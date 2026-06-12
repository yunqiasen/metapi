import { describe, expect, it, vi } from 'vitest';
import { resolveSiteAuthLogin } from './loginBridge.js';
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
});
