import { describe, expect, it, vi } from 'vitest';
import { resolveSiteAuthLogin, toSafeSiteAuthBridgeError } from './loginBridge.js';
import type {
  ExternalAuthLoginInput,
  ExternalAuthLoginResult,
  PlatformAdapter,
} from '../platforms/base.js';

function createAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    platformName: 'test-platform',
    detect: vi.fn(),
    login: vi.fn(),
    getUserInfo: vi.fn(),
    verifyToken: vi.fn(),
    checkin: vi.fn(),
    getBalance: vi.fn(),
    getModels: vi.fn(),
    getApiToken: vi.fn(),
    getApiTokens: vi.fn(),
    getSiteAnnouncements: vi.fn(),
    getUserGroups: vi.fn(),
    createApiToken: vi.fn(),
    deleteApiToken: vi.fn(),
    ...overrides,
  } as PlatformAdapter;
}

describe('resolveSiteAuthLogin', () => {
  it('delegates target login to the platform adapter externalAuthLogin hook', async () => {
    const externalAuthLogin = vi.fn(async (
      _baseUrl: string,
      _input: ExternalAuthLoginInput,
    ): Promise<ExternalAuthLoginResult> => ({
      accessToken: 'target-session-token',
      platformUserId: 42,
      username: 'linuxdo-user',
      sourceProvider: 'linuxdo',
    }));
    const adapter = createAdapter({ externalAuthLogin });

    const result = await resolveSiteAuthLogin({
      site: { url: 'https://target.example.com' },
      adapter,
      credential: {
        provider: 'linuxdo',
        credentialType: 'cookie',
        payload: { cookie: 'ld_auth_session=secret' },
      },
    });

    expect(externalAuthLogin).toHaveBeenCalledWith('https://target.example.com', {
      sourceProvider: 'linuxdo',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=secret' },
    });
    expect(result).toEqual({
      accessToken: 'target-session-token',
      platformUserId: 42,
      username: 'linuxdo-user',
      sourceProvider: 'linuxdo',
    });
  });

  it('rejects target sites without a third-party login bridge hook', async () => {
    const adapter = createAdapter();

    await expect(resolveSiteAuthLogin({
      site: { url: 'https://target.example.com' },
      adapter,
      credential: {
        provider: 'linuxdo',
        credentialType: 'cookie',
        payload: { cookie: 'ld_auth_session=secret' },
      },
    })).rejects.toThrow('target site does not support third-party login bridge');
  });

  it('rejects bridge results without a target site access token', async () => {
    const adapter = createAdapter({
      externalAuthLogin: vi.fn(async () => ({
        accessToken: '   ',
        sourceProvider: 'linuxdo',
      })),
    });

    await expect(resolveSiteAuthLogin({
      site: { url: 'https://target.example.com' },
      adapter,
      credential: {
        provider: 'linuxdo',
        credentialType: 'cookie',
        payload: { cookie: 'ld_auth_session=secret' },
      },
    })).rejects.toThrow('target site login bridge did not return an access token');
  });

  it('maps bridge errors to safe operator messages without credential payloads', () => {
    expect(toSafeSiteAuthBridgeError(new Error('upstream timeout ld_auth_session=secret')))
      .toBe('第三方登录桥接失败：目标站点连接超时。');
    expect(toSafeSiteAuthBridgeError(new Error('HTTP 403 forbidden token=secret')))
      .toBe('第三方登录桥接失败：凭证无效或目标站点拒绝授权。');
    expect(toSafeSiteAuthBridgeError(new Error('target site login bridge did not return an access token ld_auth_session=secret')))
      .toBe('第三方登录桥接失败：目标站点没有返回可用 Session。');
  });
});
