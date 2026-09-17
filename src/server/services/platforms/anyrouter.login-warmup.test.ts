import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AnyRouterAdapter } from './anyrouter.js';

const CHALLENGE_HTML = readFileSync(
  new URL('./__fixtures__/anyrouter-challenge.html', import.meta.url),
  'utf8',
);
const SOLVED_ACW = '699dbedad126579b6bc0ebb91eaae8d7af3548b5';
const WARMUP_ACW_TC = 'warmup-acw-tc';
const USERNAME = 'warmup-user';
const PASSWORD = 'warmup-pass';

describe('AnyRouter login warmup', () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it('warms the login page before posting credentials on an unprimed WAF route', async () => {
    const requests: Array<{ method: string; url: string; cookie: string }> = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const cookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
      requests.push({ method: req.method || 'GET', url: req.url || '/', cookie });

      if (req.url === '/login' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': `acw_tc=${WARMUP_ACW_TC}; Path=/; HttpOnly`,
        });
        res.end(CHALLENGE_HTML);
        return;
      }

      if (req.url === '/api/user/login' && req.method === 'POST') {
        if (!cookie.includes(`acw_tc=${WARMUP_ACW_TC}`) || !cookie.includes(`acw_sc__v2=${SOLVED_ACW}`)) {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body>login requires primed WAF route</body></html>');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { token: 'warmup-session' } }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'not found' }));
    });

    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const result = await new AnyRouterAdapter().login(
      `http://127.0.0.1:${address.port}`,
      USERNAME,
      PASSWORD,
    );

    expect(result.success).toBe(true);
    expect(result.accessToken).toBe('warmup-session');
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/login' });
    expect(requests.some((request) => (
      request.method === 'POST'
      && request.url === '/api/user/login'
      && request.cookie.includes(`acw_tc=${WARMUP_ACW_TC}`)
      && request.cookie.includes(`acw_sc__v2=${SOLVED_ACW}`)
    ))).toBe(true);
  });
});
