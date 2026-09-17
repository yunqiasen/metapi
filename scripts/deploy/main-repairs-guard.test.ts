import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const fixtures: string[] = [];
const baseline = '41767a65ec8e5470a9a70f4615b47dc24949afff';
const originalFiles = {
  'server/services/checkinService.js': 'executeAgentRouterOauthRelogin',
  'server/services/agentRouterOauthReloginService.js': 'executeAgentRouterOauthRelogin',
  'server/services/accountUpdateWorkflow.js': 'startBackgroundTask',
  'server/services/platforms/newApiShield.js': 'normalizeNewApiCredential',
  'server/services/platforms/newApi.js': 'credentialMode',
  'web/index.html': '<div id="root"></div>',
};
function fixture(overrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'metapi-main-guard-'));
  fixtures.push(root);
  const files = { ...originalFiles, ...overrides };
  for (const [path, value] of Object.entries(files)) {
    const target = join(root, 'dist', path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, value);
  }
  writeFileSync(join(root, 'main-repairs-manifest.json'), JSON.stringify({
    flavor: 'main-with-local-repairs', baseline,
    artifacts: Object.fromEntries(Object.entries(files).map(([path, value]) => [path, createHash('sha256').update(value).digest('hex')])),
  }));
  return root;
}
function verify(root: string) {
  return spawnSync(process.execPath, [resolve('scripts/deploy/main-repairs-guard.mjs'), '--runtime', root], { encoding: 'utf8' });
}
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('main repair deployment identity', () => {
  it('accepts a coherent main protocol build', () => {
    const result = verify(fixture());
    expect(result.status, result.stderr).toBe(0);
  });
  it('blocks a fork browser implementation even when its manifest hashes match', () => {
    const result = verify(fixture({ 'server/services/checkinService.js': 'executeAnyRouterBrowserVisitCheckin' }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('protocol');
  });
  it('blocks stale files copied over a signed source snapshot', () => {
    const root = fixture();
    writeFileSync(join(root, 'dist/server/services/accountUpdateWorkflow.js'), 'startBackgroundTask; stale build');
    const result = verify(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('hash mismatch');
  });
  it('blocks leftover fork-only modules', () => {
    const result = verify(fixture({ 'server/services/anyRouterBrowserVisitCheckinService.js': 'old browser code' }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('browser');
  });
  it('blocks an unlisted extra build artifact', () => {
    const root = fixture();
    writeFileSync(join(root, 'dist/server/stale.js'), 'stale artifact');
    const result = verify(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('artifact list');
  });
});

function sourceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'metapi-source-guard-'));
  fixtures.push(root);
  const result = spawnSync('git', ['clone', '--quiet', '--shared', '--no-hardlinks', resolve('.'), root], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return root;
}
function verifySource(root: string) {
  return spawnSync(process.execPath, [resolve('scripts/deploy/main-repairs-guard.mjs'), '--source', root], { encoding: 'utf8' });
}
describe('committed release sources', () => {
  it('accepts committed repairs while ignoring local credentials', () => {
    const root = sourceFixture();
    writeFileSync(join(root, '.env'), 'AUTH_TOKEN=fixture-only\n');
    const result = verifySource(root);
    expect(result.status, result.stderr).toBe(0);
  });
  it('blocks uncommitted tracked repairs', () => {
    const root = sourceFixture();
    writeFileSync(join(root, 'src/server/services/checkinService.ts'), '// changed\nexecuteAgentRouterOauthRelogin');
    const result = verifySource(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('uncommitted');
  });
  it('blocks untracked source files instead of packaging them silently', () => {
    const root = sourceFixture();
    writeFileSync(join(root, 'src/accidental-runtime.ts'), 'export const stale = true;');
    const result = verifySource(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('uncommitted');
  });
});

function exportedSource(root: string) {
  const exported = mkdtempSync(join(tmpdir(), 'metapi-export-guard-'));
  fixtures.push(exported);
  const archive = spawnSync('git', ['archive', 'HEAD'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  expect(archive.status).toBe(0);
  const unpack = spawnSync('tar', ['-x', '-C', exported], { input: archive.stdout });
  expect(unpack.status).toBe(0);
  cpSync(join(fixture(), 'dist'), join(exported, 'dist'), { recursive: true });
  return exported;
}
describe('isolated Git exports', () => {
  it('binds an exported build to the exact committed source, not a guessed revision', () => {
    const root = sourceFixture();
    const exported = exportedSource(root);
    const result = spawnSync(process.execPath, [resolve('scripts/deploy/main-repairs-guard.mjs'), '--write-manifest', exported, root], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(exported, 'main-repairs-manifest.json'), 'utf8'));
    expect(manifest.sourceCommit).toBe(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim());
  });
  it('detects source tampering inside an export before signing its manifest', () => {
    const root = sourceFixture();
    const exported = exportedSource(root);
    writeFileSync(join(exported, 'src/server/services/checkinService.ts'), 'executeAgentRouterOauthRelogin; // replaced export');
    const result = spawnSync(process.execPath, [resolve('scripts/deploy/main-repairs-guard.mjs'), '--write-manifest', exported, root], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('export differs');
  });
});
