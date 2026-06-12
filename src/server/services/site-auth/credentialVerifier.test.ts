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
type VaultModule = typeof import('./credentialVault.js');
type VerifierModule = typeof import('./credentialVerifier.js');

describe('site auth credential verifier', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let vault: VaultModule;
  let verifier: VerifierModule;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-site-auth-verifier-'));
    process.env.ACCOUNT_CREDENTIAL_SECRET = 'site-auth-verifier-test-secret';

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    vault = await import('./credentialVault.js');
    verifier = await import('./credentialVerifier.js');
    db = dbModule.db;
    schema = dbModule.schema;
  });

  beforeEach(async () => {
    fetchMock.mockReset();
    await db.delete(schema.siteAuthCredentials).run();
  });

  it('verifies GitHub access tokens and stores identity metadata', async () => {
    const created = await vault.createSiteAuthCredential({
      provider: 'github',
      label: 'GitHub 主账号',
      credentialType: 'oauth_token',
      payload: { accessToken: 'ghp-super-secret' },
      status: 'invalid',
      lastError: 'previous failure',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 123, login: 'octocat', email: 'octo@example.com' }),
    });

    const result = await verifier.verifySiteAuthCredential(created.id);

    expect(JSON.stringify(result)).not.toContain('ghp-super-secret');
    expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/user', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer ghp-super-secret',
        Accept: 'application/json',
      }),
    }));
    expect(result).toMatchObject({
      success: true,
      item: {
        provider: 'github',
        status: 'active',
        subject: '123',
        username: 'octocat',
        email: 'octo@example.com',
        lastError: null,
      },
    });
  });

  it('verifies Google access tokens and stores identity metadata', async () => {
    const created = await vault.createSiteAuthCredential({
      provider: 'google',
      label: 'Google 主账号',
      credentialType: 'oauth_token',
      payload: { accessToken: 'ya29.super-secret' },
      status: 'invalid',
      lastError: 'previous failure',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sub: 'google-sub-1', email: 'google@example.com', name: 'Google User' }),
    });

    const result = await verifier.verifySiteAuthCredential(created.id);

    expect(JSON.stringify(result)).not.toContain('ya29.super-secret');
    expect(fetchMock).toHaveBeenCalledWith('https://www.googleapis.com/oauth2/v3/userinfo', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer ya29.super-secret',
        Accept: 'application/json',
      }),
    }));
    expect(result).toMatchObject({
      success: true,
      item: {
        provider: 'google',
        status: 'active',
        subject: 'google-sub-1',
        username: 'Google User',
        email: 'google@example.com',
        lastError: null,
      },
    });
  });
});
