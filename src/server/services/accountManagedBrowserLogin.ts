import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BrowserContext, Cookie, Page } from 'playwright-core';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { loadChromiumBrowserType } from './browserAutomationRuntime.js';
import { db, schema } from '../db/index.js';
import { decryptAccountPassword } from './accountCredentialService.js';
import { getAdapter } from './platforms/index.js';
import { getAutoReloginConfig, mergeAccountExtraConfig, resolveProxyUrlFromExtraConfig } from './accountExtraConfig.js';
import { withAccountProxyOverride } from './siteProxy.js';

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
  provider: AnyAgentProvider;
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

const VIEWPORT = { width: 1440, height: 960 } as const;
const CHROMIUM_PROFILE_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'] as const;

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

function normalizeProfileProvider(site: { platform?: unknown; url?: unknown }): string {
  const managedProvider = normalizeProvider(site);
  if (managedProvider) return managedProvider;
  const platform = asString(site.platform).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (platform) return platform;
  try {
    const host = new URL(asString(site.url)).hostname.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return host || 'site';
  } catch {
    return 'site';
  }
}

export function isManagedBrowserLoginSite(site: { platform?: unknown; url?: unknown }): boolean {
  return normalizeProvider(site) !== null;
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
  const value = asString(process.env.METAPI_ACCOUNT_BROWSER_HEADLESS || process.env.SITE_AUTH_BROWSER_HEADLESS).toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
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

async function readUserSelfFromPage(page: Page, provider: ManagedProviderConfig): Promise<Record<string, unknown> | null> {
  return page.evaluate(async ({ userInfoPath, apiUserHeader }) => {
    const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' };
    try {
      const raw = window.localStorage.getItem('user') || window.localStorage.getItem('new-api-user') || '';
      const parsed = raw ? JSON.parse(raw) : null;
      const id = typeof parsed?.id === 'number' ? parsed.id : Number.parseInt(String(parsed?.id || raw || ''), 10);
      if (Number.isFinite(id) && id > 0) headers[apiUserHeader] = String(Math.trunc(id));
    } catch {}
    const res = await fetch(userInfoPath, { credentials: 'include', headers });
    const payload = await res.json().catch(() => null);
    if (!res.ok) return null;
    if (payload?.success === false) return null;
    return payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  }, provider).catch(() => null);
}

function extractUserId(userInfo: Record<string, unknown> | null): number | undefined {
  const raw = userInfo?.id;
  const id = typeof raw === 'number' ? raw : Number.parseInt(String(raw || ''), 10);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function extractUsername(userInfo: Record<string, unknown> | null, fallback?: string | null): string | undefined {
  for (const key of ['username', 'display_name', 'email', 'name']) {
    const value = asString(userInfo?.[key]);
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

async function loginWithPasswordForm(page: Page, username: string, password: string): Promise<void> {
  const emailFilled = await fillFirst(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[autocomplete="username"]',
    'input[placeholder*="邮箱"]',
    'input[placeholder*="账号"]',
    'input[type="text"]',
  ], username);
  const passwordFilled = await fillFirst(page, [
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
    'input[placeholder*="密码"]',
  ], password);
  if (!emailFilled || !passwordFilled) throw new Error('login form not found');
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
  return chromium.launchPersistentContext(input.profileDir, {
    executablePath: resolveBrowserExecutablePath(),
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
    headless: resolveBrowserHeadless(),
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

export async function refreshManagedAccountLogin(
  account: typeof schema.accounts.$inferSelect,
  site: typeof schema.sites.$inferSelect,
): Promise<ManagedAccountLoginRefresh | null> {
  const providerId = normalizeProvider(site);
  if (!providerId || !isManagedBrowserEnabled(account)) return null;

  const relogin = getAutoReloginConfig(account.extraConfig);
  if (!relogin) return null;
  const password = decryptAccountPassword(relogin.passwordCipher);
  if (!password) return null;

  const provider = ANY_AGENT_PROVIDER_CONFIGS[providerId];
  const baseUrl = normalizeBaseUrl(site.url);
  const profileDir = resolveAccountBrowserProfileDir(account, site);
  const adapter = getAdapter(site.platform);
  if (!adapter) return null;

  let context: BrowserContext | null = null;
  try {
    context = await launchPersistentAccountContext({ profileDir, account });
    const page = context.pages()[0] || await context.newPage();
    await page.setViewportSize(VIEWPORT);
    await page.goto(new URL(provider.loginPath, `${baseUrl}/`).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(async () => {
      await page.evaluate((url) => { window.location.href = url; }, new URL(provider.loginPath, `${baseUrl}/`).toString()).catch(() => {});
    });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    let userInfo = await readUserSelfFromPage(page, provider);
    if (!userInfo) {
      await loginWithPasswordForm(page, relogin.username, password);
      userInfo = await readUserSelfFromPage(page, provider);
    }
    if (!userInfo) throw new Error('managed browser login verification failed');

    const accessToken = await collectAccountCookieHeader(context, baseUrl);
    if (!accessToken) throw new Error('managed browser login cookie not found');

    const platformUserId = extractUserId(userInfo);
    const username = extractUsername(userInfo, account.username);
    let apiToken: string | null = null;
    await withAccountProxyOverride(resolveProxyUrlFromExtraConfig(account.extraConfig), async () => {
      apiToken = await adapter.getApiToken(baseUrl, accessToken, platformUserId).catch(() => null);
    });

    const extraConfig = mergeAccountExtraConfig(account.extraConfig, {
      credentialMode: 'session',
      platformUserId,
      managedBrowserProfile: {
        enabled: true,
        provider: provider.provider,
        profileDir,
        wafCookieNames: provider.wafCookieNames,
        lastVerifiedAt: new Date().toISOString(),
      },
    });

    const updates: Record<string, unknown> = {
      accessToken,
      extraConfig,
      status: account.status === 'expired' ? 'active' : account.status,
      updatedAt: new Date().toISOString(),
    };
    if (username) updates.username = username;
    if (apiToken) updates.apiToken = apiToken;

    await db.update(schema.accounts)
      .set(updates)
      .where(eq(schema.accounts.id, account.id))
      .run();

    return {
      accessToken,
      ...(platformUserId ? { platformUserId } : {}),
      ...(username ? { username } : {}),
      apiToken,
      extraConfig,
    };
  } finally {
    await context?.close().catch(() => {});
  }
}
