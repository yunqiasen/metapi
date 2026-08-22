import type { Page } from 'playwright-core';

export type LinuxDoCaptchaAutoConfirmResult = {
  clicked: boolean;
  reason: 'not-linuxdo' | 'no-token' | 'no-button' | 'button-disabled' | 'clicked' | 'click-not-acknowledged' | 'error';
  buttonText?: string;
  rect?: { x: number; y: number; width: number; height: number };
  selector?: string;
  tokenSelectors?: string[];
};



export type LinuxDoCaptchaPageState = {
  url: string;
  tokenPresent: boolean;
  verifyVisible: boolean;
  verifyDisabled: boolean;
};

export function isLinuxDoCaptchaClickAcknowledged(
  before: LinuxDoCaptchaPageState,
  after: LinuxDoCaptchaPageState,
): boolean {
  return after.url !== before.url
    || (before.tokenPresent && !after.tokenPresent)
    || (before.verifyVisible && !after.verifyVisible)
    || (!before.verifyDisabled && after.verifyDisabled);
}

function readLinuxDoCaptchaPageStateInPage(): LinuxDoCaptchaPageState {
  const tokenSelectors = [
    'textarea[name="h-captcha-response"]',
    'textarea[name="g-recaptcha-response"]',
    'input[name="h-captcha-response"]',
    'input[name="g-recaptcha-response"]',
    '[name="h-captcha-response"]',
    '[name="g-recaptcha-response"]',
  ];
  const tokenPresent = tokenSelectors.some((selector) => Array.from(document.querySelectorAll(selector)).some((node) => {
    const value = (node as HTMLInputElement | HTMLTextAreaElement).value;
    return typeof value === 'string' && value.trim().length > 0;
  }));
  const candidates = Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],.btn,.btn-primary'))
    .filter((node) => /^(验证|verify)$/i.test(String((node as HTMLElement).innerText || node.textContent || (node as HTMLInputElement).value || '').replace(/\s+/g, ' ').trim()));
  const verify = candidates.find((node) => {
    const style = window.getComputedStyle(node);
    const rect = (node as HTMLElement).getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }) as HTMLButtonElement | HTMLInputElement | undefined;
  return {
    url: window.location.href,
    tokenPresent,
    verifyVisible: Boolean(verify),
    verifyDisabled: Boolean(verify?.disabled || verify?.getAttribute('aria-disabled') === 'true'),
  };
}

export function findLinuxDoCaptchaVerifyActionInPage(): LinuxDoCaptchaAutoConfirmResult {
  try {
    // page.evaluate serializes this function without its module scope, so keep
    // every browser-side dependency inside the function body.
    const tokenSelectorsToCheck = [
      'textarea[name="h-captcha-response"]',
      'textarea[name="g-recaptcha-response"]',
      'input[name="h-captcha-response"]',
      'input[name="g-recaptcha-response"]',
      '[name="h-captcha-response"]',
      '[name="g-recaptcha-response"]',
    ];
    const host = window.location.hostname.toLowerCase();
    if (host !== 'linux.do' && !host.endsWith('.linux.do')) {
      return { clicked: false, reason: 'not-linuxdo' };
    }

    const pageText = document.body?.innerText || document.body?.textContent || '';
    if (!/人机验证|hcaptcha|h-captcha/i.test(pageText)) return { clicked: false, reason: 'no-token' };

    const tokenSelectors = tokenSelectorsToCheck.filter((selector) => (
      Array.from(document.querySelectorAll(selector)).some((node) => {
        const value = (node as HTMLInputElement | HTMLTextAreaElement).value;
        return typeof value === 'string' && value.trim().length > 0;
      })
    ));
    if (tokenSelectors.length === 0) return { clicked: false, reason: 'no-token' };

    const candidates: Array<{ element: Element; text: string; score: number }> = [];
    for (const element of Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],.btn,.btn-primary'))) {
      const style = window.getComputedStyle(element);
      const rect = (element as HTMLElement).getBoundingClientRect();
      if (style.display === 'none'
        || style.visibility === 'hidden'
        || Number.parseFloat(style.opacity || '1') <= 0
        || rect.width <= 0
        || rect.height <= 0) continue;

      const value = (element as HTMLInputElement).value;
      const text = String((element as HTMLElement).innerText || element.textContent || value || '')
        .replace(/\s+/g, ' ')
        .trim();
      let score = /^(验证|verify)$/i.test(text) ? 100 : /验证|verify/i.test(text) ? 60 : 0;
      if (!score) continue;
      const className = String((element as HTMLElement).className || '');
      const parentClassName = String((element.parentElement as HTMLElement | null)?.className || '');
      const modalClassName = String((element.closest('[role="dialog"],.modal,.d-modal,.d-modal__container,.modal-inner') as HTMLElement | null)?.className || '');
      if (/btn-primary|primary|confirm|submit/i.test(`${className} ${parentClassName}`)) score += 20;
      if (/modal|dialog|captcha|人机验证/i.test(`${modalClassName} ${pageText}`)) score += 10;
      candidates.push({ element, text, score });
    }
    candidates.sort((a, b) => b.score - a.score);

    const candidate = candidates[0];
    if (!candidate) return { clicked: false, reason: 'no-button', tokenSelectors };
    const control = candidate.element as HTMLButtonElement | HTMLInputElement;
    if (control.disabled || candidate.element.getAttribute('aria-disabled') === 'true') {
      return { clicked: false, reason: 'button-disabled', buttonText: candidate.text, tokenSelectors };
    }
    const target = candidate.element as HTMLElement;
    for (const marked of Array.from(document.querySelectorAll('[data-metapi-captcha-confirm]'))) {
      marked.removeAttribute('data-metapi-captcha-confirm');
    }
    target.setAttribute('data-metapi-captcha-confirm', 'active');
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', inline: 'center' });
    }
    const rect = target.getBoundingClientRect();
    return {
      clicked: false,
      reason: 'clicked',
      buttonText: candidate.text,
      tokenSelectors,
      selector: '[data-metapi-captcha-confirm="active"]',
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  } catch {
    return { clicked: false, reason: 'error' };
  }
}

export function confirmLinuxDoCaptchaVerifyInPage(): LinuxDoCaptchaAutoConfirmResult {
  const action = findLinuxDoCaptchaVerifyActionInPage();
  if (action.reason !== 'clicked' || !action.rect || !action.selector) return action;
  try {
    const element = document.querySelector(action.selector) as HTMLElement | null;
    if (!element) return { ...action, clicked: false, reason: 'no-button' };
    const target = element.closest('button,[role="button"],input[type="button"],input[type="submit"],.btn,.btn-primary') as HTMLElement | null || element;
    const rect = target.getBoundingClientRect();
    const eventInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
    };
    for (const type of ['pointerover', 'pointermove', 'mouseover', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const event = type.startsWith('pointer') && typeof window.PointerEvent === 'function'
        ? new window.PointerEvent(type, { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true })
        : new window.MouseEvent(type, eventInit);
      target.dispatchEvent(event);
    }
    target.click();
    const form = target.closest('form') as HTMLFormElement | null;
    if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit(target instanceof window.HTMLButtonElement || target instanceof window.HTMLInputElement ? target : undefined);
    }
    return { ...action, clicked: true };
  } catch {
    return { clicked: false, reason: 'error' };
  }
}

export async function clickLinuxDoCaptchaVerifyWithTrustedInput(page: Page): Promise<LinuxDoCaptchaAutoConfirmResult | null> {
  const action = await page.evaluate(findLinuxDoCaptchaVerifyActionInPage).catch(() => null);
  if (!action || action.reason !== 'clicked' || !action.selector) return action;
  const before = await page.evaluate(readLinuxDoCaptchaPageStateInPage).catch(() => null);
  if (!before) return { ...action, clicked: false, reason: 'error' };

  let requestObserved = false;
  const onRequest = (request: { url(): string; method(): string; resourceType(): string }) => {
    try {
      const url = new URL(request.url());
      if ((url.hostname === 'linux.do' || url.hostname.endsWith('.linux.do'))
        && request.method() !== 'GET'
        && ['document', 'xhr', 'fetch'].includes(request.resourceType())) {
        requestObserved = true;
      }
    } catch {}
  };
  page.on('request', onRequest);
  const waitForAcknowledgement = async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !page.isClosed()) {
      if (requestObserved) return true;
      const after = await page.evaluate(readLinuxDoCaptchaPageStateInPage).catch(() => null);
      if (after && isLinuxDoCaptchaClickAcknowledged(before, after)) return true;
      await page.waitForTimeout(200).catch(() => {});
    }
    return false;
  };

  try {
    const verifyButton = page.locator(action.selector);
    if (await verifyButton.count().catch(() => 0) !== 1) {
      return { ...action, clicked: false, reason: 'no-button' };
    }
    if (!await verifyButton.isVisible().catch(() => false)) {
      return { ...action, clicked: false, reason: 'no-button' };
    }
    if (!await verifyButton.isEnabled().catch(() => false)) {
      return { ...action, clicked: false, reason: 'button-disabled' };
    }
    await verifyButton.click({ timeout: 5_000 });
    return await waitForAcknowledgement()
      ? { ...action, clicked: true }
      : { ...action, clicked: false, reason: 'click-not-acknowledged' };
  } catch {
    return { ...action, clicked: false, reason: 'error' };
  } finally {
    page.off('request', onRequest);
  }
}

export function startLinuxDoCaptchaAutoConfirm(page: Page, input: { intervalMs?: number; minClickIntervalMs?: number; minProbeIntervalMs?: number; initialDelayMs?: number } = {}): () => void {
  const intervalMs = Math.max(500, input.intervalMs ?? 1500);
  const minClickIntervalMs = Math.max(1000, input.minClickIntervalMs ?? 2500);
  const minProbeIntervalMs = Math.max(3000, input.minProbeIntervalMs ?? 7000);
  const initialDelayMs = Math.max(0, input.initialDelayMs ?? 5000);
  let stopped = false;
  let inFlight = false;
  let lastClickAt = 0;
  let lastProbeAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  const tick = async () => {
    if (stopped) return;
    if (page.isClosed()) {
      stop();
      return;
    }
    if (inFlight) return;
    const now = Date.now();
    if (now - lastClickAt < minClickIntervalMs) return;
    if (now - lastProbeAt < minProbeIntervalMs) return;
    lastProbeAt = now;
    inFlight = true;
    try {
      const result = await clickLinuxDoCaptchaVerifyWithTrustedInput(page).catch(() => null);
      if (result?.clicked) lastClickAt = Date.now();
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  page.once('close', stop);
  const firstTimer = setTimeout(() => { void tick(); }, initialDelayMs);
  firstTimer.unref?.();
  return () => {
    clearTimeout(firstTimer);
    stop();
  };
}
