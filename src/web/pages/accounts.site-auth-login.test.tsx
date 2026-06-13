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
    createAccountFromSiteAuthCredential: vi.fn(),
    startAccountSiteAuthBrowserLogin: vi.fn(),
    importSiteAuthCredential: vi.fn(),
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
      authorizationUrl: 'https://target.example.com/login',
      instructions: { mode: 'target_site_browser_login' },
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

  it('opens target-site GitHub browser login from the add Session connection form', async () => {
    const openSpy = vi.fn(() => null);
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
        expect(collectText(root.root)).toContain('用 GitHub 浏览器登录该站点');
      });

      await clickButton(root, '用 GitHub 浏览器登录该站点');

      expect(apiMock.startAccountSiteAuthBrowserLogin).toHaveBeenCalledWith({
        siteId: 31,
        provider: 'github',
      });
      expect(openSpy).toHaveBeenCalledWith(
        'https://target.example.com/login',
        'metapi-target-site-auth-github',
        expect.stringContaining('popup=yes'),
      );
      expect(collectText(root.root)).not.toContain('添加 GitHub 凭证');
    } finally {
      root?.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('saves the target-site browser login result as a reusable credential', async () => {
    const openSpy = vi.fn(() => null);
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
        expect(collectText(root.root)).toContain('用 GitHub 浏览器登录该站点');
      });

      await clickButton(root, '用 GitHub 浏览器登录该站点');

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

      expect(collectText(root.root)).toContain('保存为持久凭证并填入 Session');
      await clickButton(root, '保存为持久凭证并填入 Session');

      expect(apiMock.importSiteAuthCredential).toHaveBeenCalledWith({
        provider: 'github',
        label: 'GitHub · browser-user',
        credentialType: 'session_artifact',
        payload: {
          accessToken: 'browser-session-token',
          platformUserId: '2468',
          username: 'browser-user',
        },
        metadata: {
          source: 'target-site-browser-login',
          targetSiteId: 31,
          targetSiteName: 'LinuxDO Site',
          targetSiteUrl: 'https://target.example.com',
        },
      });
      expect(collectText(root.root)).toContain('已保存持久登录凭证');
    } finally {
      root?.unmount();
      vi.unstubAllGlobals();
    }
  });
});
