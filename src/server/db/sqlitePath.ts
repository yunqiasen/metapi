import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { threadId } from 'node:worker_threads';

export type SqlitePathConfig = {
  dbUrl: string;
  dataDir: string;
};

function isVitestRuntime(): boolean {
  if ((process.env.VITEST_POOL_ID || '').trim()) return true;
  if ((process.env.VITEST_WORKER_ID || '').trim()) return true;
  return [...process.argv, ...process.execArgv]
    .map((value) => String(value || '').toLowerCase())
    .some((value) => value.includes('vitest'));
}

function isDefaultRepoDataDir(value: string | undefined): boolean {
  const trimmed = (value || '').trim();
  return !!trimmed && resolve(trimmed) === resolve('./data');
}

function resolveDatabaseUrl(rawValue: string): string {
  const raw = rawValue.trim();
  if (raw === ':memory:') return raw;
  if (raw.startsWith('file://')) {
    const parsed = new URL(raw);
    return decodeURIComponent(parsed.pathname);
  }
  if (raw.startsWith('sqlite://')) {
    return resolve(raw.slice('sqlite://'.length).trim());
  }
  return resolve(raw);
}

export function resolveSqliteDbPath(config: SqlitePathConfig): string {
  const runtimeDbUrl = (process.env.DB_URL || '').trim();
  const configuredDbUrl = (config.dbUrl || '').trim();

  if (isVitestRuntime() && runtimeDbUrl) {
    return resolveDatabaseUrl(runtimeDbUrl);
  }
  if (configuredDbUrl) {
    return resolveDatabaseUrl(configuredDbUrl);
  }

  if (isVitestRuntime()) {
    // Test files often set DATA_DIR after config was cached by another file in
    // the same worker. Prefer that explicit directory so migration and runtime
    // clients always open the same isolated database.
    const runtimeDataDir = (process.env.DATA_DIR || '').trim();
    if (runtimeDataDir && !isDefaultRepoDataDir(runtimeDataDir)) {
      return resolve(runtimeDataDir, 'hub.db');
    }
    if (!isDefaultRepoDataDir(config.dataDir)) {
      return resolve(config.dataDir, 'hub.db');
    }

    const workerTag = process.env.VITEST_POOL_ID
      || process.env.VITEST_WORKER_ID
      || `${process.pid}-${threadId}`;
    return resolve(tmpdir(), `metapi-vitest-${workerTag}`, 'hub.db');
  }

  return resolve(config.dataDir, 'hub.db');
}
