import { NewApiAdapter } from './newApi.js';

export class AgentRouterAdapter extends NewApiAdapter {
  readonly platformName = 'agentrouter';

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return normalized.includes('agentrouter');
  }
}
