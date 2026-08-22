import {
  getAgentRouterBalanceProxyUrlFromExtraConfig,
  resolveProxyUrlFromExtraConfig,
} from './accountExtraConfig.js';
import type { BalanceInfo } from './platforms/base.js';
import { withSiteRequestTimeout } from './siteProxy.js';

export function resolveAgentRouterBalanceProxyCandidates(
  extraConfig: string | Record<string, unknown> | null | undefined,
  environment: Record<string, string | undefined> = process.env,
): Array<string | undefined> {
  const rawCandidates: Array<string | undefined> = [
    resolveProxyUrlFromExtraConfig(extraConfig) ?? undefined,
    getAgentRouterBalanceProxyUrlFromExtraConfig(extraConfig) ?? undefined,
    environment.AGENTROUTER_BALANCE_PROXY_URL?.trim(),
    undefined,
  ];
  const seen = new Set<string>();
  const candidates: Array<string | undefined> = [];
  for (const candidate of rawCandidates) {
    const normalized = candidate?.trim();
    const key = normalized || '__direct__';
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(normalized || undefined);
  }
  return candidates;
}

export async function readAgentRouterBalanceWithProxyFallback(
  candidates: Array<string | undefined>,
  read: (proxyUrl: string | undefined) => Promise<BalanceInfo>,
  options: { timeoutMs?: number } = {},
): Promise<BalanceInfo | null> {
  const configuredTimeoutMs = Number.parseInt(
    String(process.env.METAPI_AGENTROUTER_MANAGEMENT_REQUEST_TIMEOUT_MS || '').trim(),
    10,
  );
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Math.max(1, Math.trunc(Number(options.timeoutMs)))
    : (Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 10_000);

  for (const proxyUrl of candidates) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const operation = Promise.resolve()
      .then(() => withSiteRequestTimeout(timeoutMs, () => read(proxyUrl)))
      .then((value) => ({ ok: true as const, value }))
      .catch(() => ({ ok: false as const }));
    const timeout = new Promise<{ ok: false }>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ ok: false }), timeoutMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([operation, timeout]);
    if (timer) clearTimeout(timer);
    if (outcome.ok) return outcome.value;
  }
  return null;
}
