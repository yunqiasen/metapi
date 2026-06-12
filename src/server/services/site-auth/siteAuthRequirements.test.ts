import { describe, expect, it } from 'vitest';
import { resolveSiteAuthRequirements } from './siteAuthRequirements.js';

describe('resolveSiteAuthRequirements', () => {
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
});
