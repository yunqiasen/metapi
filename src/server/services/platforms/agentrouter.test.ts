import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRouterAdapter } from './agentrouter.js';

describe('AgentRouterAdapter', () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it('returns a relogin configuration hint without fetching upstream when no relogin is requested', async () => {
    const requests: Array<{ method?: string; url?: string }> = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push({ method: req.method, url: req.url });
      if (req.url === '/api/user/self' && req.headers.cookie?.includes('session=fixture-session')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: { id: 59260, username: 'linuxdo_59260', quota: 108000000, used_quota: 1040000000 },
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'not found' }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const result = await new AgentRouterAdapter().checkin(
      `http://127.0.0.1:${address.port}`,
      'fixture-session',
      59260,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('未配置签到重登录');
    expect(result.balanceInfo).toBeUndefined();
    expect(requests).toEqual([]);
  });
});
