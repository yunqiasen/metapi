import { describe, expect, it } from 'vitest';
import {
  getSiteAuthProviderDefinition,
  listSiteAuthProviderDefinitions,
} from './providers.js';

describe('site auth provider registry', () => {
  it('ships the first supported third-party login providers in rollout order', () => {
    const providers = listSiteAuthProviderDefinitions();

    expect(providers.map((provider) => provider.metadata.provider)).toEqual([
      'linuxdo',
      'github',
      'google',
    ]);
    expect(providers[0]).toMatchObject({
      metadata: {
        provider: 'linuxdo',
        label: 'LinuxDO',
        credentialTypes: ['cookie', 'session_artifact', 'manual'],
        captureModes: ['manual_paste', 'browser_assisted'],
      },
    });
  });

  it('returns stable definitions without exposing the registry array', () => {
    const providers = listSiteAuthProviderDefinitions();
    providers.pop();

    expect(listSiteAuthProviderDefinitions()).toHaveLength(3);
    expect(getSiteAuthProviderDefinition('linuxdo')?.metadata.label).toBe('LinuxDO');
    expect(getSiteAuthProviderDefinition('unknown')).toBeUndefined();
  });

  it('keeps GitHub and Google on callback authorization instead of manual token capture', () => {
    expect(getSiteAuthProviderDefinition('github')?.metadata).toMatchObject({
      credentialTypes: ['oauth_token'],
      captureModes: ['oauth_callback'],
    });
    expect(getSiteAuthProviderDefinition('google')?.metadata).toMatchObject({
      credentialTypes: ['oauth_token'],
      captureModes: ['oauth_callback'],
    });
  });
});
