import { describe, expect, it, vi } from 'vitest';
import {
  executeAgentRouterReloginCheckin,
  readAgentRouterBalanceWithProxyFallback,
  readAgentRouterUserWithRetry,
  resolveAgentRouterBalanceProxyCandidates,
} from './agentRouterReloginCheckinService.js';

function createFixture(options: {
  beforeUser?: { id: number; username: string; balanceInfo?: { balance: number; used: number; quota: number } } | null;
  anonymousUser?: { id: number; username: string } | null;
  afterUser?: { id: number; username: string } | null;
  callbackUserId?: number;
  checkedIn?: boolean;
  loginError?: Error;
  preflightError?: Error;
  oauthUser?: { id: number; username: string; balanceInfo: { balance: number; used: number; quota: number } };
  accountBalance?: number;
  accountUsed?: number;
  accountQuota?: number;
  fallbackBalance?: { balance: number; used: number; quota: number } | null;
  fallbackBalances?: Array<{ balance: number; used: number; quota: number } | null>;
  lastCheckinAt?: string | null;
} = {}) {
  const calls: string[] = [];
  const users = [
    options.beforeUser === undefined ? {
      id: 59260,
      username: 'linuxdo_59260',
      balanceInfo: { balance: 813.116486, used: 511.883514, quota: 1325 },
    } : options.beforeUser,
    options.anonymousUser === undefined ? null : options.anonymousUser,
    options.afterUser === undefined ? {
      id: 59260,
      username: 'linuxdo_59260',
      balanceInfo: { balance: 838.116486, used: 511.883514, quota: 1350 },
    } : options.afterUser,
  ];
  const close = vi.fn(async () => { calls.push('close'); });
  const rollback = vi.fn(async () => { calls.push('rollback-profile'); });
  const finalize = vi.fn(async () => { calls.push('finalize-profile'); });
  const discard = vi.fn(async () => { calls.push('discard-profile'); });
  const persist = vi.fn(async () => { calls.push('persist'); });
  const invalidate = vi.fn(async () => { calls.push('invalidate-old-session'); });
  const session = {
    readCurrentUser: vi.fn(async () => {
      calls.push(users.length === 3 ? 'verify-before' : users.length === 2 ? 'verify-anonymous' : 'verify-same-user');
      return users.shift() ?? null;
    }),
    preflightProviderSession: vi.fn(async () => {
      calls.push('preflight-provider');
      if (options.preflightError) throw options.preflightError;
    }),
    logout: vi.fn(async () => { calls.push('logout'); }),
    loginWithProvider: vi.fn(async () => {
      calls.push('oauth');
      if (options.loginError) throw options.loginError;
      return {
        platformUserId: options.callbackUserId ?? 59260,
        ...(options.checkedIn === undefined ? { checkedIn: true } : { checkedIn: options.checkedIn }),
        ...(options.oauthUser ? { user: options.oauthUser } : {}),
      };
    }),
    collectSession: vi.fn(async () => {
      calls.push('collect-session');
      return { accessToken: 'session=fresh' };
    }),
    close,
    commitProfile: vi.fn(async () => {
      calls.push('commit-profile');
      return { profileDir: '/profiles/94', rollback, finalize };
    }),
    discardProfile: discard,
  };
  const fallbackBalances = [...(options.fallbackBalances || [])];
  const readBalance = vi.fn(async () => {
    calls.push('read-balance-fallback');
    return fallbackBalances.length > 0 ? fallbackBalances.shift() ?? null : options.fallbackBalance ?? null;
  });
  const deps = {
    openBrowser: vi.fn(async () => { calls.push('open'); return session; }),
    persist,
    readBalance,
    invalidate,
  };
  const account = {
    id: 94,
    username: 'linuxdo_59260',
    accessToken: 'session=old',
    status: 'active',
    balance: options.accountBalance ?? 813.116486,
    balanceUsed: options.accountUsed ?? 511.883514,
    quota: options.accountQuota ?? 1325,
    lastCheckinAt: options.lastCheckinAt ?? null,
    extraConfig: JSON.stringify({
      platformUserId: 59260,
      managedBrowserProfile: { enabled: true, loginProvider: 'linuxdo' },
    }),
  };
  const site = { id: 9, platform: 'agentrouter', url: 'https://agentrouter.org' };
  return { calls, close, rollback, finalize, discard, persist, invalidate, readBalance, deps, account, site };
}

describe('AgentRouter balance proxy fallback', () => {
  it('prefers the Profile-bound proxy and falls back to the dedicated balance proxy', async () => {
    const candidates = resolveAgentRouterBalanceProxyCandidates(JSON.stringify({
      proxyUrl: 'http://profile-proxy:7890',
      agentRouterBalanceProxyUrl: 'http://balance-proxy:7890',
    }), {});
    const calls: Array<string | undefined> = [];

    const result = await readAgentRouterBalanceWithProxyFallback(candidates, async (proxyUrl) => {
      calls.push(proxyUrl);
      if (proxyUrl === 'http://profile-proxy:7890') throw new Error('upstream_html_response');
      return { balance: 775, used: 0, quota: 775 };
    });

    expect(candidates.slice(0, 2)).toEqual([
      'http://profile-proxy:7890',
      'http://balance-proxy:7890',
    ]);
    expect(calls).toEqual([
      'http://profile-proxy:7890',
      'http://balance-proxy:7890',
    ]);
    expect(result).toEqual({ balance: 775, used: 0, quota: 775 });
  });


  it('times out a stalled Profile route and continues with the dedicated balance proxy', async () => {
    const candidates = ['http://profile-proxy:7890', 'http://balance-proxy:7890'];
    const calls: Array<string | undefined> = [];

    const result = await Promise.race([
      readAgentRouterBalanceWithProxyFallback(candidates, async (proxyUrl) => {
        calls.push(proxyUrl);
        if (proxyUrl === 'http://profile-proxy:7890') return new Promise(() => {});
        return { balance: 775, used: 0, quota: 775 };
      }, { timeoutMs: 10 }),
      new Promise<'test-timeout'>((resolve) => setTimeout(() => resolve('test-timeout'), 150)),
    ]);

    expect(result).not.toBe('test-timeout');
    expect(result).toEqual({ balance: 775, used: 0, quota: 775 });
    expect(calls).toEqual(candidates);
  });
});

describe('executeAgentRouterReloginCheckin', () => {

  it('revalidates a manual same-day click against the live target before reporting already checked in', async () => {
    const fixture = createFixture({
      lastCheckinAt: new Date().toISOString(),
      accountBalance: 700,
      accountUsed: 0,
      accountQuota: 700,
      beforeUser: {
        id: 59260,
        username: 'linuxdo_59260',
        balanceInfo: { balance: 700, used: 0, quota: 700 },
      },
    });

    const result = await executeAgentRouterReloginCheckin(
      fixture.account as never,
      fixture.site as never,
      fixture.deps as never,
    );

    expect(result).toMatchObject({
      success: false,
      alreadyCheckedIn: true,
      checkedIn: true,
      credentialsRefreshed: true,
      message: '已签到，额度无新增，当前总额度 700',
      balanceInfo: { balance: 700, used: 0, quota: 700 },
    });
    expect(fixture.calls).toEqual([
      'open', 'verify-before', 'collect-session', 'close',
      'commit-profile', 'persist', 'finalize-profile',
    ]);
    expect(fixture.calls).not.toContain('logout');
    expect(fixture.calls).not.toContain('oauth');
    expect(fixture.persist).toHaveBeenCalledWith(expect.objectContaining({
      checkedIn: true,
      user: expect.objectContaining({
        id: 59260,
        balanceInfo: { balance: 700, used: 0, quota: 700 },
      }),
    }));
  });

  it('retries the post-OAuth self lookup while the target session is settling', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 59260, username: 'linuxdo_59260' });

    await expect(readAgentRouterUserWithRetry(read, { attempts: 2, delayMs: 0 })).resolves.toEqual({
      id: 59260,
      username: 'linuxdo_59260',
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('uses the secondary route as the pre-login baseline and still performs OAuth', async () => {
    const fixture = createFixture({
      accountQuota: 800,
      beforeUser: null,
      afterUser: null,
      fallbackBalances: [
        { balance: 900, used: 0, quota: 900 },
        { balance: 925, used: 0, quota: 925 },
      ],
    });

    const result = await executeAgentRouterReloginCheckin(
      fixture.account as never,
      fixture.site as never,
      fixture.deps as never,
      { confirmationAttempts: 1, confirmationDelayMs: 0 },
    );

    expect(result).toMatchObject({
      success: true,
      reward: '总额度 +25',
      balanceInfo: { quota: 925 },
    });
    expect(fixture.readBalance).toHaveBeenCalledTimes(2);
    expect(fixture.readBalance).toHaveBeenNthCalledWith(1, expect.objectContaining({ accessToken: 'session=old' }));
    expect(fixture.readBalance).toHaveBeenNthCalledWith(2, expect.objectContaining({ accessToken: 'session=fresh' }));
    expect(fixture.calls).toContain('logout');
    expect(fixture.calls).toContain('oauth');
  });

  it('uses the live pre-login quota as baseline when the stored quota is stale', async () => {
    const fixture = createFixture({
      accountQuota: 0,
      beforeUser: {
        id: 59260,
        username: 'linuxdo_59260',
        balanceInfo: { balance: 1750, used: 150, quota: 1900 },
      },
      afterUser: {
        id: 59260,
        username: 'linuxdo_59260',
        balanceInfo: { balance: 1775, used: 150, quota: 1925 },
      } as never,
    });

    const result = await executeAgentRouterReloginCheckin(
      fixture.account as never,
      fixture.site as never,
      fixture.deps as never,
      { confirmationAttempts: 1, confirmationDelayMs: 0 },
    );

    expect(result).toMatchObject({
      success: true,
      reward: '总额度 +25',
      balanceInfo: { quota: 1925 },
    });
    expect(fixture.calls).toContain('logout');
    expect(fixture.calls).toContain('oauth');
  });

  it('accepts the live quota increase triggered by authenticated self without repeating OAuth', async () => {
    const fixture = createFixture({
      accountQuota: 1325,
      beforeUser: {
        id: 59260,
        username: 'linuxdo_59260',
        balanceInfo: { balance: 838.116486, used: 511.883514, quota: 1350 },
      },
    });

    const result = await executeAgentRouterReloginCheckin(
      fixture.account as never,
      fixture.site as never,
      fixture.deps as never,
      { confirmationAttempts: 1, confirmationDelayMs: 0 },
    );

    expect(result).toMatchObject({
      success: true,
      checkedIn: true,
      credentialsRefreshed: true,
      reward: '总额度 +25',
      message: 'AgentRouter 签到成功：总额度 +25，当前总额度 1350',
      balanceInfo: { quota: 1350 },
    });
    expect(fixture.calls).toEqual([
      'open', 'verify-before', 'collect-session', 'close',
      'commit-profile', 'persist', 'finalize-profile',
    ]);
    expect(fixture.calls).not.toContain('preflight-provider');
    expect(fixture.calls).not.toContain('logout');
    expect(fixture.calls).not.toContain('oauth');
  });

  it('returns balance captured in the authenticated browser response', async () => {
    const fixture = createFixture({
      afterUser: {
        id: 59260,
        username: 'linuxdo_59260',
        balanceInfo: { balance: 838.116486, used: 511.883514, quota: 1350 },
      } as never,
    });

    const result = await executeAgentRouterReloginCheckin(fixture.account as never, fixture.site as never, fixture.deps as never);

    expect(result).toMatchObject({
      success: true,
      reward: '总额度 +25',
      balanceInfo: { balance: 838.116486, used: 511.883514, quota: 1350 },
    });
    expect(fixture.persist).toHaveBeenCalledWith(expect.objectContaining({
      user: expect.objectContaining({ balanceInfo: expect.objectContaining({ balance: 838.116486 }) }),
    }));
  });

  it('uses the OAuth callback balance when the post-login self request is blocked', async () => {
    const fixture = createFixture({
      afterUser: null,
      oauthUser: {
        id: 59260,
        username: 'linuxdo_59260',
        balanceInfo: { balance: 838.116486, used: 511.883514, quota: 1350 },
      },
    });

    const result = await executeAgentRouterReloginCheckin(
      fixture.account as never,
      fixture.site as never,
      fixture.deps as never,
      { confirmationAttempts: 1, confirmationDelayMs: 0 },
    );

    expect(result).toMatchObject({
      success: true,
      checkedIn: true,
      reward: '总额度 +25',
      balanceInfo: { quota: 1350 },
    });
    expect(fixture.persist).toHaveBeenCalledWith(expect.objectContaining({
      user: expect.objectContaining({ id: 59260, balanceInfo: expect.objectContaining({ quota: 1350 }) }),
    }));
  });

  it('confirms the post-OAuth quota through the secondary route when browser self is blocked', async () => {
    const fixture = createFixture({
      afterUser: null,
      fallbackBalance: { balance: 825, used: 0, quota: 825 },
      beforeUser: {
        id: 59260,
        username: 'linuxdo_59260',
        balanceInfo: { balance: 800, used: 0, quota: 800 },
      },
    });

    const result = await executeAgentRouterReloginCheckin(
      fixture.account as never,
      fixture.site as never,
      fixture.deps as never,
      { confirmationAttempts: 1, confirmationDelayMs: 0 },
    );

    expect(result).toMatchObject({
      success: true,
      checkedIn: true,
      reward: '总额度 +25',
      balanceInfo: { quota: 825 },
    });
    expect(fixture.readBalance).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'session=fresh' }));
    expect(fixture.persist).toHaveBeenCalledWith(expect.objectContaining({
      user: expect.objectContaining({ id: 59260, balanceInfo: { balance: 825, used: 0, quota: 825 } }),
    }));
  });

  it('can reauthenticate from an expired target-site session when the provider profile is still available', async () => {
    const fixture = createFixture({ beforeUser: null });

    const result = await executeAgentRouterReloginCheckin(fixture.account as never, fixture.site as never, fixture.deps as never);

    expect(result).toMatchObject({ success: true, checkedIn: true });
    expect(fixture.calls).toContain('oauth');
    expect(fixture.persist).toHaveBeenCalledTimes(1);
  });

  it('runs logout and same-account OAuth reauthentication before committing credentials', async () => {
    const fixture = createFixture();

    const result = await executeAgentRouterReloginCheckin(fixture.account as never, fixture.site as never, fixture.deps as never);

    expect(result).toMatchObject({ success: true, checkedIn: true });
    expect(fixture.calls).toEqual([
      'open', 'verify-before', 'preflight-provider', 'logout', 'verify-anonymous', 'oauth', 'verify-same-user',
      'collect-session', 'close', 'commit-profile', 'persist', 'finalize-profile',
    ]);
  });

  it('preflights the saved provider before logout and preserves the target Session when it is expired', async () => {
    const fixture = createFixture({ preflightError: new Error('provider_session_expired') });

    const result = await executeAgentRouterReloginCheckin(
      fixture.account as never,
      fixture.site as never,
      fixture.deps as never,
    );

    expect(result).toMatchObject({ success: false, message: 'provider_session_expired' });
    expect(fixture.calls).toEqual([
      'open', 'verify-before', 'preflight-provider', 'close', 'discard-profile',
    ]);
    expect(fixture.calls).not.toContain('logout');
    expect(fixture.calls).not.toContain('oauth');
    expect(fixture.invalidate).not.toHaveBeenCalled();
    expect(fixture.persist).not.toHaveBeenCalled();
  });

  it('fails when logout does not produce an anonymous state', async () => {
    const fixture = createFixture({ anonymousUser: { id: 59260, username: 'linuxdo_59260' } });

    const result = await executeAgentRouterReloginCheckin(fixture.account as never, fixture.site as never, fixture.deps as never);

    expect(result.success).toBe(false);
    expect(result.message).toContain('logout_not_confirmed');
    expect(fixture.persist).not.toHaveBeenCalled();
    expect(fixture.calls).toContain('close');
    expect(fixture.calls).toContain('discard-profile');
  });

  it.each(['provider_session_expired', 'oauth_timeout'])('preserves stored credentials when staged OAuth fails with %s', async (code) => {
    const fixture = createFixture({ loginError: new Error(code) });

    const result = await executeAgentRouterReloginCheckin(fixture.account as never, fixture.site as never, fixture.deps as never);

    expect(result).toMatchObject({ success: false, message: code });
    expect(fixture.persist).not.toHaveBeenCalled();
    expect(fixture.invalidate).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.discard).toHaveBeenCalledTimes(1);
  });

  it('rejects a different callback account without committing profile or database', async () => {
    const fixture = createFixture({ callbackUserId: 99999, afterUser: { id: 99999, username: 'linuxdo_99999' } });

    const result = await executeAgentRouterReloginCheckin(fixture.account as never, fixture.site as never, fixture.deps as never);

    expect(result.message).toBe('oauth_callback_account_mismatch');
    expect(fixture.persist).not.toHaveBeenCalled();
    expect(fixture.calls).not.toContain('commit-profile');
  });

  it('distinguishes a post-OAuth self mismatch from a callback mismatch', async () => {
    const fixture = createFixture({
      callbackUserId: 59260,
      afterUser: {
        id: 99999,
        username: 'linuxdo_99999',
        balanceInfo: { balance: 25, used: 0, quota: 25 },
      } as never,
    });

    const result = await executeAgentRouterReloginCheckin(
      fixture.account as never,
      fixture.site as never,
      fixture.deps as never,
      { confirmationAttempts: 1, confirmationDelayMs: 0 },
    );

    expect(result.message).toBe('post_oauth_account_mismatch');
    expect(fixture.persist).not.toHaveBeenCalled();
  });

  it('does not report success when OAuth reports no check-in and quota is unchanged', async () => {
    const fixture = createFixture({
      checkedIn: false,
      afterUser: {
        id: 59260,
        username: 'linuxdo_59260',
        balanceInfo: { balance: 813.116486, used: 511.883514, quota: 1325 },
      } as never,
    });

    const result = await executeAgentRouterReloginCheckin(fixture.account as never, fixture.site as never, fixture.deps as never);

    expect(result).toMatchObject({ success: false, checkedIn: false });
    expect(result.reward).toBeUndefined();
    expect(result.message).not.toContain('签到成功');
  });

  it('accepts a positive quota delta when the callback checked-in flag is stale', async () => {
    const fixture = createFixture({ checkedIn: false });

    const result = await executeAgentRouterReloginCheckin(fixture.account as never, fixture.site as never, fixture.deps as never);

    expect(result).toMatchObject({
      success: true,
      checkedIn: true,
      reward: '总额度 +25',
      balanceInfo: { quota: 1350 },
    });
  });

  it('saves the new credentials but ignores a zero quota snapshot instead of overwriting a positive baseline', async () => {
    const fixture = createFixture({
      beforeUser: {
        id: 59260,
        username: 'linuxdo_59260',
        balanceInfo: { balance: 800, used: 0, quota: 800 },
      },
      afterUser: {
        id: 59260,
        username: 'linuxdo_59260',
        balanceInfo: { balance: 0, used: 0, quota: 0 },
      } as never,
    });

    const result = await executeAgentRouterReloginCheckin(
      fixture.account as never,
      fixture.site as never,
      fixture.deps as never,
      { confirmationAttempts: 1, confirmationDelayMs: 0 },
    );

    expect(result).toMatchObject({
      success: false,
      credentialsRefreshed: true,
      reasonCode: 'agentrouter_balance_unconfirmed',
    });
    expect(result.balanceInfo).toBeUndefined();
    expect(fixture.persist).toHaveBeenCalledWith(expect.objectContaining({
      user: expect.not.objectContaining({ balanceInfo: expect.anything() }),
      session: { accessToken: 'session=fresh' },
    }));
  });

  it('continues OAuth and saves fresh credentials when the previous quota baseline is missing', async () => {
    const fixture = createFixture({
      accountQuota: 0,
      beforeUser: null,
      afterUser: {
        id: 59260,
        username: 'linuxdo_59260',
        balanceInfo: { balance: 1750, used: 150, quota: 1900 },
      } as never,
    });

    const result = await executeAgentRouterReloginCheckin(
      fixture.account as never,
      fixture.site as never,
      fixture.deps as never,
      { confirmationAttempts: 1, confirmationDelayMs: 0 },
    );

    expect(result).toMatchObject({
      success: false,
      checkedIn: true,
      credentialsRefreshed: true,
      reasonCode: 'agentrouter_previous_quota_missing',
      balanceInfo: { quota: 1900 },
    });
    expect(result.reward).toBeUndefined();
    expect(fixture.calls).toContain('oauth');
    expect(fixture.persist).toHaveBeenCalledWith(expect.objectContaining({
      session: { accessToken: 'session=fresh' },
      user: expect.objectContaining({ id: 59260, balanceInfo: expect.objectContaining({ quota: 1900 }) }),
    }));
    expect(fixture.finalize).toHaveBeenCalledTimes(1);
    expect(fixture.discard).not.toHaveBeenCalled();
  });

  it('keeps the fresh OAuth Session and Profile when the balance response is blocked', async () => {
    const fixture = createFixture({
      afterUser: null,
      fallbackBalance: null,
      checkedIn: true,
    });

    const result = await executeAgentRouterReloginCheckin(
      fixture.account as never,
      fixture.site as never,
      fixture.deps as never,
      { confirmationAttempts: 1, confirmationDelayMs: 0 },
    );

    expect(result).toMatchObject({
      success: false,
      checkedIn: true,
      credentialsRefreshed: true,
      reasonCode: 'agentrouter_balance_unconfirmed',
    });
    expect(result.message).toContain('保存新凭证');
    expect(result.reward).toBeUndefined();
    expect(fixture.persist).toHaveBeenCalledWith(expect.objectContaining({
      session: { accessToken: 'session=fresh' },
      checkedIn: true,
      user: expect.objectContaining({ id: 59260 }),
    }));
    expect(fixture.finalize).toHaveBeenCalledTimes(1);
    expect(fixture.rollback).not.toHaveBeenCalled();
    expect(fixture.discard).not.toHaveBeenCalled();
  });

  it('does not report success when checked_in is true but the total quota remains unchanged', async () => {
    const unchanged = {
      id: 59260,
      username: 'linuxdo_59260',
      balanceInfo: { balance: 813.116486, used: 511.883514, quota: 1325 },
    };
    const fixture = createFixture({ afterUser: unchanged });

    const result = await executeAgentRouterReloginCheckin(
      fixture.account as never,
      fixture.site as never,
      fixture.deps as never,
      { confirmationAttempts: 1, confirmationDelayMs: 0 },
    );

    expect(result).toMatchObject({
      success: false,
      checkedIn: true,
      reasonCode: 'agentrouter_checkin_unconfirmed_quota_unchanged',
      balanceInfo: { quota: 1325 },
    });
    expect(result.reward).toBeUndefined();
  });


  it('treats a negative available balance as a credible same-day total-quota snapshot', async () => {
    const fixture = createFixture({
      lastCheckinAt: new Date().toISOString(),
      accountBalance: -0.294956,
      accountUsed: 1675.294956,
      accountQuota: 1675,
      beforeUser: {
        id: 59260,
        username: 'linuxdo_59260',
        balanceInfo: { balance: -0.294956, used: 1675.294956, quota: 1675 },
      },
    });

    const result = await executeAgentRouterReloginCheckin(
      fixture.account as never,
      fixture.site as never,
      fixture.deps as never,
      { confirmationAttempts: 1, confirmationDelayMs: 0 },
    );

    expect(result).toMatchObject({
      success: false,
      alreadyCheckedIn: true,
      checkedIn: true,
      balanceInfo: { balance: -0.294956, used: 1675.294956, quota: 1675 },
      message: '已签到，额度无新增，当前总额度 1675',
    });
    expect(fixture.calls).not.toContain('logout');
    expect(fixture.calls).not.toContain('oauth');
  });

  it('rolls back the committed profile when database persistence fails', async () => {
    const fixture = createFixture();
    fixture.persist.mockImplementationOnce(async () => { fixture.calls.push('persist'); throw new Error('db failed'); });

    const result = await executeAgentRouterReloginCheckin(fixture.account as never, fixture.site as never, fixture.deps as never);

    expect(result.success).toBe(false);
    expect(fixture.rollback).toHaveBeenCalledTimes(1);
    expect(fixture.finalize).not.toHaveBeenCalled();
  });
});
