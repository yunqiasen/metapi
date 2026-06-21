import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { launchPersistentContextMock, getAdapterMock, getApiTokenMock } = vi.hoisted(() => ({
  launchPersistentContextMock: vi.fn(),
  getAdapterMock: vi.fn(),
  getApiTokenMock: vi.fn(),
}));

vi.mock('./browserAutomationRuntime.js', () => ({
  loadChromiumBrowserType: vi.fn(async () => ({
    launchPersistentContext: launchPersistentContextMock,
  })),
}));

vi.mock('./platforms/index.js', () => ({
  getAdapter: getAdapterMock,
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
    getAdapterMock.mockReturnValue({ getApiToken: getApiTokenMock });
    getApiTokenMock.mockResolvedValue('sk-profile-refresh');
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('refreshes an AgentRouter account from saved browser profile without saved password', async () => {
    const page = {
      setViewportSize: vi.fn(async () => {}),
      goto: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({ id: 166081, username: 'github_166081' })),
    };
    const context = {
      pages: vi.fn(() => [page]),
      newPage: vi.fn(async () => page),
      cookies: vi.fn(async () => [
        { name: 'session', value: 'fresh-session', domain: 'agentrouter.org' },
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
        managedBrowserProfile: { enabled: true, provider: 'agentrouter' },
      }),
    }).returning().get();

    const { refreshManagedAccountLogin } = await import('./accountManagedBrowserLogin.js');
    const result = await refreshManagedAccountLogin(account, site);

    expect(result).toMatchObject({
      accessToken: 'session=fresh-session',
      platformUserId: 166081,
      username: 'github_166081',
      apiToken: 'sk-profile-refresh',
    });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(launchPersistentContextMock).toHaveBeenCalledTimes(1);
    const updated = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(updated?.accessToken).toBe('session=fresh-session');
    expect(updated?.status).toBe('active');
  });
});
