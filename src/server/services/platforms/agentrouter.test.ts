import { describe, expect, it, vi } from 'vitest';
import type { BalanceInfo } from './base.js';
import {
  AgentRouterAdapter,
  type AgentRouterAdapterOptions,
  buildAgentRouterCurlConfig,
  fetchAgentRouterBalanceWithCurl,
  parseAgentRouterCurlBalancePayload,
} from './agentrouter.js';

class HangingAgentRouterAdapter extends AgentRouterAdapter {
  constructor(
    balanceFallback: (baseUrl: string, accessToken: string, platformUserId: number) => Promise<BalanceInfo>,
  ) {
    super({
      balanceFallback,
      undiciTimeoutMs: 5,
    });
  }

  protected override getBalanceWithUndici(): Promise<BalanceInfo> {
    return new Promise(() => {});
  }
}

class FailingAgentRouterAdapter extends AgentRouterAdapter {
  constructor(
    private readonly failure: Error,
    balanceFallback: (baseUrl: string, accessToken: string, platformUserId: number) => Promise<BalanceInfo>,
  ) {
    super({ balanceFallback });
  }

  protected override async getBalanceWithUndici(): Promise<BalanceInfo> {
    throw this.failure;
  }
}

describe('AgentRouterAdapter balance fallback', () => {
  it('falls back when the Undici balance read never settles', async () => {
    const fallback = vi.fn(async () => ({ balance: 775, used: 0, quota: 775 }));
    const adapter = new HangingAgentRouterAdapter(fallback);
    const guardedResult = Promise.race([
      adapter.getBalance('https://agentrouter.org', 'session=secret', 166363),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('test_guard_timeout')), 100);
      }),
    ]);

    await expect(guardedResult).resolves.toEqual({ balance: 775, used: 0, quota: 775 });
    expect(fallback).toHaveBeenCalledWith('https://agentrouter.org', 'session=secret', 166363);
  }, 500);

  it('uses curl only when undici receives an upstream HTML shell', async () => {
    const fallback = vi.fn(async () => ({ balance: 838.116486, used: 511.883514, quota: 1350 }));
    const adapter = new FailingAgentRouterAdapter(new Error('upstream_html_response'), fallback);

    await expect(adapter.getBalance('https://agentrouter.org', 'session=secret', 59260)).resolves.toEqual({
      balance: 838.116486,
      used: 511.883514,
      quota: 1350,
    });
    expect(fallback).toHaveBeenCalledWith('https://agentrouter.org', 'session=secret', 59260);
  });

  it('does not hide normal authentication failures behind curl', async () => {
    const fallback = vi.fn();
    const adapter = new FailingAgentRouterAdapter(new Error('access token expired'), fallback);

    await expect(adapter.getBalance('https://agentrouter.org', 'expired', 59260))
      .rejects.toThrow('access token expired');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('builds a stdin curl config without placing credentials in process arguments', () => {
    const config = buildAgentRouterCurlConfig({
      requestUrl: 'https://agentrouter.org/api/user/self',
      accessToken: 'session=secret-value',
      platformUserId: 59260,
      proxyUrl: 'socks5h://proxy-user:proxy-pass@proxy.example:1080',
    });

    expect(config).toContain('url = "https://agentrouter.org/api/user/self"');
    expect(config).toContain('header = "Cookie: session=secret-value"');
    expect(config).toContain('header = "New-Api-User: 59260"');
    expect(config).toContain('proxy = "socks5h://proxy-user:proxy-pass@proxy.example:1080"');
  });

  it('parses and validates the same-account balance returned by curl', () => {
    expect(parseAgentRouterCurlBalancePayload(JSON.stringify({
      success: true,
      data: { id: 59260, quota: 419058243, used_quota: 255941757 },
    }), 59260)).toEqual({ balance: 838.116486, used: 511.883514, quota: 1350 });

    expect(() => parseAgentRouterCurlBalancePayload(JSON.stringify({
      success: true,
      data: { id: 99999, quota: 1, used_quota: 2 },
    }), 59260)).toThrow('account_mismatch');
  });

  it('passes secrets through curl stdin and parses its JSON response', async () => {
    let receivedConfig = '';
    const result = await fetchAgentRouterBalanceWithCurl(
      'https://agentrouter.org',
      'session=secret-value',
      59260,
      {
        resolveProxyUrl: async () => null,
        runCurl: async (config) => {
          receivedConfig = config;
          return JSON.stringify({
            success: true,
            data: { id: 59260, quota: 419058243, used_quota: 255941757 },
          });
        },
      },
    );

    expect(receivedConfig).toContain('session=secret-value');
    expect(result.balance).toBe(838.116486);
  });
});
