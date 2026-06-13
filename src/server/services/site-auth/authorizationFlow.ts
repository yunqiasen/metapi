import { randomUUID } from 'node:crypto';
import { fetch } from 'undici';
import {
  createSiteAuthCredential,
  type SiteAuthCredentialSummary,
} from './credentialVault.js';
import type { SiteAuthProviderId } from './providerTypes.js';

const SITE_AUTH_CALLBACK_PATH_PREFIX = '/api/site-auth/callback';
const MANUAL_CALLBACK_DELAY_MS = 15_000;

type SiteAuthAuthorizationStatus = 'pending' | 'success' | 'error';

type SiteAuthAuthorizationSession = {
  provider: SiteAuthProviderId;
  state: string;
  status: SiteAuthAuthorizationStatus;
  redirectUri: string;
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

type OAuthClientConfig = {
  clientId: string;
  clientSecret: string;
};

type OAuthTokenResult = {
  accessToken: string;
  tokenType?: string;
  scope?: string;
  refreshToken?: string;
  expiresIn?: number;
  idToken?: string;
};

type ProviderIdentity = {
  subject: string;
  username?: string | null;
  email?: string | null;
};

const sessions = new Map<string, SiteAuthAuthorizationSession>();

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveOrigin(origin: string): string {
  const trimmed = origin.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('site auth callback origin is required');
  return trimmed;
}

function resolveCallbackPath(provider: SiteAuthProviderId): string {
  return `${SITE_AUTH_CALLBACK_PATH_PREFIX}/${provider}`;
}

function resolveCallbackUri(provider: SiteAuthProviderId, origin: string): string {
  return `${resolveOrigin(origin)}${resolveCallbackPath(provider)}`;
}

function getOAuthClientConfig(provider: SiteAuthProviderId): OAuthClientConfig {
  if (provider === 'github') {
    const clientId = asTrimmedString(process.env.SITE_AUTH_GITHUB_CLIENT_ID);
    const clientSecret = asTrimmedString(process.env.SITE_AUTH_GITHUB_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      throw new Error('GitHub site-auth OAuth is not configured: set SITE_AUTH_GITHUB_CLIENT_ID and SITE_AUTH_GITHUB_CLIENT_SECRET');
    }
    return { clientId, clientSecret };
  }
  if (provider === 'google') {
    const clientId = asTrimmedString(process.env.SITE_AUTH_GOOGLE_CLIENT_ID);
    const clientSecret = asTrimmedString(process.env.SITE_AUTH_GOOGLE_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      throw new Error('Google site-auth OAuth is not configured: set SITE_AUTH_GOOGLE_CLIENT_ID and SITE_AUTH_GOOGLE_CLIENT_SECRET');
    }
    return { clientId, clientSecret };
  }
  throw new Error('LinuxDO automatic OAuth is not configured; use manual LinuxDO cookie import for now');
}

function resolveProviderBrowserLoginUrl(provider: SiteAuthProviderId): string {
  if (provider === 'github') return 'https://github.com/login';
  if (provider === 'google') return 'https://accounts.google.com/';
  return 'https://linux.do/login';
}

function createStartResult(
  provider: SiteAuthProviderId,
  state: string,
  redirectUri: string,
  authorizationUrl: string,
  mode: 'oauth' | 'browser_login' = 'oauth',
): SiteAuthAuthorizationStartResult {
  return {
    provider,
    state,
    authorizationUrl,
    instructions: {
      redirectUri,
      callbackPath: resolveCallbackPath(provider),
      manualCallbackDelayMs: MANUAL_CALLBACK_DELAY_MS,
      mode,
    },
  };
}

function startProviderBrowserLogin(provider: SiteAuthProviderId): SiteAuthAuthorizationStartResult {
  const state = randomUUID();
  sessions.set(state, {
    provider,
    state,
    status: 'pending',
    redirectUri: '',
  });
  return createStartResult(
    provider,
    state,
    '',
    resolveProviderBrowserLoginUrl(provider),
    'browser_login',
  );
}

function buildGitHubAuthorizationUrl(config: OAuthClientConfig, state: string, redirectUri: string): string {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  return url.toString();
}

function buildGoogleAuthorizationUrl(config: OAuthClientConfig, state: string, redirectUri: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  return url.toString();
}

export function startSiteAuthAuthorization(provider: SiteAuthProviderId, origin: string): SiteAuthAuthorizationStartResult {
  if (provider === 'linuxdo') return startProviderBrowserLogin(provider);

  let config: OAuthClientConfig;
  try {
    config = getOAuthClientConfig(provider);
  } catch {
    return startProviderBrowserLogin(provider);
  }
  const state = randomUUID();
  const redirectUri = resolveCallbackUri(provider, origin);
  const authorizationUrl = provider === 'github'
    ? buildGitHubAuthorizationUrl(config, state, redirectUri)
    : buildGoogleAuthorizationUrl(config, state, redirectUri);
  sessions.set(state, {
    provider,
    state,
    status: 'pending',
    redirectUri,
  });
  return createStartResult(provider, state, redirectUri, authorizationUrl);
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

async function readJsonResponse(response: { ok?: boolean; status?: number; json: () => Promise<unknown> }, label: string): Promise<any> {
  const body = await response.json() as any;
  if (!response.ok) {
    const message = asTrimmedString(body?.error_description) || asTrimmedString(body?.error) || `${label} returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function exchangeGitHubCode(code: string, config: OAuthClientConfig, redirectUri: string): Promise<OAuthTokenResult> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Metapi site-auth OAuth',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await readJsonResponse(response, 'GitHub token exchange');
  const accessToken = asTrimmedString(data?.access_token);
  if (!accessToken) throw new Error('GitHub token exchange did not return access_token');
  return {
    accessToken,
    tokenType: asTrimmedString(data?.token_type),
    scope: asTrimmedString(data?.scope),
  };
}

async function exchangeGoogleCode(code: string, config: OAuthClientConfig, redirectUri: string): Promise<OAuthTokenResult> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Metapi site-auth OAuth',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await readJsonResponse(response, 'Google token exchange');
  const accessToken = asTrimmedString(data?.access_token);
  if (!accessToken) throw new Error('Google token exchange did not return access_token');
  return {
    accessToken,
    tokenType: asTrimmedString(data?.token_type),
    scope: asTrimmedString(data?.scope),
    refreshToken: asTrimmedString(data?.refresh_token),
    expiresIn: Number.isFinite(data?.expires_in) ? Number(data.expires_in) : undefined,
    idToken: asTrimmedString(data?.id_token),
  };
}

async function fetchGitHubIdentity(accessToken: string): Promise<ProviderIdentity> {
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Metapi site-auth OAuth',
    },
    signal: AbortSignal.timeout(15_000),
  });
  const user = await readJsonResponse(userResponse, 'GitHub user lookup');
  const subject = user?.id === undefined || user?.id === null ? '' : String(user.id).trim();
  if (!subject) throw new Error('GitHub user id is missing');
  let email = asTrimmedString(user?.email);
  try {
    const emailResponse = await fetch('https://api.github.com/user/emails?per_page=100', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Metapi site-auth OAuth',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (emailResponse.ok) {
      const emails = await emailResponse.json() as any;
      if (Array.isArray(emails)) {
        const primary = emails.find((item) => item?.primary === true && item?.verified !== false)
          || emails.find((item) => item?.verified !== false)
          || emails[0];
        email = asTrimmedString(primary?.email) || email;
      }
    }
  } catch {}
  return {
    subject,
    username: asTrimmedString(user?.login) || null,
    email: email || null,
  };
}

async function fetchGoogleIdentity(accessToken: string): Promise<ProviderIdentity> {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'Metapi site-auth OAuth',
    },
    signal: AbortSignal.timeout(15_000),
  });
  const data = await readJsonResponse(response, 'Google userinfo lookup');
  const subject = asTrimmedString(data?.sub);
  if (!subject) throw new Error('Google subject is missing');
  return {
    subject,
    username: asTrimmedString(data?.name) || null,
    email: asTrimmedString(data?.email) || null,
  };
}

async function createCredentialFromOAuth(
  provider: SiteAuthProviderId,
  token: OAuthTokenResult,
  identity: ProviderIdentity,
  redirectUri: string,
): Promise<SiteAuthCredentialSummary> {
  const providerLabel = provider === 'github' ? 'GitHub' : 'Google';
  const displayName = identity.username || identity.email || identity.subject;
  return createSiteAuthCredential({
    provider,
    label: `${providerLabel} · ${displayName}`,
    subject: identity.subject,
    email: identity.email || null,
    username: identity.username || null,
    credentialType: 'oauth_token',
    payload: {
      accessToken: token.accessToken,
      ...(token.tokenType ? { tokenType: token.tokenType } : {}),
      ...(token.scope ? { scope: token.scope } : {}),
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      ...(token.expiresIn ? { expiresIn: token.expiresIn } : {}),
      ...(token.idToken ? { idToken: token.idToken } : {}),
    },
    metadata: {
      source: 'provider-oauth-callback',
      redirectUri,
    },
  });
}

export async function completeSiteAuthAuthorizationCallback(input: {
  provider: SiteAuthProviderId;
  state: string;
  code?: string | null;
  payload?: string | null;
  oneTimePassword?: string | null;
  error?: string | null;
}): Promise<SiteAuthAuthorizationSessionInfo> {
  void input.payload;
  void input.oneTimePassword;

  const session = sessions.get(input.state);
  if (!session || session.provider !== input.provider) {
    throw new Error('site auth authorization state mismatch');
  }

  const providerLabel = input.provider === 'github' ? 'GitHub' : input.provider === 'google' ? 'Google' : 'LinuxDO';
  try {
    const callbackError = asTrimmedString(input.error);
    if (callbackError) throw new Error(callbackError);
    const code = asTrimmedString(input.code);
    if (!code) throw new Error(`${providerLabel} callback is missing code`);
    const config = getOAuthClientConfig(input.provider);
    const token = input.provider === 'github'
      ? await exchangeGitHubCode(code, config, session.redirectUri)
      : await exchangeGoogleCode(code, config, session.redirectUri);
    const identity = input.provider === 'github'
      ? await fetchGitHubIdentity(token.accessToken)
      : await fetchGoogleIdentity(token.accessToken);
    const credential = await createCredentialFromOAuth(input.provider, token, identity, session.redirectUri);
    session.status = 'success';
    session.credential = credential;
    session.error = undefined;
  } catch (error: any) {
    session.status = 'error';
    session.error = error?.message || `${providerLabel} authorization failed`;
  }
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
  disabledMessage: 'site-auth provider OAuth callback flow is enabled for GitHub and Google',
};
