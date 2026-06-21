import { describe, expect, it } from 'vitest';
import { buildTargetAuthEntryUrls, buildTargetSessionCookieHeader, isTargetProviderLoginText, renderTargetSiteBrowserPage } from './targetSiteBrowserSession.js';

describe('target site browser session provider login matching', () => {
  it('matches the target site GitHub login button without matching unrelated login choices', () => {
    expect(isTargetProviderLoginText('github', '使用 GitHub 继续')).toBe(true);
    expect(isTargetProviderLoginText('github', 'Continue with GitHub')).toBe(true);
    expect(isTargetProviderLoginText('github', '使用 邮箱或用户名 登录')).toBe(false);
    expect(isTargetProviderLoginText('github', '注册')).toBe(false);
  });

  it('falls back from the login page to the register page when searching provider entries', () => {
    expect(buildTargetAuthEntryUrls('https://agentrouter.org/login', 'https://agentrouter.org')).toEqual([
      'https://agentrouter.org/login',
      'https://agentrouter.org/register',
    ]);
  });

  it('renders a noVNC surface instead of queued screenshot remote-control events', () => {
    const html = renderTargetSiteBrowserPage('state-1');

    expect(html).toContain('id="novnc"');
    expect(html).toContain('vnc.html?autoconnect=1');
    expect(html).not.toContain('let inputQueue=Promise.resolve()');
    expect(html).not.toContain("sendInput({type:'click'");
    expect(html).not.toContain('/screenshot?t=');
    expect(html).toContain('window.opener&&window.opener.postMessage');
  });

  it('keeps target WAF cookies in the saved session header after a real login cookie exists', () => {
    const header = buildTargetSessionCookieHeader([
      { name: 'acw_tc', value: 'waf-1', domain: 'anyrouter.top', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'cdn_sec_tc', value: 'waf-2', domain: 'anyrouter.top', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'acw_sc__v2', value: 'waf-3', domain: 'anyrouter.top', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'session', value: 'login-session', domain: 'anyrouter.top', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], 'anyrouter.top');

    expect(header).toBe('acw_tc=waf-1; cdn_sec_tc=waf-2; acw_sc__v2=waf-3; session=login-session');
  });

  it('does not treat WAF cookies alone as a saved target login session', () => {
    const header = buildTargetSessionCookieHeader([
      { name: 'acw_tc', value: 'waf-1', domain: 'anyrouter.top', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'acw_sc__v2', value: 'waf-3', domain: 'anyrouter.top', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], 'anyrouter.top');

    expect(header).toBe('');
  });
});
