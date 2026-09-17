import { fetch, type RequestInit } from 'undici';
import { resolveEffectiveSiteProxyUrlByRequestUrl, withSiteProxyRequestInit } from '../siteProxy.js';

export type AgentRouterFailureKind =
  | 'shield' | 'rate-limit' | 'non-json' | 'needs-user-id' | 'invalid-user-id'
  | 'session-expired' | 'http' | 'network' | 'timeout' | 'invalid-payload';

export class AgentRouterRequestError extends Error {
  constructor(
    message: string,
    readonly kind: AgentRouterFailureKind,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AgentRouterRequestError';
  }
}

export function agentRouterVerificationFailure(error: unknown) {
  if (!(error instanceof AgentRouterRequestError)) return null;
  return {
    success: false,
    message: error.message,
    reasonCode: error.kind,
    ...(error.kind === 'shield' ? { shieldBlocked: true } : {}),
    ...(error.kind === 'needs-user-id' ? { needsUserId: true } : {}),
    ...(error.kind === 'invalid-user-id' ? { invalidUserId: true } : {}),
    ...(error.retryAfterMs ? { retryAfterSeconds: Math.ceil(error.retryAfterMs / 1000) } : {}),
  };
}

export type AgentRouterUser = Record<string, unknown> & { id: number; quota: number; used_quota: number };

export function validateAgentRouterUser(value: unknown, expectedUserId?: number): AgentRouterUser {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentRouterRequestError('AgentRouter 用户信息响应缺失', 'invalid-payload');
  }
  const data = value as Record<string, unknown>;
  const id = typeof data.id === 'number' ? data.id
    : typeof data.id === 'string' && /^[1-9]\d*$/.test(data.id) ? Number(data.id) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AgentRouterRequestError('AgentRouter 用户 ID 响应无效', 'invalid-user-id');
  }
  if (expectedUserId && id !== expectedUserId) {
    throw new AgentRouterRequestError('AgentRouter 用户 ID 与当前 Session 不匹配', 'invalid-user-id');
  }
  if (typeof data.quota !== 'number' || !Number.isFinite(data.quota)
    || typeof data.used_quota !== 'number' || !Number.isFinite(data.used_quota)
    || !Number.isFinite(data.quota + data.used_quota)) {
    throw new AgentRouterRequestError('AgentRouter 响应缺少有效额度字段', 'invalid-payload');
  }
  return { ...data, id } as AgentRouterUser;
}

function retryDelay(raw: string | null): number {
  const seconds = raw == null || !raw.trim() ? NaN : Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw || '') - Date.now();
  return Math.min(3_600_000, Math.max(1_000, Number.isFinite(delay) ? delay : 60_000));
}

// Only explicit challenge markers count as shield evidence, not a generic SPA <script>.
export function parseAgentRouterResponse(status: number, text: string, retryAfter: string | null = null): Record<string, unknown> {
  if (status === 429 || (status === 403 && /http_ratelimit/i.test(text))) {
    const delay = retryDelay(retryAfter);
    throw new AgentRouterRequestError(`AgentRouter 当前线路被限流，请 ${Math.ceil(delay / 1000)} 秒后重试`, 'rate-limit', status, delay);
  }
  let payload: unknown;
  try { payload = JSON.parse(text); } catch {
    if (/aliyunCaptcha|aliyun_waf_aa|aliyun-captcha/i.test(text)) {
      throw new AgentRouterRequestError(`AgentRouter 返回阿里云滑块验证页（HTTP ${status}），未判定 Session 失效`, 'shield', status, 60_000);
    }
    if (/cf-chl-|challenge-platform|just a moment|var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc/i.test(text)) {
      throw new AgentRouterRequestError(`AgentRouter 返回站点验证页（HTTP ${status}），未判定 Session 失效`, 'shield', status, 60_000);
    }
    throw new AgentRouterRequestError(`AgentRouter 接口返回非 JSON 响应（HTTP ${status}）`, 'non-json', status);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AgentRouterRequestError(`AgentRouter JSON 响应格式异常（HTTP ${status}）`, 'invalid-payload', status);
  }
  const body = payload as Record<string, unknown>;
  if (status < 200 || status >= 300 || body.success === false || body.error) {
    const message = typeof body.message === 'string' ? body.message : '';
    if (/new-api-user|user[ _-]?id|用户\s*id/i.test(message)) {
      const missing = /missing|required|缺少|未提供/i.test(message);
      throw new AgentRouterRequestError(missing
        ? 'AgentRouter 需要站点用户 ID，请填写与 Session 对应的 ID'
        : 'AgentRouter 用户 ID 与当前 Session 不匹配', missing ? 'needs-user-id' : 'invalid-user-id', status);
    }
    if (/session.*(?:expired|invalid)|未登录|登录.*失效|登录.*过期/i.test(message)) {
      throw new AgentRouterRequestError('AgentRouter Session 已失效，请更新账号 Session', 'session-expired', status);
    }
    throw new AgentRouterRequestError(message || `AgentRouter 接口请求失败（HTTP ${status}）`, 'http', status);
  }
  return body;
}

async function waitForTurn(turn: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
    void turn.then(() => { signal.removeEventListener('abort', aborted); resolve(); });
  });
}

/** Single-attempt management transport. Session cookies stay request-local. */
export class AgentRouterRequestClient {
  private readonly turns = new Map<string, Promise<void>>();
  private readonly cooldowns = new Map<string, { until: number; error: AgentRouterRequestError }>();

  constructor(private readonly requestTimeoutMs = 5_000) {}

  async json(url: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.requestTimeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    const parsedUrl = new URL(url);
    const proxyUrl = await resolveEffectiveSiteProxyUrlByRequestUrl(url);
    const routeKey = `${parsedUrl.origin}|${proxyUrl || 'direct'}`;
    const endpointKey = `${routeKey}|${parsedUrl.pathname}`;
    const previous = this.turns.get(routeKey) || Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => turn);
    this.turns.set(routeKey, tail);
    void tail.then(() => { if (this.turns.get(routeKey) === tail) this.turns.delete(routeKey); });
    try {
      await waitForTurn(previous, signal);
      signal.throwIfAborted();
      for (const [key, state] of this.cooldowns) {
        if (state.until <= Date.now()) this.cooldowns.delete(key);
      }
      const cooldown = this.cooldowns.get(endpointKey);
      if (cooldown) {
        const remaining = cooldown.until - Date.now();
        throw new AgentRouterRequestError(`${cooldown.error.message}；请 ${Math.ceil(remaining / 1000)} 秒后重试`, cooldown.error.kind, cooldown.error.status, remaining);
      }
      const response = await fetch(url, await withSiteProxyRequestInit(url, {
        ...options, signal, redirect: 'manual',
      }));
      const text = await response.text();
      try { return parseAgentRouterResponse(response.status, text, response.headers.get('retry-after')); }
      catch (error) {
        if (error instanceof AgentRouterRequestError && error.retryAfterMs) {
          this.cooldowns.set(endpointKey, { until: Date.now() + error.retryAfterMs, error });
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof AgentRouterRequestError) throw error;
      if (signal.aborted) {
        throw new AgentRouterRequestError(`AgentRouter ${parsedUrl.pathname} 请求超时，本次连接已取消`, 'timeout');
      }
      throw new AgentRouterRequestError(`AgentRouter ${parsedUrl.pathname} 网络请求失败，请检查当前线路`, 'network');
    } finally {
      release();
    }
  }
}
