import type { BalanceInfo } from './platforms/base.js';

export function buildBalanceSnapshotUpdates(balance: BalanceInfo, now = new Date().toISOString()) {
  if (![balance.balance, balance.used, balance.quota].every(Number.isFinite)) {
    throw new Error('invalid balance snapshot');
  }
  return {
    balance: balance.balance,
    balanceUsed: balance.used,
    quota: balance.quota,
    lastBalanceRefresh: now,
    updatedAt: now,
  };
}
