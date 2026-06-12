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
});
