import type { Page, Response } from 'playwright-core';

export type AliyunWafVerification = {
  code: string;
  verified: boolean;
};

export type AliyunSliderTrackPoint = {
  progress: number;
  yOffset: number;
  steps: number;
  delayMs: number;
};

export type AliyunWafChallengeSnapshot = {
  url?: string;
  title?: string;
  bodyText?: string;
  hasSlider?: boolean;
};

export type AliyunWafSliderDriver = {
  drag(): Promise<AliyunWafVerification | null>;
  refresh(): Promise<void>;
};

function asVerificationResult(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function findVerification(raw: unknown, depth = 0): AliyunWafVerification | null {
  if (depth > 8 || raw == null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      return findVerification(JSON.parse(trimmed), depth + 1);
    } catch {
      const match = /["']?VerifyCode["']?\s*[:=]\s*["']([TF]\d{3})["'][\s\S]{0,300}?["']?VerifyResult["']?\s*[:=]\s*(true|false)/i.exec(trimmed)
        || /["']?VerifyResult["']?\s*[:=]\s*(true|false)[\s\S]{0,300}?["']?VerifyCode["']?\s*[:=]\s*["']([TF]\d{3})["']/i.exec(trimmed);
      if (!match) return null;
      const resultFirst = /^\s*["']?VerifyResult/i.test(match[0]);
      return {
        code: String(resultFirst ? match[2] : match[1]).toUpperCase(),
        verified: String(resultFirst ? match[1] : match[2]).toLowerCase() === 'true',
      };
    }
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = findVerification(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof raw !== 'object') return null;

  const object = raw as Record<string, unknown>;
  const codeValue = object.VerifyCode ?? object.verifyCode ?? object.verify_code;
  const resultValue = object.VerifyResult ?? object.verifyResult ?? object.verify_result;
  const verified = asVerificationResult(resultValue);
  if (typeof codeValue === 'string' && codeValue.trim() && verified != null) {
    return { code: codeValue.trim().toUpperCase(), verified };
  }
  for (const value of Object.values(object)) {
    const found = findVerification(value, depth + 1);
    if (found) return found;
  }
  return null;
}

export function parseAliyunWafVerification(raw: unknown): AliyunWafVerification | null {
  return findVerification(raw);
}

export function isAliyunWafChallenge(snapshot: AliyunWafChallengeSnapshot): boolean {
  const text = `${snapshot.title || ''}\n${snapshot.bodyText || ''}`.toLowerCase();
  if (snapshot.hasSlider) return true;
  return /访问验证|为了更好的访问体验|aliyuncaptcha|aliyun captcha|captchatype["'\s:]+sliding|aliyunCaptcha-sliding-slider/i.test(text);
}

export function buildAliyunSliderTrack(): AliyunSliderTrackPoint[] {
  const points: AliyunSliderTrackPoint[] = [];
  let lastProgress = 0;
  for (let index = 1; index <= 48; index += 1) {
    const time = index / 48;
    const eased = time < 0.5
      ? 2 * time * time
      : 1 - ((-2 * time + 2) ** 2) / 2;
    let progress = eased * 0.94;
    if (index === 19 || index === 34) progress = Math.max(0, lastProgress - 0.008);
    const yOffset = -3.8 * Math.sin(Math.PI * time)
      + Math.sin(time * 17) * 0.7
      + Math.sin(time * 41) * 0.28;
    const speedWeight = 0.72 + 0.55 * Math.abs(2 * time - 1);
    points.push({
      progress,
      yOffset,
      steps: 3,
      delayMs: Math.round(18 + ((index * 11) % 17) * speedWeight),
    });
    lastProgress = progress;
  }

  const tail = [
    0.948, 0.958, 0.967, 0.975, 0.982, 0.987,
    0.991, 0.988, 0.993, 0.996, 0.998, 1,
  ];
  tail.forEach((progress, index) => {
    points.push({
      progress,
      yOffset: Math.sin(index * 1.9) * 0.45,
      steps: index === tail.length - 1 ? 3 : 2,
      delayMs: index === tail.length - 1 ? 235 : 48 + ((index * 13) % 39),
    });
  });
  return points;
}

export async function solveAliyunWafSliderWithDriver(
  driver: AliyunWafSliderDriver,
  options: { maxAttempts?: number } = {},
): Promise<AliyunWafVerification & { attempts: number }> {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 3));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const outcome = await driver.drag();
    if (outcome?.verified === true && outcome.code === 'T001') {
      return { ...outcome, attempts: attempt };
    }
    if (attempt < maxAttempts) await driver.refresh();
  }
  throw new Error('agentrouter_waf_slider_failed');
}

function isAliyunVerificationResponse(response: Response): boolean {
  const url = response.url().toLowerCase();
  return url.includes('captcha-open')
    || url.includes('cloudauth-device')
    || url.includes('device.saf')
    || url.includes('aliyuncs.com');
}

async function waitForSlider(page: Page): Promise<void> {
  await page.locator('#aliyunCaptcha-sliding-slider').waitFor({ state: 'visible', timeout: 12_000 });
  await page.locator('#aliyunCaptcha-sliding-body').waitFor({ state: 'visible', timeout: 12_000 });
}

async function dragAliyunSlider(page: Page): Promise<AliyunWafVerification | null> {
  await waitForSlider(page);
  const slider = page.locator('#aliyunCaptcha-sliding-slider');
  const body = page.locator('#aliyunCaptcha-sliding-body');
  const [sliderBox, bodyBox] = await Promise.all([slider.boundingBox(), body.boundingBox()]);
  if (!sliderBox || !bodyBox) throw new Error('agentrouter_waf_slider_missing');

  let settleVerification: ((value: AliyunWafVerification | null) => void) | null = null;
  let settled = false;
  const verification = new Promise<AliyunWafVerification | null>((resolve) => {
    settleVerification = resolve;
  });
  const finish = (value: AliyunWafVerification | null) => {
    if (settled) return;
    settled = true;
    settleVerification?.(value);
  };
  const responseListener = (response: Response) => {
    if (!isAliyunVerificationResponse(response)) return;
    void response.text().then((text) => {
      const parsed = parseAliyunWafVerification(text);
      if (parsed) finish(parsed);
    }).catch(() => {});
  };
  page.on('response', responseListener);

  const startX = sliderBox.x + sliderBox.width / 2;
  const startY = sliderBox.y + sliderBox.height / 2;
  const distance = bodyBox.width - sliderBox.width;
  try {
    for (let index = 0; index < 4; index += 1) {
      await page.mouse.move(
        startX - 22 + index * 6 + Math.sin(index * 2.1) * 4,
        startY - 7 + Math.cos(index * 1.7) * 5,
        { steps: 4 },
      );
      await page.waitForTimeout(45 + index * 17);
    }
    await page.mouse.move(startX, startY, { steps: 7 });
    await page.waitForTimeout(185);
    await page.mouse.down();
    await page.waitForTimeout(146);

    const track = buildAliyunSliderTrack();
    for (let index = 0; index < track.length; index += 1) {
      const point = track[index]!;
      if (index === 48) await page.waitForTimeout(128);
      await page.mouse.move(
        startX + distance * point.progress,
        startY + point.yOffset,
        { steps: point.steps },
      );
      await page.waitForTimeout(point.delayMs);
    }
    await page.mouse.up().catch(() => {});

    const timeout = page.waitForTimeout(8_000).then(() => null);
    const outcome = await Promise.race([verification, timeout]);
    if (outcome) return outcome;

    const challengeStillVisible = await slider.isVisible().catch(() => false);
    if (!challengeStillVisible) {
      const bodyText = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
      if (/"success"\s*:\s*true|当前余额|console/i.test(bodyText)) {
        return { code: 'T001', verified: true };
      }
    }
    return null;
  } finally {
    page.off('response', responseListener);
    finish(null);
  }
}

async function refreshAliyunChallenge(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitForSlider(page);
}

export async function solveAliyunWafSliderPage(
  page: Page,
  options: { maxAttempts?: number } = {},
): Promise<AliyunWafVerification & { attempts: number }> {
  return solveAliyunWafSliderWithDriver({
    drag: () => dragAliyunSlider(page),
    refresh: () => refreshAliyunChallenge(page),
  }, options);
}
