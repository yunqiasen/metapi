import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, proxyAgentMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  proxyAgentMock: vi.fn(function ProxyAgentMock(this: { url?: string }, url: string) {
    this.url = url;
  }),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
  ProxyAgent: proxyAgentMock,
}));

type DbModule = typeof import('../../db/index.js');
type VaultModule = typeof import('../../services/site-auth/credentialVault.js');
type BrowserSessionModule = typeof import('../../services/site-auth/browserLoginSession.js');
type RateLimitModule = typeof import('../../middleware/requestRateLimit.js');

describe('site auth routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let vault: VaultModule;
  let browserSessions: BrowserSessionModule;
  let resetRateLimitStore: RateLimitModule['resetRequestRateLimitStore'];
  let browserSnapshot: {
    currentUrl: string;
    cookies: any[];
    storageState: { cookies: any[]; origins: any[] };
    siteIdentity?: { subject?: string | null; username?: string | null; email?: string | null } | null;
  };
  let browserStartInputs: Array<{ provider: string; state: string; loginUrl: string; profileDir: string }>;
  let browserEvents: Array<Record<string, unknown>>;
  let browserCloseCount: number;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-site-auth-routes-'));
    process.env.ACCOUNT_CREDENTIAL_SECRET = 'site-auth-routes-test-secret';
    process.env.SITE_AUTH_GITHUB_CLIENT_ID = 'github-client-id';
    process.env.SITE_AUTH_GITHUB_CLIENT_SECRET = 'github-client-secret';
    process.env.SITE_AUTH_GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.SITE_AUTH_GOOGLE_CLIENT_SECRET = 'google-client-secret';
    process.env.SITE_AUTH_LINUXDO_CLIENT_ID = 'linuxdo-client-id';
    process.env.SITE_AUTH_LINUXDO_CLIENT_SECRET = 'linuxdo-client-secret';

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    browserSessions = await import('../../services/site-auth/browserLoginSession.js');
    resetRateLimitStore = (await import('../../middleware/requestRateLimit.js')).resetRequestRateLimitStore;
    browserSessions.setSiteAuthBrowserDriverForTest({
      start: async (input) => {
        browserStartInputs.push(input);
        return {
          screenshot: async () => Buffer.from('fake-png'),
          click: async (x, y) => { browserEvents.push({ type: 'click', x, y }); },
          mouseDown: async (x, y) => { browserEvents.push({ type: 'mouseDown', x, y }); },
          mouseMove: async (x, y) => { browserEvents.push({ type: 'mouseMove', x, y }); },
          mouseUp: async (x, y) => { browserEvents.push({ type: 'mouseUp', x, y }); },
          typeText: async (text) => { browserEvents.push({ type: 'type', text }); },
          press: async (key) => { browserEvents.push({ type: 'press', key }); },
          scroll: async (deltaY) => { browserEvents.push({ type: 'scroll', deltaY }); },
          snapshot: async () => browserSnapshot,
          close: async () => { browserCloseCount += 1; },
        };
      },
    });
    const routesModule = await import('./siteAuth.js');
    vault = await import('../../services/site-auth/credentialVault.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.siteAuthRoutes);
  });

  beforeEach(async () => {
    fetchMock.mockReset();
    resetRateLimitStore();
    browserSessions.clearSiteAuthBrowserSessionsForTest();
    browserSnapshot = { currentUrl: 'about:blank', cookies: [], storageState: { cookies: [], origins: [] } };
    browserStartInputs = [];
    browserEvents = [];
    browserCloseCount = 0;
    await db.delete(schema.siteAuthCredentials).run();
    await db.delete(schema.sites).run();
  });

  it('lists supported third-party login providers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/site-auth/providers',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      providers: [
        expect.objectContaining({ provider: 'linuxdo', label: 'LinuxDO' }),
        expect.objectContaining({ provider: 'github', label: 'GitHub' }),
        expect.objectContaining({ provider: 'google', label: 'Google' }),
      ],
    });
  });

  it('starts LinuxDO controlled-browser login without OAuth app client config', async () => {
    const originalClientId = process.env.SITE_AUTH_LINUXDO_CLIENT_ID;
    const originalClientSecret = process.env.SITE_AUTH_LINUXDO_CLIENT_SECRET;
    delete process.env.SITE_AUTH_LINUXDO_CLIENT_ID;
    delete process.env.SITE_AUTH_LINUXDO_CLIENT_SECRET;
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/site-auth/providers/linuxdo/start',
        headers: { origin: 'http://metapi.local' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('SITE_AUTH_');
      expect(response.body).not.toContain('user-api-key');
      const body = response.json();
      expect(body).toMatchObject({
        provider: 'linuxdo',
        instructions: {
          mode: 'controlled_browser',
          loginUrl: 'https://linux.do/login',
        },
      });
      expect(body.authorizationUrl).toBe(`http://metapi.local/site-auth/browser/${body.state}`);
    } finally {
      process.env.SITE_AUTH_LINUXDO_CLIENT_ID = originalClientId;
      process.env.SITE_AUTH_LINUXDO_CLIENT_SECRET = originalClientSecret;
    }
  });

  it('lists credential summaries without leaking encrypted payloads', async () => {
    await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '主 LinuxDO',
      subject: 'linuxdo-user-42',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=super-secret-session' },
      metadata: { source: 'route-test' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/site-auth/credentials',
    });

    expect(response.statusCode).toBe(200);
    const bodyText = response.body;
    expect(bodyText).not.toContain('super-secret-session');
    expect(bodyText).not.toContain('encryptedPayload');
    expect(response.json()).toMatchObject({
      items: [
        expect.objectContaining({
          provider: 'linuxdo',
          label: '主 LinuxDO',
          subject: 'linuxdo-user-42',
          credentialType: 'cookie',
          metadata: { source: 'route-test' },
        }),
      ],
      total: 1,
    });
  });

  it('starts GitHub controlled-browser login and stores the pending session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/github/start',
      headers: { origin: 'http://metapi.local' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      provider: 'github',
      instructions: {
        mode: 'controlled_browser',
        loginUrl: 'https://github.com/login',
      },
    });
    expect(body.authorizationUrl).toBe(`http://metapi.local/site-auth/browser/${body.state}`);
    expect(body.authorizationUrl).not.toContain('api.openai.com/login');
    expect(body.authorizationUrl).not.toContain('user-api-key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders browser page with noVNC iframe instead of screenshot relay', async () => {
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/github/start',
      headers: { origin: 'http://metapi.local' },
    });
    const state = startResponse.json().state;

    const pageResponse = await app.inject({ method: 'GET', url: `/site-auth/browser/${state}` });

    expect(pageResponse.statusCode).toBe(200);
    expect(pageResponse.body).toContain('noVNC 真实远程浏览器');
    expect(pageResponse.body).toContain('<iframe id="novnc"');
    expect(pageResponse.body).toContain('vnc.html?autoconnect=1');
    expect(pageResponse.body).toContain("/api/site-auth/browser-sessions/'+encodeURIComponent(state)+'/save");
    expect(pageResponse.body).not.toContain('URL.createObjectURL');
    expect(pageResponse.body).not.toContain('img id="screen"');
    expect(pageResponse.body).not.toContain('setInterval(refreshScreen');
  });

  it('keeps browser screenshot refreshes from exhausting session status polling limits', async () => {
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/github/start',
      headers: { origin: 'http://metapi.local' },
    });
    const state = startResponse.json().state;

    for (let index = 0; index < 75; index += 1) {
      const screenshotResponse = await app.inject({
        method: 'GET',
        url: `/api/site-auth/browser-sessions/${state}/screenshot?t=${index}`,
      });
      expect(screenshotResponse.statusCode).toBe(200);
    }

    const sessionResponse = await app.inject({
      method: 'GET',
      url: `/api/site-auth/sessions/${state}`,
    });

    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.json()).toMatchObject({ state, status: 'pending' });
  });

  it('allows normal typing in a controlled browser login session without authorization-start throttling', async () => {
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/github/start',
      headers: { origin: 'http://metapi.local' },
    });
    const state = startResponse.json().state;

    for (let index = 0; index < 40; index += 1) {
      const inputResponse = await app.inject({
        method: 'POST',
        url: `/api/site-auth/browser-sessions/${state}/input`,
        payload: { type: 'type', text: String(index % 10) },
      });
      expect(inputResponse.statusCode).toBe(200);
    }
  });

  it('forwards drag gestures to the controlled browser for graphical captcha interactions', async () => {
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/github/start',
      headers: { origin: 'http://metapi.local' },
    });
    const state = startResponse.json().state;

    const events = [
      { type: 'mouseDown', x: 120, y: 300 },
      { type: 'mouseMove', x: 260, y: 300 },
      { type: 'mouseMove', x: 420, y: 300 },
      { type: 'mouseUp', x: 420, y: 300 },
    ];

    for (const event of events) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/site-auth/browser-sessions/${state}/input`,
        payload: event,
      });
      expect(response.statusCode).toBe(200);
    }

    expect(browserEvents).toEqual(events);
  });

  it('reuses a provider working browser profile for provider credential capture', async () => {
    const firstResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/github/start',
      headers: { origin: 'http://metapi.local' },
    });
    expect(firstResponse.statusCode).toBe(200);
    const firstState = firstResponse.json().state;
    const firstProfileDir = browserStartInputs.at(-1)?.profileDir;

    browserSnapshot = {
      currentUrl: 'https://github.com/',
      cookies: [
        { name: 'dotcom_user', value: 'octocat', domain: '.github.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' },
        { name: 'user_session', value: 'first-secret-session', domain: '.github.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      ],
      storageState: { cookies: [], origins: [] },
    };
    const saveResponse = await app.inject({ method: 'POST', url: `/api/site-auth/browser-sessions/${firstState}/save` });
    expect(saveResponse.statusCode).toBe(200);
    expect(browserCloseCount).toBe(1);

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/github/start',
      headers: { origin: 'http://metapi.local' },
    });
    expect(secondResponse.statusCode).toBe(200);
    const secondProfileDir = browserStartInputs.at(-1)?.profileDir;

    expect(firstProfileDir).toMatch(/site-auth-working-profiles\/github$/);
    expect(secondProfileDir).toBe(firstProfileDir);
    expect(firstProfileDir).not.toContain(firstState);
    expect(secondProfileDir).not.toContain(secondResponse.json().state);
  });

  it('clears stale Chromium locks from the provider working profile before launch', async () => {
    const profileDir = join(process.env.DATA_DIR || '', 'site-auth-working-profiles', 'github');
    mkdirSync(profileDir, { recursive: true });
    const staleLockPaths = [
      join(profileDir, 'SingletonLock'),
      join(profileDir, 'SingletonSocket'),
      join(profileDir, 'SingletonCookie'),
    ];
    staleLockPaths.forEach((path) => writeFileSync(path, 'stale chromium lock'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/github/start',
      headers: { origin: 'http://metapi.local' },
    });

    expect(response.statusCode).toBe(200);
    expect(browserStartInputs.at(-1)?.profileDir).toBe(profileDir);
    staleLockPaths.forEach((path) => {
      expect(existsSync(path)).toBe(false);
    });
  });

  it('saves a GitHub controlled-browser session artifact without returning cookie payloads', async () => {
    browserSnapshot = {
      currentUrl: 'https://github.com/',
      cookies: [
        { name: 'dotcom_user', value: 'octocat', domain: '.github.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' },
        { name: 'user_session', value: 'github-secret-session', domain: '.github.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      ],
      storageState: { cookies: [], origins: [] },
    };
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/github/start',
      headers: { origin: 'http://metapi.local' },
    });
    const state = startResponse.json().state;

    const saveResponse = await app.inject({ method: 'POST', url: `/api/site-auth/browser-sessions/${state}/save` });

    expect(saveResponse.statusCode).toBe(200);
    expect(saveResponse.body).not.toContain('github-secret-session');
    expect(saveResponse.json()).toMatchObject({
      provider: 'github',
      state,
      status: 'success',
      credential: {
        provider: 'github',
        label: 'GitHub · octocat',
        credentialType: 'session_artifact',
        subject: 'octocat',
        username: 'octocat',
        metadata: { source: 'controlled-browser-login' },
      },
    });
    const payload = await vault.getSiteAuthCredentialPayload(saveResponse.json().credential.id);
    expect(payload).toMatchObject({
      provider: 'github',
      currentUrl: 'https://github.com/',
      cookies: [
        expect.objectContaining({ name: 'dotcom_user', value: 'octocat' }),
        expect.objectContaining({ name: 'user_session', value: 'github-secret-session' }),
      ],
    });
  });

  it('saves a Google controlled-browser session artifact without OAuth app config', async () => {
    const originalClientId = process.env.SITE_AUTH_GOOGLE_CLIENT_ID;
    const originalClientSecret = process.env.SITE_AUTH_GOOGLE_CLIENT_SECRET;
    delete process.env.SITE_AUTH_GOOGLE_CLIENT_ID;
    delete process.env.SITE_AUTH_GOOGLE_CLIENT_SECRET;
    browserSnapshot = {
      currentUrl: 'https://accounts.google.com/',
      cookies: [
        { name: '__Secure-1PSID', value: 'google-secret-session', domain: '.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      ],
      storageState: { cookies: [], origins: [] },
    };
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/google/start',
      headers: { origin: 'http://metapi.local' },
    });
    expect(startResponse.statusCode).toBe(200);
    const state = startResponse.json().state;

    const saveResponse = await app.inject({ method: 'POST', url: `/api/site-auth/browser-sessions/${state}/save` });

    expect(saveResponse.statusCode).toBe(200);
    expect(saveResponse.body).not.toContain('google-secret-session');
    expect(saveResponse.json()).toMatchObject({
      provider: 'google',
      state,
      status: 'success',
      credential: {
        provider: 'google',
        label: 'Google · 浏览器凭证',
        credentialType: 'session_artifact',
        subject: 'google-browser-profile',
        metadata: { source: 'controlled-browser-login' },
      },
    });
    const payload = await vault.getSiteAuthCredentialPayload(saveResponse.json().credential.id);
    expect(payload).toMatchObject({
      provider: 'google',
      currentUrl: 'https://accounts.google.com/',
      cookies: [expect.objectContaining({ name: '__Secure-1PSID', value: 'google-secret-session' })],
    });
    process.env.SITE_AUTH_GOOGLE_CLIENT_ID = originalClientId;
    process.env.SITE_AUTH_GOOGLE_CLIENT_SECRET = originalClientSecret;
  });

  it('starts LinuxDO controlled-browser login and stores the pending session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/linuxdo/start',
      headers: { origin: 'http://metapi.local' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      provider: 'linuxdo',
      instructions: {
        mode: 'controlled_browser',
        loginUrl: 'https://linux.do/login',
      },
    });
    expect(body.authorizationUrl).toBe(`http://metapi.local/site-auth/browser/${body.state}`);
    expect(body.authorizationUrl).not.toContain('user-api-key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('saves a LinuxDO controlled-browser cookie credential after login is detected', async () => {
    browserSnapshot = {
      currentUrl: 'https://linux.do/',
      cookies: [
        { name: '_t', value: 'linuxdo-secret-session', domain: '.linux.do', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      ],
      storageState: { cookies: [], origins: [] },
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ current_user: { id: 6789, username: 'linuxdo-user', email: 'linuxdo@example.com' } }),
    });
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/linuxdo/start',
      headers: { origin: 'http://metapi.local' },
    });
    expect(startResponse.statusCode).toBe(200);
    const state = startResponse.json().state;

    const saveResponse = await app.inject({ method: 'POST', url: `/api/site-auth/browser-sessions/${state}/save` });

    expect(saveResponse.statusCode).toBe(200);
    expect(saveResponse.body).not.toContain('linuxdo-secret-session');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://linux.do/session/current.json',
      expect.objectContaining({
        headers: expect.objectContaining({ Cookie: '_t=linuxdo-secret-session' }),
      }),
    );
    expect(saveResponse.json()).toMatchObject({
      provider: 'linuxdo',
      state,
      status: 'success',
      credential: {
        provider: 'linuxdo',
        label: 'LinuxDO · linuxdo-user',
        credentialType: 'cookie',
        subject: '6789',
        username: 'linuxdo-user',
        email: 'linuxdo@example.com',
        metadata: { source: 'controlled-browser-login' },
      },
    });
    const payload = await vault.getSiteAuthCredentialPayload(saveResponse.json().credential.id);
    expect(payload).toMatchObject({
      cookie: '_t=linuxdo-secret-session',
      provider: 'linuxdo',
      currentUrl: 'https://linux.do/',
    });
  });

  it('saves LinuxDO credential from in-browser identity when server-side identity fetch is blocked', async () => {
    browserSnapshot = {
      currentUrl: 'https://linux.do/',
      cookies: [
        { name: '_t', value: 'linuxdo-secret-session', domain: '.linux.do', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      ],
      storageState: { cookies: [], origins: [] },
      siteIdentity: { subject: '7890', username: 'linuxdo-browser-user', email: 'browser@example.com' },
    };
    fetchMock.mockRejectedValueOnce(new Error('server-side identity fetch blocked'));
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/linuxdo/start',
      headers: { origin: 'http://metapi.local' },
    });
    expect(startResponse.statusCode).toBe(200);
    const state = startResponse.json().state;

    const saveResponse = await app.inject({ method: 'POST', url: `/api/site-auth/browser-sessions/${state}/save` });

    expect(saveResponse.statusCode).toBe(200);
    expect(saveResponse.body).not.toContain('linuxdo-secret-session');
    expect(saveResponse.json()).toMatchObject({
      status: 'success',
      credential: {
        provider: 'linuxdo',
        label: 'LinuxDO · linuxdo-browser-user',
        credentialType: 'cookie',
        subject: '7890',
        username: 'linuxdo-browser-user',
        email: 'browser@example.com',
      },
    });
  });

  it('does not save Google pre-login cookies as a credential', async () => {
    browserSnapshot = {
      currentUrl: 'https://accounts.google.com/v3/signin/identifier',
      cookies: [
        { name: '__Host-GAPS', value: 'google-prelogin-cookie', domain: 'accounts.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      ],
      storageState: { cookies: [], origins: [] },
    };
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/google/start',
      headers: { origin: 'http://metapi.local' },
    });
    expect(startResponse.statusCode).toBe(200);
    const state = startResponse.json().state;

    const saveResponse = await app.inject({ method: 'POST', url: `/api/site-auth/browser-sessions/${state}/save` });

    expect(saveResponse.statusCode).toBe(400);
    expect(saveResponse.body).not.toContain('google-prelogin-cookie');
    expect(saveResponse.json()).toMatchObject({
      success: false,
      message: expect.stringContaining('尚未检测到 Google 已登录状态'),
    });
    expect(await vault.listSiteAuthCredentials()).toHaveLength(0);
  });

  it('starts GitHub controlled-browser login even when OAuth app config is missing', async () => {
    const originalClientId = process.env.SITE_AUTH_GITHUB_CLIENT_ID;
    const originalClientSecret = process.env.SITE_AUTH_GITHUB_CLIENT_SECRET;
    delete process.env.SITE_AUTH_GITHUB_CLIENT_ID;
    delete process.env.SITE_AUTH_GITHUB_CLIENT_SECRET;
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/site-auth/providers/github/start',
        headers: { origin: 'http://metapi.local' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('SITE_AUTH_');
      expect(response.json()).toMatchObject({
        provider: 'github',
        instructions: { mode: 'controlled_browser', loginUrl: 'https://github.com/login' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.SITE_AUTH_GITHUB_CLIENT_ID = originalClientId;
      process.env.SITE_AUTH_GITHUB_CLIENT_SECRET = originalClientSecret;
    }
  });

  it('does not expose browser-helper credential capture endpoints', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/site-auth/browser-captures/legacy-state',
      payload: {
        provider: 'github',
        cookies: [{ name: 'user_session', value: 'github-secret-session', domain: '.github.com' }],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('github-secret-session');
  });

  it('imports a target-site session artifact without returning secret payloads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/site-auth/credentials/import',
      payload: {
        provider: 'github',
        label: 'GitHub 目标站 Session',
        credentialType: 'session_artifact',
        subject: 'target-user-2468',
        username: 'target-user',
        payload: {
          accessToken: 'target-site-session-secret',
          platformUserId: 2468,
        },
        metadata: {
          source: 'target-site-browser-login',
          targetSiteId: 31,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('target-site-session-secret');
    expect(response.json()).toMatchObject({
      success: true,
      item: {
        provider: 'github',
        label: 'GitHub 目标站 Session',
        credentialType: 'session_artifact',
        subject: 'target-user-2468',
        username: 'target-user',
        status: 'active',
        metadata: {
          source: 'target-site-browser-login',
          targetSiteId: 31,
        },
      },
    });

    const payload = await vault.getSiteAuthCredentialPayload(response.json().item.id);
    expect(payload).toMatchObject({
      accessToken: 'target-site-session-secret',
      platformUserId: 2468,
    });
  });

  it('reports credential decryptability without leaking payloads', async () => {
    await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '迁移路由检查',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=route-migration-check' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/site-auth/credentials/decryptability',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('route-migration-check');
    expect(response.body).not.toContain('ld_auth_session');
    expect(response.json()).toEqual(expect.objectContaining({
      total: 1,
      decryptable: 1,
      failed: 0,
      items: [expect.objectContaining({ label: '迁移路由检查', ok: true })],
    }));
  });

  it('imports a manual LinuxDO credential without returning secret payloads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/site-auth/credentials/import',
      payload: {
        provider: 'linuxdo',
        label: '主 LinuxDO',
        credentialType: 'cookie',
        subject: 'linuxdo-user-42',
        email: 'linuxdo-user@example.com',
        username: 'linuxdo-user',
        payload: {
          cookie: 'ld_auth_session=super-secret-session',
          userId: 42,
        },
        metadata: { source: 'manual-api-test' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('super-secret-session');
    expect(response.json()).toMatchObject({
      success: true,
      item: {
        provider: 'linuxdo',
        label: '主 LinuxDO',
        credentialType: 'cookie',
        subject: 'linuxdo-user-42',
        email: 'linuxdo-user@example.com',
        username: 'linuxdo-user',
        status: 'active',
        metadata: { source: 'manual-api-test' },
      },
    });

    const rows = await db.select().from(schema.siteAuthCredentials).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.encryptedPayload).not.toContain('super-secret-session');
  });

  it('parses browser assisted LinuxDO credential text', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/site-auth/credentials/parse-capture',
      payload: {
        text: 'ld_auth_session=route-secret; theme=light',
        defaultProvider: 'linuxdo',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      parsed: {
        provider: 'linuxdo',
        credentialType: 'cookie',
        payload: { cookie: 'ld_auth_session=route-secret' },
      },
    });
  });

  it('rejects invalid browser capture text without echoing the pasted value', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/site-auth/credentials/parse-capture',
      payload: {
        text: 'bad pasted text with hidden-secret',
        defaultProvider: 'linuxdo',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('hidden-secret');
    expect(response.json()).toMatchObject({
      success: false,
      message: 'no supported site auth credential found',
    });
  });

  it('verifies a LinuxDO cookie credential and updates identity metadata', async () => {
    const created = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '待校验 LinuxDO',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=super-secret-session' },
      status: 'invalid',
      lastError: 'previous failure',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        current_user: {
          id: 42,
          username: 'linuxdo-user',
          email: 'linuxdo-user@example.com',
        },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/site-auth/credentials/${created.id}/verify`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('super-secret-session');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://linux.do/session/current.json',
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: 'ld_auth_session=super-secret-session',
          Accept: 'application/json',
        }),
      }),
    );
    expect(response.json()).toMatchObject({
      success: true,
      item: {
        id: created.id,
        provider: 'linuxdo',
        status: 'active',
        subject: '42',
        username: 'linuxdo-user',
        email: 'linuxdo-user@example.com',
        lastError: null,
      },
    });
    expect(response.json().item.lastVerifiedAt).toEqual(expect.any(String));
  });

  it('returns auth-requirements with matching credential summaries', async () => {
    const [site] = await db.insert(schema.sites).values({
      name: 'LinuxDO Login Site',
      url: 'https://target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning();
    const credential = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '主 LinuxDO',
      subject: '42',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=secret' },
      status: 'active',
    });
    const oauthOnlyCredential = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: 'LinuxDO 官方 OAuth',
      subject: '43',
      credentialType: 'oauth_token',
      payload: { accessToken: 'linuxdo-oauth-secret' },
      status: 'active',
    });
    fetchMock
      .mockRejectedValueOnce(new Error('status unavailable'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<html><body><button>使用 LinuxDO 继续</button></body></html>',
      });

    const response = await app.inject({
      method: 'GET',
      url: `/api/sites/${site.id}/auth-requirements`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('ld_auth_session=secret');
    expect(response.body).not.toContain('linuxdo-oauth-secret');
    expect(response.json()).toMatchObject({
      siteId: site.id,
      hasThirdPartyLogin: true,
      requirements: [
        {
          provider: 'linuxdo',
          label: 'LinuxDO',
          required: true,
          confidence: 'detected',
          reason: expect.any(String),
          availableCredentials: [expect.objectContaining({ id: credential.id, label: '主 LinuxDO' })],
        },
      ],
    });
    const available = response.json().requirements[0].availableCredentials;
    expect(available).toHaveLength(1);
    expect(available.map((item: any) => item.id)).not.toContain(oauthOnlyCredential.id);
  });

  it('does not expose provider browser sessions as directly usable target-site bridge credentials', async () => {
    const [site] = await db.insert(schema.sites).values({
      name: 'GitHub Login Site',
      url: 'https://github-target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning();
    const providerSession = await vault.createSiteAuthCredential({
      provider: 'github',
      label: 'GitHub · octocat',
      credentialType: 'session_artifact',
      payload: {
        cookies: [{ name: 'user_session', value: 'github-secret-session', domain: '.github.com' }],
        storageState: { cookies: [], origins: [] },
      },
      metadata: { source: 'controlled-browser-login' },
      status: 'active',
    });
    const targetSiteSession = await vault.createSiteAuthCredential({
      provider: 'github',
      label: 'GitHub Target Site Session',
      credentialType: 'session_artifact',
      payload: { accessToken: 'target-site-session-token', platformUserId: 2468 },
      metadata: { source: 'target-site-browser-login', targetSiteId: site.id },
      status: 'active',
    });
    fetchMock
      .mockRejectedValueOnce(new Error('status unavailable'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<html><body><a href="https://github.com/login/oauth/authorize">Continue with GitHub</a></body></html>',
      });

    const response = await app.inject({
      method: 'GET',
      url: `/api/sites/${site.id}/auth-requirements`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('github-secret-session');
    expect(response.body).not.toContain('target-site-session-token');
    const available = response.json().requirements[0].availableCredentials;
    expect(available.map((item: any) => item.id)).toEqual([targetSiteSession.id]);
    expect(available.map((item: any) => item.id)).not.toContain(providerSession.id);
  });

  it('returns saved provider credentials separately for add-connection third-party login', async () => {
    const [site] = await db.insert(schema.sites).values({
      name: 'GitHub Login Site',
      url: 'https://github-target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning();
    const providerCredential = await vault.createSiteAuthCredential({
      provider: 'github',
      label: 'GitHub · octocat',
      credentialType: 'session_artifact',
      payload: {
        cookies: [{ name: 'user_session', value: 'github-secret-session', domain: '.github.com' }],
        storageState: { cookies: [], origins: [] },
      },
      metadata: { source: 'controlled-browser-login' },
      status: 'active',
    });
    const targetSiteSession = await vault.createSiteAuthCredential({
      provider: 'github',
      label: 'GitHub Target Site Session',
      credentialType: 'session_artifact',
      payload: { accessToken: 'target-site-session-token', platformUserId: 2468 },
      metadata: { source: 'target-site-browser-login', targetSiteId: site.id },
      status: 'active',
    });
    fetchMock.mockRejectedValueOnce(new Error('status unavailable'));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<html><body><a href="https://github.com/login/oauth/authorize">Continue with GitHub</a></body></html>',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/sites/${site.id}/auth-requirements`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('github-secret-session');
    expect(response.body).not.toContain('target-site-session-token');
    const requirement = response.json().requirements[0];
    expect(requirement.availableCredentials.map((item: any) => item.id)).toEqual([targetSiteSession.id]);
    expect(requirement.availableProviderCredentials.map((item: any) => item.id)).toEqual([providerCredential.id]);
  });

  it('returns no direct target sites for provider OAuth tokens', async () => {
    await db.insert(schema.sites).values({
      name: 'LinuxDO Target Site',
      url: 'https://linuxdo-target.example.com',
      platform: 'new-api',
      status: 'active',
    }).run();
    const credential = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: 'LinuxDO 官方 OAuth',
      credentialType: 'oauth_token',
      payload: { accessToken: 'linuxdo-oauth-secret' },
      status: 'active',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<html><body><button>使用 LinuxDO 继续</button></body></html>',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/site-auth/credentials/${credential.id}/target-sites`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('linuxdo-oauth-secret');
    expect(response.json()).toMatchObject({
      credentialId: credential.id,
      total: 0,
      items: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns target sites for a site auth credential without leaking payloads', async () => {
    const [linuxDoSite] = await db.insert(schema.sites).values({
      name: 'LinuxDO Target Site',
      url: 'https://linuxdo-target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning();
    await db.insert(schema.sites).values({
      name: 'Plain Target Site',
      url: 'https://plain-target.example.com',
      platform: 'new-api',
      status: 'active',
    }).run();
    const credential = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '主 LinuxDO',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=target-sites-secret' },
      status: 'active',
    });
    fetchMock
      .mockRejectedValueOnce(new Error('status unavailable'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<html><body><button>使用 LinuxDO 继续</button></body></html>',
      })
      .mockRejectedValueOnce(new Error('status unavailable'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<html><body><form>password login</form></body></html>',
      });

    const response = await app.inject({
      method: 'GET',
      url: `/api/site-auth/credentials/${credential.id}/target-sites`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('target-sites-secret');
    expect(response.body).not.toContain('ld_auth_session');
    expect(response.json()).toMatchObject({
      credentialId: credential.id,
      total: 1,
      items: [
        expect.objectContaining({
          id: linuxDoSite.id,
          name: 'LinuxDO Target Site',
          platform: 'new-api',
        }),
      ],
    });
  });

  it('deletes a credential summary by id', async () => {
    const created = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '删除路由测试',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=delete-route' },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/site-auth/credentials/${created.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    const listResponse = await app.inject({ method: 'GET', url: '/api/site-auth/credentials' });
    expect(listResponse.json()).toMatchObject({ items: [], total: 0 });
  });
});
