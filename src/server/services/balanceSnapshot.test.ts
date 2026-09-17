import { describe, expect, it } from 'vitest';
import { buildBalanceSnapshotUpdates } from './balanceSnapshot.js';

describe('balance snapshot persistence', () => {
  it('uses the confirmed snapshot without changing credentials or other account configuration', () => {
    expect(buildBalanceSnapshotUpdates({ balance: 115, used: 10, quota: 125 }, '2026-09-09T00:00:00.000Z')).toEqual({
      balance: 115, balanceUsed: 10, quota: 125,
      lastBalanceRefresh: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    });
  });
  it('does not persist a non-finite balance', () => {
    expect(() => buildBalanceSnapshotUpdates({ balance: NaN, used: 0, quota: 100 })).toThrow('balance snapshot');
  });
});
