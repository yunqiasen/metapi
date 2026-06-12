import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

type DbModule = typeof import('../../db/index.js');
type VaultModule = typeof import('./credentialVault.js');

describe('site auth credential vault', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let vault: VaultModule;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-site-auth-vault-'));
    process.env.ACCOUNT_CREDENTIAL_SECRET = 'site-auth-vault-test-secret';

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    vault = await import('./credentialVault.js');
    db = dbModule.db;
    schema = dbModule.schema;
  });

  beforeEach(async () => {
    await db.delete(schema.siteAuthCredentials).run();
  });

  it('stores encrypted provider payloads and returns redacted summaries', async () => {
    const created = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '主 LinuxDO',
      subject: 'linuxdo-user-42',
      email: 'user@example.com',
      username: 'linuxdo-user',
      credentialType: 'cookie',
      payload: {
        cookie: 'ld_auth_session=super-secret-session',
        userId: 42,
      },
      status: 'active',
      expiresAt: '2026-12-31T00:00:00.000Z',
      metadata: { source: 'manual-test' },
    });

    expect(created).toMatchObject({
      provider: 'linuxdo',
      label: '主 LinuxDO',
      subject: 'linuxdo-user-42',
      email: 'user@example.com',
      username: 'linuxdo-user',
      credentialType: 'cookie',
      status: 'active',
    });
    expect(JSON.stringify(created)).not.toContain('super-secret-session');

    const raw = await db.select().from(schema.siteAuthCredentials).get();
    expect(raw?.encryptedPayload).toBeTruthy();
    expect(raw?.encryptedPayload).not.toContain('super-secret-session');

    const summaries = await vault.listSiteAuthCredentials();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: created.id,
      provider: 'linuxdo',
      label: '主 LinuxDO',
      credentialType: 'cookie',
      status: 'active',
      metadata: { source: 'manual-test' },
    });
    expect(JSON.stringify(summaries[0])).not.toContain('super-secret-session');

    const payload = await vault.getSiteAuthCredentialPayload(created.id);
    expect(payload).toEqual({
      cookie: 'ld_auth_session=super-secret-session',
      userId: 42,
    });
  });

  it('deletes a site auth credential without exposing its payload', async () => {
    const created = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: '删除测试',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=delete-me' },
    });

    await expect(vault.deleteSiteAuthCredential(created.id)).resolves.toBe(true);
    await expect(vault.getSiteAuthCredential(created.id)).resolves.toBeNull();
    await expect(vault.getSiteAuthCredentialPayload(created.id)).resolves.toBeNull();
  });
});
