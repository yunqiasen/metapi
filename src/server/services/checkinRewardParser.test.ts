import { describe, expect, it } from 'vitest';
import { parseCheckinRewardAmount } from './checkinRewardParser.js';

describe('checkinRewardParser', () => {
  it('parses numeric reward values', () => {
    expect(parseCheckinRewardAmount(3.5)).toBe(3.5);
    expect(parseCheckinRewardAmount('12')).toBe(12);
  });

  it('parses reward strings with text wrappers', () => {
    expect(parseCheckinRewardAmount('奖励 +2.75')).toBe(2.75);
    expect(parseCheckinRewardAmount('checkin success, reward=5')).toBe(5);
  });

  it('does not treat a current total quota as a check-in reward', () => {
    expect(parseCheckinRewardAmount('已签到，额度无新增，当前总额度 850')).toBe(0);
    expect(parseCheckinRewardAmount('签到成功，当前总额度 850')).toBe(0);
    expect(parseCheckinRewardAmount('签到成功，获得 $25 额度')).toBe(25);
  });

  it('returns zero for missing or non-positive values', () => {
    expect(parseCheckinRewardAmount('')).toBe(0);
    expect(parseCheckinRewardAmount(null)).toBe(0);
    expect(parseCheckinRewardAmount('checked in')).toBe(0);
    expect(parseCheckinRewardAmount('-1')).toBe(0);
  });
});
