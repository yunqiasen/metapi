import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
});
