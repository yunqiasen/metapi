import type { SiteAuthCredentialType, SiteAuthProviderId } from './providerTypes.js';

export type SiteAuthCaptureParseResult = {
  provider: SiteAuthProviderId;
  credentialType: SiteAuthCredentialType;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

function normalizeProvider(value?: string | null): SiteAuthProviderId | null {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'linuxdo' || normalized === 'github' || normalized === 'google') return normalized;
  return null;
}

function extractLinuxDoSessionCookie(text: string): string | null {
  const normalized = text.trim().replace(/^cookie:\s*/i, '');
  const match = normalized.match(/(?:^|;\s*)ld_auth_session=([^;\s]+)/i);
  if (!match?.[1]) return null;
  return `ld_auth_session=${match[1]}`;
}

function parseLinuxDoCookie(text: string, defaultProvider?: SiteAuthProviderId): SiteAuthCaptureParseResult | null {
  const cookie = extractLinuxDoSessionCookie(text);
  if (!cookie || defaultProvider !== 'linuxdo') return null;
  return {
    provider: 'linuxdo',
    credentialType: 'cookie',
    payload: { cookie },
    metadata: { captureMode: 'browser_assisted' },
  };
}

export function parseSiteAuthCaptureText(
  text: string,
  defaultProvider?: SiteAuthProviderId,
): SiteAuthCaptureParseResult {
  const trimmed = text.trim();
  const normalizedDefaultProvider = normalizeProvider(defaultProvider);
  if (!trimmed) {
    throw new Error('no supported site auth credential found');
  }

  const linuxDoCookie = parseLinuxDoCookie(trimmed, normalizedDefaultProvider || undefined);
  if (linuxDoCookie) return linuxDoCookie;

  throw new Error('no supported site auth credential found');
}
