import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  mergeAccountExtraConfig,
  resolvePlatformUserId,
} from './accountExtraConfig.js';
import { withAccountBrowserProfileLease } from './accountBrowserProfileLease.js';
import { resolveAccountBrowserProfileDir } from './accountManagedBrowserLogin.js';
import { convergeAccountMutation } from './accountMutationWorkflow.js';
import { getAdapter } from './platforms/index.js';
import {
  commitTargetSiteBrowserProfile,
  getTargetSiteBrowserSession,
  markTargetSiteBrowserSessionSaved,
  readTargetSiteBrowserSessionAccessToken,
  readTargetSiteBrowserSessionUserInfo,
} from './site-auth/targetSiteBrowserSession.js';

export class AccountBrowserProfileRebindError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'AccountBrowserProfileRebindError';
  }
}

export async function rebindAccountFromTargetBrowserProfile(input: {
  accountId: number;
  state: string;
}) {
  return withAccountBrowserProfileLease(input.accountId, async () => {
    const row = await db
      .select()
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.accounts.id, input.accountId))
      .get();
    if (!row) throw new AccountBrowserProfileRebindError('账号不存在', 404);

    const account = row.accounts;
    const site = row.sites;
    const session = getTargetSiteBrowserSession(input.state);
    if (!session) throw new AccountBrowserProfileRebindError('浏览器登录会话不存在', 404);
    if (session.accountId !== account.id || session.siteId !== site.id) {
      throw new AccountBrowserProfileRebindError('浏览器登录会话与原连接不匹配', 409);
    }

    const extracted = await readTargetSiteBrowserSessionAccessToken(input.state);
    let userInfo = await readTargetSiteBrowserSessionUserInfo(input.state);
    const adapter = getAdapter(site.platform);
    if (!userInfo && adapter && typeof adapter.getUserInfo === 'function') {
      userInfo = await adapter.getUserInfo(site.url, extracted.accessToken).catch(() => null);
    }

    const expectedUserId = resolvePlatformUserId(account.extraConfig, account.username);
    const actualUserId = userInfo?.platformUserId;
    if (!actualUserId || (expectedUserId && actualUserId !== expectedUserId)) {
      throw new AccountBrowserProfileRebindError('浏览器登录账号与原连接不一致', 409);
    }

    const profileDir = resolveAccountBrowserProfileDir(account, site);
    const profileCommit = await commitTargetSiteBrowserProfile(input.state, profileDir);
    try {
      const now = new Date().toISOString();
      const platform = String(site.platform || '').trim().toLowerCase();
      const extraConfig = mergeAccountExtraConfig(account.extraConfig, {
        credentialMode: 'session',
        platformUserId: actualUserId,
        source: 'target-site-browser-rebind',
        managedBrowserProfile: {
          enabled: true,
          ...(platform ? { provider: platform } : {}),
          profileDir,
          createdFrom: 'target-site-browser-rebind',
          lastVerifiedAt: now,
          updatedAt: now,
        },
      });
      await db
        .update(schema.accounts)
        .set({
          accessToken: extracted.accessToken,
          ...(userInfo?.username ? { username: userInfo.username } : {}),
          status: 'active',
          extraConfig,
          updatedAt: now,
        })
        .where(eq(schema.accounts.id, account.id))
        .run();
      await profileCommit.finalize();
    } catch (error) {
      await profileCommit.rollback().catch(() => {});
      throw error;
    }

    await markTargetSiteBrowserSessionSaved(input.state);
    const reboundAccount = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();

    await convergeAccountMutation({
      accountId: account.id,
      preferredApiToken: reboundAccount?.apiToken || account.apiToken || null,
      defaultTokenSource: 'sync',
      refreshBalance: true,
      refreshModels: true,
      rebuildRoutes: true,
      continueOnError: true,
    });
    return await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get()
      || reboundAccount;
  });
}
