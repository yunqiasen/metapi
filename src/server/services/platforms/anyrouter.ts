import { NewApiAdapter } from './newApi.js';

export class AnyRouterAdapter extends NewApiAdapter {
  readonly platformName = 'anyrouter';
  override readonly checkinMode = 'browser-visit';
  override readonly balanceFallbackMode = 'managed-browser-profile';

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return normalized.includes('anyrouter');
  }
}
