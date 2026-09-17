import { afterEach, expect, it } from 'vitest';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('builds in a disposable Git export and cleans it on failure without moving the local dist', () => {
  const root = mkdtempSync(join(tmpdir(), 'metapi-build-script-'));
  fixtures.push(root);
  expect(spawnSync('git', ['clone', '--quiet', '--shared', resolve('.'), root]).status).toBe(0);
  for (const file of ['build-main-repairs.sh', 'main-repairs-guard.mjs']) cpSync(resolve('scripts/deploy', file), join(root, 'scripts/deploy', file));
  expect(spawnSync('git', ['add', 'scripts/deploy'], { cwd: root }).status).toBe(0);
  expect(spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'test build tooling'], { cwd: root }).status).toBe(0);
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist/sentinel.txt'), 'keep existing output');
  mkdirSync(join(root, 'node_modules')); // npm is the failing build boundary in this fixture.
  const temp = join(root, 'tmp');
  const bin = join(temp, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nmkdir -p dist\nprintf partial > dist/partial\nexit 41\n');
  chmodSync(join(bin, 'npm'), 0o700);
  const result = spawnSync('bash', [join(root, 'scripts/deploy/build-main-repairs.sh')], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temp, MAIN_REPAIRS_BACKUP_DIR: join(temp, 'legacy-backup') },
  });
  expect(result.status, result.stderr).toBe(41);
  expect(existsSync(join(root, 'dist/sentinel.txt'))).toBe(true);
  expect(existsSync(join(root, 'dist/partial'))).toBe(false);
  expect(readdirSync(temp).filter((name) => name.startsWith('metapi-release-'))).toEqual([]);
});
