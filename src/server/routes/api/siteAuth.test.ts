import Fastify, { type FastifyInstance } from 'fastify';
import { constants, publicEncrypt } from 'node:crypto';
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

  it('starts GitHub browser authorization and saves the exchanged credential on callback', async () => {
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/github/start',
      headers: { origin: 'http://metapi.local' },
    });

    expect(startResponse.statusCode).toBe(200);
    const startBody = startResponse.json();
    expect(startBody.authorizationUrl).toContain('https://github.com/login/oauth/authorize');
    expect(startBody.authorizationUrl).toContain(encodeURIComponent('http://metapi.local/api/site-auth/callback/github'));
    expect(startBody.instructions).toMatchObject({
      redirectUri: 'http://metapi.local/api/site-auth/callback/github',
      mode: 'oauth',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'gho-secret-token', token_type: 'bearer', scope: 'read:user,user:email' }),
    });

    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/api/site-auth/callback/github?state=${encodeURIComponent(startBody.state)}&code=github-code-1`,
    });

    expect(callbackResponse.statusCode).toBe(200);
    expect(callbackResponse.body).toContain('授权已保存');
    expect(callbackResponse.body).not.toContain('gho-secret-token');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.com/login/oauth/access_token',
      expect.objectContaining({ method: 'POST' }),
    );

    const sessionResponse = await app.inject({
      method: 'GET',
      url: `/api/site-auth/sessions/${encodeURIComponent(startBody.state)}`,
    });
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.body).not.toContain('gho-secret-token');
    expect(sessionResponse.json()).toMatchObject({
      provider: 'github',
      state: startBody.state,
      status: 'success',
      credential: expect.objectContaining({ provider: 'github', credentialType: 'oauth_token' }),
    });

    const payload = await vault.getSiteAuthCredentialPayload(sessionResponse.json().credential.id);
    expect(payload).toMatchObject({ accessToken: 'gho-secret-token' });
  });

  it('starts LinuxDO user-api-key authorization and saves the OTP session cookie on callback', async () => {
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/site-auth/providers/linuxdo/start',
      headers: { origin: 'http://metapi.local' },
    });

    expect(startResponse.statusCode).toBe(200);
    const startBody = startResponse.json();
    const authorizationUrl = new URL(startBody.authorizationUrl);
    expect(authorizationUrl.origin).toBe('https://linux.do');
    expect(authorizationUrl.pathname).toBe('/user-api-key/new');
    expect(authorizationUrl.searchParams.get('auth_redirect')).toBe('http://metapi.local/api/site-auth/callback/linuxdo');
    expect(authorizationUrl.searchParams.get('scopes')).toContain('one_time_password');
    expect(authorizationUrl.searchParams.get('padding')).toBe('oaep');
    expect(startBody.instructions).toMatchObject({
      redirectUri: 'http://metapi.local/api/site-auth/callback/linuxdo',
      mode: 'oauth',
    });

    const publicKey = authorizationUrl.searchParams.get('public_key') || '';
    const nonce = authorizationUrl.searchParams.get('nonce') || '';
    const payload = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING },
      Buffer.from(JSON.stringify({ key: 'linuxdo-user-api-key', nonce, api: 4, username: 'linuxdo-user' })),
    ).toString('base64');
    const oneTimePassword = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING },
      Buffer.from('linuxdo-otp-1'),
    ).toString('base64');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        getSetCookie: () => ['ld_auth_session=auto-session; Path=/; HttpOnly; Secure', '_t=csrf-token; Path=/; Secure'],
      },
    });

    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/api/site-auth/callback/linuxdo?state=${encodeURIComponent(startBody.state)}&payload=${encodeURIComponent(payload)}&oneTimePassword=${encodeURIComponent(oneTimePassword)}`,
    });

    expect(callbackResponse.statusCode).toBe(200);
    expect(callbackResponse.body).toContain('授权已保存');
    expect(callbackResponse.body).not.toContain('auto-session');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://linux.do/session/otp/linuxdo-otp-1',
      expect.objectContaining({ redirect: 'manual' }),
    );

    const sessionResponse = await app.inject({
      method: 'GET',
      url: `/api/site-auth/sessions/${encodeURIComponent(startBody.state)}`,
    });
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.body).not.toContain('auto-session');
    expect(sessionResponse.json()).toMatchObject({
      provider: 'linuxdo',
      state: startBody.state,
      status: 'success',
      credential: expect.objectContaining({ provider: 'linuxdo', credentialType: 'cookie' }),
    });

    const savedPayload = await vault.getSiteAuthCredentialPayload(sessionResponse.json().credential.id);
    expect(savedPayload).toMatchObject({ cookie: expect.stringContaining('ld_auth_session=auto-session') });
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
