import { describe, expect, it, vi } from 'vitest';
import {
  buildAnyRouterVisitPersistUpdates,
  executeAnyRouterBrowserVisitCheckin,
} from './anyRouterBrowserVisitCheckinService.js';

function fixture(
  balance: number,
  options: {
    beforeBalance?: number;
    beforeQuota?: number;
    storedQuota?: number;
    afterQuota?: number;
    signIn?: { success: boolean; message: string; alreadyCheckedIn: boolean };
  } = {},
) {
  const calls: string[] = [];
  const beforeBalance = options.beforeBalance ?? 475;
  const beforeQuota = options.beforeQuota ?? 475;
  const afterQuota = options.afterQuota ?? balance;
  const users = [
    { id: 2202, username: 'any-main', balanceInfo: { balance: beforeBalance, used: beforeQuota - beforeBalance, quota: beforeQuota } },
    { id: 2202, username: 'any-main', balanceInfo: { balance, used: afterQuota - balance, quota: afterQuota } },
  ];
  const finalize = vi.fn(async () => { calls.push('finalize'); });
  const rollback = vi.fn(async () => { calls.push('rollback'); });
  const session = {
    readCurrentUser: vi.fn(async () => {
      calls.push(users.length === 2 ? 'read-before' : 'read-after');
      return users.shift() ?? null;
    }),
    triggerCheckin: vi.fn(async () => {
      calls.push('sign-in');
      return options.signIn ?? { success: true, message: '签到成功', alreadyCheckedIn: false };
    }),
    collectSession: vi.fn(async () => { calls.push('collect'); return { accessToken: 'session=fresh' }; }),
    close: vi.fn(async () => { calls.push('close'); }),
    commitProfile: vi.fn(async () => { calls.push('commit'); return { profileDir: '/profiles/21', finalize, rollback }; }),
    discardProfile: vi.fn(async () => { calls.push('discard'); }),
  };
  const persist = vi.fn(async () => { calls.push('persist'); });
  return {
    account: { id: 21, username: 'any-main', balance: beforeBalance, quota: options.storedQuota ?? beforeQuota, status: 'active', extraConfig: JSON.stringify({ platformUserId: 2202, managedBrowserProfile: { enabled: true } }) },
    site: { id: 8, platform: 'anyrouter', url: 'https://anyrouter.top' },
    deps: { openBrowser: vi.fn(async () => { calls.push('open'); return session; }), persist },
    calls, persist,
  };
}

describe('AnyRouter browser visit persistence', () => {
  it('restores an expired account after the target site returns a verified live session', () => {
    const updates = buildAnyRouterVisitPersistUpdates({
      account: {
        id: 21,
        username: 'any-main',
        status: 'expired',
        extraConfig: JSON.stringify({ platformUserId: 2202 }),
      } as never,
      user: {
        id: 2202,
        username: 'any-main',
        balanceInfo: { balance: 875, used: 0, quota: 875 },
      },
      accessToken: 'session=fresh',
      profileDir: '/profiles/21',
    });

    expect(updates).toMatchObject({
      status: 'active',
      accessToken: 'session=fresh',
      balance: 875,
      quota: 875,
    });
  });
});

describe('executeAnyRouterBrowserVisitCheckin', () => {
  it('reports an expired target session instead of misclassifying a missing user as another account', async () => {
    const f = fixture(500);
    f.deps.openBrowser = vi.fn(async () => ({
      readCurrentUser: vi.fn(async () => null),
      triggerCheckin: vi.fn(),
      collectSession: vi.fn(),
      close: vi.fn(async () => {}),
      commitProfile: vi.fn(),
      discardProfile: vi.fn(async () => {}),
    }));

    const result = await executeAnyRouterBrowserVisitCheckin(f.account as never, f.site as never, f.deps as never);

    expect(result).toMatchObject({ success: false, message: 'anyrouter_target_session_expired' });
  });

  it('reports success only when the explicit sign-in produces a real balance increase', async () => {
    const f = fixture(500);
    const result = await executeAnyRouterBrowserVisitCheckin(f.account as never, f.site as never, f.deps as never);
    expect(result).toMatchObject({ success: true, reward: '总额度 +25', balanceInfo: { balance: 500, quota: 500 } });
    expect(f.calls).toEqual(['open', 'read-before', 'sign-in', 'read-after', 'collect', 'close', 'commit', 'persist', 'finalize']);
  });

  it('confirms check-in from total quota growth even when concurrent usage lowers the remaining balance', async () => {
    const f = fixture(450, { beforeQuota: 475, afterQuota: 525 });

    const result = await executeAnyRouterBrowserVisitCheckin(f.account as never, f.site as never, f.deps as never);

    expect(result).toMatchObject({ success: true, reward: '总额度 +50', balanceInfo: { quota: 525 } });
  });

  it('does not claim completion when sign-in reports success but quota remains unchanged', async () => {
    const f = fixture(475);
    const result = await executeAnyRouterBrowserVisitCheckin(
      f.account as never,
      f.site as never,
      f.deps as never,
      { confirmationAttempts: 1, confirmationDelayMs: 0 },
    );
    expect(result).toMatchObject({ success: false, message: 'anyrouter_checkin_unconfirmed_quota_unchanged' });
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.calls).toContain('discard');
  });

  it('reports quota already added by the browser visit before the explicit sign-in response', async () => {
    const f = fixture(500, {
      storedQuota: 475,
      beforeQuota: 500,
      afterQuota: 500,
      signIn: { success: true, message: '', alreadyCheckedIn: true },
    });

    const result = await executeAnyRouterBrowserVisitCheckin(f.account as never, f.site as never, f.deps as never);

    expect(result).toMatchObject({
      success: true,
      reward: '总额度 +25',
      balanceInfo: { quota: 500 },
    });
    expect(result.message).toContain('签到已确认');
    expect(f.persist).toHaveBeenCalledTimes(1);
  });

  it('does not report success when an already-signed response leaves total quota unchanged', async () => {
    const f = fixture(475, {
      signIn: { success: true, message: '', alreadyCheckedIn: true },
    });

    const result = await executeAnyRouterBrowserVisitCheckin(f.account as never, f.site as never, f.deps as never);

    expect(result).toMatchObject({ success: false, alreadyCheckedIn: true, balanceInfo: { quota: 475 } });
    expect(result.message).toContain('额度无新增');
    expect(result.reward).toBeUndefined();
    expect(f.persist).toHaveBeenCalledTimes(1);
  });
});
