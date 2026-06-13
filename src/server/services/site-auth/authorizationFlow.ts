import { constants, generateKeyPairSync, privateDecrypt, randomUUID } from 'node:crypto';
import { fetch } from 'undici';
import { createSiteAuthCredential, type SiteAuthCredentialSummary } from './credentialVault.js';
import type { SiteAuthProviderId } from './providerTypes.js';

const SITE_AUTH_CALLBACK_PATH_PREFIX = '/api/site-auth/callback';
const MANUAL_CALLBACK_DELAY_MS = 15_000;
const LINUXDO_ORIGIN = 'https://linux.do';

type SiteAuthAuthorizationStatus = 'pending' | 'success' | 'error';

type SiteAuthAuthorizationSession = {
  provider: SiteAuthProviderId;
  state: string;
  status: SiteAuthAuthorizationStatus;
  redirectUri: string;
  authorizationUrl: string;
  privateKeyPem?: string;
  nonce?: string;
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

type ResolvedAuthorizationRequest = {
  authorizationUrl: string;
  privateKeyPem?: string;
  nonce?: string;
  mode: 'oauth' | 'browser_login';
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

function createLinuxDoAuthorizationRequest(state: string, redirectUri: string): ResolvedAuthorizationRequest {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const nonce = randomUUID();
  const url = new URL('/user-api-key/new', LINUXDO_ORIGIN);
  url.searchParams.set('auth_redirect', redirectUri);
  url.searchParams.set('application_name', 'Metapi');
  url.searchParams.set('client_id', `metapi-${state}`);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('scopes', 'read,one_time_password');
  url.searchParams.set('public_key', publicKey);
  url.searchParams.set('padding', 'oaep');
  return {
    authorizationUrl: url.toString(),
    privateKeyPem: privateKey,
    nonce,
    mode: 'oauth',
  };
}

function resolveAuthorizationRequest(provider: SiteAuthProviderId, state: string, redirectUri: string): ResolvedAuthorizationRequest {
  if (provider === 'github') {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', requireEnv('SITE_AUTH_GITHUB_CLIENT_ID'));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'read:user user:email');
    return { authorizationUrl: url.toString(), mode: 'oauth' };
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
    return { authorizationUrl: url.toString(), mode: 'oauth' };
  }
  return createLinuxDoAuthorizationRequest(state, redirectUri);
}

export function startSiteAuthAuthorization(provider: SiteAuthProviderId, origin: string): SiteAuthAuthorizationStartResult {
  const state = randomUUID();
  const redirectUri = buildRedirectUri(origin, provider);
  const authorization = resolveAuthorizationRequest(provider, state, redirectUri);
  sessions.set(state, {
    provider,
    state,
    status: 'pending',
    redirectUri,
    authorizationUrl: authorization.authorizationUrl,
    privateKeyPem: authorization.privateKeyPem,
    nonce: authorization.nonce,
  });
  return {
    provider,
    state,
    authorizationUrl: authorization.authorizationUrl,
    instructions: {
      redirectUri,
      callbackPath: `${SITE_AUTH_CALLBACK_PATH_PREFIX}/${provider}`,
      manualCallbackDelayMs: MANUAL_CALLBACK_DELAY_MS,
      mode: authorization.mode,
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

function decryptLinuxDoValue(session: SiteAuthAuthorizationSession, value: string | null | undefined, label: string): string {
  const encrypted = (value || '').trim().replace(/ /g, '+');
  if (!encrypted) throw new Error(`LinuxDO authorization ${label} is required`);
  if (!session.privateKeyPem) throw new Error('LinuxDO authorization private key is missing');
  try {
    return privateDecrypt(
      {
        key: session.privateKeyPem,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(encrypted, 'base64'),
    ).toString('utf8');
  } catch {
    throw new Error(`LinuxDO authorization ${label} cannot be decrypted`);
  }
}

function parseJsonRecord(text: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  throw new Error(`LinuxDO authorization ${label} is invalid`);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function resolveLinuxDoOneTimePassword(text: string): string {
  const raw = text.trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'string') return parsed.trim();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return asTrimmedString(record.oneTimePassword)
        || asTrimmedString(record.one_time_password)
        || asTrimmedString(record.otp)
        || asTrimmedString(record.password);
    }
  } catch {}
  return raw;
}

function collectSetCookieHeaders(headers: any): string[] {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') {
    const values = headers.getSetCookie();
    if (Array.isArray(values)) return values.filter((value) => typeof value === 'string' && value.trim());
  }
  if (typeof headers.raw === 'function') {
    const raw = headers.raw();
    const values = raw?.['set-cookie'];
    if (Array.isArray(values)) return values.filter((value) => typeof value === 'string' && value.trim());
  }
  if (typeof headers.get === 'function') {
    const value = headers.get('set-cookie');
    if (typeof value === 'string' && value.trim()) return [value];
  }
  return [];
}

function buildCookieHeaderFromSetCookie(setCookieHeaders: string[]): string {
  const cookies = new Map<string, string>();
  for (const header of setCookieHeaders) {
    const pair = header.split(';')[0]?.trim() || '';
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex <= 0) continue;
    cookies.set(pair.slice(0, separatorIndex), pair);
  }
  return Array.from(cookies.values()).join('; ');
}

async function exchangeLinuxDoOneTimePasswordForCookie(oneTimePassword: string): Promise<string> {
  const normalizedOtp = oneTimePassword.trim();
  if (!normalizedOtp) throw new Error('LinuxDO authorization one-time password is empty');
  const response = await fetch(`${LINUXDO_ORIGIN}/session/otp/${encodeURIComponent(normalizedOtp)}`, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'Metapi site-auth LinuxDO authorization',
    },
    signal: AbortSignal.timeout(15_000),
  });
  const cookie = buildCookieHeaderFromSetCookie(collectSetCookieHeaders((response as any).headers));
  if (!cookie || !/(^|;\s*)ld_auth_session=/i.test(cookie)) {
    throw new Error(`LinuxDO authorization did not return a session cookie${response.status ? ` (HTTP ${response.status})` : ''}`);
  }
  return cookie;
}

async function completeLinuxDoAuthorizationCallback(
  session: SiteAuthAuthorizationSession,
  input: { payload?: string | null; oneTimePassword?: string | null },
): Promise<SiteAuthAuthorizationSessionInfo> {
  const payloadText = decryptLinuxDoValue(session, input.payload, 'payload');
  const payload = parseJsonRecord(payloadText, 'payload');
  const nonce = asTrimmedString(payload.nonce);
  if (!session.nonce || nonce !== session.nonce) {
    throw new Error('LinuxDO authorization nonce mismatch');
  }

  const otpText = decryptLinuxDoValue(session, input.oneTimePassword, 'one-time password');
  const cookie = await exchangeLinuxDoOneTimePasswordForCookie(resolveLinuxDoOneTimePassword(otpText));
  const user = asRecord(payload.user);
  const username = asTrimmedString(payload.username) || asTrimmedString(user?.username);
  const subject = asTrimmedString(payload.user_id) || asTrimmedString(payload.userId) || asTrimmedString(payload.id);
  const userApiKey = asTrimmedString(payload.key);
  const credential = await createSiteAuthCredential({
    provider: 'linuxdo',
    label: username ? `LinuxDO ${username}` : 'LinuxDO 浏览器授权',
    subject: subject || null,
    username: username || null,
    credentialType: 'cookie',
    payload: {
      cookie,
      ...(userApiKey ? { userApiKey } : {}),
    },
    metadata: {
      source: 'linuxdo-user-api-key-popup',
      authApiVersion: payload.api,
    },
  });
  session.status = 'success';
  session.credential = credential;
  return getSiteAuthAuthorizationSession(session.state)!;
}

export async function completeSiteAuthAuthorizationCallback(input: {
  provider: SiteAuthProviderId;
  state: string;
  code?: string | null;
  payload?: string | null;
  oneTimePassword?: string | null;
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
  if (input.provider === 'linuxdo') {
    try {
      return await completeLinuxDoAuthorizationCallback(session, input);
    } catch (error: any) {
      session.status = 'error';
      session.error = error?.message || 'LinuxDO authorization failed';
      throw error;
    }
  }
  const code = (input.code || '').trim();
  if (!code) throw new Error('site auth authorization code is required');

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
