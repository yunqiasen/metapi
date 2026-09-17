#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const BASELINE = '41767a65ec8e5470a9a70f4615b47dc24949afff';
const OLD_FORK = '920d20ad0520d653fa0c797317a44e77c4bd9c3e';
const FLAVOR = 'main-with-local-repairs';
const forbidden = /(?:anyRouterBrowserVisitCheckin|anyRouterSessionBrowserVerification|agentRouterReloginBrowser|agentRouterReloginCheckinService|accountManagedBrowserLogin|anyRouterProxyRoute|siteAuthService)/i;
const required = {
  'server/services/checkinService': 'executeAgentRouterOauthRelogin',
  'server/services/agentRouterOauthReloginService': 'executeAgentRouterOauthRelogin',
  'server/services/accountUpdateWorkflow': 'startBackgroundTask',
  'server/services/platforms/newApiShield': 'normalizeNewApiCredential',
  'server/services/platforms/newApi': 'credentialMode',
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
function filesUnder(root) {
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`unexpected symlink: ${relative(root, path)}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path));
    }
  }
  visit(root);
  return files.sort();
}
function verifyProtocol(root, source = false) {
  const tree = join(root, source ? 'src' : 'dist');
  const extension = source ? '.ts' : '.js';
  const files = filesUnder(tree);
  const leftover = files.find((path) => forbidden.test(path));
  if (leftover) throw new Error(`fork browser module: ${leftover}`);
  for (const [path, marker] of Object.entries(required)) {
    const content = readFileSync(join(tree, path + extension), 'utf8');
    if (!content.includes(marker) || forbidden.test(content)) {
      throw new Error(`main protocol identity mismatch: ${path}`);
    }
  }
  if (!source && !existsSync(join(tree, 'web/index.html'))) throw new Error('missing web entry');
}
function verifySource(root) {
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
  if (realpathSync(gitRoot) !== realpathSync(root)) throw new Error('build root is not the main worktree');
  execFileSync('git', ['merge-base', '--is-ancestor', BASELINE, 'HEAD'], { cwd: root });
  if (spawnSync('git', ['merge-base', '--is-ancestor', OLD_FORK, 'HEAD'], { cwd: root }).status === 0) {
    throw new Error('legacy fork ancestry detected');
  }
  verifyProtocol(root, true);
}
function artifactHashes(root) {
  const dist = join(root, 'dist');
  return Object.fromEntries(filesUnder(dist).map((path) => [path, hash(readFileSync(join(dist, path)))]));
}
function writeManifest(root) {
  verifySource(root);
  verifyProtocol(root);
  const paths = ['src', 'drizzle', 'scripts/deploy'].flatMap((dir) => filesUnder(join(root, dir)).map((path) => `${dir}/${path}`));
  for (const path of ['package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json', 'tsconfig.web.json']) {
    if (existsSync(join(root, path))) paths.push(path);
  }
  paths.sort();
  const sourceFiles = Object.fromEntries(paths.map((path) => [path, hash(readFileSync(join(root, path)))]));
  const manifest = {
    flavor: FLAVOR,
    baseline: BASELINE,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceBranch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceTreeSha256: hash(JSON.stringify(sourceFiles)),
    createdAt: new Date().toISOString(),
    sourceFiles,
    artifacts: artifactHashes(root),
  };
  writeFileSync(join(root, 'main-repairs-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.sourceTreeSha256;
}
function verifyRuntime(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'main-repairs-manifest.json'), 'utf8'));
  if (manifest.flavor !== FLAVOR || manifest.baseline !== BASELINE) throw new Error('main repair manifest identity mismatch');
  verifyProtocol(root);
  const actual = artifactHashes(root);
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(manifest.artifacts || {}).sort())) {
    throw new Error('artifact list mismatch');
  }
  for (const [path, digest] of Object.entries(actual)) {
    if (digest !== manifest.artifacts[path]) throw new Error(`hash mismatch: ${path}`);
  }
  for (const name of ['playwright', 'playwright-core', 'puppeteer', 'puppeteer-core', 'electron']) {
    if (existsSync(join(root, 'node_modules', name))) throw new Error(`unexpected browser dependency: ${name}`);
  }
}
try {
  const [mode, inputRoot] = process.argv.slice(2);
  if (!inputRoot) throw new Error('usage: --source|--write-manifest|--runtime ROOT');
  const root = resolve(inputRoot);
  if (mode === '--source') verifySource(root);
  else if (mode === '--write-manifest') console.log(`source snapshot: ${writeManifest(root)}`);
  else if (mode === '--runtime') verifyRuntime(root);
  else throw new Error('unknown guard mode');
  console.log(`main-repairs guard: OK (${mode})`);
} catch (error) {
  console.error(`main-repairs guard: ${error.message}`);
  process.exitCode = 1;
}
