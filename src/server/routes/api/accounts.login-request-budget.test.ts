import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loginMock = vi.fn();
const getApiTokenMock = vi.fn();
const getApiTokensMock = vi.fn();
const getBalanceMock = vi.fn();
const convergeAccountMutationMock = vi.fn();
let adapterPlatformName = 'anyrouter';

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    platformName: adapterPlatformName,
    login: (...args: unknown[]) => loginMock(...args),
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
    getBalance: (...args: unknown[]) => getBalanceMock(...args),
  }),
}));

vi.mock('../../services/accountMutationWorkflow.js', () => ({
  convergeAccountMutation: (...args: unknown[]) => convergeAccountMutationMock(...args),
  rebuildRoutesBestEffort: vi.fn(),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts login upstream request budget', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-login-budget-'));
    process.env.DATA_DIR = dataDir;
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
    getBalanceMock.mockReset();
    convergeAccountMutationMock.mockReset();
    adapterPlatformName = 'anyrouter';
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('avoids duplicate token fetch and immediate balance/model bursts for anyrouter login', async () => {
    loginMock.mockResolvedValue({
      success: true,
      accessToken: 'session-token',
      platformUserId: 200030,
      balance: { balance: 0, used: 0, quota: 0 },
    });
    getApiTokenMock.mockResolvedValue('duplicate-api-key');
    getBalanceMock.mockResolvedValue({ balance: 1550, used: 0, quota: 1550 });
    getApiTokensMock.mockResolvedValue([{ name: 'default', key: 'api-key', enabled: true }]);
    convergeAccountMutationMock.mockResolvedValue(undefined);

    const site = await db.insert(schema.sites).values({
      name: 'Any',
      url: 'https://anyrouter.example.com',
      platform: 'anyrouter',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: { siteId: site.id, username: 'fixture-user', password: 'fixture-password' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, apiTokenFound: true });
    expect(getApiTokenMock).not.toHaveBeenCalled();
    expect(getBalanceMock).toHaveBeenCalledWith(
      'https://anyrouter.example.com',
      'session-token',
      200030,
    );
    expect(getApiTokensMock).toHaveBeenCalledWith(
      'https://anyrouter.example.com',
      'session-token',
      200030,
    );
    const account = await db.select().from(schema.accounts).get();
    expect(JSON.parse(account?.extraConfig || '{}').platformUserId).toBe(200030);
    expect(account?.balance).toBe(1550);
    expect(convergeAccountMutationMock).toHaveBeenCalledWith(expect.objectContaining({
      refreshBalance: false,
      refreshModels: false,
      rebuildRoutes: true,
    }));
  });
});
