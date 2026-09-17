import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { NewApiAdapter } from './newApi.js';

describe('NewApiAdapter login failure classification', () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it.each([
    '<html><body>login endpoint unavailable</body></html>',
    '<html><title>AnyRouter</title><script type="module" src="/assets/index.js"></script><div id="root"></div></html>',
  ])('does not label a normal non-JSON login response as an anti-bot challenge: %s', async (html) => {
    server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const result = await new NewApiAdapter().login(
      `http://127.0.0.1:${address.port}`,
      'fixture-user',
      'fixture-password',
    );

    expect(result.success).toBe(false);
    expect(result.message?.toLowerCase()).not.toContain('shield challenge');
    expect(result.message).toContain('HTTP 200');
  });
});
