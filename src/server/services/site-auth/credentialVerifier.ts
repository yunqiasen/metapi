import { fetch } from 'undici';
import {
  getSiteAuthCredential,
  getSiteAuthCredentialPayload,
  updateSiteAuthCredentialPayload,
  updateSiteAuthCredential,
  type SiteAuthCredentialSummary,
} from './credentialVault.js';
import {
  isOAuthTokenExpired,
  mergeRefreshedOAuthPayload,
  resolveOAuthTokenExpiresAt,
  type SiteAuthOAuthTokenPayload,
} from './oauthToken.js';
import type { SiteAuthProviderId } from './providerTypes.js';

type LinuxDoCurrentUser = {
  id?: unknown;
  username?: unknown;
  email?: unknown;
};

type LinuxDoCurrentSessionResponse = {
  current_user?: LinuxDoCurrentUser;
  user?: LinuxDoCurrentUser;
};

type OAuthIdentity = {
  subject: string;
  username?: string | null;
  email?: string | null;
};

type OAuthRefreshResult = {
  payload: SiteAuthOAuthTokenPayload;
  expiresAt: string | null;
};

export type SiteAuthCredentialVerificationResult = {
  success: boolean;
  item: SiteAuthCredentialSummary;
  message?: string;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readProviderClientConfig(provider: SiteAuthProviderId): { clientId: string; clientSecret: string } {
  if (provider === 'google') {
    const clientId = asTrimmedString(process.env.SITE_AUTH_GOOGLE_CLIENT_ID);
    const clientSecret = asTrimmedString(process.env.SITE_AUTH_GOOGLE_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      throw new Error('Google site-auth OAuth refresh is not configured');
    }
    return { clientId, clientSecret };
  }
  if (provider === 'linuxdo') {
    const clientId = asTrimmedString(process.env.SITE_AUTH_LINUXDO_CLIENT_ID);
    const clientSecret = asTrimmedString(process.env.SITE_AUTH_LINUXDO_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      throw new Error('LinuxDO site-auth OAuth refresh is not configured');
    }
    return { clientId, clientSecret };
  }
  throw new Error(`${provider} OAuth refresh is not supported`);
}

async function readJsonResponse(response: { ok?: boolean; status?: number; json: () => Promise<unknown> }, label: string): Promise<any> {
  const body = await response.json() as any;
  if (!response.ok) {
    const message = asTrimmedString(body?.error_description) || asTrimmedString(body?.error) || `${label} returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function refreshGoogleOAuthToken(refreshToken: string): Promise<SiteAuthOAuthTokenPayload> {
  const config = readProviderClientConfig('google');
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Metapi site-auth verifier',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await readJsonResponse(response, 'Google token refresh');
  const accessToken = asTrimmedString(data?.access_token);
  if (!accessToken) throw new Error('Google token refresh did not return access_token');
  return {
    accessToken,
    tokenType: asTrimmedString(data?.token_type),
    scope: asTrimmedString(data?.scope),
    refreshToken: asTrimmedString(data?.refresh_token) || refreshToken,
    expiresIn: Number.isFinite(data?.expires_in) ? Number(data.expires_in) : undefined,
    idToken: asTrimmedString(data?.id_token),
  };
}

async function refreshLinuxDoOAuthToken(refreshToken: string): Promise<SiteAuthOAuthTokenPayload> {
  const config = readProviderClientConfig('linuxdo');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const response = await fetch(asTrimmedString(process.env.SITE_AUTH_LINUXDO_TOKEN_ENDPOINT) || 'https://connect.linux.do/oauth2/token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Metapi site-auth verifier',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await readJsonResponse(response, 'LinuxDO token refresh');
  const accessToken = asTrimmedString(data?.access_token);
  if (!accessToken) throw new Error('LinuxDO token refresh did not return access_token');
  return {
    accessToken,
    tokenType: asTrimmedString(data?.token_type),
    scope: asTrimmedString(data?.scope),
    refreshToken: asTrimmedString(data?.refresh_token) || refreshToken,
    expiresIn: Number.isFinite(data?.expires_in) ? Number(data.expires_in) : undefined,
  };
}

async function refreshOAuthTokenIfNeeded(
  id: number,
  provider: SiteAuthProviderId,
  expiresAt: string | null | undefined,
  payload: Record<string, unknown>,
): Promise<OAuthRefreshResult> {
  const refreshToken = asTrimmedString(payload?.refreshToken);
  if (!refreshToken || !isOAuthTokenExpired(expiresAt)) {
    return { payload: payload as SiteAuthOAuthTokenPayload, expiresAt: expiresAt || null };
  }
  if (provider !== 'google' && provider !== 'linuxdo') {
    return { payload: payload as SiteAuthOAuthTokenPayload, expiresAt: expiresAt || null };
  }

  const refreshed = provider === 'google'
    ? await refreshGoogleOAuthToken(refreshToken)
    : await refreshLinuxDoOAuthToken(refreshToken);
  const nextPayload = mergeRefreshedOAuthPayload(payload, refreshed);
  const nextExpiresAt = resolveOAuthTokenExpiresAt(refreshed.expiresIn);
  await updateSiteAuthCredentialPayload(id, nextPayload);
  return { payload: nextPayload, expiresAt: nextExpiresAt };
}

function resolveLinuxDoUser(body: LinuxDoCurrentSessionResponse): LinuxDoCurrentUser | null {
  const user = body.current_user || body.user;
  return user && typeof user === 'object' ? user : null;
}

async function markCredentialInvalid(id: number, message: string): Promise<SiteAuthCredentialVerificationResult> {
  const item = await updateSiteAuthCredential(id, {
    status: 'invalid',
    lastVerifiedAt: new Date().toISOString(),
    lastError: message,
  });
  if (!item) throw new Error('site auth credential not found');
  return { success: false, item, message };
}

async function verifyLinuxDoCredential(id: number): Promise<SiteAuthCredentialVerificationResult> {
  const payload = await getSiteAuthCredentialPayload(id);
  const cookie = asTrimmedString(payload?.cookie);
  if (!cookie) {
    return markCredentialInvalid(id, 'LinuxDO credential is missing cookie');
  }

  try {
    const response = await fetch('https://linux.do/session/current.json', {
      headers: {
        Accept: 'application/json',
        Cookie: cookie,
        'User-Agent': 'Metapi site-auth verifier',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return markCredentialInvalid(id, `LinuxDO returned HTTP ${response.status}`);
    }

    const body = await response.json() as LinuxDoCurrentSessionResponse;
    const user = resolveLinuxDoUser(body);
    if (!user) {
      return markCredentialInvalid(id, 'LinuxDO current user is missing');
    }

    const subject = user.id === undefined || user.id === null ? '' : String(user.id).trim();
    const username = asTrimmedString(user.username);
    const email = asTrimmedString(user.email);
    const item = await updateSiteAuthCredential(id, {
      status: 'active',
      subject: subject || null,
      username: username || null,
      email: email || null,
      lastVerifiedAt: new Date().toISOString(),
      lastError: null,
    });
    if (!item) throw new Error('site auth credential not found');
    return { success: true, item };
  } catch (error: any) {
    return markCredentialInvalid(id, error?.message || 'LinuxDO verification failed');
  }
}

async function verifyOAuthTokenCredential(
  id: number,
  options: {
    provider: SiteAuthProviderId;
    expiresAt?: string | null;
    providerLabel: string;
    url: string;
    resolveIdentity: (body: any) => OAuthIdentity | null;
  },
): Promise<SiteAuthCredentialVerificationResult> {
  const storedPayload = await getSiteAuthCredentialPayload(id);
  const refreshed = await refreshOAuthTokenIfNeeded(id, options.provider, options.expiresAt, storedPayload || {});
  const accessToken = asTrimmedString(refreshed.payload?.accessToken);
  if (!accessToken) {
    return markCredentialInvalid(id, `${options.providerLabel} credential is missing access token`);
  }

  try {
    const response = await fetch(options.url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Metapi site-auth verifier',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return markCredentialInvalid(id, `${options.providerLabel} returned HTTP ${response.status}`);
    }

    const body = await response.json() as any;
    const identity = options.resolveIdentity(body);
    if (!identity?.subject) {
      return markCredentialInvalid(id, `${options.providerLabel} identity is missing`);
    }

    const item = await updateSiteAuthCredential(id, {
      status: 'active',
      subject: identity.subject,
      username: identity.username || null,
      email: identity.email || null,
      expiresAt: refreshed.expiresAt,
      lastVerifiedAt: new Date().toISOString(),
      lastError: null,
    });
    if (!item) throw new Error('site auth credential not found');
    return { success: true, item };
  } catch (error: any) {
    return markCredentialInvalid(id, error?.message || `${options.providerLabel} verification failed`);
  }
}

function resolveGitHubIdentity(body: any): OAuthIdentity | null {
  const subject = body?.id === undefined || body?.id === null ? '' : String(body.id).trim();
  if (!subject) return null;
  return {
    subject,
    username: asTrimmedString(body?.login) || null,
    email: asTrimmedString(body?.email) || null,
  };
}

function resolveGoogleIdentity(body: any): OAuthIdentity | null {
  const subject = asTrimmedString(body?.sub);
  if (!subject) return null;
  return {
    subject,
    username: asTrimmedString(body?.name) || null,
    email: asTrimmedString(body?.email) || null,
  };
}

async function verifySessionArtifactCredential(
  id: number,
  providerLabel: string,
): Promise<SiteAuthCredentialVerificationResult> {
  const payload = await getSiteAuthCredentialPayload(id);
  const cookies = Array.isArray(payload?.cookies) ? payload.cookies : [];
  const profileDir = asTrimmedString(payload?.profileDir);
  if (cookies.length === 0 && !profileDir) {
    return markCredentialInvalid(id, `${providerLabel} browser session artifact is empty`);
  }
  const item = await updateSiteAuthCredential(id, {
    status: 'active',
    lastVerifiedAt: new Date().toISOString(),
    lastError: null,
  });
  if (!item) throw new Error('site auth credential not found');
  return { success: true, item };
}

function resolveLinuxDoOAuthIdentity(body: any): OAuthIdentity | null {
  const subject = body?.id === undefined || body?.id === null ? '' : String(body.id).trim();
  if (!subject) return null;
  return {
    subject,
    username: asTrimmedString(body?.username) || asTrimmedString(body?.name) || null,
    email: asTrimmedString(body?.email) || null,
  };
}

export async function verifySiteAuthCredential(id: number): Promise<SiteAuthCredentialVerificationResult> {
  const credential = await getSiteAuthCredential(id);
  if (!credential) {
    throw new Error('site auth credential not found');
  }
  if (credential.provider === 'linuxdo') {
    if (credential.credentialType === 'oauth_token') {
      return verifyOAuthTokenCredential(id, {
        provider: 'linuxdo',
        expiresAt: credential.expiresAt,
        providerLabel: 'LinuxDO',
        url: 'https://connect.linux.do/api/user',
        resolveIdentity: resolveLinuxDoOAuthIdentity,
      });
    }
    return verifyLinuxDoCredential(id);
  }
  if (credential.provider === 'github') {
    if (credential.credentialType === 'session_artifact') {
      return verifySessionArtifactCredential(id, 'GitHub');
    }
    return verifyOAuthTokenCredential(id, {
      provider: 'github',
      expiresAt: credential.expiresAt,
      providerLabel: 'GitHub',
      url: 'https://api.github.com/user',
      resolveIdentity: resolveGitHubIdentity,
    });
  }
  if (credential.provider === 'google') {
    if (credential.credentialType === 'session_artifact') {
      return verifySessionArtifactCredential(id, 'Google');
    }
    return verifyOAuthTokenCredential(id, {
      provider: 'google',
      expiresAt: credential.expiresAt,
      providerLabel: 'Google',
      url: 'https://www.googleapis.com/oauth2/v3/userinfo',
      resolveIdentity: resolveGoogleIdentity,
    });
  }
  throw new Error(`site auth provider verification is not supported: ${credential.provider}`);
}
