import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { AnyRouterAdapter } from './anyrouter.js';

const CHALLENGE_HTML = readFileSync(new URL('./__fixtures__/anyrouter-challenge.html', import.meta.url), 'utf8');
const SOLVED_ACW = '699dbedad126579b6bc0ebb91eaae8d7af3548b5';
const SESSION = 'session=account-119; acw_tc=old-browser-route; cdn_sec_tc=old-browser-cdn; acw_sc__v2=old-browser-challenge';
type FixtureOptions = {
  session?: string; transientRead?: boolean; slowRead?: boolean; signInAppliedThen502?: boolean;
  reward?: number; usedDuringCheckin?: number; alreadyCheckedIn?: boolean;
  userId?: number; userIdAfter?: number; missingQuota?: boolean;
  expired?: boolean; rateLimit?: boolean; nonJson?: boolean; signInNonJson?: boolean;
};

describe('AnyRouter protocol checkin', () => {
  let server: ReturnType<typeof createServer> | undefined;
  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  async function fixture(options: FixtureOptions = {}) {
    let balance = 100, used = 0, signed = false, readCount = 0;
    const requests: Array<{ path: string; method: string; cookie: string }> = [];
    const json = (res: ServerResponse, status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
    };
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const cookie = String(req.headers.cookie || ''), path = req.url || '/';
      requests.push({ path, method: req.method || 'GET', cookie });
      const routeReady = cookie.includes('acw_tc=fresh-route')
        && cookie.includes('cdn_sec_tc=fresh-cdn') && cookie.includes(`acw_sc__v2=${SOLVED_ACW}`);
      if (path === '/login') {
        if (routeReady) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><title>AnyRouter</title></html>');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': [
            'acw_tc=fresh-route; Path=/; HttpOnly', 'cdn_sec_tc=fresh-cdn; Path=/; HttpOnly',
          ] });
          res.end(CHALLENGE_HTML);
        }
        return;
      }
      if (!routeReady) {
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(CHALLENGE_HTML); return;
      }
      if (options.rateLimit) {
        res.writeHead(403, { 'Content-Type': 'text/html', 'Retry-After': '120' });
        res.end('<html><title>403 Forbidden</title>Denied by http_ratelimit</html>'); return;
      }
      if (options.nonJson) {
        res.writeHead(502, { 'Content-Type': 'text/html' }); res.end('<html>gateway unavailable</html>'); return;
      }
      if (options.expired || !cookie.includes(`session=${options.session || 'account-119'}`) || req.headers['new-api-user'] !== '119') {
        json(res, 401, { success: false, message: 'session expired' }); return;
      }
      if (path === '/api/user/self') {
        readCount++;
        if (readCount === 1 && options.transientRead) { res.writeHead(502); res.end('<html>Bad Gateway</html>'); return; }
        if (readCount === 1 && options.slowRead) return;

        json(res, 200, { success: true, data: {
          id: signed ? (options.userIdAfter ?? options.userId ?? 119) : (options.userId ?? 119),
          username: 'test-user', ...(options.missingQuota ? {} : { quota: balance * 500000 }), used_quota: used * 500000,
        } }); return;
      }
      if (path === '/api/user/sign_in' && req.method === 'POST') {
        signed = true;
        if (options.signInNonJson) {
          res.writeHead(502, { 'Content-Type': 'text/html' }); res.end('<html>gateway unavailable</html>'); return;
        }
        balance += (options.reward ?? 25) - (options.usedDuringCheckin ?? 0);
        used += options.usedDuringCheckin ?? 0;
        if (options.signInAppliedThen502) { res.writeHead(502); res.end('<html>Bad Gateway</html>'); return; }
        json(res, 200, options.alreadyCheckedIn ? { success: false, message: '今日已签到' } : { success: true, message: '签到成功', data: { reward: 999 } });
        return;
      }
      json(res, 404, { success: false, message: `Invalid URL (${req.method} ${path})` });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    return { url: `http://127.0.0.1:${address.port}`, requests };
  }

  it('renews route cookies without replacing the imported account Session and verifies the quota increase', async () => {
    const { url, requests } = await fixture();
    const result = await new AnyRouterAdapter().checkin(url, SESSION, 119);
    expect(result.success, result.message).toBe(true);
    expect(result.reward).toBe('25');
    expect(result.balanceInfo?.quota).toBe(125);
    expect(requests[0]).toMatchObject({ path: '/login', method: 'GET' });
    expect(requests.filter((r) => r.path === '/api/user/sign_in')).toHaveLength(1);
    expect(requests.some((r) => r.path === '/api/user/checkin')).toBe(false);
    expect(requests.some((r) => r.cookie.includes('old-browser-'))).toBe(false);
  });

  it('recovers an omitted user ID from the Session id field, not a username suffix', async () => {
    const payload = Buffer.concat([
      Buffer.from('username_linuxdo_9999'),
      Buffer.from('id'), Buffer.from([3]), Buffer.from('int'),
      Buffer.from([4, 3, 0, 255, 238]), // Gob signed integer 119
    ]).toString('base64');
    const session = Buffer.from(`1780000000|${payload}|fixture-signature`).toString('base64');
    const { url, requests } = await fixture({ session });
    const adapter = new AnyRouterAdapter();
    expect(await adapter.getBalance(url, `session=${session}`)).toMatchObject({ quota: 100 });
    const result = await adapter.checkin(url, `session=${session}`);
    expect(result, result.message).toMatchObject({ success: true, reward: '25' });
    expect(requests.filter((r) => r.path === '/api/user/sign_in')).toHaveLength(1);
  });

  it('preserves an explicit ID mismatch instead of silently switching to the Session user', async () => {
    const payload = Buffer.concat([
      Buffer.from('id'), Buffer.from([3]), Buffer.from('int'), Buffer.from([4, 3, 0, 255, 238]),
    ]).toString('base64');
    const session = Buffer.from(`1780000000|${payload}|fixture-signature`).toString('base64');
    const { url, requests } = await fixture({ session });
    const result = await new AnyRouterAdapter().checkin(url, `session=${session}`, 999);
    expect(result.success).toBe(false);
    expect(requests.filter((r) => r.path === '/api/user/sign_in')).toHaveLength(0);
    expect(requests.filter((r) => r.path === '/api/user/self')).toHaveLength(1);
  });

  it('retries an idempotent quota read after a transient gateway error', async () => {
    const { url, requests } = await fixture({ transientRead: true, reward: 0 });
    const result = await new AnyRouterAdapter().checkin(url, SESSION, 119);
    expect(result, result.message).toMatchObject({ quotaUnchanged: true, reward: '0' });
    expect(requests.filter(x => x.path === '/api/user/self')).toHaveLength(3);
    expect(requests.filter(x => x.path === '/api/user/sign_in')).toHaveLength(1);
  });

  it('recovers from a stalled read without exhausting the entire checkin budget', async () => {
    const { url } = await fixture({ slowRead: true, reward: 0 });
    const adapter = new AnyRouterAdapter();
    Object.defineProperty(adapter, 'requestTimeoutMs', { value: 50 });
    const start = Date.now();
    const result = await adapter.checkin(url, SESSION, 119);
    expect(result, result.message).toMatchObject({ quotaUnchanged: true, reward: '0' });
    expect(Date.now() - start).toBeLessThan(1500);
  }, 2000);

  it('reconciles quota after an ambiguous POST without replaying the sign-in', async () => {
    const { url, requests } = await fixture({ signInAppliedThen502: true });
    const result = await new AnyRouterAdapter().checkin(url, SESSION, 119);
    expect(result, result.message).toMatchObject({ success: true, reward: '25' });
    expect(requests.filter(x => x.path === '/api/user/sign_in')).toHaveLength(1);
    expect(requests.filter(x => x.path === '/api/user/self')).toHaveLength(2);
  });

  it('does not count a successful response or advertised reward when total quota did not increase', async () => {
    const { url } = await fixture({ reward: 0 });
    const result = await new AnyRouterAdapter().checkin(url, SESSION, 119);
    expect(result).toMatchObject({ success: false, reward: '0', quotaUnchanged: true });
    expect(result.message).toContain('额度无新增');
  });

  it('uses total quota rather than remaining balance when there is concurrent spending', async () => {
    const { url } = await fixture({ usedDuringCheckin: 10 });
    const result = await new AnyRouterAdapter().checkin(url, SESSION, 119);
    expect(result).toMatchObject({ success: true, reward: '25', balanceInfo: { balance: 115, used: 10, quota: 125 } });
  });

  it('marks an explicit already-checked-in response with zero new reward', async () => {
    const { url } = await fixture({ alreadyCheckedIn: true, reward: 0 });
    const result = await new AnyRouterAdapter().checkin(url, SESSION, 119);
    expect(result).toMatchObject({ success: false, alreadyCheckedIn: true, quotaUnchanged: true, reward: '0' });
  });

  it('stops before the sign-in POST if the existing session belongs to a different user', async () => {
    const { url, requests } = await fixture({ userId: 999 });
    const result = await new AnyRouterAdapter().checkin(url, SESSION, 119);
    expect(result.success).toBe(false);
    expect(result.message).toContain('用户 ID 不匹配');
    expect(requests.some((r) => r.path === '/api/user/sign_in')).toBe(false);
  });

  it('does not attribute another user quota to the imported account after sign-in', async () => {
    const { url } = await fixture({ userIdAfter: 999 });
    const result = await new AnyRouterAdapter().checkin(url, SESSION, 119);
    expect(result.success).toBe(false);
    expect(result.balanceInfo).toBeUndefined();
    expect(result.message).toContain('用户 ID 不匹配');
  });

  it('requires an authoritative quota snapshot before submitting sign-in', async () => {
    const { url, requests } = await fixture({ missingQuota: true });
    const result = await new AnyRouterAdapter().checkin(url, SESSION, 119);
    expect(result.success).toBe(false);
    expect(result.message).toContain('额度字段');
    expect(requests.some((r) => r.path === '/api/user/sign_in')).toBe(false);
  });

  it('does not try other user IDs or sign in with an expired session', async () => {
    const { url, requests } = await fixture({ expired: true });
    const result = await new AnyRouterAdapter().checkin(url, SESSION, 119);
    expect(result.success).toBe(false);
    expect(result.message).toContain('session expired');
    expect(requests.filter((r) => r.path.startsWith('/api/'))).toHaveLength(1);
  });

  it('recognizes ESA rate limiting and stops subsequent checks on that route during Retry-After', async () => {
    const { url, requests } = await fixture({ rateLimit: true });
    const adapter = new AnyRouterAdapter();
    const first = await adapter.checkin(url, SESSION, 119);
    const count = requests.length;
    const second = await adapter.checkin(url, SESSION, 119);
    expect(first.success).toBe(false);
    expect(first.message).toContain('限流');
    expect(second.message).toContain('限流');
    expect(requests).toHaveLength(count);
    expect(requests.filter((r) => r.path.startsWith('/api/'))).toHaveLength(1);
  });

  it('keeps gateway HTML errors separate from credential or Cloudflare failures', async () => {
    const { url } = await fixture({ nonJson: true });
    const result = await new AnyRouterAdapter().checkin(url, SESSION, 119);
    expect(result.success).toBe(false);
    expect(result.message).toContain('HTTP 502');
    expect(result.message).not.toMatch(/Unexpected token|Cloudflare|expired/i);
  });

  it('does not repeat a sign-in POST when its response is ambiguous', async () => {
    const { url, requests } = await fixture({ signInNonJson: true });
    const result = await new AnyRouterAdapter().checkin(url, SESSION, 119);
    expect(result.success).toBe(false);
    expect(requests.filter((r) => r.path === '/api/user/sign_in')).toHaveLength(1);
  });

  it('uses the same minimal session path for balance refresh and credential import', async () => {
    const { url, requests } = await fixture();
    const adapter = new AnyRouterAdapter();
    expect(await adapter.getBalance(url, SESSION, 119)).toMatchObject({ balance: 100, quota: 100 });
    expect(await adapter.getUserInfo(url, SESSION, 119)).toMatchObject({ username: 'test-user' });
    expect(requests.filter((r) => r.path === '/api/user/self')).toHaveLength(2);
    expect(requests.some((r) => r.cookie.includes('old-browser-'))).toBe(false);
  });
});
