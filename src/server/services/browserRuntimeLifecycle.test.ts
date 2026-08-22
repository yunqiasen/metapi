import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);

async function source(path: string) {
  return readFile(new URL(path, root), 'utf8');
}

describe('browser runtime lifecycle', () => {
  it('enables Docker init in development and production', async () => {
    for (const file of ['docker-compose.dev.yml', 'docker-compose.yml']) {
      const compose = await source(file);
      expect(compose).toMatch(/metapi:\n(?:[\s\S]*?\n)?\s{4}init:\s*true/);
    }
  });

  it('does not install competing process signal handlers inside browser services', async () => {
    for (const file of [
      'src/server/services/site-auth/targetSiteBrowserSession.ts',
      'src/server/services/site-auth/browserLoginSession.ts',
      'src/server/services/accountManagedBrowserLogin.ts',
    ]) {
      const service = await source(file);
      expect(service).not.toContain("process.once('SIGINT'");
      expect(service).not.toContain("process.once('SIGTERM'");
      expect(service).not.toContain('process.exit(130)');
      expect(service).not.toContain('process.exit(143)');
    }
  });

  it('deduplicates concurrent target-browser closes without marking them closed before cleanup finishes', async () => {
    const service = await source('src/server/services/site-auth/targetSiteBrowserSession.ts');
    const start = service.indexOf('async function closeSessionBrowser');
    const end = service.indexOf('function normalizeCookieForPlaywright', start);
    const closeSource = service.slice(start, end);
    expect(closeSource).toContain('session.closePromise');
    expect(closeSource).toContain('session.browserClosed = true');
    expect(closeSource.indexOf('await closeStandaloneBrowser(session)')).toBeLessThan(closeSource.indexOf('session.browserClosed = true'));
  });

  it('waits for CloakBrowser to flush its persistent profile before cleanup continues', async () => {
    const service = await source('src/server/services/site-auth/targetSiteBrowserSession.ts');
    const start = service.indexOf('async function closeSessionBrowser');
    const end = service.indexOf('function normalizeCookieForPlaywright', start);
    const closeSource = service.slice(start, end);
    expect(closeSource).toContain("session.browserMode === 'cloak'");
    expect(closeSource).toContain('await session.context.close()');
  });

  it('closes every browser runtime through the Fastify onClose hook', async () => {
    const server = await source('src/server/index.ts');
    expect(server).toContain('shutdownTargetSiteBrowserSessions');
    expect(server).toContain('shutdownSiteAuthBrowserSessions');
    expect(server).toContain('shutdownManagedAccountBrowserRuntime');
    expect(server).toContain("process.once('SIGTERM', closeAppOnSignal)");
    expect(server).toContain("process.once('SIGINT', closeAppOnSignal)");
    expect(server).toContain('void app.close().then(() => process.exit(0))');
  });
  it('keeps the standalone Browser handle and closes it without reconnecting over CDP', async () => {
    const service = await source('src/server/services/site-auth/targetSiteBrowserSession.ts');
    expect(service).toContain("import type { Browser, BrowserContext");
    expect(service).toContain('browser?: Browser;');
    const start = service.indexOf('async function closeStandaloneBrowser');
    const end = service.indexOf('async function waitForProfileFlush', start);
    const closeSource = service.slice(start, end);
    expect(closeSource).toContain('await session.browser.close()');
    expect(closeSource).not.toContain('connectOverCDP');
  });

  it('cleans a started browser when the noVNC gateway fails to initialize', async () => {
    const service = await source('src/server/services/site-auth/targetSiteBrowserSession.ts');
    const start = service.indexOf('export async function startTargetSiteBrowserSession');
    const end = service.indexOf('function getSession', start);
    const startSource = service.slice(start, end);
    expect(startSource).toContain('sessions.set(state, session)');
    expect(startSource).toContain('await ensureNoVncGatewayStarted');
    expect(startSource).toContain('await closeSessionBrowser(session, { removeProfile: true })');
    expect(startSource.indexOf('sessions.set(state, session)')).toBeLessThan(startSource.indexOf('await ensureNoVncGatewayStarted'));
  });

  it('expires abandoned pending sessions and closes the browser profile', async () => {
    const service = await source('src/server/services/site-auth/targetSiteBrowserSession.ts');
    expect(service).toContain('PENDING_SESSION_TTL_MS');
    expect(service).toContain('pendingExpiryTimer?: ReturnType<typeof setTimeout>');
    expect(service).toContain('schedulePendingSessionExpiry(session)');
    expect(service).toContain("if (session.status === 'pending') session.status = 'closed'");
    expect(service).toContain('await closeSessionBrowser(session, { removeProfile: true })');
  });

  it('closes abandoned sessions from the browser page with a keepalive request', async () => {
    const service = await source('src/server/services/site-auth/targetSiteBrowserSession.ts');
    const start = service.indexOf('export function renderTargetSiteBrowserPage');
    const pageSource = service.slice(start);
    expect(pageSource).toContain("window.addEventListener('pagehide'");
    expect(pageSource).toContain('keepalive:true');
    expect(pageSource).toContain("'/api/accounts/site-auth-browser-sessions/'+encodeURIComponent(state)+'/close'");
  });

});
