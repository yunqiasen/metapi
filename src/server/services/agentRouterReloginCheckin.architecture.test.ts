import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('AgentRouter relogin check-in architecture', () => {
  it('keeps the reauthentication state machine out of route adapters and ordinary credential refresh', async () => {
    const domainSource = await readFile(new URL('./agentRouterReloginCheckinService.ts', import.meta.url), 'utf8');
    const checkinSource = await readFile(new URL('./checkinService.ts', import.meta.url), 'utf8');

    expect(domainSource).not.toContain("from './accountManagedBrowserLogin.js'");
    expect(domainSource).not.toContain('/routes/');
    expect(checkinSource).toContain("adapter.checkinMode === 'browser-reauth'");
    expect(checkinSource).toContain('executeAgentRouterReloginCheckin(account, site)');
    const browserSource = await readFile(new URL('./agentRouterReloginBrowser.ts', import.meta.url), 'utf8');
    expect(browserSource).toContain('clickProviderConsentIfPresent(candidate, provider)');
    expect(browserSource).not.toContain('/api/user/logout');

    const credentialRefreshSource = await readFile(new URL('./accountCredentialRefreshService.ts', import.meta.url), 'utf8');
    const balanceSource = await readFile(new URL('./balanceService.ts', import.meta.url), 'utf8');
    expect(credentialRefreshSource).not.toContain('ReloginCheckinService');
    expect(credentialRefreshSource).not.toContain('executeAgentRouterRelogin');
    expect(balanceSource).not.toContain('ReloginCheckinService');
    expect(balanceSource).not.toContain('executeAgentRouterRelogin');
    expect(domainSource).not.toContain('executeAgentRouterReloginBalanceRefresh');
  });

  it('keeps Profile rebind and post-rebind convergence in one reentrant account lease', async () => {
    const source = await readFile(new URL('./accountBrowserProfileRebindService.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/return withAccountBrowserProfileLease\(input\.accountId, async \(\) => \{[\s\S]+?await convergeAccountMutation\([\s\S]+?\n  \}\);/);
  });
  it('serializes runtime-health writes and waits for every account health mutation', async () => {
    const healthSource = await readFile(new URL('./accountHealthService.ts', import.meta.url), 'utf8');
    const alertSource = await readFile(new URL('./alertService.ts', import.meta.url), 'utf8');
    const balanceSource = await readFile(new URL('./balanceService.ts', import.meta.url), 'utf8');
    const checkinSource = await readFile(new URL('./checkinService.ts', import.meta.url), 'utf8');
    const accountsRouteSource = await readFile(new URL('../routes/api/accounts.ts', import.meta.url), 'utf8');

    expect(healthSource).toMatch(/return withAccountBrowserProfileLease\(accountId, async \(\) =>/);
    expect(alertSource).toMatch(/return withAccountBrowserProfileLease\(params\.accountId, async \(\) =>/);
    for (const source of [alertSource, balanceSource, checkinSource, accountsRouteSource]) {
      const calls = source.split('\n').filter((line) => line.includes('setAccountRuntimeHealth('));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((line) => line.trimStart().startsWith('await setAccountRuntimeHealth('))).toBe(true);
    }
  });

});
