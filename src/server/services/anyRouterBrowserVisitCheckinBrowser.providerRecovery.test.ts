import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  installBridge: vi.fn(async () => {}),
  advanceProvider: vi.fn(),
  resolveFingerprint: vi.fn(async () => 'seed'),
}));

vi.mock('./browserAutomationRuntime.js', () => ({
  resolvePersistentBrowserFingerprintSeed: mocks.resolveFingerprint,
}));

vi.mock('./agentRouterReloginBrowser.js', () => ({
  commitAgentRouterReauthProfile: vi.fn(),
  resolveAgentRouterBrowserProxyUrl: vi.fn(() => undefined),
  classifyAgentRouterOauthPageFailure: vi.fn(() => null),
}));

vi.mock('./site-auth/targetSiteBrowserSession.js', () => ({
  parseTargetSessionCookieHeader: vi.fn(() => []),
  buildTargetSessionCookieHeader: vi.fn(() => 'session=fresh'),
  launchTargetProfileCloakContext: mocks.launch,
  installStandaloneOauthNavigationBridge: mocks.installBridge,
  advanceTargetProviderLogin: mocks.advanceProvider,
  clickProviderConsentIfPresent: vi.fn(async () => false),
}));

describe('AnyRouter provider profile recovery', () => {
  let dataDir = '';
  const originalDataDir = process.env.DATA_DIR;

  afterEach(async () => {
    mocks.launch.mockReset();
    mocks.installBridge.mockClear();
    mocks.advanceProvider.mockReset();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = '';
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    vi.resetModules();
  });

  it('uses the saved LinuxDO profile when the target-site session is absent', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'metapi-any-provider-'));
    process.env.DATA_DIR = dataDir;
    const accountId = 93001;
    await mkdir(join(dataDir, 'browser-profiles', 'accounts', 'anyrouter', String(accountId)), { recursive: true });

    let recovered = false;
    const page = {
      url: vi.fn(() => 'https://anyrouter.top/login'),
      goto: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      locator: vi.fn(() => ({ innerText: vi.fn(async () => '') })),
      title: vi.fn(async () => ''),
      evaluate: vi.fn(async () => recovered
        ? {
            status: 200,
            ok: true,
            contentType: 'application/json',
            payload: { success: true, data: { id: 182711, username: 'linuxdo_182711', quota: 400_000_000, used_quota: 150_000_000 } },
            text: '{}',
          }
        : {
            status: 401,
            ok: false,
            contentType: 'application/json',
            payload: { success: false, message: '未登录' },
            text: '{}',
          }),
    };
    const context = {
      pages: vi.fn(() => [page]),
      addCookies: vi.fn(async () => {}),
      addInitScript: vi.fn(async () => {}),
      cookies: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    };
    mocks.launch.mockResolvedValue({ context, page });
    mocks.advanceProvider.mockImplementation(async () => { recovered = true; });

    const { openAnyRouterVisitBrowser } = await import('./anyRouterBrowserVisitCheckinBrowser.js');
    const session = await openAnyRouterVisitBrowser({
      id: accountId,
      username: 'linuxdo_182711',
      accessToken: 'acw_sc__v2=expired',
      extraConfig: JSON.stringify({
        platformUserId: 182711,
        managedBrowserProfile: { enabled: true, loginProvider: 'linuxdo' },
      }),
    } as never, {
      platform: 'anyrouter',
      url: 'https://anyrouter.top',
    } as never);

    await expect(session.readCurrentUser()).resolves.toMatchObject({
      id: 182711,
      balanceInfo: { quota: 1100 },
    });
    expect(mocks.installBridge).toHaveBeenCalledTimes(1);
    expect(mocks.advanceProvider).toHaveBeenCalledWith(
      page,
      'linuxdo',
      { loginUrl: 'https://anyrouter.top/login', targetSiteUrl: 'https://anyrouter.top' },
    );
    await session.close();
    await session.discardProfile();
  }, 15_000);
});
