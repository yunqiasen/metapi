import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

type DbModule = typeof import('../../db/index.js');
type VaultModule = typeof import('../../services/site-auth/credentialVault.js');

describe('site auth routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let vault: VaultModule;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-site-auth-routes-'));
    process.env.ACCOUNT_CREDENTIAL_SECRET = 'site-auth-routes-test-secret';
    process.env.SITE_AUTH_GITHUB_CLIENT_ID = 'github-client-id';
    process.env.SITE_AUTH_GITHUB_CLIENT_SECRET = 'github-client-secret';
    process.env.SITE_AUTH_GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.SITE_AUTH_GOOGLE_CLIENT_SECRET = 'google-client-secret';

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./siteAuth.js');
    vault = await import('../../services/site-auth/credentialVault.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.siteAuthRoutes);
  });

  beforeEach(async () => {
    fetchMock.mockReset();
    await db.delete(schema.siteAuthCredentials).run();
    await db.delete(schema.sites).run();
  });

  it('lists supported third-party login providers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/site-auth/providers',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      providers: [
        expect.objectContaining({ provider: 'linuxdo', label: 'LinuxDO' }),
        expect.objectContaining({ provider: 'github', label: 'GitHub' }),
        expect.objectContaining({ provider: 'google', label: 'Google' }),
      ],
    });
  });

  it('lists credential summaries without leaking encrypted payloads', async () => {
    await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '主 LinuxDO',
      subject: 'linuxdo-user-42',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=super-secret-session' },
      metadata: { source: 'route-test' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/site-auth/credentials',
    });

    expect(response.statusCode).toBe(200);
    const bodyText = response.body;
    expect(bodyText).not.toContain('super-secret-session');
    expect(bodyText).not.toContain('encryptedPayload');
    expect(response.json()).toMatchObject({
      items: [
        expect.objectContaining({
          provider: 'linuxdo',
          label: '主 LinuxDO',
          subject: 'linuxdo-user-42',
          credentialType: 'cookie',
          metadata: { source: 'route-test' },
        }),
      ],
      total: 1,
    });
  });

  it('starts GitHub site-auth OAuth and stores the pending session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/github/start',
      headers: { origin: 'http://metapi.local' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      provider: 'github',
      instructions: {
        redirectUri: 'http://metapi.local/api/site-auth/callback/github',
        callbackPath: '/api/site-auth/callback/github',
        mode: 'oauth',
      },
    });
    const authorizationUrl = new URL(body.authorizationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(authorizationUrl.searchParams.get('client_id')).toBe('github-client-id');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('http://metapi.local/api/site-auth/callback/github');
    expect(authorizationUrl.searchParams.get('state')).toBe(body.state);
    expect(authorizationUrl.searchParams.get('scope')).toContain('user:email');
  });

  it('exchanges a GitHub callback code and automatically saves the credential', async () => {
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/github/start',
      headers: { origin: 'http://metapi.local' },
    });
    const state = startResponse.json().state;
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'github-oauth-token',
          token_type: 'bearer',
          scope: 'read:user,user:email',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 12345,
          login: 'octocat',
          email: null,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ([
          { email: 'octocat@example.com', primary: true, verified: true },
        ]),
      });

    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/api/site-auth/callback/github?state=${encodeURIComponent(state)}&code=github-code`,
    });

    expect(callbackResponse.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://github.com/login/oauth/access_token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer github-oauth-token' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://api.github.com/user/emails?per_page=100',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer github-oauth-token' }),
      }),
    );

    const sessionResponse = await app.inject({ method: 'GET', url: `/api/site-auth/sessions/${state}` });
    expect(sessionResponse.json()).toMatchObject({
      provider: 'github',
      state,
      status: 'success',
      credential: {
        provider: 'github',
        label: 'GitHub · octocat',
        credentialType: 'oauth_token',
        subject: '12345',
        username: 'octocat',
        email: 'octocat@example.com',
        metadata: { source: 'provider-oauth-callback' },
      },
    });
    const payload = await vault.getSiteAuthCredentialPayload(sessionResponse.json().credential.id);
    expect(payload).toMatchObject({
      accessToken: 'github-oauth-token',
      tokenType: 'bearer',
      scope: 'read:user,user:email',
    });
  });

  it('exchanges a Google callback code and automatically saves the credential', async () => {
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/google/start',
      headers: { origin: 'http://metapi.local' },
    });
    expect(startResponse.statusCode).toBe(200);
    const state = startResponse.json().state;
    const authorizationUrl = new URL(startResponse.json().authorizationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authorizationUrl.searchParams.get('client_id')).toBe('google-client-id');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('http://metapi.local/api/site-auth/callback/google');
    expect(authorizationUrl.searchParams.get('scope')).toContain('openid');

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'google-oauth-token',
          refresh_token: 'google-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid email profile',
          id_token: 'google-id-token',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          sub: 'google-sub-123',
          name: 'Google User',
          email: 'google-user@example.com',
        }),
      });

    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/api/site-auth/callback/google?state=${encodeURIComponent(state)}&code=google-code`,
    });

    expect(callbackResponse.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/oauth2/v3/userinfo',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer google-oauth-token' }),
      }),
    );
    const sessionResponse = await app.inject({ method: 'GET', url: `/api/site-auth/sessions/${state}` });
    expect(sessionResponse.json()).toMatchObject({
      provider: 'google',
      state,
      status: 'success',
      credential: {
        provider: 'google',
        label: 'Google · Google User',
        credentialType: 'oauth_token',
        subject: 'google-sub-123',
        username: 'Google User',
        email: 'google-user@example.com',
        metadata: { source: 'provider-oauth-callback' },
      },
    });
    const payload = await vault.getSiteAuthCredentialPayload(sessionResponse.json().credential.id);
    expect(payload).toMatchObject({
      accessToken: 'google-oauth-token',
      refreshToken: 'google-refresh-token',
      idToken: 'google-id-token',
      expiresIn: 3600,
    });
  });

  it('rejects LinuxDO OAuth starts when no callback OAuth flow is configured', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/linuxdo/start',
      headers: { origin: 'http://metapi.local' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('LinuxDO automatic OAuth is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('imports a target-site session artifact without returning secret payloads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/site-auth/credentials/import',
      payload: {
        provider: 'github',
        label: 'GitHub 目标站 Session',
        credentialType: 'session_artifact',
        subject: 'target-user-2468',
        username: 'target-user',
        payload: {
          accessToken: 'target-site-session-secret',
          platformUserId: 2468,
        },
        metadata: {
          source: 'target-site-browser-login',
          targetSiteId: 31,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('target-site-session-secret');
    expect(response.json()).toMatchObject({
      success: true,
      item: {
        provider: 'github',
        label: 'GitHub 目标站 Session',
        credentialType: 'session_artifact',
        subject: 'target-user-2468',
        username: 'target-user',
        status: 'active',
        metadata: {
          source: 'target-site-browser-login',
          targetSiteId: 31,
        },
      },
    });

    const payload = await vault.getSiteAuthCredentialPayload(response.json().item.id);
    expect(payload).toMatchObject({
      accessToken: 'target-site-session-secret',
      platformUserId: 2468,
    });
  });

  it('reports credential decryptability without leaking payloads', async () => {
    await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '迁移路由检查',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=route-migration-check' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/site-auth/credentials/decryptability',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('route-migration-check');
    expect(response.body).not.toContain('ld_auth_session');
    expect(response.json()).toEqual(expect.objectContaining({
      total: 1,
      decryptable: 1,
      failed: 0,
      items: [expect.objectContaining({ label: '迁移路由检查', ok: true })],
    }));
  });

  it('imports a manual LinuxDO credential without returning secret payloads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/site-auth/credentials/import',
      payload: {
        provider: 'linuxdo',
        label: '主 LinuxDO',
        credentialType: 'cookie',
        subject: 'linuxdo-user-42',
        email: 'linuxdo-user@example.com',
        username: 'linuxdo-user',
        payload: {
          cookie: 'ld_auth_session=super-secret-session',
          userId: 42,
        },
        metadata: { source: 'manual-api-test' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('super-secret-session');
    expect(response.json()).toMatchObject({
      success: true,
      item: {
        provider: 'linuxdo',
        label: '主 LinuxDO',
        credentialType: 'cookie',
        subject: 'linuxdo-user-42',
        email: 'linuxdo-user@example.com',
        username: 'linuxdo-user',
        status: 'active',
        metadata: { source: 'manual-api-test' },
      },
    });

    const rows = await db.select().from(schema.siteAuthCredentials).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.encryptedPayload).not.toContain('super-secret-session');
  });

  it('parses browser assisted LinuxDO credential text', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/site-auth/credentials/parse-capture',
      payload: {
        text: 'ld_auth_session=route-secret; theme=light',
        defaultProvider: 'linuxdo',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      parsed: {
        provider: 'linuxdo',
        credentialType: 'cookie',
        payload: { cookie: 'ld_auth_session=route-secret' },
      },
    });
  });

  it('rejects invalid browser capture text without echoing the pasted value', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/site-auth/credentials/parse-capture',
      payload: {
        text: 'bad pasted text with hidden-secret',
        defaultProvider: 'linuxdo',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('hidden-secret');
    expect(response.json()).toMatchObject({
      success: false,
      message: 'no supported site auth credential found',
    });
  });

  it('verifies a LinuxDO cookie credential and updates identity metadata', async () => {
    const created = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '待校验 LinuxDO',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=super-secret-session' },
      status: 'invalid',
      lastError: 'previous failure',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        current_user: {
          id: 42,
          username: 'linuxdo-user',
          email: 'linuxdo-user@example.com',
        },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/site-auth/credentials/${created.id}/verify`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('super-secret-session');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://linux.do/session/current.json',
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: 'ld_auth_session=super-secret-session',
          Accept: 'application/json',
        }),
      }),
    );
    expect(response.json()).toMatchObject({
      success: true,
      item: {
        id: created.id,
        provider: 'linuxdo',
        status: 'active',
        subject: '42',
        username: 'linuxdo-user',
        email: 'linuxdo-user@example.com',
        lastError: null,
      },
    });
    expect(response.json().item.lastVerifiedAt).toEqual(expect.any(String));
  });

  it('returns auth-requirements with matching credential summaries', async () => {
    const [site] = await db.insert(schema.sites).values({
      name: 'LinuxDO Login Site',
      url: 'https://target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning();
    const credential = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '主 LinuxDO',
      subject: '42',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=secret' },
      status: 'active',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<html><body><button>使用 LinuxDO 继续</button></body></html>',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/sites/${site.id}/auth-requirements`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('ld_auth_session=secret');
    expect(response.json()).toMatchObject({
      siteId: site.id,
      hasThirdPartyLogin: true,
      requirements: [
        {
          provider: 'linuxdo',
          label: 'LinuxDO',
          required: true,
          confidence: 'detected',
          reason: expect.any(String),
          availableCredentials: [expect.objectContaining({ id: credential.id, label: '主 LinuxDO' })],
        },
      ],
    });
  });

  it('returns target sites for a site auth credential without leaking payloads', async () => {
    const [linuxDoSite] = await db.insert(schema.sites).values({
      name: 'LinuxDO Target Site',
      url: 'https://linuxdo-target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning();
    await db.insert(schema.sites).values({
      name: 'Plain Target Site',
      url: 'https://plain-target.example.com',
      platform: 'new-api',
      status: 'active',
    }).run();
    const credential = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '主 LinuxDO',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=target-sites-secret' },
      status: 'active',
    });
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<html><body><button>使用 LinuxDO 继续</button></body></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<html><body><form>password login</form></body></html>',
      });

    const response = await app.inject({
      method: 'GET',
      url: `/api/site-auth/credentials/${credential.id}/target-sites`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('target-sites-secret');
    expect(response.body).not.toContain('ld_auth_session');
    expect(response.json()).toMatchObject({
      credentialId: credential.id,
      total: 1,
      items: [
        expect.objectContaining({
          id: linuxDoSite.id,
          name: 'LinuxDO Target Site',
          platform: 'new-api',
        }),
      ],
    });
  });

  it('deletes a credential summary by id', async () => {
    const created = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '删除路由测试',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=delete-route' },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/site-auth/credentials/${created.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    const listResponse = await app.inject({ method: 'GET', url: '/api/site-auth/credentials' });
    expect(listResponse.json()).toMatchObject({ items: [], total: 0 });
  });
});
