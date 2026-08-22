import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { launchPersistentContextMock, getAdapterMock, getApiTokenMock, getUserInfoMock, openAgentRouterBrowserMock, openAnyRouterBrowserMock } = vi.hoisted(() => ({
  launchPersistentContextMock: vi.fn(),
  getAdapterMock: vi.fn(),
  getApiTokenMock: vi.fn(),
  getUserInfoMock: vi.fn(),
  openAgentRouterBrowserMock: vi.fn(),
  openAnyRouterBrowserMock: vi.fn(),
}));

vi.mock('./browserAutomationRuntime.js', () => ({
  loadChromiumBrowserType: vi.fn(async () => ({
    launchPersistentContext: launchPersistentContextMock,
  })),
}));

vi.mock('./platforms/index.js', () => ({
  getAdapter: getAdapterMock,
}));

vi.mock('./agentRouterReloginBrowser.js', () => ({
  openAgentRouterReloginBrowser: openAgentRouterBrowserMock,
}));

vi.mock('./anyRouterBrowserVisitCheckinBrowser.js', () => ({
  openAnyRouterVisitBrowser: openAnyRouterBrowserMock,
}));

type DbModule = typeof import('../db/index.js');

describe('managed browser login profile-only refresh', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-managed-profile-refresh-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
  });

  beforeEach(async () => {
    launchPersistentContextMock.mockReset();
    getAdapterMock.mockReset();
    getApiTokenMock.mockReset();
    getUserInfoMock.mockReset();
    openAgentRouterBrowserMock.mockReset();
    openAgentRouterBrowserMock.mockResolvedValue(null);
    openAnyRouterBrowserMock.mockReset();
    openAnyRouterBrowserMock.mockResolvedValue(null);
    getAdapterMock.mockReturnValue({ getApiToken: getApiTokenMock, getUserInfo: getUserInfoMock });
    getApiTokenMock.mockResolvedValue('sk-profile-refresh');
    getUserInfoMock.mockResolvedValue(null);
    delete process.env.METAPI_MANAGED_REFRESH_REQUEST_TIMEOUT_MS;
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  async function materializeStoredProfile(
    account: typeof schema.accounts.$inferSelect,
    site: typeof schema.sites.$inferSelect,
  ) {
    const profileDir = join(dataDir, 'browser-profiles', 'accounts', String(site.platform), String(account.id));
    mkdirSync(profileDir, { recursive: true });
    const extra = JSON.parse(account.extraConfig || '{}');
    extra.managedBrowserProfile = {
      ...(extra.managedBrowserProfile || {}),
      enabled: true,
      profileDir,
    };
    account.extraConfig = JSON.stringify(extra);
    await db.update(schema.accounts)
      .set({ extraConfig: account.extraConfig })
      .where(eq(schema.accounts.id, account.id))
      .run();
  }


  it('does not trust stale browser storage when the live target self request rejects the Session', async () => {
    const page = {
      setViewportSize: vi.fn(async () => {}),
      goto: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      evaluate: vi.fn()
        .mockResolvedValueOnce({ id: 166081, username: 'github_166081' })
        .mockResolvedValueOnce(null),
    };
    const context = {
      pages: vi.fn(() => [page]),
      newPage: vi.fn(async () => page),
      cookies: vi.fn(async () => [
        { name: 'session', value: 'stale-profile-session', domain: 'agentrouter.org' },
      ]),
      close: vi.fn(async () => {}),
    };
    launchPersistentContextMock.mockResolvedValue(context);

    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'github_166081',
      accessToken: 'old-session',
      status: 'expired',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        platformUserId: 166081,
        managedBrowserProfile: { enabled: true, provider: 'agentrouter' },
      }),
    }).returning().get();

    await materializeStoredProfile(account, site);
    const { refreshManagedAccountLogin } = await import('./accountManagedBrowserLogin.js');
    const result = await refreshManagedAccountLogin(account, site);

    expect(result).toBeNull();
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(launchPersistentContextMock).toHaveBeenCalledTimes(1);
    const updated = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(updated?.accessToken).toBe('old-session');
    expect(updated?.status).toBe('expired');
  });

  it('uses the dedicated AgentRouter management route before opening the browser Profile', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'linuxdo_59260',
      accessToken: 'session=still-valid',
      status: 'expired',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        platformUserId: 59260,
        proxyUrl: 'http://account-proxy:7890',
        agentRouterBalanceProxyUrl: 'http://management-proxy:7890',
        managedBrowserProfile: { enabled: true, provider: 'agentrouter', loginProvider: 'linuxdo' },
      }),
    }).returning().get();
    getUserInfoMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ username: 'linuxdo_59260', platformUserId: 59260 });

    await materializeStoredProfile(account, site);
    const { refreshManagedAccountLogin } = await import('./accountManagedBrowserLogin.js');
    const result = await refreshManagedAccountLogin(account, site);

    expect(result).toMatchObject({
      accessToken: 'session=still-valid',
      platformUserId: 59260,
      username: 'linuxdo_59260',
    });
    expect(getUserInfoMock).toHaveBeenCalledTimes(2);
    expect(launchPersistentContextMock).not.toHaveBeenCalled();
  });

  it('refreshes an AgentRouter account directly from browser profile cookies', async () => {
    const page = {
      setViewportSize: vi.fn(async () => {}),
      goto: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      evaluate: vi.fn(async () => null),
    };
    const context = {
      pages: vi.fn(() => [page]),
      newPage: vi.fn(async () => page),
      cookies: vi.fn(async () => [
        { name: 'session', value: 'profile-session', domain: 'agentrouter.org' },
      ]),
      close: vi.fn(async () => {}),
    };
    launchPersistentContextMock.mockResolvedValue(context);
    getUserInfoMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      username: 'github_51978',
      platformUserId: 51978,
    });

    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'github_51978',
      accessToken: 'session=expired',
      status: 'expired',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        platformUserId: 51978,
        managedBrowserProfile: { enabled: true, provider: 'agentrouter', loginProvider: 'github' },
      }),
    }).returning().get();

    await materializeStoredProfile(account, site);
    const { refreshManagedAccountLogin } = await import('./accountManagedBrowserLogin.js');
    const result = await refreshManagedAccountLogin(account, site);

    expect(result).toMatchObject({
      accessToken: 'session=profile-session',
      platformUserId: 51978,
      username: 'github_51978',
      apiToken: 'sk-profile-refresh',
    });
    expect(getUserInfoMock).toHaveBeenLastCalledWith(
      'https://agentrouter.org',
      'session=profile-session',
      51978,
    );
    expect(page.goto).not.toHaveBeenCalled();
    const updated = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(updated?.accessToken).toBe('session=profile-session');
    expect(updated?.status).toBe('active');
    expect(updated?.extraConfig).toContain('recoveredFromBrowserProfileCookie');
    expect(JSON.parse(updated?.extraConfig || '{}').managedBrowserProfile.loginProvider).toBe('github');
  });

  it('returns null without inspecting the Session when the browser Profile is missing', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'github_166081',
      accessToken: 'session=still-valid',
      status: 'expired',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        platformUserId: 166081,
        managedBrowserProfile: { enabled: true, provider: 'agentrouter' },
      }),
    }).returning().get();
    getUserInfoMock.mockResolvedValueOnce({
      username: 'github_166081',
      platformUserId: 166081,
    });

    const { refreshManagedAccountLogin } = await import('./accountManagedBrowserLogin.js');
    const result = await refreshManagedAccountLogin(account, site);

    expect(result).toBeNull();
    expect(getUserInfoMock).not.toHaveBeenCalled();
    expect(launchPersistentContextMock).not.toHaveBeenCalled();
    const updated = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(updated?.status).toBe('expired');
    expect(updated?.accessToken).toBe('session=still-valid');
  });


  it('times out a blocked AgentRouter account proxy and continues with the dedicated management proxy', async () => {
    process.env.METAPI_MANAGED_REFRESH_REQUEST_TIMEOUT_MS = '10';
    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'linuxdo_59260',
      accessToken: 'session=still-valid',
      apiToken: 'sk-existing',
      status: 'expired',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        platformUserId: 59260,
        proxyUrl: 'http://blocked-account-proxy:7890',
        agentRouterBalanceProxyUrl: 'http://management-proxy:7890',
        managedBrowserProfile: { enabled: true, provider: 'agentrouter', loginProvider: 'linuxdo' },
      }),
    }).returning().get();
    getUserInfoMock
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce({ username: 'linuxdo_59260', platformUserId: 59260 });

    await materializeStoredProfile(account, site);
    const { refreshManagedAccountLogin } = await import('./accountManagedBrowserLogin.js');
    const result = await Promise.race([
      refreshManagedAccountLogin(account, site),
      new Promise<'test-timeout'>((resolve) => setTimeout(() => resolve('test-timeout'), 150)),
    ]);

    expect(result).not.toBe('test-timeout');
    expect(result).toMatchObject({
      accessToken: 'session=still-valid',
      platformUserId: 59260,
      username: 'linuxdo_59260',
    });
    expect(getUserInfoMock).toHaveBeenCalledTimes(2);
    expect(launchPersistentContextMock).not.toHaveBeenCalled();
  });

  it('persists a verified Session and keeps the existing API token when token synchronization blocks', async () => {
    process.env.METAPI_MANAGED_REFRESH_REQUEST_TIMEOUT_MS = '10';
    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'linuxdo_59260',
      accessToken: 'session=verified',
      apiToken: 'sk-existing',
      status: 'expired',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        platformUserId: 59260,
        agentRouterBalanceProxyUrl: 'http://management-proxy:7890',
        managedBrowserProfile: { enabled: true, provider: 'agentrouter', loginProvider: 'linuxdo' },
      }),
    }).returning().get();
    getUserInfoMock.mockResolvedValueOnce({ username: 'linuxdo_59260', platformUserId: 59260 });
    getApiTokenMock.mockReturnValueOnce(new Promise(() => {}));

    await materializeStoredProfile(account, site);
    const { refreshManagedAccountLogin } = await import('./accountManagedBrowserLogin.js');
    const result = await Promise.race([
      refreshManagedAccountLogin(account, site),
      new Promise<'test-timeout'>((resolve) => setTimeout(() => resolve('test-timeout'), 150)),
    ]);

    expect(result).not.toBe('test-timeout');
    expect(result).toMatchObject({
      accessToken: 'session=verified',
      platformUserId: 59260,
      apiToken: null,
    });
    const updated = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(updated?.accessToken).toBe('session=verified');
    expect(updated?.apiToken).toBe('sk-existing');
    expect(updated?.status).toBe('active');
  });


  it('uses the AgentRouter staged Profile reader when direct management requests cannot pass WAF', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'linuxdo_59260',
      accessToken: 'session=stale-database-session',
      apiToken: 'sk-existing',
      status: 'expired',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        platformUserId: 59260,
        managedBrowserProfile: { enabled: true, provider: 'agentrouter', loginProvider: 'linuxdo' },
      }),
    }).returning().get();
    getUserInfoMock.mockResolvedValue(null);
    getApiTokenMock.mockResolvedValue(null);

    const close = vi.fn(async () => {});
    const discardProfile = vi.fn(async () => {});
    const finalize = vi.fn(async () => {});
    const rollback = vi.fn(async () => {});
    openAgentRouterBrowserMock.mockResolvedValueOnce({
      readCurrentUser: vi.fn(async () => ({
        id: 59260,
        username: 'linuxdo_59260',
        balanceInfo: { balance: -0.294956, used: 1675.294956, quota: 1675 },
      })),
      collectSession: vi.fn(async () => ({ accessToken: 'session=fresh-profile-session' })),
      close,
      commitProfile: vi.fn(async () => ({
        profileDir: join(dataDir, 'browser-profiles', 'accounts', 'agentrouter', String(account.id)),
        finalize,
        rollback,
      })),
      discardProfile,
    });

    await materializeStoredProfile(account, site);
    const { refreshManagedAccountLogin } = await import('./accountManagedBrowserLogin.js');
    const result = await refreshManagedAccountLogin(account, site);

    expect(result).toMatchObject({
      accessToken: 'session=fresh-profile-session',
      platformUserId: 59260,
      username: 'linuxdo_59260',
    });
    expect(openAgentRouterBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: account.id }),
      expect.objectContaining({ platform: 'agentrouter' }),
    );
    expect(launchPersistentContextMock).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(discardProfile).not.toHaveBeenCalled();

    const updated = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(updated?.accessToken).toBe('session=fresh-profile-session');
    expect(updated?.apiToken).toBe('sk-existing');
    expect(updated?.status).toBe('active');
    expect(updated?.extraConfig).toContain('recoveredFromAgentRouterBrowserSnapshot');
  });


  it('uses the AnyRouter staged Profile reader instead of falling into a blocked password form', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'AnyRouter',
      url: 'https://anyrouter.top',
      platform: 'anyrouter',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'sqjwrre24',
      accessToken: 'session=stored-anyrouter-session',
      apiToken: 'sk-existing-any',
      status: 'active',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        platformUserId: 200029,
        managedBrowserProfile: { enabled: true, provider: 'anyrouter' },
      }),
    }).returning().get();
    getUserInfoMock.mockResolvedValue(null);
    getApiTokenMock.mockResolvedValue(null);

    const close = vi.fn(async () => {});
    const discardProfile = vi.fn(async () => {});
    const finalize = vi.fn(async () => {});
    const rollback = vi.fn(async () => {});
    openAnyRouterBrowserMock.mockResolvedValueOnce({
      readCurrentUser: vi.fn(async () => ({
        id: 200029,
        username: 'sqjwrre24',
        balanceInfo: { balance: 61.147422, used: 838.852578, quota: 900 },
      })),
      collectSession: vi.fn(async () => ({ accessToken: 'session=fresh-anyrouter-profile-session' })),
      close,
      commitProfile: vi.fn(async () => ({
        profileDir: join(dataDir, 'browser-profiles', 'accounts', 'anyrouter', String(account.id)),
        finalize,
        rollback,
      })),
      discardProfile,
    });

    await materializeStoredProfile(account, site);
    const { refreshManagedAccountLogin } = await import('./accountManagedBrowserLogin.js');
    const result = await refreshManagedAccountLogin(account, site);

    expect(result).toMatchObject({
      accessToken: 'session=fresh-anyrouter-profile-session',
      platformUserId: 200029,
      username: 'sqjwrre24',
    });
    expect(openAnyRouterBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: account.id }),
      expect.objectContaining({ platform: 'anyrouter' }),
    );
    expect(launchPersistentContextMock).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(discardProfile).not.toHaveBeenCalled();

    const updated = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(updated?.accessToken).toBe('session=fresh-anyrouter-profile-session');
    expect(updated?.apiToken).toBe('sk-existing-any');
    expect(updated?.extraConfig).toContain('recoveredFromAnyRouterBrowserSnapshot');
  });

});
