import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BrowserContext, Cookie, Page } from 'playwright-core';
import { fetch, ProxyAgent } from 'undici';
import { config } from '../../config.js';
import { loadChromiumBrowserType } from '../browserAutomationRuntime.js';
import {
  createSiteAuthCredential,
  type CreateSiteAuthCredentialInput,
  type SiteAuthCredentialSummary,
} from './credentialVault.js';
import { acquireExclusiveBrowserDisplay, releaseBrowserDisplay } from './browserDisplayLease.js';
import { startLinuxDoCaptchaAutoConfirm } from './linuxDoCaptchaConfirm.js';
import type { SiteAuthCredentialType, SiteAuthProviderId } from './providerTypes.js';

const VIEWPORT = { width: 1280, height: 900 } as const;
const SESSION_CLEANUP_DELAY_MS = 5 * 60_000;
const SCREENSHOT_TIMEOUT_MS = 15_000;
const BROWSER_STARTUP_TIMEOUT_MS = 12_000;
const XVFB_START_DELAY_MS = 500;
const DEFAULT_NOVNC_PORT = 6080;
const DEFAULT_VNC_PORT = 5900;
const NOVNC_READY_DELAY_MS = 800;
const FALLBACK_SCREENSHOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAABQAAAANECAYAAABd2Q4SAAAAAXNSR0IArs4c6QAAIABJREFUeJzt3TEOwjAMQNFc/v9PZgYGAkKkC9tOaZ0E0iRbswYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwX+oDAAFwB8kAAAAASUVORK5CYII=',
  'base64',
);

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type SiteAuthBrowserSessionStatus = 'pending' | 'success' | 'error' | 'closed';

export type SiteAuthBrowserSessionInfo = {
  provider: SiteAuthProviderId;
  state: string;
  status: SiteAuthBrowserSessionStatus;
  loginUrl: string;
  viewUrl: string;
  currentUrl?: string;
  error?: string;
  noVncUrl?: string;
  credential?: SiteAuthCredentialSummary;
};

export type SiteAuthBrowserStartResult = {
  provider: SiteAuthProviderId;
  state: string;
  authorizationUrl: string;
  instructions: {
    mode: 'controlled_browser';
    loginUrl: string;
    viewUrl: string;
    savePath: string;
    screenshotPath: string;
  };
};

export type SiteAuthBrowserInputEvent =
  | { type: 'click'; x: number; y: number }
  | { type: 'mouseDown'; x: number; y: number }
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'mouseUp'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; deltaY: number };

type BrowserCookieArtifact = Pick<Cookie, 'name' | 'value' | 'domain' | 'path' | 'expires' | 'httpOnly' | 'secure' | 'sameSite'>;

type BrowserStorageState = {
  cookies: BrowserCookieArtifact[];
  origins: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
};

type BrowserSnapshot = {
  currentUrl: string;
  title?: string;
  cookies: BrowserCookieArtifact[];
  storageState?: BrowserStorageState;
  siteIdentity?: { subject?: string | null; username?: string | null; email?: string | null } | null;
};

type BrowserPageController = {
  screenshot: () => Promise<Buffer>;
  click: (x: number, y: number) => Promise<void>;
  mouseDown: (x: number, y: number) => Promise<void>;
  mouseMove: (x: number, y: number) => Promise<void>;
  mouseUp: (x: number, y: number) => Promise<void>;
  typeText: (text: string) => Promise<void>;
  press: (key: string) => Promise<void>;
  scroll: (deltaY: number) => Promise<void>;
  snapshot: () => Promise<BrowserSnapshot>;
  close: () => Promise<void>;
};

type BrowserDriver = {
  start: (input: {
    provider: SiteAuthProviderId;
    state: string;
    loginUrl: string;
    profileDir: string;
  }) => Promise<BrowserPageController>;
};

type InternalSession = SiteAuthBrowserSessionInfo & {
  profileDir: string;
  preserveProfile?: boolean;
  controller: BrowserPageController;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  saving?: boolean;
  controllerClosed?: boolean;
};

const sessions = new Map<string, InternalSession>();
let browserDriverFactory: () => BrowserDriver = createPlaywrightBrowserDriver;
let xvfbProcess: ChildProcess | null = null;
let xvfbStartPromise: Promise<void> | null = null;
let x11vncProcess: ChildProcess | null = null;
let websockifyProcess: ChildProcess | null = null;
let noVncStartPromise: Promise<void> | null = null;

const PROVIDER_LABELS: Record<SiteAuthProviderId, string> = {
  linuxdo: 'LinuxDO',
  github: 'GitHub',
  google: 'Google',
};

const PROVIDER_LOGIN_URLS: Record<SiteAuthProviderId, string> = {
  linuxdo: 'https://linux.do/login',
  github: 'https://github.com/login',
  google: 'https://accounts.google.com/',
};

const PROVIDER_COOKIE_HOSTS: Record<SiteAuthProviderId, string[]> = {
  linuxdo: ['linux.do'],
  github: ['github.com'],
  google: ['google.com', 'accounts.google.com'],
};

const CHROMIUM_PROFILE_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'] as const;

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveOrigin(origin: string): string {
  const trimmed = origin.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('site auth browser origin is required');
  return trimmed;
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

function resolveBrowserExecutablePath(): string {
  const explicit = asTrimmedString(process.env.SITE_AUTH_BROWSER_EXECUTABLE_PATH);
  if (explicit) return explicit;
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'chromium';
}

function parseBooleanEnv(value: unknown): boolean | null {
  const normalized = asTrimmedString(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function resolveBrowserHeadless(): boolean {
  const explicit = parseBooleanEnv(process.env.SITE_AUTH_BROWSER_HEADLESS);
  if (explicit !== null) return explicit;
  return !asTrimmedString(process.env.SITE_AUTH_BROWSER_DISPLAY) && !asTrimmedString(process.env.DISPLAY);
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

function buildNoVncUrl(origin: string): string {
  const port = resolveNoVncPort();
  try {
    const parsed = new URL(resolveOrigin(origin));
    parsed.port = String(port);
    parsed.pathname = '/vnc.html';
    parsed.search = new URLSearchParams({
      autoconnect: '1',
      resize: 'remote',
      path: 'websockify',
      reconnect: '1',
    }).toString();
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return 'http://127.0.0.1:' + port + '/vnc.html?autoconnect=1&resize=remote&path=websockify&reconnect=1';
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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
        '0.0.0.0:' + noVncPort,
        '127.0.0.1:' + vncPort,
      ], { stdio: 'ignore' });
    }
    await sleep(NOVNC_READY_DELAY_MS);
    if (!(await isTcpPortOpen(noVncPort))) {
      throw new Error('noVNC gateway failed to start for site auth browser login');
    }
  })().finally(() => {
    noVncStartPromise = null;
  });
  return noVncStartPromise;
}

process.once('exit', () => { stopNoVncGateway(); stopXvfb(); });
process.once('SIGINT', () => { stopNoVncGateway(); stopXvfb(); process.exit(130); });
process.once('SIGTERM', () => { stopNoVncGateway(); stopXvfb(); process.exit(143); });

function resolveProfileDir(provider: SiteAuthProviderId): string {
  return resolve(config.dataDir, 'site-auth-working-profiles', provider);
}

async function clearChromiumProfileLocks(profileDir: string): Promise<void> {
  await Promise.all(CHROMIUM_PROFILE_LOCK_FILES.map((name) => (
    rm(join(profileDir, name), { force: true }).catch(() => {})
  )));
}

function isDomainMatch(cookieDomain: string, host: string): boolean {
  const normalized = cookieDomain.trim().toLowerCase().replace(/^\./, '');
  const normalizedHost = host.trim().toLowerCase().replace(/^\./, '');
  return normalized === normalizedHost || normalized.endsWith(`.${normalizedHost}`);
}

function filterProviderCookies(provider: SiteAuthProviderId, cookies: BrowserCookieArtifact[]): BrowserCookieArtifact[] {
  const hosts = PROVIDER_COOKIE_HOSTS[provider];
  return cookies.filter((cookie) => hosts.some((host) => isDomainMatch(cookie.domain || '', host)));
}

function buildCookieHeader(cookies: BrowserCookieArtifact[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const cookie of cookies) {
    const name = asTrimmedString(cookie.name);
    const value = asTrimmedString(cookie.value);
    if (!name || !value || seen.has(name)) continue;
    seen.add(name);
    parts.push(`${name}=${value}`);
  }
  return parts.join('; ');
}

function cookieValue(cookies: BrowserCookieArtifact[], name: string): string {
  return asTrimmedString(cookies.find((cookie) => cookie.name === name)?.value);
}

function hasAnyCookie(cookies: BrowserCookieArtifact[], names: string[]): boolean {
  return names.some((name) => !!cookieValue(cookies, name));
}

function toSafeCookieNames(cookies: BrowserCookieArtifact[]): string[] {
  return Array.from(new Set(cookies.map((cookie) => cookie.name).filter(Boolean))).sort();
}

async function readLinuxDoIdentity(cookieHeader: string): Promise<{ subject?: string | null; username?: string | null; email?: string | null } | null> {
  if (!cookieHeader) return null;
  try {
    const proxyUrl = resolveBrowserProxyUrl();
    const response = await fetch('https://linux.do/session/current.json', {
      headers: {
        Accept: 'application/json',
        Cookie: cookieHeader,
        'User-Agent': 'Metapi controlled site-auth browser',
      },
      ...(proxyUrl ? { dispatcher: new ProxyAgent(proxyUrl) } : {}),
      signal: AbortSignal.timeout(15_000),
    } as any);
    if (!response.ok) return null;
    const body = await response.json() as any;
    const user = body?.current_user || body?.user;
    if (!user || typeof user !== 'object') return null;
    const subject = user.id === undefined || user.id === null ? '' : String(user.id).trim();
    const username = asTrimmedString(user.username) || asTrimmedString(user.name);
    const email = asTrimmedString(user.email);
    return subject || username || email
      ? { subject: subject || null, username: username || null, email: email || null }
      : null;
  } catch {
    return null;
  }
}

function normalizeLinuxDoIdentity(input: unknown): { subject?: string | null; username?: string | null; email?: string | null } | null {
  const user = input && typeof input === 'object' && !Array.isArray(input)
    ? ((input as Record<string, unknown>).current_user || (input as Record<string, unknown>).user || input)
    : null;
  if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
  const record = user as Record<string, unknown>;
  const rawSubject = record.id ?? record.subject;
  const subject = rawSubject === undefined || rawSubject === null ? '' : String(rawSubject).trim();
  const username = asTrimmedString(record.username) || asTrimmedString(record.name);
  const email = asTrimmedString(record.email);
  return subject || username || email
    ? { subject: subject || null, username: username || null, email: email || null }
    : null;
}

function buildSessionArtifactPayload(input: {
  provider: SiteAuthProviderId;
  snapshot: BrowserSnapshot;
  cookies: BrowserCookieArtifact[];
}): Record<string, unknown> {
  return {
    provider: input.provider,
    currentUrl: input.snapshot.currentUrl,
    cookies: input.cookies,
    storageState: input.snapshot.storageState || { cookies: input.cookies, origins: [] },
  };
}

async function buildCredentialInputFromSnapshot(
  provider: SiteAuthProviderId,
  snapshot: BrowserSnapshot,
): Promise<CreateSiteAuthCredentialInput | null> {
  const cookies = filterProviderCookies(provider, snapshot.cookies || []);
  if (cookies.length === 0) return null;
  const providerLabel = PROVIDER_LABELS[provider];
  const cookieNames = toSafeCookieNames(cookies);
  const commonMetadata = {
    source: 'controlled-browser-login',
    loginUrl: PROVIDER_LOGIN_URLS[provider],
    currentUrl: snapshot.currentUrl,
    cookieNames,
    savedAt: new Date().toISOString(),
  };

  if (provider === 'linuxdo') {
    const cookieHeader = buildCookieHeader(cookies);
    const identity = normalizeLinuxDoIdentity(snapshot.siteIdentity) || await readLinuxDoIdentity(cookieHeader);
    if (!identity) return null;
    const displayName = identity.username || identity.email || identity.subject || '浏览器凭证';
    return {
      provider,
      label: `${providerLabel} · ${displayName}`,
      subject: identity.subject || null,
      username: identity.username || null,
      email: identity.email || null,
      credentialType: 'cookie',
      payload: {
        cookie: cookieHeader,
        ...buildSessionArtifactPayload({ provider, snapshot, cookies }),
      },
      metadata: commonMetadata,
    };
  }

  if (provider === 'github') {
    const username = cookieValue(cookies, 'dotcom_user');
    const hasLoginCookie = hasAnyCookie(cookies, ['user_session', 'dotcom_user'])
      || cookieValue(cookies, 'logged_in').toLowerCase() === 'yes';
    if (!hasLoginCookie) return null;
    const displayName = username || '浏览器凭证';
    return {
      provider,
      label: `${providerLabel} · ${displayName}`,
      subject: username || null,
      username: username || null,
      credentialType: 'session_artifact',
      payload: buildSessionArtifactPayload({ provider, snapshot, cookies }),
      metadata: commonMetadata,
    };
  }

  const hasGoogleSession = hasAnyCookie(cookies, [
    'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
    '__Secure-1PSID', '__Secure-3PSID', 'LSID',
  ]);
  if (!hasGoogleSession) return null;
  return {
    provider,
    label: `${providerLabel} · 浏览器凭证`,
    subject: 'google-browser-profile',
    credentialType: 'session_artifact',
    payload: buildSessionArtifactPayload({ provider, snapshot, cookies }),
    metadata: commonMetadata,
  };
}

function toSessionInfo(session: InternalSession): SiteAuthBrowserSessionInfo {
  return {
    provider: session.provider,
    state: session.state,
    status: session.status,
    loginUrl: session.loginUrl,
    viewUrl: session.viewUrl,
    ...(session.currentUrl ? { currentUrl: session.currentUrl } : {}),
    ...(session.error ? { error: session.error } : {}),
    ...(session.credential ? { credential: session.credential } : {}),
  };
}

function scheduleSessionCleanup(session: InternalSession): void {
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    sessions.delete(session.state);
  }, SESSION_CLEANUP_DELAY_MS);
  session.cleanupTimer.unref?.();
}

async function closeBrowserController(session: InternalSession): Promise<void> {
  if (session.controllerClosed) return;
  session.controllerClosed = true;
  try {
    await session.controller.close();
  } catch {}
}

async function removeTemporaryProfile(session: InternalSession): Promise<void> {
  if (session.preserveProfile) return;
  await rm(session.profileDir, { recursive: true, force: true }).catch(() => {});
}

async function finishBrowserSession(session: InternalSession): Promise<void> {
  releaseBrowserDisplay(`site-auth:${session.state}`);
  await closeBrowserController(session);
  await removeTemporaryProfile(session);
  scheduleSessionCleanup(session);
}

async function persistSessionCredential(session: InternalSession, options: { quiet?: boolean } = {}): Promise<SiteAuthCredentialSummary | null> {
  if (session.status !== 'pending') return session.credential || null;
  if (session.saving) return null;
  session.saving = true;
  try {
    const snapshot = await session.controller.snapshot();
    session.currentUrl = snapshot.currentUrl;
    const credentialInput = await buildCredentialInputFromSnapshot(session.provider, snapshot);
    if (!credentialInput) {
      if (options.quiet) return null;
      throw new Error(`尚未检测到 ${PROVIDER_LABELS[session.provider]} 已登录状态。请在小窗里完成登录、验证码或 2FA 后再保存。`);
    }
    const credential = await createSiteAuthCredential(credentialInput);
    session.status = 'success';
    session.credential = credential;
    session.error = undefined;
    await finishBrowserSession(session);
    return credential;
  } catch (error: any) {
    if (!options.quiet) throw error;
    return null;
  } finally {
    session.saving = false;
  }
}

async function closeProviderPendingSession(provider: SiteAuthProviderId): Promise<void> {
  const pending = Array.from(sessions.values()).filter((session) => session.provider === provider && session.status === 'pending');
  await Promise.all(pending.map(async (session) => {
    session.status = 'closed';
    await finishBrowserSession(session);
  }));
}

export function setSiteAuthBrowserDriverForTest(driver: BrowserDriver | null): void {
  browserDriverFactory = driver ? () => driver : createPlaywrightBrowserDriver;
}

export function clearSiteAuthBrowserSessionsForTest(): void {
  for (const session of sessions.values()) {
    releaseBrowserDisplay(`site-auth:${session.state}`);
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    void session.controller.close().catch(() => {});
  }
  sessions.clear();
}

export async function startSiteAuthBrowserLogin(provider: SiteAuthProviderId, origin: string): Promise<SiteAuthBrowserStartResult> {
  const state = randomUUID();
  const leaseKey = `site-auth:${state}`;
  const resolvedOrigin = resolveOrigin(origin);
  const loginUrl = PROVIDER_LOGIN_URLS[provider];
  const viewUrl = `${resolvedOrigin}/site-auth/browser/${state}`;
  const profileDir = resolveProfileDir(provider);
  await acquireExclusiveBrowserDisplay(leaseKey, async () => {
    const session = sessions.get(state);
    if (!session) return;
    if (session.status === 'pending') session.status = 'closed';
    await finishBrowserSession(session);
  });
  await mkdir(profileDir, { recursive: true });
  await closeProviderPendingSession(provider);
  await clearChromiumProfileLocks(profileDir);

  let controller: BrowserPageController;
  try {
    controller = await withTimeout(
      browserDriverFactory().start({ provider, state, loginUrl, profileDir }),
      BROWSER_STARTUP_TIMEOUT_MS + 8_000,
    );
  } catch (error: any) {
    releaseBrowserDisplay(leaseKey);
    throw new Error(`无法启动 ${PROVIDER_LABELS[provider]} 登录窗口：${error?.message || '受控浏览器不可用'}`);
  }

  await ensureNoVncGatewayStarted(resolveBrowserDisplay());
  const session: InternalSession = {
    provider,
    state,
    status: 'pending',
    loginUrl,
    viewUrl,
    noVncUrl: buildNoVncUrl(resolvedOrigin),
    profileDir,
    preserveProfile: true,
    controller,
  };
  sessions.set(state, session);

  return {
    provider,
    state,
    authorizationUrl: viewUrl,
    instructions: {
      mode: 'controlled_browser',
      loginUrl,
      viewUrl,
      savePath: `/api/site-auth/browser-sessions/${state}/save`,
      screenshotPath: `/api/site-auth/browser-sessions/${state}/screenshot`,
    },
  };
}

export function getSiteAuthBrowserSession(state: string): SiteAuthBrowserSessionInfo | null {
  const session = sessions.get(state);
  return session ? toSessionInfo(session) : null;
}

function getInternalSession(state: string): InternalSession {
  const session = sessions.get(state);
  if (!session) throw new Error('site auth browser session not found');
  return session;
}

export async function captureSiteAuthBrowserScreenshot(state: string): Promise<Buffer> {
  const session = getInternalSession(state);
  if (session.controllerClosed) throw new Error('site auth browser session is closed');
  return session.controller.screenshot();
}

export async function sendSiteAuthBrowserInput(state: string, event: SiteAuthBrowserInputEvent): Promise<SiteAuthBrowserSessionInfo> {
  const session = getInternalSession(state);
  if (session.status !== 'pending' || session.controllerClosed) return toSessionInfo(session);
  if (event.type === 'click') {
    await session.controller.click(Math.max(0, Math.min(VIEWPORT.width, event.x)), Math.max(0, Math.min(VIEWPORT.height, event.y)));
  } else if (event.type === 'mouseDown') {
    await session.controller.mouseDown(Math.max(0, Math.min(VIEWPORT.width, event.x)), Math.max(0, Math.min(VIEWPORT.height, event.y)));
  } else if (event.type === 'mouseMove') {
    await session.controller.mouseMove(Math.max(0, Math.min(VIEWPORT.width, event.x)), Math.max(0, Math.min(VIEWPORT.height, event.y)));
  } else if (event.type === 'mouseUp') {
    await session.controller.mouseUp(Math.max(0, Math.min(VIEWPORT.width, event.x)), Math.max(0, Math.min(VIEWPORT.height, event.y)));
  } else if (event.type === 'type') {
    const text = asTrimmedString(event.text);
    if (text) await session.controller.typeText(text.slice(0, 1000));
  } else if (event.type === 'press') {
    const key = asTrimmedString(event.key);
    if (key) await session.controller.press(key);
  } else if (event.type === 'scroll') {
    await session.controller.scroll(Math.max(-3000, Math.min(3000, event.deltaY || 0)));
  }
  return toSessionInfo(session);
}

export async function saveSiteAuthBrowserSession(state: string): Promise<SiteAuthBrowserSessionInfo> {
  const session = getInternalSession(state);
  await persistSessionCredential(session, { quiet: false });
  return toSessionInfo(session);
}

export async function closeSiteAuthBrowserSession(state: string): Promise<SiteAuthBrowserSessionInfo> {
  const session = getInternalSession(state);
  if (session.status === 'pending') session.status = 'closed';
  await finishBrowserSession(session);
  return toSessionInfo(session);
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderSiteAuthBrowserPage(state: string): string {
  const safeState = htmlEscape(state);
  const jsonState = JSON.stringify(state);
  const session = sessions.get(state);
  const jsonNoVncUrl = JSON.stringify(session?.noVncUrl || buildNoVncUrl('http://127.0.0.1:4000'));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Metapi 第三方登录</title>
<style>
:root{color-scheme:light;background:#0f172a;color:#e5e7eb;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#020617}.bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.12);background:rgba(15,23,42,.94)}.title{font-weight:750}.hint{font-size:12px;color:#a5b4fc;max-width:760px;line-height:1.45}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn{border:0;border-radius:999px;padding:8px 13px;font-weight:750;cursor:pointer}.primary{background:#22c55e;color:#052e16}.ghost{background:rgba(255,255,255,.1);color:#e5e7eb}.danger{background:#ef4444;color:white}.status{padding:8px 14px;font-size:13px;color:#d1d5db;background:rgba(2,6,23,.75);border-bottom:1px solid rgba(255,255,255,.08)}.stage{height:calc(100vh - 104px);background:#111827}.novnc{width:100%;height:100%;border:0;background:#111827}.ok{color:#86efac}.err{color:#fecaca}
</style>
</head>
<body>
<div class="bar"><div><div class="title">Metapi 第三方凭证登录窗口</div><div class="hint">这是 noVNC 真实远程浏览器，不再用截图模拟点击。请在窗口里登录，完成验证码或 2FA 后点击保存。</div></div><div class="actions"><button class="btn primary" id="save">保存当前登录状态</button><button class="btn ghost" id="reload">重载远程窗口</button><button class="btn danger" id="close">关闭</button></div></div>
<div class="status" id="status">会话 ${safeState} 正在启动...</div><div class="stage"><iframe id="novnc" class="novnc" allow="clipboard-read; clipboard-write"></iframe></div>
<script>
const state=${jsonState};
const noVncUrl=${jsonNoVncUrl};
const frame=document.getElementById('novnc');
const statusEl=document.getElementById('status');
const saveBtn=document.getElementById('save');
let closed=false;
function token(){const q=new URLSearchParams(window.location.search).get('metapiAuthToken')||'';return(q.trim()||localStorage.getItem('auth_token')||'').trim()}
function setStatus(t,c){statusEl.textContent=t;statusEl.className='status '+(c||'')}
async function api(path,options={}){const headers=new Headers(options.headers||{});const t=token();if(t)headers.set('Authorization','Bearer '+t);if(options.body&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');const res=await fetch(path,{...options,headers});if(!res.ok){let msg='HTTP '+res.status;try{const b=await res.json();msg=b.message||b.error||msg}catch{}throw new Error(msg)}return res}
function loadVnc(){frame.src=noVncUrl}
async function poll(){if(closed)return;try{const res=await api('/api/site-auth/sessions/'+encodeURIComponent(state));const data=await res.json();if(data.status==='success'){setStatus((data.credential&&data.credential.label?data.credential.label:'凭证')+' 已保存，可以关闭窗口。','ok');closed=true;try{window.opener&&window.opener.postMessage({type:'metapi-site-auth',status:'success',state},'*')}catch{}return}if(data.status==='closed'){setStatus('登录窗口已关闭，未保存凭证。');closed=true;return}if(data.status==='error'){setStatus(data.error||'登录会话失败','err');closed=true;return}setStatus('远程浏览器已连接。登录完成后点击“保存当前登录状态”。')}catch(e){setStatus(e.message||'会话状态读取失败','err')}if(!closed)setTimeout(poll,2500)}
document.getElementById('save').addEventListener('click',async()=>{try{saveBtn.disabled=true;setStatus('正在验证并保存当前登录状态...');const res=await api('/api/site-auth/browser-sessions/'+encodeURIComponent(state)+'/save',{method:'POST'});const data=await res.json();setStatus((data.credential&&data.credential.label?data.credential.label:'凭证')+' 已保存，可以关闭窗口。','ok');closed=true;try{window.opener&&window.opener.postMessage({type:'metapi-site-auth',status:'success',state},'*')}catch{}}catch(e){setStatus(e.message||'保存失败','err')}finally{saveBtn.disabled=false}});
document.getElementById('reload').addEventListener('click',loadVnc);
document.getElementById('close').addEventListener('click',async()=>{try{await api('/api/site-auth/browser-sessions/'+encodeURIComponent(state)+'/close',{method:'POST'})}catch{}window.close()});
loadVnc();poll();
</script>
</body>
</html>`;
}
function createPlaywrightBrowserDriver(): BrowserDriver {
  return {
    async start(input) {
      const chromium = await loadChromiumBrowserType();
      const executablePath = resolveBrowserExecutablePath();
      const proxyUrl = resolveBrowserProxyUrl();
      const headless = resolveBrowserHeadless();
      const launchEnv = { ...process.env };
      if (!headless) {
        const display = resolveBrowserDisplay();
        await ensureXvfbStarted(display);
        launchEnv.DISPLAY = display;
      }
      const context = await chromium.launchPersistentContext(input.profileDir, {
        executablePath,
        ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
        headless,
        env: launchEnv,
        viewport: VIEWPORT,
        ignoreHTTPSErrors: true,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
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
      const page = context.pages()[0] || await context.newPage();
      const stopLinuxDoCaptchaAutoConfirm = startLinuxDoCaptchaAutoConfirm(page);
      await page.setViewportSize(VIEWPORT);
      void page.goto(input.loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: BROWSER_STARTUP_TIMEOUT_MS,
      }).catch(async () => {
        await page.evaluate((url) => {
          window.location.href = url;
        }, input.loginUrl).catch(() => {});
      });
      return createPlaywrightController(context, page, async () => {
        stopLinuxDoCaptchaAutoConfirm();
        await context.close();
      });
    },
  };
}
function createPlaywrightController(context: BrowserContext, page: Page, closeBrowser?: () => Promise<void>): BrowserPageController {
  return {
    screenshot: async () => {
      try {
        return await withTimeout(page.screenshot({
          type: 'png',
          fullPage: false,
          timeout: SCREENSHOT_TIMEOUT_MS,
          animations: 'disabled',
          caret: 'hide',
        }), 6000);
      } catch {}
      try {
        return await withTimeout((async () => {
          const cdp = await context.newCDPSession(page);
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
          return FALLBACK_SCREENSHOT_PNG;
        })(), 4000);
      } catch {
        return FALLBACK_SCREENSHOT_PNG;
      }
    },
    click: async (x, y) => { await page.mouse.click(x, y); },
    mouseDown: async (x, y) => {
      await page.mouse.move(x, y);
      await page.mouse.down();
    },
    mouseMove: async (x, y) => { await page.mouse.move(x, y); },
    mouseUp: async (x, y) => {
      await page.mouse.move(x, y);
      await page.mouse.up();
    },
    typeText: async (text) => { await page.keyboard.type(text, { delay: 8 }); },
    press: async (key) => { await page.keyboard.press(key); },
    scroll: async (deltaY) => { await page.mouse.wheel(0, deltaY); },
    snapshot: async () => {
      let storageState: BrowserStorageState | undefined;
      try {
        storageState = await context.storageState({ indexedDB: true }) as BrowserStorageState;
      } catch {
        storageState = await context.storageState() as BrowserStorageState;
      }
      let siteIdentity: BrowserSnapshot['siteIdentity'] = null;
      try {
        const currentUrl = new URL(page.url());
        if (currentUrl.hostname === 'linux.do' || currentUrl.hostname.endsWith('.linux.do')) {
          siteIdentity = normalizeLinuxDoIdentity(await page.evaluate(async () => {
            const response = await fetch('/session/current.json', {
              credentials: 'include',
              headers: { Accept: 'application/json' },
            });
            if (!response.ok) return null;
            return response.json();
          }));
        }
      } catch {}
      return {
        currentUrl: page.url(),
        title: await page.title().catch(() => ''),
        cookies: await context.cookies(),
        storageState,
        siteIdentity,
      };
    },
    close: async () => { await (closeBrowser ? closeBrowser() : context.close()); },
  };
}

export const siteAuthBrowserSessionCompatibility = {
  mode: 'controlled_browser',
  loginUrls: PROVIDER_LOGIN_URLS,
  viewport: VIEWPORT,
};
