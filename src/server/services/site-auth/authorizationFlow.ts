import {
  getSiteAuthBrowserSession,
  renderSiteAuthBrowserPage,
  startSiteAuthBrowserLogin,
  type SiteAuthBrowserSessionInfo,
  type SiteAuthBrowserStartResult,
} from './browserLoginSession.js';
import type { SiteAuthProviderId } from './providerTypes.js';

const SITE_AUTH_CALLBACK_PATH_PREFIX = '/api/site-auth/callback';
const MANUAL_CALLBACK_DELAY_MS = 0;

export type SiteAuthAuthorizationSessionInfo = SiteAuthBrowserSessionInfo;
export type SiteAuthAuthorizationStartResult = SiteAuthBrowserStartResult;

export function isSiteAuthAuthorizationConfigured(_provider: SiteAuthProviderId): boolean {
  return true;
}

export function getSiteAuthAuthorizationUnavailableReason(_provider: SiteAuthProviderId): string | null {
  return null;
}

export async function startSiteAuthAuthorization(
  provider: SiteAuthProviderId,
  origin: string,
): Promise<SiteAuthAuthorizationStartResult> {
  return startSiteAuthBrowserLogin(provider, origin);
}

export function getSiteAuthAuthorizationSession(state: string): SiteAuthAuthorizationSessionInfo | null {
  return getSiteAuthBrowserSession(state);
}

export async function completeSiteAuthAuthorizationCallback(input: {
  provider: SiteAuthProviderId;
  state: string;
  code?: string | null;
  payload?: string | null;
  oneTimePassword?: string | null;
  error?: string | null;
}): Promise<SiteAuthAuthorizationSessionInfo> {
  const existing = getSiteAuthBrowserSession(input.state);
  if (existing) return existing;
  throw new Error('第三方登录已改为 Metapi 受控浏览器小窗，不再使用 OAuth App callback。请从 OAuth 管理页重新点击授权。');
}

export function renderSiteAuthCallbackPage(session: SiteAuthAuthorizationSessionInfo | { state: string; status: 'error'; error?: string }): string {
  const message = session.status === 'success'
    ? '凭证已保存，可以关闭窗口。'
    : (session.error || '第三方登录已改为 Metapi 受控浏览器小窗。');
  const status = session.status === 'success' ? 'success' : 'error';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Metapi Site Auth</title></head><body><script>try{window.opener&&window.opener.postMessage(${JSON.stringify({ type: 'metapi-site-auth', status, state: session.state })}, '*')}catch(e){}</script><p>${message}</p></body></html>`;
}

export { renderSiteAuthBrowserPage };

export const siteAuthAuthorizationCompatibility = {
  callbackPathPrefix: SITE_AUTH_CALLBACK_PATH_PREFIX,
  manualCallbackDelayMs: MANUAL_CALLBACK_DELAY_MS,
  disabledMessage: 'site-auth provider login uses Metapi controlled browser sessions for GitHub, Google, and LinuxDO',
};
