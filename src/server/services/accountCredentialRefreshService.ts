import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { decryptAccountPassword } from './accountCredentialService.js';
import { getAutoReloginConfig, resolvePlatformUserId, resolveProxyUrlFromExtraConfig } from './accountExtraConfig.js';
import {
  isManagedBrowserLoginSite,
  refreshManagedAccountLogin,
} from './accountManagedBrowserLogin.js';
import { getAdapter } from './platforms/index.js';
import { withAccountProxyOverride } from './siteProxy.js';

export type AccountCredentialRefreshStatus = 'success' | 'skipped' | 'failed';

export type AccountCredentialRefreshResult = {
  accountId: number;
  status: AccountCredentialRefreshStatus;
  refreshed: boolean;
  message: string;
};

export type AccountCredentialsRefreshSummary = {
  total: number;
  success: number;
  skipped: number;
  failed: number;
  results: AccountCredentialRefreshResult[];
};

type AccountWithSiteRow = {
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : '刷新凭证失败';
}

function summarize(
  results: AccountCredentialRefreshResult[],
): AccountCredentialsRefreshSummary {
  return {
    total: results.length,
    success: results.filter((item) => item.status === 'success').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length,
    results,
  };
}

async function refreshBySavedPassword(
  account: typeof schema.accounts.$inferSelect,
  site: typeof schema.sites.$inferSelect,
): Promise<AccountCredentialRefreshResult | null> {
  const relogin = getAutoReloginConfig(account.extraConfig);
  if (!relogin) return null;

  const password = decryptAccountPassword(relogin.passwordCipher);
  if (!password) return null;

  const adapter = getAdapter(site.platform);
  if (!adapter) {
    return {
      accountId: account.id,
      status: 'skipped',
      refreshed: false,
      message: `不支持的平台: ${site.platform}`,
    };
  }

  const loginResult = await withAccountProxyOverride(
    resolveProxyUrlFromExtraConfig(account.extraConfig),
    () => adapter.login(site.url, relogin.username, password),
  );
  const accessToken = loginResult.accessToken;
  if (!loginResult.success || !accessToken) {
    return {
      accountId: account.id,
      status: 'failed',
      refreshed: false,
      message: loginResult.message || '账号密码重新登录失败',
    };
  }

  const platformUserId = resolvePlatformUserId(
    account.extraConfig,
    account.username,
  );
  let apiToken: string | null = null;
  try {
    apiToken = await withAccountProxyOverride(
      resolveProxyUrlFromExtraConfig(account.extraConfig),
      () => adapter.getApiToken(site.url, accessToken, platformUserId),
    );
  } catch {}

  const updates: Record<string, unknown> = {
    accessToken,
    status: account.status === 'expired' ? 'active' : account.status,
    updatedAt: new Date().toISOString(),
  };
  if (apiToken) updates.apiToken = apiToken;

  await db
    .update(schema.accounts)
    .set(updates)
    .where(eq(schema.accounts.id, account.id))
    .run();

  return {
    accountId: account.id,
    status: 'success',
    refreshed: true,
    message: '已用保存的账号密码重新登录并刷新凭证',
  };
}

async function refreshAccountCredentialRow(
  row: AccountWithSiteRow,
): Promise<AccountCredentialRefreshResult> {
  const { account, site } = row;

  if (isManagedBrowserLoginSite(site)) {
    try {
      const refreshed = await refreshManagedAccountLogin(account, site);
      if (refreshed) {
        return {
          accountId: account.id,
          status: 'success',
          refreshed: true,
          message: '凭证已刷新',
        };
      }
    } catch {}
  }

  try {
    const passwordRefresh = await refreshBySavedPassword(account, site);
    if (passwordRefresh) return passwordRefresh;
  } catch (error) {
    return {
      accountId: account.id,
      status: 'failed',
      refreshed: false,
      message: toErrorMessage(error),
    };
  }

  return {
    accountId: account.id,
    status: 'skipped',
    refreshed: false,
    message: isManagedBrowserLoginSite(site)
      ? '浏览器 Profile 登录态不可用，且没有保存账号密码，请重新授权或重新登录刷新凭证'
      : '该账号没有保存账号密码，暂不支持自动刷新凭证',
  };
}

export async function refreshAccountCredential(
  accountId: number,
): Promise<AccountCredentialRefreshResult> {
  const row = await db
    .select({ account: schema.accounts, site: schema.sites })
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();

  if (!row) {
    return {
      accountId,
      status: 'failed',
      refreshed: false,
      message: '账号不存在',
    };
  }

  return refreshAccountCredentialRow(row);
}

export async function refreshAllAccountCredentials(): Promise<
  AccountCredentialsRefreshSummary
> {
  const rows = await db
    .select({ account: schema.accounts, site: schema.sites })
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .orderBy(asc(schema.accounts.id))
    .all();

  const results: AccountCredentialRefreshResult[] = [];
  for (const row of rows) {
    results.push(await refreshAccountCredentialRow(row));
  }

  return summarize(results);
}
