import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { commitBrowserProfileReplacement } from "./browserProfileTransaction.js";
import type { BrowserContext, Page, Response } from "playwright-core";
import { resolvePersistentBrowserFingerprintSeed } from "./browserAutomationRuntime.js";
import { withAccountBrowserProfileLease } from "./accountBrowserProfileLease.js";
import type { schema } from "../db/index.js";
import {
  resolveAccountBrowserProfileDir,
} from "./accountManagedBrowserLogin.js";
import {
  getAgentRouterBrowserProxyUrlFromExtraConfig,
  resolvePlatformUserId,
  resolveProxyUrlFromExtraConfig,
  type ManagedBrowserLoginProvider,
} from "./accountExtraConfig.js";
import type {
  AgentRouterBrowserUser,
  AgentRouterOauthResult,
  AgentRouterProfileCommit,
  AgentRouterReloginBrowserSession,
} from "./agentRouterReloginCheckinService.js";
import {
  advanceTargetProviderLogin,
  buildTargetSessionCookieHeader,
  clickProviderConsentIfPresent,
  installStandaloneOauthNavigationBridge,
  isProviderConsentText,
  launchTargetProfileNativeContext,
  parseTargetSessionCookieHeader,
} from "./site-auth/targetSiteBrowserSession.js";
import {
  isAliyunWafChallenge,
  solveAliyunWafSliderPage,
} from "./site-auth/aliyunWafSlider.js";

export { isProviderConsentText };
type AccountLike = typeof schema.accounts.$inferSelect;
type SiteLike = typeof schema.sites.$inferSelect;

const PROFILE_LOCK_FILES = [
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
] as const;
const DEFAULT_AGENTROUTER_BROWSER_API_TIMEOUT_MS = 15_000;
const AGENTROUTER_WAF_COOKIE_NAMES = new Set([
  "acw_tc",
  "acw_sc__v2",
  "acw_sc__v3",
  "cdn_sec_tc",
  "cf_clearance",
]);

function parseAgentRouterStoredBrowserCookies(
  value: string,
): Array<{ name: string; value: string }> {
  const authCookies = new Map(
    parseTargetSessionCookieHeader(value).map((cookie) => [cookie.name.toLowerCase(), cookie]),
  );
  for (const part of value.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const cookieValue = part.slice(index + 1).trim();
    if (!name || !cookieValue || !AGENTROUTER_WAF_COOKIE_NAMES.has(name.toLowerCase())) continue;
    authCookies.set(name.toLowerCase(), { name, value: cookieValue });
  }
  return [...authCookies.values()];
}

function resolveAgentRouterBrowserApiTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.AGENTROUTER_BROWSER_API_TIMEOUT_MS || "",
    10,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_AGENTROUTER_BROWSER_API_TIMEOUT_MS;
}

export async function withAgentRouterBrowserOperationTimeout<T, F>(
  operation: Promise<T>,
  timeoutMs: number,
  fallback: F,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<F>((resolve) => {
        timer = setTimeout(() => resolve(fallback), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function selectAgentRouterActivePageIndex(
  urls: string[],
  baseUrl: string,
): number {
  let targetOrigin = "";
  try {
    targetOrigin = new URL(baseUrl).origin;
  } catch {}
  for (let index = urls.length - 1; index >= 0; index -= 1) {
    try {
      if (new URL(urls[index]).origin === targetOrigin) return index;
    } catch {}
  }
  return Math.max(0, urls.length - 1);
}

export function resolveAgentRouterBrowserProxyUrl(
  extraConfig: string | Record<string, unknown> | null | undefined,
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    getAgentRouterBrowserProxyUrlFromExtraConfig(extraConfig) ||
    environment.AGENTROUTER_BROWSER_PROXY_URL?.trim() ||
    resolveProxyUrlFromExtraConfig(extraConfig) ||
    environment.METAPI_ACCOUNT_BROWSER_PROXY_URL?.trim() ||
    environment.SITE_AUTH_BROWSER_PROXY_URL?.trim() ||
    environment.HTTPS_PROXY?.trim() ||
    environment.HTTP_PROXY?.trim() ||
    environment.https_proxy?.trim() ||
    environment.http_proxy?.trim() ||
    undefined
  );
}

export function buildAgentRouterUserHeaders(
  platformUserId: number,
): Record<string, string> {
  const value = String(Math.trunc(platformUserId));
  return {
    "X-Requested-With": "XMLHttpRequest",
    "New-API-User": value,
  };
}

function asPositiveId(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed =
    typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAgentRouterBrowserUserData(
  data: Record<string, unknown>,
): AgentRouterBrowserUser | null {
  const id = asPositiveId(data.id);
  if (!id) return null;

  const quotaRaw = asFiniteNumber(data.quota);
  const usedQuotaRaw = asFiniteNumber(data.used_quota);
  const balanceInfo =
    quotaRaw != null && usedQuotaRaw != null
      ? {
          balance: quotaRaw / 500_000,
          used: usedQuotaRaw / 500_000,
          quota: (quotaRaw + usedQuotaRaw) / 500_000,
        }
      : undefined;

  return {
    id,
    ...(typeof data.username === "string" ? { username: data.username } : {}),
    ...(balanceInfo ? { balanceInfo } : {}),
  };
}

export function parseAgentRouterBrowserUserPayload(
  raw: unknown,
): AgentRouterBrowserUser | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (
    body.success !== true ||
    !body.data ||
    typeof body.data !== "object" ||
    Array.isArray(body.data)
  )
    return null;
  return parseAgentRouterBrowserUserData(body.data as Record<string, unknown>);
}

function parseAgentRouterStoredBrowserUser(
  raw: unknown,
): AgentRouterBrowserUser | null {
  let parsed = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const body = parsed as Record<string, unknown>;
  if (body.success === false) return null;
  const data =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : body;
  return parseAgentRouterBrowserUserData(data);
}

function hasPopulatedAgentRouterBalance(
  user: AgentRouterBrowserUser | null,
): user is AgentRouterBrowserUser & {
  balanceInfo: NonNullable<AgentRouterBrowserUser["balanceInfo"]>;
} {
  const balance = user?.balanceInfo;
  return (
    !!balance &&
    Number.isFinite(balance.balance) &&
    Number.isFinite(balance.used) &&
    Number.isFinite(balance.quota) &&
    (balance.balance !== 0 || balance.used !== 0 || balance.quota !== 0)
  );
}

type AgentRouterBrowserPageSnapshot = {
  consoleBalance?: { balanceText?: unknown; usedText?: unknown } | null;
  storedUser?: unknown;
  fetchedUsers?: unknown[];
  selfResponses?: Array<{
    status?: unknown;
    contentType?: unknown;
    text?: unknown;
    wafDetected?: unknown;
  }>;
};

function parseConsoleMoneyText(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const match = /[$￥¥]\s*([0-9][0-9,]*(?:\.[0-9]+)?)/.exec(raw);
  if (!match?.[1]) return null;
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function selectAgentRouterBrowserPageSnapshotUser(
  snapshot: AgentRouterBrowserPageSnapshot | null | undefined,
  expectedUserId: number,
): AgentRouterBrowserUser | null {
  if (!snapshot || typeof snapshot !== "object") return null;

  const fetchedUsers = (Array.isArray(snapshot.fetchedUsers)
    ? snapshot.fetchedUsers
    : [])
    .map((candidate) => parseAgentRouterStoredBrowserUser(candidate))
    .filter((candidate): candidate is AgentRouterBrowserUser => !!candidate);
  const liveUser = fetchedUsers.find((candidate) => candidate.id === expectedUserId);
  if (!liveUser) return null;

  const balance = parseConsoleMoneyText(snapshot.consoleBalance?.balanceText);
  const used = parseConsoleMoneyText(snapshot.consoleBalance?.usedText);
  if (balance != null && used != null && (balance !== 0 || used !== 0)) {
    return {
      id: expectedUserId,
      ...(liveUser.username ? { username: liveUser.username } : {}),
      balanceInfo: { balance, used, quota: balance + used },
    };
  }

  const storedUser = parseAgentRouterStoredBrowserUser(snapshot.storedUser);
  if (storedUser?.id === expectedUserId && hasPopulatedAgentRouterBalance(storedUser)) {
    return storedUser;
  }
  if (hasPopulatedAgentRouterBalance(liveUser)) return liveUser;
  return {
    id: liveUser.id,
    ...(liveUser.username || storedUser?.username
      ? { username: liveUser.username || storedUser?.username }
      : {}),
  };
}

export function hasAgentRouterAliyunWafResponse(
  snapshot: AgentRouterBrowserPageSnapshot | null | undefined,
): boolean {
  if (!snapshot || !Array.isArray(snapshot.selfResponses)) return false;
  return snapshot.selfResponses.some((response) => {
    if (response?.wafDetected === true) return true;
    const contentType = typeof response?.contentType === "string"
      ? response.contentType.toLowerCase()
      : "";
    const text = typeof response?.text === "string" ? response.text : "";
    const looksHtml = contentType.includes("text/html")
      || /^\s*<(?:!doctype|html|head|body|script|title)\b/i.test(text);
    return looksHtml && isAliyunWafChallenge({ bodyText: text });
  });
}

export function summarizeAgentRouterOauthCallbackPayload(raw: unknown) {
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const data =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : {};
  const user =
    data.user && typeof data.user === "object" && !Array.isArray(data.user)
      ? (data.user as Record<string, unknown>)
      : {};
  return {
    bodyKeys: Object.keys(body).sort(),
    dataKeys: Object.keys(data).sort(),
    userKeys: Object.keys(user).sort(),
    platformUserId: asPositiveId(data.id),
    checkedIn: typeof data.checked_in === "boolean" ? data.checked_in : null,
    quota: asFiniteNumber(data.quota),
    usedQuota: asFiniteNumber(data.used_quota),
    nestedUserId: asPositiveId(user.id),
    nestedQuota: asFiniteNumber(user.quota),
    nestedUsedQuota: asFiniteNumber(user.used_quota),
  };
}

export function parseAgentRouterOauthCallbackPayload(
  raw: unknown,
): AgentRouterOauthResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (
    body.success !== true ||
    !body.data ||
    typeof body.data !== "object" ||
    Array.isArray(body.data)
  )
    return null;
  const data = body.data as Record<string, unknown>;
  const platformUserId = asPositiveId(data.id);
  if (!platformUserId) return null;
  const callbackUser = parseAgentRouterBrowserUserPayload(raw);
  const user =
    callbackUser?.balanceInfo && callbackUser.balanceInfo.quota > 0
      ? callbackUser
      : null;
  return {
    platformUserId,
    ...(typeof data.checked_in === "boolean"
      ? { checkedIn: data.checked_in }
      : {}),
    ...(user ? { user } : {}),
  };
}

type ProviderSessionCookieLike = {
  name?: string;
  value?: string;
  expires?: number;
};

export function hasUsableProviderSessionCookie(
  provider: ManagedBrowserLoginProvider,
  cookies: ProviderSessionCookieLike[],
  nowSeconds = Date.now() / 1000,
): boolean {
  const expectedName = provider === "linuxdo" ? "_t" : "user_session";
  return cookies.some((cookie) => {
    if (cookie.name !== expectedName || !cookie.value?.trim()) return false;
    const expires = typeof cookie.expires === "number" ? cookie.expires : -1;
    return expires <= 0 || expires > nowSeconds;
  });
}

export type ProviderSessionProbeResult =
  | "authenticated"
  | "provider_session_expired"
  | "provider_challenge_required"
  | "provider_session_check_failed";

export function shouldContinueAgentRouterOauthAfterProviderProbe(
  result: ProviderSessionProbeResult,
): boolean {
  return result === "authenticated" || result === "provider_challenge_required";
}

type AgentRouterTargetCookieLike = {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
};

export function selectAgentRouterTargetAuthCookies<T extends AgentRouterTargetCookieLike>(
  cookies: T[],
): T[] {
  return cookies.filter((cookie) => {
    const name = cookie.name?.trim();
    const value = cookie.value?.trim();
    if (!name || !value || AGENTROUTER_WAF_COOKIE_NAMES.has(name.toLowerCase())) return false;
    return parseTargetSessionCookieHeader(`${name}=${value}`).length > 0;
  });
}

export function classifyProviderSessionProbe(
  provider: ManagedBrowserLoginProvider,
  input: { url: string; status: number; bodyText: string; title?: string },
): ProviderSessionProbeResult {
  const oauthFailure = classifyAgentRouterOauthPageFailure(
    provider,
    input.url,
    input.bodyText,
    input.title || "",
  );
  if (oauthFailure) return oauthFailure;

  let host = "";
  let path = "";
  try {
    const parsed = new URL(input.url);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.toLowerCase();
  } catch {
    return "provider_session_check_failed";
  }
  const expectedHost = provider === "linuxdo" ? "linux.do" : "github.com";
  if (!(host === expectedHost || host.endsWith(`.${expectedHost}`))) {
    return "provider_session_check_failed";
  }
  if (input.status < 200 || input.status >= 400) {
    return "provider_session_check_failed";
  }

  if (provider === "github") {
    if (path === "/login" || path.startsWith("/login/")) {
      return "provider_session_expired";
    }
    return path === "/settings/profile" || path.startsWith("/settings/")
      ? "authenticated"
      : "provider_session_check_failed";
  }

  try {
    const payload = JSON.parse(input.bodyText) as Record<string, unknown>;
    const currentUser = payload.current_user;
    return currentUser && typeof currentUser === "object" && !Array.isArray(currentUser)
      ? "authenticated"
      : "provider_session_expired";
  } catch {
    return "provider_session_check_failed";
  }
}

export function isProviderSessionExpiredPage(
  provider: ManagedBrowserLoginProvider,
  url: string,
  bodyText: string,
): boolean {
  let host = "";
  let path = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.toLowerCase();
  } catch {}
  const expectedHost = provider === "linuxdo" ? "linux.do" : "github.com";
  if (!(host === expectedHost || host.endsWith(`.${expectedHost}`)))
    return false;
  if (
    provider === "github" &&
    (path === "/login/oauth/authorize" ||
      path.startsWith("/login/oauth/authorize/"))
  ) {
    return false;
  }
  const text = bodyText.toLowerCase();
  return path.includes("/login") || /sign in|log in|登录|登入/.test(text);
}

export function classifyAgentRouterOauthPageFailure(
  provider: ManagedBrowserLoginProvider,
  url: string,
  bodyText: string,
  title: string,
): "provider_session_expired" | "provider_challenge_required" | null {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {}
  const providerHost = provider === "linuxdo" ? "linux.do" : "github.com";
  if (!(host === providerHost || host.endsWith(`.${providerHost}`)))
    return null;
  const text = `${title} ${bodyText}`.toLowerCase();
  if (
    /just a moment|verify you are human|checking your browser|performing security verification|cloudflare|请稍候|安全验证|验证您是否是真人/.test(
      text,
    )
  ) {
    return "provider_challenge_required";
  }
  return isProviderSessionExpiredPage(provider, url, bodyText)
    ? "provider_session_expired"
    : null;
}

export async function commitAgentRouterReauthProfile(
  stagedProfileDir: string,
  formalProfileDir: string,
): Promise<AgentRouterProfileCommit> {
  return commitBrowserProfileReplacement(stagedProfileDir, formalProfileDir);
}

function isOauthCallbackResponse(response: Response, baseUrl: string): boolean {
  try {
    const url = new URL(response.url());
    return (
      url.origin === new URL(baseUrl).origin &&
      /^\/api\/oauth\/(linuxdo|github)$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function isUserSelfResponse(response: Response, baseUrl: string): boolean {
  try {
    const url = new URL(response.url());
    return (
      url.origin === new URL(baseUrl).origin &&
      url.pathname === "/api/user/self"
    );
  } catch {
    return false;
  }
}

async function waitForCapturedBrowserUser(
  getUser: () => AgentRouterBrowserUser | null,
  expectedUserId: number,
): Promise<AgentRouterBrowserUser | null> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const user = getUser();
    if (user?.id === expectedUserId && user.balanceInfo) return user;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

const READ_AGENTROUTER_PAGE_USER_SNAPSHOT_SCRIPT = String.raw`async ({ url, apiUser, requestTimeoutMs }) => {
  const parseStored = (raw) => {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const storageCandidates = [
    parseStored(window.localStorage.getItem('user')),
    parseStored(window.localStorage.getItem('userInfo')),
    parseStored(window.sessionStorage.getItem('user')),
    parseStored(window.sessionStorage.getItem('userInfo')),
  ];
  const storedUser = storageCandidates.find((candidate) => candidate && typeof candidate === 'object') || null;
  const readLabelParentText = (labels) => {
    const expected = new Set(labels.map((label) => label.toLowerCase()));
    const elements = Array.from(document.querySelectorAll('body *'));
    const labelElement = elements.find((element) => {
      const text = (element.textContent || '').trim().toLowerCase();
      if (!expected.has(text)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    });
    return labelElement?.parentElement?.innerText || null;
  };
  const consoleBalance = {
    balanceText: readLabelParentText(['当前余额', 'Current Balance', 'Current balance']),
    usedText: readLabelParentText(['历史消耗', 'Historical Usage', 'Historical usage']),
  };
  const hasPopulatedQuota = (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)
      ? raw.data
      : raw;
    const quota = Number(data.quota);
    const usedQuota = Number(data.used_quota);
    return Number.isFinite(quota)
      && Number.isFinite(usedQuota)
      && (quota !== 0 || usedQuota !== 0);
  };
  const fetchedUsers = [];
  const selfResponses = [];
  const perRequestTimeoutMs = Math.max(1, Math.floor(requestTimeoutMs / 2));
  for (const headerUser of [null, String(apiUser)]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perRequestTimeoutMs);
    try {
      const headers = {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      };
      if (headerUser) headers['New-API-User'] = headerUser;
      const response = await fetch(url + '/api/user/self', {
        credentials: 'include',
        cache: 'no-store',
        headers,
        signal: controller.signal,
      });
      const text = await response.text();
      const contentType = response.headers.get('content-type') || '';
      const looksHtml = contentType.toLowerCase().includes('text/html')
        || /^\s*<(?:!doctype|html|head|body|script|title)\b/i.test(text);
      selfResponses.push({
        status: response.status,
        contentType,
        text: text.slice(0, 8000),
        wafDetected: looksHtml
          && /访问验证|为了更好的访问体验|aliyuncaptcha|aliyun captcha|captchatype["'\s:]+sliding|aliyunCaptcha-sliding-slider/i.test(text),
      });
      if (!response.ok) continue;
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch {}
      if (!payload) continue;
      fetchedUsers.push(payload);
      if (hasPopulatedQuota(payload)) break;
    } catch {
      // Try the alternate New-API-User header form.
    } finally {
      clearTimeout(timer);
    }
  }
  return { storedUser, consoleBalance, fetchedUsers, selfResponses };
}`;

async function probePageUser(
  page: Page,
  baseUrl: string,
  platformUserId: number,
): Promise<{ user: AgentRouterBrowserUser | null; wafDetected: boolean }> {
  const timeoutMs = resolveAgentRouterBrowserApiTimeoutMs();
  const snapshot = await withAgentRouterBrowserOperationTimeout(
    page.evaluate(READ_AGENTROUTER_PAGE_USER_SNAPSHOT_SCRIPT, {
      url: baseUrl,
      apiUser: platformUserId,
      requestTimeoutMs: timeoutMs,
    }) as Promise<AgentRouterBrowserPageSnapshot>,
    timeoutMs + 1_000,
    null,
  );
  return {
    user: selectAgentRouterBrowserPageSnapshotUser(snapshot, platformUserId),
    wafDetected: hasAgentRouterAliyunWafResponse(snapshot),
  };
}

type AgentRouterWafObservation = {
  detected(): boolean;
  wait(): Promise<void>;
  clear(): void;
};

async function readPageUser(
  page: Page,
  baseUrl: string,
  platformUserId: number,
  observedWaf?: AgentRouterWafObservation,
): Promise<AgentRouterBrowserUser | null> {
  const pageProbe = probePageUser(page, baseUrl, platformUserId)
    .catch(() => ({ user: null, wafDetected: false }));
  const initial = observedWaf
    ? await Promise.race([
        pageProbe,
        observedWaf.detected()
          ? Promise.resolve({ user: null, wafDetected: true as const })
          : observedWaf.wait().then(() => ({ user: null, wafDetected: true as const })),
      ])
    : await pageProbe;
  if (initial.user || !initial.wafDetected) return initial.user;
  observedWaf?.clear();

  await page.setExtraHTTPHeaders(buildAgentRouterUserHeaders(platformUserId));
  try {
    await page.goto(`${baseUrl}/api/user/self`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await solveAliyunWafSliderPage(page, { maxAttempts: 3 });
  } finally {
    await page.setExtraHTTPHeaders({}).catch(() => {});
  }

  await page.goto(`${baseUrl}/console`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  const confirmed = await probePageUser(page, baseUrl, platformUserId)
    .catch(() => ({ user: null, wafDetected: false }));
  if (confirmed.wafDetected) throw new Error("agentrouter_waf_slider_failed");
  return confirmed.user;
}

async function waitForOauthCallback(
  getPages: () => Page[],
  getResult: () => AgentRouterOauthResult | null,
  provider: ManagedBrowserLoginProvider,
): Promise<AgentRouterOauthResult> {
  const configured = Number.parseInt(
    process.env.AGENTROUTER_OAUTH_TIMEOUT_MS || "",
    10,
  );
  const timeoutMs =
    Number.isFinite(configured) && configured > 0 ? configured : 90_000;
  const deadline = Date.now() + timeoutMs;
  let lastFailure: ReturnType<typeof classifyAgentRouterOauthPageFailure> =
    null;
  let reachedProvider = false;
  let clickedConsent = false;
  while (Date.now() < deadline) {
    const result = getResult();
    if (result) return result;
    const pages = getPages();
    for (const candidate of pages) {
      const url = candidate.url();
      let providerHost = false;
      try {
        const host = new URL(url).hostname.toLowerCase();
        const expectedHost = provider === "linuxdo" ? "linux.do" : "github.com";
        providerHost =
          host === expectedHost || host.endsWith(`.${expectedHost}`);
      } catch {}
      reachedProvider ||= providerHost;
      if (
        await clickProviderConsentIfPresent(candidate, provider).catch(
          () => false,
        )
      ) {
        clickedConsent = true;
        break;
      }
      const [text, title] = await Promise.all([
        candidate
          .locator("body")
          .innerText({ timeout: 1_000 })
          .catch(() => ""),
        candidate.title().catch(() => ""),
      ]);
      const failure = classifyAgentRouterOauthPageFailure(
        provider,
        url,
        text,
        title,
      );
      if (failure) {
        let pageLocation = url;
        try {
          const parsed = new URL(url);
          pageLocation = `${parsed.origin}${parsed.pathname}`;
        } catch {}
        console.info(
          `[AgentRouterBrowser] OAuth provider state provider=${provider} page=${pageLocation} title=${JSON.stringify(title.slice(0, 120))} failure=${failure}`,
        );
      }
      if (failure === "provider_session_expired") throw new Error(failure);
      if (failure) lastFailure = failure;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (lastFailure) throw new Error(lastFailure);
  if (reachedProvider && !clickedConsent)
    throw new Error("oauth_consent_not_found");
  throw new Error("oauth_callback_timeout");
}

type AgentRouterBalanceBrowserDependencies = {
  openBrowser(
    account: AccountLike,
    site: SiteLike,
  ): Promise<AgentRouterReloginBrowserSession>;
};

export async function readAgentRouterBalanceFromProfile(
  account: AccountLike,
  site: SiteLike,
  dependencies: AgentRouterBalanceBrowserDependencies = {
    openBrowser: openAgentRouterReloginBrowser,
  },
) {
  const expectedUserId = resolvePlatformUserId(
    account.extraConfig,
    account.username,
  );
  if (!expectedUserId) throw new Error("platform_user_id_missing");

  return withAccountBrowserProfileLease(account.id, async () => {
    const browser = await dependencies.openBrowser(account, site);
    try {
      const user = await browser.readCurrentUser();
      if (!user || user.id !== expectedUserId)
        throw new Error("profile_account_mismatch");
      if (!user.balanceInfo)
        throw new Error("balance_missing_from_browser_response");
      return user.balanceInfo;
    } finally {
      await browser.close().catch(() => {});
      await browser.discardProfile().catch(() => {});
    }
  });
}

export async function openAgentRouterReloginBrowser(
  account: AccountLike,
  site: SiteLike,
): Promise<AgentRouterReloginBrowserSession> {
  const baseUrl = site.url.trim().replace(/\/+$/, "");
  const loginUrl = `${baseUrl}/login`;
  const expectedPlatformUserId = resolvePlatformUserId(
    account.extraConfig,
    account.username,
  );
  if (!expectedPlatformUserId) throw new Error("platform_user_id_missing");
  const formalProfileDir = resolveAccountBrowserProfileDir(account, site);
  if (!existsSync(formalProfileDir)) throw new Error("browser_profile_missing");
  const stagedProfileDir = join(
    dirname(formalProfileDir),
    `reauth-${account.id}-${randomUUID()}`,
  );
  await resolvePersistentBrowserFingerprintSeed(formalProfileDir);
  await cp(formalProfileDir, stagedProfileDir, { recursive: true });
  await Promise.all(
    PROFILE_LOCK_FILES.map((name) =>
      rm(join(stagedProfileDir, name), { force: true }).catch(() => {}),
    ),
  );
  console.info(
    `[AgentRouterBrowser] account=${account.id} staged profile ready`,
  );

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let closed = false;
  let oauthResult: AgentRouterOauthResult | null = null;
  let capturedBrowserUser: AgentRouterBrowserUser | null = null;
  let targetSessionCleared = false;
  let capturedWafChallenge = false;
  let resolveCapturedWaf!: () => void;
  let capturedWafSignal = new Promise<void>((resolve) => {
    resolveCapturedWaf = resolve;
  });
  const markCapturedWaf = () => {
    capturedWafChallenge = true;
    resolveCapturedWaf();
  };
  const observedWaf: AgentRouterWafObservation = {
    detected: () => capturedWafChallenge,
    wait: () => capturedWafSignal,
    clear: () => {
      capturedWafChallenge = false;
      capturedWafSignal = new Promise<void>((resolve) => {
        resolveCapturedWaf = resolve;
      });
    },
  };
  try {
    console.info(
      `[AgentRouterBrowser] account=${account.id} launching profile browser`,
    );
    const launchStartedAt = Date.now();
    const started = await launchTargetProfileNativeContext({
      profileDir: stagedProfileDir,
      loginUrl,
      proxyUrl: resolveAgentRouterBrowserProxyUrl(account.extraConfig),
    });
    context = started.context;
    page = started.page;
    console.info(
      `[AgentRouterBrowser] account=${account.id} profile browser ready in ${Date.now() - launchStartedAt}ms url=${page.url()}`,
    );
    const storedSessionCookies = parseAgentRouterStoredBrowserCookies(
      account.accessToken || "",
    );
    if (storedSessionCookies.length > 0) {
      const profileCookieNames = new Set(
        (await context.cookies(baseUrl).catch(() => []))
          .filter((cookie) => cookie.value?.trim())
          .map((cookie) => cookie.name.toLowerCase()),
      );
      const missingStoredCookies = storedSessionCookies.filter(
        (cookie) => !profileCookieNames.has(cookie.name.toLowerCase()),
      );
      if (missingStoredCookies.length > 0) {
        const targetHost = new URL(baseUrl).hostname;
        await context.addCookies(
          missingStoredCookies.map((cookie) => ({
            ...cookie,
            domain: targetHost,
            path: "/",
            secure: true,
            httpOnly: true,
          })),
        );
      }
    }
    const trackedPages = new WeakSet<Page>();
    const trackPage = (candidate: Page) => {
      if (trackedPages.has(candidate)) return;
      trackedPages.add(candidate);
      candidate.on("response", (response) => {
        if (isOauthCallbackResponse(response, baseUrl)) {
          void response
            .json()
            .then((payload) => {
              oauthResult = parseAgentRouterOauthCallbackPayload(payload);
              if (oauthResult) {
                capturedBrowserUser = null;
                const summary =
                  summarizeAgentRouterOauthCallbackPayload(payload);
                console.info(
                  `[AgentRouterBrowser] OAuth callback account=${account.id} user=${oauthResult.platformUserId} checkedIn=${String(oauthResult.checkedIn)} summary=${JSON.stringify(summary)}`,
                );
              }
            })
            .catch(() => {});
          return;
        }
        if (isUserSelfResponse(response, baseUrl)) {
          const contentType = (response.headers?.()['content-type'] || '').toLowerCase();
          if (contentType.includes('text/html') && typeof response.text === 'function') {
            void response.text().then((text) => {
              if (isAliyunWafChallenge({ bodyText: text })) markCapturedWaf();
            }).catch(() => {});
            return;
          }
          void response
            .json()
            .then((payload) => {
              const user = parseAgentRouterBrowserUserPayload(payload);
              if (
                user?.id === expectedPlatformUserId &&
                hasPopulatedAgentRouterBalance(user)
              ) {
                capturedBrowserUser = user;
                console.info(
                  `[AgentRouterBrowser] Browser self account=${account.id} user=${user.id} totalQuota=${user.balanceInfo.quota}`,
                );
              }
            })
            .catch(() => {});
        }
      });
    };
    context.pages().forEach(trackPage);
    context.on("page", trackPage);
    console.info(
      `[AgentRouterBrowser] account=${account.id} response capture ready`,
    );
  } catch (error) {
    await context?.close().catch(() => {});
    await rm(stagedProfileDir, { recursive: true, force: true }).catch(
      () => {},
    );
    throw error;
  }

  const activePage = () => {
    const pages = context?.pages() || [];
    if (pages.length > 0) {
      return pages[
        selectAgentRouterActivePageIndex(
          pages.map((candidate) => candidate.url()),
          baseUrl,
        )
      ];
    }
    if (!page) throw new Error("browser_page_closed");
    return page;
  };
  return {
    async readCurrentUser() {
      const currentPage = activePage();
      let isConsolePage = false;
      try {
        const currentUrl = new URL(currentPage.url());
        const targetUrl = new URL(`${baseUrl}/console`);
        isConsolePage =
          currentUrl.origin === targetUrl.origin
          && currentUrl.pathname === targetUrl.pathname;
      } catch {}
      if (!isConsolePage) {
        await currentPage
          .goto(`${baseUrl}/console`, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          })
          .catch(() => {});
      }
      console.info(
        `[AgentRouterBrowser] account=${account.id} reading current user url=${currentPage.url()}`,
      );
      let user = await readPageUser(
        currentPage,
        baseUrl,
        expectedPlatformUserId,
        observedWaf,
      );
      if (!targetSessionCleared && !hasPopulatedAgentRouterBalance(user)) {
        const captured = await waitForCapturedBrowserUser(
          () => capturedBrowserUser,
          expectedPlatformUserId,
        );
        if (captured) user = captured;
      }
      console.info(
        `[AgentRouterBrowser] account=${account.id} current user=${user?.id || 0} quota=${user?.balanceInfo?.quota ?? "missing"}`,
      );
      return user;
    },
    async preflightProviderSession(provider) {
      const providerOrigin = provider === "linuxdo"
        ? "https://linux.do"
        : "https://github.com";
      const cookies = await context!.cookies(providerOrigin);
      if (!hasUsableProviderSessionCookie(provider, cookies)) {
        throw new Error("provider_session_expired");
      }

      const probeUrl = provider === "linuxdo"
        ? "https://linux.do/session/current.json"
        : "https://github.com/settings/profile";
      const timeoutMs = resolveAgentRouterBrowserApiTimeoutMs();
      const probePage = await context!.newPage();
      let result: ProviderSessionProbeResult = "provider_session_check_failed";
      try {
        await probePage.setExtraHTTPHeaders({
          Accept: provider === "linuxdo" ? "application/json" : "text/html",
        });
        const response = await withAgentRouterBrowserOperationTimeout(
          probePage.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => null),
          timeoutMs + 1_000,
          null,
        );
        const [bodyText, title] = await Promise.all([
          probePage.locator("body").innerText({ timeout: 2_000 }).catch(() => ""),
          probePage.title().catch(() => ""),
        ]);
        result = classifyProviderSessionProbe(provider, {
          url: probePage.url(),
          status: response?.status() || 0,
          bodyText: bodyText.slice(0, 16_000),
          title,
        });
      } finally {
        await probePage.close().catch(() => {});
      }
      if (!shouldContinueAgentRouterOauthAfterProviderProbe(result)) throw new Error(result);
      console.info(
        `[AgentRouterBrowser] account=${account.id} provider=${provider} session preflight=${result}`,
      );
    },
    async logout() {
      capturedBrowserUser = null;
      oauthResult = null;
      const targetCookies = selectAgentRouterTargetAuthCookies(
        await context!.cookies(baseUrl),
      );
      await Promise.all(targetCookies.map((cookie) => context!.clearCookies({
        name: cookie.name,
        ...(cookie.domain ? { domain: cookie.domain } : {}),
        ...(cookie.path ? { path: cookie.path } : {}),
      })));
      await activePage().evaluate(() => {
        localStorage.removeItem("user");
        localStorage.removeItem("userInfo");
        sessionStorage.removeItem("user");
        sessionStorage.removeItem("userInfo");
      }).catch(() => {});
      const remainingAuthCookies = selectAgentRouterTargetAuthCookies(
        await context!.cookies(baseUrl),
      );
      if (remainingAuthCookies.length > 0) throw new Error("logout_cookie_clear_failed");
      targetSessionCleared = true;
      await activePage()
        .goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
        .catch(() => {});
    },
    async loginWithProvider(provider) {
      oauthResult = null;
      capturedBrowserUser = null;
      targetSessionCleared = false;
      await installStandaloneOauthNavigationBridge(context!, activePage());
      await activePage().goto(loginUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await advanceTargetProviderLogin(activePage(), provider, {
        loginUrl,
        targetSiteUrl: baseUrl,
      });
      const oauth = await waitForOauthCallback(
        () => context?.pages() || [activePage()],
        () => oauthResult,
        provider,
      );
      await activePage().goto(`${baseUrl}/console`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      const browserUser = hasPopulatedAgentRouterBalance(capturedBrowserUser)
        ? capturedBrowserUser
        : (await readPageUser(activePage(), baseUrl, expectedPlatformUserId, observedWaf)) ||
          (await waitForCapturedBrowserUser(
            () => capturedBrowserUser,
            expectedPlatformUserId,
          ));
      return browserUser ? { ...oauth, user: browserUser } : oauth;
    },
    async collectSession() {
      const cookies = await context!.cookies(baseUrl);
      return {
        accessToken: buildTargetSessionCookieHeader(
          cookies,
          new URL(baseUrl).hostname,
        ),
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await context?.close();
      await new Promise((resolve) => setTimeout(resolve, 250));
    },
    commitProfile: () =>
      commitAgentRouterReauthProfile(stagedProfileDir, formalProfileDir),
    async discardProfile() {
      await rm(stagedProfileDir, { recursive: true, force: true });
    },
  };
}
