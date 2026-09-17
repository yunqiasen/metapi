import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    platformName: 'agentrouter',
    verifyToken: async () => ({ tokenType: 'unknown' }),
    getModels: async () => [],
  }),
  getAdapterForSite: () => ({
    platformName: 'agentrouter',
    verifyToken: async () => ({ tokenType: 'unknown' }),
    getModels: async () => [],
  }),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts checkin relogin config api', { timeout: 15_000 }, () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-checkin-relogin-'));
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
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  async function seedAgentRouterAccount() {
    const site = await db.insert(schema.sites).values({
      name: 'Agentrouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'github_166363',
      accessToken: 'session=old',
      status: 'active',
      extraConfig: JSON.stringify({ platformUserId: 166363 }),
    }).returning().get();
    return { site, account };
  }

  it('stores checkin relogin provider and cookie into extra config', async () => {
    const { account } = await seedAgentRouterAccount();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${account.id}`,
      payload: {
        checkinReloginProvider: 'github',
        checkinReloginCookie: 'user_session=gh-cookie',
      },
    });
    expect(response.statusCode).toBe(200);

    const row = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    const extraConfig = JSON.parse(row?.extraConfig || '{}');
    expect(extraConfig.checkinRelogin.provider).toBe('github');
    expect(extraConfig.checkinRelogin.cookie).toBe('user_session=gh-cookie');
    expect(extraConfig.platformUserId).toBe(166363);
  });

  it('normalizes a full third-party Cookie header and leaves the site session intact', async () => {
    const { account } = await seedAgentRouterAccount();
    const response = await app.inject({
      method: 'PUT', url: `/api/accounts/${account.id}`,
      payload: {
        checkinReloginProvider: 'linuxdo',
        checkinReloginCookie: 'Cookie: _forum_session=abc\n123==;\r\n _t=def%2B==; g_state={"i_l":0}',
      },
    });
    expect(response.statusCode).toBe(200);
    const row = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(row?.accessToken).toBe('session=old');
    expect(JSON.parse(row?.extraConfig || '{}')).toMatchObject({
      platformUserId: 166363,
      checkinRelogin: { provider: 'linuxdo', cookie: '_forum_session=abc123==; _t=def%2B==; g_state={"i_l":0}' },
    });
  });

  it('rejects invalid provider values', async () => {
    const { account } = await seedAgentRouterAccount();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${account.id}`,
      payload: { checkinReloginProvider: 'google' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('clears relogin config when provider or cookie is emptied', async () => {
    const { account } = await seedAgentRouterAccount();
    await app.inject({
      method: 'PUT',
      url: `/api/accounts/${account.id}`,
      payload: {
        checkinReloginProvider: 'linuxdo',
        checkinReloginCookie: 'ld-cookie',
      },
    });
    const cleared = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${account.id}`,
      payload: { checkinReloginProvider: null, checkinReloginCookie: null },
    });
    expect(cleared.statusCode).toBe(200);

    const row = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    const extraConfig = JSON.parse(row?.extraConfig || '{}');
    expect(extraConfig.checkinRelogin).toBeUndefined();
  });
});
