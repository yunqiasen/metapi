import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
const cli = resolve('scripts/deploy/metapictl.mjs');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'metapi-maintenance-test-'));
  roots.push(root);
  const configDir = join(root, 'config');
  const dataDir = join(root, 'data');
  const backupDir = join(root, 'backups');
  mkdirSync(configDir, { mode: 0o700 });
  mkdirSync(dataDir);
  mkdirSync(backupDir);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ sourceDir: root, dataDir, backupDir }));
  writeFileSync(join(configDir, 'app.env'), 'AUTH_TOKEN=fixture-only-not-a-real-token\n');
  writeFileSync(join(configDir, 'compose.yml'), 'services: {}\n');
  writeFileSync(join(configDir, 'release.json'), JSON.stringify({ current: { image: 'metapi:test-only' }, previous: null }));
  writeFileSync(join(configDir, 'backup.key'), Buffer.alloc(32, 17), { mode: 0o600 });
  const db = spawnSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE accounts(id INTEGER PRIMARY KEY, name TEXT)"); c.execute("INSERT INTO accounts VALUES(27, ?)", ("preserved",)); c.commit(); c.close()', join(dataDir, 'hub.db')]);
  expect(db.status).toBe(0);
  const env = { ...process.env };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, '--config-dir', configDir, ...args], { encoding: 'utf8', env });
  return { root, configDir, dataDir, backupDir, run, env };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('branch-independent Metapi backups', () => {
  it('round-trips SQLite and credentials without plaintext archives or production writes', () => {
    const f = fixture();
    const before = readFileSync(join(f.dataDir, 'hub.db'));
    const result = f.run('backup', 'daily');
    expect(result.status, result.stderr).toBe(0);
    const archives = readdirSync(f.backupDir);
    expect(archives).toHaveLength(1);
    const archive = join(f.backupDir, archives[0]);
    expect(readFileSync(archive).includes(Buffer.from('fixture-only-not-a-real-token'))).toBe(false);
    expect(statSync(archive).mode & 0o777).toBe(0o600);
    expect(result.stdout).not.toContain('fixture-only-not-a-real-token');
    const output = join(f.root, 'restored');
    const exported = f.run('export', archive, output);
    expect(exported.status, exported.stderr).toBe(0);
    expect(readFileSync(join(output, 'app.env'), 'utf8')).toBe(readFileSync(join(f.configDir, 'app.env'), 'utf8'));
    const query = spawnSync('python3', ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT name FROM accounts WHERE id=27").fetchone()[0])', join(output, 'hub.db')], { encoding: 'utf8' });
    expect(query.stdout.trim()).toBe('preserved');
    expect(readFileSync(join(f.dataDir, 'hub.db'))).toEqual(before);
  });

  it('detects modified ciphertext before creating any restored files', () => {
    const f = fixture();
    expect(f.run('backup', 'daily').status).toBe(0);
    const archive = join(f.backupDir, readdirSync(f.backupDir)[0]);
    const bytes = readFileSync(archive);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(archive, bytes);
    const output = join(f.root, 'corrupt-output');
    expect(f.run('export', archive, output).status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });

  it('exports only to a new directory and leaves the live database untouched', () => {
    const f = fixture();
    const before = readFileSync(join(f.dataDir, 'hub.db'));
    expect(f.run('backup', 'daily').status).toBe(0);
    const archive = join(f.backupDir, readdirSync(f.backupDir)[0]);
    const result = f.run('export', archive, f.dataDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('new directory');
    expect(readFileSync(join(f.dataDir, 'hub.db'))).toEqual(before);
  });

  it('keeps seven daily snapshots and two release snapshots without touching other archives', () => {
    const f = fixture();
    writeFileSync(join(f.backupDir, 'migration-protected.bundle'), 'keep');
    for (let n = 0; n < 9; n++) expect(f.run('backup', 'daily').status).toBe(0);
    for (let n = 0; n < 3; n++) expect(f.run('backup', 'release').status).toBe(0);
    const files = readdirSync(f.backupDir);
    expect(files.filter((name) => name.startsWith('daily-'))).toHaveLength(7);
    expect(files.filter((name) => name.startsWith('release-'))).toHaveLength(2);
    expect(readFileSync(join(f.backupDir, 'migration-protected.bundle'), 'utf8')).toBe('keep');
  });

  it('does not delete older backups or leave plaintext when SQLite validation fails', () => {
    const f = fixture();
    expect(f.run('backup', 'daily').status).toBe(0);
    const before = readdirSync(f.backupDir);
    writeFileSync(join(f.dataDir, 'hub.db'), 'not a database');
    const result = f.run('backup', 'daily');
    expect(result.status).not.toBe(0);
    expect(readdirSync(f.backupDir)).toEqual(before);
  });
});

function dockerFixture(options: { schemaChange?: boolean; failTarget?: boolean; wrongFlavor?: boolean } = {}) {
  const f = fixture();
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const makeImage = (name: string, letter: string, schema: string) => {
    const sourceFiles = { 'drizzle/0000.sql': digest(schema), 'src/server/index.ts': digest(name) };
    const sourceTreeSha256 = digest(JSON.stringify(sourceFiles));
    const manifest = { flavor: 'main-with-local-repairs', baseline: '41767a65ec8e5470a9a70f4615b47dc24949afff', sourceCommit: letter.repeat(40), sourceTreeSha256, sourceFiles };
    const record = { image: `metapi:${name}`, imageId: `sha256:${letter.repeat(64)}`, commit: manifest.sourceCommit, sourceTree: sourceTreeSha256, schemaTree: digest(JSON.stringify([['drizzle/0000.sql', digest(schema)]])) };
    return { record, manifest, labels: { 'io.metapi.flavor': manifest.flavor, 'io.metapi.source-tree': sourceTreeSha256, 'org.opencontainers.image.revision': manifest.sourceCommit } };
  };
  const oldImage = makeImage('before', 'a', 'schema-v1');
  const nextImage = makeImage('next', 'b', options.schemaChange ? 'schema-v2' : 'schema-v1');
  if (options.wrongFlavor) nextImage.labels['io.metapi.flavor'] = 'legacy-fork';
  const statePath = join(f.root, 'docker-state.json');
  const state = { current: oldImage.record.imageId, images: [oldImage, nextImage], dataDir: f.dataDir, backups: f.backupDir, failTarget: options.failTarget, actions: [] as any[] };
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(join(f.configDir, 'release.json'), JSON.stringify({ current: oldImage.record, previous: null }));
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const path = process.env.METAPI_DOCKER_FIXTURE;
const state = JSON.parse(fs.readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
function output(value) { console.log(JSON.stringify(value)); }
const imageFor = (id) => state.images.find(i => i.record.image === id || i.record.imageId === id);
if (args[0] === 'image' && args[1] === 'inspect') {
 const image = imageFor(args[2]); output([{Id:image.record.imageId,Config:{Labels:image.labels}}]);
} else if (args[0] === 'inspect') {
 output([{Image:state.current,Config:{Image:state.current},State:{Status:'running',Health:{Status:state.failTarget && state.current===state.images[1].record.imageId?'unhealthy':'healthy'}},Mounts:[{Destination:'/app/data',Source:state.dataDir}],NetworkSettings:{Ports:{'4000/tcp':[{HostPort:'4010'}]}}}]);
} else if (args[0] === 'run') {
 const image = state.images.find(i => args.includes(i.record.imageId));
 if (args.includes('cat')) output(image.manifest);
} else if (args[0] === 'compose') {
 state.current = process.env.METAPI_IMAGE;
 state.actions.push({image:state.current,backups:fs.readdirSync(state.backups).filter(n=>n.endsWith('.metapi')).length});
 fs.writeFileSync(path,JSON.stringify(state));
 if (state.failTarget && state.current===state.images[1].record.imageId) {console.error('fixture health failure');process.exit(1);}
} else { console.error('unexpected docker command');process.exit(2); }
`);
  chmodSync(join(bin, 'docker'), 0o700);
  f.env.PATH = `${bin}:${process.env.PATH}`;
  f.env.METAPI_DOCKER_FIXTURE = statePath;
  return { ...f, oldImage, nextImage, statePath, state: () => JSON.parse(readFileSync(statePath, 'utf8')) };
}

describe('guarded release switching', () => {
  it('backs up before switching an immutable image and saves the prior release', () => {
    const f = dockerFixture();
    const result = f.run('deploy', f.nextImage.record.image);
    expect(result.status, result.stderr).toBe(0);
    const release = JSON.parse(readFileSync(join(f.configDir, 'release.json'), 'utf8'));
    expect(release.current.imageId).toBe(f.nextImage.record.imageId);
    expect(release.previous.imageId).toBe(f.oldImage.record.imageId);
    expect(f.state().actions).toEqual([{ image: f.nextImage.record.imageId, backups: 1 }]);
  });
  it('restores the previous image after failed health checks, never an old database', () => {
    const f = dockerFixture({ failTarget: true });
    const before = readFileSync(join(f.dataDir, 'hub.db'));
    const result = f.run('deploy', f.nextImage.record.image);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('previous image restored');
    expect(f.state().current).toBe(f.oldImage.record.imageId);
    const release = JSON.parse(readFileSync(join(f.configDir, 'release.json'), 'utf8'));
    expect(release.current.imageId).toBe(f.oldImage.record.imageId);
    expect(readFileSync(join(f.dataDir, 'hub.db'))).toEqual(before);
  });
  it.each([{ schemaChange: true, error: 'database' }, { wrongFlavor: true, error: 'flavor' }])('stops incompatible or legacy images before any service change: $error', (options) => {
    const f = dockerFixture(options);
    const result = f.run('deploy', f.nextImage.record.image);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(options.error);
    expect(f.state().actions).toEqual([]);
    expect(readdirSync(f.backupDir)).toEqual([]);
  });
  it('stops when the running image differs from the release record', () => {
    const f = dockerFixture();
    const state = f.state();
    state.current = 'sha256:unexpected';
    writeFileSync(f.statePath, JSON.stringify(state));
    const result = f.run('deploy', f.nextImage.record.image);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('running image');
    expect(f.state().actions).toEqual([]);
  });
});

it('rolls back using the immutable previous image even when no source checkout is available', () => {
  const f = dockerFixture();
  const before = readFileSync(join(f.dataDir, 'hub.db'));
  expect(f.run('deploy', f.nextImage.record.image).status).toBe(0);
  const configPath = join(f.configDir, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.sourceDir = join(f.root, 'no-checkout');
  writeFileSync(configPath, JSON.stringify(config));
  const result = f.run('rollback');
  expect(result.status, result.stderr).toBe(0);
  expect(f.state().current).toBe(f.oldImage.record.imageId);
  const release = JSON.parse(readFileSync(join(f.configDir, 'release.json'), 'utf8'));
  expect(release.current.imageId).toBe(f.oldImage.record.imageId);
  expect(release.previous.imageId).toBe(f.nextImage.record.imageId);
  expect(readFileSync(join(f.dataDir, 'hub.db'))).toEqual(before);
});

it('reports actual runtime identity without depending on the source branch or exposing configuration', () => {
  const f = dockerFixture();
  const result = f.run('status');
  expect(result.status, result.stderr).toBe(0);
  const status = JSON.parse(result.stdout);
  expect(status.imageMatchesRecord).toBe(true);
  expect(status.health).toBe('healthy');
  expect(status.sourceMatchesRelease).toBe(false);
  expect(result.stdout).not.toContain('fixture-only-not-a-real-token');
  expect(f.state().actions).toEqual([]);
});
