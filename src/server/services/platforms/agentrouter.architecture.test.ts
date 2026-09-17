import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

describe('AgentRouter protocol boundaries', () => {
  it('keeps management policy in the platform adapter and HTTP budget outside routes', () => {
    const adapter = read('./agentrouter.ts');
    const transport = read('./agentRouterRequest.ts');
    expect(adapter).toContain("verificationDiagnostics = 'adapter'");
    expect(adapter).toContain('AgentRouterRequestClient');
    expect(adapter).not.toMatch(/super\.(?:getBalance|getModels|getApiTokens|verifyToken)|probeAlternateUserId|probeUserId/);
    expect(transport).toContain('withSiteProxyRequestInit');
    for (const source of [adapter, transport]) {
      expect(source).not.toMatch(/from\s+['"][^'"]*(?:\/routes\/|fastify|playwright|puppeteer)/);
    }
  });

  it('shares the strict identity and quota parser with OAuth callback verification', () => {
    const oauth = read('../agentRouterOauthReloginService.ts');
    expect(oauth).toContain('validateAgentRouterUser');
    expect(oauth).toContain('parseNewApiBalance');
    expect(read('./newApi.ts')).toContain('return parseNewApiBalance(data)');
  });
});
