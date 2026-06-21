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
  renderSiteAuthBrowserPage,
  startSiteAuthAuthorization,
} from '../../services/site-auth/authorizationFlow.js';
import {
  captureSiteAuthBrowserScreenshot,
  closeSiteAuthBrowserSession,
  saveSiteAuthBrowserSession,
  sendSiteAuthBrowserInput,
  type SiteAuthBrowserInputEvent,
} from '../../services/site-auth/browserLoginSession.js';
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

const limitSiteAuthBrowserSessionRead = createRateLimitGuard({
  bucket: 'site-auth-browser-session-read',
  max: 180,
  windowMs: 60_000,
});

const limitSiteAuthBrowserScreenshot = createRateLimitGuard({
  bucket: 'site-auth-browser-screenshot',
  max: 240,
  windowMs: 60_000,
});

const limitSiteAuthBrowserInput = createRateLimitGuard({
  bucket: 'site-auth-browser-input',
  max: 600,
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
  const origin = typeof request.headers.origin === "string" ? request.headers.origin.trim() : "";
  if (origin) return origin;
  const referer = typeof request.headers.referer === "string" ? request.headers.referer.trim() : "";
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {}
  }
  const forwardedHost = typeof request.headers["x-forwarded-host"] === "string" ? request.headers["x-forwarded-host"].trim() : "";
  const forwardedProto = typeof request.headers["x-forwarded-proto"] === "string" ? request.headers["x-forwarded-proto"].trim().split(",")[0] : "";
  if (forwardedHost) {
    return (forwardedProto || request.protocol || "http") + "://" + forwardedHost.split(",")[0].trim();
  }
  const host = typeof request.headers.host === "string" ? request.headers.host.trim() : "";
  const protocol = request.protocol || "http";
  return host ? protocol + "://" + host : "";
}
function isCredentialUsableForTargetSiteLogin(credential: { provider?: string; credentialType: string; metadata?: Record<string, unknown> | null }): boolean {
  if (credential.credentialType === 'cookie') {
    return credential.provider === 'linuxdo';
  }
  if (credential.credentialType !== 'session_artifact') return false;
  const source = typeof credential.metadata?.source === 'string' ? credential.metadata.source : '';
  return source === 'target-site-browser-login';
}

function isProviderCredentialUsableForTargetSiteOAuth(credential: { credentialType: string; metadata?: Record<string, unknown> | null }): boolean {
  const source = typeof credential.metadata?.source === 'string' ? credential.metadata.source : '';
  if (source !== 'controlled-browser-login') return false;
  return credential.credentialType === 'cookie' || credential.credentialType === 'session_artifact';
}

function parseFiniteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseSiteAuthBrowserInputEvent(value: unknown): SiteAuthBrowserInputEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const type = typeof payload.type === 'string' ? payload.type.trim() : '';
  if (type === 'click' || type === 'mouseDown' || type === 'mouseMove' || type === 'mouseUp') {
    const x = parseFiniteNumber(payload.x);
    const y = parseFiniteNumber(payload.y);
    return x === null || y === null ? null : { type, x, y };
  }
  if (type === 'type') {
    return typeof payload.text === 'string' ? { type, text: payload.text } : null;
  }
  if (type === 'press') {
    return typeof payload.key === 'string' ? { type, key: payload.key } : null;
  }
  if (type === 'scroll') {
    const deltaY = parseFiniteNumber(payload.deltaY);
    return deltaY === null ? null : { type, deltaY };
  }
  return null;
}

export async function siteAuthRoutes(app: FastifyInstance) {
  app.get('/api/site-auth/providers', { preHandler: [limitSiteAuthProviderRead] }, async () => ({
    providers: listSiteAuthProviderDefinitions().map((definition) => ({
      ...definition.metadata,
      authorizationConfigured: true,
      authorizationUnavailableReason: null,
    })),
  }));

  app.get<{ Params: { state: string } }>(
    '/site-auth/browser/:state',
    async (request, reply) => {
      const state = String(request.params.state || '').trim();
      if (!state) {
        return reply.code(404).type('text/html; charset=utf-8').send('Site auth browser session not found');
      }
      return reply
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(renderSiteAuthBrowserPage(state));
    },
  );

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
        return await startSiteAuthAuthorization(provider, resolveRequestOrigin(request));
      } catch (error: any) {
        return reply.code(400).send({ success: false, message: error?.message || 'site auth authorization start failed' });
      }
    },
  );

  app.get<{ Params: { state: string } }>(
    '/api/site-auth/sessions/:state',
    { preHandler: [limitSiteAuthBrowserSessionRead] },
    async (request, reply) => {
      const state = String(request.params.state || '').trim();
      const session = state ? getSiteAuthAuthorizationSession(state) : null;
      if (!session) {
        return reply.code(404).send({ success: false, message: 'site auth authorization session not found' });
      }
      return session;
    },
  );

  app.get<{ Params: { state: string } }>(
    '/api/site-auth/browser-sessions/:state/screenshot',
    { preHandler: [limitSiteAuthBrowserScreenshot] },
    async (request, reply) => {
      const state = String(request.params.state || '').trim();
      try {
        const buffer = await captureSiteAuthBrowserScreenshot(state);
        return reply
          .header('Cache-Control', 'no-store')
          .type('image/png')
          .send(buffer);
      } catch (error: any) {
        return reply.code(404).send({ success: false, message: error?.message || 'site auth browser screenshot failed' });
      }
    },
  );

  app.post<{ Params: { state: string }; Body: unknown }>(
    '/api/site-auth/browser-sessions/:state/input',
    { preHandler: [limitSiteAuthBrowserInput] },
    async (request, reply) => {
      const state = String(request.params.state || '').trim();
      const input = parseSiteAuthBrowserInputEvent(request.body);
      if (!input) {
        return reply.code(400).send({ success: false, message: 'invalid site auth browser input' });
      }
      try {
        return await sendSiteAuthBrowserInput(state, input);
      } catch (error: any) {
        return reply.code(404).send({ success: false, message: error?.message || 'site auth browser input failed' });
      }
    },
  );

  app.post<{ Params: { state: string } }>(
    '/api/site-auth/browser-sessions/:state/save',
    { preHandler: [limitSiteAuthCredentialImport] },
    async (request, reply) => {
      const state = String(request.params.state || '').trim();
      try {
        return await saveSiteAuthBrowserSession(state);
      } catch (error: any) {
        return reply.code(400).send({ success: false, message: error?.message || 'site auth browser save failed' });
      }
    },
  );

  app.post<{ Params: { state: string } }>(
    '/api/site-auth/browser-sessions/:state/close',
    { preHandler: [limitSiteAuthCredentialDelete] },
    async (request, reply) => {
      const state = String(request.params.state || '').trim();
      try {
        return await closeSiteAuthBrowserSession(state);
      } catch (error: any) {
        return reply.code(404).send({ success: false, message: error?.message || 'site auth browser close failed' });
      }
    },
  );

  app.get<{ Params: { provider: string }; Querystring: { state?: string; code?: string; payload?: string; oneTimePassword?: string; error?: string } }>(
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
          payload: request.query.payload,
          oneTimePassword: request.query.oneTimePassword,
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
            credential.provider === requirement.provider && credential.status === 'active' && isCredentialUsableForTargetSiteLogin(credential)
          )),
          availableProviderCredentials: credentials.filter((credential) => (
            credential.provider === requirement.provider && credential.status === 'active' && isProviderCredentialUsableForTargetSiteOAuth(credential)
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

      if (!isCredentialUsableForTargetSiteLogin(credential)) {
        return {
          credentialId,
          total: 0,
          items: [],
        };
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
