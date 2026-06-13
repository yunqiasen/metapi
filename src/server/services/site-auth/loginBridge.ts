import type {
  ExternalBrowserLoginStartResult,
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

export type StartSiteAuthBrowserLoginInput = {
  site: SiteAuthLoginSiteInput;
  adapter: PlatformAdapter;
  provider: SiteAuthProviderId;
};

function normalizeSiteUrl(site: SiteAuthLoginSiteInput): string {
  const url = typeof site.url === 'string' ? site.url.trim() : '';
  if (!url) throw new Error('target site URL is required');
  return url;
}

export function toSafeSiteAuthBridgeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/timeout|ETIMEDOUT|ECONNRESET/i.test(message)) {
    return '第三方登录桥接失败：目标站点连接超时。';
  }
  if (/401|403|unauthorized|forbidden/i.test(message)) {
    return '第三方登录桥接失败：凭证无效或目标站点拒绝授权。';
  }
  return '第三方登录桥接失败：目标站点没有返回可用 Session。';
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

export async function startSiteAuthBrowserLogin({
  site,
  adapter,
  provider,
}: StartSiteAuthBrowserLoginInput): Promise<ExternalBrowserLoginStartResult> {
  if (typeof adapter.startExternalBrowserLogin !== 'function') {
    throw new Error('target site does not support browser third-party login');
  }
  const result = await adapter.startExternalBrowserLogin(normalizeSiteUrl(site), {
    sourceProvider: provider,
  });
  const authorizationUrl = typeof result.authorizationUrl === 'string'
    ? result.authorizationUrl.trim()
    : '';
  if (!authorizationUrl) {
    throw new Error('target site browser login did not return an authorization URL');
  }
  return {
    ...result,
    authorizationUrl,
  };
}
