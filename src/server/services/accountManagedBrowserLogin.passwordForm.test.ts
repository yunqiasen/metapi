import { describe, expect, it, vi } from 'vitest';
import { loginManagedAccountPasswordForm } from './accountManagedBrowserLogin.js';

type LoginState = {
  overlayVisible: boolean;
  formVisible: boolean;
  events: string[];
};

function createLocator(selector: string, state: LoginState) {
  const isUsername = /type="email"|name="email"|name="username"|autocomplete="username"|placeholder\*="邮箱"|placeholder\*="账号"|placeholder\*="用户名"|type="text"/.test(selector);
  const isPassword = /type="password"|name="password"|current-password|placeholder\*="密码"/.test(selector);
  const isOverlayClose = /关闭公告|Close Notice|今日关闭|Close Today|semi-modal-close|aria-label="close"|aria-label="Close"/.test(selector);
  const isEmailEntry = /semi-icon-mail|aria-label="mail"|Sign in with Email|邮箱或用户名|使用.*邮箱/.test(selector);
  const isSubmit = /type="submit"|:has-text\("登录"\)|:has-text\("Login"\)|:has-text\("Sign in"\)/.test(selector);

  return {
    first() { return this; },
    async isVisible() {
      if (isOverlayClose) return state.overlayVisible;
      if (isEmailEntry) return !state.overlayVisible && !state.formVisible;
      if (isUsername || isPassword || isSubmit) return state.formVisible;
      return false;
    },
    async click() {
      if (isOverlayClose) {
        state.overlayVisible = false;
        state.events.push('close-overlay');
      } else if (isEmailEntry) {
        state.formVisible = true;
        state.events.push('open-email-form');
      } else if (isSubmit) {
        state.events.push('submit');
      }
    },
    async fill(value: string) {
      if (isUsername) state.events.push(`username:${value}`);
      if (isPassword) state.events.push(`password:${value}`);
    },
    async waitFor() {
      if (!(await this.isVisible())) throw new Error('not visible');
    },
    async count() { return 0; },
    nth() { return this; },
  };
}

describe('managed browser password form', () => {
  it('dismisses the announcement and expands the email login entry before filling credentials', async () => {
    const state: LoginState = { overlayVisible: true, formVisible: false, events: [] };
    const page = {
      locator: vi.fn((selector: string) => createLocator(selector, state)),
      waitForSelector: vi.fn(async () => {
        if (!state.formVisible) throw new Error('password hidden');
      }),
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      keyboard: { press: vi.fn(async () => {}) },
      evaluate: vi.fn(async () => false),
    };

    await loginManagedAccountPasswordForm(page as never, 'user@example.com', 'secret');

    expect(state.events).toEqual([
      'close-overlay',
      'open-email-form',
      'username:user@example.com',
      'password:secret',
      'submit',
    ]);
  });
});
