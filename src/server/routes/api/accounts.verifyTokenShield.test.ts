import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetRequestRateLimitStore } from '../../middleware/requestRateLimit.js';

const verifyTokenMock = vi.fn();
const undiciFetchMock = vi.fn();
let adapterPlatformName = 'new-api';

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    platformName: adapterPlatformName,
    verificationDiagnostics: adapterPlatformName === 'agentrouter' ? 'adapter' : undefined,
    verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
  }),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => undiciFetchMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts verify-token shield detection', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-verify-shield-'));
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
    undiciFetchMock.mockReset();
    adapterPlatformName = 'new-api';
    resetRequestRateLimitStore();

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

  it('passes the explicit credential mode into adapter verification', async () => {
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'session', userInfo: { username: 'fixture-user' } });

    const site = await db.insert(schema.sites).values({
      name: 'Session Mode Site',
      url: 'https://session-mode.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      payload: {
        siteId: site.id,
        accessToken: 'session-token',
        platformUserId: 200029,
        credentialMode: 'session',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, tokenType: 'session' });
    expect(verifyTokenMock).toHaveBeenCalledWith(
      site.url,
      'session-token',
      200029,
      'session',
    );
  });

  it('returns rebind hint when verify-token reports invalid access token', async () => {
    verifyTokenMock.mockRejectedValueOnce(new Error('invalid access token'));

    const site = await db.insert(schema.sites).values({
      name: 'AnyRouter',
      url: 'https://anyrouter.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      payload: {
        siteId: site.id,
        accessToken: 'session-or-cookie-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'invalid access token，请在中转站重新生成系统访问令牌后重新绑定账号',
    });
  });

  it('rate limits repeated verify-token attempts from the same client ip', async () => {
    verifyTokenMock.mockRejectedValue(new Error('invalid access token'));

    const site = await db.insert(schema.sites).values({
      name: 'AnyRouter',
      url: 'https://anyrouter.example.com',
      platform: 'new-api',
    }).returning().get();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/accounts/verify-token',
        remoteAddress: '198.51.100.11',
        payload: {
          siteId: site.id,
          accessToken: 'session-or-cookie-token',
        },
      });
      expect(response.statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      remoteAddress: '198.51.100.11',
      payload: {
        siteId: site.id,
        accessToken: 'session-or-cookie-token',
      },
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      success: false,
      message: '请求过于频繁，请稍后再试',
    });
  });

  it('avoids raw shieldBlocked misclassification for new-api when verifyToken returned tokenType unknown', async () => {
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'unknown' });
    undiciFetchMock.mockResolvedValue({
      text: async () => '<html><script>var arg1="ABC123";</script></html>',
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
      },
    });

    const site = await db.insert(schema.sites).values({
      name: 'AnyRouter',
      url: 'https://anyrouter.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      payload: {
        siteId: site.id,
        accessToken: 'session-or-cookie-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Token invalid: cannot use it as session cookie or API key',
    });
    expect(undiciFetchMock).toHaveBeenCalled();
  });

  it('uses adapter platformName to skip raw shield detection for newapi alias site platform', async () => {
    adapterPlatformName = 'new-api';
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'unknown' });
    undiciFetchMock.mockResolvedValue({
      text: async () => '<html><script>var arg1="ABC123";</script></html>',
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
      },
    });

    const site = await db.insert(schema.sites).values({
      name: 'AnyRouter Alias',
      url: 'https://anyrouter-alias.example.com',
      platform: 'newapi',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      payload: {
        siteId: site.id,
        accessToken: 'session-or-cookie-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Token invalid: cannot use it as session cookie or API key',
    });
    expect(response.json()).not.toMatchObject({
      shieldBlocked: true,
    });
    expect(undiciFetchMock).toHaveBeenCalled();
  });

  it('still returns shieldBlocked for non-new-api platforms when challenge html is detected', async () => {
    adapterPlatformName = 'one-api';
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'unknown' });
    undiciFetchMock.mockResolvedValue({
      text: async () => '<html><script>var arg1="ABC123";</script></html>',
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
      },
    });

    const site = await db.insert(schema.sites).values({
      name: 'Legacy Shielded',
      url: 'https://legacy-shield.example.com',
      platform: 'one-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      payload: {
        siteId: site.id,
        accessToken: 'session-or-cookie-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: false,
      shieldBlocked: true,
    });
    expect(undiciFetchMock).toHaveBeenCalled();
  });

  it('falls back to needsUserId diagnosis when verifyToken hangs', async () => {
    vi.useFakeTimers();
    verifyTokenMock.mockImplementationOnce(() => new Promise(() => {}));
    undiciFetchMock.mockResolvedValue({
      text: async () => JSON.stringify({ success: false, message: 'missing New-Api-User' }),
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null),
      },
    });

    const site = await db.insert(schema.sites).values({
      name: 'Needs User Id',
      url: 'https://needs-user-id.example.com',
      platform: 'new-api',
    }).returning().get();

    const responsePromise = app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      payload: {
        siteId: site.id,
        accessToken: 'slow-session-token',
      },
    });

    await vi.advanceTimersByTimeAsync(10_100);
    const response = await responsePromise;

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: false,
      needsUserId: true,
    });
    expect(undiciFetchMock).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('short-circuits to needsUserId before heavy verification when probe already confirms it', async () => {
    verifyTokenMock.mockResolvedValueOnce({
      tokenType: 'session',
      userInfo: { username: 'should-not-run' },
      balance: null,
      apiToken: null,
    });
    undiciFetchMock.mockResolvedValue({
      text: async () => JSON.stringify({ success: false, message: 'missing New-Api-User' }),
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null),
      },
    });

    const site = await db.insert(schema.sites).values({
      name: 'Needs User Id Fast',
      url: 'https://needs-user-id-fast.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      payload: {
        siteId: site.id,
        accessToken: 'token-without-user-id',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: false,
      needsUserId: true,
    });
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });

  it('returns invalidUserId when the provided user id does not match the token', async () => {
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'unknown' });
    undiciFetchMock.mockResolvedValue({
      text: async () => JSON.stringify({ success: false, message: 'user id mismatch' }),
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null),
      },
    });

    const site = await db.insert(schema.sites).values({
      name: 'Wrong User Id',
      url: 'https://wrong-user-id.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      payload: {
        siteId: site.id,
        accessToken: 'token-with-wrong-user-id',
        platformUserId: 2,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: false,
      invalidUserId: true,
    });
    expect(response.json()).not.toMatchObject({
      needsUserId: true,
    });
    expect(undiciFetchMock).toHaveBeenCalled();
  });
  it.each([
    ['shield', 'AgentRouter 返回阿里云滑块验证页（HTTP 200），未判定 Session 失效', { shieldBlocked: true }],
    ['invalid-user-id', 'AgentRouter 用户 ID 与当前 Session 不匹配', { invalidUserId: true }],
    ['needs-user-id', 'AgentRouter 需要站点用户 ID', { needsUserId: true }],
    ['non-json', 'AgentRouter 接口返回非 JSON 响应（HTTP 403）', {}],
    ['timeout', 'AgentRouter request timeout', {}],
  ] as const)('surfaces Agent adapter %s diagnostics without sending secondary credential probes', async (kind, message, flags) => {
    adapterPlatformName = 'agentrouter';
    const { AgentRouterRequestError } = await import('../../services/platforms/agentRouterRequest.js');
    verifyTokenMock.mockRejectedValueOnce(new AgentRouterRequestError(message, kind, 200));
    const site = await db.insert(schema.sites).values({ name: 'Agent Fixture', url: 'https://agent-fixture.example.com', platform: 'agentrouter' }).returning().get();
    const response = await app.inject({ method: 'POST', url: '/api/accounts/verify-token', payload: { siteId: site.id, accessToken: 'session=fixture', platformUserId: 59260, credentialMode: 'session' } });
    expect(response.json()).toMatchObject({ success: false, message, reasonCode: kind, ...flags });
    expect(undiciFetchMock).not.toHaveBeenCalled();
    if (kind !== 'shield') expect(response.json().shieldBlocked).toBeUndefined();
  });

  it('does not classify a normal SPA as a shield challenge for legacy adapters', async () => {
    adapterPlatformName = 'one-api';
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'unknown' });
    undiciFetchMock.mockResolvedValue({ text: async () => '<html><script type="module" src="/assets/index.js"></script><div id="root"></div></html>', headers: { get: () => 'text/html' } });
    const site = await db.insert(schema.sites).values({ name: 'SPA Fixture', url: 'https://spa-fixture.example.com', platform: 'one-api' }).returning().get();
    const response = await app.inject({ method: 'POST', url: '/api/accounts/verify-token', payload: { siteId: site.id, accessToken: 'session=fixture', platformUserId: 59260 } });
    expect(response.json().success).toBe(false);
    expect(response.json().shieldBlocked).toBeUndefined();
  });

});
