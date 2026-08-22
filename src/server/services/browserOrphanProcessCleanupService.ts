import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';

const MANAGED_PROFILE_ROOTS = [
  'target-site-auth-profiles',
  'site-auth-working-profiles',
  'browser-profiles/accounts',
] as const;

const BROWSER_EXECUTABLE_NAMES = new Set([
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
]);

function parseCommandArgs(command: string): string[] {
  if (command.includes('\0')) return command.split('\0').filter(Boolean);
  return command.trim().split(/\s+/).filter(Boolean);
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = resolve(candidate);
  const normalizedRoot = resolve(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function readUserDataDir(args: string[]): string {
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg.startsWith('--user-data-dir=')) return arg.slice('--user-data-dir='.length);
    if (arg === '--user-data-dir') return args[index + 1] || '';
  }
  return '';
}

export function isManagedBrowserProcessCommand(command: string, dataDir: string): boolean {
  const args = parseCommandArgs(command);
  if (args.length === 0 || !BROWSER_EXECUTABLE_NAMES.has(basename(args[0] || ''))) return false;
  const userDataDir = readUserDataDir(args);
  if (!userDataDir) return false;
  return MANAGED_PROFILE_ROOTS.some((relativeRoot) => isPathInside(userDataDir, resolve(dataDir, relativeRoot)));
}

async function readManagedBrowserPids(dataDir: string): Promise<number[]> {
  const entries = await readdir('/proc', { withFileTypes: true }).catch(() => []);
  const pids: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number.parseInt(entry.name, 10);
    if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) continue;
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    if (command && isManagedBrowserProcessCommand(command, dataDir)) pids.push(pid);
  }
  return pids;
}

function signalProcesses(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch {}
  }
}

export async function terminateOrphanedBrowserProcesses(dataDir: string): Promise<number> {
  const pids = await readManagedBrowserPids(dataDir);
  if (pids.length === 0) return 0;
  signalProcesses(pids, 'SIGTERM');
  await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  const survivors = await readManagedBrowserPids(dataDir);
  signalProcesses(survivors, 'SIGKILL');
  return pids.length;
}
