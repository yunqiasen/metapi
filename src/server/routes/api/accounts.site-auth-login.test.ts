import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const externalAuthLoginMock = vi.fn();
const verifyTokenMock = vi.fn();
const getApiTokensMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    platformName: 'new-api',
    externalAuthLogin: (...args: unknown[]) => externalAuthLoginMock(...args),
    verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
  }),
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
    verifyTokenMock.mockReset();
    getApiTokensMock.mockReset();
    getApiTokensMock.mockResolvedValue([]);

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
});
