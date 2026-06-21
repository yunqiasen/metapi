import type { SiteAuthProviderDefinition, SiteAuthProviderId } from './providerTypes.js';

const PROVIDERS: SiteAuthProviderDefinition[] = [
  {
    metadata: {
      provider: 'linuxdo',
      label: 'LinuxDO',
      credentialTypes: ['oauth_token', 'cookie', 'session_artifact', 'manual'],
      captureModes: ['controlled_browser', 'manual_paste'],
      enabled: true,
    },
  },
  {
    metadata: {
      provider: 'github',
      label: 'GitHub',
      credentialTypes: ['oauth_token', 'session_artifact'],
      captureModes: ['controlled_browser'],
      enabled: true,
    },
  },
  {
    metadata: {
      provider: 'google',
      label: 'Google',
      credentialTypes: ['oauth_token', 'session_artifact'],
      captureModes: ['controlled_browser'],
      enabled: true,
    },
  },
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((provider) => [provider.metadata.provider, provider] as const));

export function listSiteAuthProviderDefinitions(): SiteAuthProviderDefinition[] {
  return PROVIDERS.slice();
}

export function getSiteAuthProviderDefinition(provider: string): SiteAuthProviderDefinition | undefined {
  return PROVIDER_BY_ID.get(provider as SiteAuthProviderId);
}

export type {
  SiteAuthCaptureMode,
  SiteAuthCredentialType,
  SiteAuthProviderDefinition,
  SiteAuthProviderId,
  SiteAuthProviderMetadata,
} from './providerTypes.js';
