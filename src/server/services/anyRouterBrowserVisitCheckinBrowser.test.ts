import { describe, expect, it, vi } from 'vitest';
import {
  parseAnyRouterSignInPayload,
  readAnyRouterUserWithOptionalLogin,
  readAnyRouterUserWithRetry,
  resolveAnyRouterBrowserProxyUrl,
  selectTargetSessionCookies,
  triggerAnyRouterSignIn,
} from './anyRouterBrowserVisitCheckinBrowser.js';

describe('AnyRouter browser proxy selection', () => {
  it('keeps the AnyRouter browser on its generic routed proxy when AgentRouter has a dedicated fixed egress', () => {
    const environment = {
      AGENTROUTER_BROWSER_PROXY_URL: 'http://agent-fixed-proxy:7891',
      SITE_AUTH_BROWSER_PROXY_URL: 'http://site-browser-proxy:7890',
    };

    expect(resolveAnyRouterBrowserProxyUrl(null, environment)).toBe('http://site-browser-proxy:7890');
    expect(resolveAnyRouterBrowserProxyUrl(
      JSON.stringify({ proxyUrl: 'http://account-proxy:8080' }),
      environment,
    )).toBe('http://account-proxy:8080');
  });
});

describe('AnyRouter browser visit', () => {
  it('normalizes successful, already-signed and failed sign-in responses', () => {
    expect(parseAnyRouterSignInPayload({ success: true, message: '' })).toEqual({
      success: true,
      message: '',
      alreadyCheckedIn: true,
    });
    expect(parseAnyRouterSignInPayload({ success: false, message: '今日已签到' })).toEqual({
      success: true,
      message: '今日已签到',
      alreadyCheckedIn: true,
    });
    expect(parseAnyRouterSignInPayload({ success: false, message: 'session expired' })).toEqual({
      success: false,
      message: 'session expired',
      alreadyCheckedIn: false,
    });
  });

  it('posts the real sign-in endpoint with the authenticated user header', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ success: true, message: '签到成功' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const page = {
      evaluate: vi.fn(async (callback: (input: { url: string; id: number }) => Promise<unknown>, input: { url: string; id: number }) => callback(input)),
    };

    await expect(triggerAnyRouterSignIn(page as never, 'https://anyrouter.top', 182711)).resolves.toMatchObject({
      success: true,
      alreadyCheckedIn: false,
    });
    expect(fetchMock).toHaveBeenCalledWith('https://anyrouter.top/api/user/sign_in', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: expect.objectContaining({
        'New-API-User': '182711',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/json',
      }),
    }));
    vi.unstubAllGlobals();
  });

  it('retries when the WAF challenge reload destroys the page execution context', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation'))
      .mockResolvedValueOnce({
        id: 182711,
        username: 'linuxdo_182711',
        balanceInfo: { balance: 540.228796, used: 234.771204, quota: 775 },
      });

    await expect(readAnyRouterUserWithRetry(read, { attempts: 2, delayMs: 0 })).resolves.toMatchObject({
      id: 182711,
      balanceInfo: { balance: 540.228796 },
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('retries a transient initial read before deciding that provider login is required', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation'))
      .mockResolvedValueOnce({
        id: 182711,
        username: 'linuxdo_182711',
        balanceInfo: { balance: 540.228796, used: 234.771204, quota: 775 },
      });
    const login = vi.fn(async () => {});

    await expect(readAnyRouterUserWithOptionalLogin(read, login, { attempts: 2, delayMs: 0 })).resolves.toMatchObject({
      id: 182711,
      balanceInfo: { quota: 775 },
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(login).not.toHaveBeenCalled();
  });

  it('retries the sign-in request when a WAF navigation replaces the execution context', async () => {
    const page = {
      evaluate: vi.fn()
        .mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation'))
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          payload: { success: false, message: '今日已签到' },
          text: JSON.stringify({ success: false, message: '今日已签到' }),
        }),
    };

    await expect(triggerAnyRouterSignIn(
      page as never,
      'https://anyrouter.top',
      182711,
      { attempts: 2, delayMs: 0 },
    )).resolves.toMatchObject({
      success: true,
      alreadyCheckedIn: true,
    });
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });


  it('selects the stored target session without forwarding WAF-only cookies', () => {
    expect(selectTargetSessionCookies('acw_tc=waf; acw_sc__v2=challenge; session=target; jwt_token=jwt')).toEqual([
      { name: 'session', value: 'target' },
      { name: 'jwt_token', value: 'jwt' },
    ]);
  });

  it('invokes the supplied recovery callback when the Profile no longer has a target session', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 1752, balanceInfo: { balance: 500, used: 0, quota: 500 } });
    const login = vi.fn(async () => {});

    const user = await readAnyRouterUserWithOptionalLogin(read, login, { attempts: 1, delayMs: 0 });

    expect(login).toHaveBeenCalledTimes(1);
    expect(user?.id).toBe(1752);
  });
});

describe('AnyRouter self-response classification', () => {
  it('distinguishes an expired target session from a WAF HTML response', async () => {
    const module = await import('./anyRouterBrowserVisitCheckinBrowser.js') as Record<string, any>;
    const parse = module.parseAnyRouterUserResponse;

    expect(parse?.({
      status: 401,
      ok: false,
      contentType: 'application/json',
      payload: { success: false, message: '未登录' },
      text: '{"success":false}',
    })).toBeNull();
    expect(() => parse?.({
      status: 200,
      ok: true,
      contentType: 'application/json',
      payload: { success: true, data: { id: 182711, username: 'linuxdo_182711' } },
      text: '{}',
    })).toThrow('anyrouter_balance_missing');
    expect(() => parse?.({
      status: 200,
      ok: true,
      contentType: 'text/html; charset=utf-8',
      payload: null,
      text: '<script>document.cookie="acw_sc__v2=challenge"</script>',
    })).toThrow('anyrouter_waf_response');
  });
});

describe('AnyRouter read-only balance fallback', () => {
  it('exports a browser Profile balance reader for balance refresh isolation', async () => {
    const module = await import('./anyRouterBrowserVisitCheckinBrowser.js') as Record<string, unknown>;
    expect(typeof module.readAnyRouterBalanceFromProfile).toBe('function');
  });
});
