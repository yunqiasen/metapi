import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { BrowserContext, Cookie, Page, Response as PlaywrightResponse } from 'playwright-core';
import { config } from '../../config.js';
import { loadChromiumBrowserType } from '../browserAutomationRuntime.js';
import { acquireExclusiveBrowserDisplay, releaseBrowserDisplay } from './browserDisplayLease.js';
import { startLinuxDoCaptchaAutoConfirm } from './linuxDoCaptchaConfirm.js';
import type { SiteAuthProviderId } from './providerTypes.js';

const VIEWPORT = { width: 1280, height: 900 } as const;
const SCREENSHOT_TIMEOUT_MS = 15_000;
const BROWSER_STARTUP_TIMEOUT_MS = 30_000;
const TARGET_USER_VERIFY_TIMEOUT_MS = 12_000;
const XVFB_START_DELAY_MS = 500;
const SESSION_CLEANUP_DELAY_MS = 5 * 60_000;
const DEFAULT_NOVNC_PORT = 6080;
const DEFAULT_VNC_PORT = 5900;
const NOVNC_READY_DELAY_MS = 800;
const CHROMIUM_PROFILE_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'] as const;
const FALLBACK_SCREENSHOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAABQAAAANECAYAAABd2Q4SAAAAAXNSR0IArs4c6QAAIABJREFUeJzt3TEOwjAMQNFc/v9PZgYGAkKkC9tOaZ0E0iRbswYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwX+oDAAFwB8kAAAAASUVORK5CYII=',
  'base64',
);
const VALID_FALLBACK_SCREENSHOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const TARGET_PROVIDER_LOGIN_TERMS: Record<SiteAuthProviderId, string[]> = {
  github: ['github', 'git hub'],
  google: ['google', '谷歌'],
  linuxdo: ['linuxdo', 'linux do', 'linux.do'],
};

const PROVIDER_CONSENT_TERMS: Record<SiteAuthProviderId, RegExp[]> = {
  github: [/authorize/i, /continue/i, /授权/, /继续/, /确认/, /允许/],
  google: [/continue/i, /allow/i, /继续/, /确认/, /允许/],
  linuxdo: [/authorize/i, /continue/i, /授权/, /继续/, /确认/, /允许/],
};

type BrowserCookieArtifact = Pick<Cookie, 'name' | 'value' | 'domain' | 'path' | 'expires' | 'httpOnly' | 'secure' | 'sameSite'>;

type BrowserStorageState = {
  cookies?: BrowserCookieArtifact[];
  origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
};

type TargetSiteBrowserSessionStatus = 'pending' | 'success' | 'error' | 'closed';

type TargetSiteBrowserSession = {
  state: string;
  siteId: number;
  provider?: SiteAuthProviderId;
  credentialId?: number;
  targetSiteUrl: string;
  loginUrl: string;
  viewUrl: string;
  noVncUrl: string;
  profileDir: string;
  context?: BrowserContext;
  page?: Page;
  browserProcess?: ChildProcess;
  debuggingPort?: number;
  browserMode?: 'playwright' | 'standalone';
  status: TargetSiteBrowserSessionStatus;
  userInfo?: TargetSiteBrowserUserInfo;
  currentUrl?: string;
  error?: string;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  stopCaptchaAutoConfirm?: () => void;
};

export type TargetSiteBrowserSessionInfo = {
  state: string;
  siteId: number;
  provider?: SiteAuthProviderId;
  credentialId?: number;
  targetSiteUrl: string;
  loginUrl: string;
  viewUrl: string;
  noVncUrl: string;
  status: TargetSiteBrowserSessionStatus;
  currentUrl?: string;
  error?: string;
};

export type TargetSiteBrowserStartResult = TargetSiteBrowserSessionInfo & {
  authorizationUrl: string;
};

export type TargetSiteBrowserInputEvent =
  | { type: 'click'; x: number; y: number }
  | { type: 'mouseDown'; x: number; y: number }
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'mouseUp'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; deltaY: number };

export type TargetSiteBrowserSaveResult = TargetSiteBrowserSessionInfo & {
  accessToken: string;
};

export type TargetSiteBrowserUserInfo = {
  username?: string;
  platformUserId?: number;
};

const sessions = new Map<string, TargetSiteBrowserSession>();
let xvfbProcess: ChildProcess | null = null;
let xvfbStartPromise: Promise<void> | null = null;
let x11vncProcess: ChildProcess | null = null;
let websockifyProcess: ChildProcess | null = null;
let noVncStartPromise: Promise<void> | null = null;

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveBrowserExecutablePath(): string {
  const explicit = asTrimmedString(process.env.SITE_AUTH_BROWSER_EXECUTABLE_PATH);
  if (explicit) return explicit;
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'chromium';
}

function resolveBrowserProxyUrl(): string {
  const explicit = asTrimmedString(process.env.SITE_AUTH_BROWSER_PROXY_URL);
  if (explicit) return explicit;
  const useSystemProxy = asTrimmedString(process.env.SITE_AUTH_BROWSER_USE_SYSTEM_PROXY).toLowerCase();
  if (!['1', 'true', 'yes', 'on'].includes(useSystemProxy)) return '';
  return asTrimmedString(process.env.HTTPS_PROXY)
    || asTrimmedString(process.env.HTTP_PROXY)
    || asTrimmedString(process.env.https_proxy)
    || asTrimmedString(process.env.http_proxy);
}

function resolveBrowserHeadless(): boolean {
  const normalized = asTrimmedString(process.env.SITE_AUTH_BROWSER_HEADLESS).toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  return true;
}

function resolveBrowserDisplay(): string {
  return asTrimmedString(process.env.SITE_AUTH_BROWSER_DISPLAY)
    || asTrimmedString(process.env.DISPLAY)
    || ':99';
}

function resolveNoVncPort(): number {
  const parsed = Number.parseInt(asTrimmedString(process.env.SITE_AUTH_NOVNC_PORT) || asTrimmedString(process.env.NOVNC_PORT), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_NOVNC_PORT;
}

function resolveVncPort(): number {
  const parsed = Number.parseInt(asTrimmedString(process.env.SITE_AUTH_VNC_PORT), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VNC_PORT;
}

function resolveNoVncWebDir(): string {
  return asTrimmedString(process.env.SITE_AUTH_NOVNC_WEB_DIR) || '/usr/share/novnc';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function isTcpPortOpen(port: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveOpen(value);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function allocateLocalTcpPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        if (port > 0) resolvePort(port);
        else rejectPort(new Error('failed to allocate local port'));
      });
    });
  });
}

function resolveDisplaySocketPath(display: string): string | null {
  const match = display.match(/:(\d+)/);
  return match?.[1] ? `/tmp/.X11-unix/X${match[1]}` : null;
}

async function isDisplaySocketOpen(display: string): Promise<boolean> {
  const socketPath = resolveDisplaySocketPath(display);
  if (!socketPath) return false;
  return new Promise((resolveOpen) => {
    const socket = connect({ path: socketPath });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveOpen(value);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function clearStaleDisplaySocket(display: string): Promise<void> {
  const socketPath = resolveDisplaySocketPath(display);
  if (!socketPath || !existsSync(socketPath)) return;
  if (await isDisplaySocketOpen(display)) return;
  await unlink(socketPath).catch(() => {});
  const match = display.match(/:(\d+)/);
  if (match?.[1]) await unlink(`/tmp/.X${match[1]}-lock`).catch(() => {});
}

async function ensureXvfbStarted(display: string): Promise<void> {
  if (await isDisplaySocketOpen(display)) return;
  if (xvfbProcess && xvfbProcess.exitCode === null) return;
  await clearStaleDisplaySocket(display);
  if (xvfbStartPromise) return xvfbStartPromise;
  xvfbStartPromise = (async () => {
    xvfbProcess = spawn('Xvfb', [
      display,
      '-screen',
      '0',
      String(VIEWPORT.width) + 'x' + String(VIEWPORT.height) + 'x24',
      '-nolisten',
      'tcp',
    ], { stdio: 'ignore' });
    await sleep(XVFB_START_DELAY_MS);
    if (!xvfbProcess || xvfbProcess.exitCode !== null) {
      if (await isDisplaySocketOpen(display)) {
        xvfbProcess = null;
        return;
      }
      xvfbProcess = null;
      throw new Error('Xvfb failed to start on ' + display);
    }
  })().finally(() => {
    xvfbStartPromise = null;
  });
  return xvfbStartPromise;
}

function stopXvfb(): void {
  if (!xvfbProcess || xvfbProcess.exitCode !== null) return;
  xvfbProcess.kill('SIGTERM');
  xvfbProcess = null;
}

function stopNoVncGateway(): void {
  if (websockifyProcess && websockifyProcess.exitCode === null) websockifyProcess.kill('SIGTERM');
  if (x11vncProcess && x11vncProcess.exitCode === null) x11vncProcess.kill('SIGTERM');
  websockifyProcess = null;
  x11vncProcess = null;
}

async function ensureNoVncGatewayStarted(display: string): Promise<void> {
  const noVncPort = resolveNoVncPort();
  if (await isTcpPortOpen(noVncPort)) return;
  if (x11vncProcess && x11vncProcess.exitCode === null && websockifyProcess && websockifyProcess.exitCode === null) return;
  if (noVncStartPromise) return noVncStartPromise;
  noVncStartPromise = (async () => {
    await ensureXvfbStarted(display);
    const vncPort = resolveVncPort();
    if (!x11vncProcess || x11vncProcess.exitCode !== null) {
      x11vncProcess = spawn('x11vnc', [
        '-display', display,
        '-rfbport', String(vncPort),
        '-localhost',
        '-forever',
        '-shared',
        '-nopw',
        '-quiet',
      ], { stdio: 'ignore' });
    }
    if (!websockifyProcess || websockifyProcess.exitCode !== null) {
      websockifyProcess = spawn('websockify', [
        '--web', resolveNoVncWebDir(),
        `0.0.0.0:${noVncPort}`,
        `127.0.0.1:${vncPort}`,
      ], { stdio: 'ignore' });
    }
    await sleep(NOVNC_READY_DELAY_MS);
    if (!x11vncProcess || x11vncProcess.exitCode !== null) {
      x11vncProcess = null;
      throw new Error('x11vnc failed to start for target-site browser login');
    }
    if (!websockifyProcess || websockifyProcess.exitCode !== null) {
      websockifyProcess = null;
      throw new Error('websockify/noVNC failed to start for target-site browser login');
    }
  })().finally(() => {
    noVncStartPromise = null;
  });
  return noVncStartPromise;
}

process.once('exit', () => { stopNoVncGateway(); stopXvfb(); });
process.once('SIGINT', () => { stopNoVncGateway(); stopXvfb(); process.exit(130); });
process.once('SIGTERM', () => { stopNoVncGateway(); stopXvfb(); process.exit(143); });

function resolveProfileDir(siteId: number, state: string): string {
  return resolve(config.dataDir, 'target-site-auth-profiles', String(siteId), state);
}

function resolveOrigin(origin: string): string {
  const trimmed = origin.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('target site auth browser origin is required');
  return trimmed;
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('target site URL is required');
  return trimmed;
}

function buildNoVncUrl(origin: string): string {
  const port = resolveNoVncPort();
  const fallback = `http://127.0.0.1:${port}/vnc.html?autoconnect=1&resize=remote&path=websockify&show_dot=1`;
  try {
    const parsed = new URL(resolveOrigin(origin));
    parsed.port = String(port);
    parsed.pathname = '/vnc.html';
    parsed.search = new URLSearchParams({
      autoconnect: '1',
      resize: 'remote',
      path: 'websockify',
      reconnect: '1',
      show_dot: '1',
    }).toString();
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return fallback;
  }
}


function resolveProviderWorkingProfileDir(provider: SiteAuthProviderId): string {
  return resolve(config.dataDir, 'site-auth-working-profiles', provider);
}

async function clearChromiumProfileLocks(profileDir: string): Promise<void> {
  await Promise.all(CHROMIUM_PROFILE_LOCK_FILES.map((name) => (
    rm(join(profileDir, name), { force: true }).catch(() => {})
  )));
}

async function seedStandaloneProfileFromProvider(provider: SiteAuthProviderId | undefined, profileDir: string): Promise<void> {
  if (provider !== 'linuxdo') return;
  const providerProfileDir = resolveProviderWorkingProfileDir(provider);
  if (!existsSync(providerProfileDir)) return;
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dirname(profileDir), { recursive: true });
  await cp(providerProfileDir, profileDir, { recursive: true }).catch(async () => {
    await mkdir(profileDir, { recursive: true });
  });
  await clearChromiumProfileLocks(profileDir);
}

function isLinuxDoStandaloneTarget(input: { provider?: SiteAuthProviderId; credentialPayload: Record<string, unknown>; loginUrl: string; targetSiteUrl?: string }): boolean {
  if (input.provider === 'linuxdo') return true;
  const hostMatches = (value: string | undefined, pattern: RegExp) => {
    try {
      return pattern.test(new URL(value || '').hostname.toLowerCase());
    } catch {
      return false;
    }
  };
  return hostMatches(input.loginUrl, /(^|\.)linux\.do$/)
    || hostMatches(input.targetSiteUrl, /(^|\.)(anyrouter\.top|agentrouter\.org)$/);
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function isTargetProviderLoginText(provider: SiteAuthProviderId, text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  return TARGET_PROVIDER_LOGIN_TERMS[provider].some((term) => normalized.includes(term));
}

function buildTargetProviderLocatorPattern(provider: SiteAuthProviderId): RegExp {
  const escapedTerms = TARGET_PROVIDER_LOGIN_TERMS[provider]
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escapedTerms.join('|'), 'i');
}

function getProviderHost(provider: SiteAuthProviderId): string {
  if (provider === 'github') return 'github.com';
  if (provider === 'google') return 'google.com';
  return 'linux.do';
}

function getProviderAttributeTerms(provider: SiteAuthProviderId): string[] {
  return Array.from(new Set([
    ...TARGET_PROVIDER_LOGIN_TERMS[provider],
    getProviderHost(provider),
    provider,
  ].map((term) => term.toLowerCase())));
}

function normalizeUrlForCompare(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return value.trim().replace(/\/+$/, '');
  }
}

function appendUniqueUrl(urls: string[], value: string): void {
  const normalized = normalizeUrlForCompare(value);
  if (!normalized || urls.some((item) => normalizeUrlForCompare(item) === normalized)) return;
  urls.push(value);
}

export function buildTargetAuthEntryUrls(loginUrl: string, targetSiteUrl: string): string[] {
  const urls: string[] = [];
  const trimmedLoginUrl = loginUrl.trim();
  if (trimmedLoginUrl) appendUniqueUrl(urls, trimmedLoginUrl);
  const base = normalizeBaseUrl(targetSiteUrl || trimmedLoginUrl);
  appendUniqueUrl(urls, new URL('/login', base + '/').toString());
  appendUniqueUrl(urls, new URL('/register', base + '/').toString());
  return urls;
}

function isOnProviderHost(page: Page, provider: SiteAuthProviderId): boolean {
  try {
    const host = new URL(page.url()).hostname.toLowerCase();
    return host === getProviderHost(provider) || host.endsWith(`.${getProviderHost(provider)}`);
  } catch {
    return false;
  }
}

async function clickFirstVisibleLocator(locator: ReturnType<Page['locator']>): Promise<boolean> {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    const visible = await item.isVisible().catch(() => false);
    if (!visible) continue;
    await item.click({ timeout: 5_000 });
    return true;
  }
  return false;
}

async function clickTargetProviderLogin(page: Page, provider: SiteAuthProviderId): Promise<boolean> {
  const pattern = buildTargetProviderLocatorPattern(provider);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const interactive = page.locator('a,button,[role="button"],input[type="button"],input[type="submit"]').filter({ hasText: pattern });
    const count = await interactive.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = interactive.nth(index);
      const text = await item.innerText({ timeout: 500 }).catch(() => '');
      if (!isTargetProviderLoginText(provider, text)) continue;
      const visible = await item.isVisible().catch(() => false);
      if (!visible) continue;
      await item.click({ timeout: 5_000 });
      return true;
    }
    const clickedByAttributes = await page.evaluate((terms) => {
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el);
        const rect = (el as HTMLElement).getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const candidates = Array.from(document.querySelectorAll('a,button,[role="button"],input[type="button"],input[type="submit"]')) as HTMLElement[];
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const text = [
          el.innerText,
          el.textContent,
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('value'),
          el.getAttribute('href'),
          el.getAttribute('data-provider'),
          el.getAttribute('data-oauth-provider'),
          el.className,
          (el as HTMLAnchorElement).href,
          el.querySelector('svg title')?.textContent,
          el.querySelector('[aria-label]')?.getAttribute('aria-label'),
        ]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        if (!text) continue;
        if (!terms.some((term) => text.includes(term))) continue;
        el.click();
        return true;
      }
      return false;
    }, getProviderAttributeTerms(provider)).catch(() => false);
    if (clickedByAttributes) return true;
    await page.waitForTimeout(400).catch(() => {});
  }
  return false;
}

async function clickProviderConsentIfPresent(page: Page, provider: SiteAuthProviderId): Promise<boolean> {
  if (!isOnProviderHost(page, provider)) return false;
  for (const pattern of PROVIDER_CONSENT_TERMS[provider]) {
    const clicked = await clickFirstVisibleLocator(page.locator('button,input[type="submit"],a,[role="button"]').filter({ hasText: pattern }));
    if (clicked) return true;
  }
  return false;
}

async function advanceTargetProviderLogin(page: Page, provider: SiteAuthProviderId, input: { loginUrl: string; targetSiteUrl: string }): Promise<void> {
  let clickedTargetProvider = await clickTargetProviderLogin(page, provider).catch(() => false);
  if (!clickedTargetProvider) {
    for (const candidateUrl of buildTargetAuthEntryUrls(input.loginUrl, input.targetSiteUrl)) {
      if (normalizeUrlForCompare(page.url()) === normalizeUrlForCompare(candidateUrl)) continue;
      await page.goto(candidateUrl, { waitUntil: 'domcontentloaded', timeout: BROWSER_STARTUP_TIMEOUT_MS }).catch(async () => {
        await page.evaluate((url) => { window.location.href = url; }, candidateUrl).catch(() => {});
      });
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      clickedTargetProvider = await clickTargetProviderLogin(page, provider).catch(() => false);
      if (clickedTargetProvider) break;
    }
  }
  if (!clickedTargetProvider) return;
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const clickedConsent = await clickProviderConsentIfPresent(page, provider).catch(() => false);
    if (!clickedConsent) break;
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  }
}

function toSessionInfo(session: TargetSiteBrowserSession): TargetSiteBrowserSessionInfo {
  return {
    state: session.state,
    siteId: session.siteId,
    provider: session.provider,
    credentialId: session.credentialId,
    targetSiteUrl: session.targetSiteUrl,
    loginUrl: session.loginUrl,
    viewUrl: session.viewUrl,
    noVncUrl: session.noVncUrl,
    status: session.status,
    ...(session.currentUrl ? { currentUrl: session.currentUrl } : {}),
    ...(session.error ? { error: session.error } : {}),
  };
}

function scheduleSessionCleanup(session: TargetSiteBrowserSession): void {
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    sessions.delete(session.state);
  }, SESSION_CLEANUP_DELAY_MS);
  session.cleanupTimer.unref?.();
}

async function closeSessionBrowser(session: TargetSiteBrowserSession): Promise<void> {
  releaseBrowserDisplay(`target-site:${session.state}`);
  try {
    session.stopCaptchaAutoConfirm?.();
  } catch {}
  try {
    await session.context?.close();
  } catch {}
  try {
    if (session.browserProcess && session.browserProcess.exitCode === null) session.browserProcess.kill('SIGTERM');
  } catch {}
  scheduleSessionCleanup(session);
}

function normalizeCookieForPlaywright(cookie: unknown): BrowserCookieArtifact | null {
  if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) return null;
  const source = cookie as Record<string, unknown>;
  const name = asTrimmedString(source.name);
  const value = typeof source.value === 'string' ? source.value : '';
  const domain = asTrimmedString(source.domain);
  if (!name || !domain) return null;
  const sameSite = source.sameSite === 'Strict' || source.sameSite === 'None' ? source.sameSite : 'Lax';
  return {
    name,
    value,
    domain,
    path: asTrimmedString(source.path) || '/',
    expires: typeof source.expires === 'number' ? source.expires : -1,
    httpOnly: Boolean(source.httpOnly),
    secure: source.secure === undefined ? true : Boolean(source.secure),
    sameSite,
  };
}

function extractProviderCookies(payload: Record<string, unknown>): BrowserCookieArtifact[] {
  const directCookies = Array.isArray(payload.cookies) ? payload.cookies : [];
  const storage = payload.storageState && typeof payload.storageState === 'object' && !Array.isArray(payload.storageState)
    ? payload.storageState as BrowserStorageState
    : null;
  const storageCookies = Array.isArray(storage?.cookies) ? storage.cookies : [];
  return [...directCookies, ...storageCookies]
    .map(normalizeCookieForPlaywright)
    .filter((item): item is BrowserCookieArtifact => Boolean(item));
}

function extractStorageOrigins(payload: Record<string, unknown>): BrowserStorageState['origins'] {
  const storage = payload.storageState && typeof payload.storageState === 'object' && !Array.isArray(payload.storageState)
    ? payload.storageState as BrowserStorageState
    : null;
  return Array.isArray(storage?.origins) ? storage.origins : [];
}

async function injectProviderCredential(context: BrowserContext, payload: Record<string, unknown>): Promise<void> {
  const cookies = extractProviderCookies(payload);
  if (cookies.length > 0) {
    await context.addCookies(cookies as Cookie[]).catch(() => {});
  }
  const origins = (extractStorageOrigins(payload) || [])
    .filter((origin) => origin && typeof origin.origin === 'string' && Array.isArray(origin.localStorage));
  if (origins.length > 0) {
    await context.addInitScript((items) => {
      const match = items.find((item: { origin: string }) => item.origin === window.location.origin);
      if (!match || !Array.isArray((match as any).localStorage)) return;
      for (const entry of (match as any).localStorage) {
        if (!entry || typeof entry.name !== 'string' || typeof entry.value !== 'string') continue;
        window.localStorage.setItem(entry.name, entry.value);
      }
    }, origins).catch(() => {});
  }
}

function getTargetHost(targetSiteUrl: string): string {
  try {
    return new URL(targetSiteUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isDomainMatch(cookieDomain: string, host: string): boolean {
  const normalized = cookieDomain.trim().toLowerCase().replace(/^\./, '');
  const normalizedHost = host.trim().toLowerCase().replace(/^\./, '');
  return normalized === normalizedHost || normalized.endsWith(`.${normalizedHost}`);
}

function buildCookieHeader(cookies: BrowserCookieArtifact[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const cookie of cookies) {
    const name = asTrimmedString(cookie.name);
    const value = typeof cookie.value === 'string' ? cookie.value : '';
    if (!name || !value || seen.has(name)) continue;
    seen.add(name);
    parts.push(`${name}=${value}`);
  }
  return parts.join('; ');
}

function isUsableTargetSessionCookie(cookie: BrowserCookieArtifact): boolean {
  const name = asTrimmedString(cookie.name).toLowerCase();
  if (!name || ['acw_tc', 'acw_sc__v2', 'cdn_sec_tc'].includes(name)) return false;
  return name === 'session'
    || name === 'token'
    || name === 'auth_token'
    || name === 'access_token'
    || name === 'jwt'
    || name === 'jwt_token'
    || name.includes('session')
    || name.includes('token')
    || name.includes('auth');
}

export function buildTargetSessionCookieHeader(cookies: BrowserCookieArtifact[], targetHost: string): string {
  const domainCookies = targetHost
    ? cookies.filter((cookie) => isDomainMatch(cookie.domain || '', targetHost))
    : [];
  if (!domainCookies.some(isUsableTargetSessionCookie)) return '';
  return buildCookieHeader(domainCookies);
}


type StartedTargetBrowser = {
  context?: BrowserContext;
  page?: Page;
  browserProcess?: ChildProcess;
  debuggingPort?: number;
  browserMode: 'playwright' | 'standalone';
  stopCaptchaAutoConfirm: () => void;
};

async function waitForDebuggingPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTcpPortOpen(port)) return;
    await sleep(250);
  }
  throw new Error('standalone browser debugging port not ready');
}

async function launchStandaloneBrowser(input: {
  profileDir: string;
  loginUrl: string;
  provider?: SiteAuthProviderId;
}): Promise<StartedTargetBrowser> {
  const display = resolveBrowserDisplay();
  await ensureXvfbStarted(display);
  await seedStandaloneProfileFromProvider(input.provider, input.profileDir);
  await mkdir(input.profileDir, { recursive: true });
  await clearChromiumProfileLocks(input.profileDir);
  const debuggingPort = await allocateLocalTcpPort();
  const proxyUrl = resolveBrowserProxyUrl();
  const args = [
    `--user-data-dir=${input.profileDir}`,
    `--remote-debugging-port=${debuggingPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    '--lang=zh-CN,zh',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ...(proxyUrl ? [`--proxy-server=${proxyUrl}`] : []),
    input.loginUrl,
  ];
  const browserProcess = spawn(resolveBrowserExecutablePath(), args, {
    env: { ...process.env, DISPLAY: display },
    stdio: 'ignore',
  });
  browserProcess.unref?.();
  await waitForDebuggingPort(debuggingPort).catch((error) => {
    if (browserProcess.exitCode === null) browserProcess.kill('SIGTERM');
    throw error;
  });
  return {
    browserProcess,
    debuggingPort,
    browserMode: 'standalone',
    stopCaptchaAutoConfirm: () => {},
  };
}

async function connectStandaloneContext<T>(session: TargetSiteBrowserSession, fn: (context: BrowserContext, page: Page) => Promise<T>): Promise<T> {
  if (!session.debuggingPort) throw new Error('standalone browser debugging port missing');
  const chromium = await loadChromiumBrowserType();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.debuggingPort}`);
  const context = browser.contexts()[0];
  const page = context?.pages()[0];
  if (!context || !page) throw new Error('standalone browser page not found');
  return fn(context, page);
}

async function startBrowser(input: {
  profileDir: string;
  loginUrl: string;
  targetSiteUrl: string;
  provider?: SiteAuthProviderId;
  credentialPayload: Record<string, unknown>;
  autoAdvanceProvider?: boolean;
}): Promise<StartedTargetBrowser> {
  if (isLinuxDoStandaloneTarget(input)) {
    return launchStandaloneBrowser({ profileDir: input.profileDir, loginUrl: input.loginUrl, provider: input.provider });
  }
  const chromium = await loadChromiumBrowserType();
  const proxyUrl = resolveBrowserProxyUrl();
  const headless = resolveBrowserHeadless();
  const launchEnv = { ...process.env };
  if (!headless) {
    const display = resolveBrowserDisplay();
    await ensureXvfbStarted(display);
    launchEnv.DISPLAY = display;
  }
  const context = await chromium.launchPersistentContext(input.profileDir, {
    executablePath: resolveBrowserExecutablePath(),
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
    headless,
    env: launchEnv,
    viewport: VIEWPORT,
    ignoreHTTPSErrors: true,
    ignoreDefaultArgs: ['--enable-automation'],
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-infobars',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=AutomationControlled',
      '--lang=zh-CN,zh',
      '--password-store=basic',
      '--use-mock-keychain',
      '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
    ],
  });
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] }); } catch {}
    try { Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); } catch {}
    try {
      const originalQuery = navigator.permissions?.query?.bind(navigator.permissions);
      if (originalQuery) {
        navigator.permissions.query = (parameters) => (
          parameters && (parameters as PermissionDescriptor).name === 'notifications'
            ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
            : originalQuery(parameters)
        );
      }
    } catch {}
  });
  await injectProviderCredential(context, input.credentialPayload);
  const page = context.pages()[0] || await context.newPage();
  const stopCaptchaAutoConfirm = startLinuxDoCaptchaAutoConfirm(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto(input.loginUrl, { waitUntil: 'domcontentloaded', timeout: BROWSER_STARTUP_TIMEOUT_MS }).catch(async () => {
    await page.evaluate((url) => { window.location.href = url; }, input.loginUrl).catch(() => {});
  });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  if (input.provider && input.autoAdvanceProvider !== false) {
    await advanceTargetProviderLogin(page, input.provider, { loginUrl: input.loginUrl, targetSiteUrl: input.targetSiteUrl });
  }
  return { context, page, stopCaptchaAutoConfirm, browserMode: 'playwright' };
}

export async function startTargetSiteBrowserSession(input: {
  siteId: number;
  provider?: SiteAuthProviderId;
  credentialId?: number;
  credentialPayload: Record<string, unknown>;
  loginUrl: string;
  targetSiteUrl: string;
  origin: string;
  autoAdvanceProvider?: boolean;
}): Promise<TargetSiteBrowserStartResult> {
  const state = randomUUID();
  const leaseKey = `target-site:${state}`;
  const targetSiteUrl = normalizeBaseUrl(input.targetSiteUrl);
  const loginUrl = input.loginUrl.trim() || `${targetSiteUrl}/login`;
  const profileDir = resolveProfileDir(input.siteId, state);
  await acquireExclusiveBrowserDisplay(leaseKey, async () => {
    const session = sessions.get(state);
    if (!session) return;
    if (session.status === 'pending') session.status = 'closed';
    await closeSessionBrowser(session);
  });
  await mkdir(profileDir, { recursive: true });
  let started: StartedTargetBrowser;
  let stopCaptchaAutoConfirm: (() => void) | undefined;
  try {
    started = await startBrowser({
      profileDir,
      loginUrl,
      provider: input.provider,
      targetSiteUrl,
      credentialPayload: input.credentialPayload,
      autoAdvanceProvider: input.autoAdvanceProvider,
    });
    stopCaptchaAutoConfirm = started.stopCaptchaAutoConfirm;
  } catch (error) {
    releaseBrowserDisplay(leaseKey);
    throw error;
  }
  await ensureNoVncGatewayStarted(resolveBrowserDisplay());
  const viewUrl = `${resolveOrigin(input.origin)}/site-auth/target-browser/${state}`;
  const noVncUrl = buildNoVncUrl(input.origin);
  const session: TargetSiteBrowserSession = {
    state,
    siteId: input.siteId,
    provider: input.provider,
    credentialId: input.credentialId,
    targetSiteUrl,
    loginUrl,
    viewUrl,
    noVncUrl,
    profileDir,
    context: started.context,
    page: started.page,
    browserProcess: started.browserProcess,
    debuggingPort: started.debuggingPort,
    browserMode: started.browserMode,
    status: 'pending',
    currentUrl: started.page?.url() || loginUrl,
    stopCaptchaAutoConfirm,
  };
  if (session.page) watchTargetBrowserUserInfo(session);
  sessions.set(state, session);
  return {
    ...toSessionInfo(session),
    authorizationUrl: viewUrl,
  };
}

function getSession(state: string): TargetSiteBrowserSession {
  const session = sessions.get(state);
  if (!session) throw new Error('target site auth browser session not found');
  return session;
}

export function getTargetSiteBrowserSession(state: string): TargetSiteBrowserSessionInfo | null {
  const session = sessions.get(state);
  return session ? toSessionInfo(session) : null;
}

export async function captureTargetSiteBrowserScreenshot(state: string): Promise<Buffer> {
  const session = getSession(state);
  if (!session.page || !session.context) return VALID_FALLBACK_SCREENSHOT_PNG;
  try {
    return await session.page.screenshot({
      type: 'png',
      fullPage: false,
      timeout: SCREENSHOT_TIMEOUT_MS,
      animations: 'disabled',
      caret: 'hide',
    });
  } catch {}
  try {
    const cdp = await session.context.newCDPSession(session.page);
    try {
      const captured = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      }) as { data?: string };
      const data = typeof captured.data === 'string' ? captured.data : '';
      if (data) return Buffer.from(data, 'base64');
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch {}
  return VALID_FALLBACK_SCREENSHOT_PNG;
}

export async function sendTargetSiteBrowserInput(state: string, event: TargetSiteBrowserInputEvent): Promise<TargetSiteBrowserSessionInfo> {
  const session = getSession(state);
  if (session.status !== 'pending') return toSessionInfo(session);
  if (!session.page) return toSessionInfo(session);
  if (event.type === 'click') await session.page.mouse.click(event.x, event.y, { delay: 45 });
  else if (event.type === 'mouseDown') { await session.page.mouse.move(event.x, event.y, { steps: 2 }); await session.page.mouse.down(); }
  else if (event.type === 'mouseMove') await session.page.mouse.move(event.x, event.y, { steps: 2 });
  else if (event.type === 'mouseUp') { await session.page.mouse.move(event.x, event.y, { steps: 2 }); await session.page.mouse.up(); }
  else if (event.type === 'type') await session.page.keyboard.type(event.text, { delay: 8 });
  else if (event.type === 'press') await session.page.keyboard.press(event.key);
  else if (event.type === 'scroll') await session.page.mouse.wheel(0, event.deltaY);
  session.currentUrl = session.page.url();
  return toSessionInfo(session);
}

function normalizeTargetBrowserUserInfo(payload: unknown): TargetSiteBrowserUserInfo | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const source = payload as Record<string, unknown>;
  const nested = source.data && typeof source.data === 'object' && !Array.isArray(source.data)
    ? source.data as Record<string, unknown>
    : source;
  const rawId = nested.id ?? nested.user_id ?? nested.userId;
  const platformUserId = typeof rawId === 'number' ? rawId : Number.parseInt(String(rawId || ''), 10);
  const username = ['username', 'display_name', 'displayName', 'email', 'name']
    .map((key) => asTrimmedString(nested[key]))
    .find(Boolean);
  const result: TargetSiteBrowserUserInfo = {
    ...(username ? { username } : {}),
    ...(Number.isInteger(platformUserId) && platformUserId > 0 ? { platformUserId } : {}),
  };
  return result.username || result.platformUserId ? result : null;
}

function watchTargetBrowserUserInfo(session: TargetSiteBrowserSession): void {
  if (!session.page) return;
  session.page.on('response', async (response) => {
    try {
      const url = new URL(response.url());
      if (!url.pathname.endsWith('/api/user/self')) return;
      if (!response.ok()) return;
      const payload = await response.json().catch(() => null);
      const userInfo = normalizeTargetBrowserUserInfo(payload);
      if (userInfo) session.userInfo = userInfo;
    } catch {}
  });
}

export async function readTargetSiteBrowserSessionAccessToken(state: string): Promise<TargetSiteBrowserSaveResult> {
  const session = getSession(state);
  const targetHost = getTargetHost(session.targetSiteUrl);
  const readFromContext = async (context: BrowserContext, page?: Page) => {
    const cookies = (await context.cookies()) as BrowserCookieArtifact[];
    const accessToken = buildTargetSessionCookieHeader(cookies, targetHost);
    if (page) session.currentUrl = page.url();
    if (!accessToken) throw new Error('target site session cookie not found');
    return accessToken;
  };
  const accessToken = session.context
    ? await readFromContext(session.context, session.page)
    : await connectStandaloneContext(session, (context, page) => readFromContext(context, page));
  return {
    ...toSessionInfo(session),
    accessToken,
  };
}

function resolveTargetConsoleUrl(targetSiteUrl: string): string {
  try {
    return new URL('/console', `${normalizeBaseUrl(targetSiteUrl)}/`).toString();
  } catch {
    return `${targetSiteUrl.replace(/\/+$/, '')}/console`;
  }
}

async function readTargetSiteBrowserPageUserInfo(page: Page): Promise<TargetSiteBrowserUserInfo | null> {
  return page.evaluate(async () => {
    const parseJson = (raw: string | null) => {
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return raw; }
    };
    const normalize = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const source = value as Record<string, unknown>;
      const nested = source.data && typeof source.data === 'object' && !Array.isArray(source.data)
        ? source.data as Record<string, unknown>
        : source;
      const rawId = nested.id ?? nested.user_id ?? nested.userId;
      const id = typeof rawId === 'number' ? rawId : Number.parseInt(String(rawId || ''), 10);
      const username = ['username', 'display_name', 'displayName', 'email', 'name']
        .map((key) => typeof nested[key] === 'string' ? String(nested[key]).trim() : '')
        .find(Boolean);
      return username || (Number.isInteger(id) && id > 0)
        ? { ...(username ? { username } : {}), ...(Number.isInteger(id) && id > 0 ? { platformUserId: Math.trunc(id) } : {}) }
        : null;
    };

    const collectStorageCandidates = (storage: Storage) => {
      const values: unknown[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key) continue;
        const raw = storage.getItem(key);
        values.push(parseJson(raw));
        if (/user|account|profile|auth|session|id/i.test(key)) values.push({ id: raw });
      }
      return values;
    };
    const localCandidates = [
      parseJson(window.localStorage.getItem('user')),
      parseJson(window.localStorage.getItem('new-api-user')),
      parseJson(window.localStorage.getItem('userInfo')),
      parseJson(window.sessionStorage.getItem('user')),
      parseJson(window.sessionStorage.getItem('new-api-user')),
      parseJson(window.sessionStorage.getItem('userInfo')),
      ...collectStorageCandidates(window.localStorage),
      ...collectStorageCandidates(window.sessionStorage),
    ];
    const localUser = localCandidates.map(normalize).find(Boolean) as { username?: string; platformUserId?: number } | null;
    const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' };
    if (localUser?.platformUserId) {
      const userId = String(localUser.platformUserId);
      headers['New-Api-User'] = userId;
      headers['Veloera-User'] = userId;
      headers['voapi-user'] = userId;
      headers['User-id'] = userId;
      headers['Rix-Api-User'] = userId;
      headers['neo-api-user'] = userId;
    }
    try {
      const res = await fetch('/api/user/self', { credentials: 'include', headers });
      const payload = await res.json().catch(() => null);
      if (res.ok && payload?.success !== false) {
        const remoteUser = normalize(payload);
        if (remoteUser) return { ...localUser, ...remoteUser };
      }
    } catch {}
    return localUser;
  }).then(normalizeTargetBrowserUserInfo).catch(() => null);
}

async function verifyTargetSiteBrowserUserInfoViaConsole(session: TargetSiteBrowserSession): Promise<TargetSiteBrowserUserInfo | null> {
  if (session.userInfo) return session.userInfo;
  if (!session.page) {
    return connectStandaloneContext(session, async (_context, page) => {
      const shadowSession = { ...session, page } as TargetSiteBrowserSession;
      return verifyTargetSiteBrowserUserInfoViaConsole(shadowSession);
    });
  }
  const page = session.page;
  const consoleUrl = resolveTargetConsoleUrl(session.targetSiteUrl);
  let capturedUserInfo: TargetSiteBrowserUserInfo | null = null;
  const onResponse = async (response: PlaywrightResponse) => {
    if (capturedUserInfo) return;
    try {
      const url = new URL(response.url());
      if (!url.pathname.endsWith('/api/user/self')) return;
      if (!response.ok()) return;
      const userInfo = normalizeTargetBrowserUserInfo(await response.json().catch(() => null));
      if (userInfo) capturedUserInfo = userInfo;
    } catch {}
  };

  page.on('response', onResponse);
  try {
    await page.goto(consoleUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(async () => {
      await page.evaluate((url) => { window.location.href = url; }, consoleUrl).catch(() => {});
    });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    const deadline = Date.now() + TARGET_USER_VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (capturedUserInfo) break;
      capturedUserInfo = await readTargetSiteBrowserPageUserInfo(page);
      if (capturedUserInfo) break;
      await page.waitForTimeout(500).catch(() => {});
    }
  } finally {
    page.off('response', onResponse);
    session.currentUrl = page.url();
  }

  if (capturedUserInfo) session.userInfo = capturedUserInfo;
  return capturedUserInfo;
}

export async function readTargetSiteBrowserSessionUserInfo(state: string): Promise<TargetSiteBrowserUserInfo | null> {
  const session = getSession(state);
  if (session.userInfo) return session.userInfo;
  if (!session.page) {
    return connectStandaloneContext(session, async (_context, page) => {
      session.currentUrl = page.url();
      const pageUserInfo = await readTargetSiteBrowserPageUserInfo(page);
      if (pageUserInfo) {
        session.userInfo = pageUserInfo;
        return pageUserInfo;
      }
      return verifyTargetSiteBrowserUserInfoViaConsole({ ...session, page } as TargetSiteBrowserSession);
    });
  }
  session.currentUrl = session.page.url();
  const pageUserInfo = await readTargetSiteBrowserPageUserInfo(session.page);
  if (pageUserInfo) {
    session.userInfo = pageUserInfo;
    return pageUserInfo;
  }
  return verifyTargetSiteBrowserUserInfoViaConsole(session);
}

export async function markTargetSiteBrowserSessionSaved(state: string): Promise<TargetSiteBrowserSessionInfo> {
  const session = getSession(state);
  session.status = 'success';
  await closeSessionBrowser(session);
  return toSessionInfo(session);
}

export async function persistTargetSiteBrowserProfile(state: string, destinationProfileDir: string): Promise<void> {
  const session = getSession(state);
  await closeSessionBrowser(session);
  await rm(destinationProfileDir, { recursive: true, force: true });
  await mkdir(dirname(destinationProfileDir), { recursive: true });
  await cp(session.profileDir, destinationProfileDir, { recursive: true });
}

export async function saveTargetSiteBrowserSession(state: string): Promise<TargetSiteBrowserSaveResult> {
  const captured = await readTargetSiteBrowserSessionAccessToken(state);
  await markTargetSiteBrowserSessionSaved(state);
  return {
    ...captured,
    status: 'success',
  };
}

export async function closeTargetSiteBrowserSession(state: string): Promise<TargetSiteBrowserSessionInfo> {
  const session = getSession(state);
  if (session.status === 'pending') session.status = 'closed';
  await closeSessionBrowser(session);
  return toSessionInfo(session);
}

export function renderTargetSiteBrowserPage(state: string): string {
  const safeState = htmlEscape(state);
  const jsonState = JSON.stringify(state);
  const session = sessions.get(state);
  const noVncUrl = session?.noVncUrl || buildNoVncUrl('http://127.0.0.1:4000');
  const jsonNoVncUrl = JSON.stringify(noVncUrl);
  const safeHint = htmlEscape(session?.credentialId
    ? '已注入你保存的第三方登录态。请在远程窗口里完成目标站授权，进入目标站控制台后点击“提取并回填表单”。'
    : '这是目标站真实浏览器窗口。请在窗口里自行选择 GitHub / LinuxDO / 验证码完成登录，Metapi 只保存目标站 Session 和浏览器 Profile。');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Metapi 目标站登录</title>
<style>:root{color-scheme:light;background:#0f172a;color:#e5e7eb;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#020617}.bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.12);background:rgba(15,23,42,.94)}.title{font-weight:750}.hint{font-size:12px;color:#99f6e4;max-width:760px;line-height:1.45}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn{border:0;border-radius:999px;padding:8px 13px;font-weight:750;cursor:pointer}.primary{background:#14b8a6;color:#042f2e}.ghost{background:rgba(255,255,255,.1);color:#e5e7eb}.danger{background:#ef4444;color:white}.status{padding:8px 14px;font-size:13px;color:#d1d5db;background:rgba(2,6,23,.75);border-bottom:1px solid rgba(255,255,255,.08)}.stage{height:calc(100vh - 104px);background:#111827}.novnc{width:100%;height:100%;border:0;background:#111827}.ok{color:#86efac}.err{color:#fecaca}</style></head>
<body><div class="bar"><div><div class="title">Metapi 目标站登录窗口</div><div class="hint">${safeHint}</div></div><div class="actions"><button class="btn primary" id="save">提取并回填表单</button><button class="btn ghost" id="reload">重载远程窗口</button><button class="btn danger" id="close">关闭</button></div></div><div class="status" id="status">会话 ${safeState} 正在启动...</div><div class="stage"><iframe id="novnc" class="novnc" allow="clipboard-read; clipboard-write"></iframe></div>
<script>
const state=${jsonState};
const noVncUrl=${jsonNoVncUrl};
const frame=document.getElementById('novnc');
const statusEl=document.getElementById('status');
const saveBtn=document.getElementById('save');
let closed=false,autoSaving=false,manualSaving=false;
function token(){const q=new URLSearchParams(window.location.search).get('metapiAuthToken')||'';return(q.trim()||localStorage.getItem('auth_token')||'').trim()}
function setStatus(t,c){statusEl.textContent=t;statusEl.className='status '+(c||'')}
async function api(path,options={}){const headers=new Headers(options.headers||{});const t=token();if(t)headers.set('Authorization','Bearer '+t);if(options.body&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');const res=await fetch(path,{...options,headers});if(!res.ok&&res.status!==202){let msg='HTTP '+res.status;try{const b=await res.json();msg=b.message||b.error||msg}catch{}throw new Error(msg)}return res}
function loadVnc(){frame.src=noVncUrl}
async function saveAndCreate(auto=false){
  if(closed)return;
  if(auto){if(autoSaving||manualSaving)return;autoSaving=true}else{if(manualSaving)return;manualSaving=true;saveBtn.disabled=true;setStatus('正在检查目标站登录状态...')}
  try{
    const res=await api('/api/accounts/site-auth-browser-sessions/'+encodeURIComponent(state)+'/extract'+(auto?'?auto=1':''),{method:'POST'});
    const data=await res.json().catch(()=>({}));
    if(data&&data.pending){if(!auto)setStatus(data.message||'还没检测到目标站登录状态。请确认已经进入目标站控制台/个人中心。');return}
    if(!data||!data.accessToken){if(!auto)setStatus('没有提取到目标站 Session，请确认已经登录目标站。','err');return}
    if(!window.opener){setStatus('登录窗口回传通道不可用，请从连接管理重新打开。','err');return}
    setStatus('目标站凭证已提取，正在回填添加表单。','ok');
    closed=true;
    try{window.opener&&window.opener.postMessage({type:'metapi-target-site-auth',status:'success',state,siteId:data.siteId,provider:data.provider,credentialId:data.credentialId,targetSiteUrl:data.targetSiteUrl,accessToken:data.accessToken,username:data.username,platformUserId:data.platformUserId},'*')}catch{}
  }catch(e){if(!auto)setStatus(e.message||'提取失败','err')}
  finally{if(auto){autoSaving=false}else{manualSaving=false;saveBtn.disabled=false}}
}
saveBtn.addEventListener('click',()=>saveAndCreate(false));
document.getElementById('reload').addEventListener('click',loadVnc);
document.getElementById('close').addEventListener('click',async()=>{try{await api('/api/accounts/site-auth-browser-sessions/'+encodeURIComponent(state)+'/close',{method:'POST'})}catch{}window.close()});
loadVnc();
setStatus('远程浏览器已连接。请先完成目标站登录，确认进入控制台后点击“提取并回填表单”。不会自动保存未确认状态。');
</script></body></html>`;
}
