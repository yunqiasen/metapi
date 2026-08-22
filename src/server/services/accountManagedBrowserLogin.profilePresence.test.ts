import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasStoredAccountBrowserProfile } from './accountManagedBrowserLogin.js';

describe('managed browser profile presence', () => {
  it('only reports a persisted profile when the concrete directory exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'metapi-profile-presence-'));
    const profileDir = join(root, 'anyrouter', '91');
    mkdirSync(profileDir, { recursive: true });

    expect(hasStoredAccountBrowserProfile({ extraConfig: JSON.stringify({ managedBrowserProfile: { enabled: true, profileDir } }) })).toBe(true);
    expect(hasStoredAccountBrowserProfile({ extraConfig: JSON.stringify({ managedBrowserProfile: { enabled: true, profileDir: join(root, 'missing') } }) })).toBe(false);
    expect(hasStoredAccountBrowserProfile({ extraConfig: JSON.stringify({ managedBrowserProfile: { enabled: true, profileDir: '/app/data/browser-profiles/accounts/anyrouter/<accountId>' } }) })).toBe(false);
    expect(hasStoredAccountBrowserProfile({ extraConfig: JSON.stringify({ managedBrowserProfile: { enabled: true } }) })).toBe(false);
  });
});
