import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupBrowserProfiles, reconcileManagedBrowserProfileExtraConfig } from './browserProfileCleanupService.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'metapi-browser-cleanup-'));
  roots.push(root);
  return root;
}

describe('browser profile cleanup', () => {
  it('replaces placeholder profile paths only when a real persisted profile exists', async () => {
    const extra = JSON.stringify({
      credentialMode: 'session',
      autoRelogin: { username: 'demo' },
      managedBrowserProfile: { enabled: true, profileDir: '/app/data/browser-profiles/accounts/anyrouter/<accountId>' },
    });

    expect(JSON.parse(reconcileManagedBrowserProfileExtraConfig(extra, '/app/data/browser-profiles/accounts/anyrouter/92', true))).toMatchObject({
      autoRelogin: { username: 'demo' },
      managedBrowserProfile: { enabled: true, profileDir: '/app/data/browser-profiles/accounts/anyrouter/92' },
    });
    expect(JSON.parse(reconcileManagedBrowserProfileExtraConfig(extra, '/app/data/browser-profiles/accounts/anyrouter/91', false)).managedBrowserProfile).toBeUndefined();

    const root = await makeRoot();
    const wrongPath = join(root, 'browser-profiles', 'accounts', 'agentrouter', '91');
    await mkdir(wrongPath, { recursive: true });
    const wrongExistingPath = JSON.stringify({
      managedBrowserProfile: { enabled: true, profileDir: wrongPath },
    });
    expect(JSON.parse(reconcileManagedBrowserProfileExtraConfig(
      wrongExistingPath,
      join(root, 'browser-profiles', 'accounts', 'anyrouter', '91'),
      false,
    )).managedBrowserProfile).toBeUndefined();
  });

  it('removes stale target-site temporary profiles', async () => {
    const root = await makeRoot();
    const stale = join(root, 'target-site-auth-profiles', '9', 'old-session');
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, 'marker'), 'stale');

    const result = await cleanupBrowserProfiles({ dataDir: root, activeProfileDirs: new Set() });

    expect(result.removedTargetSiteProfiles).toBe(1);
    expect(await readdir(join(root, 'target-site-auth-profiles', '9')).catch(() => [])).toEqual([]);
  });

  it('keeps profiles for existing accounts and removes orphaned or pending profiles', async () => {
    const root = await makeRoot();
    for (const name of ['91', '56', 'pending-abc', '92.tmp-old']) {
      await mkdir(join(root, 'browser-profiles', 'accounts', 'anyrouter', name), { recursive: true });
    }
    await mkdir(join(root, 'browser-profiles', 'accounts', 'agentrouter', '91'), { recursive: true });

    const activeProfileDir = join(root, 'browser-profiles', 'accounts', 'anyrouter', '91');
    const result = await cleanupBrowserProfiles({ dataDir: root, activeProfileDirs: new Set([activeProfileDir]) });
    const remaining = await readdir(join(root, 'browser-profiles', 'accounts', 'anyrouter'));

    expect(remaining).toEqual(['91']);
    expect(result.removedAccountProfiles).toBe(4);
    expect(await readdir(join(root, 'browser-profiles', 'accounts', 'agentrouter'))).toEqual([]);
  });
});
