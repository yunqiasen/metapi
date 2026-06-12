import type { FastifyInstance } from 'fastify';
import { parseSiteAuthCredentialImportPayload } from '../../contracts/siteAuthRoutePayloads.js';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import {
  createSiteAuthCredential,
  listSiteAuthCredentials,
} from '../../services/site-auth/credentialVault.js';
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

const limitSiteAuthCredentialImport = createRateLimitGuard({
  bucket: 'site-auth-credential-import',
  max: 20,
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

  app.post<{ Body: unknown }>(
    '/api/site-auth/credentials/import',
    { preHandler: [limitSiteAuthCredentialImport] },
    async (request, reply) => {
      const parsedBody = parseSiteAuthCredentialImportPayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ success: false, message: parsedBody.error });
      }

      try {
        const item = await createSiteAuthCredential({
          provider: parsedBody.data.provider,
          label: parsedBody.data.label,
          subject: parsedBody.data.subject,
          email: parsedBody.data.email,
          username: parsedBody.data.username,
          credentialType: parsedBody.data.credentialType,
          payload: parsedBody.data.payload,
          status: parsedBody.data.status,
          expiresAt: parsedBody.data.expiresAt,
          metadata: parsedBody.data.metadata,
        });
        return {
          success: true,
          item,
        };
      } catch (error: any) {
        return reply.code(400).send({
          success: false,
          message: error?.message || 'site auth credential import failed',
        });
      }
    },
  );
}
