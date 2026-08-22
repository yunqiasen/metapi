import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { confirmLinuxDoCaptchaVerifyInPage, findLinuxDoCaptchaVerifyActionInPage, isLinuxDoCaptchaClickAcknowledged } from './linuxDoCaptchaConfirm.js';

const originalWindow = (globalThis as any).window;
const originalDocument = (globalThis as any).document;

afterEach(() => {
  (globalThis as any).window = originalWindow;
  (globalThis as any).document = originalDocument;
});

function installDom(html: string, url = 'https://linux.do/login') {
  const dom = new JSDOM(html, { url });
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 40, width: 120, height: 40, toJSON: () => ({}) } as DOMRect;
  };
  return dom;
}

describe('LinuxDO hCaptcha confirm helper', () => {
  it('clicks the visible verify button only after a captcha token exists', () => {
    const dom = installDom(`
      <div>人机验证</div>
      <textarea name="h-captcha-response">token-1</textarea>
      <button id="verify">验证</button>
    `);
    const clickSpy = vi.fn();
    dom.window.document.getElementById('verify')?.addEventListener('click', clickSpy);

    expect(confirmLinuxDoCaptchaVerifyInPage()).toMatchObject({ clicked: true, reason: 'clicked', buttonText: '验证' });
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('can be serialized into page.evaluate without module-scope dependencies', () => {
    const dom = new JSDOM(`
      <div>Human Verification hCaptcha</div>
      <textarea name="h-captcha-response">token-1</textarea>
      <button id="verify">Verify</button>
    `, { url: 'https://linux.do/login', runScripts: 'outside-only' });
    dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return { x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 40, width: 120, height: 40, toJSON: () => ({}) } as DOMRect;
    };

    const result = dom.window.eval(`(${findLinuxDoCaptchaVerifyActionInPage.toString()})()`);

    expect(result).toMatchObject({ reason: 'clicked', buttonText: 'Verify', selector: '[data-metapi-captcha-confirm=\"active\"]' });
    expect(dom.window.document.getElementById('verify')?.getAttribute('data-metapi-captcha-confirm')).toBe('active');
  });

  it('does not click before the captcha token exists', () => {
    const dom = installDom(`
      <div>人机验证</div>
      <textarea name="h-captcha-response"></textarea>
      <button id="verify">验证</button>
    `);
    const clickSpy = vi.fn();
    dom.window.document.getElementById('verify')?.addEventListener('click', clickSpy);

    expect(confirmLinuxDoCaptchaVerifyInPage()).toEqual({ clicked: false, reason: 'no-token' });
    expect(clickSpy).not.toHaveBeenCalled();
  });


  it('does not click Cloudflare Turnstile challenge checkbox pages', () => {
    const dom = installDom(`
      <div>请验证您是真人</div>
      <input name="cf-turnstile-response" value="turnstile-token">
      <div role="button" id="cf">请验证您是真人</div>
    `);
    const clickSpy = vi.fn();
    dom.window.document.getElementById('cf')?.addEventListener('click', clickSpy);

    expect(confirmLinuxDoCaptchaVerifyInPage()).toEqual({ clicked: false, reason: 'no-token' });
    expect(clickSpy).not.toHaveBeenCalled();
  });



  it('uses the uniquely marked verify element instead of a stale coordinate or forced first match', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./linuxDoCaptchaConfirm.ts', import.meta.url), 'utf8'));
    const start = source.indexOf('export async function clickLinuxDoCaptchaVerifyWithTrustedInput');
    const end = source.indexOf('export function startLinuxDoCaptchaAutoConfirm', start);
    const functionSource = source.slice(start, end);
    expect(functionSource).toContain("page.locator(action.selector)");
    expect(functionSource).not.toContain('.first()');
    expect(functionSource).not.toContain('force: true');
    expect(functionSource).not.toContain('page.mouse.down');
  });

  it('requires observable page progress before reporting a captcha click as accepted', () => {
    const before = {
      url: 'https://linux.do/login',
      tokenPresent: true,
      verifyVisible: true,
      verifyDisabled: false,
    };

    expect(isLinuxDoCaptchaClickAcknowledged(before, { ...before })).toBe(false);
    expect(isLinuxDoCaptchaClickAcknowledged(before, { ...before, verifyDisabled: true })).toBe(true);
    expect(isLinuxDoCaptchaClickAcknowledged(before, { ...before, verifyVisible: false })).toBe(true);
    expect(isLinuxDoCaptchaClickAcknowledged(before, { ...before, tokenPresent: false })).toBe(true);
    expect(isLinuxDoCaptchaClickAcknowledged(before, { ...before, url: 'https://linux.do/' })).toBe(true);
  });

  it('does not click on non-LinuxDO pages', () => {
    installDom('<div>人机验证</div><textarea name="h-captcha-response">token-1</textarea><button>验证</button>', 'https://example.com/login');

    expect(confirmLinuxDoCaptchaVerifyInPage()).toEqual({ clicked: false, reason: 'not-linuxdo' });
  });
});
