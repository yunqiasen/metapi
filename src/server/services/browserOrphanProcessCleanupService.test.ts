import { describe, expect, it } from 'vitest';
import { isManagedBrowserProcessCommand } from './browserOrphanProcessCleanupService.js';

describe('browser orphan process cleanup', () => {
  it('matches only Chromium processes owned by Metapi browser profile roots', () => {
    const dataDir = '/app/data';
    expect(isManagedBrowserProcessCommand('/usr/lib/chromium/chromium\0--user-data-dir=/app/data/target-site-auth-profiles/9/state\0', dataDir)).toBe(true);
    expect(isManagedBrowserProcessCommand('/usr/lib/chromium/chromium\0--user-data-dir=/app/data/site-auth-working-profiles/linuxdo\0', dataDir)).toBe(true);
    expect(isManagedBrowserProcessCommand('/usr/lib/chromium/chromium\0--user-data-dir=/app/data/browser-profiles/accounts/anyrouter/92\0', dataDir)).toBe(true);
    expect(isManagedBrowserProcessCommand('/usr/bin/google-chrome-stable\0--user-data-dir=/app/data/browser-profiles/accounts/anyrouter/92\0', dataDir)).toBe(true);
    expect(isManagedBrowserProcessCommand('/opt/google/chrome/chrome\0--user-data-dir\0/app/data/target-site-auth-profiles/9/state\0', dataDir)).toBe(true);
    expect(isManagedBrowserProcessCommand('/usr/lib/chromium/chromium\0--user-data-dir=/tmp/unrelated-profile\0', dataDir)).toBe(false);
    expect(isManagedBrowserProcessCommand('node\0server.js\0/app/data/target-site-auth-profiles\0', dataDir)).toBe(false);
    expect(isManagedBrowserProcessCommand('/usr/bin/google-chrome-stable\0--note=/app/data/target-site-auth-profiles/9/state\0', dataDir)).toBe(false);
    expect(isManagedBrowserProcessCommand('/usr/bin/chromium-helper\0--user-data-dir=/app/data/target-site-auth-profiles/9/state\0', dataDir)).toBe(false);
  });
});
