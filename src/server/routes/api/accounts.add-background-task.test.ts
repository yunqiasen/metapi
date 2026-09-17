import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { BackgroundTask } from '../../services/backgroundTaskService.js';
import { waitForBackgroundTaskToReachTerminalState } from '../../test-fixtures/backgroundTaskTestUtils.js';

const verifyTokenMock = vi.fn();
const getApiTokensMock = vi.fn();
const refreshBalanceMock = vi.fn();
const refreshModelsForAccountMock = vi.fn();
const rebuildTokenRoutesFromAvailabilityMock = vi.fn();
const ensureDefaultTokenForAccountMock = vi.fn();
const syncTokensFromUpstreamMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
  }),
}));

vi.mock('../../services/balanceService.js', () => ({
  refreshBalance: (...args: unknown[]) => refreshBalanceMock(...args),
}));

vi.mock('../../services/modelService.js', () => ({
  refreshModelsForAccount: (...args: unknown[]) => refreshModelsForAccountMock(...args),
  rebuildTokenRoutesFromAvailability: (...args: unknown[]) => rebuildTokenRoutesFromAvailabilityMock(...args),
}));

vi.mock('../../services/accountTokenService.js', () => ({
  ensureDefaultTokenForAccount: (...args: unknown[]) => ensureDefaultTokenForAccountMock(...args),
  syncTokensFromUpstream: (...args: unknown[]) => syncTokensFromUpstreamMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts background initialization', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let resetBackgroundTasks: (() => void) | null = null;
  let getBackgroundTask: (taskId: string) => BackgroundTask | null;
  let listBackgroundTasks: () => BackgroundTask[];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-background-init-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    const backgroundTaskModule = await import('../../services/backgroundTaskService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    resetBackgroundTasks = backgroundTaskModule.__resetBackgroundTasksForTests;
    getBackgroundTask = backgroundTaskModule.getBackgroundTask;
    listBackgroundTasks = backgroundTaskModule.listBackgroundTasks;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    verifyTokenMock.mockReset();
    getApiTokensMock.mockReset();
    refreshBalanceMock.mockReset();
    refreshModelsForAccountMock.mockReset();
    rebuildTokenRoutesFromAvailabilityMock.mockReset();
    ensureDefaultTokenForAccountMock.mockReset();
    syncTokensFromUpstreamMock.mockReset();
    resetBackgroundTasks?.();

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
    delete process.env.DATA_DIR;
  });

  it('returns immediately and queues background initialization when token sync is slow', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Session Site',
      url: 'https://session.example.com',
      platform: 'new-api',
    }).returning().get();

    verifyTokenMock.mockResolvedValue({
      tokenType: 'session',
      userInfo: { username: 'demo-user' },
      apiToken: 'sk-demo',
    });
    ensureDefaultTokenForAccountMock.mockResolvedValue(undefined);
    refreshBalanceMock.mockResolvedValue({ balance: 1, used: 0, quota: 1 });
    refreshModelsForAccountMock.mockResolvedValue(undefined);
    rebuildTokenRoutesFromAvailabilityMock.mockResolvedValue(undefined);
    syncTokensFromUpstreamMock.mockResolvedValue(undefined);

    let releaseTokens: ((value: Array<{ name: string; value: string }>) => void) | null = null;
    const pendingTokens = new Promise<Array<{ name: string; value: string }>>((resolve) => {
      releaseTokens = resolve;
    });
    getApiTokensMock.mockReturnValue(pendingTokens);

    const responsePromise = app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'session-token',
      },
    });

    try {
      const raceResult = await Promise.race([
        responsePromise.then(() => 'response'),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 25)),
      ]);

      expect(raceResult).toBe('response');

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);

      const body = response.json() as {
        id: number;
        queued?: boolean;
        jobId?: string;
        usernameDetected?: boolean;
        apiTokenFound?: boolean;
      };

      expect(body).toMatchObject({
        queued: true,
        usernameDetected: true,
        apiTokenFound: true,
      });
      expect(body.jobId).toBeTruthy();

      const insertedAccounts = await db.select().from(schema.accounts).all();
      expect(insertedAccounts).toHaveLength(1);
      expect(getBackgroundTask?.(body.jobId!)).toMatchObject({
        status: expect.stringMatching(/pending|running/),
      });

      releaseTokens?.([{ name: 'default', value: 'sk-demo' }]);

      const task = await waitForBackgroundTaskToReachTerminalState(
        (taskId) => getBackgroundTask?.(taskId) ?? null,
        body.jobId!,
      );

      expect(syncTokensFromUpstreamMock).toHaveBeenCalledTimes(1);
      expect(refreshBalanceMock).toHaveBeenCalledTimes(1);
      expect(refreshModelsForAccountMock).toHaveBeenCalledTimes(1);
      expect(rebuildTokenRoutesFromAvailabilityMock).toHaveBeenCalledTimes(1);
      expect(task).toMatchObject({ status: 'succeeded' });
    } finally {
      releaseTokens?.([]);
      await responsePromise.catch(() => undefined);
    }
  });

  async function seedEditableAccount() {
    const site = await db.insert(schema.sites).values({
      name: 'Editable Session Site', url: 'https://editable-session.example.com', platform: 'agentrouter',
    }).returning().get();
    return db.insert(schema.accounts).values({
      siteId: site.id, username: 'github_166363', accessToken: 'session=old', apiToken: 'sk-existing',
      status: 'active', checkinEnabled: true,
      extraConfig: JSON.stringify({ platformUserId: 166363, checkinRelogin: { provider: 'github', cookie: 'user_session=fixture' } }),
    }).returning().get();
  }

  async function finishMaintenance() {
    for (const task of listBackgroundTasks().filter((item) => item.type === 'account-update-maintenance')) {
      await waitForBackgroundTaskToReachTerminalState(getBackgroundTask, task.id);
    }
  }

  it('saves an edited Cookie before slow model synchronization completes', async () => {
    const account = await seedEditableAccount();
    let releaseModels!: (result: unknown) => void;
    refreshModelsForAccountMock.mockReturnValue(new Promise((resolve) => { releaseModels = resolve; }));
    const responsePromise = app.inject({
      method: 'PUT', url: `/api/accounts/${account.id}`,
      payload: { accessToken: 'Cookie: session=new\nsession==;\n acw_tc=shield', apiToken: 'sk-existing' },
    });
    try {
      expect(await Promise.race([
        responsePromise.then(() => 'saved'),
        new Promise((resolve) => setTimeout(() => resolve('waiting-on-upstream'), 200)),
      ])).toBe('saved');
      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: account.id, accessToken: 'session=newsession==; acw_tc=shield' });
      const saved = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
      expect(JSON.parse(saved?.extraConfig || '{}').checkinRelogin.cookie).toBe('user_session=fixture');
      expect(listBackgroundTasks()).toContainEqual(expect.objectContaining({ type: 'account-update-maintenance' }));
    } finally {
      releaseModels({ accountId: account.id, refreshed: true, status: 'success' });
      await responsePromise;
      await finishMaintenance();
    }
    expect(refreshModelsForAccountMock).toHaveBeenCalledTimes(1);
    expect(rebuildTokenRoutesFromAvailabilityMock).toHaveBeenCalledTimes(1);
  });

  it('serializes overlapping edits without dropping maintenance for the newer credentials', async () => {
    const account = await seedEditableAccount();
    let releaseFirst!: (result: unknown) => void;
    refreshModelsForAccountMock
      .mockReturnValueOnce(new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValue({ accountId: account.id, refreshed: true, status: 'success' });
    const first = app.inject({ method: 'PUT', url: `/api/accounts/${account.id}`, payload: { apiToken: 'sk-first' } });
    let second: ReturnType<typeof app.inject> | undefined;
    try {
      expect(await Promise.race([first.then(() => 'saved'), new Promise((resolve) => setTimeout(() => resolve('timeout'), 200))])).toBe('saved');
      await vi.waitFor(() => expect(refreshModelsForAccountMock).toHaveBeenCalledTimes(1));
      second = app.inject({ method: 'PUT', url: `/api/accounts/${account.id}`, payload: { apiToken: 'sk-second' } });
      const response = await second;
      expect(response.statusCode).toBe(200);
      expect(response.json().apiToken).toBe('sk-second');
      expect(refreshModelsForAccountMock).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirst({ accountId: account.id, refreshed: true, status: 'success' });
      await first;
      if (second) await second;
      await finishMaintenance();
    }
    expect(refreshModelsForAccountMock).toHaveBeenCalledTimes(2);
    expect(ensureDefaultTokenForAccountMock).toHaveBeenLastCalledWith(account.id, 'sk-second', expect.anything());
    const saved = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(saved?.apiToken).toBe('sk-second');
  });

  it('reports a failed background synchronization without undoing the saved credentials', async () => {
    const account = await seedEditableAccount();
    refreshModelsForAccountMock.mockResolvedValue({
      accountId: account.id, refreshed: false, status: 'failed', errorMessage: 'fixture upstream error',
    });
    const response = await app.inject({ method: 'PUT', url: `/api/accounts/${account.id}`, payload: { accessToken: 'session=new' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toBe('session=new');
    await finishMaintenance();
    expect(listBackgroundTasks()).toContainEqual(expect.objectContaining({
      type: 'account-update-maintenance', status: 'failed', error: 'fixture upstream error',
    }));
  });

});
