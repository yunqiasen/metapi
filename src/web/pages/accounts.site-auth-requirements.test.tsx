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
    button.props.onClick();
  });
  await flushMicrotasks();
}

describe('Accounts site auth requirements', () => {
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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows LinuxDO credential choices after selecting a site that requires LinuxDO login', async () => {
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
        const text = collectText(root.root);
        expect(apiMock.getSiteAuthRequirements).toHaveBeenCalledWith(31);
        expect(text).toContain('第三方授权登录');
        expect(text).toContain('LinuxDO');
        expect(text).toContain('主 LinuxDO');
        expect(text).toContain('使用该凭证登录站点');
      });
    } finally {
      root?.unmount();
    }
  });

  it('shows a visible third-party login workspace and browser credential capture entry after selecting a site', async () => {
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
        const text = collectText(root.root);
        expect(text).toContain('第三方授权登录');
        expect(text).toContain('检测到该站点支持 LinuxDO 登录');
        expect(text).toContain('这里会使用 OAuth 管理里已保存的第三方凭证打开目标站授权登录。');
        expect(text).toContain('自动获取浏览器凭证和 UserID');
      });
    } finally {
      root?.unmount();
    }
  });

  it('fills the Session form from browser credential capture output', async () => {
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
        expect(collectText(root.root)).toContain('自动获取浏览器凭证和 UserID');
      });

      await clickButton(root, '自动获取浏览器凭证和 UserID');
      expect(collectText(root.root)).toContain('浏览器凭证获取');

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

      await clickButton(root, '填入 Session');

      const tokenTextarea = root.root.find((node) => (
        node.type === 'textarea'
        && typeof node.props.placeholder === 'string'
        && node.props.placeholder.includes('Session Access Token')
      ));
      const userIdInput = root.root.find((node) => (
        node.type === 'input'
        && node.props.placeholder === '用户 ID（可选）'
      ));
      const nameInput = root.root.find((node) => (
        node.type === 'input'
        && node.props.placeholder === '连接名称（可选）'
      ));
      expect(tokenTextarea.props.value).toBe('browser-session-token');
      expect(userIdInput.props.value).toBe('2468');
      expect(nameInput.props.value).toBe('browser-user');
    } finally {
      root?.unmount();
    }
  });

});
