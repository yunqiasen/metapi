import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const externalAuthLoginMock = vi.fn();
const startExternalBrowserLoginMock = vi.fn();
const verifyTokenMock = vi.fn();
const getApiTokensMock = vi.fn();
const getUserInfoMock = vi.fn();

const targetBrowserSessionMock = vi.hoisted(() => ({
  captureTargetSiteBrowserScreenshot: vi.fn(),
  closeTargetSiteBrowserSession: vi.fn(),
  getTargetSiteBrowserSession: vi.fn(),
  markTargetSiteBrowserSessionSaved: vi.fn(),
  persistTargetSiteBrowserProfile: vi.fn(),
  readTargetSiteBrowserSessionAccessToken: vi.fn(),
  readTargetSiteBrowserSessionUserInfo: vi.fn(),
  renderTargetSiteBrowserPage: vi.fn(),
  sendTargetSiteBrowserInput: vi.fn(),
  startTargetSiteBrowserSession: vi.fn(),
}));

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    platformName: 'new-api',
    externalAuthLogin: (...args: unknown[]) => externalAuthLoginMock(...args),
    startExternalBrowserLogin: (...args: unknown[]) => startExternalBrowserLoginMock(...args),
    verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
    getUserInfo: (...args: unknown[]) => getUserInfoMock(...args),
  }),
}));

vi.mock('../../services/site-auth/targetSiteBrowserSession.js', () => ({
  captureTargetSiteBrowserScreenshot: targetBrowserSessionMock.captureTargetSiteBrowserScreenshot,
  closeTargetSiteBrowserSession: targetBrowserSessionMock.closeTargetSiteBrowserSession,
  getTargetSiteBrowserSession: targetBrowserSessionMock.getTargetSiteBrowserSession,
  markTargetSiteBrowserSessionSaved: targetBrowserSessionMock.markTargetSiteBrowserSessionSaved,
  persistTargetSiteBrowserProfile: targetBrowserSessionMock.persistTargetSiteBrowserProfile,
  readTargetSiteBrowserSessionAccessToken: targetBrowserSessionMock.readTargetSiteBrowserSessionAccessToken,
  readTargetSiteBrowserSessionUserInfo: targetBrowserSessionMock.readTargetSiteBrowserSessionUserInfo,
  renderTargetSiteBrowserPage: targetBrowserSessionMock.renderTargetSiteBrowserPage,
  sendTargetSiteBrowserInput: targetBrowserSessionMock.sendTargetSiteBrowserInput,
  startTargetSiteBrowserSession: targetBrowserSessionMock.startTargetSiteBrowserSession,
}));

type DbModule = typeof import('../../db/index.js');
type VaultModule = typeof import('../../services/site-auth/credentialVault.js');

describe('accounts site auth login', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let vault: VaultModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-site-auth-login-'));
    process.env.DATA_DIR = dataDir;
    process.env.ACCOUNT_CREDENTIAL_SECRET = 'accounts-site-auth-login-test-secret';

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    vault = await import('../../services/site-auth/credentialVault.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    externalAuthLoginMock.mockReset();
    startExternalBrowserLoginMock.mockReset();
    verifyTokenMock.mockReset();
    getApiTokensMock.mockReset();
    getApiTokensMock.mockResolvedValue([]);
    getUserInfoMock.mockReset();
    getUserInfoMock.mockResolvedValue(null);
    for (const mock of Object.values(targetBrowserSessionMock)) {
      mock.mockReset();
    }

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteAuthCredentials).run();
    await db.delete(schema.sites).run();
  });

  it('starts a target-site browser login without requiring a saved GitHub credential', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'GitHub Target',
      url: 'https://target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    startExternalBrowserLoginMock.mockResolvedValueOnce({
      sourceProvider: 'github',
      authorizationUrl: 'https://target.example.com/login',
      targetSiteUrl: 'https://target.example.com',
      completionMode: 'target_site_session',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/site-auth-browser-login/start',
      payload: {
        siteId: site.id,
        provider: 'github',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(startExternalBrowserLoginMock).toHaveBeenCalledWith('https://target.example.com', {
      sourceProvider: 'github',
    });
    expect(response.json()).toMatchObject({
      success: true,
      siteId: site.id,
      provider: 'github',
      authorizationUrl: 'https://target.example.com/login',
      instructions: {
        mode: 'target_site_browser_login',
      },
    });
  });

  afterAll(async () => {
    await app.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.ACCOUNT_CREDENTIAL_SECRET;
  });

  it('creates a normal session account from a saved site auth credential', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'LinuxDO Target',
      url: 'https://target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const credential = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '主 LinuxDO',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=super-secret-cookie' },
      status: 'active',
    });
    externalAuthLoginMock.mockResolvedValueOnce({
      accessToken: 'target-session-token',
      platformUserId: 42,
      username: 'target-user',
      sourceProvider: 'linuxdo',
    });
    verifyTokenMock.mockResolvedValueOnce({
      tokenType: 'session',
      userInfo: { username: 'verified-user' },
      apiToken: 'sk-target',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/site-auth-login',
      payload: {
        siteId: site.id,
        credentialId: credential.id,
        skipModelFetch: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('super-secret-cookie');
    expect(externalAuthLoginMock).toHaveBeenCalledWith('https://target.example.com', {
      sourceProvider: 'linuxdo',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=super-secret-cookie' },
    });
    expect(verifyTokenMock).toHaveBeenCalledWith('https://target.example.com', 'target-session-token', 42);

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      siteId: site.id,
      username: 'target-user',
      accessToken: 'target-session-token',
      apiToken: 'sk-target',
      checkinEnabled: true,
    });
    expect(JSON.parse(accounts[0]?.extraConfig || '{}')).toMatchObject({
      credentialMode: 'session',
      platformUserId: 42,
    });
    expect(response.json()).toMatchObject({
      tokenType: 'session',
      credentialMode: 'session',
      username: 'target-user',
      apiTokenFound: true,
    });
  });

  it('returns a safe bridge failure message without leaking credential payloads', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'LinuxDO Target',
      url: 'https://target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const credential = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '主 LinuxDO',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=super-secret-cookie' },
      status: 'active',
    });
    externalAuthLoginMock.mockRejectedValueOnce(new Error('HTTP 403 forbidden ld_auth_session=super-secret-cookie'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/site-auth-login',
      payload: {
        siteId: site.id,
        credentialId: credential.id,
        skipModelFetch: true,
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual(expect.objectContaining({
      success: false,
      message: '第三方登录桥接失败：凭证无效或目标站点拒绝授权。',
    }));
    expect(response.body).not.toContain('ld_auth_session');
    expect(response.body).not.toContain('super-secret-cookie');
  });

  it('auto-saves a target-site browser session account even when token verification is inconclusive', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'GitHub Target',
      url: 'https://target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const session = {
      state: 'target-state-1',
      siteId: site.id,
      provider: 'github',
      credentialId: 88,
      targetSiteUrl: 'https://target.example.com',
      loginUrl: 'https://target.example.com/login',
      viewUrl: 'http://metapi.local/site-auth/target-browser/target-state-1',
      status: 'pending',
      currentUrl: 'https://target.example.com/console',
    };
    targetBrowserSessionMock.getTargetSiteBrowserSession.mockReturnValue(session);
    targetBrowserSessionMock.readTargetSiteBrowserSessionAccessToken.mockResolvedValue({
      ...session,
      accessToken: 'session=target-site-session',
    });
    targetBrowserSessionMock.markTargetSiteBrowserSessionSaved.mockResolvedValue({
      ...session,
      status: 'success',
    });
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'unknown' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/site-auth-browser-sessions/target-state-1/save?auto=1',
    });

    expect(response.statusCode).toBe(200);
    expect(verifyTokenMock).toHaveBeenCalledWith('https://target.example.com', 'session=target-site-session', undefined);
    expect(targetBrowserSessionMock.markTargetSiteBrowserSessionSaved).toHaveBeenCalledWith('target-state-1');
    expect(targetBrowserSessionMock.persistTargetSiteBrowserProfile).toHaveBeenCalledWith(
      'target-state-1',
      expect.stringContaining('/browser-profiles/accounts/new-api/'),
    );

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      siteId: site.id,
      accessToken: 'session=target-site-session',
      checkinEnabled: true,
      apiToken: null,
    });
    expect(JSON.parse(accounts[0]?.extraConfig || '{}')).toMatchObject({
      credentialMode: 'session',
      source: 'target-site-browser-login',
      sourceProvider: 'github',
      providerCredentialId: 88,
      verification: 'pending',
    });
    expect(response.json()).toMatchObject({
      success: true,
      tokenType: 'session',
      credentialMode: 'session',
      verificationPending: true,
    });
  });

  it('extracts a target-site browser session for the normal add form without creating an account', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'GitHub Target',
      url: 'https://target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const session = {
      state: 'target-state-2',
      siteId: site.id,
      provider: 'github',
      credentialId: 88,
      targetSiteUrl: 'https://target.example.com',
      loginUrl: 'https://target.example.com/login',
      viewUrl: 'http://metapi.local/site-auth/target-browser/target-state-2',
      status: 'pending',
      currentUrl: 'https://target.example.com/console',
    };
    targetBrowserSessionMock.getTargetSiteBrowserSession.mockReturnValue(session);
    targetBrowserSessionMock.readTargetSiteBrowserSessionAccessToken.mockResolvedValue({
      ...session,
      accessToken: 'session=target-site-session',
    });
    getUserInfoMock.mockResolvedValueOnce({ username: 'octocat', platformUserId: 2468 });

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/site-auth-browser-sessions/target-state-2/extract?auto=1',
    });

    expect(response.statusCode).toBe(200);
    expect(getUserInfoMock).toHaveBeenCalledWith('https://target.example.com', 'session=target-site-session');
    expect(targetBrowserSessionMock.markTargetSiteBrowserSessionSaved).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      success: true,
      siteId: site.id,
      provider: 'github',
      credentialId: 88,
      accessToken: 'session=target-site-session',
      username: 'octocat',
      platformUserId: 2468,
    });
    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(0);
  });

  it('extracts target user info from the live browser page before falling back to adapter probes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Agent Target',
      url: 'https://target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const session = {
      state: 'target-state-page-user',
      siteId: site.id,
      provider: 'github',
      credentialId: 88,
      targetSiteUrl: 'https://target.example.com',
      loginUrl: 'https://target.example.com/login',
      viewUrl: 'http://metapi.local/site-auth/target-browser/target-state-page-user',
      status: 'pending',
      currentUrl: 'https://target.example.com/console/token',
    };
    targetBrowserSessionMock.getTargetSiteBrowserSession.mockReturnValue(session);
    targetBrowserSessionMock.readTargetSiteBrowserSessionAccessToken.mockResolvedValue({
      ...session,
      accessToken: 'session=target-site-session',
    });
    targetBrowserSessionMock.readTargetSiteBrowserSessionUserInfo.mockResolvedValue({
      username: 'octocat',
      platformUserId: 2468,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/site-auth-browser-sessions/target-state-page-user/extract?auto=1',
    });

    expect(response.statusCode).toBe(200);
    expect(targetBrowserSessionMock.readTargetSiteBrowserSessionUserInfo).toHaveBeenCalledWith('target-state-page-user');
    expect(targetBrowserSessionMock.markTargetSiteBrowserSessionSaved).not.toHaveBeenCalled();
    expect(getUserInfoMock).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      success: true,
      username: 'octocat',
      platformUserId: 2468,
    });
  });

  it('keeps auto extraction pending when cookies exist but target user info is unavailable', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Any Target',
      url: 'https://target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const session = {
      state: 'target-state-cookie-only',
      siteId: site.id,
      targetSiteUrl: 'https://target.example.com',
      loginUrl: 'https://target.example.com/login',
      viewUrl: 'http://metapi.local/site-auth/target-browser/target-state-cookie-only',
      status: 'pending',
      currentUrl: 'https://target.example.com/login',
    };
    targetBrowserSessionMock.getTargetSiteBrowserSession.mockReturnValue(session);
    targetBrowserSessionMock.readTargetSiteBrowserSessionAccessToken.mockResolvedValue({
      ...session,
      accessToken: 'acw_tc=waf-cookie-only',
    });
    getUserInfoMock.mockResolvedValueOnce(null);

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/site-auth-browser-sessions/target-state-cookie-only/extract?auto=1',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      success: false,
      pending: true,
    });
    expect(targetBrowserSessionMock.markTargetSiteBrowserSessionSaved).not.toHaveBeenCalled();
  });

  it('keeps Any/Agent extraction pending until the browser verifies the target user', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Any Target',
      url: 'https://anyrouter.top',
      platform: 'anyrouter',
      status: 'active',
    }).returning().get();
    const session = {
      state: 'target-state-any-cookie-only',
      siteId: site.id,
      provider: 'github',
      credentialId: 88,
      targetSiteUrl: 'https://anyrouter.top',
      loginUrl: 'https://anyrouter.top/login',
      viewUrl: 'http://metapi.local/site-auth/target-browser/target-state-any-cookie-only',
      status: 'pending',
      currentUrl: 'https://anyrouter.top/console',
    };
    targetBrowserSessionMock.getTargetSiteBrowserSession.mockReturnValue(session);
    targetBrowserSessionMock.readTargetSiteBrowserSessionAccessToken.mockResolvedValue({
      ...session,
      accessToken: 'session=target-site-session',
    });
    getUserInfoMock.mockResolvedValueOnce(null);

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/site-auth-browser-sessions/target-state-any-cookie-only/extract?auto=1',
    });

    expect(response.statusCode).toBe(202);
    expect(targetBrowserSessionMock.markTargetSiteBrowserSessionSaved).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      success: false,
      pending: true,
    });
  });

  it('creates a target-site browser session through the normal add-account endpoint when verification is inconclusive', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'GitHub Target',
      url: 'https://target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'unknown' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        username: 'GitHub · octocat',
        accessToken: 'session=target-site-session',
        credentialMode: 'session',
        skipModelFetch: true,
        targetSiteAuth: {
          source: 'target-site-browser-login',
          provider: 'github',
          credentialId: 88,
          state: 'target-state-3',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      siteId: site.id,
      username: 'GitHub · octocat',
      accessToken: 'session=target-site-session',
      checkinEnabled: true,
      apiToken: null,
    });
    expect(JSON.parse(accounts[0]?.extraConfig || '{}')).toMatchObject({
      credentialMode: 'session',
      source: 'target-site-browser-login',
      sourceProvider: 'github',
      providerCredentialId: 88,
      verification: 'pending',
    });
    expect(targetBrowserSessionMock.persistTargetSiteBrowserProfile).toHaveBeenCalledWith(
      'target-state-3',
      expect.stringContaining('/browser-profiles/accounts/new-api/'),
    );
    expect(response.json()).toMatchObject({
      tokenType: 'session',
      credentialMode: 'session',
      verificationPending: true,
    });
  });
});
