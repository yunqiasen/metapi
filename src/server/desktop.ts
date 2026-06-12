import type { FastifyInstance } from 'fastify';

const DESKTOP_HEALTH_ROUTE = '/api/desktop/health';

export function isPublicApiRoute(url: string): boolean {
  return url === DESKTOP_HEALTH_ROUTE
    || url.startsWith('/api/oauth/callback/')
    || url.startsWith('/api/site-auth/callback/');
}

export async function registerDesktopRoutes(app: FastifyInstance) {
  app.get(DESKTOP_HEALTH_ROUTE, async () => ({ ok: true }));
}
