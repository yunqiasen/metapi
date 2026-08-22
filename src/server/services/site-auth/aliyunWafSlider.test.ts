import { describe, expect, it, vi } from 'vitest';
import {
  buildAliyunSliderTrack,
  isAliyunWafChallenge,
  parseAliyunWafVerification,
  solveAliyunWafSliderWithDriver,
} from './aliyunWafSlider.js';

describe('Aliyun WAF slider', () => {
  it('recognizes the AgentRouter access-verification page without treating ordinary HTML as a challenge', () => {
    expect(isAliyunWafChallenge({
      url: 'https://agentrouter.org/api/user/self',
      title: '访问验证',
      bodyText: '别离开，为了更好的访问体验，请进行验证，通过后即可继续访问网页',
      hasSlider: true,
    })).toBe(true);
    expect(isAliyunWafChallenge({
      url: 'https://agentrouter.org/console',
      title: 'AgentRouter',
      bodyText: '当前余额 800',
      hasSlider: false,
    })).toBe(false);
  });

  it('parses T001 and F001 verification responses from nested Aliyun payloads', () => {
    expect(parseAliyunWafVerification({
      Code: 'Success',
      Data: { VerifyCode: 'T001', VerifyResult: true },
    })).toEqual({ code: 'T001', verified: true });
    expect(parseAliyunWafVerification(JSON.stringify({
      result: { VerifyCode: 'F001', VerifyResult: false },
    }))).toEqual({ code: 'F001', verified: false });
  });

  it('touches the slider endpoint for the first time only on the final trajectory point', () => {
    const track = buildAliyunSliderTrack();
    expect(track.length).toBeGreaterThan(50);
    expect(track.at(-1)?.progress).toBe(1);
    expect(track.slice(0, -1).every((point) => point.progress < 1)).toBe(true);
    expect(track.some((point, index) => index > 0 && point.progress < track[index - 1]!.progress)).toBe(true);
  });

  it('refreshes after F001 and stops after a later T001 result', async () => {
    const drag = vi.fn()
      .mockResolvedValueOnce({ code: 'F001', verified: false })
      .mockResolvedValueOnce({ code: 'T001', verified: true });
    const refresh = vi.fn(async () => {});

    await expect(solveAliyunWafSliderWithDriver({ drag, refresh }, { maxAttempts: 3 }))
      .resolves.toEqual({ code: 'T001', verified: true, attempts: 2 });
    expect(drag).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('returns a bounded failure instead of retrying forever', async () => {
    const drag = vi.fn(async () => ({ code: 'F001', verified: false }));
    const refresh = vi.fn(async () => {});

    await expect(solveAliyunWafSliderWithDriver({ drag, refresh }, { maxAttempts: 2 }))
      .rejects.toThrow('agentrouter_waf_slider_failed');
    expect(drag).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
