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
  metadata?: Record<string, unknown> | string | null;
};

type ResolveSiteAuthRequirementsInput = {
  site: SiteAuthRequirementSiteInput;
  html?: string | null;
};

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
