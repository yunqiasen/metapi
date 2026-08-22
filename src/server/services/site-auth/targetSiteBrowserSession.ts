import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Browser, BrowserContext, Cookie, Page, Response as PlaywrightResponse } from 'playwright-core';
import { config } from '../../config.js';
import { buildCloakPersistentContextOptions, loadChromiumBrowserType, loadCloakPersistentContextLauncher, resolvePersistentBrowserFingerprintSeed } from '../browserAutomationRuntime.js';
import { acquireExclusiveBrowserDisplay, releaseBrowserDisplay } from './browserDisplayLease.js';
import { clickLinuxDoCaptchaVerifyWithTrustedInput, type LinuxDoCaptchaAutoConfirmResult } from './linuxDoCaptchaConfirm.js';
import type { SiteAuthProviderId } from './providerTypes.js';
import { commitBrowserProfileReplacement, type BrowserProfileCommit } from '../browserProfileTransaction.js';

const VIEWPORT = { width: 1280, height: 900 } as const;
const SCREENSHOT_TIMEOUT_MS = 15_000;
const BROWSER_STARTUP_TIMEOUT_MS = 30_000;
const TARGET_USER_VERIFY_TIMEOUT_MS = 12_000;
const XVFB_START_DELAY_MS = 500;
const SESSION_CLEANUP_DELAY_MS = 5 * 60_000;
const PENDING_SESSION_TTL_MS = 20 * 60_000;
const DEFAULT_NOVNC_PORT = 6080;
const DEFAULT_VNC_PORT = 5900;
const NOVNC_READY_DELAY_MS = 800;
const CHROMIUM_PROFILE_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'] as const;
const BROWSER_CLOSE_TIMEOUT_MS = 1_500;
const PROFILE_FLUSH_TIMEOUT_MS = 5_000;
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
  linuxdo: [/authorize/i, /continue/i, /allow/i, /授权/, /继续/, /确认/, /允许/],
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
  accountId?: number;
  provider?: SiteAuthProviderId;
  credentialId?: number;
  targetSiteUrl: string;
  loginUrl: string;
  viewUrl: string;
  noVncUrl: string;
  profileDir: string;
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  browserProcess?: ChildProcess;
  debuggingPort?: number;
  browserMode?: 'playwright' | 'standalone' | 'cloak';
  status: TargetSiteBrowserSessionStatus;
  userInfo?: TargetSiteBrowserUserInfo;
  currentUrl?: string;
  error?: string;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  pendingExpiryTimer?: ReturnType<typeof setTimeout>;
  stopCaptchaAutoConfirm?: () => void;
  trackedPages?: Set<Page>;
  browserClosed?: boolean;
  closePromise?: Promise<void>;
};

export type TargetSiteBrowserSessionInfo = {
  state: string;
  siteId: number;
  accountId?: number;
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

export function buildStandaloneBrowserProxyArgs(_loginUrl: string, configuredProxyUrl: string): string[] {
  const proxyUrl = asTrimmedString(configuredProxyUrl);
  return proxyUrl ? [`--proxy-server=${proxyUrl}`] : [];
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

function waitForChildProcessExit(process: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      cleanup();
      resolveExit(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = () => {
      cleanup();
      resolveExit(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      process.off('exit', onExit);
    };
    process.once('exit', onExit);
  });
}

async function closeStandaloneBrowser(session: TargetSiteBrowserSession): Promise<void> {
  const browserProcess = session.browserProcess;
  if (!browserProcess) return;

  if (browserProcess.exitCode === null && session.browser) {
    try {
      await session.browser.close();
      if (await waitForChildProcessExit(browserProcess, BROWSER_CLOSE_TIMEOUT_MS)) return;
    } catch {}
  }

  try {
    if (browserProcess.exitCode === null) browserProcess.kill('SIGTERM');
  } catch {}
  if (await waitForChildProcessExit(browserProcess, BROWSER_CLOSE_TIMEOUT_MS)) return;

  try {
    if (browserProcess.exitCode === null) browserProcess.kill('SIGKILL');
  } catch {}
  await waitForChildProcessExit(browserProcess, 1_000).catch(() => false);
}

async function waitForProfileFlush(profileDir: string): Promise<void> {
  const deadline = Date.now() + PROFILE_FLUSH_TIMEOUT_MS;
  const cookiePath = join(profileDir, 'Default', 'Cookies');
  const preferencesPath = join(profileDir, 'Default', 'Preferences');
  while (Date.now() < deadline) {
    if (existsSync(cookiePath) || existsSync(preferencesPath)) return;
    await sleep(150);
  }
}

function assertPersistableTargetBrowserProfile(profileDir: string): void {
  const cookiePath = join(profileDir, 'Default', 'Cookies');
  if (existsSync(cookiePath)) return;
  throw new Error('浏览器 Profile 未完整保存，请重新登录后再导入');
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

const TARGET_OAUTH_STATUS_FLAGS = ['github_oauth', 'linuxdo_oauth', 'google_oauth'] as const;

export function parseTargetOauthStatus(raw: unknown): Record<string, unknown> | null {
  let parsed = raw;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (!trimmed || trimmed.startsWith('<')) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const candidate = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : root;
  return TARGET_OAUTH_STATUS_FLAGS.some((flag) => typeof candidate[flag] === 'boolean')
    ? candidate
    : null;
}

export function isStandaloneWafWarmupReady(input: { responseOk: boolean; contentType: string; body: string }): boolean {
  if (!input.responseOk) return false;
  return buildVerifiedTargetOauthStatusStorageSeed(input.body) !== null;
}

export function hasStandaloneWafClearanceCookie(cookies: Array<{ name?: string }>): boolean {
  return cookies.some((cookie) => cookie.name === 'acw_sc__v2');
}

export function shouldUseCloakBrowserForTarget(url: string): boolean {
  return shouldStabilizeStandaloneOauthLogin(url);
}

export function shouldStabilizeStandaloneOauthLogin(loginUrl: string): boolean {
  try {
    const host = new URL(loginUrl).hostname.toLowerCase();
    return host === 'anyrouter.top' || host.endsWith('.anyrouter.top')
      || host === 'agentrouter.org' || host.endsWith('.agentrouter.org');
  } catch {
    return false;
  }
}


export function buildStandaloneOauthStatusSeed(loginUrl: string): Record<string, unknown> | null {
  let host = '';
  try { host = new URL(loginUrl).hostname.toLowerCase(); } catch { return null; }
  if (host === 'anyrouter.top' || host.endsWith('.anyrouter.top')) {
    return {
      system_name: 'Any Router',
      github_oauth: true,
      github_client_id: 'Ov23liOwlnIiYoF3bUqw',
      linuxdo_oauth: true,
      linuxdo_client_id: '8w2uZtoWH9AUXrZr1qeCEEmvXLafea3c',
    };
  }
  if (host === 'agentrouter.org' || host.endsWith('.agentrouter.org')) {
    return {
      system_name: 'Agent Router',
      github_oauth: true,
      github_client_id: 'Ov23lidtiR4LeVZvVRNL',
      linuxdo_oauth: true,
      linuxdo_client_id: 'KZUecGfhhDZMVnv8UtEdhOhf9sNOhqVX',
    };
  }
  return null;
}

function hasEnabledTargetOauthProvider(status: Record<string, unknown> | null): boolean {
  return Boolean(status && TARGET_OAUTH_STATUS_FLAGS.some((flag) => status[flag] === true));
}


type StandaloneOauthActionInput = {
  oauthControlVisible: boolean;
  statusVerified: boolean;
  attempt: number;
  maxAttempts: number;
  nowMs: number;
  deadlineMs: number;
};

export function decideStandaloneOauthAction(input: StandaloneOauthActionInput): 'ready' | 'navigate-login' | 'fail-timeout' {
  // The target status endpoints are frequently blocked by ESA/WAF while the
  // rendered OAuth controls remain usable in the real browser. Visible controls
  // are the runtime source of truth for whether the login window can be handed off.
  if (input.oauthControlVisible) return 'ready';
  if (input.nowMs >= input.deadlineMs || input.attempt >= input.maxAttempts) return 'fail-timeout';
  return 'navigate-login';
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

export function isProviderConsentText(provider: SiteAuthProviderId, candidates: Array<string | null | undefined>): boolean {
  const text = candidates.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return Boolean(text && PROVIDER_CONSENT_TERMS[provider].some((pattern) => pattern.test(text)));
}

export async function clickProviderConsentIfPresent(page: Page, provider: SiteAuthProviderId): Promise<boolean> {
  if (!isOnProviderHost(page, provider)) return false;
  const controls = page.locator('button,input[type="submit"],a,[role="button"]');
  const count = await controls.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = controls.nth(index);
    if (!await item.isVisible().catch(() => false)) continue;
    const candidates = await Promise.all([
      item.innerText({ timeout: 500 }).catch(() => ''),
      item.textContent({ timeout: 500 }).catch(() => ''),
      item.getAttribute('value').catch(() => ''),
      item.getAttribute('aria-label').catch(() => ''),
      item.getAttribute('title').catch(() => ''),
    ]);
    if (!isProviderConsentText(provider, candidates)) continue;
    await item.click({ timeout: 5_000 });
    return true;
  }
  return false;
}

export async function advanceTargetProviderLogin(page: Page, provider: SiteAuthProviderId, input: { loginUrl: string; targetSiteUrl: string }): Promise<void> {
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
    accountId: session.accountId,
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

function schedulePendingSessionExpiry(session: TargetSiteBrowserSession): void {
  if (session.pendingExpiryTimer) clearTimeout(session.pendingExpiryTimer);
  session.pendingExpiryTimer = setTimeout(() => {
    if (session.status !== 'pending') return;
    session.status = 'closed';
    void closeSessionBrowser(session, { removeProfile: true });
  }, PENDING_SESSION_TTL_MS);
  session.pendingExpiryTimer.unref?.();
}

async function closeSessionBrowser(
  session: TargetSiteBrowserSession,
  options: { removeProfile?: boolean } = {},
): Promise<void> {
  if (!session.browserClosed && !session.closePromise) {
    session.closePromise = (async () => {
      if (session.pendingExpiryTimer) {
        clearTimeout(session.pendingExpiryTimer);
        session.pendingExpiryTimer = undefined;
      }
      try {
        session.stopCaptchaAutoConfirm?.();
      } catch {}
      try {
        if (session.browserMode === 'standalone') {
          await closeStandaloneBrowser(session);
        } else if (session.context) {
          if (session.browserMode === 'cloak') {
            await session.context.close().catch(() => {});
          } else {
            await Promise.race([
              session.context.close().catch(() => {}),
              sleep(BROWSER_CLOSE_TIMEOUT_MS),
            ]);
          }
        }
      } finally {
        session.browser = undefined;
        session.context = undefined;
        session.page = undefined;
        session.trackedPages?.clear();
        session.trackedPages = undefined;
        session.browserProcess = undefined;
        session.debuggingPort = undefined;
        releaseBrowserDisplay(`target-site:${session.state}`);
        session.browserClosed = true;
      }
    })().finally(() => {
      session.closePromise = undefined;
    });
  }
  await session.closePromise;
  if (options.removeProfile) {
    await rm(session.profileDir, { recursive: true, force: true }).catch(() => {});
  }
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

function isUsableTargetSessionCookieName(rawName: unknown): boolean {
  const name = asTrimmedString(rawName).toLowerCase();
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

function isUsableTargetSessionCookie(cookie: BrowserCookieArtifact): boolean {
  return isUsableTargetSessionCookieName(cookie.name);
}

export function parseTargetSessionCookieHeader(value: string): Array<{ name: string; value: string }> {
  return value.split(';').map((part) => part.trim()).flatMap((part) => {
    const index = part.indexOf('=');
    if (index <= 0) return [];
    const name = part.slice(0, index).trim();
    const cookieValue = part.slice(index + 1).trim();
    return name && cookieValue && isUsableTargetSessionCookieName(name)
      ? [{ name, value: cookieValue }]
      : [];
  });
}

export function buildTargetSessionCookieHeader(cookies: BrowserCookieArtifact[], targetHost: string): string {
  const domainCookies = targetHost
    ? cookies.filter((cookie) => isDomainMatch(cookie.domain || '', targetHost))
    : [];
  if (!domainCookies.some(isUsableTargetSessionCookie)) return '';
  return buildCookieHeader(domainCookies);
}


type StartedTargetBrowser = {
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  browserProcess?: ChildProcess;
  debuggingPort?: number;
  browserMode: 'playwright' | 'standalone' | 'cloak';
  stopCaptchaAutoConfirm?: () => void;
};

async function waitForDebuggingPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTcpPortOpen(port)) return;
    await sleep(250);
  }
  throw new Error('standalone browser debugging port not ready');
}

async function hasVisibleTargetOauthControl(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const terms = ['github', 'linuxdo', 'linux do', 'linux.do', 'google'];
    const candidates = Array.from(document.querySelectorAll('a,button,[role="button"]')) as HTMLElement[];
    return candidates.some((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) return false;
      const text = [
        element.innerText,
        element.textContent,
        element.getAttribute('href'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-provider'),
        element.getAttribute('data-oauth-provider'),
        element.getAttribute('class'),
        element.querySelector('img')?.getAttribute('alt'),
        element.querySelector('svg title')?.textContent,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return terms.some((term) => text.includes(term));
    });
  }).catch(() => false);
}

async function seedStandaloneOauthStatus(page: Page, loginUrl: string): Promise<void> {
  const seed = buildStandaloneOauthStatusSeed(loginUrl);
  if (!seed) return;
  const rawStatus = await page.evaluate(() => window.localStorage.getItem('status')).catch(() => null);
  if (hasEnabledTargetOauthProvider(parseTargetOauthStatus(rawStatus))) return;
  await page.evaluate((statusSeed) => {
    window.localStorage.setItem('status', JSON.stringify(statusSeed));
  }, seed);
}

function isVerifiedTargetOauthStatus(status: Record<string, unknown> | null): boolean {
  if (!hasEnabledTargetOauthProvider(status)) return false;
  const systemName = asTrimmedString(status?.system_name);
  const hasRealClientId = ['github_client_id', 'linuxdo_client_id', 'google_client_id']
    .some((key) => {
      const value = asTrimmedString(status?.[key]);
      return Boolean(value && value !== 'configured');
    });
  return Boolean(systemName && hasRealClientId);
}

export function buildVerifiedTargetOauthStatusStorageSeed(raw: unknown): string | null {
  const status = parseTargetOauthStatus(raw);
  return isVerifiedTargetOauthStatus(status) ? JSON.stringify(status) : null;
}

type TargetOauthReadiness = {
  oauthControlVisible: boolean;
  statusVerified: boolean;
};

async function readTargetOauthReadiness(page: Page): Promise<TargetOauthReadiness> {
  const [oauthControlVisible, rawStatus] = await Promise.all([
    hasVisibleTargetOauthControl(page),
    page.evaluate(() => window.localStorage.getItem('status')).catch(() => null),
  ]);
  return {
    oauthControlVisible,
    statusVerified: isVerifiedTargetOauthStatus(parseTargetOauthStatus(rawStatus)),
  };
}

function isLinuxDoPageUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'linux.do' || host.endsWith('.linux.do');
  } catch {
    return false;
  }
}

export function selectPreferredTargetPageIndex(urls: string[]): number {
  for (let index = urls.length - 1; index >= 0; index -= 1) {
    if (isLinuxDoPageUrl(urls[index] || '')) return index;
  }
  for (let index = urls.length - 1; index >= 0; index -= 1) {
    const url = (urls[index] || '').trim();
    if (url && url !== 'about:blank') return index;
  }
  return urls.length > 0 ? urls.length - 1 : -1;
}

function selectPreferredTargetPage(context: BrowserContext | undefined, fallback?: Page): Page | undefined {
  const pages = context?.pages().filter((page) => !page.isClosed()) || [];
  const index = selectPreferredTargetPageIndex(pages.map((page) => page.url()));
  return index >= 0 ? pages[index] : fallback;
}


function getActiveTargetPage(session: TargetSiteBrowserSession): Page | undefined {
  const page = selectPreferredTargetPage(session.context, session.page);
  if (page && !page.isClosed()) {
    session.page = page;
    session.currentUrl = page.url();
    return page;
  }
  return undefined;
}

export function isTargetLoginOverlayDismissText(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
  return ['close notice', 'close today', '关闭公告', '关闭通知', '今日不再显示'].includes(normalized);
}

async function dismissTargetLoginOverlay(page: Page): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const buttons = await page.locator('button').all().catch(() => []);
    for (const button of buttons) {
      const text = await button.innerText().catch(() => '');
      if (!isTargetLoginOverlayDismissText(text)) continue;
      if (!await button.isVisible().catch(() => false)) continue;
      await button.click({ timeout: 2_000 }).catch(() => {});
      return;
    }
    await page.waitForTimeout(200).catch(() => sleep(200));
  }
}

async function waitForTargetOauthReadiness(page: Page, timeoutMs: number): Promise<TargetOauthReadiness> {
  const deadline = Date.now() + timeoutMs;
  let readiness = await readTargetOauthReadiness(page);
  while (Date.now() < deadline && !readiness.oauthControlVisible) {
    await page.waitForTimeout(250).catch(() => sleep(250));
    readiness = await readTargetOauthReadiness(page);
  }
  return readiness;
}

async function warmStandaloneTargetWaf(page: Page, loginUrl: string): Promise<void> {
  if (!shouldStabilizeStandaloneOauthLogin(loginUrl)) return;
  const startedAt = Date.now();
  console.log(`[TargetSiteBrowser] WAF warmup start ${new URL(loginUrl).hostname}`);
  const statusUrl = new URL('/api/status', loginUrl).toString();
  const deadline = Date.now() + 20_000;
  let lastBody = '';

  for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt += 1) {
    await page.goto(statusUrl, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1_000, Math.min(BROWSER_STARTUP_TIMEOUT_MS, deadline - Date.now())),
    }).catch(() => {});

    while (Date.now() < deadline) {
      lastBody = await page.locator('body').innerText().catch(() => '');
      const verifiedStatusSeed = buildVerifiedTargetOauthStatusStorageSeed(lastBody);
      if (verifiedStatusSeed) {
        // Persist the real /api/status payload before the SPA is created. This
        // avoids the race where the WAF succeeds at the deadline but React's
        // first render still sees stale or empty OAuth flags.
        await page.evaluate((rawStatus) => {
          window.localStorage.setItem('status', rawStatus);
        }, verifiedStatusSeed).catch(() => {});
        await page.goto(loginUrl, {
          waitUntil: 'domcontentloaded',
          timeout: BROWSER_STARTUP_TIMEOUT_MS,
        }).catch(() => {});
        console.log(`[TargetSiteBrowser] WAF warmup ready in ${Date.now() - startedAt}ms`);
        return;
      }
      if (/denied by http_ratelimit|sorry, you have been blocked/i.test(lastBody)) break;
      await page.waitForTimeout(500).catch(() => sleep(500));
    }
  }

  const blocked = /denied by http_ratelimit|sorry, you have been blocked/i.test(lastBody);
  console.warn(`[TargetSiteBrowser] WAF warmup failed in ${Date.now() - startedAt}ms`);
  throw new Error(blocked
    ? '目标站限制了当前浏览器出口，请稍后重试'
    : '目标站 WAF 验证未完成，请稍后重试');
}

const STANDALONE_OAUTH_NAVIGATION_BRIDGE = `(() => {
  if (window.__metapiOauthNavigationBridgeInstalled) return;
  window.__metapiOauthNavigationBridgeInstalled = true;
  const nativeOpen = window.open.bind(window);
  window.open = function metapiOauthOpen(url, target, features) {
    const nextUrl = typeof url === 'string' ? url : String(url || '');
    if (document.body) {
      const previous = document.body.dataset.metapiOpenCalls || '';
      document.body.dataset.metapiOpenCalls = previous + '\\n' + nextUrl;
    }
    if (!nextUrl || nextUrl === 'about:blank') {
      return window;
    }
    const oauthPrefixes = [
      'https://connect.linux.do/',
      'https://github.com/login/oauth/',
      'https://accounts.google.com/',
    ];
    if (oauthPrefixes.some((prefix) => nextUrl.startsWith(prefix))) {
      if (document.body) document.body.dataset.metapiOauthUrl = nextUrl;
      window.location.href = nextUrl;
      return window;
    }
    return nativeOpen(url, target, features);
  };
})()`;

export async function installStandaloneOauthNavigationBridge(context: BrowserContext, page: Page): Promise<void> {
  await context.addInitScript(STANDALONE_OAUTH_NAVIGATION_BRIDGE);
  await page.evaluate(STANDALONE_OAUTH_NAVIGATION_BRIDGE);
}

async function stabilizeStandaloneOauthLogin(context: BrowserContext, page: Page, loginUrl: string): Promise<void> {
  await installStandaloneOauthNavigationBridge(context, page);
  let navigationError: unknown;
  try {
    await page.goto(loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: BROWSER_STARTUP_TIMEOUT_MS,
    });
  } catch (error) {
    navigationError = error;
    await page.evaluate((url) => { window.location.href = url; }, loginUrl).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
  }

  // WAF and hCaptcha must remain visible and interactive in the real browser.
  // Do not gate the handoff on /api/status or pre-judge OAuth button readiness.
  if (page.url() === 'about:blank') {
    const suffix = navigationError instanceof Error ? `：${navigationError.message}` : '';
    throw new Error(`目标站登录页无法打开${suffix}`);
  }
  if (shouldStabilizeStandaloneOauthLogin(loginUrl) && !await hasVisibleTargetOauthControl(page)) {
    await seedStandaloneOauthStatus(page, loginUrl);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: BROWSER_STARTUP_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(800).catch(() => {});
  }
  await installStandaloneOauthNavigationBridge(context, page);
  await dismissTargetLoginOverlay(page);
}

async function terminateStandaloneBrowserProcess(browserProcess: ChildProcess): Promise<void> {
  try {
    if (browserProcess.exitCode === null) browserProcess.kill('SIGTERM');
  } catch {}
  if (await waitForChildProcessExit(browserProcess, BROWSER_CLOSE_TIMEOUT_MS)) return;
  try {
    if (browserProcess.exitCode === null) browserProcess.kill('SIGKILL');
  } catch {}
  await waitForChildProcessExit(browserProcess, 1_000).catch(() => false);
}

async function warmCloakTargetWaf(context: BrowserContext, page: Page, loginUrl: string): Promise<boolean> {
  if (!shouldUseCloakBrowserForTarget(loginUrl)) return true;
  const statusUrl = new URL('/api/status', loginUrl).toString();
  for (let attempt = 0; attempt < 1; attempt += 1) {
    const response = await page.goto(statusUrl, {
      waitUntil: 'domcontentloaded',
      timeout: BROWSER_STARTUP_TIMEOUT_MS,
    }).catch(() => null);
    await sleep(1_200);
    const body = await page.locator('body').innerText().catch(() => '');
    if (isStandaloneWafWarmupReady({
      responseOk: Boolean(response?.ok()),
      contentType: response?.headers()['content-type'] || '',
      body,
    })) return true;
    const cookies = await context.cookies(statusUrl).catch(() => []);
    const hasClearance = hasStandaloneWafClearanceCookie(cookies);
    console.log(`[TargetSiteBrowser] CloakBrowser WAF attempt ${attempt + 1}: status=${response?.status() || 0} contentType=${response?.headers()['content-type'] || ''} clearance=${hasClearance} blocked=${/denied by http_ratelimit|sorry, you have been blocked/i.test(body)}`);
    if (hasClearance) await sleep(300);
  }
  console.warn('[TargetSiteBrowser] CloakBrowser WAF preflight incomplete; handing off the real login page for interactive verification');
  return false;
}

export async function launchTargetProfileNativeContext(input: {
  profileDir: string;
  loginUrl: string;
  proxyUrl?: string;
}): Promise<{ context: BrowserContext; page: Page }> {
  const display = resolveBrowserDisplay();
  await ensureXvfbStarted(display);
  await mkdir(input.profileDir, { recursive: true });
  await clearChromiumProfileLocks(input.profileDir);
  const chromium = await loadChromiumBrowserType();
  const proxyUrl = asTrimmedString(input.proxyUrl);
  const context = await chromium.launchPersistentContext(input.profileDir, {
    executablePath: resolveBrowserExecutablePath(),
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
    headless: false,
    env: { ...process.env, DISPLAY: display },
    viewport: null,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    ignoreHTTPSErrors: true,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--password-store=basic',
      '--use-mock-keychain',
      '--lang=zh-CN,zh',
      '--window-size=1280,900',
    ],
  });
  const page = context.pages()[0] || await context.newPage();
  try {
    await installStandaloneOauthNavigationBridge(context, page);
    await page.goto(input.loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: BROWSER_STARTUP_TIMEOUT_MS,
    });
    return { context, page };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

export async function launchTargetProfileCloakContext(input: {
  profileDir: string;
  loginUrl: string;
  proxyUrl?: string;
}): Promise<{ context: BrowserContext; page: Page }> {
  const display = resolveBrowserDisplay();
  await ensureXvfbStarted(display);
  await mkdir(input.profileDir, { recursive: true });
  await clearChromiumProfileLocks(input.profileDir);
  const launchPersistentContext = await loadCloakPersistentContextLauncher();
  const fingerprintSeed = await resolvePersistentBrowserFingerprintSeed(input.profileDir);
  const context = await launchPersistentContext(buildCloakPersistentContextOptions({
    profileDir: input.profileDir,
    display,
    proxyUrl: asTrimmedString(input.proxyUrl),
    fingerprintSeed,
  }));
  const page = context.pages()[0] || await context.newPage();
  try {
    await installStandaloneOauthNavigationBridge(context, page);
    await warmCloakTargetWaf(context, page, input.loginUrl);
    await page.goto(input.loginUrl, { waitUntil: 'domcontentloaded', timeout: BROWSER_STARTUP_TIMEOUT_MS });
    await installStandaloneOauthNavigationBridge(context, page);
    return { context, page };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}


async function launchCloakBrowser(input: {
  profileDir: string;
  loginUrl: string;
  provider?: SiteAuthProviderId;
}): Promise<StartedTargetBrowser> {
  const display = resolveBrowserDisplay();
  await ensureXvfbStarted(display);
  await seedStandaloneProfileFromProvider(input.provider, input.profileDir);
  await mkdir(input.profileDir, { recursive: true });
  await clearChromiumProfileLocks(input.profileDir);

  const launchPersistentContext = await loadCloakPersistentContextLauncher();
  const fingerprintSeed = await resolvePersistentBrowserFingerprintSeed(input.profileDir);
  const launchStartedAt = Date.now();
  const context = await launchPersistentContext(buildCloakPersistentContextOptions({
    profileDir: input.profileDir,
    display,
    proxyUrl: resolveBrowserProxyUrl(),
    fingerprintSeed,
  }));
  const page = context.pages()[0] || await context.newPage();
  console.log(`[TargetSiteBrowser] CloakBrowser ready in ${Date.now() - launchStartedAt}ms`);
  try {
    const navigationStartedAt = Date.now();
    await warmCloakTargetWaf(context, page, input.loginUrl);
    await page.goto(input.loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: BROWSER_STARTUP_TIMEOUT_MS,
    });
    if (page.url() === 'about:blank') throw new Error('目标站登录页无法打开');
    console.log(`[TargetSiteBrowser] CloakBrowser login opened in ${Date.now() - navigationStartedAt}ms`);
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
  return {
    context,
    page,
    browserMode: 'cloak',
  };
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
  const proxyArgs = buildStandaloneBrowserProxyArgs(input.loginUrl, resolveBrowserProxyUrl());
  const args = [
    `--user-data-dir=${input.profileDir}`,
    `--remote-debugging-port=${debuggingPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--password-store=basic',
    '--use-mock-keychain',
    '--lang=zh-CN,zh',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    ...proxyArgs,
    // Warm the ESA/WAF status endpoint before the SPA starts its own API calls.
    // Opening the login page first can poison the fresh profile with a rate-limit response.
    'about:blank',
  ];
  const browserProcess = spawn(resolveBrowserExecutablePath(), args, {
    env: { ...process.env, DISPLAY: display },
    stdio: 'ignore',
  });
  browserProcess.unref?.();
  const launchStartedAt = Date.now();
  await waitForDebuggingPort(debuggingPort).catch((error) => {
    if (browserProcess.exitCode === null) browserProcess.kill('SIGTERM');
    throw error;
  });
  console.log(`[TargetSiteBrowser] Chromium debugging ready in ${Date.now() - launchStartedAt}ms`);
  const chromium = await loadChromiumBrowserType();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`);
  const context = browser.contexts()[0];
  const page = context?.pages()[0];
  if (!context || !page) {
    await terminateStandaloneBrowserProcess(browserProcess);
    throw new Error('目标站登录浏览器页面未创建');
  }
  // Do not hand the noVNC window to the user while Chromium is still on
  // about:blank or while the target OAuth controls are hidden behind WAF setup.
  await installStandaloneOauthNavigationBridge(context, page);
  try {
    const stabilizeStartedAt = Date.now();
    await stabilizeStandaloneOauthLogin(context, page, input.loginUrl);
    console.log(`[TargetSiteBrowser] login ready in ${Date.now() - stabilizeStartedAt}ms`);
  } catch (error) {
    await terminateStandaloneBrowserProcess(browserProcess);
    throw error;
  }
  return {
    browser,
    context,
    page,
    browserProcess,
    debuggingPort,
    browserMode: 'standalone',
  };
}

async function connectStandaloneContext<T>(session: TargetSiteBrowserSession, fn: (context: BrowserContext, page: Page) => Promise<T>): Promise<T> {
  const context = session.context || session.browser?.contexts()[0];
  const page = selectPreferredTargetPage(context, session.page);
  if (!context || !page) throw new Error('standalone browser page not found');
  session.context = context;
  session.page = page;
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
  if (shouldUseCloakBrowserForTarget(input.targetSiteUrl) || shouldUseCloakBrowserForTarget(input.loginUrl)) {
    const started = await launchCloakBrowser({ profileDir: input.profileDir, loginUrl: input.loginUrl, provider: input.provider });
    try {
      if (input.provider && input.autoAdvanceProvider !== false && started.page) {
        await advanceTargetProviderLogin(started.page, input.provider, {
          loginUrl: input.loginUrl,
          targetSiteUrl: input.targetSiteUrl,
        });
      }
      return started;
    } catch (error) {
      await started.context?.close().catch(() => {});
      throw error;
    }
  }
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
  await page.setViewportSize(VIEWPORT);
  await page.goto(input.loginUrl, { waitUntil: 'domcontentloaded', timeout: BROWSER_STARTUP_TIMEOUT_MS }).catch(async () => {
    await page.evaluate((url) => { window.location.href = url; }, input.loginUrl).catch(() => {});
  });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  if (input.provider && input.autoAdvanceProvider !== false) {
    await advanceTargetProviderLogin(page, input.provider, { loginUrl: input.loginUrl, targetSiteUrl: input.targetSiteUrl });
  }
  return { context, page, browserMode: 'playwright' };
}

export async function seedTargetSiteBrowserProfile(
  sourceProfileDir: string | undefined,
  destinationProfileDir: string,
): Promise<void> {
  await rm(destinationProfileDir, { recursive: true, force: true });
  await mkdir(dirname(destinationProfileDir), { recursive: true });
  if (sourceProfileDir?.trim()) {
    await cp(sourceProfileDir, destinationProfileDir, { recursive: true });
    return;
  }
  await mkdir(destinationProfileDir, { recursive: true });
}

export async function startTargetSiteBrowserSession(input: {
  siteId: number;
  accountId?: number;
  provider?: SiteAuthProviderId;
  credentialId?: number;
  sourceProfileDir?: string;
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
    await closeSessionBrowser(session, { removeProfile: true });
  });
  await seedTargetSiteBrowserProfile(input.sourceProfileDir, profileDir);
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
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const viewUrl = `${resolveOrigin(input.origin)}/site-auth/target-browser/${state}`;
  const noVncUrl = buildNoVncUrl(input.origin);
  const session: TargetSiteBrowserSession = {
    state,
    siteId: input.siteId,
    accountId: input.accountId,
    provider: input.provider,
    credentialId: input.credentialId,
    targetSiteUrl,
    loginUrl,
    viewUrl,
    noVncUrl,
    profileDir,
    browser: started.browser,
    context: started.context,
    page: started.page,
    browserProcess: started.browserProcess,
    debuggingPort: started.debuggingPort,
    browserMode: started.browserMode,
    status: 'pending',
    currentUrl: started.page?.url() || loginUrl,
    stopCaptchaAutoConfirm,
  };
  attachTargetPageTracking(session);
  sessions.set(state, session);
  schedulePendingSessionExpiry(session);
  try {
    await ensureNoVncGatewayStarted(resolveBrowserDisplay());
  } catch (error) {
    session.status = 'error';
    session.error = error instanceof Error ? error.message : String(error);
    await closeSessionBrowser(session, { removeProfile: true });
    sessions.delete(state);
    throw error;
  }
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

export async function confirmTargetSiteBrowserCaptcha(state: string): Promise<LinuxDoCaptchaAutoConfirmResult> {
  const session = getSession(state);
  if (session.status !== 'pending') return { clicked: false, reason: 'error' };
  const page = getActiveTargetPage(session);
  if (!page) return { clicked: false, reason: 'error' };
  if (!isLinuxDoPageUrl(page.url())) return { clicked: false, reason: 'not-linuxdo' };
  return await clickLinuxDoCaptchaVerifyWithTrustedInput(page)
    || { clicked: false, reason: 'error' };
}

export async function captureTargetSiteBrowserScreenshot(state: string): Promise<Buffer> {
  const session = getSession(state);
  const page = getActiveTargetPage(session);
  if (!page || !session.context) return VALID_FALLBACK_SCREENSHOT_PNG;
  try {
    return await page.screenshot({
      type: 'png',
      fullPage: false,
      timeout: SCREENSHOT_TIMEOUT_MS,
      animations: 'disabled',
      caret: 'hide',
    });
  } catch {}
  try {
    const cdp = await session.context.newCDPSession(page);
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
  const page = getActiveTargetPage(session);
  if (!page) return toSessionInfo(session);
  if (event.type === 'click') await page.mouse.click(event.x, event.y, { delay: 45 });
  else if (event.type === 'mouseDown') { await page.mouse.move(event.x, event.y, { steps: 2 }); await page.mouse.down(); }
  else if (event.type === 'mouseMove') await page.mouse.move(event.x, event.y, { steps: 2 });
  else if (event.type === 'mouseUp') { await page.mouse.move(event.x, event.y, { steps: 2 }); await page.mouse.up(); }
  else if (event.type === 'type') await page.keyboard.type(event.text, { delay: 8 });
  else if (event.type === 'press') await page.keyboard.press(event.key);
  else if (event.type === 'scroll') await page.mouse.wheel(0, event.deltaY);
  session.currentUrl = page.url();
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

function watchTargetBrowserUserInfo(session: TargetSiteBrowserSession, page: Page): void {
  page.on('response', async (response) => {
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

function attachTargetPageTracking(session: TargetSiteBrowserSession): void {
  const context = session.context;
  if (!context) return;
  session.trackedPages ||= new Set<Page>();
  const attachPage = (page: Page) => {
    if (session.trackedPages?.has(page)) return;
    session.trackedPages?.add(page);
    session.page = page;
    session.currentUrl = page.url();
    watchTargetBrowserUserInfo(session, page);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      session.page = page;
      session.currentUrl = page.url();
    });
    page.once('close', () => {
      session.trackedPages?.delete(page);
      if (session.browserClosed || session.status !== 'pending') return;
      const fallback = selectPreferredTargetPage(context);
      if (fallback) {
        session.page = fallback;
        session.currentUrl = fallback.url();
      }
    });
  };
  for (const page of context.pages()) attachPage(page);
  context.on('page', attachPage);
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
  await closeSessionBrowser(session, { removeProfile: true });
  return toSessionInfo(session);
}

export async function commitTargetSiteBrowserProfile(
  state: string,
  destinationProfileDir: string,
): Promise<BrowserProfileCommit> {
  const session = getSession(state);
  await closeSessionBrowser(session);
  await waitForProfileFlush(session.profileDir);
  assertPersistableTargetBrowserProfile(session.profileDir);
  return commitBrowserProfileReplacement(session.profileDir, destinationProfileDir);
}

export async function persistTargetSiteBrowserProfile(
  state: string,
  destinationProfileDir: string,
): Promise<void> {
  const commit = await commitTargetSiteBrowserProfile(state, destinationProfileDir);
  await commit.finalize();
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
  await closeSessionBrowser(session, { removeProfile: true });
  return toSessionInfo(session);
}



export async function shutdownTargetSiteBrowserSessions(): Promise<void> {
  const activeSessions = Array.from(sessions.values());
  for (const session of activeSessions) {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    if (session.pendingExpiryTimer) clearTimeout(session.pendingExpiryTimer);
    if (session.status === 'pending') session.status = 'closed';
    await closeSessionBrowser(session, { removeProfile: true }).catch(() => {});
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  }
  sessions.clear();
  stopNoVncGateway();
  stopXvfb();
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
<body><div class="bar"><div><div class="title">Metapi 目标站登录窗口</div><div class="hint">${safeHint}</div></div><div class="actions"><button class="btn ghost" id="verifyCaptcha">验证码通过后继续</button><button class="btn primary" id="save">提取并回填表单</button><button class="btn ghost" id="reload">重载远程窗口</button><button class="btn danger" id="close">关闭</button></div></div><div class="status" id="status">会话 ${safeState} 正在启动...</div><div class="stage"><iframe id="novnc" class="novnc" allow="clipboard-read; clipboard-write"></iframe></div>
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
    try{window.opener&&window.opener.postMessage({type:'metapi-target-site-auth',status:'success',state,siteId:data.siteId,accountId:data.accountId,provider:data.provider,credentialId:data.credentialId,targetSiteUrl:data.targetSiteUrl,accessToken:data.accessToken,username:data.username,platformUserId:data.platformUserId},'*')}catch{}
  }catch(e){if(!auto)setStatus(e.message||'提取失败','err')}
  finally{if(auto){autoSaving=false}else{manualSaving=false;saveBtn.disabled=false}}
}
document.getElementById('verifyCaptcha').addEventListener('click',async(e)=>{const btn=e.currentTarget;btn.disabled=true;setStatus('正在确认已完成的人机验证...');try{const res=await api('/api/accounts/site-auth-browser-sessions/'+encodeURIComponent(state)+'/confirm-captcha',{method:'POST'});const data=await res.json().catch(()=>({}));if(data.clicked)setStatus('Verify 已生效，正在等待 LinuxDO 登录结果。','ok');else if(data.reason==='no-token')setStatus('还没检测到已通过的验证码，请先完成图片/拖拽验证。','err');else if(data.reason==='click-not-acknowledged')setStatus('Verify 已发送点击但页面没有响应，请保持窗口打开后再试一次。','err');else if(data.reason==='not-linuxdo')setStatus('当前活动页面不是 LinuxDO 验证页，请先切回验证页面。','err');else setStatus('没有找到可确认的 Verify 按钮，请保持验证窗口打开后重试。','err')}catch(err){setStatus(err.message||'确认验证码失败','err')}finally{btn.disabled=false}});
saveBtn.addEventListener('click',()=>saveAndCreate(false));
document.getElementById('reload').addEventListener('click',loadVnc);
document.getElementById('close').addEventListener('click',async()=>{try{await api('/api/accounts/site-auth-browser-sessions/'+encodeURIComponent(state)+'/close',{method:'POST'})}catch{}window.close()});
window.addEventListener('pagehide',()=>{if(closed)return;const headers={};const t=token();if(t)headers.Authorization='Bearer '+t;fetch('/api/accounts/site-auth-browser-sessions/'+encodeURIComponent(state)+'/close',{method:'POST',headers,keepalive:true}).catch(()=>{})});
loadVnc();
setStatus('远程浏览器已连接。请先完成目标站登录，确认进入控制台后点击“提取并回填表单”。不会自动保存未确认状态。');
</script></body></html>`;
}
