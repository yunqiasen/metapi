import { fetch } from 'undici';
import {
  getSiteAuthCredential,
  getSiteAuthCredentialPayload,
  updateSiteAuthCredential,
  type SiteAuthCredentialSummary,
} from './credentialVault.js';

type LinuxDoCurrentUser = {
  id?: unknown;
  username?: unknown;
  email?: unknown;
};

type LinuxDoCurrentSessionResponse = {
  current_user?: LinuxDoCurrentUser;
  user?: LinuxDoCurrentUser;
};

export type SiteAuthCredentialVerificationResult = {
  success: boolean;
  item: SiteAuthCredentialSummary;
  message?: string;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

export async function verifySiteAuthCredential(id: number): Promise<SiteAuthCredentialVerificationResult> {
  const credential = await getSiteAuthCredential(id);
  if (!credential) {
    throw new Error('site auth credential not found');
  }
  if (credential.provider !== 'linuxdo') {
    throw new Error(`site auth provider verification is not supported: ${credential.provider}`);
  }
  return verifyLinuxDoCredential(id);
}
