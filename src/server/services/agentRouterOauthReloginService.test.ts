import { describe, expect, it, vi } from 'vitest';
import { executeAgentRouterOauthRelogin } from './agentRouterOauthReloginService.js';

vi.mock('../db/index.js', () => ({
  db: {
    update: () => ({ set: () => ({ where: () => ({ run: async () => {} }) }) }),
  },
  schema: { accounts: { id: 'id' } },
}));

vi.mock('./siteProxy.js', () => ({
  withSiteRecordProxyRequestInit: (_site: unknown, options: Record<string, unknown>) => options,
}));

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string>; setCookie?: string[] } = {}) {
  const headers = new Headers(init.headers || {});
  (headers as any).getSetCookie = () => init.setCookie || [];
  return {
    status: init.status ?? 200,
    headers,
    text: async () => JSON.stringify(body),
  };
}

function htmlResponse(html: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers || {});
  (headers as any).getSetCookie = () => [];
  return {
    status: init.status ?? 200,
    headers,
    text: async () => html,
  };
}

const account = {
  id: 1,
  siteId: 25,
  username: 'github_166363',
  accessToken: 'session=old-token',
  apiToken: null,
  balance: 250,
  balanceUsed: 1073,
  quota: 1323,
  status: 'active',
  extraConfig: JSON.stringify({ platformUserId: 166363 }),
} as any;

const site = {
  id: 25,
  name: 'Agentrouter',
  url: 'https://agentrouter.org',
  platform: 'agentrouter',
} as any;

function buildFetch(routes: Record<string, (url: string, options: any) => any>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, options: any = {}) => {
    calls.push(url);
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.startsWith(pattern)) return handler(url, options);
    }
    throw new Error(`unexpected url: ${url}`);
  };
  return { calls, fetchImpl: fetchImpl as any };
}

const happyRoutes = {
  'https://agentrouter.org/api/oauth/state': () =>
    jsonResponse({ success: true, data: 'state-1' }, { setCookie: ['session=state-cookie; Path=/'] }),
  'https://agentrouter.org/api/status': () =>
    jsonResponse({ success: true, data: { github_client_id: 'cid-1' } }),
  'https://github.com/login/oauth/authorize': () =>
    htmlResponse('', {
      status: 302,
      headers: { location: 'https://agentrouter.org/api/oauth/github?code=code-1&state=state-1' },
    }),
  'https://agentrouter.org/api/oauth/github': () =>
    jsonResponse(
      { success: true, data: { checked_in: true } },
      { setCookie: ['session=new-token; Path=/; HttpOnly'] },
    ),
  'https://agentrouter.org/api/user/self': (_url: string, options: any) =>
    jsonResponse({ success: true, data: { id: 166363, username: 'github_166363', quota: options.headers.Cookie === 'session=old-token' ? 137500000 : 150000000, used_quota: 500000000 } }),
};

describe('executeAgentRouterOauthRelogin', () => {
  it('completes the oauth relogin chain and persists the fresh session', async () => {
    const persist = vi.fn(async () => {});
    const { calls, fetchImpl } = buildFetch(happyRoutes);
    const result = await executeAgentRouterOauthRelogin(
      { account, site, provider: 'github', providerCookie: 'user_session=gh' },
      { fetchImpl, persist },
    );

    expect(result.success).toBe(true);
    expect(result.checkedIn).toBe(true);
    expect(result.credentialsRefreshed).toBe(true);
    expect(result.balanceInfo?.quota).toBe(1300);
    expect(calls[0]).toBe('https://agentrouter.org/api/user/self');
    expect(calls[1]).toBe('https://agentrouter.org/api/oauth/state');
    expect(calls[3]).toContain('https://github.com/login/oauth/authorize?client_id=cid-1');
    expect(calls[4]).toBe('https://agentrouter.org/api/oauth/github?code=code-1&state=state-1');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      sessionToken: 'session=new-token',
      username: 'github_166363',
      apiToken: null,
    });
  });

  it('handles the real frontend callback and carries state Cookie only to the site API', async () => {
    const requests: Array<{ url: string; options: any }> = [];
    const persist = vi.fn(async () => {});
    const fetchImpl = async (url: string, options: any = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/api/oauth/state')) return jsonResponse({ success: true, data: 'state-live' }, { setCookie: ['session=state-session; Path=/; HttpOnly'] });
      if (url.endsWith('/api/status')) return happyRoutes['https://agentrouter.org/api/status']();
      if (url.startsWith('https://github.com/')) return htmlResponse('', { status: 302, headers: { location: 'https://agentrouter.org/oauth/github?code=c&state=state-live' } });
      if (url.includes('/api/oauth/github?')) {
        expect(options.headers.Cookie).toContain('session=state-session');
        expect(options.headers.Cookie).not.toContain('user_session');
        return happyRoutes['https://agentrouter.org/api/oauth/github']();
      }
      if (url.endsWith('/api/user/self')) return jsonResponse({ success: true, data: { id: 166363, username: 'github_166363', quota: 150000000, used_quota: 500000000 } });
      throw new Error('unexpected frontend request');
    };
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist });
    expect(result.credentialsRefreshed, result.message).toBe(true);
    expect(result).toMatchObject({ success: false, quotaUnchanged: true, reward: '0' });
    expect(requests.some(x => new URL(x.url).pathname === '/oauth/github')).toBe(false);
    expect(persist).toHaveBeenCalledOnce();
    expect(requests.every(x => x.options.signal instanceof AbortSignal)).toBe(true);
  });

  it('reports provider HTTP 502 as a network failure, not an expired Cookie', async () => {
    const { fetchImpl } = buildFetch({ ...happyRoutes, 'https://github.com/login/oauth/authorize': () => htmlResponse('<html>Bad Gateway</html>', { status: 502 }) });
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist: async () => {} });
    expect(result.reasonCode).toBe('provider_http_error');
    expect(result.message).toContain('502');
    expect(result.message).not.toContain('登录态已失效');
  });

  it('does not send provider cookies to an unexpected redirect origin', async () => {
    const { fetchImpl, calls } = buildFetch({ ...happyRoutes, 'https://github.com/login/oauth/authorize': () => htmlResponse('', { status: 302, headers: { location: 'https://other.example/login' } }) });
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist: async () => {} });
    expect(result.reasonCode).toBe('provider_redirect_invalid');
    expect(calls.some(x => x.startsWith('https://other.example'))).toBe(false);
  });

  it('rejects a callback whose state differs from this login flow', async () => {
    const { fetchImpl, calls } = buildFetch({ ...happyRoutes, 'https://github.com/login/oauth/authorize': () => htmlResponse('', { status: 302, headers: { location: 'https://agentrouter.org/oauth/github?code=c&state=wrong' } }) });
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist: async () => {} });
    expect(result.reasonCode).toBe('oauth_state_mismatch');
    expect(calls.some(x => x.includes('/api/oauth/github?'))).toBe(false);
  });

  it('preserves old credentials if the new Session identity cannot be verified', async () => {
    const persist = vi.fn(async () => {});
    const { fetchImpl } = buildFetch({ ...happyRoutes, 'https://agentrouter.org/api/user/self': () => jsonResponse({ success: false, message: 'session expired' }) });
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist });
    expect(result.success).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it('reports provider_session_expired when the provider returns a login page', async () => {
    const { fetchImpl } = buildFetch({
      ...happyRoutes,
      'https://github.com/login/oauth/authorize': () =>
        htmlResponse('<html><body>Sign in to GitHub</body></html>'),
    });
    const result = await executeAgentRouterOauthRelogin(
      { account, site, provider: 'github', providerCookie: 'bad-cookie' },
      { fetchImpl, persist: async () => {} },
    );
    expect(result.success).toBe(false);
    expect(result.reasonCode).toBe('provider_session_expired');
    expect(result.message).toContain('登录态已失效');
  });

  it('reports provider_authorization_required on consent pages', async () => {
    const { fetchImpl } = buildFetch({
      ...happyRoutes,
      'https://github.com/login/oauth/authorize': () =>
        htmlResponse('<html><body>Authorize application<form><button>Authorize</button></form></body></html>'),
    });
    const result = await executeAgentRouterOauthRelogin(
      { account, site, provider: 'github', providerCookie: 'user_session=gh' },
      { fetchImpl, persist: async () => {} },
    );
    expect(result.success).toBe(false);
    expect(result.reasonCode).toBe('provider_authorization_required');
  });

  it('follows intermediate provider redirects until the site callback', async () => {
    const { fetchImpl } = buildFetch({
      'https://agentrouter.org/api/oauth/state': happyRoutes['https://agentrouter.org/api/oauth/state'],
      'https://agentrouter.org/api/status': happyRoutes['https://agentrouter.org/api/status'],
      'https://github.com/login/oauth/authorize/next': () =>
        htmlResponse('', {
          status: 302,
          headers: { location: 'https://agentrouter.org/api/oauth/github?code=code-2&state=state-1' },
        }),
      'https://github.com/login/oauth/authorize': () =>
        htmlResponse('', { status: 302, headers: { location: '/login/oauth/authorize/next' } }),
      'https://agentrouter.org/api/oauth/github': happyRoutes['https://agentrouter.org/api/oauth/github'],
      'https://agentrouter.org/api/user/self': happyRoutes['https://agentrouter.org/api/user/self'],
    });
    const persist = vi.fn(async () => {});
    const result = await executeAgentRouterOauthRelogin(
      { account, site, provider: 'github', providerCookie: 'user_session=gh' },
      { fetchImpl, persist },
    );
    expect(result.success).toBe(true);
    expect(persist.mock.calls[0]?.[0]?.sessionToken).toBe('session=new-token');
  });

  it('drops the new session when the callback lands on a different account', async () => {
    const persist = vi.fn(async () => {});
    const { fetchImpl } = buildFetch({
      ...happyRoutes,
      'https://agentrouter.org/api/user/self': () =>
        jsonResponse({ success: true, data: { id: 999, username: 'github_999' } }),
    });
    const result = await executeAgentRouterOauthRelogin(
      { account, site, provider: 'github', providerCookie: 'user_session=gh' },
      { fetchImpl, persist },
    );
    expect(result.success).toBe(false);
    expect(result.reasonCode).toBe('account_mismatch');
    expect(persist).not.toHaveBeenCalled();
  });

  it('fails when the site callback does not issue a session cookie', async () => {
    const { fetchImpl } = buildFetch({
      ...happyRoutes,
      'https://agentrouter.org/api/oauth/github': () =>
        jsonResponse({ success: true, data: {} }),
    });
    const result = await executeAgentRouterOauthRelogin(
      { account, site, provider: 'github', providerCookie: 'user_session=gh' },
      { fetchImpl, persist: async () => {} },
    );
    expect(result.success).toBe(false);
    expect(result.reasonCode).toBe('session_cookie_missing');
  });

  it('uses the linuxdo authorize endpoint for linuxdo accounts', async () => {
    const { calls, fetchImpl } = buildFetch({
      'https://agentrouter.org/api/oauth/state': () =>
        jsonResponse({ success: true, data: 'state-9' }, { setCookie: ['session=ld-state; Path=/'] }),
      'https://agentrouter.org/api/status': () =>
        jsonResponse({ success: true, data: { linuxdo_client_id: 'ld-1' } }),
      'https://connect.linux.do/oauth2/authorize': () =>
        htmlResponse('', {
          status: 302,
          headers: { location: 'https://agentrouter.org/api/oauth/linuxdo?code=c-9&state=state-9' },
        }),
      'https://agentrouter.org/api/oauth/linuxdo': () =>
        jsonResponse({ success: true, data: {} }, { setCookie: ['session=ld-token; Path=/'] }),
      'https://agentrouter.org/api/user/self': happyRoutes['https://agentrouter.org/api/user/self'],
    });
    const result = await executeAgentRouterOauthRelogin(
      { account, site, provider: 'linuxdo', providerCookie: 'linuxdo-cookie' },
      { fetchImpl, persist: async () => {} },
    );
    expect(result.success).toBe(true);
    expect(calls[3]).toContain('https://connect.linux.do/oauth2/authorize?response_type=code&client_id=ld-1');
  });

  it('bounds a stalled provider request and retains the old Session', async () => {
    const persist = vi.fn(async () => {});
    const { fetchImpl: normalFetch } = buildFetch(happyRoutes);
    const fetchImpl = async (url: string, options: any = {}) => {
      if (!url.startsWith('https://github.com/')) return normalFetch(url, options);
      return new Promise<any>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    };
    const start = Date.now();
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist, requestTimeoutMs: 40 });
    expect(result.reasonCode).toBe('provider_request_failed');
    expect(Date.now() - start).toBeLessThan(1000);
    expect(persist).not.toHaveBeenCalled();
  });

  it('normalizes an imported bare Session before reading the pre-login quota', async () => {
    const { fetchImpl: normalFetch } = buildFetch(happyRoutes);
    const fetchImpl = async (url: string, options: any = {}) => {
      if (url.endsWith('/api/user/self') && options.headers.Cookie !== 'session=new-token') {
        if (options.headers.Cookie !== 'session=old-token') return jsonResponse({ success: false }, { status: 401 });
      }
      return normalFetch(url, options);
    };
    const result = await executeAgentRouterOauthRelogin({ account: { ...account, accessToken: 'old-token' }, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist: async () => {} });
    expect(result, result.message).toMatchObject({ success: true, reward: '25' });
  });

  it('keeps the display alias and API key while refreshing only the verified Session', async () => {
    const persist = vi.fn(async () => {});
    const { fetchImpl } = buildFetch(happyRoutes);
    const result = await executeAgentRouterOauthRelogin({ account: { ...account, username: 'G2', apiToken: 'unchanged-key', quota: 9999 }, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist });
    expect(result).toMatchObject({ success: true, reward: '25' });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ username: 'G2', apiToken: 'unchanged-key', sessionToken: 'session=new-token' }));
  });

  it('requires a platform user id to guard identity', async () => {
    const noIdAccount = { ...account, username: 'plain-name', extraConfig: '{}' };
    const result = await executeAgentRouterOauthRelogin(
      { account: noIdAccount, site, provider: 'github', providerCookie: 'x' },
      { fetchImpl: (async () => { throw new Error('should not fetch'); }) as any, persist: async () => {} },
    );
    expect(result.success).toBe(false);
    expect(result.reasonCode).toBe('platform_user_id_missing');
  });
});


describe('AgentRouter identity response diagnostics', () => {
  it('identifies a slider page without claiming an expired session or a confirmed reward', async () => {
    const persist = vi.fn(async () => {});
    const { fetchImpl } = buildFetch({
      ...happyRoutes,
      'https://agentrouter.org/api/user/self': (_url, options) => options.headers.Cookie === 'session=new-token'
        ? htmlResponse('<html><script src="aliyunCaptcha.js"></script><div id="aliyun_waf_aa"></div></html>')
        : happyRoutes['https://agentrouter.org/api/user/self'](_url, options),
    });
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist });
    expect(result.success).toBe(false);
    expect(result.message).toContain('阿里云滑块');
    expect(result.message).toContain('到账待确认');
    expect(result.reward).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('AgentRouter official callback identity snapshot', () => {
  const callbackUser = { id: 166363, username: 'github_166363', quota: 150000000, used_quota: 500000000, checked_in: true };

  it('uses the complete callback identity without an unnecessary second self request', async () => {
    const persist = vi.fn(async () => {});
    const { calls, fetchImpl } = buildFetch({
      ...happyRoutes,
      'https://agentrouter.org/api/oauth/github': () => jsonResponse({ success: true, data: callbackUser }, { setCookie: ['session=new-token; Path=/; HttpOnly'] }),
      'https://agentrouter.org/api/user/self': (url, options) => options.headers.Cookie === 'session=old-token'
        ? happyRoutes['https://agentrouter.org/api/user/self'](url, options)
        : htmlResponse('<html><div id="aliyun_waf_aa"></div></html>'),
    });
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist });
    expect(result).toMatchObject({ success: true, reward: '25', credentialsRefreshed: true });
    expect(calls.filter(url => url.endsWith('/api/user/self'))).toHaveLength(1);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: 'session=new-token' }));
  });

  it('saves the verified callback session but leaves reward pending when the pre-login self read is challenged', async () => {
    const persist = vi.fn(async () => {});
    const { calls, fetchImpl } = buildFetch({
      ...happyRoutes,
      'https://agentrouter.org/api/oauth/github': () => jsonResponse({ success: true, data: callbackUser }, { setCookie: ['session=new-token; Path=/'] }),
      'https://agentrouter.org/api/user/self': () => htmlResponse('<html><div id="aliyun_waf_aa"></div></html>'),
    });
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist });
    expect(result).toMatchObject({ success: false, credentialsRefreshed: true, checkedIn: true, rewardPending: true });
    expect(result.reward).toBeUndefined();
    expect(result.balanceInfo?.quota).toBe(1300);
    expect(calls.filter(url => url.endsWith('/api/user/self'))).toHaveLength(1);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('rejects a different callback identity even when the old Session still belongs to the expected account', async () => {
    const persist = vi.fn(async () => {});
    const { fetchImpl } = buildFetch({
      ...happyRoutes,
      'https://agentrouter.org/api/oauth/github': () => jsonResponse({ success: true, data: { ...callbackUser, id: 999 } }, { setCookie: ['session=new-token; Path=/'] }),
    });
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist });
    expect(result).toMatchObject({ success: false, reasonCode: 'account_mismatch' });
    expect(persist).not.toHaveBeenCalled();
  });
  it('does not call an unrelated quota increase a check-in reward when the callback explicitly reports no check-in', async () => {
    const { fetchImpl } = buildFetch({
      ...happyRoutes,
      'https://agentrouter.org/api/oauth/github': () => jsonResponse({ success: true, data: { ...callbackUser, checked_in: false } }, { setCookie: ['session=new-token; Path=/'] }),
    });
    const persist = vi.fn(async () => {});
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist });
    expect(result).toMatchObject({ success: false, checkedIn: false, credentialsRefreshed: true, rewardPending: true });
    expect(result.reward).toBeUndefined();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('checks an incomplete callback quota against the new Session rather than substituting zero', async () => {
    const { fetchImpl, calls } = buildFetch({
      ...happyRoutes,
      'https://agentrouter.org/api/oauth/github': () => jsonResponse({ success: true, data: { id: 166363, checked_in: true } }, { setCookie: ['session=new-token; Path=/'] }),
    });
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist: async () => {} });
    expect(result).toMatchObject({ success: true, reward: '25' });
    expect(calls.filter(url => url.endsWith('/api/user/self'))).toHaveLength(2);
  });

  it('uses the LinuxDO callback snapshot and keeps cookies on their correct origins', async () => {
    const { fetchImpl, calls } = buildFetch({
      ...happyRoutes,
      'https://agentrouter.org/api/status': () => jsonResponse({ success: true, data: { linuxdo_client_id: 'ld-1' } }),
      'https://connect.linux.do/oauth2/authorize': (_url, options) => {
        expect(options.headers.Cookie).toBe('linux_do_cdk_session_id=fixture');
        return htmlResponse('', { status: 302, headers: { location: 'https://agentrouter.org/oauth/linuxdo?code=c&state=state-1' } });
      },
      'https://agentrouter.org/api/oauth/linuxdo': (_url, options) => {
        expect(options.headers.Cookie).toBe('session=state-cookie');
        return jsonResponse({ success: true, data: callbackUser }, { setCookie: ['session=ld-new-token; Path=/'] });
      },
    });
    const persist = vi.fn(async () => {});
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'linuxdo', providerCookie: 'linux_do_cdk_session_id=fixture' }, { fetchImpl, persist });
    expect(result).toMatchObject({ success: true, reward: '25' });
    expect(calls.filter(url => url.endsWith('/api/user/self'))).toHaveLength(1);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: 'session=ld-new-token' }));
  });

  it('preserves the saved balance when a sparse OAuth DTO defaults both quota fields to zero and self is challenged', async () => {
    const persist = vi.fn(async () => {});
    const { fetchImpl, calls } = buildFetch({
      ...happyRoutes,
      'https://agentrouter.org/api/oauth/github': () => jsonResponse({ success: true, data: { ...callbackUser, quota: 0, used_quota: 0 } }, { setCookie: ['session=new-token; Path=/'] }),
      'https://agentrouter.org/api/user/self': () => htmlResponse('<html><div id="aliyun_waf_aa"></div></html>'),
    });
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist });
    expect(result).toMatchObject({ success: false, credentialsRefreshed: true, rewardPending: true, reasonCode: 'balance_after_unavailable' });
    expect(result.balanceInfo).toBeUndefined();
    expect(result.reward).toBeUndefined();
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ sessionToken: 'session=new-token', balanceInfo: null }));
    expect(calls.filter(url => url.endsWith('/api/user/self'))).toHaveLength(1);
  });

  it('reads real post-login quota when a sparse callback has only identity and the previous self endpoint worked', async () => {
    const persist = vi.fn(async () => {});
    const { fetchImpl, calls } = buildFetch({
      ...happyRoutes,
      'https://agentrouter.org/api/oauth/github': () => jsonResponse({ success: true, data: { ...callbackUser, quota: 0, used_quota: 0 } }, { setCookie: ['session=new-token; Path=/'] }),
    });
    const result = await executeAgentRouterOauthRelogin({ account, site, provider: 'github', providerCookie: 'user_session=gh' }, { fetchImpl, persist });
    expect(result).toMatchObject({ success: true, reward: '25', balanceInfo: { quota: 1300 } });
    expect(calls.filter(url => url.endsWith('/api/user/self'))).toHaveLength(2);
  });

});
