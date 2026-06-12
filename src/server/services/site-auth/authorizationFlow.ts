import { randomUUID } from 'node:crypto';
import { fetch } from 'undici';
import { createSiteAuthCredential, type SiteAuthCredentialSummary } from './credentialVault.js';
import type { SiteAuthProviderId } from './providerTypes.js';

const SITE_AUTH_CALLBACK_PATH_PREFIX = '/api/site-auth/callback';
const MANUAL_CALLBACK_DELAY_MS = 15_000;

type SiteAuthAuthorizationStatus = 'pending' | 'success' | 'error';

type SiteAuthAuthorizationSession = {
  provider: SiteAuthProviderId;
  state: string;
  status: SiteAuthAuthorizationStatus;
  redirectUri: string;
  authorizationUrl: string;
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

function normalizeOrigin(origin: string): string {
  const clean = origin.trim().replace(/\/+$/, '');
  if (!clean) throw new Error('site auth authorization origin is required');
  return clean;
}

function buildRedirectUri(origin: string, provider: SiteAuthProviderId): string {
  return `${normalizeOrigin(origin)}${SITE_AUTH_CALLBACK_PATH_PREFIX}/${provider}`;
}

function requireEnv(name: string): string {
  const value = (process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function resolveAuthorizationUrl(provider: SiteAuthProviderId, state: string, redirectUri: string): string {
  if (provider === 'github') {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', requireEnv('SITE_AUTH_GITHUB_CLIENT_ID'));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'read:user user:email');
    return url.toString();
  }
  if (provider === 'google') {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', requireEnv('SITE_AUTH_GOOGLE_CLIENT_ID'));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    return url.toString();
  }
  return 'https://linux.do/login';
}

export function startSiteAuthAuthorization(provider: SiteAuthProviderId, origin: string): SiteAuthAuthorizationStartResult {
  const state = randomUUID();
  const redirectUri = buildRedirectUri(origin, provider);
  const authorizationUrl = resolveAuthorizationUrl(provider, state, redirectUri);
  const mode = provider === 'linuxdo' ? 'browser_login' : 'oauth';
  sessions.set(state, {
    provider,
    state,
    status: 'pending',
    redirectUri,
    authorizationUrl,
  });
  return {
    provider,
    state,
    authorizationUrl,
    instructions: {
      redirectUri,
      callbackPath: `${SITE_AUTH_CALLBACK_PATH_PREFIX}/${provider}`,
      manualCallbackDelayMs: MANUAL_CALLBACK_DELAY_MS,
      mode,
    },
  };
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

async function exchangeGitHubCode(code: string, redirectUri: string): Promise<Record<string, unknown>> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: requireEnv('SITE_AUTH_GITHUB_CLIENT_ID'),
      client_secret: requireEnv('SITE_AUTH_GITHUB_CLIENT_SECRET'),
      code,
      redirect_uri: redirectUri,
    }),
  });
  const body = await response.json() as any;
  if (!response.ok || !body?.access_token) {
    throw new Error(body?.error_description || body?.error || `GitHub returned HTTP ${response.status}`);
  }
  return {
    accessToken: body.access_token,
    tokenType: body.token_type,
    scope: body.scope,
  };
}

async function exchangeGoogleCode(code: string, redirectUri: string): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    client_id: requireEnv('SITE_AUTH_GOOGLE_CLIENT_ID'),
    client_secret: requireEnv('SITE_AUTH_GOOGLE_CLIENT_SECRET'),
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json() as any;
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || payload?.error || `Google returned HTTP ${response.status}`);
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    idToken: payload.id_token,
    expiresIn: payload.expires_in,
    tokenType: payload.token_type,
    scope: payload.scope,
  };
}

export async function completeSiteAuthAuthorizationCallback(input: {
  provider: SiteAuthProviderId;
  state: string;
  code?: string | null;
  error?: string | null;
}): Promise<SiteAuthAuthorizationSessionInfo> {
  const session = sessions.get(input.state);
  if (!session || session.provider !== input.provider) {
    throw new Error('site auth authorization state mismatch');
  }
  if (input.error) {
    session.status = 'error';
    session.error = input.error;
    return getSiteAuthAuthorizationSession(session.state)!;
  }
  const code = (input.code || '').trim();
  if (!code) throw new Error('site auth authorization code is required');
  if (input.provider === 'linuxdo') throw new Error('LinuxDO browser login does not return an OAuth code');

  try {
    const payload = input.provider === 'github'
      ? await exchangeGitHubCode(code, session.redirectUri)
      : await exchangeGoogleCode(code, session.redirectUri);
    const credential = await createSiteAuthCredential({
      provider: input.provider,
      label: `${input.provider === 'github' ? 'GitHub' : 'Google'} 浏览器授权`,
      credentialType: 'oauth_token',
      payload,
      metadata: { source: 'site-auth-oauth-popup' },
    });
    session.status = 'success';
    session.credential = credential;
    return getSiteAuthAuthorizationSession(session.state)!;
  } catch (error: any) {
    session.status = 'error';
    session.error = error?.message || 'site auth authorization failed';
    throw error;
  }
}

export function renderSiteAuthCallbackPage(session: SiteAuthAuthorizationSessionInfo): string {
  const status = session.status === 'success' ? 'success' : 'error';
  const message = status === 'success' ? '授权已保存，可以关闭窗口。' : (session.error || '授权失败');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Metapi Site Auth</title></head><body><script>try{window.opener&&window.opener.postMessage(${JSON.stringify({ type: 'metapi-site-auth', status, state: session.state })}, '*')}catch(e){}</script><p>${message}</p></body></html>`;
}
