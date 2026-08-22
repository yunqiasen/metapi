import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const checkinAllMock = vi.fn();
const checkinAccountMock = vi.fn();
const { insertedValues } = vi.hoisted(() => ({ insertedValues: [] as any[] }));

vi.mock('../../services/checkinService.js', () => ({
  checkinAll: (...args: unknown[]) => checkinAllMock(...args),
  checkinAccount: (...args: unknown[]) => checkinAccountMock(...args),
}));

vi.mock('../../services/checkinScheduler.js', () => ({
  updateCheckinSchedule: vi.fn(),
}));

vi.mock('../../db/index.js', () => {
  const insertChain = {
    values: (value: any) => {
      insertedValues.push(value);
      return insertChain;
    },
    onConflictDoUpdate: () => insertChain,
    run: () => ({ changes: 1 }),
  };

  const queryChain = {
    where: () => queryChain,
    all: () => [],
    limit: () => queryChain,
    offset: () => queryChain,
    orderBy: () => queryChain,
    innerJoin: () => queryChain,
    from: () => queryChain,
  };

  return {
    db: {
      insert: () => insertChain,
      select: () => queryChain,
    },
    hasProxyLogStreamTimingColumns: async () => false,
    schema: {
      settings: { key: 'key' },
      checkinLogs: { accountId: 'accountId', createdAt: 'createdAt' },
      accounts: { id: 'id' },
      events: { id: 'id' },
    },
  };
});

describe('POST /api/checkin/trigger background task dedupe', () => {
  beforeEach(async () => {
    checkinAllMock.mockReset();
    checkinAccountMock.mockReset();
    insertedValues.length = 0;
    checkinAccountMock.mockResolvedValue({ success: true, message: 'ok' });
    const { __resetBackgroundTasksForTests } = await import('../../services/backgroundTaskService.js');
    __resetBackgroundTasksForTests();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reuses the same background task while checkin-all is already running', async () => {
    let resolveFirst: (value: Array<unknown>) => void = () => {};
    const firstRun = new Promise<Array<unknown>>((resolve) => {
      resolveFirst = resolve;
    });
    checkinAllMock.mockImplementation(() => firstRun);

    const { checkinRoutes } = await import('./checkin.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const firstResponse = await app.inject({ method: 'POST', url: '/api/checkin/trigger' });
    expect(firstResponse.statusCode).toBe(202);
    const firstBody = firstResponse.json() as { success: boolean; queued: boolean; jobId: string };
    expect(firstBody.success).toBe(true);
    expect(firstBody.queued).toBe(true);
    expect(typeof firstBody.jobId).toBe('string');
    expect(firstBody.jobId.length).toBeGreaterThan(10);

    const secondResponse = await app.inject({ method: 'POST', url: '/api/checkin/trigger' });
    expect(secondResponse.statusCode).toBe(202);
    const secondBody = secondResponse.json() as { reused: boolean; jobId: string };
    expect(secondBody.reused).toBe(true);
    expect(secondBody.jobId).toBe(firstBody.jobId);
    expect(checkinAllMock).toHaveBeenCalledTimes(1);

    resolveFirst([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.close();
  });



  it('streams per-account progress into the all-checkin background task', async () => {
    checkinAllMock.mockImplementationOnce(async (options: any) => {
      options.onProgress({
        completed: 1,
        total: 2,
        accountId: 91,
        username: 'any-user',
        site: 'Any',
        result: { success: true, status: 'success', reward: '总额度 +25', message: '签到成功' },
      });
      options.onProgress({
        completed: 2,
        total: 2,
        accountId: 95,
        username: 'agent-user',
        site: 'AgentRouter',
        result: { success: false, status: 'failed', message: 'provider_session_expired' },
      });
      return [];
    });

    const { checkinRoutes } = await import('./checkin.js');
    const { getBackgroundTask } = await import('../../services/backgroundTaskService.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const response = await app.inject({ method: 'POST', url: '/api/checkin/trigger' });
    const { jobId } = response.json() as { jobId: string };
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(checkinAllMock).toHaveBeenCalledWith(expect.objectContaining({
      onProgress: expect.any(Function),
    }));
    expect(getBackgroundTask(jobId)?.logs.map((entry) => entry.message)).toEqual([
      '签到进度 1/2：any-user @ Any - 成功（总额度 +25）',
      '签到进度 2/2：agent-user @ AgentRouter - 失败（provider_session_expired）',
    ]);
    await app.close();
  });

  it('publishes an error-level task event when all-checkin finishes with account failures', async () => {
    checkinAllMock.mockResolvedValueOnce([
      {
        accountId: 91,
        username: 'any-user',
        site: 'Any',
        result: { success: true, status: 'success', reward: '总额度 +25' },
      },
      {
        accountId: 95,
        username: 'agent-user',
        site: 'AgentRouter',
        result: { success: false, status: 'failed', message: 'provider_session_expired' },
      },
    ]);

    const { checkinRoutes } = await import('./checkin.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const response = await app.inject({ method: 'POST', url: '/api/checkin/trigger' });
    expect(response.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(insertedValues).toContainEqual(expect.objectContaining({
      relatedType: 'task',
      level: 'error',
      title: '全部账号签到部分失败（成功1/跳过0/失败1）',
    }));
    await app.close();
  });

  it('queues one-account checkin and returns before the browser workflow finishes', async () => {
    let resolveCheckin!: (value: { success: boolean; status: string; message: string; reward?: string }) => void;
    const deferred = new Promise<{ success: boolean; status: string; message: string; reward?: string }>((resolve) => {
      resolveCheckin = resolve;
    });
    checkinAccountMock.mockImplementationOnce(() => deferred);

    const { checkinRoutes } = await import('./checkin.js');
    const { getBackgroundTask } = await import('../../services/backgroundTaskService.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const responsePromise = app.inject({ method: 'POST', url: '/api/checkin/trigger/95' });
    const settledBeforeRunner = await Promise.race([
      responsePromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    resolveCheckin({
      success: true,
      status: 'success',
      message: 'AgentRouter 签到成功：总额度 +25，当前总额度 925',
      reward: '总额度 +25',
    });

    const response = await responsePromise;
    expect(settledBeforeRunner).toBe(true);
    expect(response.statusCode).toBe(202);
    const body = response.json() as { queued: boolean; reused: boolean; jobId: string };
    expect(body).toMatchObject({ queued: true, reused: false });
    expect(getBackgroundTask(body.jobId)).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getBackgroundTask(body.jobId)).toMatchObject({
      status: 'succeeded',
      result: expect.objectContaining({ reward: '总额度 +25' }),
    });
    await app.close();
  });

  it('marks a structured one-account domain failure as a failed task while preserving its result', async () => {
    checkinAccountMock.mockResolvedValueOnce({
      success: false,
      status: 'failed',
      checkedIn: true,
      credentialsRefreshed: true,
      reasonCode: 'agentrouter_balance_unconfirmed',
      message: 'AgentRouter 已重新登录并保存新凭证，但签到奖励尚未确认',
    });

    const { checkinRoutes } = await import('./checkin.js');
    const { getBackgroundTask } = await import('../../services/backgroundTaskService.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const response = await app.inject({ method: 'POST', url: '/api/checkin/trigger/102' });
    const body = response.json() as { jobId: string };
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getBackgroundTask(body.jobId)).toMatchObject({
      status: 'failed',
      error: 'AgentRouter 已重新登录并保存新凭证，但签到奖励尚未确认',
      result: {
        success: false,
        status: 'failed',
        checkedIn: true,
        credentialsRefreshed: true,
        reasonCode: 'agentrouter_balance_unconfirmed',
      },
    });
    expect(insertedValues).toContainEqual(expect.objectContaining({
      relatedType: 'task',
      level: 'error',
      title: '账号签到 #102 失败',
    }));
    await app.close();
  });

  it('reuses a running one-account checkin task', async () => {
    let resolveCheckin!: (value: { success: boolean; status: string; message: string }) => void;
    checkinAccountMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCheckin = resolve;
    }));

    const { checkinRoutes } = await import('./checkin.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const first = await app.inject({ method: 'POST', url: '/api/checkin/trigger/95' });
    const second = await app.inject({ method: 'POST', url: '/api/checkin/trigger/95' });
    const firstBody = first.json() as { jobId: string; reused: boolean };
    const secondBody = second.json() as { jobId: string; reused: boolean };

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(secondBody).toMatchObject({ jobId: firstBody.jobId, reused: true });
    expect(checkinAccountMock).toHaveBeenCalledTimes(1);

    resolveCheckin({ success: true, status: 'success', message: 'ok' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.close();
  });

  it('accepts the legacy cron-only schedule payload', async () => {
    const { checkinRoutes } = await import('./checkin.js');
    const schedulerModule = await import('../../services/checkinScheduler.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/checkin/schedule',
      payload: { cron: '0 8 * * *' },
    });

    expect(response.statusCode).toBe(200);
    expect((schedulerModule as any).updateCheckinSchedule).toHaveBeenCalledWith({
      mode: 'cron',
      cronExpr: '0 8 * * *',
      intervalHours: undefined,
    });
    await app.close();
  });
});
