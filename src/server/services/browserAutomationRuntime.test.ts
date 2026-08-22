import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromium as playwrightChromium } from 'playwright-core';
import {
  buildCloakPersistentContextOptions,
  loadChromiumBrowserType,
  loadCloakPersistentContextLauncher,
  resolvePersistentBrowserFingerprintSeed,
} from './browserAutomationRuntime.js';

describe('browser automation runtime', () => {
  it('uses the installed playwright-core runtime by default', async () => {
    await expect(loadChromiumBrowserType()).resolves.toBe(playwrightChromium);
  });

  it('loads CloakBrowser persistent contexts for shielded login targets', async () => {
    await expect(loadCloakPersistentContextLauncher()).resolves.toEqual(expect.any(Function));
  });

  it('builds a headed persistent profile on the shared noVNC display', () => {
    const options = buildCloakPersistentContextOptions({
      profileDir: '/tmp/profile-a',
      display: ':99',
      proxyUrl: 'http://proxy:8080',
      fingerprintSeed: 44122,
    });
    expect(options).toMatchObject({
      userDataDir: '/tmp/profile-a',
      headless: false,
      proxy: 'http://proxy:8080',
      humanize: true,
      humanPreset: 'careful',
      locale: 'zh-CN',
      viewport: null,
      launchOptions: {
        env: expect.objectContaining({ DISPLAY: ':99' }),
      },
    });
    expect(options.args).toContain('--fingerprint=44122');
  });

  it('keeps the same fingerprint seed when a persistent profile is copied for reauthentication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metapi-browser-fingerprint-'));
    const formalProfile = join(root, '94');
    const stagedProfile = join(root, 'reauth-94');

    const firstSeed = await resolvePersistentBrowserFingerprintSeed(formalProfile);
    await cp(formalProfile, stagedProfile, { recursive: true });
    const stagedSeed = await resolvePersistentBrowserFingerprintSeed(stagedProfile);
    const nextFormalSeed = await resolvePersistentBrowserFingerprintSeed(formalProfile);

    expect(firstSeed).toBeGreaterThanOrEqual(10_000);
    expect(firstSeed).toBeLessThanOrEqual(99_999);
    expect(stagedSeed).toBe(firstSeed);
    expect(nextFormalSeed).toBe(firstSeed);
  });
});
