import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const browserVerifyMock = vi.hoisted(() => vi.fn());
const browserProfileDiscardMock = vi.hoisted(() => vi.fn(async () => {}));
const persistManagedProfileMock = vi.hoisted(() => vi.fn());
const discardManagedProfileMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('./agentRouterSessionBrowserVerification.js', () => ({
  verifyAgentRouterSessionInBrowser: (...args: unknown[]) => browserVerifyMock(...args),
  discardAgentRouterSessionVerificationProfile: (...args: unknown[]) => browserProfileDiscardMock(...args),
}));

vi.mock('./accountManagedBrowserLogin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./accountManagedBrowserLogin.js')>();
  return {
    ...actual,
    persistManagedAccountBrowserProfile: (...args: unknown[]) => persistManagedProfileMock(...args),
    discardManagedAccountBrowserProfile: (...args: unknown[]) => discardManagedProfileMock(...args),
  };
});

type DbModule = typeof import('../db/index.js');

describe('manual account creation service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-manual-account-create-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
  });

  beforeEach(async () => {
    browserVerifyMock.mockReset();
    browserProfileDiscardMock.mockClear();
    persistManagedProfileMock.mockReset();
    discardManagedProfileMock.mockClear();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('removes the inserted account when browser Profile persistence fails', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const adapter = {
      verifyToken: vi.fn(async () => ({
        tokenType: 'session' as const,
        userInfo: { username: 'linuxdo_59260' },
      })),
    };
    const { createManualAccount } = await import('./manualAccountCreationService.js');

    await expect(createManualAccount({
      body: {
        siteId: site.id,
        accessToken: 'session=valid',
        credentialMode: 'session',
        skipModelFetch: true,
      },
      site,
      adapter: adapter as never,
      credentialMode: 'session',
      rawAccessToken: 'session=valid',
      prepareAccountForInitialization: async () => {
        throw new Error('profile_commit_failed');
      },
    })).rejects.toThrow('profile_commit_failed');

    await expect(db.select().from(schema.accounts).all()).resolves.toHaveLength(0);
  });


  it('removes the final AgentRouter Profile when account preparation fails after browser verification', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const adapter = {
      verifyToken: vi.fn(async () => ({ tokenType: 'unknown' as const })),
      getApiTokens: vi.fn(async () => []),
    };
    browserVerifyMock.mockResolvedValueOnce({
      accessToken: 'session=verified-browser-session',
      platformUserId: 51978,
      username: 'github_51978',
      profileDir: '/tmp/browser-profiles/session-verification/agentrouter/pending-failure',
      provider: 'agentrouter',
    });
    persistManagedProfileMock.mockImplementationOnce(async (_source, account) => (
      `/tmp/browser-profiles/accounts/agentrouter/${account.id}`
    ));
    const { createManualAccount } = await import('./manualAccountCreationService.js');

    await expect(createManualAccount({
      body: {
        siteId: site.id,
        accessToken: 'raw-session-from-devtools',
        platformUserId: 51978,
        credentialMode: 'session',
        skipModelFetch: true,
      },
      site,
      adapter: adapter as never,
      credentialMode: 'session',
      rawAccessToken: 'raw-session-from-devtools',
      prepareAccountForInitialization: async () => {
        throw new Error('account_prepare_failed');
      },
    })).rejects.toThrow('account_prepare_failed');

    await expect(db.select().from(schema.accounts).all()).resolves.toHaveLength(0);
    expect(discardManagedProfileMock).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/browser-profiles\/accounts\/agentrouter\/\d+$/));
    expect(browserProfileDiscardMock).toHaveBeenCalledWith(
      '/tmp/browser-profiles/session-verification/agentrouter/pending-failure',
    );
  });

  it('uses AgentRouter browser verification on direct timeout and persists the verified Profile', async () => {
    vi.useFakeTimers();
    const site = await db.insert(schema.sites).values({
      name: 'AgentRouter',
      url: 'https://agentrouter.org',
      platform: 'agentrouter',
    }).returning().get();
    const adapter = {
      verifyToken: vi.fn(() => new Promise(() => {})),
      getApiTokens: vi.fn(async () => []),
    };
    browserVerifyMock.mockResolvedValueOnce({
      accessToken: 'session=verified-browser-session',
      platformUserId: 51978,
      username: 'github_51978',
      balance: { balance: 925, used: 0, quota: 925 },
      profileDir: '/tmp/browser-profiles/session-verification/agentrouter/pending-create',
      provider: 'agentrouter',
    });
    persistManagedProfileMock.mockImplementationOnce(async (_source, account) => (
      `/tmp/browser-profiles/accounts/agentrouter/${account.id}`
    ));
    const { createManualAccount } = await import('./manualAccountCreationService.js');

    const creation = createManualAccount({
      body: {
        siteId: site.id,
        accessToken: 'raw-session-from-devtools',
        platformUserId: 51978,
        credentialMode: 'session',
        skipModelFetch: true,
      },
      site,
      adapter: adapter as never,
      credentialMode: 'session',
      rawAccessToken: 'raw-session-from-devtools',
    });
    await vi.advanceTimersByTimeAsync(10_100);
    const created = await creation;

    expect(created.account.accessToken).toBe('session=verified-browser-session');
    expect(created.account.username).toBe('github_51978');
    const extra = JSON.parse(created.account.extraConfig || '{}');
    expect(extra).toMatchObject({
      credentialMode: 'session',
      platformUserId: 51978,
      managedBrowserProfile: {
        enabled: true,
        provider: 'agentrouter',
        createdFrom: 'manual-session-browser-verification',
      },
    });
    expect(extra.managedBrowserProfile.profileDir).toBe(`/tmp/browser-profiles/accounts/agentrouter/${created.account.id}`);
    expect(persistManagedProfileMock).toHaveBeenCalledWith(
      '/tmp/browser-profiles/session-verification/agentrouter/pending-create',
      expect.objectContaining({ id: created.account.id }),
      expect.objectContaining({ platform: 'agentrouter' }),
    );
    vi.useRealTimers();
  });

});
