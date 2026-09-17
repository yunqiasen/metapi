import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterMock = {
  platformName: 'anyrouter',
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

describe('checkinService confirmed quota persistence', () => {
  beforeEach(() => {
    adapterMock.platformName = 'anyrouter';
    adapterMock.checkin.mockReset();
    adapterMock.login.mockReset();
    reloginMock.mockReset();
    selectAllMock.mockReset();
    insertValuesMock.mockReset();
    updateSetMock.mockReset();
  });

  it('persists the adapter-confirmed balance so the UI reload reads the new quota', async () => {
    selectAllMock.mockReturnValue([{ accounts: agentAccount, sites: { ...agentSite, platform: 'anyrouter' } }]);
    adapterMock.checkin.mockResolvedValue({
      success: true, message: 'AnyRouter 签到已确认：总额度 +25', reward: '25',
      balanceInfo: { balance: 275, used: 1073, quota: 1348 },
    });
    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(9);
    expect(result).toMatchObject({ success: true, status: 'success', reward: '25' });
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      balance: 275, balanceUsed: 1073, quota: 1348, lastBalanceRefresh: expect.any(String),
    }));
    const { refreshBalance } = await import('./balanceService.js');
    expect(refreshBalance).not.toHaveBeenCalled();
  });

  it('records unchanged quota as skipped, with no fabricated success or reward', async () => {
    selectAllMock.mockReturnValue([{ accounts: agentAccount, sites: { ...agentSite, platform: 'anyrouter' } }]);
    adapterMock.checkin.mockResolvedValue({
      success: false, quotaUnchanged: true, reward: '0',
      message: 'AnyRouter 已完成签到请求，额度无新增',
      balanceInfo: { balance: 250, used: 1073, quota: 1323 },
    });
    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(9);
    expect(result).toMatchObject({ success: false, status: 'skipped', skipped: true, reward: '0' });
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped', reward: '0' }));
    expect(updateSetMock.mock.calls.some(([updates]) => updates.lastCheckinAt)).toBe(false);
  });
});
