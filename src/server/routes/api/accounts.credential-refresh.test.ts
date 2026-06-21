import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { refreshAccountCredentialMock, refreshAllAccountCredentialsMock } = vi.hoisted(() => ({
  refreshAccountCredentialMock: vi.fn(),
  refreshAllAccountCredentialsMock: vi.fn(),
}));

vi.mock('../../services/accountCredentialRefreshService.js', () => ({
  refreshAccountCredential: refreshAccountCredentialMock,
  refreshAllAccountCredentials: refreshAllAccountCredentialsMock,
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

  beforeEach(() => {
    refreshAccountCredentialMock.mockReset();
    refreshAllAccountCredentialsMock.mockReset();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('refreshes credential for one account', async () => {
    refreshAccountCredentialMock.mockResolvedValueOnce({
      accountId: 11,
      status: 'success',
      refreshed: true,
      message: '凭证已刷新',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/11/credential/refresh',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      accountId: 11,
      status: 'success',
      refreshed: true,
    });
    expect(refreshAccountCredentialMock).toHaveBeenCalledWith(11);
  });

  it('refreshes credentials for all accounts', async () => {
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

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      total: 3,
      summary: { success: 1, skipped: 1, failed: 1 },
    });
    expect(refreshAllAccountCredentialsMock).toHaveBeenCalledTimes(1);
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
