import { db, schema } from '../db/index.js';
import { getAdapter } from './platforms/index.js';
import type { BalanceInfo } from './platforms/base.js';
import { eq, and } from 'drizzle-orm';
import { sendNotification } from './notifyService.js';
import { isCloudflareChallenge, isTokenExpiredError } from './alertRules.js';
import { reportTokenExpired } from './alertService.js';
import { refreshBalance } from './balanceService.js';
import { parseCheckinRewardAmount } from './checkinRewardParser.js';
import {
  getAutoReloginConfig,
  getPlatformUserIdFromExtraConfig,
  guessPlatformUserIdFromUsername,
  mergeAccountExtraConfig,
  resolveProxyUrlFromExtraConfig,
  resolvePlatformUserId,
} from './accountExtraConfig.js';
import { decryptAccountPassword } from './accountCredentialService.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { withAccountProxyOverride } from './siteProxy.js';
import { hasStoredAccountBrowserProfile, refreshManagedAccountLogin } from './accountManagedBrowserLogin.js';
import { executeAgentRouterReloginCheckin } from './agentRouterReloginCheckinService.js';
import { executeAnyRouterBrowserVisitCheckin } from './anyRouterBrowserVisitCheckinService.js';
import { withAccountBrowserProfileLease } from './accountBrowserProfileLease.js';

type CheckinExecutionStatus = 'success' | 'failed' | 'skipped';

export type CheckinAllProgress = {
  completed: number;
  total: number;
  accountId: number;
  username: string | null;
  site: string;
  result: any;
};

type CheckinAllOptions = {
  accountIds?: number[];
  scheduleMode?: 'cron' | 'interval';
  onProgress?: (progress: CheckinAllProgress) => void;
};

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

function isAlreadyCheckedInMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = message.trim();
  if (!text) return false;
  const normalized = text.toLowerCase();
  return (
    normalized.includes('already checked in') ||
    normalized.includes('already signed') ||
    normalized.includes('already sign in') ||
    text.includes('\u4eca\u65e5\u5df2\u7b7e\u5230') ||
    text.includes('\u4eca\u5929\u5df2\u7b7e\u5230') ||
    text.includes('\u4eca\u5929\u5df2\u7ecf\u7b7e\u5230') ||
    text.includes('\u4eca\u65e5\u5df2\u7ecf\u7b7e\u5230') ||
    text.includes('\u5df2\u7ecf\u7b7e\u5230') ||
    text.includes('\u5df2\u7b7e\u5230') ||
    text.includes('\u91cd\u590d\u7b7e\u5230') ||
    text.includes('\u7b7e\u5230\u8fc7')
  );
}

function isUnsupportedCheckinMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    text.includes('invalid url (post /api/user/checkin)') ||
    (text.includes('http 404') && text.includes('/api/user/checkin')) ||
    text.includes('checkin endpoint not found') ||
    text.includes('check-in is not supported') ||
    text.includes('checkin is not supported') ||
    text.includes('does not support checkin') ||
    text.includes('not support checkin')
  );
}


function isManualVerificationRequiredMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    text.includes('turnstile token \u4e3a\u7a7a') ||
    (text.includes('turnstile') && (text.includes('token') || text.includes('\u6821\u9a8c') || text.includes('\u9a8c\u8bc1')))
  );
}

function shouldAttemptAutoRelogin(message?: string | null): boolean {
  if (!message) return false;
  if (isTokenExpiredError({ message })) return true;

  const text = message.toLowerCase();
  if (text.includes('new-api-user')) return true;
  if (text.includes('access token')) return true;
  if (text.includes('platform_user_id_missing')) return true;
  if (isCloudflareChallenge(message)) return true;
  return (
    text.includes('upstream_html_response') ||
    text.includes("unexpected token '<'") ||
    (text.includes('not valid json') && (text.includes('<html') || text.includes('<script')))
  );
}

function formatBalanceReward(delta: number): string {
  return `余额 +${Number.isInteger(delta) ? Math.trunc(delta) : delta}`;
}

function inferRewardFromBalanceDelta(previousBalance: unknown, latestBalance: unknown): number {
  const before = typeof previousBalance === 'number' && Number.isFinite(previousBalance)
    ? previousBalance
    : null;
  const after = typeof latestBalance === 'number' && Number.isFinite(latestBalance)
    ? latestBalance
    : null;
  if (before == null || after == null) return 0;

  const delta = after - before;
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.round(delta * 1_000_000) / 1_000_000;
}

type AutoReloginResult = {
  accessToken: string;
  platformUserId?: number;
  extraConfig?: string;
};

async function tryAutoRelogin(account: any, site: any): Promise<AutoReloginResult | null> {
  const adapter = getAdapter(site.platform);
  if (!adapter) return null;

  if (hasStoredAccountBrowserProfile(account)) {
    let managedRefresh: Awaited<ReturnType<typeof refreshManagedAccountLogin>> | null = null;
    try {
      managedRefresh = await refreshManagedAccountLogin(account, site);
    } catch {}
    if (managedRefresh?.accessToken) {
      return {
        accessToken: managedRefresh.accessToken,
        ...(managedRefresh.platformUserId ? { platformUserId: managedRefresh.platformUserId } : {}),
        extraConfig: managedRefresh.extraConfig,
      };
    }
  }

  const relogin = getAutoReloginConfig(account.extraConfig);
  if (!relogin) return null;

  const password = decryptAccountPassword(relogin.passwordCipher);
  if (!password) return null;

  const result = await withAccountProxyOverride(
    resolveProxyUrlFromExtraConfig(account.extraConfig),
    () => adapter.login(site.url, relogin.username, password),
  );
  if (!result.success || !result.accessToken) return null;

  await db.update(schema.accounts)
    .set({
      accessToken: result.accessToken,
      updatedAt: new Date().toISOString(),
      status: account.status === 'expired' ? 'active' : account.status,
    })
    .where(eq(schema.accounts.id, account.id))
    .run();

  return { accessToken: result.accessToken };
}

async function checkinAccountUnlocked(accountId: number, options?: { skipEvent?: boolean; scheduleMode?: 'cron' | 'interval' }) {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .all();

  if (rows.length === 0) return { success: false, message: 'account not found' };

  const account = rows[0].accounts;
  const site = rows[0].sites;

  if (isSiteDisabled(site.status)) {
    const createdAt = formatUtcSqlDateTime(new Date());
    await setAccountRuntimeHealth(account.id, {
      state: 'disabled',
      reason: '\u7ad9\u70b9\u5df2\u7981\u7528',
      source: 'checkin',
    });
    await db.insert(schema.checkinLogs).values({
      accountId: account.id,
      status: 'skipped',
      message: 'site disabled',
      createdAt,
    }).run();

    if (!options?.skipEvent) {
      await db.insert(schema.events).values({
        type: 'checkin',
        title: 'checkin skipped',
        message: `${account.username || 'ID:' + accountId} @ ${site.name}: site disabled`,
        level: 'info',
        relatedId: accountId,
        relatedType: 'account',
        createdAt,
      }).run();
    }

    return {
      success: true,
      status: 'skipped' as const,
      skipped: true,
      reason: 'site_disabled',
      message: 'site disabled',
    };
  }

  const adapter = getAdapter(site.platform);
  if (!adapter) return { success: false, status: 'failed' as const, message: `unsupported platform: ${site.platform}` };

  const storedPlatformUserId = getPlatformUserIdFromExtraConfig(account.extraConfig);
  const guessedPlatformUserId = storedPlatformUserId
    ? undefined
    : guessPlatformUserIdFromUsername(account.username);
  let platformUserId = resolvePlatformUserId(account.extraConfig, account.username);

  const accountProxyUrl = resolveProxyUrlFromExtraConfig(account.extraConfig);
  const hasBrowserProfile = hasStoredAccountBrowserProfile(account);
  const useAgentBrowserCheckin = hasBrowserProfile && adapter.checkinMode === 'browser-reauth';
  const useAnyBrowserCheckin = hasBrowserProfile && adapter.checkinMode === 'browser-visit';
  const runProtocolCheckin = () => withAccountProxyOverride(
    accountProxyUrl,
    () => adapter.checkin(site.url, activeAccessToken, platformUserId),
  );
  let activeAccessToken = account.accessToken;
  let browserVisitAccount = account;
  let result = useAgentBrowserCheckin
    ? await executeAgentRouterReloginCheckin(account, site)
    : useAnyBrowserCheckin
      ? await executeAnyRouterBrowserVisitCheckin(account, site)
      : await runProtocolCheckin();

  const supportsProtocolRetry = !useAgentBrowserCheckin && !useAnyBrowserCheckin;
  if (supportsProtocolRetry && !result.success && shouldAttemptAutoRelogin(result.message)) {
    const refreshed = await tryAutoRelogin(account, site);
    if (refreshed?.accessToken) {
      activeAccessToken = refreshed.accessToken;
      if (refreshed.platformUserId) platformUserId = refreshed.platformUserId;
      browserVisitAccount = {
        ...account,
        accessToken: refreshed.accessToken,
        ...(refreshed.extraConfig ? { extraConfig: refreshed.extraConfig } : {}),
      };
      result = await withAccountProxyOverride(accountProxyUrl,
        () => adapter.checkin(site.url, activeAccessToken, platformUserId));
    }
  }

  if (hasBrowserProfile && adapter.checkinMode === 'browser-visit-fallback' && !result.success) {
    result = await executeAnyRouterBrowserVisitCheckin(browserVisitAccount, site);
  }

  const isCloudflare = isCloudflareChallenge(result.message);
  const explicitUnchangedCheckin = result.success === false
    && (result as { alreadyCheckedIn?: boolean }).alreadyCheckedIn === true;
  const alreadyCheckedIn = !explicitUnchangedCheckin && isAlreadyCheckedInMessage(result.message);
  const unsupportedCheckin = isUnsupportedCheckinMessage(result.message);
  const manualVerificationRequired = isManualVerificationRequiredMessage(result.message);
  const manualVerificationMessage = '\u7ad9\u70b9\u5f00\u542f\u4e86 Turnstile \u6821\u9a8c\uff0c\u9700\u8981\u4eba\u5de5\u7b7e\u5230';
  let logMessage = manualVerificationRequired ? manualVerificationMessage : result.message;
  const effectiveSuccess = result.success || alreadyCheckedIn || unsupportedCheckin || manualVerificationRequired;
  const shouldRefreshBalance = result.success || alreadyCheckedIn || explicitUnchangedCheckin;
  const directCheckinSuccess = result.success && !alreadyCheckedIn && !unsupportedCheckin;
  const shouldAdvanceLastCheckinAt = directCheckinSuccess || (alreadyCheckedIn && options?.scheduleMode !== 'interval');
  const normalizedStatus: CheckinExecutionStatus = explicitUnchangedCheckin
    ? 'skipped'
    : effectiveSuccess
      ? ((unsupportedCheckin || manualVerificationRequired) ? 'skipped' : 'success')
      : 'failed';
  let logReward = result.reward;
  const inlineBalanceInfo = (result as { balanceInfo?: BalanceInfo }).balanceInfo;
  let refreshedBalanceInfo: Awaited<ReturnType<typeof refreshBalance>> | null = inlineBalanceInfo || null;

  if (effectiveSuccess || explicitUnchangedCheckin) {
    const healthState = (unsupportedCheckin || manualVerificationRequired) ? 'degraded' : 'healthy';
    const healthReason = unsupportedCheckin
      ? '\u7ad9\u70b9\u4e0d\u652f\u6301\u7b7e\u5230\u63a5\u53e3'
      : manualVerificationRequired
        ? manualVerificationMessage
        : explicitUnchangedCheckin
          ? (result.message || '\u5df2\u7b7e\u5230\uff0c\u989d\u5ea6\u65e0\u65b0\u589e')
          : (alreadyCheckedIn ? '\u4eca\u65e5\u5df2\u7b7e\u5230' : (result.message || '\u7b7e\u5230\u6210\u529f'));
    const updates: Record<string, unknown> = {};
    if (shouldAdvanceLastCheckinAt) {
      updates.lastCheckinAt = new Date().toISOString();
    }
    if (!storedPlatformUserId && guessedPlatformUserId) {
      updates.extraConfig = mergeAccountExtraConfig(account.extraConfig, {
        platformUserId: guessedPlatformUserId,
      });
    }
    if (account.status === 'expired') {
      updates.status = 'active';
      updates.updatedAt = new Date().toISOString();
    }

    if (Object.keys(updates).length > 0) {
      await db.update(schema.accounts)
        .set(updates)
        .where(eq(schema.accounts.id, accountId))
        .run();
    }

    if (shouldRefreshBalance && !refreshedBalanceInfo) {
      try {
        refreshedBalanceInfo = await refreshBalance(account.id);
      } catch {}
    }

    const parsedReward = parseCheckinRewardAmount(logReward) || parseCheckinRewardAmount(result.message);
    if (directCheckinSuccess && parsedReward <= 0) {
      const inferredReward = inferRewardFromBalanceDelta(account.balance, refreshedBalanceInfo?.balance);
      if (inferredReward > 0) {
        const formattedReward = formatBalanceReward(inferredReward);
        logReward = formattedReward;
        logMessage = logMessage ? `${logMessage}（${formattedReward}）` : formattedReward;
      }
    }

    await setAccountRuntimeHealth(account.id, {
      state: healthState,
      reason: healthReason,
      source: 'checkin',
    });
  }

  const createdAt = formatUtcSqlDateTime(new Date());
  await db.insert(schema.checkinLogs).values({
    accountId: account.id,
    status: normalizedStatus,
    message: logMessage,
    reward: logReward,
    createdAt,
  }).run();

  if (!options?.skipEvent) {
    await db.insert(schema.events).values({
      type: 'checkin',
      title: normalizedStatus === 'skipped'
        ? 'checkin skipped'
        : normalizedStatus === 'success'
          ? 'checkin success'
          : (isCloudflare ? 'checkin failed (cloudflare challenge)' : 'checkin failed'),
      message: `${account.username || 'ID:' + accountId} @ ${site.name}: ${logMessage}`,
      level: normalizedStatus === 'failed' ? 'error' : 'info',
      relatedId: accountId,
      relatedType: 'account',
      createdAt,
    }).run();
  }

  if (normalizedStatus === 'failed') {
    await setAccountRuntimeHealth(account.id, {
      state: 'unhealthy',
      reason: result.message || '\u7b7e\u5230\u5931\u8d25',
      source: 'checkin',
    });
    if (isTokenExpiredError({ message: result.message })) {
      await reportTokenExpired({
        accountId: account.id,
        username: account.username,
        siteName: site.name,
        detail: result.message,
      });
    }

    if (isCloudflare) {
      await sendNotification(
        'Cloudflare challenge',
        `${account.username || 'ID:' + accountId} @ ${site.name}: ${result.message}`,
        'warning',
      );
    }

    if (!unsupportedCheckin && !manualVerificationRequired) {
      await sendNotification(
        'checkin failed',
        `${account.username || 'ID:' + accountId} @ ${site.name}: ${result.message}`,
        'error',
      );
    }
  }


  return {
    ...result,
    success: effectiveSuccess,
    status: normalizedStatus,
    ...(logMessage ? { message: logMessage } : {}),
    ...(logReward ? { reward: logReward } : {}),
    ...(refreshedBalanceInfo ? { balanceInfo: refreshedBalanceInfo } : {}),
    ...(normalizedStatus === 'skipped' ? { skipped: true } : {}),
  };
}

export function checkinAccount(
  accountId: number,
  options?: { skipEvent?: boolean; scheduleMode?: 'cron' | 'interval' },
) {
  return withAccountBrowserProfileLease(
    accountId,
    () => checkinAccountUnlocked(accountId, options),
  );
}

export async function checkinAll(options?: CheckinAllOptions) {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.accounts.checkinEnabled, true),
        eq(schema.accounts.status, 'active'),
      ),
    )
    .all();

  const scopedAccountIds = options?.accountIds ? new Set(options.accountIds) : null;
  const selectedRows = scopedAccountIds
    ? rows.filter((row) => scopedAccountIds.has(row.accounts.id))
    : rows;
  const results: Array<{ accountId: number; username: string | null; site: string; result: any }> = [];

  for (const row of selectedRows) {
    const result = await checkinAccount(row.accounts.id, {
      skipEvent: true,
      scheduleMode: options?.scheduleMode,
    });
    const item = {
      accountId: row.accounts.id,
      username: row.accounts.username,
      site: row.sites.name,
      result,
    };
    results.push(item);
    try {
      options?.onProgress?.({
        completed: results.length,
        total: selectedRows.length,
        ...item,
      });
    } catch {}
  }

  return results;
}
