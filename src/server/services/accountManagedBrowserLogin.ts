import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { BrowserContext, Cookie, Page } from 'playwright-core';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { loadChromiumBrowserType } from './browserAutomationRuntime.js';
import { db, schema } from '../db/index.js';
import { getAdapter } from './platforms/index.js';
import { mergeAccountExtraConfig, mergeManagedBrowserProfileExtraConfig, resolvePlatformUserId, resolveProxyUrlFromExtraConfig } from './accountExtraConfig.js';
import { withAccountProxyOverride, withSiteRequestTimeout } from './siteProxy.js';
import { withAccountBrowserProfileLease } from './accountBrowserProfileLease.js';
import { resolveAgentRouterBalanceProxyCandidates } from './agentRouterBalanceRequest.js';

type AnyAgentProvider = 'anyrouter' | 'agentrouter';

type ManagedBrowserProfileConfig = {
  enabled?: unknown;
  profileDir?: unknown;
};

type AccountExtraConfig = {
  managedBrowserProfile?: ManagedBrowserProfileConfig;
  source?: unknown;
};

type BrowserCookieArtifact = Pick<Cookie, 'name' | 'value' | 'domain'>;

type ManagedProviderConfig = {
  provider: string;
  loginPath: string;
  userInfoPath: string;
  signInPath: string | null;
  apiUserHeader: string;
  wafCookieNames: string[];
};

export type ManagedAccountLoginRefresh = {
  accessToken: string;
  platformUserId?: number;
  username?: string;
  apiToken?: string | null;
  extraConfig: string;
};

export type ManagedAccountPasswordLogin = {
  accessToken: string;
  platformUserId?: number;
  username?: string;
  apiToken?: string | null;
  apiTokens: Array<{ name?: string | null; key?: string | null; enabled?: boolean | null }>;
  profileDir: string;
  provider: string;
  createdFromTemporaryProfile: boolean;
};

const VIEWPORT = { width: 1440, height: 960 } as const;
const CHROMIUM_PROFILE_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'] as const;
const DEFAULT_MANAGED_REFRESH_REQUEST_TIMEOUT_MS = 10_000;

let xvfbProcess: ChildProcess | null = null;
let xvfbStartPromise: Promise<void> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}


function resolveManagedRefreshRequestTimeoutMs(): number {
  const configured = Number.parseInt(asString(process.env.METAPI_MANAGED_REFRESH_REQUEST_TIMEOUT_MS), 10);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(1, configured)
    : DEFAULT_MANAGED_REFRESH_REQUEST_TIMEOUT_MS;
}

async function runManagedRefreshRequest<T>(request: () => Promise<T>): Promise<T | null> {
  const timeoutMs = resolveManagedRefreshRequestTimeoutMs();
  const operation = Promise.resolve()
    .then(() => withSiteRequestTimeout(timeoutMs, request))
    .catch(() => null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(null), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveBrowserDisplay(): string {
  return asString(process.env.SITE_AUTH_BROWSER_DISPLAY)
    || asString(process.env.DISPLAY)
    || ':99';
}

async function ensureXvfbStarted(display: string): Promise<void> {
  if (xvfbProcess && xvfbProcess.exitCode === null) return;
  if (xvfbStartPromise) return xvfbStartPromise;
  xvfbStartPromise = (async () => {
    xvfbProcess = spawn('Xvfb', [
      display,
      '-screen',
      '0',
      `${VIEWPORT.width}x${VIEWPORT.height}x24`,
      '-nolisten',
      'tcp',
    ], { stdio: 'ignore' });
    await sleep(600);
    if (!xvfbProcess || xvfbProcess.exitCode !== null) {
      xvfbProcess = null;
      throw new Error('Xvfb failed to start on ' + display);
    }
    xvfbStartPromise = null;
  })().catch((error) => {
    xvfbStartPromise = null;
    throw error;
  });
  return xvfbStartPromise;
}

function stopXvfb(): void {
  if (!xvfbProcess || xvfbProcess.exitCode !== null) return;
  xvfbProcess.kill('SIGTERM');
  xvfbProcess = null;
}


export async function shutdownManagedAccountBrowserRuntime(): Promise<void> {
  stopXvfb();
}


export const ANY_AGENT_PROVIDER_CONFIGS: Record<AnyAgentProvider, ManagedProviderConfig> = {
  anyrouter: {
    provider: 'anyrouter',
    loginPath: '/login',
    userInfoPath: '/api/user/self',
    signInPath: '/api/user/sign_in',
    apiUserHeader: 'new-api-user',
    wafCookieNames: ['acw_tc', 'cdn_sec_tc', 'acw_sc__v2'],
  },
  agentrouter: {
    provider: 'agentrouter',
    loginPath: '/login',
    userInfoPath: '/api/user/self',
    signInPath: null,
    apiUserHeader: 'new-api-user',
    wafCookieNames: ['acw_tc'],
  },
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseExtraConfig(extraConfig: unknown): AccountExtraConfig {
  if (!extraConfig) return {};
  if (typeof extraConfig === 'object' && !Array.isArray(extraConfig)) return extraConfig as AccountExtraConfig;
  if (typeof extraConfig !== 'string') return {};
  try {
    const parsed = JSON.parse(extraConfig) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as AccountExtraConfig
      : {};
  } catch {
    return {};
  }
}

function normalizeProvider(site: { platform?: unknown; url?: unknown }): AnyAgentProvider | null {
  const platform = asString(site.platform).toLowerCase();
  const url = asString(site.url).toLowerCase();
  if (platform === 'anyrouter' || url.includes('anyrouter')) return 'anyrouter';
  if (platform === 'agentrouter' || url.includes('agentrouter')) return 'agentrouter';
  return null;
}

function normalizeGenericSiteProvider(site: { platform?: unknown; url?: unknown }): string {
  try {
    const host = new URL(asString(site.url)).hostname.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (host) return host;
  } catch {}
  const platform = asString(site.platform).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return platform || 'site';
}

function resolveManagedProviderConfig(
  site: { platform?: unknown; url?: unknown },
  options: { allowGenericNewApi?: boolean } = {},
): ManagedProviderConfig | null {
  const providerId = normalizeProvider(site);
  if (providerId) return ANY_AGENT_PROVIDER_CONFIGS[providerId];

  if (!options.allowGenericNewApi) return null;
  const platform = asString(site.platform).toLowerCase();
  if (platform !== 'new-api' && platform !== 'one-api' && platform !== 'newapi') {
    return null;
  }

  return {
    provider: normalizeGenericSiteProvider(site),
    loginPath: '/login',
    userInfoPath: '/api/user/self',
    signInPath: null,
    apiUserHeader: 'new-api-user',
    wafCookieNames: ['acw_tc', 'cdn_sec_tc', 'acw_sc__v2', 'cf_clearance'],
  };
}

function normalizeProfileProvider(site: { platform?: unknown; url?: unknown }): string {
  const managedProvider = normalizeProvider(site);
  if (managedProvider) return managedProvider;
  return normalizeGenericSiteProvider(site);
}

export function isManagedBrowserLoginSite(site: { platform?: unknown; url?: unknown }): boolean {
  return normalizeProvider(site) !== null;
}

export function canUseManagedBrowserPasswordLogin(site: { platform?: unknown; url?: unknown }): boolean {
  return resolveManagedProviderConfig(site, { allowGenericNewApi: true }) !== null;
}

export function hasStoredAccountBrowserProfile(account: { extraConfig?: unknown }): boolean {
  const extra = parseExtraConfig(account.extraConfig);
  const profile = extra.managedBrowserProfile;
  if (!profile || typeof profile !== 'object' || profile.enabled === false) return false;
  const profileDir = asString(profile.profileDir);
  if (!profileDir || profileDir.includes('<accountId>') || profileDir.includes('pending-')) return false;
  return existsSync(profileDir);
}

function isManagedBrowserEnabled(account: { extraConfig?: unknown }): boolean {
  const extra = parseExtraConfig(account.extraConfig);
  if (extra.managedBrowserProfile?.enabled === false) return false;
  if (extra.managedBrowserProfile?.enabled === true) return true;
  return true;
}

export function resolveAccountBrowserProfileDir(account: { id: number }, site: { platform?: unknown; url?: unknown }): string {
  const provider = normalizeProfileProvider(site);
  return resolve(config.dataDir, 'browser-profiles', 'accounts', provider, String(account.id));
}

function resolveBrowserExecutablePath(): string {
  const explicit = asString(process.env.SITE_AUTH_BROWSER_EXECUTABLE_PATH);
  if (explicit) return explicit;
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'chromium';
}

function resolveBrowserHeadless(): boolean {
  const value = asString(process.env.METAPI_ACCOUNT_BROWSER_HEADLESS).toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return true;
}

function resolveBrowserProxyUrl(account: { extraConfig?: string | Record<string, unknown> | null }): string {
  return resolveProxyUrlFromExtraConfig(account.extraConfig)
    || asString(process.env.METAPI_ACCOUNT_BROWSER_PROXY_URL)
    || asString(process.env.SITE_AUTH_BROWSER_PROXY_URL)
    || asString(process.env.HTTPS_PROXY)
    || asString(process.env.HTTP_PROXY)
    || asString(process.env.https_proxy)
    || asString(process.env.http_proxy);
}

async function clearChromiumProfileLocks(profileDir: string): Promise<void> {
  await Promise.all(CHROMIUM_PROFILE_LOCK_FILES.map((name) => rm(join(profileDir, name), { force: true }).catch(() => {})));
}

function normalizeBaseUrl(url: unknown): string {
  const normalized = asString(url).replace(/\/+$/, '');
  if (!normalized) throw new Error('site url is required');
  return normalized;
}

function isDomainMatch(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.trim().toLowerCase().replace(/^\./, '');
  const normalizedHost = host.trim().toLowerCase().replace(/^\./, '');
  return domain === normalizedHost || domain.endsWith(`.${normalizedHost}`) || normalizedHost.endsWith(`.${domain}`);
}

function buildCookieHeader(cookies: BrowserCookieArtifact[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const cookie of cookies) {
    const name = asString(cookie.name);
    const value = typeof cookie.value === 'string' ? cookie.value : '';
    if (!name || !value || seen.has(name)) continue;
    seen.add(name);
    parts.push(`${name}=${value}`);
  }
  return parts.join('; ');
}

function normalizeStoredBrowserUser(raw: unknown): Record<string, unknown> | null {
  let parsed = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try { parsed = JSON.parse(trimmed); } catch { parsed = { id: trimmed }; }
  }
  const source = getObjectRecord(parsed);
  if (!source) return null;
  const nested = getObjectRecord(source.data) || source;
  const rawId = nested.id ?? nested.user_id ?? nested.userId;
  const id = typeof rawId === 'number' ? rawId : Number.parseInt(String(rawId || ''), 10);
  const username = ['username', 'display_name', 'displayName', 'email', 'name']
    .map((key) => asString(nested[key]))
    .find(Boolean);
  return username || (Number.isFinite(id) && id > 0)
    ? { ...(username ? { username } : {}), ...(Number.isFinite(id) && id > 0 ? { id: Math.trunc(id) } : {}) }
    : null;
}

async function readUserSelfFromPage(
  page: Page,
  provider: ManagedProviderConfig,
  fallbackPlatformUserId?: number,
): Promise<Record<string, unknown> | null> {
  const rawLocalUser = await page.evaluate(() => {
    const direct = window.localStorage.getItem('user')
      || window.localStorage.getItem('new-api-user')
      || window.localStorage.getItem('userInfo')
      || window.sessionStorage.getItem('user')
      || window.sessionStorage.getItem('new-api-user')
      || window.sessionStorage.getItem('userInfo');
    if (direct) return direct;
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key || !/user|account|profile|auth|session|id/i.test(key)) continue;
        const raw = storage.getItem(key);
        if (raw) return raw;
      }
    }
    return null;
  }).catch(() => null);
  const localUser = normalizeStoredBrowserUser(rawLocalUser);
  const remoteRaw = await page.evaluate(async ({ userInfoPath, apiUserHeader, fallbackPlatformUserId }) => {
    const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' };
    if (typeof fallbackPlatformUserId === 'number' && Number.isFinite(fallbackPlatformUserId) && fallbackPlatformUserId > 0) {
      const userId = String(Math.trunc(fallbackPlatformUserId));
      headers[apiUserHeader] = userId;
      headers['New-Api-User'] = userId;
      headers['Veloera-User'] = userId;
      headers['voapi-user'] = userId;
      headers['User-id'] = userId;
      headers['Rix-Api-User'] = userId;
      headers['neo-api-user'] = userId;
    }
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 8_000);
      const res = await fetch(userInfoPath, { credentials: 'include', cache: 'no-store', headers, signal: controller.signal });
      window.clearTimeout(timer);
      const payload = await res.json().catch(() => null);
      if (!res.ok || payload?.success === false) return null;
      const remoteUser = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      return remoteUser && typeof remoteUser === 'object' ? remoteUser : null;
    } catch {
      return null;
    }
  }, {
    ...provider,
    fallbackPlatformUserId: fallbackPlatformUserId || extractUserId(localUser),
  }).catch(() => null);
  const remoteUser = normalizeStoredBrowserUser(remoteRaw);
  if (!remoteUser) return null;
  return { ...(localUser || {}), ...remoteUser };
}

function getObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractUserId(userInfo: unknown): number | undefined {
  const source = getObjectRecord(userInfo);
  const raw = source?.id ?? source?.platformUserId ?? source?.user_id ?? source?.userId;
  const id = typeof raw === 'number' ? raw : Number.parseInt(String(raw || ''), 10);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function extractUsername(userInfo: unknown, fallback?: string | null): string | undefined {
  const source = getObjectRecord(userInfo);
  for (const key of ['username', 'display_name', 'displayName', 'email', 'name']) {
    const value = asString(source?.[key]);
    if (value) return value;
  }
  return asString(fallback) || undefined;
}

async function fillFirst(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!await locator.isVisible({ timeout: 800 }).catch(() => false)) continue;
    await locator.fill(value, { timeout: 5_000 });
    return true;
  }
  return false;
}

async function clickSubmit(page: Page): Promise<void> {
  const selectors = [
    'form.semi-form button[type="submit"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("登录")',
    'button:has-text("Sign in")',
    'button:has-text("Login")',
    '[role="button"]:has-text("登录")',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!await locator.isVisible({ timeout: 800 }).catch(() => false)) continue;
    await locator.click({ timeout: 5_000 });
    return;
  }
  await page.keyboard.press('Enter');
}

async function clickFirstVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!await locator.isVisible({ timeout: 800 }).catch(() => false)) continue;
    await locator.click({ timeout: 5_000 }).catch(async () => {
      await locator.click({ timeout: 5_000, force: true });
    });
    return true;
  }
  return false;
}

async function hasVisibleManagedPasswordForm(page: Page): Promise<boolean> {
  const username = await page.locator([
    '#username',
    'input[name="username"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[autocomplete="username"]',
  ].join(',')).first().isVisible({ timeout: 500 }).catch(() => false);
  if (!username) return false;
  return page.locator([
    '#password',
    'input[name="password"]',
    'input[type="password"]',
    'input[autocomplete="current-password"]',
  ].join(',')).first().isVisible({ timeout: 500 }).catch(() => false);
}

async function prepareManagedAccountPasswordForm(page: Page): Promise<void> {
  if (await hasVisibleManagedPasswordForm(page)) return;

  const overlaySelectors = [
    '[role="dialog"][aria-modal="true"] button:has-text("关闭公告")',
    '[role="dialog"][aria-modal="true"] button:has-text("Close Notice")',
    '[role="dialog"][aria-modal="true"] button:has-text("今日关闭")',
    '[role="dialog"][aria-modal="true"] button:has-text("Close Today")',
    '[role="dialog"][aria-modal="true"] button.semi-modal-close',
    '.semi-modal button.semi-modal-close',
    '[role="dialog"][aria-modal="true"] button[aria-label="close"]',
    '[role="dialog"][aria-modal="true"] button[aria-label="Close"]',
  ];
  const emailEntrySelectors = [
    '.semi-card button:has(.semi-icon-mail):not(form.semi-form button)',
    '.semi-card button:has([aria-label="mail"]):not(form.semi-form button)',
    'button:has-text("Sign in with Email or Username")',
    'button:has-text("Sign in with Email")',
    'button:has-text("邮箱或用户名")',
    'button:has-text("使用邮箱")',
  ];
  const tabSelectors = [
    '.semi-card .semi-tabs-tab:has-text("邮箱")',
    '.semi-card .semi-tabs-tab:has-text("密码")',
    '.semi-card .semi-tabs-tab:has-text("Email")',
  ];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const overlayClosed = await clickFirstVisible(page, overlaySelectors);
    if (overlayClosed) await page.waitForTimeout(250).catch(() => {});
    if (await hasVisibleManagedPasswordForm(page)) return;

    const entryClicked = await clickFirstVisible(page, emailEntrySelectors);
    if (entryClicked) {
      await page.waitForSelector(
        '#username, input[name="username"], input[name="email"], input[type="email"], input[autocomplete="username"]',
        { timeout: 8_000, state: 'visible' },
      ).catch(() => {});
      if (await hasVisibleManagedPasswordForm(page)) return;
    }

    if (await clickFirstVisible(page, tabSelectors)) {
      await page.waitForTimeout(300).catch(() => {});
      if (await hasVisibleManagedPasswordForm(page)) return;
    }
  }
}

async function isShieldChallengePage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const title = document.title || '';
    return /Just a moment|Performing security verification|Cloudflare|cf-turnstile|人机|安全验证|真人/i.test(`${title}\n${text}`)
      || !!document.querySelector('input[name="cf-turnstile-response"], iframe[src*="turnstile"], iframe[src*="challenge"]');
  }).catch(() => false);
}

export async function loginManagedAccountPasswordForm(page: Page, username: string, password: string): Promise<void> {
  await prepareManagedAccountPasswordForm(page);
  await page.waitForSelector('input[type="password"], input[name="password"], input[autocomplete="current-password"]', { timeout: 15_000 }).catch(() => {});

  const emailFilled = await fillFirst(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[autocomplete="username"]',
    'input[placeholder*="邮箱"]',
    'input[placeholder*="账号"]',
    'input[placeholder*="用户名"]',
    'input[type="text"]',
  ], username);
  const passwordFilled = await fillFirst(page, [
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
    'input[placeholder*="密码"]',
  ], password);
  if (!emailFilled || !passwordFilled) {
    if (await isShieldChallengePage(page)) {
      throw new Error('shield challenge requires interactive browser profile');
    }
    throw new Error('login form not found');
  }
  await clickSubmit(page);
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
}

async function launchPersistentAccountContext(input: {
  profileDir: string;
  account: { extraConfig?: string | Record<string, unknown> | null };
}): Promise<BrowserContext> {
  const chromium = await loadChromiumBrowserType();
  await mkdir(input.profileDir, { recursive: true });
  await clearChromiumProfileLocks(input.profileDir);
  const proxyUrl = resolveBrowserProxyUrl(input.account);
  const headless = resolveBrowserHeadless();
  const launchEnv = { ...process.env };
  if (!headless) {
    const display = resolveBrowserDisplay();
    await ensureXvfbStarted(display);
    launchEnv.DISPLAY = display;
  }
  return chromium.launchPersistentContext(input.profileDir, {
    executablePath: resolveBrowserExecutablePath(),
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
    headless,
    env: launchEnv,
    viewport: VIEWPORT,
    ignoreHTTPSErrors: true,
    locale: 'zh-CN',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--password-store=basic',
      '--use-mock-keychain',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ],
  });
}

async function collectAccountCookieHeader(context: BrowserContext, baseUrl: string): Promise<string> {
  const host = new URL(baseUrl).hostname.toLowerCase();
  const cookies = (await context.cookies(baseUrl)) as BrowserCookieArtifact[];
  return buildCookieHeader(cookies.filter((cookie) => isDomainMatch(cookie.domain || '', host)));
}

function resolveTemporaryAccountBrowserProfileDir(site: { platform?: unknown; url?: unknown }): string {
  const provider = normalizeProfileProvider(site);
  return resolve(config.dataDir, 'browser-profiles', 'accounts', provider, `pending-${randomUUID()}`);
}

async function persistManagedAccountBrowserProfileUnlocked(
  sourceProfileDir: string,
  account: { id: number },
  site: { platform?: unknown; url?: unknown },
): Promise<string> {
  const destinationProfileDir = resolveAccountBrowserProfileDir(account, site);
  if (resolve(sourceProfileDir) === resolve(destinationProfileDir)) return destinationProfileDir;
  const tempProfileDir = `${destinationProfileDir}.tmp-${randomUUID()}`;
  await rm(tempProfileDir, { recursive: true, force: true }).catch(() => {});
  try {
    await mkdir(dirname(destinationProfileDir), { recursive: true });
    await cp(sourceProfileDir, tempProfileDir, { recursive: true });
    await rm(destinationProfileDir, { recursive: true, force: true }).catch(() => {});
    await cp(tempProfileDir, destinationProfileDir, { recursive: true });
    await rm(sourceProfileDir, { recursive: true, force: true }).catch(() => {});
    return destinationProfileDir;
  } finally {
    await rm(tempProfileDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function persistManagedAccountBrowserProfile(
  sourceProfileDir: string,
  account: { id: number },
  site: { platform?: unknown; url?: unknown },
): Promise<string> {
  return withAccountBrowserProfileLease(account.id, () => (
    persistManagedAccountBrowserProfileUnlocked(sourceProfileDir, account, site)
  ));
}

export async function discardManagedAccountBrowserProfile(profileDir: string): Promise<void> {
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

function resolveManagedRequestProxyCandidates(
  account: typeof schema.accounts.$inferSelect,
  site: typeof schema.sites.$inferSelect,
): Array<string | undefined> {
  const platform = asString(site.platform).toLowerCase();
  if (platform === 'agentrouter') {
    return resolveAgentRouterBalanceProxyCandidates(account.extraConfig);
  }
  return [resolveProxyUrlFromExtraConfig(account.extraConfig) || undefined];
}

async function readManagedUserInfoWithProxyFallback(input: {
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  adapter: NonNullable<ReturnType<typeof getAdapter>>;
  baseUrl: string;
  accessToken: string;
  platformUserId?: number;
}): Promise<{ userInfo: NonNullable<Awaited<ReturnType<NonNullable<ReturnType<typeof getAdapter>>['getUserInfo']>>>; proxyUrl?: string } | null> {
  for (const proxyUrl of resolveManagedRequestProxyCandidates(input.account, input.site)) {
    const userInfo = await runManagedRefreshRequest(() => withAccountProxyOverride(
      proxyUrl,
      () => input.adapter.getUserInfo(
        input.baseUrl,
        input.accessToken,
        input.platformUserId,
      ),
    ));
    if (userInfo) return { userInfo, ...(proxyUrl ? { proxyUrl } : {}) };
  }
  return null;
}

async function persistManagedRefresh(input: {
  account: typeof schema.accounts.$inferSelect;
  adapter: NonNullable<ReturnType<typeof getAdapter>>;
  baseUrl: string;
  accessToken: string;
  userInfo: unknown;
  existingPlatformUserId?: number;
  profileDir: string;
  provider: ManagedProviderConfig;
  requestProxyUrl?: string;
  markers?: Record<string, unknown>;
}): Promise<ManagedAccountLoginRefresh> {
  const platformUserId = extractUserId(input.userInfo) || input.existingPlatformUserId;
  const username = extractUsername(input.userInfo, input.account.username);
  const apiToken = await runManagedRefreshRequest(() => withAccountProxyOverride(
    input.requestProxyUrl || resolveProxyUrlFromExtraConfig(input.account.extraConfig),
    () => input.adapter.getApiToken(input.baseUrl, input.accessToken, platformUserId),
  ));
  const credentialExtraConfig = mergeAccountExtraConfig(input.account.extraConfig, {
    credentialMode: 'session',
    platformUserId,
  });
  const extraConfig = mergeManagedBrowserProfileExtraConfig(credentialExtraConfig, {
    enabled: true,
    provider: input.provider.provider,
    profileDir: input.profileDir,
    wafCookieNames: input.provider.wafCookieNames,
    lastVerifiedAt: new Date().toISOString(),
    ...(input.markers || {}),
  });
  const updates: Record<string, unknown> = {
    accessToken: input.accessToken,
    extraConfig,
    status: input.account.status === 'expired' ? 'active' : input.account.status,
    updatedAt: new Date().toISOString(),
  };
  if (username) updates.username = username;
  if (apiToken) updates.apiToken = apiToken;
  await db.update(schema.accounts)
    .set(updates)
    .where(eq(schema.accounts.id, input.account.id))
    .run();
  return {
    accessToken: input.accessToken,
    ...(platformUserId ? { platformUserId } : {}),
    ...(username ? { username } : {}),
    apiToken,
    extraConfig,
  };
}

async function refreshRouterFromStagedProfile(input: {
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  adapter: NonNullable<ReturnType<typeof getAdapter>>;
  baseUrl: string;
  profileDir: string;
  provider: ManagedProviderConfig;
  existingPlatformUserId?: number;
}): Promise<ManagedAccountLoginRefresh | null> {
  let browser;
  let recoveryMarker: Record<string, boolean>;
  if (input.provider.provider === 'agentrouter') {
    const { openAgentRouterReloginBrowser } = await import('./agentRouterReloginBrowser.js');
    browser = await openAgentRouterReloginBrowser(input.account, input.site);
    recoveryMarker = { recoveredFromAgentRouterBrowserSnapshot: true };
  } else if (input.provider.provider === 'anyrouter') {
    const { openAnyRouterVisitBrowser } = await import('./anyRouterBrowserVisitCheckinBrowser.js');
    browser = await openAnyRouterVisitBrowser(input.account, input.site);
    recoveryMarker = { recoveredFromAnyRouterBrowserSnapshot: true };
  } else {
    return null;
  }
  if (!browser) return null;

  let closed = false;
  let completed = false;
  let profileCommit: Awaited<ReturnType<typeof browser.commitProfile>> | null = null;
  try {
    const user = await browser.readCurrentUser();
    if (!user) return null;
    if (input.existingPlatformUserId && user.id !== input.existingPlatformUserId) {
      throw new Error('profile_account_mismatch');
    }

    const session = await browser.collectSession();
    if (!session.accessToken.trim()) throw new Error('managed browser login cookie not found');

    await browser.close();
    closed = true;
    profileCommit = await browser.commitProfile();

    const refreshed = await persistManagedRefresh({
      account: input.account,
      adapter: input.adapter,
      baseUrl: input.baseUrl,
      accessToken: session.accessToken,
      userInfo: {
        id: user.id,
        ...(user.username ? { username: user.username } : {}),
      },
      existingPlatformUserId: input.existingPlatformUserId,
      profileDir: profileCommit.profileDir || input.profileDir,
      provider: input.provider,
      markers: recoveryMarker,
    });
    await profileCommit.finalize();
    completed = true;
    return refreshed;
  } catch (error) {
    if (profileCommit) await profileCommit.rollback().catch(() => {});
    throw error;
  } finally {
    if (!closed) await browser.close().catch(() => {});
    if (!completed) await browser.discardProfile().catch(() => {});
  }
}

async function refreshManagedAccountLoginUnlocked(
  account: typeof schema.accounts.$inferSelect,
  site: typeof schema.sites.$inferSelect,
): Promise<ManagedAccountLoginRefresh | null> {
  if (!hasStoredAccountBrowserProfile(account)) return null;
  const provider = resolveManagedProviderConfig(site, { allowGenericNewApi: true });
  if (!provider || !isManagedBrowserEnabled(account)) return null;

  const baseUrl = normalizeBaseUrl(site.url);
  const profileDir = resolveAccountBrowserProfileDir(account, site);
  const adapter = getAdapter(site.platform);
  if (!adapter) return null;

  const existingAccessToken = asString(account.accessToken);
  const existingPlatformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  if (existingAccessToken) {
    const direct = await readManagedUserInfoWithProxyFallback({
      account,
      site,
      adapter,
      baseUrl,
      accessToken: existingAccessToken,
      platformUserId: existingPlatformUserId,
    });
    if (direct) {
      return persistManagedRefresh({
        account,
        adapter,
        baseUrl,
        accessToken: existingAccessToken,
        userInfo: direct.userInfo,
        existingPlatformUserId,
        profileDir,
        provider,
        requestProxyUrl: direct.proxyUrl,
        markers: { recoveredFromStoredSession: true },
      });
    }
  }

  try {
    const routerProfileRefresh = await refreshRouterFromStagedProfile({
      account,
      site,
      adapter,
      baseUrl,
      profileDir,
      provider,
      existingPlatformUserId,
    });
    if (routerProfileRefresh) return routerProfileRefresh;
  } catch (error) {
    if (error instanceof Error && error.message === 'profile_account_mismatch') throw error;
  }

  let context: BrowserContext | null = null;
  try {
    context = await launchPersistentAccountContext({ profileDir, account });
    const profileAccessToken = await collectAccountCookieHeader(context, baseUrl).catch(() => '');
    if (profileAccessToken) {
      const profile = await readManagedUserInfoWithProxyFallback({
        account,
        site,
        adapter,
        baseUrl,
        accessToken: profileAccessToken,
        platformUserId: existingPlatformUserId,
      });
      if (profile) {
        return await persistManagedRefresh({
          account,
          adapter,
          baseUrl,
          accessToken: profileAccessToken,
          userInfo: profile.userInfo,
          existingPlatformUserId,
          profileDir,
          provider,
          requestProxyUrl: profile.proxyUrl,
          markers: { recoveredFromBrowserProfileCookie: true },
        });
      }
    }
    const page = context.pages()[0] || await context.newPage();
    await page.setViewportSize(VIEWPORT);
    await page.goto(new URL(provider.loginPath, `${baseUrl}/`).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(async () => {
      await page.evaluate((url) => { window.location.href = url; }, new URL(provider.loginPath, `${baseUrl}/`).toString()).catch(() => {});
    });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    const userInfo = await readUserSelfFromPage(page, provider, existingPlatformUserId);
    if (!userInfo) return null;

    const accessToken = await collectAccountCookieHeader(context, baseUrl);
    if (!accessToken) throw new Error('managed browser login cookie not found');

    return await persistManagedRefresh({
      account,
      adapter,
      baseUrl,
      accessToken,
      userInfo,
      existingPlatformUserId,
      profileDir,
      provider,
    });
  } finally {
    await context?.close().catch(() => {});
  }
}


export async function refreshManagedAccountLogin(
  account: typeof schema.accounts.$inferSelect,
  site: typeof schema.sites.$inferSelect,
): Promise<ManagedAccountLoginRefresh | null> {
  return withAccountBrowserProfileLease(account.id, () => refreshManagedAccountLoginUnlocked(account, site));
}
