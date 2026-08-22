import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import ModernSelect from '../components/ModernSelect.js';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
    getAccountTokens: vi.fn(),
    getSiteAuthRequirements: vi.fn(),
    addAccount: vi.fn(),
    createAccountFromSiteAuthCredential: vi.fn(),
    startAccountSiteAuthBrowserLogin: vi.fn(),
    importSiteAuthCredential: vi.fn(),
    rebindAccountBrowserProfile: vi.fn(),
    getTask: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || [])
    .map((child) => (typeof child === 'string' ? child : collectText(child)))
    .join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function installMessageWindow(openSpy = vi.fn((..._args: unknown[]) => ({ location: { href: '' }, focus: vi.fn(), close: vi.fn() }))) {
  const listeners: Record<string, Set<(event: any) => void>> = {};
  const addEventListener = vi.fn((type: string, listener: (event: any) => void) => {
    listeners[type] ||= new Set();
    listeners[type].add(listener);
  });
  const removeEventListener = vi.fn((type: string, listener: (event: any) => void) => {
    listeners[type]?.delete(listener);
  });
  const dispatchEvent = vi.fn((event: any) => {
    for (const listener of listeners[event?.type] || []) listener(event);
    return true;
  });
  vi.stubGlobal('window', {
    open: openSpy,
    addEventListener,
    removeEventListener,
    dispatchEvent,
  });
  vi.stubGlobal('MessageEvent', class {
    type: string;
    data: unknown;
    constructor(type: string, init: { data?: unknown } = {}) {
      this.type = type;
      this.data = init.data;
    }
  });
  return openSpy;
}

async function renderAccountsPage() {
  apiMock.getAccounts.mockResolvedValue([]);
  apiMock.getSites.mockResolvedValue([
    { id: 31, name: 'LinuxDO Site', platform: 'new-api', status: 'active', url: 'https://target.example.com' },
  ]);
  apiMock.getAccountTokens.mockResolvedValue([]);

  let root!: WebTestRenderer;
  await act(async () => {
    root = create(
      <MemoryRouter initialEntries={['/accounts']}>
        <ToastProvider>
          <Accounts />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await flushMicrotasks();
  return root!;
}

async function renderAccountsPageWithSites(sites: Array<Record<string, unknown>>) {
  apiMock.getAccounts.mockResolvedValue([]);
  apiMock.getSites.mockResolvedValue(sites);
  apiMock.getAccountTokens.mockResolvedValue([]);

  let root!: WebTestRenderer;
  await act(async () => {
    root = create(
      <MemoryRouter initialEntries={['/accounts']}>
        <ToastProvider>
          <Accounts />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await flushMicrotasks();
  return root!;
}

async function clickButton(root: WebTestRenderer, label: string) {
  const button = root.root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).includes(label)
  ));
  await act(async () => {
    await button.props.onClick();
  });
  await flushMicrotasks();
}

describe('Accounts site auth login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
    apiMock.getSiteAuthRequirements.mockResolvedValue({
      siteId: 31,
      hasThirdPartyLogin: true,
      requirements: [
        {
          provider: 'linuxdo',
          label: 'LinuxDO',
          required: true,
          confidence: 'detected',
          reason: 'login page contains this provider',
          availableCredentials: [
            {
              id: 12,
              provider: 'linuxdo',
              label: '主 LinuxDO',
              credentialType: 'cookie',
              status: 'active',
              metadata: {},
            },
          ],
        },
      ],
    });
    apiMock.createAccountFromSiteAuthCredential.mockResolvedValue({
      id: 99,
      username: 'target-user',
      tokenType: 'session',
      credentialMode: 'session',
    });
    apiMock.startAccountSiteAuthBrowserLogin.mockResolvedValue({
      success: true,
      siteId: 31,
      provider: 'github',
      authorizationUrl: 'http://metapi.local/site-auth/target-browser/state-1',
      instructions: { mode: 'target_site_browser_login' },
    });
    apiMock.addAccount.mockResolvedValue({
      id: 100,
      username: 'GitHub · octocat',
      tokenType: 'session',
      credentialMode: 'session',
      queued: false,
    });
    apiMock.getTask.mockResolvedValue({
      success: true,
      task: { id: 'account-init-100', status: 'succeeded', message: '初始化连接 #100已完成' },
    });
    apiMock.importSiteAuthCredential.mockResolvedValue({
      success: true,
      item: {
        id: 77,
        provider: 'github',
        label: 'GitHub · browser-user',
        credentialType: 'session_artifact',
        status: 'active',
        metadata: {},
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rebinds an expired AgentRouter account through its original browser Profile', async () => {
    const popup = { location: { href: '' }, focus: vi.fn(), close: vi.fn() };
    const openSpy = installMessageWindow(vi.fn((..._args: unknown[]) => popup));
    apiMock.getAccounts.mockResolvedValue([{
      id: 94,
      siteId: 32,
      username: 'linuxdo_59260',
      accessToken: 'session=expired',
      status: 'expired',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        platformUserId: 59260,
        managedBrowserProfile: { enabled: true, loginProvider: 'linuxdo' },
      }),
      site: { id: 32, name: 'AgentRouter', platform: 'agentrouter', status: 'active', url: 'https://agentrouter.org' },
    }]);
    apiMock.getSites.mockResolvedValue([
      { id: 32, name: 'AgentRouter', platform: 'agentrouter', status: 'active', url: 'https://agentrouter.org' },
    ]);
    apiMock.startAccountSiteAuthBrowserLogin.mockResolvedValueOnce({
      success: true,
      siteId: 32,
      accountId: 94,
      authorizationUrl: 'http://metapi.local/site-auth/target-browser/rebind-state-94',
      targetSiteUrl: 'https://agentrouter.org',
      instructions: { mode: 'target_site_browser_login', source: 'managed_target_profile_rebind' },
    });
    apiMock.rebindAccountBrowserProfile.mockResolvedValueOnce({ success: true, account: { id: 94, status: 'active' } });

    let root!: WebTestRenderer;
    await act(async () => {
      root = create(
        <MemoryRouter initialEntries={['/accounts']}>
          <ToastProvider>
            <Accounts />
          </ToastProvider>
        </MemoryRouter>,
      );
    });
    await flushMicrotasks();

    try {
      const rebindButton = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('重新绑定')
      ))[0];
      await act(async () => {
        await rebindButton.props.onClick();
      });
      await flushMicrotasks();

      expect(collectText(root.root)).toContain('打开浏览器重新绑定 Profile');
      await clickButton(root, '打开浏览器重新绑定 Profile');

      expect(apiMock.startAccountSiteAuthBrowserLogin).toHaveBeenCalledWith({
        siteId: 32,
        accountId: 94,
      });
      expect(openSpy).toHaveBeenCalledWith(
        'about:blank',
        'metapi-target-site-rebind-94',
        expect.stringContaining('popup=yes'),
      );
      expect(popup.location.href).toContain('/site-auth/target-browser/rebind-state-94');

      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: {
            type: 'metapi-target-site-auth',
            status: 'success',
            state: 'rebind-state-94',
            siteId: 32,
            accountId: 94,
            accessToken: 'session=fresh-agent',
            username: 'linuxdo_59260',
            platformUserId: 59260,
          },
        }));
      });
      await vi.waitFor(async () => {
        await flushMicrotasks();
        expect(apiMock.rebindAccountBrowserProfile).toHaveBeenCalledWith(94, {
          state: 'rebind-state-94',
        });
      });
      expect(collectText(root.root)).toContain('浏览器 Profile 重新绑定成功');
    } finally {
      await act(async () => root?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it('creates a Session connection from a saved site auth credential', async () => {
    const root = await renderAccountsPage();
    try {
      await clickButton(root, '+ 添加连接');

      const selects = root.root.findAllByType(ModernSelect);
      const siteSelect = selects[1];
      await act(async () => {
        siteSelect?.props.onChange('31');
      });
      await flushMicrotasks();

      await vi.waitFor(async () => {
        await flushMicrotasks();
        expect(collectText(root.root)).toContain('使用该凭证登录站点');
      });

      await clickButton(root, '使用该凭证登录站点');

      expect(apiMock.createAccountFromSiteAuthCredential).toHaveBeenCalledWith({
        siteId: 31,
        credentialId: 12,
      });
      await vi.waitFor(async () => {
        await flushMicrotasks();
        expect(collectText(root.root)).toContain('已创建 Session 连接');
      });
    } finally {
      root?.unmount();
    }
  });

  it('does not start target-site OAuth login when no saved provider credential exists', async () => {
    const openSpy = vi.fn((..._args: unknown[]) => null);
    vi.stubGlobal('window', { open: openSpy });
    apiMock.getSiteAuthRequirements.mockResolvedValueOnce({
      siteId: 31,
      hasThirdPartyLogin: true,
      requirements: [
        {
          provider: 'github',
          label: 'GitHub',
          required: true,
          confidence: 'detected',
          reason: 'login page contains this provider',
          availableCredentials: [],
          availableProviderCredentials: [],
        },
      ],
    });

    const root = await renderAccountsPage();
    try {
      await clickButton(root, '+ 添加连接');

      const selects = root.root.findAllByType(ModernSelect);
      const siteSelect = selects[1];
      await act(async () => {
        siteSelect?.props.onChange('31');
      });
      await flushMicrotasks();

      await vi.waitFor(async () => {
        await flushMicrotasks();
        expect(collectText(root.root)).toContain('没有可用的 GitHub 凭证');
        expect(collectText(root.root)).toContain('去 OAuth 管理保存 GitHub 凭证');
      });

      expect(apiMock.startAccountSiteAuthBrowserLogin).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });

  it('keeps AnyRouter and AgentRouter profile login while allowing password login fallback', async () => {
    const popup = { location: { href: '' }, focus: vi.fn(), close: vi.fn(), document: { title: '', body: { innerHTML: '' } } };
    const openSpy = vi.fn((..._args: unknown[]) => popup);
    vi.stubGlobal('window', { open: openSpy });
    apiMock.getSiteAuthRequirements.mockResolvedValueOnce({
      siteId: 32,
      hasThirdPartyLogin: true,
      requirements: [
        {
          provider: 'github',
          label: 'GitHub',
          required: true,
          confidence: 'detected',
          reason: 'NewAPI status declares GitHub OAuth',
          availableCredentials: [],
          availableProviderCredentials: [
            {
              id: 88,
              provider: 'github',
              label: 'GitHub · octocat',
              credentialType: 'session_artifact',
              status: 'active',
              metadata: { source: 'controlled-browser-login' },
            },
          ],
        },
      ],
    });

    const root = await renderAccountsPageWithSites([
      { id: 32, name: 'AgentRouter', platform: 'agentrouter', status: 'active', url: 'https://agentrouter.org' },
    ]);
    try {
      await clickButton(root, '+ 添加连接');

      const siteSelect = root.root.findAllByType(ModernSelect)[1];
      await act(async () => {
        siteSelect?.props.onChange('32');
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('Any/Agent 真实站点登录维护');
      expect(text).toContain('打开站点登录窗口并保存 Profile');
      expect(text).toContain('账号密码登录');
      expect(text).not.toContain('第三方授权登录');
      expect(text).not.toContain('OAuth 管理');
      expect(text).not.toContain('使用已保存 GitHub 登录该站点');

      await clickButton(root, '打开站点登录窗口并保存 Profile');

      expect(apiMock.startAccountSiteAuthBrowserLogin).toHaveBeenCalledWith({
        siteId: 32,
      });
      expect(openSpy).toHaveBeenCalledWith(
        'about:blank',
        'metapi-target-site-login-32',
        expect.stringContaining('popup=yes'),
      );

      await clickButton(root, '账号密码登录');
      const loginSelect = root.root
        .findAllByType(ModernSelect)
        .find((node) => node.props.options?.some?.((option: any) => option.value === '32'));
      expect(loginSelect).toBeTruthy();
      expect(loginSelect!.props.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: '32', label: 'AgentRouter (agentrouter)' }),
        ]),
      );
      expect(collectText(root.root)).toContain('账号密码会走协议登录，不会启动浏览器或保存 Profile');
      expect(root.root.findAll((node) => node.type === 'input' && node.props.placeholder === '用户名').length).toBe(1);
      expect(root.root.findAll((node) => node.type === 'input' && node.props.placeholder === '密码').length).toBe(1);
    } finally {
      await act(async () => {
        root?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });

  it('lets the user choose a saved provider credential before starting target-site OAuth login', async () => {
    const popup = { location: { href: '' }, focus: vi.fn(), close: vi.fn() };
    const openSpy = vi.fn((..._args: unknown[]) => popup);
    vi.stubGlobal('window', { open: openSpy });
    apiMock.getSiteAuthRequirements.mockResolvedValueOnce({
      siteId: 31,
      hasThirdPartyLogin: true,
      requirements: [
        {
          provider: 'github',
          label: 'GitHub',
          required: true,
          confidence: 'detected',
          reason: 'NewAPI status declares GitHub OAuth',
          availableCredentials: [],
          availableProviderCredentials: [
            {
              id: 88,
              provider: 'github',
              label: 'GitHub · octocat',
              credentialType: 'session_artifact',
              status: 'active',
              metadata: { source: 'controlled-browser-login' },
            },
          ],
        },
      ],
    });
    apiMock.startAccountSiteAuthBrowserLogin.mockResolvedValueOnce({
      success: true,
      siteId: 31,
      provider: 'github',
      authorizationUrl: 'http://metapi.local/site-auth/target-browser/state-1',
      instructions: { mode: 'target_site_browser_login' },
    });

    const root = await renderAccountsPage();
    try {
      await clickButton(root, '+ 添加连接');

      const siteSelect = root.root.findAllByType(ModernSelect)[1];
      await act(async () => {
        siteSelect?.props.onChange('31');
      });
      await flushMicrotasks();

      await vi.waitFor(async () => {
        await flushMicrotasks();
        expect(collectText(root.root)).toContain('选择已保存 GitHub 凭证');
        expect(collectText(root.root)).toContain('GitHub · octocat');
      });

      await clickButton(root, '使用已保存 GitHub 登录该站点');

      expect(apiMock.startAccountSiteAuthBrowserLogin).toHaveBeenCalledWith({
        siteId: 31,
        provider: 'github',
        credentialId: 88,
      });
      expect(openSpy).toHaveBeenCalledWith(
        'about:blank',
        'metapi-target-site-auth-github',
        expect.stringContaining('popup=yes'),
      );
      const openFeatures = String(openSpy.mock.calls[0]?.[2] || '');
      expect(openFeatures).not.toContain('noopener');
      expect(openFeatures).not.toContain('noreferrer');
      expect(popup.location.href).toBe('http://metapi.local/site-auth/target-browser/state-1');
      expect(popup.focus).toHaveBeenCalled();
    } finally {
      await act(async () => {
        root?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });

  it('does not start target-site OAuth when the browser blocks the popup', async () => {
    const openSpy = vi.fn((..._args: unknown[]) => null);
    vi.stubGlobal('window', { open: openSpy });
    apiMock.getSiteAuthRequirements.mockResolvedValueOnce({
      siteId: 31,
      hasThirdPartyLogin: true,
      requirements: [
        {
          provider: 'github',
          label: 'GitHub',
          required: true,
          confidence: 'detected',
          reason: 'NewAPI status declares GitHub OAuth',
          availableCredentials: [],
          availableProviderCredentials: [
            {
              id: 88,
              provider: 'github',
              label: 'GitHub · octocat',
              credentialType: 'session_artifact',
              status: 'active',
              metadata: { source: 'controlled-browser-login' },
            },
          ],
        },
      ],
    });

    const root = await renderAccountsPage();
    try {
      await clickButton(root, '+ 添加连接');
      const siteSelect = root.root.findAllByType(ModernSelect)[1];
      await act(async () => {
        siteSelect?.props.onChange('31');
      });
      await flushMicrotasks();

      await vi.waitFor(async () => {
        await flushMicrotasks();
        expect(collectText(root.root)).toContain('选择已保存 GitHub 凭证');
      });

      await clickButton(root, '使用已保存 GitHub 登录该站点');

      expect(openSpy).toHaveBeenCalledWith(
        'about:blank',
        'metapi-target-site-auth-github',
        expect.stringContaining('popup=yes'),
      );
      expect(apiMock.startAccountSiteAuthBrowserLogin).not.toHaveBeenCalled();
      expect(collectText(root.root)).toContain('浏览器拦截了目标站授权窗口');
    } finally {
      await act(async () => {
        root?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });

  it('fills the Session form, waits for queued initialization, and then reports the add flow complete', async () => {
    const openSpy = installMessageWindow();
    apiMock.addAccount.mockResolvedValueOnce({
      id: 100,
      username: 'GitHub · octocat',
      tokenType: 'session',
      credentialMode: 'session',
      queued: true,
      jobId: 'account-init-100',
      message: '账号已添加，后台正在同步令牌和余额信息。',
    });
    apiMock.getSiteAuthRequirements.mockResolvedValueOnce({
      siteId: 31,
      hasThirdPartyLogin: true,
      requirements: [
        {
          provider: 'github',
          label: 'GitHub',
          required: true,
          confidence: 'detected',
          reason: 'NewAPI status declares GitHub OAuth',
          availableCredentials: [],
          availableProviderCredentials: [
            {
              id: 88,
              provider: 'github',
              label: 'GitHub · octocat',
              credentialType: 'session_artifact',
              status: 'active',
              metadata: { source: 'controlled-browser-login' },
            },
          ],
        },
      ],
    });

    const root = await renderAccountsPage();
    try {
      await clickButton(root, '+ 添加连接');

      const siteSelect = root.root.findAllByType(ModernSelect)[1];
      await act(async () => {
        siteSelect?.props.onChange('31');
      });
      await flushMicrotasks();

      await vi.waitFor(async () => {
        await flushMicrotasks();
        expect(collectText(root.root)).toContain('选择已保存 GitHub 凭证');
      });

      await clickButton(root, '使用已保存 GitHub 登录该站点');

      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          data: {
            type: 'metapi-target-site-auth',
            status: 'success',
            state: 'state-1',
            siteId: 31,
            provider: 'github',
            credentialId: 88,
            accessToken: 'session=target-site-session',
            username: 'GitHub · octocat',
            platformUserId: 2468,
          },
        }));
      });
      await flushMicrotasks();

      expect(openSpy).toHaveBeenCalledWith(
        'about:blank',
        'metapi-target-site-auth-github',
        expect.stringContaining('popup=yes'),
      );
      expect(apiMock.addAccount).toHaveBeenCalledWith(expect.objectContaining({
        siteId: 31,
        username: 'GitHub · octocat',
        accessToken: 'session=target-site-session',
        platformUserId: 2468,
        credentialMode: 'session',
        skipModelFetch: true,
        targetSiteAuth: {
          source: 'target-site-browser-login',
          provider: 'github',
          credentialId: 88,
          state: 'state-1',
        },
      }));
      expect(apiMock.createAccountFromSiteAuthCredential).not.toHaveBeenCalled();
      expect(apiMock.getTask).toHaveBeenCalledWith('account-init-100');
      expect(collectText(root.root)).toContain('初始化连接 #100已完成');
    } finally {
      await act(async () => {
        root?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });

  it('imports browser Session/UserID from the Session Cookie compatibility area', async () => {
    const openSpy = vi.fn((..._args: unknown[]) => null);
    vi.stubGlobal('window', { open: openSpy });
    apiMock.getSiteAuthRequirements.mockResolvedValueOnce({
      siteId: 31,
      hasThirdPartyLogin: true,
      requirements: [
        {
          provider: 'github',
          label: 'GitHub',
          required: true,
          confidence: 'detected',
          reason: 'login page contains this provider',
          availableCredentials: [],
          availableProviderCredentials: [],
        },
      ],
    });

    const root = await renderAccountsPage();
    try {
      await clickButton(root, '+ 添加连接');

      const selects = root.root.findAllByType(ModernSelect);
      const siteSelect = selects[1];
      await act(async () => {
        siteSelect?.props.onChange('31');
      });
      await flushMicrotasks();

      await vi.waitFor(async () => {
        await flushMicrotasks();
        expect(collectText(root.root)).toContain('Session/Cookie 兼容导入');
      });

      await clickButton(root, '自动获取浏览器凭证和 UserID');

      const captureTextarea = root.root.find((node) => (
        node.type === 'textarea'
        && typeof node.props.placeholder === 'string'
        && node.props.placeholder.includes('粘贴浏览器脚本输出')
      ));
      await act(async () => {
        captureTextarea.props.onChange({
          target: {
            value: JSON.stringify({
              accessToken: 'browser-session-token',
              userId: 2468,
              username: 'browser-user',
            }),
          },
        });
      });
      await flushMicrotasks();

      expect(collectText(root.root)).toContain('填入 Session');
      await clickButton(root, '填入 Session');

      expect(apiMock.importSiteAuthCredential).not.toHaveBeenCalled();
      expect(collectText(root.root)).toContain('已填入浏览器 Session 凭证和 UserID');
    } finally {
      await act(async () => {
        root?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });
});
