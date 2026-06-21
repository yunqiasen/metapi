import type { Page } from 'playwright-core';

export type LinuxDoCaptchaAutoConfirmResult = {
  clicked: boolean;
  reason: 'not-linuxdo' | 'no-token' | 'no-button' | 'button-disabled' | 'clicked' | 'error';
  buttonText?: string;
};

export function confirmLinuxDoCaptchaVerifyInPage(): LinuxDoCaptchaAutoConfirmResult {
  try {
    const host = window.location.hostname.toLowerCase();
    if (host !== 'linux.do' && !host.endsWith('.linux.do')) {
      return { clicked: false, reason: 'not-linuxdo' };
    }

    const tokenSelectors = [
      'textarea[name="h-captcha-response"]',
      'textarea[name="g-recaptcha-response"]',
      'textarea[name="cf-turnstile-response"]',
      'input[name="h-captcha-response"]',
      'input[name="g-recaptcha-response"]',
      'input[name="cf-turnstile-response"]',
      '[name="h-captcha-response"]',
      '[name="g-recaptcha-response"]',
      '[name="cf-turnstile-response"]',
    ];
    const tokenPresent = tokenSelectors.some((selector) => (
      Array.from(document.querySelectorAll(selector)).some((node) => {
        const value = (node as HTMLInputElement | HTMLTextAreaElement).value;
        return typeof value === 'string' && value.trim().length > 0;
      })
    ));
    if (!tokenPresent) return { clicked: false, reason: 'no-token' };

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
    const candidates = Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]'));
    for (const element of candidates) {
      if (!isVisible(element)) continue;
      const text = textOf(element);
      if (!/^(验证|verify)$/i.test(text)) continue;
      const control = element as HTMLButtonElement | HTMLInputElement;
      if (control.disabled || element.getAttribute('aria-disabled') === 'true') {
        return { clicked: false, reason: 'button-disabled', buttonText: text };
      }
      const rect = (element as HTMLElement).getBoundingClientRect();
      const eventInit: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
      };
      const target = element as HTMLElement;
      if (typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'center', inline: 'center' });
      }
      for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup']) {
        element.dispatchEvent(new window.MouseEvent(type, eventInit));
      }
      (element as HTMLElement).click();
      return { clicked: true, reason: 'clicked', buttonText: text };
    }
    return { clicked: false, reason: 'no-button' };
  } catch {
    return { clicked: false, reason: 'error' };
  }
}

export function startLinuxDoCaptchaAutoConfirm(page: Page, input: { intervalMs?: number; minClickIntervalMs?: number } = {}): () => void {
  const intervalMs = Math.max(300, input.intervalMs ?? 900);
  const minClickIntervalMs = Math.max(1000, input.minClickIntervalMs ?? 3000);
  let stopped = false;
  let inFlight = false;
  let lastClickAt = 0;
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
    if (Date.now() - lastClickAt < minClickIntervalMs) return;
    inFlight = true;
    try {
      const result = await page.evaluate(confirmLinuxDoCaptchaVerifyInPage).catch(() => null);
      if (result?.clicked) lastClickAt = Date.now();
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  page.once('close', stop);
  void tick();
  return stop;
}
