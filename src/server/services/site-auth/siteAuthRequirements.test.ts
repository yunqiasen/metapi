import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

import { resolveSiteAuthRequirements, resolveSiteAuthRequirementsForSite } from './siteAuthRequirements.js';

function htmlResponse(html: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => html,
    json: async () => JSON.parse(html),
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json; charset=utf-8' },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe('resolveSiteAuthRequirements', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('detects LinuxDO from a visible login button', () => {
    const result = resolveSiteAuthRequirements({
      site: { id: 7, name: 'Demo Hub', url: 'https://demo.example.com', platform: 'new-api' },
      html: '<button>使用 LinuxDO 继续</button>',
    });
    expect(result.hasThirdPartyLogin).toBe(true);
    expect(result.requirements).toEqual([
      expect.objectContaining({ provider: 'linuxdo', label: 'LinuxDO', required: true, confidence: 'detected' }),
    ]);
  });

  it('detects GitHub and Google oauth links from html', () => {
    const result = resolveSiteAuthRequirements({
      site: { id: 8, name: 'OAuth Site', url: 'https://oauth.example.com', platform: 'new-api' },
      html: '<a href="https://github.com/login/oauth/authorize">GitHub</a><a href="https://accounts.google.com/o/oauth2/v2/auth">Google</a>',
    });
    expect(result.requirements.map((item) => item.provider)).toEqual(['github', 'google']);
  });

  it('does not treat analytics or model text as Google login support', () => {
    const result = resolveSiteAuthRequirements({
      site: { id: 10, name: 'Analytics Site', url: 'https://analytics.example.com', platform: 'new-api' },
      html: '<!--Google Analytics--><meta content="Google Gemini compatible API"><div>Login</div>',
    });

    expect(result.hasThirdPartyLogin).toBe(false);
    expect(result.requirements).toEqual([]);
  });

  it('uses explicit site metadata before html detection', () => {
    const result = resolveSiteAuthRequirements({
      site: {
        id: 9,
        name: 'Metadata Site',
        url: 'https://metadata.example.com',
        platform: 'new-api',
        metadata: { siteAuthProviders: ['linuxdo'] },
      },
      html: '<a href="https://github.com/login/oauth/authorize">GitHub</a>',
    });
    expect(result.requirements).toEqual([
      expect.objectContaining({ provider: 'linuxdo', confidence: 'explicit' }),
    ]);
  });

  it('uses login and register pages before NewAPI status provider flags', async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse('<div id="root"><!-- SPA shell --></div>'))
      .mockResolvedValueOnce(htmlResponse('<form><input name="username"></form>'))
      .mockResolvedValueOnce(htmlResponse('<form><input name="username"></form>'));

    const result = await resolveSiteAuthRequirementsForSite({
      id: 12,
      name: '917813',
      url: 'https://api.nexusvai.xyz',
      platform: 'new-api',
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://api.nexusvai.xyz',
      'https://api.nexusvai.xyz/login',
      'https://api.nexusvai.xyz/register',
    ]);
    expect(result).toMatchObject({
      siteId: 12,
      hasThirdPartyLogin: false,
      requirements: [],
    });
  });

  it('checks login and register pages when the root page is only a SPA shell', async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse('<div id="root"><!--Google Analytics QuantumNous--></div>'))
      .mockResolvedValueOnce(htmlResponse('<a href="https://github.com/login/oauth/authorize">Continue with GitHub</a>'));

    const result = await resolveSiteAuthRequirementsForSite({
      id: 13,
      name: 'GitHub Login Site',
      url: 'https://target.example.com',
      platform: 'new-api',
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://target.example.com',
      'https://target.example.com/login',
    ]);
    expect(result.requirements.map((item) => item.provider)).toEqual(['github']);
  });
});
