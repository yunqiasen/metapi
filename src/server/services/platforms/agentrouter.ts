import { spawn } from 'node:child_process';
import { resolveEffectiveSiteProxyUrlByRequestUrl } from '../siteProxy.js';
import type { BalanceInfo } from './base.js';
import { NewApiAdapter } from './newApi.js';

const CURL_RESPONSE_LIMIT_BYTES = 1_048_576;
const CURL_TIMEOUT_MS = 35_000;
const DEFAULT_UNDICI_TIMEOUT_MS = 15_000;

type AgentRouterBalanceFallback = (
  baseUrl: string,
  accessToken: string,
  platformUserId: number,
) => Promise<BalanceInfo>;

export type AgentRouterAdapterOptions = {
  balanceFallback?: AgentRouterBalanceFallback;
  undiciTimeoutMs?: number;
};

export type AgentRouterCurlConfigInput = {
  requestUrl: string;
  accessToken: string;
  platformUserId: number;
  proxyUrl?: string | null;
};

type AgentRouterCurlDependencies = {
  resolveProxyUrl?: (requestUrl: string) => Promise<string | null>;
  runCurl?: (config: string) => Promise<string>;
};


export async function withAgentRouterBalanceTimeout<T>(
  operation: Promise<T>,
  timeoutMs = DEFAULT_UNDICI_TIMEOUT_MS,
): Promise<T> {
  const safeTimeoutMs = Math.max(1, Math.trunc(timeoutMs));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('agentrouter_undici_timeout')));
    }, safeTimeoutMs);
    timer.unref?.();
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function quoteCurlConfigValue(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('invalid_curl_config_value');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveInteger(value: unknown): number | null {
  const parsed = parseFiniteNumber(value);
  return parsed != null && parsed > 0 ? Math.trunc(parsed) : null;
}

export function buildAgentRouterCurlConfig(input: AgentRouterCurlConfigInput): string {
  const lines = [
    'silent',
    'show-error',
    'location',
    'http1.1',
    'fail-with-body',
    'connect-timeout = 15',
    'max-time = 30',
    `url = ${quoteCurlConfigValue(input.requestUrl)}`,
    `header = ${quoteCurlConfigValue('Accept: application/json')}`,
    `header = ${quoteCurlConfigValue('X-Requested-With: XMLHttpRequest')}`,
    `header = ${quoteCurlConfigValue(`New-Api-User: ${Math.trunc(input.platformUserId)}`)}`,
    `header = ${quoteCurlConfigValue(`Cookie: ${input.accessToken}`)}`,
  ];
  if (input.proxyUrl) lines.push(`proxy = ${quoteCurlConfigValue(input.proxyUrl)}`);
  return `${lines.join('\n')}\n`;
}

export function parseAgentRouterCurlBalancePayload(raw: string, expectedUserId: number): BalanceInfo {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    if (/<html|<!doctype/i.test(raw)) throw new Error('upstream_html_response');
    throw new Error('invalid_json_response');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('invalid_balance_response');
  }
  const body = payload as Record<string, unknown>;
  if (body.success !== true || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    throw new Error(message || 'failed_to_fetch_balance');
  }
  const data = body.data as Record<string, unknown>;
  const actualUserId = parsePositiveInteger(data.id);
  if (actualUserId && actualUserId !== Math.trunc(expectedUserId)) throw new Error('account_mismatch');
  const quotaRaw = parseFiniteNumber(data.quota);
  const usedQuotaRaw = parseFiniteNumber(data.used_quota);
  if (quotaRaw == null || usedQuotaRaw == null) throw new Error('invalid_balance_response');
  return {
    balance: quotaRaw / 500_000,
    used: usedQuotaRaw / 500_000,
    quota: (quotaRaw + usedQuotaRaw) / 500_000,
  };
}

async function runAgentRouterCurl(config: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', ['--config', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value || '');
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('curl_timeout'));
    }, CURL_TIMEOUT_MS);
    timer.unref();

    child.once('error', (error) => {
      finish(new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'curl_unavailable' : 'curl_start_failed'));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > CURL_RESPONSE_LIMIT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('curl_response_too_large'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 16_384) return;
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.once('close', (code) => {
      const body = Buffer.concat(stdout).toString('utf8');
      if (body.trim()) {
        finish(undefined, body);
        return;
      }
      finish(new Error(code === 0 ? 'empty_balance_response' : 'curl_request_failed'));
    });
    child.stdin.once('error', () => {});
    child.stdin.end(config);
  });
}

export async function fetchAgentRouterBalanceWithCurl(
  baseUrl: string,
  accessToken: string,
  platformUserId: number,
  dependencies: AgentRouterCurlDependencies = {},
): Promise<BalanceInfo> {
  const requestUrl = `${baseUrl.trim().replace(/\/+$/, '')}/api/user/self`;
  const resolveProxyUrl = dependencies.resolveProxyUrl || resolveEffectiveSiteProxyUrlByRequestUrl;
  const proxyUrl = await resolveProxyUrl(requestUrl);
  const config = buildAgentRouterCurlConfig({ requestUrl, accessToken, platformUserId, proxyUrl });
  const raw = await (dependencies.runCurl || runAgentRouterCurl)(config);
  return parseAgentRouterCurlBalancePayload(raw, platformUserId);
}

export class AgentRouterAdapter extends NewApiAdapter {
  readonly platformName = 'agentrouter';
  override readonly checkinMode = 'browser-reauth';
  override readonly balanceFallbackMode = 'managed-browser-profile';
  private readonly balanceFallback: AgentRouterBalanceFallback;
  private readonly undiciTimeoutMs: number;

  constructor(options: AgentRouterAdapterOptions = {}) {
    super();
    this.balanceFallback = options.balanceFallback || fetchAgentRouterBalanceWithCurl;
    this.undiciTimeoutMs = Math.max(1, Math.trunc(options.undiciTimeoutMs ?? DEFAULT_UNDICI_TIMEOUT_MS));
  }

  protected getBalanceWithUndici(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
  ): Promise<BalanceInfo> {
    return super.getBalance(baseUrl, accessToken, platformUserId);
  }

  override async getBalance(baseUrl: string, accessToken: string, platformUserId?: number): Promise<BalanceInfo> {
    try {
      return await withAgentRouterBalanceTimeout(
        this.getBalanceWithUndici(baseUrl, accessToken, platformUserId),
        this.undiciTimeoutMs,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '');
      if (!['upstream_html_response', 'agentrouter_undici_timeout'].includes(message) || !platformUserId) throw error;
      try {
        return await this.balanceFallback(baseUrl, accessToken, platformUserId);
      } catch {
        throw error;
      }
    }
  }

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return normalized.includes('agentrouter');
  }
}
