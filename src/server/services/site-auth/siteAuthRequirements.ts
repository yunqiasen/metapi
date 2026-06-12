import { fetch } from 'undici';
import { withSiteRecordProxyRequestInit } from '../siteProxy.js';
import { getSiteAuthProviderDefinition } from './providers.js';
import type {
  SiteAuthProviderId,
  SiteAuthRequirement,
  SiteAuthRequirementResult,
} from './providerTypes.js';

type SiteAuthRequirementSiteInput = {
  id: number;
  name?: string | null;
  url?: string | null;
  platform?: string | null;
  proxyUrl?: string | null;
  useSystemProxy?: boolean | null;
  customHeaders?: string | null;
  metadata?: Record<string, unknown> | string | null;
};

type ResolveSiteAuthRequirementsInput = {
  site: SiteAuthRequirementSiteInput;
  html?: string | null;
};

export type SiteAuthTargetSite = {
  id: number;
  name: string;
  url: string;
  platform: string;
  status?: string | null;
  requirementReason?: string | null;
};

const SITE_AUTH_REQUIREMENTS_HTML_TIMEOUT_MS = 10_000;
const SITE_AUTH_REQUIREMENTS_HTML_MAX_BYTES = 256_000;

function parseMetadata(value: SiteAuthRequirementSiteInput['metadata']): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeProvider(value: unknown): SiteAuthProviderId | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'linuxdo' || normalized === 'github' || normalized === 'google') return normalized;
  return null;
}

function uniqueProviders(values: SiteAuthProviderId[]): SiteAuthProviderId[] {
  return Array.from(new Set(values));
}

function getExplicitProviders(metadata: Record<string, unknown>): SiteAuthProviderId[] {
  const raw = metadata.siteAuthProviders;
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return uniqueProviders(values.map(normalizeProvider).filter((item): item is SiteAuthProviderId => Boolean(item)));
}

function detectProvidersFromHtml(html: string): SiteAuthProviderId[] {
  const providers: SiteAuthProviderId[] = [];
  const text = html || '';
  const lowerText = text.toLowerCase();

  if (/linuxdo|linux\.do|使用\s*linuxdo\s*继续/i.test(text)) providers.push('linuxdo');
  if (lowerText.includes('github.com/login/oauth') || /github/i.test(text)) providers.push('github');
  if (lowerText.includes('accounts.google.com') || /google/i.test(text)) providers.push('google');

  return uniqueProviders(providers);
}

function buildRequirement(
  provider: SiteAuthProviderId,
  confidence: SiteAuthRequirement['confidence'],
  reason: string,
): SiteAuthRequirement {
  const definition = getSiteAuthProviderDefinition(provider);
  return {
    provider,
    label: definition?.metadata.label || provider,
    required: true,
    confidence,
    reason,
  };
}

export function resolveSiteAuthRequirements(input: ResolveSiteAuthRequirementsInput): SiteAuthRequirementResult {
  const metadata = parseMetadata(input.site.metadata);
  const explicitProviders = getExplicitProviders(metadata);
  const detectedProviders = explicitProviders.length > 0 ? [] : detectProvidersFromHtml(input.html || '');
  const requirements = explicitProviders.length > 0
    ? explicitProviders.map((provider) => buildRequirement(provider, 'explicit', 'site metadata declares this login provider'))
    : detectedProviders.map((provider) => buildRequirement(provider, 'detected', 'login page contains this provider'));

  return {
    siteId: input.site.id,
    hasThirdPartyLogin: requirements.length > 0,
    requirements,
  };
}

async function fetchSiteLoginHtml(site: SiteAuthRequirementSiteInput): Promise<string | null> {
  const url = typeof site.url === 'string' ? site.url.trim() : '';
  if (!url) return null;

  try {
    const response = await fetch(url, withSiteRecordProxyRequestInit(site, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'User-Agent': 'Metapi site-auth requirements probe',
      },
      signal: AbortSignal.timeout(SITE_AUTH_REQUIREMENTS_HTML_TIMEOUT_MS),
    }));
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return null;

    const html = await response.text();
    return html.slice(0, SITE_AUTH_REQUIREMENTS_HTML_MAX_BYTES);
  } catch {
    return null;
  }
}

export async function resolveSiteAuthRequirementsForSite(
  site: SiteAuthRequirementSiteInput,
): Promise<SiteAuthRequirementResult> {
  const explicit = resolveSiteAuthRequirements({ site });
  if (explicit.hasThirdPartyLogin) return explicit;

  const html = await fetchSiteLoginHtml(site);
  return resolveSiteAuthRequirements({ site, html });
}

export async function listTargetSitesForSiteAuthProvider(
  provider: SiteAuthProviderId,
  sites: SiteAuthRequirementSiteInput[],
): Promise<SiteAuthTargetSite[]> {
  const targetSites: SiteAuthTargetSite[] = [];
  for (const site of sites) {
    const result = await resolveSiteAuthRequirementsForSite(site);
    const matchingRequirement = result.requirements.find((requirement) => requirement.provider === provider);
    if (!matchingRequirement) continue;
    targetSites.push({
      id: site.id,
      name: site.name || `site-${site.id}`,
      url: site.url || '',
      platform: site.platform || '',
      status: typeof (site as { status?: unknown }).status === 'string'
        ? (site as { status?: string }).status
        : null,
      requirementReason: matchingRequirement.reason,
    });
  }
  return targetSites;
}
