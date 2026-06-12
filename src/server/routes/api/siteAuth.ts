import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  parseSiteAuthCredentialCapturePayload,
  parseSiteAuthCredentialImportPayload,
} from '../../contracts/siteAuthRoutePayloads.js';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import { db, schema } from '../../db/index.js';
import {
  checkSiteAuthCredentialDecryptability,
  createSiteAuthCredential,
  deleteSiteAuthCredential,
  getSiteAuthCredential,
  listSiteAuthCredentials,
} from '../../services/site-auth/credentialVault.js';
import { parseSiteAuthCaptureText } from '../../services/site-auth/browserCapture.js';
import { verifySiteAuthCredential } from '../../services/site-auth/credentialVerifier.js';
import { listSiteAuthProviderDefinitions } from '../../services/site-auth/providers.js';
import type { SiteAuthProviderId } from '../../services/site-auth/providerTypes.js';
import {
  completeSiteAuthAuthorizationCallback,
  getSiteAuthAuthorizationSession,
  renderSiteAuthCallbackPage,
  startSiteAuthAuthorization,
} from '../../services/site-auth/authorizationFlow.js';
import {
  listTargetSitesForSiteAuthProvider,
  resolveSiteAuthRequirementsForSite,
} from '../../services/site-auth/siteAuthRequirements.js';

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

const limitSiteAuthAuthorizationStart = createRateLimitGuard({
  bucket: 'site-auth-authorization-start',
  max: 20,
  windowMs: 60_000,
});

const limitSiteAuthCredentialCaptureParse = createRateLimitGuard({
  bucket: 'site-auth-credential-capture-parse',
  max: 30,
  windowMs: 60_000,
});

const limitSiteAuthCredentialVerify = createRateLimitGuard({
  bucket: 'site-auth-credential-verify',
  max: 30,
  windowMs: 60_000,
});

const limitSiteAuthCredentialDelete = createRateLimitGuard({
  bucket: 'site-auth-credential-delete',
  max: 30,
  windowMs: 60_000,
});

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeSiteAuthProvider(value: unknown): SiteAuthProviderId | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'linuxdo' || normalized === 'github' || normalized === 'google') return normalized;
  return null;
}

function resolveRequestOrigin(request: { headers: Record<string, unknown>; protocol?: string; hostname?: string }): string {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin.trim() : '';
  if (origin) return origin;
  const host = typeof request.headers.host === 'string' ? request.headers.host.trim() : '';
  const protocol = request.protocol || 'http';
  return host ? `${protocol}://${host}` : '';
}

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

  app.get('/api/site-auth/credentials/decryptability', { preHandler: [limitSiteAuthCredentialRead] }, async () => (
    checkSiteAuthCredentialDecryptability()
  ));

  app.post<{ Params: { provider: string } }>(
    '/api/site-auth/providers/:provider/start',
    { preHandler: [limitSiteAuthAuthorizationStart] },
    async (request, reply) => {
      const provider = normalizeSiteAuthProvider(request.params.provider);
      if (!provider) {
        return reply.code(400).send({ success: false, message: 'invalid site auth provider' });
      }
      try {
        return startSiteAuthAuthorization(provider, resolveRequestOrigin(request));
      } catch (error: any) {
        return reply.code(400).send({ success: false, message: error?.message || 'site auth authorization start failed' });
      }
    },
  );

  app.get<{ Params: { state: string } }>(
    '/api/site-auth/sessions/:state',
    { preHandler: [limitSiteAuthCredentialRead] },
    async (request, reply) => {
      const state = String(request.params.state || '').trim();
      const session = state ? getSiteAuthAuthorizationSession(state) : null;
      if (!session) {
        return reply.code(404).send({ success: false, message: 'site auth authorization session not found' });
      }
      return session;
    },
  );

  app.get<{ Params: { provider: string }; Querystring: { state?: string; code?: string; error?: string } }>(
    '/api/site-auth/callback/:provider',
    async (request, reply) => {
      const provider = normalizeSiteAuthProvider(request.params.provider);
      if (!provider) {
        return reply.code(400).type('text/html').send('Invalid provider');
      }
      try {
        const session = await completeSiteAuthAuthorizationCallback({
          provider,
          state: String(request.query.state || ''),
          code: request.query.code,
          error: request.query.error,
        });
        return reply.type('text/html').send(renderSiteAuthCallbackPage(session));
      } catch (error: any) {
        const session = getSiteAuthAuthorizationSession(String(request.query.state || '')) || {
          provider,
          state: String(request.query.state || ''),
          status: 'error' as const,
          error: error?.message || 'site auth authorization callback failed',
        };
        return reply.code(400).type('text/html').send(renderSiteAuthCallbackPage(session));
      }
    },
  );

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

  app.post<{ Body: unknown }>(
    '/api/site-auth/credentials/parse-capture',
    { preHandler: [limitSiteAuthCredentialCaptureParse] },
    async (request, reply) => {
      const parsedBody = parseSiteAuthCredentialCapturePayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ success: false, message: parsedBody.error });
      }

      try {
        const parsed = parseSiteAuthCaptureText(
          parsedBody.data.text,
          parsedBody.data.defaultProvider,
        );
        return { success: true, parsed };
      } catch (error: any) {
        return reply.code(400).send({
          success: false,
          message: error?.message || 'site auth credential capture parse failed',
        });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/sites/:id/auth-requirements',
    { preHandler: [limitSiteAuthCredentialRead] },
    async (request, reply) => {
      const siteId = parsePositiveInteger(request.params.id);
      if (!siteId) {
        return reply.code(400).send({ success: false, message: 'invalid site id' });
      }

      const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
      if (!site) {
        return reply.code(404).send({ success: false, message: 'site not found' });
      }

      const detected = await resolveSiteAuthRequirementsForSite(site);
      const credentials = await listSiteAuthCredentials();
      return {
        siteId,
        hasThirdPartyLogin: detected.hasThirdPartyLogin,
        requirements: detected.requirements.map((requirement) => ({
          ...requirement,
          availableCredentials: credentials.filter((credential) => (
            credential.provider === requirement.provider && credential.status === 'active'
          )),
        })),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/site-auth/credentials/:id/target-sites',
    { preHandler: [limitSiteAuthCredentialRead] },
    async (request, reply) => {
      const credentialId = parsePositiveInteger(request.params.id);
      if (!credentialId) {
        return reply.code(400).send({ success: false, message: 'invalid credential id' });
      }

      const credential = await getSiteAuthCredential(credentialId);
      if (!credential) {
        return reply.code(404).send({ success: false, message: 'site auth credential not found' });
      }

      const sites = await db.select().from(schema.sites).all();
      const items = await listTargetSitesForSiteAuthProvider(credential.provider, sites);
      return {
        credentialId,
        total: items.length,
        items,
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/site-auth/credentials/:id',
    { preHandler: [limitSiteAuthCredentialDelete] },
    async (request, reply) => {
      const credentialId = parsePositiveInteger(request.params.id);
      if (!credentialId) {
        return reply.code(400).send({ success: false, message: 'invalid credential id' });
      }

      const deleted = await deleteSiteAuthCredential(credentialId);
      if (!deleted) {
        return reply.code(404).send({ success: false, message: 'site auth credential not found' });
      }
      return { success: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/site-auth/credentials/:id/verify',
    { preHandler: [limitSiteAuthCredentialVerify] },
    async (request, reply) => {
      const credentialId = parsePositiveInteger(request.params.id);
      if (!credentialId) {
        return reply.code(400).send({ success: false, message: 'invalid credential id' });
      }

      try {
        return await verifySiteAuthCredential(credentialId);
      } catch (error: any) {
        const message = error?.message || 'site auth credential verification failed';
        if (message === 'site auth credential not found') {
          return reply.code(404).send({ success: false, message });
        }
        return reply.code(400).send({ success: false, message });
      }
    },
  );
}
