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

export type SiteAuthRequirementConfidence = 'explicit' | 'detected';

export type SiteAuthRequirement = {
  provider: SiteAuthProviderId;
  label: string;
  required: boolean;
  confidence: SiteAuthRequirementConfidence;
  reason: string;
};

export type SiteAuthRequirementResult = {
  siteId: number;
  hasThirdPartyLogin: boolean;
  requirements: SiteAuthRequirement[];
};
