import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { refreshManagedAccountLoginMock, loginManagedAccountWithPasswordMock, getAdapterMock, adapterLoginMock, refreshBalanceMock } = vi.hoisted(() => ({
  refreshManagedAccountLoginMock: vi.fn(),
  loginManagedAccountWithPasswordMock: vi.fn(),
  getAdapterMock: vi.fn(),
  adapterLoginMock: vi.fn(),
  refreshBalanceMock: vi.fn(),
}));

vi.mock('./platforms/index.js', () => ({
  getAdapter: getAdapterMock,
}));

vi.mock('./balanceService.js', () => ({
  refreshBalance: (...args: unknown[]) => refreshBalanceMock(...args),
}));

vi.mock('./accountManagedBrowserLogin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./accountManagedBrowserLogin.js')>();
  return {
    ...actual,
    refreshManagedAccountLogin: refreshManagedAccountLoginMock,
    loginManagedAccountWithPassword: loginManagedAccountWithPasswordMock,
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
    loginManagedAccountWithPasswordMock.mockReset();
    getAdapterMock.mockReset();
    adapterLoginMock.mockReset();
    refreshBalanceMock.mockReset();
    refreshBalanceMock.mockResolvedValue(null);
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
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        managedBrowserProfile: {
          enabled: true,
          profileDir: (() => {
            const profileDir = join(dataDir, 'profiles', 'anyrouter-alpha');
            mkdirSync(profileDir, { recursive: true });
            return profileDir;
          })(),
        },
      }),
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


  it('serializes complete credential refresh operations for one account', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'linuxdo_59260',
      accessToken: 'session=old',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        platformUserId: 59260,
        managedBrowserProfile: {
          enabled: true,
          loginProvider: 'linuxdo',
          profileDir: (() => {
            const profileDir = join(dataDir, 'profiles', 'agent-serialized');
            mkdirSync(profileDir, { recursive: true });
            return profileDir;
          })(),
        },
      }),
    }).returning().get();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    refreshManagedAccountLoginMock
      .mockImplementationOnce(async () => {
        markFirstStarted();
        await firstGate;
        return {
          accessToken: 'session=first',
          platformUserId: 59260,
          extraConfig: account.extraConfig,
        };
      })
      .mockResolvedValueOnce({
        accessToken: 'session=second',
        platformUserId: 59260,
        extraConfig: account.extraConfig,
      });

    const { refreshAccountCredential } = await import('./accountCredentialRefreshService.js');
    const first = refreshAccountCredential(account.id);
    await firstStarted;
    const second = refreshAccountCredential(account.id);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(refreshManagedAccountLoginMock).toHaveBeenCalledTimes(1);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(refreshManagedAccountLoginMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes AgentRouter credentials from the existing Session/Profile without invoking check-in reauthentication', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'github_166363',
      accessToken: 'session=stale',
      status: 'expired',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        platformUserId: 166363,
        managedBrowserProfile: {
          enabled: true,
          loginProvider: 'github',
          profileDir: (() => {
            const profileDir = join(dataDir, 'profiles', 'agent-refresh');
            mkdirSync(profileDir, { recursive: true });
            return profileDir;
          })(),
        },
      }),
    }).returning().get();
    refreshManagedAccountLoginMock.mockResolvedValueOnce({
      accessToken: 'session=fresh-from-profile',
      platformUserId: 166363,
      username: 'github_166363',
      apiToken: 'sk-agentrouter',
      extraConfig: account.extraConfig,
    });
    refreshBalanceMock.mockResolvedValueOnce({
      balance: 850,
      used: 0,
      quota: 850,
      observedCheckinReward: '总额度 +50',
      observedCheckinMessage: 'AgentRouter 签到成功：总额度 +50，当前总额度 850',
    });

    const { refreshAccountCredential } = await import('./accountCredentialRefreshService.js');
    const result = await refreshAccountCredential(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      status: 'success',
      refreshed: true,
    });
    expect(result.message).toBe('凭证已刷新；AgentRouter 签到成功：总额度 +50，当前总额度 850');
    expect(refreshBalanceMock).toHaveBeenCalledWith(account.id);
    expect(refreshManagedAccountLoginMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: account.id }),
      expect.objectContaining({ id: site.id, platform: 'agentrouter' }),
    );
  });

  it('does not invoke browser refresh when the stored Profile directory is missing', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'github_166363',
      accessToken: 'session=stale',
      status: 'expired',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        platformUserId: 166363,
        managedBrowserProfile: { enabled: true, loginProvider: 'github' },
      }),
    }).returning().get();
    refreshManagedAccountLoginMock.mockResolvedValueOnce(null);

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
    expect(refreshManagedAccountLoginMock).not.toHaveBeenCalled();
    expect(loginManagedAccountWithPasswordMock).not.toHaveBeenCalled();
    const updated = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(updated?.accessToken).toBe('new-session');
    expect(updated?.status).toBe('active');
  });

  it('keeps saved-password refresh protocol-only when login hits a shield challenge', async () => {
    const { encryptAccountPassword } = await import('./accountCredentialService.js');
    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
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
      success: false,
      message: 'shield challenge blocked login',
    });

    const { refreshAccountCredential } = await import('./accountCredentialRefreshService.js');
    const result = await refreshAccountCredential(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      status: 'failed',
      refreshed: false,
    });
    expect(result.message).toContain('真实站点登录窗口重新保存 Profile');
    expect(refreshManagedAccountLoginMock).not.toHaveBeenCalled();
    expect(loginManagedAccountWithPasswordMock).not.toHaveBeenCalled();
    const updated = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(updated?.accessToken).toBe('old-session');
  });

  it('does not return raw shield text when browser password refresh cannot complete', async () => {
    const { encryptAccountPassword } = await import('./accountCredentialService.js');
    const site = await db.insert(schema.sites).values({
      name: 'Elysia',
      url: 'https://elysiver.h-e.top',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'TX123KOA',
      accessToken: 'old-session',
      status: 'expired',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        autoRelogin: {
          username: 'TX123KOA',
          passwordCipher: encryptAccountPassword('secret-pass'),
        },
      }),
    }).returning().get();
    adapterLoginMock.mockResolvedValueOnce({ success: false, message: 'shield challenge blocked login' });
    loginManagedAccountWithPasswordMock.mockResolvedValueOnce(null);

    const { refreshAccountCredential } = await import('./accountCredentialRefreshService.js');
    const result = await refreshAccountCredential(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      status: 'failed',
      refreshed: false,
    });
    expect(result.message).toContain('真实站点登录窗口重新保存 Profile');
    expect(result.message).not.toBe('shield challenge blocked login');
    expect(loginManagedAccountWithPasswordMock).not.toHaveBeenCalled();
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
    const managedProfileDir = join(dataDir, 'profiles', 'summary-managed');
    mkdirSync(managedProfileDir, { recursive: true });
    await db.insert(schema.accounts).values([
      {
        id: 31,
        siteId: managedSite.id,
        username: 'managed',
        accessToken: 'old',
        status: 'active',
        extraConfig: JSON.stringify({
          managedBrowserProfile: { enabled: true, profileDir: managedProfileDir },
        }),
      },
      { id: 32, siteId: otherSite.id, username: 'plain', accessToken: 'sk-old', status: 'active' },
    ]).run();
    refreshManagedAccountLoginMock.mockResolvedValueOnce({
      accessToken: 'session=refreshed',
      platformUserId: 59260,
      username: 'managed',
      apiToken: null,
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    });

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
