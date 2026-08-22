import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { refreshAccountCredentialMock, refreshAllAccountCredentialsMock, refreshBalanceMock } = vi.hoisted(() => ({
  refreshAccountCredentialMock: vi.fn(),
  refreshAllAccountCredentialsMock: vi.fn(),
  refreshBalanceMock: vi.fn(),
}));

vi.mock('../../services/accountCredentialRefreshService.js', () => ({
  refreshAccountCredential: refreshAccountCredentialMock,
  refreshAllAccountCredentials: refreshAllAccountCredentialsMock,
}));

vi.mock('../../services/balanceService.js', () => ({
  refreshBalance: refreshBalanceMock,
}));

describe('accounts credential refresh routes', () => {
  let app: FastifyInstance;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-credential-refresh-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const routesModule = await import('./accounts.js');
    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    refreshAccountCredentialMock.mockReset();
    refreshAllAccountCredentialsMock.mockReset();
    refreshBalanceMock.mockReset();
    const { __resetBackgroundTasksForTests } = await import('../../services/backgroundTaskService.js');
    __resetBackgroundTasksForTests();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('queues one-account credential refresh without holding the HTTP request open', async () => {
    let resolveRefresh!: (value: { accountId: number; status: string; refreshed: boolean; message: string }) => void;
    refreshAccountCredentialMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    const responsePromise = app.inject({
      method: 'POST',
      url: '/api/accounts/11/credential/refresh',
    });
    const settledBeforeRunner = await Promise.race([
      responsePromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    resolveRefresh({ accountId: 11, status: 'success', refreshed: true, message: '凭证已刷新' });

    const response = await responsePromise;
    expect(settledBeforeRunner).toBe(true);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      success: true,
      queued: true,
      reused: false,
      jobId: expect.any(String),
    });
    expect(refreshAccountCredentialMock).toHaveBeenCalledWith(11);
  });

  it('queues all-account credential refresh', async () => {
    refreshAllAccountCredentialsMock.mockResolvedValueOnce({
      total: 3,
      success: 1,
      skipped: 1,
      failed: 1,
      results: [
        { accountId: 1, status: 'success', refreshed: true },
        { accountId: 2, status: 'skipped', refreshed: false },
        { accountId: 3, status: 'failed', refreshed: false },
      ],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/credentials/refresh',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      success: true,
      queued: true,
      reused: false,
      jobId: expect.any(String),
    });
    expect(refreshAllAccountCredentialsMock).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { db, schema } = await import('../../db/index.js');
    const taskEvents = await db.select().from(schema.events).all();
    expect(taskEvents).toContainEqual(expect.objectContaining({
      relatedType: 'task',
      level: 'error',
      title: '全部账号凭证刷新部分失败',
    }));
  });

  it('queues a balance refresh when background mode is requested', async () => {
    let resolveRefresh!: (value: { balance: number; used: number; quota: number }) => void;
    refreshBalanceMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    const responsePromise = app.inject({
      method: 'POST',
      url: '/api/accounts/11/balance?background=1',
    });
    const settledBeforeRunner = await Promise.race([
      responsePromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    resolveRefresh({ balance: 925, used: 0, quota: 925 });

    const response = await responsePromise;
    expect(settledBeforeRunner).toBe(true);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      success: true,
      queued: true,
      reused: false,
      jobId: expect.any(String),
    });
    expect(refreshBalanceMock).toHaveBeenCalledWith(11);
  });

  it('reports an AgentRouter check-in observed during background balance refresh', async () => {
    refreshBalanceMock.mockResolvedValueOnce({
      balance: -0.294956,
      used: 1675.294956,
      quota: 1675,
      observedCheckinReward: '总额度 +50',
      observedCheckinMessage: 'AgentRouter 签到成功：总额度 +50，当前总额度 1675',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/94/balance?background=1',
    });
    const body = response.json() as { jobId: string };
    const { waitForBackgroundTaskCompletion } = await import('../../services/backgroundTaskService.js');
    const task = await waitForBackgroundTaskCompletion(body.jobId);

    expect(task).toMatchObject({
      status: 'succeeded',
      message: 'AgentRouter 签到成功：总额度 +50，当前总额度 1675',
    });
  });

  it('rejects invalid account id when refreshing one credential', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/nope/credential/refresh',
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message?: string }).message).toContain('账号 ID');
    expect(refreshAccountCredentialMock).not.toHaveBeenCalled();
  });
});
