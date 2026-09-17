import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const verifyTokenMock = vi.fn();
const getApiTokensMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
  }),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts add requires token verification success', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-add-requires-verify-'));
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
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('passes session credential mode through when binding a verified session', async () => {
    verifyTokenMock.mockResolvedValueOnce({
      tokenType: 'session',
      userInfo: { username: 'fixture-user' },
    });

    const site = await db.insert(schema.sites).values({
      name: 'Session Site',
      url: 'https://session.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'session-token',
        platformUserId: 200029,
        credentialMode: 'session',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(verifyTokenMock).toHaveBeenCalledWith(
      site.url,
      'session-token',
      200029,
      'session',
    );
  });

  it('verifies and stores the same normalized pasted Cookie without creating a browser profile', async () => {
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'session', userInfo: { username: 'fixture-user' } });
    const site = await db.insert(schema.sites).values({
      name: 'Any Fixture', url: 'https://any.example.com', platform: 'anyrouter',
    }).returning().get();
    const response = await app.inject({
      method: 'POST', url: '/api/accounts',
      payload: {
        siteId: site.id, accessToken: 'Cookie: session=abc\n123==;\n acw_tc=shield',
        platformUserId: 7788, credentialMode: 'session', skipModelFetch: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(verifyTokenMock).toHaveBeenCalledWith(site.url, 'session=abc123==; acw_tc=shield', 7788, 'session');
    const saved = (await db.select().from(schema.accounts).all())[0];
    expect(saved.accessToken).toBe('session=abc123==; acw_tc=shield');
    expect(JSON.parse(saved.extraConfig || '{}')).toMatchObject({ platformUserId: 7788, credentialMode: 'session' });
    expect(JSON.parse(saved.extraConfig || '{}').managedBrowserProfile).toBeUndefined();
  });

  it('persists the verified upstream ID instead of digits from a numeric username', async () => {
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'session', userInfo: { id: 83033, username: '875133228' } });
    const site = await db.insert(schema.sites).values({ name: 'NewAPI', url: 'https://newapi.example.com', platform: 'new-api' }).returning().get();
    const response = await app.inject({ method: 'POST', url: '/api/accounts', payload: {
      siteId: site.id, accessToken: 'session=fixture', credentialMode: 'session', skipModelFetch: true,
    } });
    expect(response.statusCode).toBe(200);
    const saved = (await db.select().from(schema.accounts).all())[0];
    expect(JSON.parse(saved.extraConfig || '{}').platformUserId).toBe(83033);
  });

  it('rejects binding when token verification is not successful', async () => {
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'unknown' });

    const site = await db.insert(schema.sites).values({
      name: 'Verify Site',
      url: 'https://verify.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'invalid-token',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
    });
    expect(await db.select().from(schema.accounts).all()).toHaveLength(0);
  });

  it('returns rebind hint when token verify reports invalid access token', async () => {
    verifyTokenMock.mockRejectedValueOnce(new Error('无权进行此操作，access token 无效'));

    const site = await db.insert(schema.sites).values({
      name: 'Verify Site',
      url: 'https://verify.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'invalid-token',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: '无权进行此操作，access token 无效，请在中转站重新生成系统访问令牌后重新绑定账号',
    });
    expect(await db.select().from(schema.accounts).all()).toHaveLength(0);
  });

  it('allows binding when token verification succeeds as api key', async () => {
    verifyTokenMock.mockResolvedValueOnce({
      tokenType: 'apikey',
      models: ['gpt-4o-mini'],
    });

    const site = await db.insert(schema.sites).values({
      name: 'API Key Site',
      url: 'https://apikey.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-valid-key',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { tokenType?: string; apiTokenFound?: boolean };
    expect(body.tokenType).toBe('apikey');
    expect(body.apiTokenFound).toBe(true);

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect((accounts[0]?.apiToken || '').startsWith('sk-')).toBe(true);
  });
});
