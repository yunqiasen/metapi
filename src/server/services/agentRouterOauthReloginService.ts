import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  getProxyUrlFromExtraConfig,
  resolvePlatformUserId,
  type CheckinReloginProvider,
} from './accountExtraConfig.js';
import { buildNewApiCookieCandidates, normalizeNewApiCredential } from './platforms/newApiShield.js';
import type { BalanceInfo, CheckinResult } from './platforms/base.js';
import { parseNewApiBalance } from './platforms/newApi.js';
import { AgentRouterRequestError, parseAgentRouterResponse, validateAgentRouterUser } from './platforms/agentRouterRequest.js';
import { withSiteRecordProxyRequestInit } from './siteProxy.js';

type AccountLike = typeof schema.accounts.$inferSelect;
type SiteLike = typeof schema.sites.$inferSelect;

type FetchResponseLike = {
  status: number;
  headers: {
    get(name: string): string | null;
    getSetCookie?(): string[];
  };
  text(): Promise<string>;
};

export type AgentRouterReloginFetch = (
  url: string,
  options?: Record<string, unknown>,
) => Promise<FetchResponseLike>;

export type AgentRouterOauthReloginResult = CheckinResult & {
  checkedIn?: boolean;
  credentialsRefreshed?: boolean;
  reasonCode?: string;
  balanceInfo?: BalanceInfo;
};

type AgentRouterOauthReloginInput = {
  account: AccountLike;
  site: SiteLike;
  provider: CheckinReloginProvider;
  providerCookie: string;
};

type ReloginDependencies = {
  fetchImpl?: AgentRouterReloginFetch;
  persist?: (input: {
    account: AccountLike;
    sessionToken: string;
    username?: string;
    balanceInfo: BalanceInfo | null;
    apiToken: string | null;
  }) => Promise<void>;
  now?: () => Date;
  requestTimeoutMs?: number;
};

const OAUTH_STATE_PATH = '/api/oauth/state';
const OAUTH_STATUS_PATH = '/api/status';
const PROVIDER_AUTHORIZE_URL: Record<CheckinReloginProvider, (clientId: string, state: string) => string> = {
  github: (clientId, state) =>
    `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&state=${encodeURIComponent(state)}&scope=user:email`,
  linuxdo: (clientId, state) =>
    `https://connect.linux.do/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&state=${encodeURIComponent(state)}`,
};
const PROVIDER_CLIENT_ID_KEY: Record<CheckinReloginProvider, string> = {
  github: 'github_client_id',
  linuxdo: 'linuxdo_client_id',
};
const MAX_PROVIDER_REDIRECTS = 5;

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function extractSetCookieSession(response: FetchResponseLike): string {
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (() => {
        const single = response.headers.get('set-cookie');
        return single ? [single] : [];
      })();
  for (const cookie of cookies) {
    const match = /^session=([^;]+)/i.exec(cookie.trim());
    if (match?.[1]) return `session=${match[1]}`;
  }
  return '';
}

function parseJsonSafe(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return null;
}

function parsePositiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && /TimeoutError|AbortError/.test(error.name)) return '线路响应超时，本次请求已结束';
  return error instanceof Error ? error.message : String(error || '');
}

async function defaultPersist(input: Parameters<NonNullable<ReloginDependencies['persist']>>[0]): Promise<void> {
  const updates: Record<string, unknown> = {
    accessToken: input.sessionToken,
    status: input.account.status === 'expired' ? 'active' : input.account.status,
    updatedAt: (new Date()).toISOString(),
  };
  if (input.username) updates.username = input.username;
  if (input.apiToken) updates.apiToken = input.apiToken;
  if (input.balanceInfo) {
    updates.balance = input.balanceInfo.balance;
    updates.balanceUsed = input.balanceInfo.used;
    updates.quota = input.balanceInfo.quota;
    updates.lastBalanceRefresh = new Date().toISOString();
  }
  await db.update(schema.accounts)
    .set(updates)
    .where(eq(schema.accounts.id, input.account.id))
    .run();
}

export async function executeAgentRouterOauthRelogin(
  input: AgentRouterOauthReloginInput,
  dependencies: ReloginDependencies = {},
): Promise<AgentRouterOauthReloginResult> {
  const { account, site, provider, providerCookie } = input;
  const baseUrl = normalizeBaseUrl(site.url || '');
  const expectedUserId = resolvePlatformUserId(account.extraConfig, account.username);
  if (!expectedUserId) {
    return { success: false, reasonCode: 'platform_user_id_missing', message: '缺少站点用户 ID，无法校验重登录身份' };
  }

  const accountProxyUrl = getProxyUrlFromExtraConfig(account.extraConfig);
  const { fetch: undiciFetch } = await import('undici');
  const fetchImpl: AgentRouterReloginFetch = dependencies.fetchImpl
    || ((url, options) => undiciFetch(url, options as any) as unknown as Promise<FetchResponseLike>);
  const deadline = AbortSignal.timeout(25_000);
  const siteFetch: AgentRouterReloginFetch = async (url, options = {}) => {
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(dependencies.requestTimeoutMs ?? 5_000)]);
    const response = await fetchImpl(url, withSiteRecordProxyRequestInit(site, {
      ...options, signal, redirect: 'manual',
    }, accountProxyUrl) as Record<string, unknown>);
    // Consume redirect bodies too so pooled proxy connections are released.
    const text = await response.text();
    return { status: response.status, headers: response.headers, text: async () => text };
  };

  const parseIdentity = (data: Record<string, unknown>) => {
    try {
      const user = validateAgentRouterUser(data, expectedUserId);
      return {
        username: typeof user.username === 'string' ? user.username : undefined,
        balance: parseNewApiBalance(user),
      };
    } catch (error) {
      if (error instanceof AgentRouterRequestError && error.kind === 'invalid-user-id') throw new Error('account_mismatch');
      throw error;
    }
  };

  const readIdentity = async (session: string) => {
    const response = await siteFetch(`${baseUrl}/api/user/self`, {
      headers: { Cookie: buildNewApiCookieCandidates(session)[0] || '', 'New-Api-User': String(expectedUserId), Accept: 'application/json' },
    });
    const responseText = await response.text();
    let body: Record<string, unknown>;
    try { body = parseAgentRouterResponse(response.status, responseText, response.headers.get('retry-after')); }
    catch (error) {
      if (error instanceof AgentRouterRequestError) throw error;
      throw new Error(`${errorMessage(error)}；到账待确认`);
    }
    const data = body?.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : null;
    if (response.status !== 200 || !body?.success || !data) throw new Error(`用户信息读取失败（HTTP ${response.status}）`);
    return parseIdentity(data);
  };

  const fail = (reasonCode: string, message: string): AgentRouterOauthReloginResult => ({
    success: false,
    reasonCode,
    message,
  });

  // 1) 读取签到前余额（旧 Session 仍可用时）
  let beforeBalance: BalanceInfo | null = null;
  let selfReadBlocked = false;
  if ((account.accessToken || '').trim()) {
    try {
      beforeBalance = (await readIdentity(account.accessToken)).balance;
    } catch (error) {
      selfReadBlocked = error instanceof AgentRouterRequestError && ['shield', 'rate-limit'].includes(error.kind);
    }
  }

  // 2) 获取 OAuth state 与 client_id
  let state: string;
  let stateCookie = '';
  try {
    const stateRes = await siteFetch(`${baseUrl}${OAUTH_STATE_PATH}`, {
      headers: { Accept: 'application/json' },
    });
    if (stateRes.status !== 200) return fail('oauth_state_failed', `AgentRouter OAuth state 接口 HTTP ${stateRes.status}`);
    stateCookie = extractSetCookieSession(stateRes);
    const body = parseJsonSafe(await stateRes.text());
    const stateValue = typeof body?.data === 'string' ? body.data.trim() : '';
    if (!stateValue) return fail('oauth_state_missing', 'AgentRouter 未返回 OAuth state');
    if (!stateCookie) return fail('oauth_state_cookie_missing', 'AgentRouter 未下发 OAuth state 会话 Cookie');
    state = stateValue;
  } catch (error) {
    return fail('oauth_state_failed', `获取 AgentRouter OAuth state 失败：${errorMessage(error)}`);
  }

  let clientId: string;
  try {
    const statusRes = await siteFetch(`${baseUrl}${OAUTH_STATUS_PATH}`, {
      headers: { Accept: 'application/json' },
    });
    if (statusRes.status !== 200) return fail('oauth_status_failed', `AgentRouter 站点配置接口 HTTP ${statusRes.status}`);
    const body = parseJsonSafe(await statusRes.text());
    const data = body?.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {};
    const value = typeof data[PROVIDER_CLIENT_ID_KEY[provider]] === 'string'
      ? String(data[PROVIDER_CLIENT_ID_KEY[provider]]).trim()
      : '';
    if (!value) return fail('oauth_client_id_missing', `AgentRouter 未启用 ${provider} 登录`);
    clientId = value;
  } catch (error) {
    return fail('oauth_status_failed', `获取 AgentRouter 站点配置失败：${errorMessage(error)}`);
  }

  // 3) 第三方授权页：携带第三方 Cookie，期望直接 302 回 AgentRouter 回调
  let callbackUrl: string | null = null;
  let currentUrl = PROVIDER_AUTHORIZE_URL[provider](clientId, state);
  const providerOrigin = new URL(currentUrl).origin;
  for (let hop = 0; hop < MAX_PROVIDER_REDIRECTS; hop += 1) {
    let response: FetchResponseLike;
    try {
      response = await siteFetch(currentUrl, {
        headers: {
          Cookie: normalizeNewApiCredential(providerCookie),
          Accept: 'text/html,application/xhtml+xml',
        },
      });
    } catch (error) {
      return fail('provider_request_failed', `请求 ${provider} 授权失败：${errorMessage(error)}`);
    }

    const location = response.headers.get('location') || '';
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, currentUrl);
      const siteOrigin = new URL(baseUrl).origin;
      if (next.origin === siteOrigin && [`/oauth/${provider}`, `/api/oauth/${provider}`].includes(next.pathname)) {
        if (next.searchParams.get('state') !== state) return fail('oauth_state_mismatch', 'AgentRouter OAuth state 不匹配，已停止重登录');
        if (!next.searchParams.get('code')) return fail('provider_callback_missing', `${provider} 未回传授权码`);
        const callback = new URL(`${baseUrl}/api/oauth/${provider}`);
        callback.search = next.search;
        callbackUrl = callback.toString();
        break;
      }
      if (next.origin !== providerOrigin) return fail('provider_redirect_invalid', `${provider} 授权跳转地址异常，已停止重登录`);
      currentUrl = next.toString();
      continue;
    }

    const html = await response.text();
    if (response.status === 429) return fail('provider_rate_limited', `${provider} 授权接口限流，请稍后重试`);
    if (response.status >= 400) return fail('provider_http_error', `${provider} 授权接口 HTTP ${response.status}，未判定登录态失效`);
    if (/just a moment|cf-chl-|challenge-platform/i.test(html)) return fail('provider_challenge', `${provider} 授权页面要求完成站点验证`);
    if (/authorize application|授权/i.test(html) && /<form|button/i.test(html)) {
      return fail('provider_authorization_required', `${provider} 弹出了授权确认页：请在浏览器里重新登录 AgentRouter 并同意授权，再重试`);
    }
    if (/Sign in to GitHub|login_field|name=["']password|登录 Linux|登录 LinuxDO/i.test(html)
      || /\/login(?:$|\?)/.test(new URL(currentUrl).pathname)) {
      return fail('provider_session_expired', `${provider} 登录态已失效：请在浏览器登录 ${provider === 'github' ? 'github.com' : 'connect.linux.do'}，更新「编辑账号 → 签到重登录」Cookie`);
    }
    return fail('provider_response_unexpected', `${provider} 授权返回非预期页面，未判定登录态失效`);

  }
  if (!callbackUrl) {
    return fail('provider_callback_missing', `${provider} 未回传授权码，请检查第三方 Cookie 是否有效`);
  }

  // 4) AgentRouter OAuth 回调：创建新 Session（签到在服务端随登录触发）
  let newSessionToken = '';
  let callbackCheckedIn: boolean | undefined;
  let callbackIdentity: ReturnType<typeof parseIdentity> | null = null;
  let callbackUser: { username?: string } | null = null;
  try {
    const callbackRes = await siteFetch(callbackUrl, {
      headers: { Cookie: stateCookie, Accept: 'application/json' },
    });
    newSessionToken = extractSetCookieSession(callbackRes);
    const body = parseJsonSafe(await callbackRes.text());
    if (callbackRes.status !== 200 || body?.success !== true) return fail('oauth_callback_failed', `AgentRouter OAuth 回调失败（HTTP ${callbackRes.status}）：${typeof body?.message === 'string' ? body.message : '未返回有效结果'}`);
    const data = body?.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : null;
    if (data && typeof data.checked_in === 'boolean') callbackCheckedIn = data.checked_in;
    if (data && typeof data.checkedIn === 'boolean') callbackCheckedIn = data.checkedIn;
    // The official frontend uses this authenticated callback as its login snapshot.
    // Reject an explicit different identity before considering any fallback read.
    if (data?.id != null && parsePositiveInt(data.id) !== expectedUserId) {
      return fail('account_mismatch', 'AgentRouter 重登录落到其他账号，已放弃新凭证');
    }
    if (data?.id != null) {
      callbackUser = { username: typeof data.username === 'string' ? data.username : undefined };
      // The live OAuth DTO includes zero-valued quota fields even for accounts
      // with substantial usage. Those defaults prove identity, not balance.
      if (!(data.quota === 0 && data.used_quota === 0)) {
        try { callbackIdentity = parseIdentity(data); } catch { /* Verify missing quota via the new Session if the endpoint is available. */ }
      }
    }
  } catch (error) {
    return fail('oauth_callback_failed', `AgentRouter OAuth 回调失败：${errorMessage(error)}`);
  }
  if (!newSessionToken) {
    return fail('session_cookie_missing', 'AgentRouter 回调未下发新 Session，签到未完成');
  }

  // 5) Identity and balance are independent: a sparse callback can renew the
  // Session even when user/self is challenged, but must never zero the balance.
  let identity = callbackIdentity;
  let balanceFailure = '';
  if (!identity && !(callbackUser && selfReadBlocked)) {
    try { identity = await readIdentity(newSessionToken); }
    catch (error) {
      if (errorMessage(error) === 'account_mismatch') {
        return fail('account_mismatch', 'AgentRouter 重登录落到其他账号，已放弃新凭证');
      }
      if (!callbackUser) return fail('balance_read_failed', `AgentRouter 重登录后身份/额度验证失败：${errorMessage(error)}；到账待确认`);
      balanceFailure = errorMessage(error);
    }
  }
  const afterBalance = identity?.balance || null;
  // Session renewal does not rotate an API key. Keep it, and the user's display alias.
  await (dependencies.persist || defaultPersist)({
    account, sessionToken: newSessionToken,
    username: account.username || identity?.username || callbackUser?.username,
    balanceInfo: afterBalance, apiToken: account.apiToken || null,
  });
  if (!afterBalance) return {
    ...fail('balance_after_unavailable', `AgentRouter 已重新登录并刷新凭证；${balanceFailure || '余额接口待验证'}，保留原余额，新增奖励待确认`),
    credentialsRefreshed: true, rewardPending: true, checkedIn: callbackCheckedIn,
  };
  if (!beforeBalance) return {
    ...fail('quota_before_unavailable', 'AgentRouter 已重新登录并刷新凭证；缺少签到前额度，新增奖励待确认'),
    credentialsRefreshed: true, balanceInfo: afterBalance, rewardPending: true, checkedIn: callbackCheckedIn,
  };
  const reward = Math.round((afterBalance.quota - beforeBalance.quota) * 1_000_000) / 1_000_000;
  if (reward > 0 && callbackCheckedIn === false) return {
    ...fail('checkin_not_confirmed', 'AgentRouter 已重新登录并刷新凭证；额度增加但回调未确认签到，奖励来源待确认'),
    credentialsRefreshed: true, balanceInfo: afterBalance, rewardPending: true, checkedIn: false,
  };
  return {
    success: reward > 0,
    ...(reward <= 0 ? { quotaUnchanged: true } : {}),
    reward: String(Math.max(0, reward)), checkedIn: callbackCheckedIn,
    credentialsRefreshed: true, balanceInfo: afterBalance,
    message: reward > 0
      ? `AgentRouter 已通过 ${provider} 重新登录，确认总额度 +${reward}`
      : `AgentRouter 已通过 ${provider} 重新登录，额度无新增`,
  };
}
