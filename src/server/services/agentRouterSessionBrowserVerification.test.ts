import { describe, expect, it, vi } from 'vitest';

const launchNativeContextMock = vi.hoisted(() => vi.fn());

vi.mock('./site-auth/targetSiteBrowserSession.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    launchTargetProfileNativeContext: launchNativeContextMock,
  };
});

describe('AgentRouter browser Session verification', () => {
  it('injects a raw F12 Session value into an isolated Profile and reads the real user', async () => {
    const page = {
      setExtraHTTPHeaders: vi.fn(async () => {}),
      goto: vi.fn(async () => ({
        status: () => 200,
        ok: () => true,
        headers: () => ({ 'content-type': 'application/json; charset=utf-8' }),
      })),
      locator: vi.fn(() => ({ innerText: vi.fn(async () => JSON.stringify({
        success: true,
        data: {
          id: 51978,
          username: 'github_51978',
          quota: 462_500_000,
          used_quota: 0,
        },
      })) })),
    };
    const context = {
      addCookies: vi.fn(async () => {}),
      cookies: vi.fn(async () => [{ name: 'session', value: 'raw-session', domain: 'agentrouter.org' }]),
      close: vi.fn(async () => {}),
    };
    launchNativeContextMock.mockResolvedValueOnce({ context, page });

    const { verifyAgentRouterSessionInBrowser } = await import('./agentRouterSessionBrowserVerification.js');
    const result = await verifyAgentRouterSessionInBrowser({
      site: { platform: 'agentrouter', url: 'https://agentrouter.org' } as never,
      accessToken: 'raw-session',
      platformUserId: 51978,
    });

    expect(context.addCookies).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ name: 'session', value: 'raw-session', domain: 'agentrouter.org' }),
    ]));
    expect(page.setExtraHTTPHeaders).toHaveBeenCalledWith(expect.objectContaining({
      'New-API-User': '51978',
    }));
    expect(result).toMatchObject({
      accessToken: 'session=raw-session',
      platformUserId: 51978,
      username: 'github_51978',
      balance: { quota: 925 },
    });
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a Session that resolves to a different AgentRouter user', async () => {
    const page = {
      setExtraHTTPHeaders: vi.fn(async () => {}),
      goto: vi.fn(async () => ({
        status: () => 200,
        ok: () => true,
        headers: () => ({ 'content-type': 'application/json' }),
      })),
      locator: vi.fn(() => ({ innerText: vi.fn(async () => JSON.stringify({
        success: true,
        data: { id: 60000, username: 'wrong-user', quota: 1, used_quota: 2 },
      })) })),
    };
    const context = {
      addCookies: vi.fn(async () => {}),
      cookies: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    };
    launchNativeContextMock.mockResolvedValueOnce({ context, page });

    const { verifyAgentRouterSessionInBrowser } = await import('./agentRouterSessionBrowserVerification.js');
    await expect(verifyAgentRouterSessionInBrowser({
      site: { platform: 'agentrouter', url: 'https://agentrouter.org' } as never,
      accessToken: 'raw-session',
      platformUserId: 51978,
    })).rejects.toThrow('profile_account_mismatch');
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
