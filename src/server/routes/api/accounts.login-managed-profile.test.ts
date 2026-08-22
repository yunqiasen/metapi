import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loginMock = vi.fn();
const getApiTokenMock = vi.fn();
const getApiTokensMock = vi.fn();
const convergeAccountMutationMock = vi.fn();
const loginManagedAccountWithPasswordMock = vi.fn();
const persistManagedAccountBrowserProfileMock = vi.fn();
const discardManagedAccountBrowserProfileMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    login: (...args: unknown[]) => loginMock(...args),
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
  }),
}));

vi.mock('../../services/accountMutationWorkflow.js', () => ({
  convergeAccountMutation: (...args: unknown[]) => convergeAccountMutationMock(...args),
  rebuildRoutesBestEffort: vi.fn(),
}));

vi.mock('../../services/accountManagedBrowserLogin.js', () => ({
  isManagedBrowserLoginSite: (site: { platform?: unknown; url?: unknown }) => {
    const platform = String(site?.platform || '').toLowerCase();
    const url = String(site?.url || '').toLowerCase();
    return platform === 'anyrouter' || platform === 'agentrouter' || url.includes('anyrouter') || url.includes('agentrouter');
  },
  canUseManagedBrowserPasswordLogin: (site: { platform?: unknown; url?: unknown }) => {
    const platform = String(site?.platform || '').toLowerCase();
    const url = String(site?.url || '').toLowerCase();
    return platform === 'anyrouter' || platform === 'agentrouter' || platform === 'new-api' || url.includes('anyrouter') || url.includes('agentrouter');
  },
  resolveAccountBrowserProfileDir: (account: { id: number }, site: { platform?: unknown }) => `/tmp/browser-profiles/accounts/${String(site.platform || 'site')}/${account.id}`,
  loginManagedAccountWithPassword: (...args: unknown[]) => loginManagedAccountWithPasswordMock(...args),
  persistManagedAccountBrowserProfile: (...args: unknown[]) => persistManagedAccountBrowserProfileMock(...args),
  discardManagedAccountBrowserProfile: (...args: unknown[]) => discardManagedAccountBrowserProfileMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts password login stays protocol-only', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-login-protocol-only-'));
    process.env.DATA_DIR = dataDir;
    process.env.ACCOUNT_CREDENTIAL_SECRET = 'accounts-login-protocol-only-test-secret';

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    loginMock.mockReset();
    getApiTokenMock.mockReset();
    getApiTokensMock.mockReset();
    convergeAccountMutationMock.mockReset();
    loginManagedAccountWithPasswordMock.mockReset();
    persistManagedAccountBrowserProfileMock.mockReset();
    discardManagedAccountBrowserProfileMock.mockReset();
    delete process.env.METAPI_ACCOUNT_LOGIN_REQUEST_TIMEOUT_MS;
    delete process.env.METAPI_ACCOUNT_LOGIN_TOKEN_TIMEOUT_MS;

    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.ACCOUNT_CREDENTIAL_SECRET;
  });

  it('uses direct protocol login without starting a browser or saving a Profile', async () => {
    loginMock.mockResolvedValue({ success: true, accessToken: 'session=fresh; acw_tc=waf' });
    getApiTokenMock.mockResolvedValue('sk-any');
    getApiTokensMock.mockResolvedValue([{ name: 'default', key: 'sk-any', enabled: true }]);
    convergeAccountMutationMock.mockResolvedValue({});

    const site = await db.insert(schema.sites).values({
      name: 'AnyRouter',
      url: 'https://anyrouter.top',
      platform: 'anyrouter',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: { siteId: site.id, username: 'any@example.com', password: 'demo-password' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, apiTokenFound: true });
    expect(loginManagedAccountWithPasswordMock).not.toHaveBeenCalled();
    expect(persistManagedAccountBrowserProfileMock).not.toHaveBeenCalled();
    const account = await db.select().from(schema.accounts).get();
    expect(account?.accessToken).toBe('session=fresh; acw_tc=waf');
    const extraConfig = JSON.parse(account?.extraConfig || '{}');
    expect(extraConfig).toMatchObject({
      credentialMode: 'session',
      autoRelogin: { username: 'any@example.com' },
    });
    expect(extraConfig.managedBrowserProfile).toBeUndefined();
  });

  it('returns the protocol login failure without opening a browser', async () => {
    loginMock.mockResolvedValue({ success: false, message: 'shield challenge blocked login' });

    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: { siteId: site.id, username: 'yunqiasen', password: 'demo-password' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: false, shieldBlocked: true });
    expect(loginManagedAccountWithPasswordMock).not.toHaveBeenCalled();
    expect(persistManagedAccountBrowserProfileMock).not.toHaveBeenCalled();
    await expect(db.select().from(schema.accounts).all()).resolves.toHaveLength(0);
  });

  it('does not block account creation when optional API-token discovery stalls', async () => {
    process.env.METAPI_ACCOUNT_LOGIN_TOKEN_TIMEOUT_MS = '10';
    loginMock.mockResolvedValue({ success: true, accessToken: 'session=fresh' });
    getApiTokenMock.mockReturnValue(new Promise(() => {}));
    getApiTokensMock.mockReturnValue(new Promise(() => {}));
    convergeAccountMutationMock.mockResolvedValue({});

    const site = await db.insert(schema.sites).values({
      name: 'AnyRouter',
      url: 'https://anyrouter.top',
      platform: 'anyrouter',
    }).returning().get();
    const responsePromise = app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: { siteId: site.id, username: 'any@example.com', password: 'demo-password' },
    });
    const response = await Promise.race([
      responsePromise,
      new Promise<'test-timeout'>((resolve) => setTimeout(() => resolve('test-timeout'), 150)),
    ]);

    expect(response).not.toBe('test-timeout');
    if (response === 'test-timeout') return;
    expect(response.json()).toMatchObject({ success: true, apiTokenFound: false, queued: true });
    expect(loginManagedAccountWithPasswordMock).not.toHaveBeenCalled();
  });

  it('times out a stalled protocol login without falling back to a browser', async () => {
    process.env.METAPI_ACCOUNT_LOGIN_REQUEST_TIMEOUT_MS = '10';
    loginMock.mockReturnValue(new Promise(() => {}));

    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const responsePromise = app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: { siteId: site.id, username: 'yunqiasen', password: 'demo-password' },
    });
    const response = await Promise.race([
      responsePromise,
      new Promise<'test-timeout'>((resolve) => setTimeout(() => resolve('test-timeout'), 150)),
    ]);

    expect(response).not.toBe('test-timeout');
    if (response === 'test-timeout') return;
    expect(response.json()).toMatchObject({ success: false });
    expect(response.json().message).toContain('timed out');
    expect(loginManagedAccountWithPasswordMock).not.toHaveBeenCalled();
  });
});
