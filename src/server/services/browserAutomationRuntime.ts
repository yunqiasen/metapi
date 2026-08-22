import { randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { launchPersistentContext } from 'cloakbrowser';

export type ChromiumBrowserType = typeof chromium;
export type CloakPersistentContextLauncher = typeof launchPersistentContext;
export type CloakPersistentContextOptions = Parameters<CloakPersistentContextLauncher>[0];

const CLOAK_FINGERPRINT_FILE = '.metapi-cloak-fingerprint';
const CLOAK_FINGERPRINT_MIN = 10_000;
const CLOAK_FINGERPRINT_MAX_EXCLUSIVE = 100_000;

function parseFingerprintSeed(raw: string): number | null {
  const seed = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(seed) && seed >= CLOAK_FINGERPRINT_MIN && seed < CLOAK_FINGERPRINT_MAX_EXCLUSIVE
    ? seed
    : null;
}

export async function resolvePersistentBrowserFingerprintSeed(profileDir: string): Promise<number> {
  await mkdir(profileDir, { recursive: true });
  const markerPath = join(profileDir, CLOAK_FINGERPRINT_FILE);
  const existing = await readFile(markerPath, 'utf8').then(parseFingerprintSeed).catch(() => null);
  if (existing) return existing;

  const generated = randomInt(CLOAK_FINGERPRINT_MIN, CLOAK_FINGERPRINT_MAX_EXCLUSIVE);
  try {
    await writeFile(markerPath, String(generated), { encoding: 'utf8', flag: 'wx' });
    return generated;
  } catch {
    const raced = await readFile(markerPath, 'utf8').then(parseFingerprintSeed).catch(() => null);
    if (raced) return raced;
    await writeFile(markerPath, String(generated), 'utf8');
    return generated;
  }
}

export async function loadChromiumBrowserType(): Promise<ChromiumBrowserType> {
  return chromium;
}

export async function loadCloakPersistentContextLauncher(): Promise<CloakPersistentContextLauncher> {
  return launchPersistentContext;
}

export function buildCloakPersistentContextOptions(input: {
  profileDir: string;
  display: string;
  proxyUrl?: string;
  fingerprintSeed?: number;
}): CloakPersistentContextOptions {
  const proxyUrl = input.proxyUrl?.trim();
  const fingerprintSeed = input.fingerprintSeed;
  return {
    userDataDir: input.profileDir,
    headless: false,
    ...(proxyUrl ? { proxy: proxyUrl } : {}),
    humanize: true,
    humanPreset: 'careful',
    locale: 'zh-CN',
    viewport: null,
    args: [
      ...(Number.isInteger(fingerprintSeed) ? [`--fingerprint=${fingerprintSeed}`] : []),
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--password-store=basic',
      '--use-mock-keychain',
      '--window-size=1280,900',
    ],
    launchOptions: {
      env: {
        ...process.env,
        DISPLAY: input.display,
      },
    },
  };
}
