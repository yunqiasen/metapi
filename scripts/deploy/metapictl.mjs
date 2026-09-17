#!/usr/bin/env node
// Installed outside the Git worktree so checkout never changes the running service.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const MAGIC = Buffer.from('METAPI1\n');
const CONFIG_FILES = ['app.env', 'compose.yml', 'config.json', 'release.json'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr?.trim() || result.status}`);
  return result.stdout.trim();
}
function atomicWrite(path, content) {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}
export function loadConfig(configDir) {
  configDir = resolve(configDir);
  const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  for (const key of ['sourceDir', 'dataDir', 'backupDir']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw new Error(`${key} must be an absolute path`);
    config[key] = resolve(config[key]);
  }
  return { ...config, configDir };
}
export function seal(plain, key) {
  if (key.length !== 32) throw new Error('backup.key must contain 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}
export function unseal(bytes, key) {
  if (bytes.length < 36 || !bytes.subarray(0, 8).equals(MAGIC)) throw new Error('invalid backup format');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(8, 20));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(bytes.subarray(20, 36));
  return Buffer.concat([decipher.update(bytes.subarray(36)), decipher.final()]);
}
function checkDatabase(path) {
  run('python3', ['-c', 'import sqlite3,sys,pathlib; c=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True); r=c.execute("PRAGMA integrity_check").fetchall(); c.close(); assert r==[("ok",)],r', path]);
}
function snapshotDatabase(source, target) {
  run('python3', ['-c', 'import sqlite3,sys,pathlib; a=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True); b=sqlite3.connect(sys.argv[2]); a.backup(b); b.close(); a.close()', source, target]);
  chmodSync(target, 0o600);
  checkDatabase(target);
}
export function backup(config, kind) {
  if (!['daily', 'release'].includes(kind)) throw new Error('backup kind must be daily or release');
  const key = readFileSync(join(config.configDir, 'backup.key'));
  mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(config.backupDir, '.snapshot-'));
  chmodSync(temp, 0o700);
  try {
    snapshotDatabase(join(config.dataDir, 'hub.db'), join(temp, 'hub.db'));
    const files = { 'hub.db': readFileSync(join(temp, 'hub.db')).toString('base64') };
    for (const name of CONFIG_FILES) files[name] = readFileSync(join(config.configDir, name)).toString('base64');
    const packed = gzipSync(Buffer.from(JSON.stringify({ version: 1, createdAt: new Date().toISOString(), files })));
    const encrypted = seal(packed, key);
    if (!unseal(encrypted, key).equals(packed)) throw new Error('encrypted backup verification failed');
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    const path = join(config.backupDir, `${kind}-${stamp}.metapi`);
    atomicWrite(path, encrypted);
    // Retention starts only after the new snapshot passes integrity and authentication checks.
    const pattern = new RegExp(`^${kind}-[0-9]{8}T[0-9]{9}Z\\.metapi$`);
    const previous = readdirSync(config.backupDir, { withFileTypes: true }).filter((entry) => entry.isFile() && pattern.test(entry.name)).map((entry) => entry.name).sort().reverse();
    for (const name of previous.slice(kind === 'daily' ? 7 : 2)) rmSync(join(config.backupDir, name));
    return path;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
export function exportBackup(config, archive, destination) {
  destination = resolve(destination);
  if (existsSync(destination) || [config.dataDir, config.configDir].some((base) => destination === base || destination.startsWith(base + sep))) {
    throw new Error('export requires a new directory outside live data and configuration');
  }
  const packed = unseal(readFileSync(archive), readFileSync(join(config.configDir, 'backup.key')));
  const payload = JSON.parse(gunzipSync(packed).toString('utf8'));
  const names = ['hub.db', ...CONFIG_FILES].sort();
  if (payload.version !== 1 || JSON.stringify(Object.keys(payload.files || {}).sort()) !== JSON.stringify(names)) throw new Error('invalid backup payload');
  mkdirSync(destination, { mode: 0o700 });
  try {
    for (const name of names) writeFileSync(join(destination, name), Buffer.from(payload.files[name], 'base64'), { mode: 0o600, flag: 'wx' });
    checkDatabase(join(destination, 'hub.db'));
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
  return destination;
}
function withLock(config, task) {
  const path = join(config.configDir, 'operation.lock');
  const descriptor = openSync(path, 'wx', 0o600);
  try { writeFileSync(descriptor, String(process.pid)); return task(); }
  finally { closeSync(descriptor); rmSync(path, { force: true }); }
}
function readRelease(config) {
  return JSON.parse(readFileSync(join(config.configDir, 'release.json'), 'utf8'));
}
function containerInfo() { return JSON.parse(run('docker', ['inspect', 'metapi-main']))[0]; }
function verifyRunning(config, record) {
  const container = containerInfo();
  if (container.Image !== record.imageId) throw new Error('running image differs from the release record; inspect before switching');
  if (container.State.Status !== 'running' || container.State.Health?.Status !== 'healthy') throw new Error('runtime health check failed');
  if (!container.Mounts.some((mount) => mount.Destination === '/app/data' && resolve(mount.Source) === config.dataDir)) throw new Error('production data mount differs');
  if (!container.NetworkSettings.Ports?.['4000/tcp']?.some((port) => port.HostPort === '4010')) throw new Error('production port differs');
  return container;
}
export function inspectImage(image) {
  const info = JSON.parse(run('docker', ['image', 'inspect', image]))[0];
  const labels = info.Config.Labels || {};
  if (labels['io.metapi.flavor'] !== 'main-with-local-repairs') throw new Error('image flavor is not main-with-local-repairs');
  const runtimeArgs = ['run', '--rm', '--network', 'none', '--read-only', '--entrypoint'];
  run('docker', [...runtimeArgs, 'node', info.Id, 'scripts/deploy/main-repairs-guard.mjs', '--runtime', '/app']);
  const manifest = JSON.parse(run('docker', [...runtimeArgs, 'cat', info.Id, '/app/main-repairs-manifest.json']));
  if (manifest.flavor !== labels['io.metapi.flavor'] || manifest.sourceTreeSha256 !== labels['io.metapi.source-tree'] || manifest.sourceTreeSha256 !== hash(JSON.stringify(manifest.sourceFiles))) throw new Error('image source manifest mismatch');
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit) || manifest.sourceCommit !== labels['org.opencontainers.image.revision']) throw new Error('image commit label mismatch');
  const schema = Object.entries(manifest.sourceFiles).filter(([path]) => path.startsWith('drizzle/') || path.startsWith('src/server/db/')).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (!schema.length) throw new Error('database schema manifest is missing');
  return { image, imageId: info.Id, commit: manifest.sourceCommit, sourceTree: manifest.sourceTreeSha256, schemaTree: hash(JSON.stringify(schema)) };
}
function composeUp(config, record) {
  run('docker', ['compose', '--env-file', '/dev/null', '--project-directory', config.configDir, '-p', 'metapi-main-deploy', '-f', join(config.configDir, 'compose.yml'), 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90', 'metapi-main'], {
    env: { ...process.env, METAPI_IMAGE: record.imageId, METAPI_DATA_DIR: config.dataDir },
  });
  verifyRunning(config, record);
}
export function deploy(config, image) {
  const before = readRelease(config);
  verifyRunning(config, before.current);
  const target = inspectImage(image);
  if (target.schemaTree !== before.current.schemaTree) throw new Error('database code/schema differs; prepare a separate data migration before deploying');
  const backupPath = backup(config, 'release');
  const pending = join(config.configDir, 'release.pending.json');
  atomicWrite(pending, JSON.stringify({ before, target, backupPath, startedAt: new Date().toISOString() }, null, 2) + '\n');
  try {
    composeUp(config, target);
    const previous = target.imageId === before.current.imageId ? before.previous : before.current;
    atomicWrite(join(config.configDir, 'release.json'), JSON.stringify({ current: target, previous, deployedAt: new Date().toISOString(), backupPath }, null, 2) + '\n');
    rmSync(pending);
    return target;
  } catch (error) {
    try { composeUp(config, before.current); rmSync(pending, { force: true }); }
    catch (rollbackError) { throw new Error(`deployment failed: ${error.message}; previous image startup also failed: ${rollbackError.message}; inspect release.pending.json`); }
    throw new Error(`deployment failed: ${error.message}; previous image restored, current database retained`);
  }
}
function status(config) {
  const release = readRelease(config);
  const running = containerInfo();
  const git = (...args) => {
    const result = spawnSync('git', ['-C', config.sourceDir, ...args], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const commit = git('rev-parse', 'HEAD');
  return { sourceDir: config.sourceDir, branch: git('branch', '--show-current'), commit, sourceDirty: Boolean(git('status', '--porcelain')), image: release.current.image, imageId: running.Image, releaseCommit: release.current.commit, imageMatchesRecord: running.Image === release.current.imageId, sourceMatchesRelease: commit === release.current.commit || commit === release.current.savedCommit, health: running.State.Health?.Status || running.State.Status, dataDir: config.dataDir, port: 4010, pendingRelease: existsSync(join(config.configDir, 'release.pending.json')) };
}
function main(args) {
  const configDir = args[0] === '--config-dir' ? args.splice(0, 2)[1] : join(homedir(), '.config/metapi');
  const config = loadConfig(configDir);
  const [command, ...rest] = args;
  if (command === 'backup') console.log(`Backup verified: ${withLock(config, () => backup(config, rest[0] || 'daily'))}`);
  else if (command === 'export' && rest.length === 2) console.log(`Export verified: ${exportBackup(config, rest[0], rest[1])}`);
  else if (command === 'status') console.log(JSON.stringify(status(config), null, 2));
  else if (command === 'deploy' && rest.length === 1) console.log(`Deployed: ${withLock(config, () => deploy(config, rest[0])).image}`);
  else if (command === 'rollback') {
    const previous = readRelease(config).previous;
    if (!previous) throw new Error('no previous release recorded');
    console.log(`Deployed: ${withLock(config, () => deploy(config, previous.imageId)).image}`);
  }
  else throw new Error('usage: metapictl status | backup [daily|release] | export ARCHIVE NEW_DIRECTORY | deploy IMAGE | rollback');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`metapictl: ${error.message}`); process.exitCode = 1; }
}
