export type SiteAuthProviderId = 'linuxdo' | 'github' | 'google';

export type SiteAuthCredentialType = 'oauth_token' | 'cookie' | 'session_artifact' | 'manual';

export type SiteAuthCaptureMode = 'oauth_callback' | 'manual_paste' | 'browser_assisted';

export type SiteAuthProviderMetadata = {
  provider: SiteAuthProviderId;
  label: string;
  credentialTypes: SiteAuthCredentialType[];
  captureModes: SiteAuthCaptureMode[];
  enabled: boolean;
};

export type SiteAuthProviderDefinition = {
  metadata: SiteAuthProviderMetadata;
};
