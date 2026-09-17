import type { RequestInit as UndiciRequestInit } from 'undici';
import type { BalanceInfo, CheckinResult, UserInfo } from './base.js';
import { NewApiAdapter } from './newApi.js';

type AnyUser = Record<string, unknown> & { id: number; quota: number; used_quota: number };
class AnyRequestError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

type AnyResponse = { success?: boolean; message?: string; msg?: string; data?: unknown };

export class AnyRouterAdapter extends NewApiAdapter {
  readonly platformName = 'anyrouter';
  protected override readonly reuseShieldCookiesAcrossRequests = true;
  protected readonly requestTimeoutMs = 5_000;

  async detect(url: string): Promise<boolean> {
    return (url || '').toLowerCase().includes('anyrouter');
  }

  private sessionCookie(token: string): string {
    const cookie = this.stripShieldCookies(this.buildCookieCandidates(token)[0] || '');
    if (!cookie) throw new Error('AnyRouter 缺少账号 Session');
    return cookie;
  }

  private async requestOnce(
    baseUrl: string,
    path: string,
    token: string,
    userId: number | undefined,
    signal: AbortSignal,
    options: UndiciRequestInit = {},
  ): Promise<AnyResponse> {
    const response = await this.fetchJsonRawWithCookie<AnyResponse>(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      ...options,
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]),
      headers: {
        Cookie: this.sessionCookie(token),
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${baseUrl.replace(/\/+$/, '')}/console`,
        ...(userId ? { 'New-API-User': String(userId) } : {}),
      },
    });
    if (response.failureKind === 'rate-limit') {
      throw new Error(`AnyRouter 当前线路被限流，请 ${Math.ceil((response.retryAfterMs || 60_000) / 1000)} 秒后重试`);
    }
    if (!response.data) {
      const status = response.status ? `HTTP ${response.status}` : '重试次数已达上限';
      throw new AnyRequestError(response.failureKind === 'shield'
        ? `AnyRouter 站点防护校验未通过（${status}）`
        : `AnyRouter 接口返回非 JSON 响应（${status}）`, [502, 503, 504].includes(response.status || 0));
    }
    if (response.status && response.status >= 400) {
      throw new AnyRequestError(response.data.message || response.data.msg || `AnyRouter HTTP ${response.status}`, [502, 503, 504].includes(response.status));
    }
    return response.data;
  }

  private isTransient(error: unknown): boolean {
    if (error instanceof AnyRequestError) return error.retryable;
    if (!(error instanceof Error)) return false;
    return error.name === 'TimeoutError' || error.name === 'AbortError'
      || /fetch failed|socket|ECONNRESET|ETIMEDOUT|EPIPE/i.test(error.message);
  }

  private async request(
    baseUrl: string, path: string, token: string, userId: number | undefined,
    signal: AbortSignal, options: UndiciRequestInit = {},
  ): Promise<AnyResponse> {
    const attempts = !options.method || options.method === 'GET' ? 2 : 1;
    for (let attempt = 0; ; attempt++) {
      try { return await this.requestOnce(baseUrl, path, token, userId, signal, options); }
      catch (error) {
        if (signal.aborted || !this.isTransient(error) || attempt + 1 >= attempts) throw error;
      }
    }
  }

  private async readUser(
    baseUrl: string, token: string, expectedUserId: number | undefined, signal: AbortSignal,
  ): Promise<AnyUser> {
    expectedUserId ??= this.extractSessionUserId(token);
    const payload = await this.request(baseUrl, '/api/user/self', token, expectedUserId, signal);
    if (!payload.success || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
      throw new Error(payload.message || payload.msg || 'AnyRouter 账号 Session 验证失败');
    }
    const data = payload.data as Record<string, unknown>;
    const id = data.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error('AnyRouter 用户 ID 响应无效');
    }
    if (expectedUserId && id !== expectedUserId) throw new Error('AnyRouter 用户 ID 不匹配，已停止签到');
    if (typeof data.quota !== 'number' || !Number.isFinite(data.quota)
      || typeof data.used_quota !== 'number' || !Number.isFinite(data.used_quota)) {
      throw new Error('AnyRouter 响应缺少有效额度字段，已停止签到');
    }
    return data as AnyUser;
  }

  protected override async readSessionUserData(
    baseUrl: string, token: string, platformUserId?: number,
  ): Promise<AnyUser> {
    this.sessionCookie(token);
    const signal = AbortSignal.timeout(20_000);
    await this.warmupLoginPage(baseUrl, AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]));
    return this.readUser(baseUrl, token, platformUserId, signal);
  }

  override async getUserInfo(baseUrl: string, token: string, platformUserId?: number): Promise<UserInfo | null> {
    return this.parseUserInfo(await this.readSessionUserData(baseUrl, token, platformUserId));
  }

  override async getBalance(baseUrl: string, token: string, platformUserId?: number): Promise<BalanceInfo> {
    return this.parseBalance(await this.readSessionUserData(baseUrl, token, platformUserId));
  }

  override async checkin(baseUrl: string, token: string, platformUserId?: number): Promise<CheckinResult> {
    try {
      this.sessionCookie(token);
      const signal = AbortSignal.timeout(25_000);
      await this.warmupLoginPage(baseUrl, AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]));
      const before = await this.readUser(baseUrl, token, platformUserId, signal);
      let signed: AnyResponse = {};
      let ambiguousError: unknown;
      try {
        signed = await this.request(baseUrl, '/api/user/sign_in', token, before.id, signal, {
          method: 'POST', body: '{}',
        });
      } catch (error) {
        if (!this.isTransient(error) || signal.aborted) throw error;
        // The write may already have reached the site. Read its result; never replay it.
        ambiguousError = error;
      }
      const message = signed.message || signed.msg || '';
      const alreadyCheckedIn = /already (?:checked|signed)|(?:今日|今天)?已(?:经)?签到|重复签到/i.test(message);
      if (!signed.success && !alreadyCheckedIn && !ambiguousError) {
        return { success: false, message: message || 'AnyRouter 签到请求未成功' };
      }
      const after = await this.readUser(baseUrl, token, before.id, signal);
      const balanceInfo = this.parseBalance(after);
      const reward = Math.round((after.quota + after.used_quota - before.quota - before.used_quota) / 500000 * 1e6) / 1e6;
      if (reward <= 0) {
        if (ambiguousError) return { success: false, reward: '0', message: `AnyRouter 签到响应中断，补查额度无新增，结果待确认（${ambiguousError instanceof Error ? ambiguousError.message : '网络异常'}）` };
        return {
          success: false, quotaUnchanged: true, alreadyCheckedIn, reward: '0', balanceInfo,
          message: `${alreadyCheckedIn ? 'AnyRouter 今日已签到' : 'AnyRouter 已完成签到请求'}，额度无新增`,
        };
      }
      return {
        success: true, reward: String(reward), balanceInfo,
        message: `AnyRouter 签到已确认：总额度 +${reward}，当前总额度 ${balanceInfo.quota}`,
      };
    } catch (error) {
      return { success: false, message: error instanceof Error && /TimeoutError|AbortError/.test(error.name)
        ? 'AnyRouter 线路响应超时；已结束本次请求，未确认新增额度'
        : error instanceof Error ? error.message : 'AnyRouter 签到请求失败' };
    }
  }
}
