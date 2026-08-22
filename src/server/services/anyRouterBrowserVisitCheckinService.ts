import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { mergeAccountExtraConfig, mergeManagedBrowserProfileExtraConfig, resolvePlatformUserId } from './accountExtraConfig.js';
import { withAccountBrowserProfileLease } from './accountBrowserProfileLease.js';
import type { BalanceInfo, CheckinResult } from './platforms/base.js';

export type AnyRouterVisitUser = { id: number; username?: string; balanceInfo?: BalanceInfo };
export type AnyRouterSignInResult = { success: boolean; message: string; alreadyCheckedIn: boolean };
export type AnyRouterVisitProfileCommit = { profileDir: string; rollback(): Promise<void>; finalize(): Promise<void> };
export type AnyRouterVisitBrowserSession = {
  readCurrentUser(): Promise<AnyRouterVisitUser | null>;
  triggerCheckin(): Promise<AnyRouterSignInResult>;
  collectSession(): Promise<{ accessToken: string }>;
  close(): Promise<void>;
  commitProfile(): Promise<AnyRouterVisitProfileCommit>;
  discardProfile(): Promise<void>;
};
type AccountLike = typeof schema.accounts.$inferSelect;
type SiteLike = typeof schema.sites.$inferSelect;
type Dependencies = {
  openBrowser(account: AccountLike, site: SiteLike): Promise<AnyRouterVisitBrowserSession>;
  persist(input: { account: AccountLike; user: AnyRouterVisitUser; accessToken: string; profileDir: string }): Promise<void>;
};
type ConfirmationOptions = { confirmationAttempts?: number; confirmationDelayMs?: number };
export type AnyRouterVisitCheckinResult = CheckinResult & {
  alreadyCheckedIn?: boolean;
  balanceInfo?: BalanceInfo;
};

async function openBrowser(account: AccountLike, site: SiteLike) {
  const module = await import('./anyRouterBrowserVisitCheckinBrowser.js');
  return module.openAnyRouterVisitBrowser(account, site);
}

export function buildAnyRouterVisitPersistUpdates(
  input: Parameters<Dependencies['persist']>[0],
): Record<string, unknown> {
  const now = new Date().toISOString();
  let extraConfig = mergeAccountExtraConfig(input.account.extraConfig, {
    credentialMode: 'session',
    platformUserId: input.user.id,
  });
  extraConfig = mergeManagedBrowserProfileExtraConfig(extraConfig, {
    enabled: true,
    provider: 'anyrouter',
    profileDir: input.profileDir,
    lastVerifiedAt: now,
  });
  const updates: Record<string, unknown> = {
    accessToken: input.accessToken,
    extraConfig,
    status: input.account.status === 'expired' ? 'active' : input.account.status,
    balance: input.user.balanceInfo!.balance,
    balanceUsed: input.user.balanceInfo!.used,
    quota: input.user.balanceInfo!.quota,
    lastBalanceRefresh: now,
    updatedAt: now,
  };
  if (input.user.username) updates.username = input.user.username;
  return updates;
}

async function persist(input: Parameters<Dependencies['persist']>[0]) {
  const updates = buildAnyRouterVisitPersistUpdates(input);
  await db.update(schema.accounts).set(updates).where(eq(schema.accounts.id, input.account.id)).run();
}

const defaults: Dependencies = { openBrowser, persist };

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundedPositiveDelta(before: number, after: number): number {
  const delta = after - before;
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.round(delta * 1_000_000) / 1_000_000;
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(Math.trunc(value)) : String(value);
}

async function readAfterSignIn(
  read: () => Promise<AnyRouterVisitUser | null>,
  beforeQuota: number,
  options: ConfirmationOptions,
): Promise<AnyRouterVisitUser | null> {
  const attempts = Math.max(1, Math.trunc(options.confirmationAttempts ?? 8));
  const delayMs = Math.max(0, Math.trunc(options.confirmationDelayMs ?? 750));
  let latest: AnyRouterVisitUser | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await read();
    const quota = latest?.balanceInfo?.quota;
    if (typeof quota === 'number' && roundedPositiveDelta(beforeQuota, quota) > 0) return latest;
    if (attempt + 1 < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return latest;
}

export async function executeAnyRouterBrowserVisitCheckin(
  account: AccountLike,
  site: SiteLike,
  dependencies: Dependencies = defaults,
  confirmationOptions: ConfirmationOptions = {},
): Promise<AnyRouterVisitCheckinResult> {
  const expectedUserId = resolvePlatformUserId(account.extraConfig, account.username);
  if (!expectedUserId) return { success: false, message: 'platform_user_id_missing' };

  return withAccountBrowserProfileLease(account.id, async () => {
    let browser: AnyRouterVisitBrowserSession | null = null;
    let closed = false;
    let commit: AnyRouterVisitProfileCommit | null = null;
    let completed = false;
    try {
      browser = await dependencies.openBrowser(account, site);
      const beforeUser = await browser.readCurrentUser();
      if (!beforeUser) throw new Error('anyrouter_target_session_expired');
      if (beforeUser.id !== expectedUserId) throw new Error('profile_account_mismatch');
      if (!beforeUser.balanceInfo) throw new Error('anyrouter_balance_missing');

      const storedQuota = finiteNumber(account.quota);
      const observedVisitDelta = storedQuota != null
        ? roundedPositiveDelta(storedQuota, beforeUser.balanceInfo.quota)
        : 0;
      const signIn = await browser.triggerCheckin();
      if (!signIn.success) throw new Error(signIn.message || 'anyrouter_sign_in_failed');

      const afterUser = signIn.alreadyCheckedIn
        ? await browser.readCurrentUser()
        : await readAfterSignIn(() => browser!.readCurrentUser(), beforeUser.balanceInfo.quota, confirmationOptions);
      if (!afterUser) throw new Error('anyrouter_target_session_expired');
      if (afterUser.id !== expectedUserId) throw new Error('profile_account_mismatch');
      if (!afterUser.balanceInfo) throw new Error('anyrouter_balance_missing');

      const explicitSignInDelta = roundedPositiveDelta(beforeUser.balanceInfo.quota, afterUser.balanceInfo.quota);
      const storedToCurrentDelta = storedQuota != null
        ? roundedPositiveDelta(storedQuota, afterUser.balanceInfo.quota)
        : 0;
      const quotaDelta = Math.max(observedVisitDelta, explicitSignInDelta, storedToCurrentDelta);
      if (quotaDelta <= 0 && !signIn.alreadyCheckedIn) {
        throw new Error('anyrouter_checkin_unconfirmed_quota_unchanged');
      }

      const session = await browser.collectSession();
      if (!session.accessToken.trim()) throw new Error('session_cookie_missing');
      await browser.close();
      closed = true;
      commit = await browser.commitProfile();
      await dependencies.persist({ account, user: afterUser, accessToken: session.accessToken, profileDir: commit.profileDir });
      await commit.finalize();
      completed = true;

      const currentQuota = formatAmount(afterUser.balanceInfo.quota);
      if (quotaDelta > 0) {
        const reward = `总额度 +${formatAmount(quotaDelta)}`;
        const confirmation = signIn.alreadyCheckedIn && observedVisitDelta > 0
          ? '签到已确认'
          : '签到成功';
        return {
          success: true,
          message: `${confirmation}：${reward}，当前总额度 ${currentQuota}`,
          reward,
          balanceInfo: afterUser.balanceInfo,
        };
      }
      return {
        success: false,
        alreadyCheckedIn: true,
        message: `已签到，额度无新增，当前总额度 ${currentQuota}`,
        balanceInfo: afterUser.balanceInfo,
      };
    } catch (error) {
      if (commit) await commit.rollback().catch(() => {});
      return { success: false, message: error instanceof Error ? error.message : String(error || 'anyrouter_browser_visit_failed') };
    } finally {
      if (browser && !closed) await browser.close().catch(() => {});
      if (browser && !completed) await browser.discardProfile().catch(() => {});
    }
  });
}
