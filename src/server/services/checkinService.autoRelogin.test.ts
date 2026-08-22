import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterMock = {
  checkinMode: 'standard' as 'standard' | 'browser-reauth' | 'browser-visit' | 'browser-visit-fallback',
  checkin: vi.fn(),
  login: vi.fn(),
};

const notifyMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const refreshBalanceMock = vi.fn();
const decryptPasswordMock = vi.fn();
const refreshManagedAccountLoginMock = vi.fn();
const executeAgentRouterReloginCheckinMock = vi.fn();
const executeAnyRouterBrowserVisitCheckinMock = vi.fn();

const selectAllMock = vi.fn();
const insertValuesMock = vi.fn();
const updateSetMock = vi.fn();

vi.mock('../db/index.js', () => {
  const selectChain = {
    all: () => selectAllMock(),
    where: () => selectChain,
    innerJoin: () => selectChain,
    from: () => selectChain,
  };

  const insertChain = {
    run: () => ({}),
    values: (...args: unknown[]) => {
      insertValuesMock(...args);
      return insertChain;
    },
  };

  const updateWhereChain = {
    run: () => ({}),
  };

  const updateSetChain = {
    where: () => updateWhereChain,
  };

  return {
    db: {
      select: () => selectChain,
      insert: () => insertChain,
      update: () => ({
        set: (updates: Record<string, unknown>) => {
          updateSetMock(updates);
          return updateSetChain;
        },
      }),
    },
    schema: {
      accounts: { id: 'id', siteId: 'siteId', checkinEnabled: 'checkinEnabled', status: 'status' },
      sites: { id: 'id' },
      checkinLogs: {},
      events: {},
    },
  };
});

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => adapterMock,
}));

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => notifyMock(...args),
}));

vi.mock('./alertService.js', () => ({
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('./balanceService.js', () => ({
  refreshBalance: (...args: unknown[]) => refreshBalanceMock(...args),
}));

vi.mock('./accountCredentialService.js', () => ({
  decryptAccountPassword: (...args: unknown[]) => decryptPasswordMock(...args),
}));

vi.mock('./accountManagedBrowserLogin.js', () => ({
  refreshManagedAccountLogin: (...args: unknown[]) => refreshManagedAccountLoginMock(...args),
  hasStoredAccountBrowserProfile: (account: { extraConfig?: unknown }) => {
    try {
      const extra = typeof account.extraConfig === 'string'
        ? JSON.parse(account.extraConfig)
        : account.extraConfig;
      return extra?.managedBrowserProfile?.enabled === true;
    } catch {
      return false;
    }
  },
}));

vi.mock('./anyRouterBrowserVisitCheckinService.js', () => ({
  executeAnyRouterBrowserVisitCheckin: (...args: unknown[]) => executeAnyRouterBrowserVisitCheckinMock(...args),
}));

vi.mock('./agentRouterReloginCheckinService.js', () => ({
  executeAgentRouterReloginCheckin: (...args: unknown[]) => executeAgentRouterReloginCheckinMock(...args),
}));

describe('checkinService auto relogin', () => {
  beforeEach(() => {
    adapterMock.checkinMode = 'standard';
    adapterMock.checkin.mockReset();
    adapterMock.login.mockReset();
    notifyMock.mockReset();
    reportTokenExpiredMock.mockReset();
    refreshBalanceMock.mockReset();
    decryptPasswordMock.mockReset();
    refreshManagedAccountLoginMock.mockReset();
    executeAgentRouterReloginCheckinMock.mockReset();
    executeAnyRouterBrowserVisitCheckinMock.mockReset();
    selectAllMock.mockReset();
    insertValuesMock.mockReset();
    updateSetMock.mockReset();
  });

  it('waits for the account lease before reading the database and starting check-in', async () => {
    selectAllMock.mockReturnValue([{
      accounts: {
        id: 78,
        username: 'locked-checkin',
        accessToken: 'session=active',
        status: 'active',
        balance: 10,
        extraConfig: JSON.stringify({ platformUserId: 78, credentialMode: 'session' }),
      },
      sites: { id: 8, name: 'Locked', url: 'https://locked.example', platform: 'new-api' },
    }]);
    adapterMock.checkin.mockResolvedValue({ success: true, message: 'checked in', reward: '余额 +1' });
    refreshBalanceMock.mockResolvedValue({ balance: 11, used: 0, quota: 11 });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holding = new Promise<void>((resolve) => { started = resolve; });
    const { withAccountBrowserProfileLease } = await import('./accountBrowserProfileLease.js');
    const { checkinAccount } = await import('./checkinService.js');
    const holder = withAccountBrowserProfileLease(78, async () => {
      started();
      await gate;
    });
    await holding;

    const checkin = checkinAccount(78);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(selectAllMock).not.toHaveBeenCalled();
    expect(adapterMock.checkin).not.toHaveBeenCalled();

    release();
    await holder;
    await expect(checkin).resolves.toMatchObject({ success: true, status: 'success' });
  });

  it('refreshes AnyRouter browser credentials before using the real-page fallback', async () => {
    selectAllMock.mockReturnValue([{
      accounts: {
        id: 21, username: 'any-main', accessToken: 'session=stale', status: 'active', balance: 475,
        extraConfig: JSON.stringify({ platformUserId: 1001, managedBrowserProfile: { enabled: true } }),
      },
      sites: { id: 8, name: 'AnyRouter', url: 'https://anyrouter.top', platform: 'anyrouter' },
    }]);
    adapterMock.checkinMode = 'browser-visit-fallback';
    adapterMock.checkin
      .mockResolvedValueOnce({ success: false, message: 'platform_user_id_missing' })
      .mockResolvedValueOnce({ success: false, message: 'upstream_html_response' });
    refreshManagedAccountLoginMock.mockResolvedValueOnce({
      accessToken: 'session=fresh; acw_sc__v2=solved',
      platformUserId: 2202,
      extraConfig: JSON.stringify({ platformUserId: 2202, managedBrowserProfile: { enabled: true } }),
    });
    executeAnyRouterBrowserVisitCheckinMock.mockResolvedValueOnce({
      success: true, message: 'AnyRouter 页面登录签到已确认（余额 +25）', reward: '余额 +25',
      balanceInfo: { balance: 500, used: 0, quota: 500 },
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(21);

    expect(result.success).toBe(true);
    expect(adapterMock.checkin).toHaveBeenCalledTimes(2);
    expect(refreshManagedAccountLoginMock).toHaveBeenCalledTimes(1);
    expect(executeAnyRouterBrowserVisitCheckinMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 21, accessToken: expect.stringContaining('session=fresh'), extraConfig: expect.stringContaining('2202') }),
      expect.objectContaining({ platform: 'anyrouter' }),
    );
  });

  it('retries checkin once after auto relogin when access token is missing', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 1,
          username: 'linuxdo_7659',
          accessToken: 'expired-token',
          status: 'active',
          extraConfig: JSON.stringify({
            autoRelogin: { username: 'linuxdo_7659', passwordCipher: 'cipher' },
          }),
        },
        sites: {
          id: 3,
          name: 'kfc',
          url: 'https://kfc-api.sxxe.net',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin
      .mockResolvedValueOnce({ success: false, message: '无权进行此操作，未登录且未提供 access token' })
      .mockResolvedValueOnce({ success: true, message: 'checked in' });
    decryptPasswordMock.mockReturnValue('plain-password');
    adapterMock.login.mockResolvedValue({ success: true, accessToken: 'fresh-token' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(1);

    expect(result.success).toBe(true);
    expect(adapterMock.login).toHaveBeenCalledTimes(1);
    expect(adapterMock.checkin).toHaveBeenCalledTimes(2);
    expect(adapterMock.checkin.mock.calls[0][1]).toBe('expired-token');
    expect(adapterMock.checkin.mock.calls[1][1]).toBe('fresh-token');
    expect(adapterMock.checkin.mock.calls[0][2]).toBe(7659);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fresh-token' }));
  });

  it('passes guessed platform user id when config does not include it', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 2,
          username: 'linuxdo_11494',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 4,
          name: 'wong',
          url: 'https://wzw.pp.ua',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: true, message: 'checked in' });

    const { checkinAccount } = await import('./checkinService.js');
    await checkinAccount(2);

    expect(adapterMock.checkin).toHaveBeenCalledTimes(1);
    expect(adapterMock.checkin.mock.calls[0][2]).toBe(11494);
  });

  it('keeps successful checkin as success when message is 签到成功', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 12,
          username: 'linuxdo_5566',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 12,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: true, message: '签到成功' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(12);

    expect(result.success).toBe(true);
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('success');
  });

  it('infers reward from balance delta when checkin reward text is empty', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 13,
          username: 'linuxdo_7788',
          accessToken: 'token',
          status: 'active',
          balance: 10,
          extraConfig: null,
        },
        sites: {
          id: 13,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: true, message: 'checkin success' });
    refreshBalanceMock.mockResolvedValue({ balance: 12.5, used: 0, quota: 12.5 });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(13);

    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.reward).toBe('余额 +2.5');
    expect(firstInsertPayload?.message).toContain('余额 +2.5');
    expect(result).toMatchObject({
      success: true,
      reward: '余额 +2.5',
      balanceInfo: { balance: 12.5, used: 0, quota: 12.5 },
    });
    expect(result.message).toContain('余额 +2.5');
  });

  it('treats already checked in responses as successful checkins', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 9,
          username: 'linuxdo_9999',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 9,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: false, message: '今天已经签到过啦' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(9);

    expect(result.success).toBe(true);
    expect(result.status).toBe('success');
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('success');
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('keeps an explicit browser check-in with unchanged quota out of the success state', async () => {
    selectAllMock.mockReturnValue([{
      accounts: {
        id: 24,
        username: 'any-main',
        accessToken: 'session=fresh',
        status: 'active',
        balance: 475,
        quota: 850,
        extraConfig: JSON.stringify({ platformUserId: 2202, managedBrowserProfile: { enabled: true } }),
      },
      sites: {
        id: 24,
        name: 'AnyRouter',
        url: 'https://anyrouter.top',
        platform: 'anyrouter',
      },
    }]);
    adapterMock.checkinMode = 'browser-visit';
    executeAnyRouterBrowserVisitCheckinMock.mockResolvedValueOnce({
      success: false,
      alreadyCheckedIn: true,
      message: '已签到，额度无新增，当前总额度 850',
      balanceInfo: { balance: 475, used: 375, quota: 850 },
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(24);

    expect(result).toMatchObject({
      success: false,
      status: 'skipped',
      skipped: true,
      balanceInfo: { quota: 850 },
    });
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload).toMatchObject({ status: 'skipped', reward: undefined });
    expect(updateSetMock).not.toHaveBeenCalledWith(expect.objectContaining({ lastCheckinAt: expect.any(String) }));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('does not advance lastCheckinAt for already checked in responses in interval mode', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 16,
          username: 'interval-user',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 16,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: false, message: '今天已经签到过啦' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(16, { scheduleMode: 'interval' });

    expect(result.success).toBe(true);
    expect(result.status).toBe('success');
    expect(updateSetMock).not.toHaveBeenCalledWith(expect.objectContaining({ lastCheckinAt: expect.any(String) }));
  });

  it('advances lastCheckinAt when interval mode gets a direct success', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 17,
          username: 'interval-success',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 17,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: true, message: '签到成功' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(17, { scheduleMode: 'interval' });

    expect(result.success).toBe(true);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ lastCheckinAt: expect.any(String) }));
  });


  it('uses the protocol check-in for AgentRouter password accounts without a browser Profile', async () => {
    selectAllMock.mockReturnValue([{
      accounts: {
        id: 25,
        username: 'password-agent',
        accessToken: 'session=active',
        status: 'active',
        balance: 10,
        extraConfig: JSON.stringify({
          platformUserId: 166081,
          autoRelogin: { username: 'password-agent', passwordCipher: 'cipher' },
        }),
      },
      sites: {
        id: 25,
        name: 'AgentRouter',
        url: 'https://agentrouter.org',
        platform: 'agentrouter',
      },
    }]);
    adapterMock.checkinMode = 'browser-reauth';
    adapterMock.checkin.mockResolvedValueOnce({ success: true, message: '签到成功', reward: '余额 +1' });
    executeAgentRouterReloginCheckinMock.mockResolvedValueOnce({ success: false, message: 'browser_should_not_run' });
    refreshBalanceMock.mockResolvedValue({ balance: 11, used: 0, quota: 11 });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(25);

    expect(result).toMatchObject({ success: true, status: 'success' });
    expect(adapterMock.checkin).toHaveBeenCalledWith('https://agentrouter.org', 'session=active', 166081);
    expect(executeAgentRouterReloginCheckinMock).not.toHaveBeenCalled();
    expect(refreshManagedAccountLoginMock).not.toHaveBeenCalled();
  });

  it('delegates AgentRouter check-in to browser reauthentication without standard check-in or session refresh', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 22,
          username: 'github_166081',
          accessToken: 'session=still-valid',
          status: 'active',
          balance: 10,
          extraConfig: JSON.stringify({
            platformUserId: 166081,
            credentialMode: 'session',
            managedBrowserProfile: {
              enabled: true,
              provider: 'agentrouter',
              loginProvider: 'github',
            },
          }),
        },
        sites: {
          id: 22,
          name: 'AgentRouter',
          url: 'https://agentrouter.org',
          platform: 'agentrouter',
        },
      },
    ]);
    adapterMock.checkinMode = 'browser-reauth';
    executeAgentRouterReloginCheckinMock.mockResolvedValueOnce({
      success: true,
      message: 'AgentRouter OAuth 重登录完成',
      balanceInfo: { balance: 12.5, used: 0, quota: 12.5 },
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(22);

    expect(result.success).toBe(true);
    expect(executeAgentRouterReloginCheckinMock).toHaveBeenCalledWith(expect.objectContaining({ id: 22 }), expect.objectContaining({ platform: 'agentrouter' }));
    expect(adapterMock.checkin).not.toHaveBeenCalled();
    expect(refreshManagedAccountLoginMock).not.toHaveBeenCalled();
    expect(refreshBalanceMock).not.toHaveBeenCalled();
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('success');
    expect(firstInsertPayload?.reward).toBe('余额 +2.5');
  });

  it('keeps AgentRouter browser reauthentication failures as failed check-ins', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 23,
          username: 'github_166081',
          accessToken: 'session=still-valid',
          status: 'active',
          balance: 10,
          extraConfig: JSON.stringify({
            platformUserId: 166081,
            managedBrowserProfile: { enabled: true, loginProvider: 'github' },
          }),
        },
        sites: {
          id: 23,
          name: 'AgentRouter',
          url: 'https://agentrouter.org',
          platform: 'agentrouter',
        },
      },
    ]);
    adapterMock.checkinMode = 'browser-reauth';
    executeAgentRouterReloginCheckinMock.mockResolvedValueOnce({
      success: false,
      message: 'provider_session_expired',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(23);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(adapterMock.checkin).not.toHaveBeenCalled();
    expect(refreshManagedAccountLoginMock).not.toHaveBeenCalled();
    expect(refreshBalanceMock).not.toHaveBeenCalled();
  });

  it('treats unsupported checkin endpoint responses as skipped', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 10,
          username: 'linuxdo_131936',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 10,
          name: 'anyrouter',
          url: 'https://anyrouter.top',
          platform: 'anyrouter',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'HTTP 404: {"error":{"message":"Invalid URL (POST /api/user/checkin)"}}',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(10);

    expect(result.success).toBe(true);
    expect(result.status).toBe('skipped');
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('skipped');
    expect(refreshBalanceMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('skips account updates when unsupported checkin responses do not change account state', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 18,
          username: 'plain-user',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 18,
          name: 'done-hub',
          url: 'https://done.example.com',
          platform: 'donehub',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'checkin endpoint not found',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(18);

    expect(result.success).toBe(true);
    expect(result.status).toBe('skipped');
    expect(updateSetMock).not.toHaveBeenCalled();
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('skipped');
  });

  it('treats sub2api checkin unsupported message as skipped', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 15,
          username: 'sub2_user',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 15,
          name: 'sub2',
          url: 'https://sub2.example.com',
          platform: 'sub2api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'Check-in is not supported by Sub2API',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(15);

    expect(result.success).toBe(true);
    expect(result.status).toBe('skipped');
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('skipped');
    expect(refreshBalanceMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('treats turnstile-required responses as skipped', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 14,
          username: 'linuxdo_10277',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 14,
          name: 'run-anytime',
          url: 'https://runanytime.hxi.me',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'Turnstile token 为空',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(14);

    expect(result.success).toBe(true);
    expect(result.status).toBe('skipped');
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('skipped');
    expect(firstInsertPayload?.message).toBe('站点开启了 Turnstile 校验，需要人工签到');
    expect(refreshBalanceMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('runs all-account checkins sequentially to avoid site and proxy throttling', async () => {
    const rowA = {
      accounts: {
        id: 31,
        username: 'site-a-user',
        accessToken: 'token-a',
        status: 'active',
        extraConfig: null,
      },
      sites: {
        id: 101,
        name: 'Site A',
        url: 'https://site-a.example.com',
        platform: 'new-api',
      },
    };
    const rowB = {
      accounts: {
        id: 32,
        username: 'site-b-user',
        accessToken: 'token-b',
        status: 'active',
        extraConfig: null,
      },
      sites: {
        id: 102,
        name: 'Site B',
        url: 'https://site-b.example.com',
        platform: 'new-api',
      },
    };

    selectAllMock
      .mockReturnValueOnce([rowA, rowB])
      .mockReturnValueOnce([rowA])
      .mockReturnValueOnce([rowB]);

    let active = 0;
    let maxActive = 0;
    adapterMock.checkin.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { success: true, message: '签到成功' };
    });

    const onProgress = vi.fn();
    const { checkinAll } = await import('./checkinService.js');
    const results = await checkinAll({ onProgress });

    expect(results.map((item) => item.accountId)).toEqual([31, 32]);
    expect(maxActive).toBe(1);
    expect(onProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({
      completed: 1,
      total: 2,
      accountId: 31,
      username: 'site-a-user',
      site: 'Site A',
    }));
    expect(onProgress).toHaveBeenNthCalledWith(2, expect.objectContaining({
      completed: 2,
      total: 2,
      accountId: 32,
      username: 'site-b-user',
      site: 'Site B',
    }));
  });

});
