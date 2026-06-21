import type { chromium as playwrightChromium } from 'playwright-core';

export type ChromiumBrowserType = typeof playwrightChromium;

export async function loadChromiumBrowserType(): Promise<ChromiumBrowserType> {
  try {
    const rebrowser = await import('rebrowser-playwright-core');
    if (rebrowser.chromium) return rebrowser.chromium as unknown as ChromiumBrowserType;
  } catch {}
  const playwright = await import('playwright-core');
  return playwright.chromium;
}
