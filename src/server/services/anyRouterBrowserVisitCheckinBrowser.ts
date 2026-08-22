import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import type { schema } from '../db/index.js';
import { getManagedBrowserLoginProvider, resolvePlatformUserId, resolveProxyUrlFromExtraConfig } from './accountExtraConfig.js';
import { resolveAccountBrowserProfileDir } from './accountManagedBrowserLogin.js';
import { resolvePersistentBrowserFingerprintSeed } from './browserAutomationRuntime.js';
import { withAccountBrowserProfileLease } from './accountBrowserProfileLease.js';
import { classifyAgentRouterOauthPageFailure, commitAgentRouterReauthProfile } from './agentRouterReloginBrowser.js';
import type { AnyRouterSignInResult, AnyRouterVisitBrowserSession, AnyRouterVisitUser } from './anyRouterBrowserVisitCheckinService.js';
import { advanceTargetProviderLogin, buildTargetSessionCookieHeader, installStandaloneOauthNavigationBridge, launchTargetProfileCloakContext, parseTargetSessionCookieHeader } from './site-auth/targetSiteBrowserSession.js';

type AccountLike = typeof schema.accounts.$inferSelect;
type SiteLike = typeof schema.sites.$inferSelect;
const LOCKS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

export const selectTargetSessionCookies = parseTargetSessionCookieHeader;

export function resolveAnyRouterBrowserProxyUrl(
  extraConfig: string | Record<string, unknown> | null | undefined,
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    resolveProxyUrlFromExtraConfig(extraConfig) ||
    environment.ANYROUTER_BROWSER_PROXY_URL?.trim() ||
    environment.METAPI_ACCOUNT_BROWSER_PROXY_URL?.trim() ||
    environment.SITE_AUTH_BROWSER_PROXY_URL?.trim() ||
    environment.HTTPS_PROXY?.trim() ||
    environment.HTTP_PROXY?.trim() ||
    environment.https_proxy?.trim() ||
    environment.http_proxy?.trim() ||
    undefined
  );
}

function finite(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export type AnyRouterUserResponse = {
  status: number;
  ok: boolean;
  contentType: string;
  payload: unknown;
  text: string;
};

function isHtmlResponse(input: AnyRouterUserResponse): boolean {
  return input.contentType.toLowerCase().includes('text/html')
    || /^\s*<(?:!doctype|html|script|head|body)\b/i.test(input.text);
}

export function parseAnyRouterUserResponse(input: AnyRouterUserResponse): AnyRouterVisitUser | null {
  if (isHtmlResponse(input)) throw new Error('anyrouter_waf_response');
  if (input.status === 0) throw new Error('anyrouter_self_request_failed');
  if (!input.ok) {
    if (input.status === 401 || input.status === 403) return null;
    throw new Error(`anyrouter_self_http_${input.status}`);
  }
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new Error('anyrouter_self_invalid_response');
  }
  const body = input.payload as Record<string, unknown>;
  if (body.success !== true) return null;
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return null;
  const data = body.data as Record<string, unknown>;
  const id = Number(data.id);
  const quota = finite(data.quota);
  const used = finite(data.used_quota);
  if (!Number.isFinite(id) || id <= 0) throw new Error('anyrouter_user_invalid_response');
  if (quota == null || used == null) throw new Error('anyrouter_balance_missing');
  return {
    id: Math.trunc(id),
    ...(typeof data.username === 'string' ? { username: data.username } : {}),
    balanceInfo: { balance: quota / 500_000, used: used / 500_000, quota: (quota + used) / 500_000 },
  };
}

function anyRouterSignInMessage(raw: Record<string, unknown>): string {
  for (const key of ['message', 'msg', 'error']) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isAnyRouterAlreadyCheckedInMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('already checked')
    || normalized.includes('already signed')
    || message.includes('已经签到')
    || message.includes('已签到')
    || message.includes('重复签到');
}

export function parseAnyRouterSignInPayload(raw: unknown): AnyRouterSignInResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { success: false, message: 'anyrouter_sign_in_invalid_response', alreadyCheckedIn: false };
  }
  const body = raw as Record<string, unknown>;
  const message = anyRouterSignInMessage(body);
  const alreadyCheckedIn = isAnyRouterAlreadyCheckedInMessage(message)
    || (body.success === true && message === '');
  return {
    success: body.success === true || alreadyCheckedIn,
    message,
    alreadyCheckedIn,
  };
}

function isTransientPageNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /execution context was destroyed|navigation|frame was detached/i.test(message);
}

async function retryTransientPageOperation<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 8));
  const delayMs = Math.max(0, Math.trunc(options.delayMs ?? 750));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientPageNavigationError(error)) throw error;
      lastError = error;
    }
    if (attempt + 1 < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export async function readAnyRouterUserWithRetry(
  read: () => Promise<AnyRouterVisitUser | null>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<AnyRouterVisitUser | null> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 8));
  const delayMs = Math.max(0, Math.trunc(options.delayMs ?? 750));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const user = await read();
      if (user) return user;
      lastError = null;
    } catch (error) {
      if (!isTransientPageNavigationError(error)) throw error;
      lastError = error;
    }
    if (attempt + 1 < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (lastError) throw lastError;
  return null;
}

export async function readAnyRouterUserWithOptionalLogin(
  read: () => Promise<AnyRouterVisitUser | null>,
  login?: () => Promise<void>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<AnyRouterVisitUser | null> {
  const existing = await retryTransientPageOperation(read, options);
  if (existing || !login) return existing;
  await login();
  return readAnyRouterUserWithRetry(read, options);
}

export async function triggerAnyRouterSignIn(
  page: Page,
  baseUrl: string,
  userId: number,
  retryOptions: { attempts?: number; delayMs?: number } = {},
): Promise<AnyRouterSignInResult> {
  const response = await retryTransientPageOperation(() => page.evaluate(async ({ url, id }) => {
    try {
      const result = await fetch(`${url}/api/user/sign_in`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'New-API-User': String(id),
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/json',
        },
      });
      const text = await result.text();
      let payload: unknown = null;
      try { payload = text ? JSON.parse(text) : null; } catch {}
      return { status: result.status, ok: result.ok, payload, text };
    } catch (error) {
      return { status: 0, ok: false, payload: null, text: error instanceof Error ? error.message : String(error) };
    }
  }, { url: baseUrl, id: userId }), retryOptions);

  const parsed = parseAnyRouterSignInPayload(response.payload);
  if (parsed.success) return parsed;
  if (parsed.message && parsed.message !== 'anyrouter_sign_in_invalid_response') return parsed;
  const detail = String(response.text || '').trim();
  return {
    success: false,
    message: detail || (response.status ? `anyrouter_sign_in_http_${response.status}` : 'anyrouter_sign_in_request_failed'),
    alreadyCheckedIn: false,
  };
}

async function readUser(page: Page, baseUrl: string, userId: number): Promise<AnyRouterVisitUser | null> {
  const response = await page.evaluate(async ({ url, id }) => {
    try {
      const result = await fetch(`${url}/api/user/self`, {
        credentials: 'include',
        cache: 'no-store',
        headers: { 'New-API-User': String(id), 'X-Requested-With': 'XMLHttpRequest' },
      });
      const text = await result.text();
      let payload: unknown = null;
      try { payload = text ? JSON.parse(text) : null; } catch {}
      return {
        status: result.status,
        ok: result.ok,
        contentType: result.headers.get('content-type') || '',
        payload,
        text,
      };
    } catch {
      return { status: 0, ok: false, contentType: '', payload: null, text: '' };
    }
  }, { url: baseUrl, id: userId });
  return parseAnyRouterUserResponse(response);
}

async function classifyProviderRecoveryPages(
  pages: Page[],
  provider: 'linuxdo' | 'github',
): Promise<void> {
  for (const candidate of pages) {
    const url = candidate.url();
    const [bodyText, title] = await Promise.all([
      candidate.locator('body').innerText({ timeout: 1_000 }).catch(() => ''),
      candidate.title().catch(() => ''),
    ]);
    const failure = classifyAgentRouterOauthPageFailure(provider, url, bodyText, title);
    if (failure) throw new Error(failure);
  }
}

export async function readAnyRouterBalanceFromProfile(
  account: AccountLike,
  site: SiteLike,
): Promise<NonNullable<AnyRouterVisitUser['balanceInfo']>> {
  const baseUrl = site.url.trim().replace(/\/+$/, '');
  const userId = resolvePlatformUserId(account.extraConfig, account.username);
  if (!userId) throw new Error('platform_user_id_missing');

  return withAccountBrowserProfileLease(account.id, async () => {
    const formal = resolveAccountBrowserProfileDir(account, site);
    if (!existsSync(formal)) throw new Error('browser_profile_missing');
    const staged = join(dirname(formal), `balance-${account.id}-${randomUUID()}`);
    await resolvePersistentBrowserFingerprintSeed(formal);
    await cp(formal, staged, { recursive: true });
    await Promise.all(LOCKS.map((name) => rm(join(staged, name), { force: true }).catch(() => {})));

    let context: BrowserContext | null = null;
    try {
      const selfUrl = `${baseUrl}/api/user/self`;
      const started = await launchTargetProfileCloakContext({
        profileDir: staged,
        loginUrl: selfUrl,
        proxyUrl: resolveAnyRouterBrowserProxyUrl(account.extraConfig),
      });
      context = started.context;
      const page = started.page;
      const sessionCookies = selectTargetSessionCookies(account.accessToken || '');
      if (sessionCookies.length > 0) {
        await context.addCookies(sessionCookies.map((cookie) => ({
          ...cookie,
          domain: new URL(baseUrl).hostname,
          path: '/',
          secure: true,
          httpOnly: true,
        }))).catch(() => {});
      }
      await page.setExtraHTTPHeaders({
        'New-API-User': String(userId),
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      });
      const response = await page.goto(selfUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      }).catch(() => null);
      const text = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
      let payload: unknown = null;
      try { payload = text ? JSON.parse(text) : null; } catch {}
      const user = parseAnyRouterUserResponse({
        status: response?.status() || 0,
        ok: Boolean(response?.ok()),
        contentType: response?.headers()['content-type'] || '',
        payload,
        text,
      });
      if (!user) throw new Error('anyrouter_target_session_expired');
      if (user.id !== userId) throw new Error('profile_account_mismatch');
      if (!user.balanceInfo) throw new Error('anyrouter_balance_missing');
      return user.balanceInfo;
    } finally {
      await context?.close().catch(() => {});
      await rm(staged, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export async function openAnyRouterVisitBrowser(account: AccountLike, site: SiteLike): Promise<AnyRouterVisitBrowserSession> {
  const baseUrl = site.url.trim().replace(/\/+$/, '');
  const userId = resolvePlatformUserId(account.extraConfig, account.username);
  if (!userId) throw new Error('platform_user_id_missing');
  const formal = resolveAccountBrowserProfileDir(account, site);
  if (!existsSync(formal)) throw new Error('browser_profile_missing');
  const staged = join(dirname(formal), `checkin-${account.id}-${randomUUID()}`);
  await resolvePersistentBrowserFingerprintSeed(formal);
  await cp(formal, staged, { recursive: true });
  await Promise.all(LOCKS.map((name) => rm(join(staged, name), { force: true }).catch(() => {})));
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let closed = false;
  try {
    const started = await launchTargetProfileCloakContext({ profileDir: staged, loginUrl: baseUrl, proxyUrl: resolveAnyRouterBrowserProxyUrl(account.extraConfig) });
    context = started.context;
    page = started.page;
    const sessionCookies = selectTargetSessionCookies(account.accessToken || '');
    if (sessionCookies.length > 0) {
      await context.addCookies(sessionCookies.map((cookie) => ({
        ...cookie, domain: new URL(baseUrl).hostname, path: '/', secure: true, httpOnly: true,
      }))).catch(() => {});
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
  } catch (error) {
    await context?.close().catch(() => {});
    await rm(staged, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const activeTargetPage = (): Page => {
    const pages = context?.pages() || [];
    let targetOrigin = '';
    try { targetOrigin = new URL(baseUrl).origin; } catch {}
    for (let index = pages.length - 1; index >= 0; index -= 1) {
      try {
        if (new URL(pages[index].url()).origin === targetOrigin) return pages[index];
      } catch {}
    }
    if (!page) throw new Error('browser_page_closed');
    return page;
  };

  return {
    readCurrentUser: () => {
      const provider = getManagedBrowserLoginProvider(account.extraConfig, account.username);
      const recover = provider
        ? async () => {
            const current = activeTargetPage();
            const loginUrl = `${baseUrl}/login`;
            await installStandaloneOauthNavigationBridge(context!, current);
            await current.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await advanceTargetProviderLogin(current, provider, { loginUrl, targetSiteUrl: baseUrl });
            await classifyProviderRecoveryPages(context?.pages() || [current], provider);
          }
        : undefined;
      return readAnyRouterUserWithOptionalLogin(() => readUser(activeTargetPage(), baseUrl, userId), recover);
    },
    triggerCheckin: () => triggerAnyRouterSignIn(activeTargetPage(), baseUrl, userId),
    async collectSession() {
      const cookies = await context!.cookies(baseUrl);
      return { accessToken: buildTargetSessionCookieHeader(cookies, new URL(baseUrl).hostname) };
    },
    async close() { if (!closed) { closed = true; await context?.close(); } },
    commitProfile: () => commitAgentRouterReauthProfile(staged, formal),
    discardProfile: () => rm(staged, { recursive: true, force: true }),
  };
}
