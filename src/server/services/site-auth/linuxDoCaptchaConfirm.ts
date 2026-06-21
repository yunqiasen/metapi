import type { Page } from 'playwright-core';

export type LinuxDoCaptchaAutoConfirmResult = {
  clicked: boolean;
  reason: 'not-linuxdo' | 'no-token' | 'no-button' | 'button-disabled' | 'clicked' | 'error';
  buttonText?: string;
  rect?: { x: number; y: number; width: number; height: number };
  tokenSelectors?: string[];
};

const LINUXDO_CAPTCHA_TOKEN_SELECTORS = [
  'textarea[name="h-captcha-response"]',
  'textarea[name="g-recaptcha-response"]',
  'input[name="h-captcha-response"]',
  'input[name="g-recaptcha-response"]',
  '[name="h-captcha-response"]',
  '[name="g-recaptcha-response"]',
] as const;

export function findLinuxDoCaptchaVerifyActionInPage(): LinuxDoCaptchaAutoConfirmResult {
  try {
    const host = window.location.hostname.toLowerCase();
    if (host !== 'linux.do' && !host.endsWith('.linux.do')) {
      return { clicked: false, reason: 'not-linuxdo' };
    }

    const pageText = document.body?.innerText || document.body?.textContent || '';
    if (!/人机验证|hcaptcha|h-captcha/i.test(pageText)) return { clicked: false, reason: 'no-token' };

    const tokenSelectors = LINUXDO_CAPTCHA_TOKEN_SELECTORS.filter((selector) => (
      Array.from(document.querySelectorAll(selector)).some((node) => {
        const value = (node as HTMLInputElement | HTMLTextAreaElement).value;
        return typeof value === 'string' && value.trim().length > 0;
      })
    ));
    if (tokenSelectors.length === 0) return { clicked: false, reason: 'no-token' };

    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = (element as HTMLElement).getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const textOf = (element: Element) => {
      const value = (element as HTMLInputElement).value;
      return String((element as HTMLElement).innerText || element.textContent || value || '')
        .replace(/\s+/g, ' ')
        .trim();
    };
    const scoreCandidate = (element: Element, text: string) => {
      let score = /^(验证|verify)$/i.test(text) ? 100 : /验证|verify/i.test(text) ? 60 : 0;
      if (!score) return 0;
      const className = String((element as HTMLElement).className || '');
      const parentClassName = String((element.parentElement as HTMLElement | null)?.className || '');
      const modalClassName = String((element.closest('[role="dialog"],.modal,.d-modal,.d-modal__container,.modal-inner') as HTMLElement | null)?.className || '');
      if (/btn-primary|primary|confirm|submit/i.test(`${className} ${parentClassName}`)) score += 20;
      if (/modal|dialog|captcha|人机验证/i.test(`${modalClassName} ${pageText}`)) score += 10;
      return score;
    };

    const candidates = Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],.btn,.btn-primary'))
      .filter(isVisible)
      .map((element) => ({ element, text: textOf(element) }))
      .map((item) => ({ ...item, score: scoreCandidate(item.element, item.text) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const candidate = candidates[0];
    if (!candidate) return { clicked: false, reason: 'no-button', tokenSelectors };
    const control = candidate.element as HTMLButtonElement | HTMLInputElement;
    if (control.disabled || candidate.element.getAttribute('aria-disabled') === 'true') {
      return { clicked: false, reason: 'button-disabled', buttonText: candidate.text, tokenSelectors };
    }
    const target = candidate.element as HTMLElement;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', inline: 'center' });
    }
    const rect = target.getBoundingClientRect();
    return {
      clicked: false,
      reason: 'clicked',
      buttonText: candidate.text,
      tokenSelectors,
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
  if (action.reason !== 'clicked' || !action.rect) return action;
  try {
    const pointElement = typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(
        action.rect.x + action.rect.width / 2,
        action.rect.y + action.rect.height / 2,
      ) as HTMLElement | null
      : null;
    const fallbackElement = Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],.btn,.btn-primary'))
      .find((node) => /^(验证|verify)$/i.test(String((node as HTMLElement).innerText || node.textContent || (node as HTMLInputElement).value || '').replace(/\s+/g, ' ').trim())) as HTMLElement | undefined;
    const element = pointElement || fallbackElement || null;
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

async function clickLinuxDoCaptchaVerifyWithTrustedInput(page: Page): Promise<LinuxDoCaptchaAutoConfirmResult | null> {
  const action = await page.evaluate(findLinuxDoCaptchaVerifyActionInPage).catch(() => null);
  if (!action || action.reason !== 'clicked' || !action.rect) return action;
  const x = action.rect.x + Math.max(1, action.rect.width / 2);
  const y = action.rect.y + Math.max(1, action.rect.height / 2);
  try {
    await page.mouse.move(x, y, { steps: 6 });
    await page.mouse.down({ button: 'left' });
    await page.waitForTimeout(90);
    await page.mouse.up({ button: 'left' });
    return { ...action, clicked: true };
  } catch {
    const fallback = await page.evaluate(confirmLinuxDoCaptchaVerifyInPage).catch(() => null);
    return fallback || { clicked: false, reason: 'error' };
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
