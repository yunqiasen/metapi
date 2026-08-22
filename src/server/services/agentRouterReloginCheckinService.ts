import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  getManagedBrowserLoginProvider,
  mergeAccountExtraConfig,
  mergeManagedBrowserProfileExtraConfig,
  resolvePlatformUserId,
  resolveProxyUrlFromExtraConfig,
  type ManagedBrowserLoginProvider,
} from './accountExtraConfig.js';
import { withAccountBrowserProfileLease } from './accountBrowserProfileLease.js';
import { formatLocalDate, toLocalDayKeyFromStoredUtc } from './localTimeService.js';
import { getAdapter } from './platforms/index.js';
import type { BalanceInfo, CheckinResult } from './platforms/base.js';
import { withAccountProxyOverride } from './siteProxy.js';
import {
  readAgentRouterBalanceWithProxyFallback,
  resolveAgentRouterBalanceProxyCandidates,
} from './agentRouterBalanceRequest.js';
export {
  readAgentRouterBalanceWithProxyFallback,
  resolveAgentRouterBalanceProxyCandidates,
} from './agentRouterBalanceRequest.js';

export type AgentRouterBrowserUser = {
  id: number;
  username?: string;
  balanceInfo?: BalanceInfo;
};
export type AgentRouterOauthResult = { platformUserId: number; checkedIn?: boolean; user?: AgentRouterBrowserUser };
export type AgentRouterCollectedSession = { accessToken: string };
export type AgentRouterProfileCommit = {
  profileDir: string;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
};

export type AgentRouterReloginBrowserSession = {
  readCurrentUser(): Promise<AgentRouterBrowserUser | null>;
  preflightProviderSession(provider: ManagedBrowserLoginProvider): Promise<void>;
  logout(): Promise<void>;
  loginWithProvider(provider: ManagedBrowserLoginProvider): Promise<AgentRouterOauthResult>;
  collectSession(): Promise<AgentRouterCollectedSession>;
  close(): Promise<void>;
  commitProfile(): Promise<AgentRouterProfileCommit>;
  discardProfile(): Promise<void>;
};

type AccountLike = typeof schema.accounts.$inferSelect;
type SiteLike = typeof schema.sites.$inferSelect;

type AgentRouterBalanceReadInput = {
  account: AccountLike;
  site: SiteLike;
  accessToken: string;
  platformUserId: number;
};

type ReloginDependencies = {
  openBrowser(account: AccountLike, site: SiteLike): Promise<AgentRouterReloginBrowserSession>;
  readBalance(input: AgentRouterBalanceReadInput): Promise<BalanceInfo | null>;
  persist(input: {
    account: AccountLike;
    site: SiteLike;
    user: AgentRouterBrowserUser;
    session: AgentRouterCollectedSession;
    provider: ManagedBrowserLoginProvider;
    profileDir: string;
    checkedIn?: boolean;
  }): Promise<void>;
};

export type AgentRouterReloginCheckinResult = CheckinResult & {
  checkedIn?: boolean;
  alreadyCheckedIn?: boolean;
  credentialsRefreshed?: boolean;
  reasonCode?: string;
  balanceInfo?: BalanceInfo;
};

type ConfirmationOptions = { confirmationAttempts?: number; confirmationDelayMs?: number };

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

function hasCredibleAgentRouterBalance(
  balanceInfo: BalanceInfo | null | undefined,
): balanceInfo is BalanceInfo {
  return !!balanceInfo
    && Number.isFinite(balanceInfo.balance)
    && Number.isFinite(balanceInfo.used)
    && Number.isFinite(balanceInfo.quota)
    && balanceInfo.used >= 0
    && balanceInfo.quota > 0;
}

async function defaultOpenBrowser(account: AccountLike, site: SiteLike): Promise<AgentRouterReloginBrowserSession> {
  const browser = await import('./agentRouterReloginBrowser.js');
  return browser.openAgentRouterReloginBrowser(account, site);
}

async function readAgentRouterBalanceAfterOauth(input: AgentRouterBalanceReadInput): Promise<BalanceInfo | null> {
  const adapter = getAdapter(input.site.platform);
  if (!adapter) throw new Error('agentrouter_adapter_missing');
  const candidates = resolveAgentRouterBalanceProxyCandidates(input.account.extraConfig);
  return readAgentRouterBalanceWithProxyFallback(
    candidates,
    (proxyUrl) => withAccountProxyOverride(
      proxyUrl,
      () => adapter.getBalance(input.site.url, input.accessToken, input.platformUserId),
    ),
  );
}

async function persistAgentRouterRelogin(input: Parameters<ReloginDependencies['persist']>[0]): Promise<void> {
  const adapter = getAdapter(input.site.platform);
  if (!adapter) throw new Error('agentrouter_adapter_missing');
  const apiToken = await withAccountProxyOverride(
    resolveProxyUrlFromExtraConfig(input.account.extraConfig),
    () => adapter.getApiToken(input.site.url, input.session.accessToken, input.user.id).catch(() => null),
  );
  const accountConfig = mergeAccountExtraConfig(input.account.extraConfig, {
    credentialMode: 'session',
    platformUserId: input.user.id,
  });
  const extraConfig = mergeManagedBrowserProfileExtraConfig(accountConfig, {
    enabled: true,
    provider: 'agentrouter',
    profileDir: input.profileDir,
    loginProvider: input.provider,
    lastVerifiedAt: new Date().toISOString(),
    lastReauthenticatedAt: new Date().toISOString(),
    ...(input.checkedIn === undefined ? {} : { lastOauthCheckedIn: input.checkedIn }),
  });
  const updates: Record<string, unknown> = {
    accessToken: input.session.accessToken,
    extraConfig,
    status: input.account.status === 'expired' ? 'active' : input.account.status,
    updatedAt: new Date().toISOString(),
  };
  if (input.user.username) updates.username = input.user.username;
  if (apiToken) updates.apiToken = apiToken;
  if (input.user.balanceInfo) {
    updates.balance = input.user.balanceInfo.balance;
    updates.balanceUsed = input.user.balanceInfo.used;
    updates.quota = input.user.balanceInfo.quota;
    updates.lastBalanceRefresh = new Date().toISOString();
  }
  await db.update(schema.accounts).set(updates).where(eq(schema.accounts.id, input.account.id)).run();
}

const defaultDependencies: ReloginDependencies = {
  openBrowser: defaultOpenBrowser,
  readBalance: readAgentRouterBalanceAfterOauth,
  persist: persistAgentRouterRelogin,
};

export async function readAgentRouterUserWithRetry(
  read: () => Promise<AgentRouterBrowserUser | null>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<AgentRouterBrowserUser | null> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 4));
  const delayMs = Math.max(0, Math.trunc(options.delayMs ?? 750));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const user = await read();
    if (user) return user;
    if (attempt + 1 < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

async function readAgentRouterUserAfterCheckin(
  read: () => Promise<AgentRouterBrowserUser | null>,
  beforeQuota: number,
  options: ConfirmationOptions,
): Promise<AgentRouterBrowserUser | null> {
  const attempts = Math.max(1, Math.trunc(options.confirmationAttempts ?? 8));
  const delayMs = Math.max(0, Math.trunc(options.confirmationDelayMs ?? 750));
  let latest: AgentRouterBrowserUser | null = null;
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

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error || '').trim();
  return message || 'browser_reauth_failed';
}

export async function executeAgentRouterReloginCheckin(
  account: AccountLike,
  site: SiteLike,
  dependencies: ReloginDependencies = defaultDependencies,
  confirmationOptions: ConfirmationOptions = {},
): Promise<AgentRouterReloginCheckinResult> {
  const expectedUserId = resolvePlatformUserId(account.extraConfig, account.username);
  if (!expectedUserId) return { success: false, message: 'platform_user_id_missing' };
  const provider = getManagedBrowserLoginProvider(account.extraConfig, account.username);
  if (!provider) return { success: false, message: 'login_provider_missing' };

  const checkedInToday = toLocalDayKeyFromStoredUtc(account.lastCheckinAt) === formatLocalDate(new Date());

  return withAccountBrowserProfileLease(account.id, async () => {
    let browser: AgentRouterReloginBrowserSession | null = null;
    let closed = false;
    let profileCommit: AgentRouterProfileCommit | null = null;
    let completed = false;
    try {
      browser = await dependencies.openBrowser(account, site);
      let beforeUser = await browser.readCurrentUser();
      const observedBrowserVisitBalance = beforeUser
        && hasCredibleAgentRouterBalance(beforeUser.balanceInfo)
        ? beforeUser.balanceInfo
        : null;
      // 目标站 Session 过期时仍应利用同一 Profile 中的第三方登录态重新授权；
      // 只有明确读到另一个账号时才阻止继续，最终账号一致性以后置 OAuth 回调和 self 为准。
      if (beforeUser && beforeUser.id !== expectedUserId) throw new Error('profile_account_mismatch');
      if (!beforeUser?.balanceInfo && account.accessToken.trim()) {
        const fallbackBalance = await dependencies.readBalance({
          account,
          site,
          accessToken: account.accessToken,
          platformUserId: expectedUserId,
        });
        if (fallbackBalance) {
          beforeUser = {
            id: expectedUserId,
            ...(beforeUser?.username || account.username ? { username: beforeUser?.username || account.username || undefined } : {}),
            balanceInfo: fallbackBalance,
          };
        }
      }

      // AgentRouter 会在当天第一次读取已登录用户信息时发放额度。
      // 先用数据库旧总额度与本次真实浏览器 self 响应比较；一旦出现正向增量，
      // 这次浏览器访问本身就是签到，不再重复 logout/OAuth。
      const storedQuota = finiteNumber(account.quota);
      const observedVisitBalance = observedBrowserVisitBalance;
      const observedVisitDelta = !checkedInToday
        && storedQuota != null
        && storedQuota > 0
        && observedVisitBalance
        ? roundedPositiveDelta(storedQuota, observedVisitBalance.quota)
        : 0;
      if (beforeUser && observedVisitBalance && observedVisitDelta > 0) {
        const collected = await browser.collectSession();
        if (!collected.accessToken.trim()) throw new Error('session_cookie_missing');

        await browser.close();
        closed = true;

        profileCommit = await browser.commitProfile();
        await dependencies.persist({
          account,
          site,
          user: beforeUser,
          session: collected,
          provider,
          profileDir: profileCommit.profileDir,
          checkedIn: true,
        });
        await profileCommit.finalize();
        completed = true;

        const reward = `总额度 +${formatAmount(observedVisitDelta)}`;
        return {
          success: true,
          checkedIn: true,
          credentialsRefreshed: true,
          reward,
          balanceInfo: observedVisitBalance,
          message: `AgentRouter 签到成功：${reward}，当前总额度 ${formatAmount(observedVisitBalance.quota)}`,
        };
      }

      // 同一天已经由 Metapi 记录成功时，只做在线复核；其余情况才走
      // provider preflight -> logout -> OAuth。
      const sameDayBalance = checkedInToday ? observedVisitBalance : null;
      if (beforeUser && sameDayBalance) {
        const collected = await browser.collectSession();
        if (!collected.accessToken.trim()) throw new Error('session_cookie_missing');

        await browser.close();
        closed = true;

        profileCommit = await browser.commitProfile();
        await dependencies.persist({
          account,
          site,
          user: beforeUser,
          session: collected,
          provider,
          profileDir: profileCommit.profileDir,
          checkedIn: true,
        });
        await profileCommit.finalize();
        completed = true;

        return {
          success: false,
          checkedIn: true,
          alreadyCheckedIn: true,
          credentialsRefreshed: true,
          balanceInfo: sameDayBalance,
          message: `已签到，额度无新增，当前总额度 ${formatAmount(sameDayBalance.quota)}`,
        };
      }

      await browser.preflightProviderSession(provider);
      await browser.logout();
      const anonymousUser = await browser.readCurrentUser();
      if (anonymousUser) throw new Error('logout_not_confirmed');

      const beforeQuota = finiteNumber(beforeUser?.balanceInfo?.quota) ?? finiteNumber(account.quota);
      const hasPositiveBaseline = beforeQuota != null && beforeQuota > 0;

      const oauth = await browser.loginWithProvider(provider);
      if (oauth.platformUserId !== expectedUserId) throw new Error('oauth_callback_account_mismatch');
      const callbackUser = oauth.user?.id === expectedUserId ? oauth.user : null;
      let afterUser = callbackUser
        || (oauth.checkedIn === true && hasPositiveBaseline
          ? await readAgentRouterUserAfterCheckin(() => browser!.readCurrentUser(), beforeQuota, confirmationOptions)
          : await readAgentRouterUserWithRetry(() => browser!.readCurrentUser()));
      if (afterUser && afterUser.id !== expectedUserId) throw new Error('post_oauth_account_mismatch');

      const collected = await browser.collectSession();
      if (!collected.accessToken.trim()) throw new Error('session_cookie_missing');
      const browserQuota = finiteNumber(afterUser?.balanceInfo?.quota);
      if (
        browserQuota == null
        || (hasPositiveBaseline && browserQuota < beforeQuota)
      ) {
        const fallbackBalance = await dependencies.readBalance({
          account,
          site,
          accessToken: collected.accessToken,
          platformUserId: expectedUserId,
        });
        if (fallbackBalance) {
          afterUser = {
            id: expectedUserId,
            ...(afterUser?.username || account.username ? { username: afterUser?.username || account.username || undefined } : {}),
            balanceInfo: fallbackBalance,
          };
        }
      }

      const afterQuota = finiteNumber(afterUser?.balanceInfo?.quota);
      const credibleBalance = afterUser?.balanceInfo
        && afterQuota != null
        && afterQuota > 0
        && (!hasPositiveBaseline || afterQuota >= beforeQuota)
        ? afterUser.balanceInfo
        : null;
      const persistedUser: AgentRouterBrowserUser = {
        id: expectedUserId,
        ...(afterUser?.username || account.username ? { username: afterUser?.username || account.username || undefined } : {}),
        ...(credibleBalance ? { balanceInfo: credibleBalance } : {}),
      };

      // OAuth 回调在暂存 Profile 中创建新 Session；正式 Profile 和数据库凭证只在整条链路确认后替换。
      await browser.close();
      closed = true;

      profileCommit = await browser.commitProfile();
      await dependencies.persist({
        account,
        site,
        user: persistedUser,
        session: collected,
        provider,
        profileDir: profileCommit.profileDir,
        checkedIn: oauth.checkedIn,
      });
      await profileCommit.finalize();
      completed = true;

      if (!hasPositiveBaseline) {
        return {
          success: false,
          checkedIn: oauth.checkedIn,
          credentialsRefreshed: true,
          reasonCode: 'agentrouter_previous_quota_missing',
          ...(credibleBalance ? { balanceInfo: credibleBalance } : {}),
          message: credibleBalance
            ? `AgentRouter 已重新登录并保存新凭证；缺少签到前额度，未推算奖励，当前总额度 ${formatAmount(credibleBalance.quota)}`
            : 'AgentRouter 已重新登录并保存新凭证；缺少签到前额度，签到奖励尚未确认',
        };
      }

      if (!credibleBalance) {
        return {
          success: false,
          checkedIn: oauth.checkedIn,
          credentialsRefreshed: true,
          reasonCode: 'agentrouter_balance_unconfirmed',
          message: 'AgentRouter 已重新登录并保存新凭证，但余额接口暂时未返回有效数据，签到奖励尚未确认',
        };
      }

      const quotaDelta = roundedPositiveDelta(beforeQuota, credibleBalance.quota);
      if (quotaDelta > 0) {
        const reward = `总额度 +${formatAmount(quotaDelta)}`;
        return {
          success: true,
          checkedIn: true,
          credentialsRefreshed: true,
          reward,
          balanceInfo: credibleBalance,
          message: `AgentRouter 签到成功：${reward}，当前总额度 ${formatAmount(credibleBalance.quota)}`,
        };
      }
      if (oauth.checkedIn !== true) {
        return {
          success: false,
          checkedIn: oauth.checkedIn,
          credentialsRefreshed: true,
          reasonCode: 'agentrouter_oauth_checkin_not_confirmed',
          balanceInfo: credibleBalance,
          message: `AgentRouter 已重新登录并保存新凭证，站点未返回签到确认，当前总额度 ${formatAmount(credibleBalance.quota)}`,
        };
      }
      return {
        success: false,
        checkedIn: true,
        credentialsRefreshed: true,
        reasonCode: 'agentrouter_checkin_unconfirmed_quota_unchanged',
        balanceInfo: credibleBalance,
        message: `AgentRouter 已重新登录并保存新凭证，但总额度未增加，当前总额度 ${formatAmount(credibleBalance.quota)}`,
      };
    } catch (error) {
      if (profileCommit) await profileCommit.rollback().catch(() => {});
      const reason = errorCode(error);
      return { success: false, message: reason };
    } finally {
      if (browser && !closed) await browser.close().catch(() => {});
      if (browser && !completed) await browser.discardProfile().catch(() => {});
    }
  });
}
