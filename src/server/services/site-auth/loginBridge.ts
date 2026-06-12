import type {
  ExternalAuthLoginResult,
  PlatformAdapter,
} from '../platforms/base.js';
import type { SiteAuthCredentialType, SiteAuthProviderId } from './providerTypes.js';

type SiteAuthLoginSiteInput = {
  url?: string | null;
};

type SiteAuthLoginCredentialInput = {
  provider: SiteAuthProviderId;
  credentialType: SiteAuthCredentialType;
  payload: Record<string, unknown>;
};

export type ResolveSiteAuthLoginInput = {
  site: SiteAuthLoginSiteInput;
  adapter: PlatformAdapter;
  credential: SiteAuthLoginCredentialInput;
};

function normalizeSiteUrl(site: SiteAuthLoginSiteInput): string {
  const url = typeof site.url === 'string' ? site.url.trim() : '';
  if (!url) throw new Error('target site URL is required');
  return url;
}

export async function resolveSiteAuthLogin({
  site,
  adapter,
  credential,
}: ResolveSiteAuthLoginInput): Promise<ExternalAuthLoginResult> {
  if (typeof adapter.externalAuthLogin !== 'function') {
    throw new Error('target site does not support third-party login bridge');
  }

  const result = await adapter.externalAuthLogin(normalizeSiteUrl(site), {
    sourceProvider: credential.provider,
    credentialType: credential.credentialType,
    payload: credential.payload,
  });
  const accessToken = typeof result.accessToken === 'string' ? result.accessToken.trim() : '';
  if (!accessToken) {
    throw new Error('target site login bridge did not return an access token');
  }

  return {
    ...result,
    accessToken,
  };
}
