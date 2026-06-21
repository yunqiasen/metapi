import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { confirmLinuxDoCaptchaVerifyInPage } from './linuxDoCaptchaConfirm.js';

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
      <textarea name="h-captcha-response">token-1</textarea>
      <button id="verify">验证</button>
    `);
    const clickSpy = vi.fn();
    dom.window.document.getElementById('verify')?.addEventListener('click', clickSpy);

    expect(confirmLinuxDoCaptchaVerifyInPage()).toEqual({ clicked: true, reason: 'clicked', buttonText: '验证' });
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('does not click before the captcha token exists', () => {
    const dom = installDom(`
      <textarea name="h-captcha-response"></textarea>
      <button id="verify">验证</button>
    `);
    const clickSpy = vi.fn();
    dom.window.document.getElementById('verify')?.addEventListener('click', clickSpy);

    expect(confirmLinuxDoCaptchaVerifyInPage()).toEqual({ clicked: false, reason: 'no-token' });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('does not click on non-LinuxDO pages', () => {
    installDom('<textarea name="h-captcha-response">token-1</textarea><button>验证</button>', 'https://example.com/login');

    expect(confirmLinuxDoCaptchaVerifyInPage()).toEqual({ clicked: false, reason: 'not-linuxdo' });
  });
});
