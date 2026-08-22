import { eq } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { resolveAccountBrowserProfileDir } from './accountManagedBrowserLogin.js';



function parseExtraConfig(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...(value as Record<string, any>) };
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

export function reconcileManagedBrowserProfileExtraConfig(
  extraConfig: unknown,
  expectedProfileDir: string,
  expectedProfileExists: boolean,
): string {
  const extra = parseExtraConfig(extraConfig);
  const current = extra.managedBrowserProfile && typeof extra.managedBrowserProfile === 'object'
    ? { ...extra.managedBrowserProfile }
    : null;
  if (expectedProfileExists) {
    extra.managedBrowserProfile = {
      ...(current || {}),
      enabled: true,
      profileDir: expectedProfileDir,
    };
  } else {
    // The canonical account path is the only source of truth. An existing
    // profile under another provider/account path must not keep stale metadata
    // alive or protect that directory from orphan cleanup.
    delete extra.managedBrowserProfile;
  }
  return JSON.stringify(extra);
}

export type BrowserProfileCleanupResult = {
  removedTargetSiteProfiles: number;
  removedAccountProfiles: number;
};

async function listDirectories(path: string) {
  return (await readdir(path, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory());
}

export async function cleanupBrowserProfiles(input: {
  dataDir: string;
  activeProfileDirs: Set<string>;
}): Promise<BrowserProfileCleanupResult> {
  let removedTargetSiteProfiles = 0;
  let removedAccountProfiles = 0;
  const targetRoot = resolve(input.dataDir, 'target-site-auth-profiles');
  for (const siteDir of await listDirectories(targetRoot)) {
    const sitePath = join(targetRoot, siteDir.name);
    for (const sessionDir of await listDirectories(sitePath)) {
      await rm(join(sitePath, sessionDir.name), { recursive: true, force: true });
      removedTargetSiteProfiles += 1;
    }
  }

  const accountRoot = resolve(input.dataDir, 'browser-profiles', 'accounts');
  for (const providerDir of await listDirectories(accountRoot)) {
    const providerPath = join(accountRoot, providerDir.name);
    for (const profileDir of await listDirectories(providerPath)) {
      const candidate = resolve(providerPath, profileDir.name);
      if (input.activeProfileDirs.has(candidate)) continue;
      await rm(join(providerPath, profileDir.name), { recursive: true, force: true });
      removedAccountProfiles += 1;
    }
  }

  return { removedTargetSiteProfiles, removedAccountProfiles };
}

export async function cleanupOrphanedBrowserProfiles(): Promise<BrowserProfileCleanupResult> {
  const rows = await db
    .select({ account: schema.accounts, site: schema.sites })
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();
  const activeProfileDirs = new Set<string>();
  for (const row of rows) {
    activeProfileDirs.add(resolve(resolveAccountBrowserProfileDir(row.account, row.site)));
  }
  const cleanupResult = await cleanupBrowserProfiles({ dataDir: config.dataDir, activeProfileDirs });
  for (const row of rows) {
    const expectedProfileDir = resolve(resolveAccountBrowserProfileDir(row.account, row.site));
    const reconciled = reconcileManagedBrowserProfileExtraConfig(
      row.account.extraConfig,
      expectedProfileDir,
      existsSync(expectedProfileDir),
    );
    if (reconciled !== (row.account.extraConfig || '{}')) {
      await db.update(schema.accounts)
        .set({ extraConfig: reconciled, updatedAt: new Date().toISOString() })
        .where(eq(schema.accounts.id, row.account.id))
        .run();
    }
  }
  return cleanupResult;
}
