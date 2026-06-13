import type { SiteAuthCredentialSummary } from './credentialVault.js';
import type { SiteAuthProviderId } from './providerTypes.js';

const SITE_AUTH_CALLBACK_PATH_PREFIX = '/api/site-auth/callback';
const MANUAL_CALLBACK_DELAY_MS = 15_000;
const LEGACY_SITE_AUTH_AUTHORIZATION_DISABLED = 'legacy site-auth provider authorization is disabled; use target-site session capture from connection management';

type SiteAuthAuthorizationStatus = 'pending' | 'success' | 'error';

type SiteAuthAuthorizationSession = {
  provider: SiteAuthProviderId;
  state: string;
  status: SiteAuthAuthorizationStatus;
  error?: string;
  credential?: SiteAuthCredentialSummary;
};

export type SiteAuthAuthorizationStartResult = {
  provider: SiteAuthProviderId;
  state: string;
  authorizationUrl: string;
  instructions: {
    redirectUri: string;
    callbackPath: string;
    manualCallbackDelayMs: number;
    mode: 'oauth' | 'browser_login';
  };
};

export type SiteAuthAuthorizationSessionInfo = {
  provider: SiteAuthProviderId;
  state: string;
  status: SiteAuthAuthorizationStatus;
  error?: string;
  credential?: SiteAuthCredentialSummary;
};

const sessions = new Map<string, SiteAuthAuthorizationSession>();

export function startSiteAuthAuthorization(provider: SiteAuthProviderId, origin: string): SiteAuthAuthorizationStartResult {
  void provider;
  void origin;
  throw new Error(LEGACY_SITE_AUTH_AUTHORIZATION_DISABLED);
}

export function getSiteAuthAuthorizationSession(state: string): SiteAuthAuthorizationSessionInfo | null {
  const session = sessions.get(state);
  if (!session) return null;
  return {
    provider: session.provider,
    state: session.state,
    status: session.status,
    ...(session.error ? { error: session.error } : {}),
    ...(session.credential ? { credential: session.credential } : {}),
  };
}

export async function completeSiteAuthAuthorizationCallback(input: {
  provider: SiteAuthProviderId;
  state: string;
  code?: string | null;
  payload?: string | null;
  oneTimePassword?: string | null;
  error?: string | null;
}): Promise<SiteAuthAuthorizationSessionInfo> {
  void input.code;
  void input.payload;
  void input.oneTimePassword;

  const session = sessions.get(input.state);
  if (!session || session.provider !== input.provider) {
    throw new Error('site auth authorization state mismatch');
  }

  session.status = 'error';
  session.error = (input.error || '').trim() || LEGACY_SITE_AUTH_AUTHORIZATION_DISABLED;
  return getSiteAuthAuthorizationSession(session.state)!;
}

export function renderSiteAuthCallbackPage(session: SiteAuthAuthorizationSessionInfo): string {
  const status = session.status === 'success' ? 'success' : 'error';
  const message = status === 'success' ? '授权已保存，可以关闭窗口。' : (session.error || '授权失败');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Metapi Site Auth</title></head><body><script>try{window.opener&&window.opener.postMessage(${JSON.stringify({ type: 'metapi-site-auth', status, state: session.state })}, '*')}catch(e){}</script><p>${message}</p></body></html>`;
}

export const siteAuthAuthorizationCompatibility = {
  callbackPathPrefix: SITE_AUTH_CALLBACK_PATH_PREFIX,
  manualCallbackDelayMs: MANUAL_CALLBACK_DELAY_MS,
  disabledMessage: LEGACY_SITE_AUTH_AUTHORIZATION_DISABLED,
};
