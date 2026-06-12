import type { FastifyInstance } from 'fastify';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import { listSiteAuthCredentials } from '../../services/site-auth/credentialVault.js';
import { listSiteAuthProviderDefinitions } from '../../services/site-auth/providers.js';

const limitSiteAuthProviderRead = createRateLimitGuard({
  bucket: 'site-auth-provider-read',
  max: 60,
  windowMs: 60_000,
});

const limitSiteAuthCredentialRead = createRateLimitGuard({
  bucket: 'site-auth-credential-read',
  max: 60,
  windowMs: 60_000,
});

export async function siteAuthRoutes(app: FastifyInstance) {
  app.get('/api/site-auth/providers', { preHandler: [limitSiteAuthProviderRead] }, async () => ({
    providers: listSiteAuthProviderDefinitions().map((definition) => definition.metadata),
  }));

  app.get('/api/site-auth/credentials', { preHandler: [limitSiteAuthCredentialRead] }, async () => {
    const items = await listSiteAuthCredentials();
    return {
      items,
      total: items.length,
    };
  });
}
