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

  it('refreshes expired Google OAuth tokens before verification', async () => {
    const created = await vault.createSiteAuthCredential({
      provider: 'google',
      label: 'Google 主账号',
      credentialType: 'oauth_token',
      payload: {
        accessToken: 'expired-google-token',
        refreshToken: 'google-refresh-token',
      },
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    process.env.SITE_AUTH_GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.SITE_AUTH_GOOGLE_CLIENT_SECRET = 'google-client-secret';
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'fresh-google-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid email profile',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ sub: 'google-sub-1', email: 'google@example.com', name: 'Google User' }),
      });

    const result = await verifier.verifySiteAuthCredential(created.id);

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://oauth2.googleapis.com/token', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://www.googleapis.com/oauth2/v3/userinfo', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer fresh-google-token' }),
    }));
    expect(result).toMatchObject({ success: true, item: { status: 'active', expiresAt: expect.any(String) } });
    const payload = await vault.getSiteAuthCredentialPayload(created.id);
    expect(payload).toMatchObject({
      accessToken: 'fresh-google-token',
      refreshToken: 'google-refresh-token',
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
  });

  it('verifies LinuxDO OAuth tokens and stores identity metadata', async () => {
    const created = await vault.createSiteAuthCredential({
      provider: 'linuxdo',
      label: 'LinuxDO 主账号',
      credentialType: 'oauth_token',
      payload: { accessToken: 'linuxdo-super-secret' },
      status: 'invalid',
      lastError: 'previous failure',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 6789, username: 'linuxdo-user', name: 'LinuxDO User' }),
    });

    const result = await verifier.verifySiteAuthCredential(created.id);

    expect(JSON.stringify(result)).not.toContain('linuxdo-super-secret');
    expect(fetchMock).toHaveBeenCalledWith('https://connect.linux.do/api/user', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer linuxdo-super-secret',
        Accept: 'application/json',
      }),
    }));
    expect(result).toMatchObject({
      success: true,
      item: {
        provider: 'linuxdo',
        status: 'active',
        subject: '6789',
        username: 'linuxdo-user',
        lastError: null,
      },
    });
  });
});
