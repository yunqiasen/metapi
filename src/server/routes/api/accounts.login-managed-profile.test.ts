import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loginMock = vi.fn();
const getApiTokenMock = vi.fn();
const getApiTokensMock = vi.fn();
const convergeAccountMutationMock = vi.fn();

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

type DbModule = typeof import('../../db/index.js');

describe('accounts login managed browser profile', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-login-managed-profile-'));
    process.env.DATA_DIR = dataDir;
    process.env.ACCOUNT_CREDENTIAL_SECRET = 'accounts-login-managed-profile-test-secret';

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

  it('marks AnyRouter password-created accounts for managed browser profile maintenance', async () => {
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
      payload: {
        siteId: site.id,
        username: 'any@example.com',
        password: 'demo-password',
      },
    });

    expect(response.statusCode).toBe(200);
    const account = await db.select().from(schema.accounts).get();
    const extraConfig = JSON.parse(account?.extraConfig || '{}');
    expect(extraConfig).toMatchObject({
      credentialMode: 'session',
      managedBrowserProfile: {
        enabled: true,
        provider: 'anyrouter',
        createdFrom: 'account-password-login',
      },
    });
    expect(extraConfig.managedBrowserProfile.profileDir).toContain('browser-profiles/accounts/anyrouter');
  });
});
