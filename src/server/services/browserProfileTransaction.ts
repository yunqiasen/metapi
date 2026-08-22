import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export type BrowserProfileCommit = {
  profileDir: string;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
};

export async function commitBrowserProfileReplacement(
  stagedProfileDir: string,
  formalProfileDir: string,
): Promise<BrowserProfileCommit> {
  await access(stagedProfileDir);
  const backupProfileDir = `${formalProfileDir}.backup-${randomUUID()}`;
  const hadFormalProfile = existsSync(formalProfileDir);
  let installed = false;
  try {
    await mkdir(dirname(formalProfileDir), { recursive: true });
    if (hadFormalProfile) await rename(formalProfileDir, backupProfileDir);
    await rename(stagedProfileDir, formalProfileDir);
    installed = true;
  } catch (error) {
    if (hadFormalProfile && existsSync(backupProfileDir) && !existsSync(formalProfileDir)) {
      await rename(backupProfileDir, formalProfileDir).catch(() => {});
    }
    throw error;
  }

  let settled = false;
  return {
    profileDir: formalProfileDir,
    async rollback() {
      if (settled) return;
      settled = true;
      if (installed) await rm(formalProfileDir, { recursive: true, force: true });
      if (hadFormalProfile && existsSync(backupProfileDir)) {
        await rename(backupProfileDir, formalProfileDir);
      }
    },
    async finalize() {
      if (settled) return;
      settled = true;
      await rm(backupProfileDir, { recursive: true, force: true });
    },
  };
}
