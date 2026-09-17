import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRouterAdapter } from './agentrouter.js';

const SLIDER = '<html><script src="https://o.alicdn.com/aliyunCaptcha.js"></script><div id="aliyun_waf_aa"></div></html>';

describe('AgentRouter management request budget', () => {
  let server: ReturnType<typeof createServer> | undefined;
  const requests: Array<{ path: string; id: string | undefined; cookie: string | undefined; authorization: string | undefined }> = [];
  async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    requests.length = 0;
    server = createServer((req, res) => {
      requests.push({ path: req.url || '/', id: req.headers['new-api-user'] as string | undefined, cookie: req.headers.cookie, authorization: req.headers.authorization });
      handler(req, res);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture address missing');
    return `http://127.0.0.1:${address.port}`;
  }
  afterEach(async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server = undefined; });

  it.each(['balance', 'models', 'tokens', 'verify', 'user', 'groups', 'create', 'delete'] as const)('stops %s on the first slider response without probing other user IDs', async method => {
    const url = await fixture((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(SLIDER); });
    const adapter = new AgentRouterAdapter();
    const call = () => method === 'balance' ? adapter.getBalance(url, 'session=fixture', 166363)
      : method === 'models' ? adapter.getModels(url, 'session=fixture', 166363)
      : method === 'tokens' ? adapter.getApiTokens(url, 'session=fixture', 166363)
      : method === 'user' ? adapter.getUserInfo(url, 'session=fixture', 166363)
      : method === 'groups' ? adapter.getUserGroups(url, 'session=fixture', 166363)
      : method === 'create' ? adapter.createApiToken(url, 'session=fixture', 166363)
      : method === 'delete' ? adapter.deleteApiToken(url, 'session=fixture', 'fixture-key', 166363)
      : adapter.verifyToken(url, 'session=fixture', 166363, 'session');
    await expect(call()).rejects.toThrow('阿里云滑块');
    expect(requests).toHaveLength(method === 'verify' ? 2 : 1);
    expect(requests[0].id).toBe('166363');
    expect(requests[0].authorization).toBeUndefined();
    // An immediate second click should use the path cooldown, not hit the same challenge again.
    await expect(call()).rejects.toThrow('阿里云滑块');
    expect(requests).toHaveLength(method === 'verify' ? 2 : 1);
  });

  it('treats a normal SPA as non-JSON rather than a slider', async () => {
    const url = await fixture((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><script type="module" src="/assets/index.js"></script><div id="root"></div></html>'); });
    await expect(new AgentRouterAdapter().verifyToken(url, 'session=fixture', 166363, 'session')).rejects.toThrow('非 JSON');
    expect(requests).toHaveLength(1);
  });

  it('keeps Session import and token discovery working without extra ID probes', async () => {
    const url = await fixture((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.startsWith('/api/token/')) res.end(JSON.stringify({ success: true, data: [] }));
      else res.end(JSON.stringify({ success: true, data: { id: 166363, username: 'github_fixture', quota: 1000000, used_quota: 500000 } }));
    });
    const result = await new AgentRouterAdapter().verifyToken(url, 'session=fixture', 166363, 'session');
    expect(result).toMatchObject({ tokenType: 'session', userInfo: { id: 166363 }, balance: { balance: 2, used: 1, quota: 3 }, apiToken: null });
    expect(requests.length).toBeLessThanOrEqual(2);
    expect(requests.every(r => r.id === '166363')).toBe(true);
  });

  it('checks an API key using Bearer models, without attaching a Session Cookie', async () => {
    const url = await fixture((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'model-1' }] })); });
    const result = await new AgentRouterAdapter().verifyToken(url, 'sk-fixture', undefined, 'apikey');
    expect(result).toMatchObject({ tokenType: 'apikey', models: ['model-1'] });
    expect(requests).toEqual([{ path: '/v1/models', id: undefined, cookie: undefined, authorization: 'Bearer sk-fixture' }]);
  });

  it('does not guess a different ID when the site rejects the supplied identity', async () => {
    const url = await fixture((_req, res) => { res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: false, message: 'New-Api-User does not match logged in user' })); });
    await expect(new AgentRouterAdapter().getBalance(url, 'session=fixture', 999)).rejects.toThrow('用户 ID');
    expect(requests).toHaveLength(1);
  });
  it('does not send an explicit Session to the model API during auto verification', async () => {
    const url = await fixture((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(SLIDER); });
    await expect(new AgentRouterAdapter().verifyToken(url, 'session=fixture', 166363)).rejects.toThrow('阿里云滑块');
    expect(requests).toHaveLength(2);
    expect(requests[0].path).toBe('/api/user/self');
    expect(requests.every(r => r.path !== '/v1/models')).toBe(true);
  });

  it('accepts a bare 48-character API key for model discovery, even with an account user ID', async () => {
    const url = await fixture((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'model-1' }] })); });
    expect(await new AgentRouterAdapter().getModels(url, 'a'.repeat(48), 166363)).toEqual(['model-1']);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ path: '/v1/models', cookie: undefined, authorization: `Bearer ${'a'.repeat(48)}` });
  });

  it('rejects a successful JSON response containing another user identity', async () => {
    const url = await fixture((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data: { id: 999, quota: 1, used_quota: 0 } })); });
    await expect(new AgentRouterAdapter().verifyToken(url, 'session=fixture', 166363, 'session')).rejects.toThrow('用户 ID');
    expect(requests).toHaveLength(1);
  });

  it('does not turn missing quota fields into a zero balance', async () => {
    const url = await fixture((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data: { id: 166363, username: 'fixture' } })); });
    await expect(new AgentRouterAdapter().getBalance(url, 'session=fixture', 166363)).rejects.toThrow('额度字段');
    expect(requests).toHaveLength(1);
  });

  it('honors Retry-After and lets requests resume after the cooldown', async () => {
    let limited = true;
    const url = await fixture((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (limited) { res.statusCode = 429; res.setHeader('Retry-After', '2'); res.end('{"message":"too many requests"}'); }
      else res.end(JSON.stringify({ success: true, data: { id: 166363, quota: 500000, used_quota: 0 } }));
    });
    const adapter = new AgentRouterAdapter();
    await expect(adapter.getBalance(url, 'session=fixture', 166363)).rejects.toThrow('限流');
    limited = false;
    await expect(adapter.getBalance(url, 'session=fixture', 166363)).rejects.toThrow('限流');
    expect(requests).toHaveLength(1);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 3_000);
    try { expect(await adapter.getBalance(url, 'session=fixture', 166363)).toMatchObject({ balance: 1 }); }
    finally { clock.mockRestore(); }
    expect(requests).toHaveLength(2);
  });

  it('serializes management calls sharing the same site without mixing account cookies', async () => {
    let active = 0;
    let peak = 0;
    const url = await fixture((req, res) => {
      active++; peak = Math.max(peak, active);
      setTimeout(() => { active--; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data: { id: Number(req.headers['new-api-user']), quota: 500000, used_quota: 0 } })); }, 15);
    });
    const adapter = new AgentRouterAdapter();
    await Promise.all([adapter.getBalance(url, 'session=first', 1), adapter.getBalance(url, 'session=second', 2)]);
    expect(peak).toBe(1);
    expect(requests.map(r => [r.id, r.cookie])).toEqual([['1', 'session=first'], ['2', 'session=second']]);
  });

  it('cancels the real HTTP request when its deadline expires, without continuing ID probes', async () => {
    let closed = false;
    const url = await fixture((_req, res) => { res.on('close', () => { closed = true; }); });
    const adapter = new AgentRouterAdapter({ requestTimeoutMs: 50 });
    await expect(adapter.getBalance(url, 'session=fixture', 166363)).rejects.toThrow('超时');
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(requests).toHaveLength(1);
  });

  it('distinguishes a malformed token response from an explicitly empty list', async () => {
    const url = await fixture((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data: {} })); });
    await expect(new AgentRouterAdapter().getApiTokens(url, 'session=fixture', 166363)).rejects.toThrow('令牌列表');
    expect(requests).toHaveLength(1);
  });

  it('still validates the Session if optional token discovery is challenged', async () => {
    const url = await fixture((req, res) => {
      if (req.url?.startsWith('/api/token')) { res.setHeader('Content-Type', 'text/html'); res.end(SLIDER); }
      else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data: { id: 166363, username: 'fixture', quota: 500000, used_quota: 0 } })); }
    });
    const result = await new AgentRouterAdapter().verifyToken(url, 'session=fixture', 166363, 'session');
    expect(result).toMatchObject({ tokenType: 'session', userInfo: { id: 166363 }, apiToken: null });
    expect(requests).toHaveLength(2);
  });

  it('leaves the API key endpoint available while the management endpoint is cooling down', async () => {
    const url = await fixture((req, res) => {
      if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'model-1' }] })); }
      else { res.setHeader('Content-Type', 'text/html'); res.end(SLIDER); }
    });
    const adapter = new AgentRouterAdapter();
    await expect(adapter.getBalance(url, 'session=fixture', 166363)).rejects.toThrow('阿里云滑块');
    expect(await adapter.getModels(url, 'sk-fixture')).toEqual(['model-1']);
    expect(requests).toHaveLength(2);
    expect(requests[1].cookie).toBeUndefined();
  });

  it('rejects boolean IDs instead of treating true as user 1', async () => {
    const url = await fixture((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data: { id: true, quota: 500000, used_quota: 0 } })); });
    await expect(new AgentRouterAdapter().getBalance(url, 'session=fixture', 1)).rejects.toThrow('用户 ID');
  });

  it('does not carry a path cooldown onto a different effective proxy route', async () => {
    let blocked = true;
    const url = await fixture((_req, res) => {
      if (blocked) res.end(SLIDER);
      else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data: { id: 166363, quota: 500000, used_quota: 0 } })); }
    });
    const adapter = new AgentRouterAdapter();
    await expect(adapter.getBalance(url, 'session=fixture', 166363)).rejects.toThrow('阿里云滑块');
    blocked = false;
    const proxy = await import('../siteProxy.js');
    // Network stays on the local fixture; only the effective routing identity changes.
    const route = vi.spyOn(proxy, 'resolveEffectiveSiteProxyUrlByRequestUrl').mockResolvedValue('http://route-fixture:7890');
    try { expect(await adapter.getBalance(url, 'session=fixture', 166363)).toMatchObject({ balance: 1 }); }
    finally { route.mockRestore(); }
    expect(requests).toHaveLength(2);
  });

  it('cancels a stalled response body as well as a stalled connection', async () => {
    let closed = false;
    const url = await fixture((_req, res) => {
      res.on('close', () => { closed = true; });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"success":');
    });
    await expect(new AgentRouterAdapter({ requestTimeoutMs: 50 }).getBalance(url, 'session=fixture', 166363)).rejects.toThrow('超时');
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(requests).toHaveLength(1);
  });

  it('expires queued calls without making a new request after the caller has timed out', async () => {
    const url = await fixture((_req, res) => { setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end('{"success":true}'); }, 50); });
    const { AgentRouterRequestClient } = await import('./agentRouterRequest.js');
    const client = new AgentRouterRequestClient(300);
    const first = client.json(`${url}/api/fixture`);
    const second = client.json(`${url}/api/fixture`, { signal: AbortSignal.timeout(10) });
    await expect(second).rejects.toThrow('超时');
    await first;
    expect(requests).toHaveLength(1);
    await client.json(`${url}/api/fixture`);
    expect(requests).toHaveLength(2);
  });

  it('imports a structured bare Session using its own ID hint, never a username-derived ID', async () => {
    const payload = Buffer.concat([Buffer.from('id'), Buffer.from([3]), Buffer.from('int'), Buffer.from([4, 3, 0, 255, 238])]).toString('base64');
    const session = Buffer.from(`1780000000|${payload}|fixture-signature`).toString('base64');
    const url = await fixture((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.startsWith('/api/token')) res.end('{"success":true,"data":[]}');
      else res.end('{"success":true,"data":{"id":119,"username":"linuxdo_59260","quota":500000,"used_quota":0}}');
    });
    expect(await new AgentRouterAdapter().verifyToken(url, session, undefined, 'session')).toMatchObject({ tokenType: 'session', userInfo: { id: 119, username: 'linuxdo_59260' } });
    expect(requests.every(r => r.id === '119' && r.cookie === `session=${session}`)).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it('keeps token discovery, creation, deletion and group parsing compatible on the Session transport', async () => {
    const mutations: Array<{ method: string; path: string }> = [];
    const url = await fixture((req, res) => {
      expect(req.headers.cookie).toBe('session=fixture');
      expect(req.headers['new-api-user']).toBe('166363');
      expect(req.headers.authorization).toBeUndefined();
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url?.startsWith('/api/token/')) {
        res.end(JSON.stringify({ success: true, data: { items: [{ id: 9, key: 'enabled-key', name: 'main', status: 1, group: 'premium' }] } }));
      } else if (req.url === '/api/user/self/groups') res.end('{"success":true,"data":{"default":1,"premium":2}}');
      else { mutations.push({ method: req.method || '', path: req.url || '' }); res.end('{"success":true}'); }
    });
    const adapter = new AgentRouterAdapter();
    expect(await adapter.getApiTokens(url, 'session=fixture', 166363)).toEqual([{ name: 'main', key: 'enabled-key', enabled: true, tokenGroup: 'premium' }]);
    expect(await adapter.getUserGroups(url, 'session=fixture', 166363)).toEqual(['default', 'premium']);
    expect(await adapter.createApiToken(url, 'session=fixture', 166363, { name: 'fixture' })).toBe(true);
    expect(await adapter.deleteApiToken(url, 'session=fixture', 'enabled-key', 166363)).toBe(true);
    expect(mutations).toEqual([{ method: 'POST', path: '/api/token/' }, { method: 'DELETE', path: '/api/token/9' }]);
    expect(requests).toHaveLength(5);
  });

  it('verifies a Session using token ownership when only the self endpoint is challenged, without fabricating balance', async () => {
    const url = await fixture((req, res) => {
      if (req.url === '/api/user/self') { res.setHeader('Content-Type', 'text/html'); res.end(SLIDER); }
      else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data: { items: [{ id: 1, user_id: 59260, key: 'site-api-key', status: 1, name: 'default' }] } })); }
    });
    const adapter = new AgentRouterAdapter();
    const result = await adapter.verifyToken(url, 'session=fixture', 59260, 'session');
    expect(result).toMatchObject({ tokenType: 'session', userInfo: { id: 59260 }, balance: null, apiToken: 'site-api-key' });
    expect(requests).toHaveLength(2);
    expect(requests.every(r => r.id === '59260' && r.cookie === 'session=fixture')).toBe(true);
  });

  it('rejects token ownership from another account when self is challenged', async () => {
    const url = await fixture((req, res) => {
      if (req.url === '/api/user/self') res.end(SLIDER);
      else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data: [{ user_id: 999, key: 'other-key' }] })); }
    });
    await expect(new AgentRouterAdapter().verifyToken(url, 'session=fixture', 59260, 'session')).rejects.toThrow('用户 ID');
    expect(requests).toHaveLength(2);
  });

  it('does not consider an empty token list proof of identity after self was challenged', async () => {
    const url = await fixture((req, res) => {
      if (req.url === '/api/user/self') res.end(SLIDER);
      else { res.setHeader('Content-Type', 'application/json'); res.end('{"success":true,"data":[]}'); }
    });
    await expect(new AgentRouterAdapter().verifyToken(url, 'session=fixture', 59260, 'session')).rejects.toThrow('阿里云滑块');
    expect(requests).toHaveLength(2);
  });

  it('reuses the configured /v1 API endpoint without adding a second /v1 segment', async () => {
    const url = await fixture((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url !== '/v1/models') { res.statusCode = 404; res.end('{"error":{"message":"not found"}}'); }
      else res.end('{"data":[{"id":"model-1"}]}');
    });
    expect(await new AgentRouterAdapter().getModels(`${url}/v1/`, 'a'.repeat(48), 166363)).toEqual(['model-1']);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/v1/models');
  });

  it('resolves Session management models against the site root instead of /v1/api', async () => {
    const url = await fixture((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url !== '/api/user/models') { res.statusCode = 404; res.end('{"success":false}'); }
      else res.end('{"success":true,"data":["model-1"]}');
    });
    expect(await new AgentRouterAdapter().getModels(`${url}/v1`, 'session=fixture', 166363)).toEqual(['model-1']);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/api/user/models');
  });

});
