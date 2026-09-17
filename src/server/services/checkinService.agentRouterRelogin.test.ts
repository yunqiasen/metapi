import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterMock = {
  platformName: 'agentrouter',
  checkin: vi.fn(),
  login: vi.fn(),
};

const reloginMock = vi.fn();
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
  const updateWhereChain = { run: () => ({}) };
  const updateSetChain = { where: () => updateWhereChain };
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
  getAdapterForSite: () => adapterMock,
}));

vi.mock('./agentRouterOauthReloginService.js', () => ({
  executeAgentRouterOauthRelogin: (...args: unknown[]) => reloginMock(...args),
}));

vi.mock('./notifyService.js', () => ({ sendNotification: vi.fn() }));
vi.mock('./alertService.js', () => ({ reportTokenExpired: vi.fn() }));
vi.mock('./balanceService.js', () => ({ refreshBalance: vi.fn() }));
vi.mock('./accountCredentialService.js', () => ({ decryptAccountPassword: vi.fn() }));

const agentAccount = {
  id: 9,
  username: 'github_166363',
  accessToken: 'session=old',
  status: 'active',
  balance: 250,
  quota: 1323,
  extraConfig: JSON.stringify({
    platformUserId: 166363,
    checkinRelogin: { provider: 'github', cookie: 'user_session=gh' },
  }),
};

const agentSite = {
  id: 25,
  name: 'Agentrouter',
  url: 'https://agentrouter.org',
  platform: 'agentrouter',
};

describe('checkinService agentrouter oauth relogin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMock.platformName = 'agentrouter';
    adapterMock.checkin.mockReset();
    adapterMock.login.mockReset();
    reloginMock.mockReset();
    selectAllMock.mockReset();
    insertValuesMock.mockReset();
    updateSetMock.mockReset();
  });

  it('uses oauth relogin instead of protocol checkin when relogin config exists', async () => {
    selectAllMock.mockReturnValue([{ accounts: agentAccount, sites: agentSite }]);
    reloginMock.mockResolvedValue({
      success: true,
      checkedIn: true,
      credentialsRefreshed: true,
      reward: '25',
      balanceInfo: { balance: 275, used: 1073, quota: 1348 },
      message: 'AgentRouter 已通过 github 重新登录完成签到',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(9);

    expect(result.success).toBe(true);
    expect(result.status).toBe('success');
    expect(result.reward).toBe('25');
    expect(adapterMock.checkin).not.toHaveBeenCalled();
    expect(reloginMock).toHaveBeenCalledTimes(1);
    expect(reloginMock.mock.calls[0]?.[0]).toMatchObject({
      provider: 'github',
      providerCookie: 'user_session=gh',
    });
  });

  it('uses the live adapter reward rather than a stale local quota', async () => {
    selectAllMock.mockReturnValue([{ accounts: { ...agentAccount, quota: 9000 }, sites: agentSite }]);
    reloginMock.mockResolvedValue({ success: true, credentialsRefreshed: true, reward: '25', balanceInfo: { balance: 275, used: 1073, quota: 1348 }, message: '实际新增 25' });
    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(9);
    expect(result).toMatchObject({ success: true, status: 'success', reward: '25' });
  });

  it('coalesces simultaneous check-in calls for the same account', async () => {
    selectAllMock.mockReturnValue([{ accounts: agentAccount, sites: agentSite }]);
    let resolve!: (value: any) => void;
    reloginMock.mockReturnValue(new Promise(r => { resolve = r; }));
    const { checkinAccount } = await import('./checkinService.js');
    const first = checkinAccount(9);
    const second = checkinAccount(9);
    await vi.waitFor(() => expect(reloginMock).toHaveBeenCalled());
    resolve({ success: false, quotaUnchanged: true, credentialsRefreshed: true, reward: '0', message: '额度无新增' });
    await Promise.all([first, second]);
    expect(reloginMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock.mock.calls.filter(x => x[0]?.accountId === 9)).toHaveLength(1);
    await checkinAccount(9);
    expect(reloginMock).toHaveBeenCalledTimes(2);
  });

  it('marks unchanged quota as skipped after a successful relogin', async () => {
    selectAllMock.mockReturnValue([{ accounts: agentAccount, sites: agentSite }]);
    reloginMock.mockResolvedValue({
      success: false, quotaUnchanged: true, reward: '0',
      checkedIn: true,
      credentialsRefreshed: true,
      balanceInfo: { balance: 250, used: 1073, quota: 1323 },
      message: 'AgentRouter 已重新登录，额度无新增',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(9);

    expect(result.status).toBe('skipped');
    expect(result.message).toContain('额度无新增');
  });

  it('records a verified login with an unknown reward as neutral and advances the interval without another balance query', async () => {
    selectAllMock.mockReturnValue([{ accounts: agentAccount, sites: agentSite }]);
    reloginMock.mockResolvedValue({
      success: false, credentialsRefreshed: true, rewardPending: true, checkedIn: true,
      reasonCode: 'quota_before_unavailable',
      balanceInfo: { balance: 275, used: 1073, quota: 1348 },
      message: 'AgentRouter 已重新登录并刷新凭证；缺少签到前额度，新增奖励待确认',
    });
    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(9, { scheduleMode: 'interval' });
    expect(result).toMatchObject({ success: false, status: 'skipped', skipped: true, credentialsRefreshed: true, rewardPending: true });
    expect(result.reward).toBeUndefined();
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ accountId: 9, status: 'skipped', reward: undefined }));
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ balance: 275, quota: 1348, lastCheckinAt: expect.any(String) }));
    const { refreshBalance } = await import('./balanceService.js');
    const { sendNotification } = await import('./notifyService.js');
    expect(refreshBalance).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('does not repeatedly relogin on every interval tick after a verified unchanged quota', async () => {
    selectAllMock.mockReturnValue([{ accounts: agentAccount, sites: agentSite }]);
    reloginMock.mockResolvedValue({ success: false, credentialsRefreshed: true, quotaUnchanged: true, reward: '0', balanceInfo: { balance: 250, used: 1073, quota: 1323 }, message: '额度无新增' });
    const { checkinAccount } = await import('./checkinService.js');
    await checkinAccount(9, { scheduleMode: 'interval' });
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ lastCheckinAt: expect.any(String) }));
  });

  it('keeps protocol-only AgentRouter checks as skipped when relogin config is missing', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: { ...agentAccount, extraConfig: JSON.stringify({ platformUserId: 166363 }) },
        sites: agentSite,
      },
    ]);
    adapterMock.checkin.mockResolvedValue({
      success: true,
      message: 'AgentRouter 已通过用户信息请求触发签到校验',
      balanceInfo: { balance: 275, used: 1073, quota: 1348 },
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(9);

    expect(result.success).toBe(false);
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('未触发签到');
    expect(adapterMock.checkin).toHaveBeenCalledTimes(1);
    expect(reloginMock).not.toHaveBeenCalled();
  });

  it('surfaces relogin failure reasons without auto-relogin retry', async () => {
    selectAllMock.mockReturnValue([{ accounts: agentAccount, sites: agentSite }]);
    reloginMock.mockResolvedValue({
      success: false,
      reasonCode: 'provider_session_expired',
      message: 'github 登录态已失效，请重新在浏览器登录 github 后更新 Cookie',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(9);

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.message).toContain('登录态已失效');
    expect(adapterMock.login).not.toHaveBeenCalled();
  });
  it('keeps the existing balance and makes no extra balance query when OAuth refreshed only identity', async () => {
    selectAllMock.mockReturnValue([{ accounts: agentAccount, sites: agentSite }]);
    reloginMock.mockResolvedValue({ success: false, credentialsRefreshed: true, rewardPending: true, reasonCode: 'balance_after_unavailable', message: 'AgentRouter 已重新登录并刷新凭证；余额接口返回滑块，保留原余额，奖励待确认' });
    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(9, { scheduleMode: 'interval' });
    const { refreshBalance } = await import('./balanceService.js');
    expect(refreshBalance).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, status: 'skipped', rewardPending: true });
    expect(updateSetMock.mock.calls.some(([updates]) => 'balance' in updates)).toBe(false);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ lastCheckinAt: expect.any(String) }));
  });

});
