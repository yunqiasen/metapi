import type { RequestInit } from 'undici';
import type { ApiTokenInfo, BalanceInfo, CheckinResult, CreateApiTokenOptions, TokenVerifyResult, UserInfo } from './base.js';
import { NewApiAdapter } from './newApi.js';
import { normalizeNewApiCredential } from './newApiShield.js';
import { normalizePlatformBaseUrl, resolveVersionedModelsUrl } from './standardApiProvider.js';
import { AgentRouterRequestClient, AgentRouterRequestError, validateAgentRouterUser } from './agentRouterRequest.js';

export class AgentRouterAdapter extends NewApiAdapter {
  readonly platformName = 'agentrouter';
  readonly verificationDiagnostics = 'adapter' as const;
  protected override readonly reuseShieldCookiesAcrossRequests = true;
  private readonly requests: AgentRouterRequestClient;

  constructor(options: { requestTimeoutMs?: number } = {}) {
    super();
    this.requests = new AgentRouterRequestClient(options.requestTimeoutMs);
  }

  async detect(url: string): Promise<boolean> {
    return (url || '').toLowerCase().includes('agentrouter');
  }

  private isApiKey(token: string): boolean {
    // Agent's token API returns 48-character keys without the optional sk- prefix.
    return /^(?:sk-[^\s;=]+|[a-z\d]{48})$/i.test(normalizeNewApiCredential(token));
  }

  private async sessionRequest(
    baseUrl: string, path: string, token: string, platformUserId?: number, options: RequestInit = {},
  ) {
    const cookie = this.buildCookieCandidates(token)[0];
    if (!cookie) throw new AgentRouterRequestError('AgentRouter 缺少账号 Session', 'session-expired');
    const userId = platformUserId || this.extractSessionUserId(token);
    const payload = await this.requests.json(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        Cookie: cookie,
        ...(userId ? { 'New-Api-User': String(userId) } : {}),
      },
    });
    if (payload.success !== true) throw new AgentRouterRequestError('AgentRouter 接口未返回有效结果', 'invalid-payload');
    return payload;
  }

  protected override async readSessionUserData(baseUrl: string, token: string, platformUserId?: number, signal?: AbortSignal) {
    const expectedId = platformUserId || this.extractSessionUserId(token);
    const payload = await this.sessionRequest(baseUrl, '/api/user/self', token, expectedId, { signal });
    return validateAgentRouterUser(payload.data, expectedId);
  }

  override async getUserInfo(baseUrl: string, token: string, platformUserId?: number): Promise<UserInfo> {
    return this.parseUserInfo(await this.readSessionUserData(baseUrl, token, platformUserId));
  }

  override async getBalance(baseUrl: string, token: string, platformUserId?: number): Promise<BalanceInfo> {
    return this.parseBalance(await this.readSessionUserData(baseUrl, token, platformUserId));
  }

  private async apiKeyModels(baseUrl: string, token: string, signal?: AbortSignal): Promise<string[]> {
    const payload = await this.requests.json(resolveVersionedModelsUrl(baseUrl), {
      signal, headers: { Accept: 'application/json', Authorization: `Bearer ${normalizeNewApiCredential(token)}` },
    });
    if (!Array.isArray(payload.data)) throw new AgentRouterRequestError('AgentRouter 模型列表响应格式异常', 'invalid-payload');
    return payload.data.map((model: any) => model?.id).filter((id): id is string => typeof id === 'string' && !!id.trim());
  }

  override async getModels(baseUrl: string, token: string, platformUserId?: number): Promise<string[]> {
    if (this.isApiKey(token)) return this.apiKeyModels(baseUrl, token);
    const managementBaseUrl = normalizePlatformBaseUrl(baseUrl).replace(/\/v1$/i, '');
    const payload = await this.sessionRequest(managementBaseUrl, '/api/user/models', token, platformUserId);
    if (Array.isArray(payload.data)) return payload.data.filter((id): id is string => typeof id === 'string' && !!id.trim());
    if (payload.data && typeof payload.data === 'object') return Object.keys(payload.data);
    throw new AgentRouterRequestError('AgentRouter 模型列表响应格式异常', 'invalid-payload');
  }

  private async tokenItems(baseUrl: string, token: string, platformUserId?: number, signal?: AbortSignal) {
    const payload = await this.sessionRequest(baseUrl, '/api/token/?p=0&size=100', token, platformUserId, { signal });
    const items = this.parseTokenItemsOrNull(payload);
    if (!items) throw new AgentRouterRequestError('AgentRouter 令牌列表响应格式异常', 'invalid-payload');
    return items;
  }

  override async getApiTokens(baseUrl: string, token: string, platformUserId?: number): Promise<ApiTokenInfo[]> {
    return this.normalizeTokenItems(await this.tokenItems(baseUrl, token, platformUserId));
  }

  override async getApiToken(baseUrl: string, token: string, platformUserId?: number): Promise<string | null> {
    const tokens = await this.getApiTokens(baseUrl, token, platformUserId);
    return tokens.find(item => item.enabled !== false)?.key || tokens[0]?.key || null;
  }

  override async verifyToken(
    baseUrl: string, token: string, platformUserId?: number,
    credentialMode: 'auto' | 'session' | 'apikey' = 'auto',
  ): Promise<TokenVerifyResult> {
    token = normalizeNewApiCredential(token);
    const signal = AbortSignal.timeout(8_000);
    if (credentialMode === 'apikey' || (credentialMode === 'auto' && this.isApiKey(token))) {
      const models = await this.apiKeyModels(baseUrl, token, signal);
      if (!models.length) throw new AgentRouterRequestError('AgentRouter API Key 未返回可用模型', 'invalid-payload');
      return { tokenType: 'apikey', models };
    }
    let data: Awaited<ReturnType<AgentRouterAdapter['readSessionUserData']>>;
    try { data = await this.readSessionUserData(baseUrl, token, platformUserId, signal); }
    catch (error) {
      // The site's authenticated token list carries user_id. Use it as a second,
      // independent identity proof only for an explicitly challenged self path.
      // No alternate credentials or guessed IDs, and token quota is not balance.
      if (!(error instanceof AgentRouterRequestError) || error.kind !== 'shield') throw error;
      const expectedId = platformUserId || this.extractSessionUserId(token);
      if (!expectedId) throw error;
      let items: any[];
      try { items = await this.tokenItems(baseUrl, token, expectedId, signal); }
      catch { throw error; }
      if (!items.length) throw error;
      const ids = items.map(item => typeof item?.user_id === 'number' ? item.user_id : NaN);
      if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw error;
      if (ids.some(id => id !== expectedId)) {
        throw new AgentRouterRequestError('AgentRouter 令牌所属用户 ID 与当前账号不匹配', 'invalid-user-id');
      }
      const tokens = this.normalizeTokenItems(items);
      return {
        tokenType: 'session', userInfo: { id: expectedId, username: '' }, balance: null,
        apiToken: tokens.find(item => item.enabled !== false)?.key || tokens[0]?.key || null,
      };
    }
    let apiToken: string | null = null;
    // Token discovery is optional after identity verification. A challenged token
    // endpoint must neither discard the valid Session nor trigger more probes.
    try {
      const tokens = this.normalizeTokenItems(await this.tokenItems(baseUrl, token, data.id, signal));
      apiToken = tokens.find(item => item.enabled !== false)?.key || tokens[0]?.key || null;
    } catch {}
    return { tokenType: 'session', userInfo: this.parseUserInfo(data), balance: this.parseBalance(data), apiToken };
  }

  override async createApiToken(baseUrl: string, token: string, platformUserId?: number, options?: CreateApiTokenOptions): Promise<boolean> {
    await this.sessionRequest(baseUrl, '/api/token/', token, platformUserId, {
      method: 'POST', body: JSON.stringify(this.buildDefaultTokenPayload(options)),
    });
    return true;
  }

  override async deleteApiToken(baseUrl: string, token: string, tokenKey: string, platformUserId?: number): Promise<boolean> {
    const key = this.normalizeTokenKeyForCompare(tokenKey);
    if (!key) return false;
    const signal = AbortSignal.timeout(8_000);
    const items = await this.tokenItems(baseUrl, token, platformUserId, signal);
    const item = items.find((item: any) => this.normalizeTokenKeyForCompare(item?.key) === key);
    if (!item) return true;
    const id = Number(item.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new AgentRouterRequestError('AgentRouter 令牌 ID 响应无效', 'invalid-payload');
    await this.sessionRequest(baseUrl, `/api/token/${id}`, token, platformUserId, { method: 'DELETE', signal });
    return true;
  }

  override async getUserGroups(baseUrl: string, token: string, platformUserId?: number): Promise<string[]> {
    const signal = AbortSignal.timeout(8_000);
    let payload: Record<string, unknown>;
    try { payload = await this.sessionRequest(baseUrl, '/api/user/self/groups', token, platformUserId, { signal }); }
    catch (error) {
      if (!(error instanceof AgentRouterRequestError) || error.kind !== 'http' || error.status !== 404) throw error;
      payload = await this.sessionRequest(baseUrl, '/api/user_group_map', token, platformUserId, { signal });
    }
    const groups = this.parseGroupKeys(payload);
    return groups.length ? [...new Set(groups)] : ['default'];
  }

  override async checkin(_baseUrl: string, _accessToken: string, _platformUserId?: number): Promise<CheckinResult> {
    return {
      success: true,
      message: 'AgentRouter 未配置签到重登录：该站只有重新登录才触发签到，请在「编辑账号 → 签到重登录」选择 GitHub/LinuxDO 并粘贴对应站点 Cookie',
    };
  }
}
