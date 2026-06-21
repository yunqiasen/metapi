import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { refreshManagedAccountLoginMock, getAdapterMock, adapterLoginMock } = vi.hoisted(() => ({
  refreshManagedAccountLoginMock: vi.fn(),
  getAdapterMock: vi.fn(),
  adapterLoginMock: vi.fn(),
}));

vi.mock('./platforms/index.js', () => ({
  getAdapter: getAdapterMock,
}));

vi.mock('./accountManagedBrowserLogin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./accountManagedBrowserLogin.js')>();
  return {
    ...actual,
    refreshManagedAccountLogin: refreshManagedAccountLoginMock,
  };
});

type DbModule = typeof import('../db/index.js');

describe('account credential refresh service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-account-credential-refresh-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
  });

  beforeEach(async () => {
    refreshManagedAccountLoginMock.mockReset();
    getAdapterMock.mockReset();
    adapterLoginMock.mockReset();
    getAdapterMock.mockReturnValue({
      login: adapterLoginMock,
    });
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('refreshes a managed browser login account', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'AnyRouter',
      url: 'https://anyrouter.top',
      platform: 'anyrouter',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alpha',
      accessToken: 'old-cookie',
      status: 'expired',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    refreshManagedAccountLoginMock.mockResolvedValueOnce({
      accessToken: 'new-cookie',
      platformUserId: 123,
      username: 'alpha',
      apiToken: 'sk-new',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    });

    const { refreshAccountCredential } = await import('./accountCredentialRefreshService.js');
    const result = await refreshAccountCredential(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      status: 'success',
      refreshed: true,
    });
    expect(refreshManagedAccountLoginMock).toHaveBeenCalledTimes(1);
    expect(refreshManagedAccountLoginMock.mock.calls[0]?.[0]).toMatchObject({ id: account.id });
    expect(refreshManagedAccountLoginMock.mock.calls[0]?.[1]).toMatchObject({ id: site.id });
  });


  it('refreshes a password-login account by logging in again with saved credentials', async () => {
    const { encryptAccountPassword } = await import('./accountCredentialService.js');
    const site = await db.insert(schema.sites).values({
      name: 'New API',
      url: 'https://new-api.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'password-user',
      accessToken: 'old-session',
      status: 'expired',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        autoRelogin: {
          username: 'password-user',
          passwordCipher: encryptAccountPassword('secret-pass'),
        },
      }),
    }).returning().get();
    adapterLoginMock.mockResolvedValueOnce({
      success: true,
      accessToken: 'new-session',
    });

    const { refreshAccountCredential } = await import('./accountCredentialRefreshService.js');
    const result = await refreshAccountCredential(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      status: 'success',
      refreshed: true,
    });
    expect(adapterLoginMock).toHaveBeenCalledWith(
      site.url,
      'password-user',
      'secret-pass',
    );
    const updated = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(updated?.accessToken).toBe('new-session');
    expect(updated?.status).toBe('active');
  });

  it('skips accounts whose site is not managed by browser profile refresh', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'OpenAI',
      url: 'https://api.openai.com',
      platform: 'openai',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'api-key',
      accessToken: 'sk-old',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const { refreshAccountCredential } = await import('./accountCredentialRefreshService.js');
    const result = await refreshAccountCredential(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      status: 'skipped',
      refreshed: false,
    });
    expect(result.message).toContain('没有保存账号密码');
    expect(refreshManagedAccountLoginMock).not.toHaveBeenCalled();
  });

  it('summarizes all account credential refresh results', async () => {
    const managedSite = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const otherSite = await db.insert(schema.sites).values({
      name: 'OpenAI',
      url: 'https://api.openai.com',
      platform: 'openai',
    }).returning().get();
    await db.insert(schema.accounts).values([
      { id: 31, siteId: managedSite.id, username: 'managed', accessToken: 'old', status: 'active' },
      { id: 32, siteId: otherSite.id, username: 'plain', accessToken: 'sk-old', status: 'active' },
    ]).run();
    refreshManagedAccountLoginMock.mockResolvedValueOnce({ accessToken: 'new', extraConfig: '{}' });

    const { refreshAllAccountCredentials } = await import('./accountCredentialRefreshService.js');
    const result = await refreshAllAccountCredentials();

    expect(result).toMatchObject({
      total: 2,
      success: 1,
      skipped: 1,
      failed: 0,
    });
    expect(result.results.map((item) => item.accountId)).toEqual([31, 32]);
  });
});
