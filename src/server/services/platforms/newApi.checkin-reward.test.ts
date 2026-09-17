import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { NewApiAdapter } from './newApi.js';

describe('NewAPI checkin reward contract', () => {
  let server: ReturnType<typeof createServer> | undefined;
  afterEach(async () => { await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()); });

  it('preserves the verified user ID for session imports', async () => {
    server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, data: { id: 83033, username: '875133228', quota: 0, used_quota: 0 } }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('missing address');
    const result = await new NewApiAdapter().verifyToken(`http://127.0.0.1:${addr.port}`, 'session=fixture', undefined, 'session');
    expect(result.userInfo).toMatchObject({ id: 83033, username: '875133228' });
  });

  it.each(['bearer', 'cookie-checkin', 'cookie-sign-in'])('reads quota_awarded in %s flow without displaying raw quota as dollars', async (flow) => {
    server = createServer((req, res) => {
      const isRewardRequest = flow === 'bearer' ? !!req.headers.authorization
        : flow === 'cookie-checkin' ? !!req.headers.cookie && req.url === '/api/user/checkin'
        : !!req.headers.cookie && req.url === '/api/user/sign_in';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(isRewardRequest
        ? { success: true, message: '签到成功', data: { quota_awarded: 4216992 } }
        : { success: false, message: 'access token required' }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('missing address');
    const result = await new NewApiAdapter().checkin(`http://127.0.0.1:${addr.port}`, 'session=fixture', 83033);
    expect(result).toMatchObject({ success: true, reward: '8.433984' });
  });
});
