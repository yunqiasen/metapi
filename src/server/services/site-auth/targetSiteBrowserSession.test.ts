import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildStandaloneBrowserProxyArgs, buildStandaloneOauthStatusSeed, buildTargetAuthEntryUrls, buildVerifiedTargetOauthStatusStorageSeed, buildTargetSessionCookieHeader, decideStandaloneOauthAction, isTargetLoginOverlayDismissText, isTargetProviderLoginText, parseTargetOauthStatus, renderTargetSiteBrowserPage, seedTargetSiteBrowserProfile, selectPreferredTargetPageIndex, shouldStabilizeStandaloneOauthLogin, shouldUseCloakBrowserForTarget, hasStandaloneWafClearanceCookie, isStandaloneWafWarmupReady } from './targetSiteBrowserSession.js';

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

  it('seeds a rebind browser from an isolated copy of the original Profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metapi-target-profile-rebind-'));
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await writeFile(join(root, 'marker'), 'root');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(source, 'Default'), { recursive: true }));
    await writeFile(join(source, 'Default', 'Cookies'), 'original-cookie-db');

    await seedTargetSiteBrowserProfile(source, destination);
    await writeFile(join(destination, 'Default', 'Cookies'), 'changed-in-staged-copy');

    expect(await readFile(join(source, 'Default', 'Cookies'), 'utf8')).toBe('original-cookie-db');
    expect(await readFile(join(destination, 'Default', 'Cookies'), 'utf8')).toBe('changed-in-staged-copy');
  });

  it('renders a noVNC surface instead of queued screenshot remote-control events', () => {
    const html = renderTargetSiteBrowserPage('state-1');

    expect(html).toContain('id="novnc"');
    expect(html).toContain('vnc.html?autoconnect=1');
    expect(html).not.toContain('let inputQueue=Promise.resolve()');
    expect(html).not.toContain("sendInput({type:'click'");
    expect(html).not.toContain('/screenshot?t=');
    expect(html).toContain('window.opener&&window.opener.postMessage');
    expect(html).toContain('id="verifyCaptcha"');
    expect(html).toContain('/confirm-captcha');
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

  it('parses only reusable target-session cookies from a stored Cookie header', async () => {
    const module = await import('./targetSiteBrowserSession.js') as Record<string, any>;
    expect(module.parseTargetSessionCookieHeader?.('acw_tc=waf; acw_sc__v2=challenge; session=stored; jwt_token=jwt')).toEqual([
      { name: 'session', value: 'stored' },
      { name: 'jwt_token', value: 'jwt' },
    ]);
  });

  it('does not treat WAF cookies alone as a saved target login session', () => {
    const header = buildTargetSessionCookieHeader([
      { name: 'acw_tc', value: 'waf-1', domain: 'anyrouter.top', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'acw_sc__v2', value: 'waf-3', domain: 'anyrouter.top', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
    ], 'anyrouter.top');

    expect(header).toBe('');
  });
});

describe('standalone target OAuth login stabilization', () => {
  it('prefers the active LinuxDO page over the stale target login page', () => {
    expect(selectPreferredTargetPageIndex([
      'https://anyrouter.top/login',
      'https://linux.do/login',
    ])).toBe(1);
    expect(selectPreferredTargetPageIndex([
      'about:blank',
      'https://anyrouter.top/login',
    ])).toBe(1);
    expect(selectPreferredTargetPageIndex([])).toBe(-1);
  });

  it('recognizes target login notice dismissal actions without matching OAuth controls', () => {
    expect(isTargetLoginOverlayDismissText('Close Notice')).toBe(true);
    expect(isTargetLoginOverlayDismissText('Close Today')).toBe(true);
    expect(isTargetLoginOverlayDismissText('关闭公告')).toBe(true);
    expect(isTargetLoginOverlayDismissText('今日不再显示')).toBe(true);
    expect(isTargetLoginOverlayDismissText('Continue with LinuxDO')).toBe(false);
  });

  it('extracts OAuth flags from NewAPI status storage', () => {
    expect(parseTargetOauthStatus(JSON.stringify({
      data: { github_oauth: true, linuxdo_oauth: true, linuxdo_client_id: 'configured' },
    }))).toEqual({ github_oauth: true, linuxdo_oauth: true, linuxdo_client_id: 'configured' });

    expect(parseTargetOauthStatus(JSON.stringify({ github_oauth: true }))).toEqual({ github_oauth: true });
  });

  it('rejects WAF challenge HTML and unrelated JSON', () => {
    expect(parseTargetOauthStatus('<script>document.cookie="acw_sc__v2=challenge"</script>')).toBeNull();
    expect(parseTargetOauthStatus(JSON.stringify({ data: { turnstile_check: true } }))).toBeNull();
  });

  it('seeds the login SPA only from a verified real target status response', () => {
    expect(buildVerifiedTargetOauthStatusStorageSeed(JSON.stringify({
      data: {
        system_name: 'AnyRouter',
        github_oauth: true,
        github_client_id: 'real-client-id',
        linuxdo_oauth: true,
        linuxdo_client_id: 'real-linuxdo-client-id',
      },
    }))).toBe(JSON.stringify({
      system_name: 'AnyRouter',
      github_oauth: true,
      github_client_id: 'real-client-id',
      linuxdo_oauth: true,
      linuxdo_client_id: 'real-linuxdo-client-id',
    }));
    expect(buildVerifiedTargetOauthStatusStorageSeed(JSON.stringify({
      github_oauth: true,
      github_client_id: 'configured',
    }))).toBeNull();
    expect(buildVerifiedTargetOauthStatusStorageSeed('<html>challenge</html>')).toBeNull();
  });

  it('keeps the CloakBrowser handoff free of OAuth state seeding and popup rewriting', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./targetSiteBrowserSession.ts', import.meta.url), 'utf8'));
    const start = source.indexOf('async function launchCloakBrowser');
    const end = source.indexOf('async function launchStandaloneBrowser', start);
    const functionSource = source.slice(start, end);
    expect(functionSource).toContain('page.goto(input.loginUrl');
    expect(functionSource).not.toContain('stabilizeStandaloneOauthLogin');
    expect(functionSource).not.toContain('seedStandaloneOauthStatus');
    expect(functionSource).not.toContain('installStandaloneOauthNavigationBridge');
  });

  it('does not hand off the login page until the WAF status endpoint returns real JSON', () => {
    expect(isStandaloneWafWarmupReady({
      responseOk: true,
      contentType: 'text/html; charset=utf-8',
      body: '<html><script>document.cookie=\"acw_sc__v2=challenge\"</script></html>',
    })).toBe(false);
    expect(isStandaloneWafWarmupReady({
      responseOk: true,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ data: { system_name: 'AnyRouter', github_oauth: true, github_client_id: 'real-id' } }),
    })).toBe(true);
  });

  it('recognizes the ESA JavaScript clearance cookie used by shielded targets', () => {
    expect(hasStandaloneWafClearanceCookie([{ name: 'acw_sc__v2' }])).toBe(true);
    expect(hasStandaloneWafClearanceCookie([{ name: 'acw_tc' }, { name: 'cdn_sec_tc' }])).toBe(false);
  });

  it('keeps the real CloakBrowser window available when WAF status preflight is blocked', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./targetSiteBrowserSession.ts', import.meta.url), 'utf8'));
    const warmStart = source.indexOf('async function warmCloakTargetWaf');
    const warmEnd = source.indexOf('async function launchCloakBrowser', warmStart);
    const warmSource = source.slice(warmStart, warmEnd);
    expect(warmSource).toContain('Promise<boolean>');
    expect(warmSource).toContain('attempt < 1');
    expect(warmSource).toContain('return false;');
    expect(warmSource).not.toContain("throw new Error('目标站 WAF 验证未完成，请稍后重试')");

    const launchStart = source.indexOf('async function launchCloakBrowser');
    const launchEnd = source.indexOf('async function launchStandaloneBrowser', launchStart);
    const launchSource = source.slice(launchStart, launchEnd);
    expect(launchSource).toContain('await warmCloakTargetWaf(context, page, input.loginUrl);');
    expect(launchSource).toContain('await page.goto(input.loginUrl');
  });

  it('continues saved-provider logins from the target login page into the provider flow', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./targetSiteBrowserSession.ts', import.meta.url), 'utf8'));
    const start = source.indexOf('async function startBrowser');
    const end = source.indexOf('export async function startTargetSiteBrowserSession', start);
    const functionSource = source.slice(start, end);
    const cloakStart = functionSource.indexOf('if (shouldUseCloakBrowserForTarget');
    const cloakEnd = functionSource.indexOf('if (isLinuxDoStandaloneTarget', cloakStart);
    const cloakBranch = functionSource.slice(cloakStart, cloakEnd);
    expect(cloakStart).toBeGreaterThanOrEqual(0);
    expect(cloakBranch).toContain('advanceTargetProviderLogin');
  });

  it('uses CloakBrowser only for AnyRouter and AgentRouter login targets', () => {
    expect(shouldUseCloakBrowserForTarget('https://anyrouter.top/login')).toBe(true);
    expect(shouldUseCloakBrowserForTarget('https://agentrouter.org/login')).toBe(true);
    expect(shouldUseCloakBrowserForTarget('https://example.com/login')).toBe(false);
  });

  it('only stabilizes AnyRouter and AgentRouter login pages', () => {
    expect(shouldStabilizeStandaloneOauthLogin('https://anyrouter.top/login')).toBe(true);
    expect(shouldStabilizeStandaloneOauthLogin('https://agentrouter.org/login')).toBe(true);
    expect(shouldStabilizeStandaloneOauthLogin('https://linux.do/login')).toBe(false);
    expect(shouldStabilizeStandaloneOauthLogin('https://example.com/login')).toBe(false);
  });

  it('detects icon and data-attribute OAuth controls during readiness checks', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./targetSiteBrowserSession.ts', import.meta.url), 'utf8'));
    const start = source.indexOf('async function hasVisibleTargetOauthControl');
    const end = source.indexOf('async function seedStandaloneOauthStatus', start);
    const functionSource = source.slice(start, end);
    expect(functionSource).toContain("element.getAttribute('data-provider')");
    expect(functionSource).toContain("element.getAttribute('data-oauth-provider')");
    expect(functionSource).toContain("element.querySelector('svg title')");
  });

  it('hands off the real target login page without blocking on WAF status preflight', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./targetSiteBrowserSession.ts', import.meta.url), 'utf8'));
    expect(source).toContain("'--disable-popup-blocking'");
    expect(source).toContain("nextUrl === 'about:blank'");
    expect(source).toContain('window.location.href = nextUrl');
    expect(source).toContain('await stabilizeStandaloneOauthLogin(context, page, input.loginUrl);');
    expect(source).toContain('context,\n    page,\n    browserProcess');
    const stabilizeStart = source.indexOf('async function stabilizeStandaloneOauthLogin');
    const stabilizeEnd = source.indexOf('async function terminateStandaloneBrowserProcess', stabilizeStart);
    const stabilizeSource = source.slice(stabilizeStart, stabilizeEnd);
    expect(stabilizeSource).toContain('await page.goto(loginUrl, {');
    expect(stabilizeSource).toContain("waitUntil: 'domcontentloaded'");
    expect(stabilizeSource).not.toContain('warmStandaloneTargetWaf');
    expect(stabilizeSource).not.toContain('waitForTargetOauthReadiness');
    expect(stabilizeSource).toContain('seedStandaloneOauthStatus(page, loginUrl)');
  });

  it('does not auto-click LinuxDO captcha verification in target-site browsers', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./targetSiteBrowserSession.ts', import.meta.url), 'utf8'));
    const standaloneStart = source.indexOf('async function launchStandaloneBrowser');
    const standaloneEnd = source.indexOf('async function connectStandaloneContext');
    const standaloneSource = source.slice(standaloneStart, standaloneEnd);
    const playwrightStart = source.indexOf('async function startBrowser');
    const playwrightEnd = source.indexOf('export async function startTargetSiteBrowserSession');
    const playwrightSource = source.slice(playwrightStart, playwrightEnd);
    expect(standaloneSource).not.toContain('startLinuxDoCaptchaAutoConfirm');
    expect(playwrightSource).not.toContain('startLinuxDoCaptchaAutoConfirm');
  });

  it('removes each temporary target-site profile after close or successful persistence', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./targetSiteBrowserSession.ts', import.meta.url), 'utf8'));
    expect(source).toContain('removeProfile?: boolean');
    expect(source).toContain("await rm(session.profileDir, { recursive: true, force: true })");
    expect(source).toContain('await closeSessionBrowser(session, { removeProfile: true });');
  });

  it('tracks popup pages and main-frame navigation as the active target page changes', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./targetSiteBrowserSession.ts', import.meta.url), 'utf8'));
    expect(source).toContain("context.on('page', attachPage)");
    expect(source).toContain("page.on('framenavigated'");
    expect(source).toContain('attachTargetPageTracking(session);');
  });

  it('routes captcha, screenshot, and input actions through the preferred active page', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./targetSiteBrowserSession.ts', import.meta.url), 'utf8'));
    for (const functionName of [
      'confirmTargetSiteBrowserCaptcha',
      'captureTargetSiteBrowserScreenshot',
      'sendTargetSiteBrowserInput',
    ]) {
      const start = source.indexOf(`export async function ${functionName}`);
      const end = source.indexOf('\nexport ', start + 1);
      const functionSource = source.slice(start, end === -1 ? undefined : end);
      expect(functionSource).toContain('getActiveTargetPage(session)');
    }
  });

  it('does not restore cross-browser WAF state into a fresh login browser', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./targetSiteBrowserSession.ts', import.meta.url), 'utf8'));
    const start = source.indexOf('async function launchStandaloneBrowser');
    const end = source.indexOf('async function connectStandaloneContext', start);
    const functionSource = source.slice(start, end);
    expect(functionSource).not.toContain('restoreTargetWafState');
    expect(functionSource).not.toContain('persistTargetWafState');
  });

  it('does not stack a cached-login wait in front of the normal WAF warmup', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./targetSiteBrowserSession.ts', import.meta.url), 'utf8'));
    const start = source.indexOf('async function stabilizeStandaloneOauthLogin');
    const end = source.indexOf('async function terminateStandaloneBrowserProcess', start);
    const functionSource = source.slice(start, end);
    expect(functionSource).not.toContain('cachedReadiness');
    expect(functionSource).not.toContain('restoredWafState');
  });

  it('keeps the configured proxy for target and provider pages', () => {
    expect(buildStandaloneBrowserProxyArgs('https://anyrouter.top/login', 'http://proxy:8080')).toEqual([
      '--proxy-server=http://proxy:8080',
    ]);
    expect(buildStandaloneBrowserProxyArgs('https://agentrouter.org/login', 'http://proxy:8080')).toEqual([
      '--proxy-server=http://proxy:8080',
    ]);
    expect(buildStandaloneBrowserProxyArgs('https://example.com/login', 'http://proxy:8080')).toEqual([
      '--proxy-server=http://proxy:8080',
    ]);
    expect(buildStandaloneBrowserProxyArgs('https://anyrouter.top/login', '')).toEqual([]);
  });

  it('seeds only the verified OAuth providers for AnyRouter and AgentRouter', () => {
    expect(buildStandaloneOauthStatusSeed('https://anyrouter.top/login')).toEqual({
      system_name: 'Any Router',
      github_oauth: true,
      github_client_id: 'Ov23liOwlnIiYoF3bUqw',
      linuxdo_oauth: true,
      linuxdo_client_id: '8w2uZtoWH9AUXrZr1qeCEEmvXLafea3c',
    });
    expect(buildStandaloneOauthStatusSeed('https://agentrouter.org/login')).toEqual({
      system_name: 'Agent Router',
      github_oauth: true,
      github_client_id: 'Ov23lidtiR4LeVZvVRNL',
      linuxdo_oauth: true,
      linuxdo_client_id: 'KZUecGfhhDZMVnv8UtEdhOhf9sNOhqVX',
    });
    expect(buildStandaloneOauthStatusSeed('https://example.com/login')).toBeNull();
  });

  it('marks the standalone login ready when a usable OAuth control is visible even if status API is blocked', () => {
    expect(decideStandaloneOauthAction({
      oauthControlVisible: true,
      statusVerified: true,
      attempt: 0,
      maxAttempts: 3,
      nowMs: 100,
      deadlineMs: 1_000,
    })).toBe('ready');
    expect(decideStandaloneOauthAction({
      oauthControlVisible: false,
      statusVerified: false,
      attempt: 0,
      maxAttempts: 3,
      nowMs: 100,
      deadlineMs: 1_000,
    })).toBe('navigate-login');
    expect(decideStandaloneOauthAction({
      oauthControlVisible: true,
      statusVerified: false,
      attempt: 0,
      maxAttempts: 3,
      nowMs: 100,
      deadlineMs: 1_000,
    })).toBe('ready');
  });

  it('fails closed when navigation attempts or the startup deadline are exhausted', () => {
    expect(decideStandaloneOauthAction({
      oauthControlVisible: false,
      statusVerified: false,
      attempt: 3,
      maxAttempts: 3,
      nowMs: 100,
      deadlineMs: 1_000,
    })).toBe('fail-timeout');
    expect(decideStandaloneOauthAction({
      oauthControlVisible: false,
      statusVerified: false,
      attempt: 1,
      maxAttempts: 3,
      nowMs: 1_000,
      deadlineMs: 1_000,
    })).toBe('fail-timeout');
  });
});
