import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
    triggerCheckin: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findCheckinButton(root: ReactTestInstance): ReactTestInstance {
  return root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && typeof node.props.className === 'string'
    && node.props.className.includes('btn-link-warning')
    && collectText(node).trim() === '签到'
  ));
}

function installAccountFixture() {
  apiMock.getSites.mockResolvedValue([
    { id: 25, name: 'Agentrouter', platform: 'agentrouter', status: 'active' },
  ]);
  apiMock.getAccounts.mockResolvedValue([
    {
      id: 110,
      siteId: 25,
      username: 'linuxdo_59260',
      accessToken: 'session-token',
      status: 'active',
      checkinEnabled: true,
      balance: 213.04,
      balanceUsed: 2086.96,
      site: { id: 25, name: 'Agentrouter', platform: 'agentrouter', status: 'active' },
      runtimeHealth: { state: 'healthy', reason: 'ok' },
    },
  ]);
}

async function renderAccounts() {
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
  return root;
}

describe('Accounts check-in feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
    installAccountFixture();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the real skipped message instead of reporting check-in complete', async () => {
    apiMock.triggerCheckin.mockResolvedValue({
      success: false,
      status: 'skipped',
      skipped: true,
      message: 'AgentRouter 已执行签到校验，额度无新增，当前余额 212.63',
    });

    const root = await renderAccounts();
    try {
      await act(async () => {
        await findCheckinButton(root.root).props.onClick();
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('AgentRouter 已执行签到校验，额度无新增，当前余额 212.63');
      expect(rendered).not.toContain('签到完成');
      expect(rendered).toContain('toast-info');
    } finally {
      root.unmount();
    }
  });

  it('shows refreshed credentials with reward pending as info, not a completed or zero-reward check-in', async () => {
    apiMock.triggerCheckin.mockResolvedValue({
      success: false, status: 'skipped', skipped: true, rewardPending: true, credentialsRefreshed: true,
      message: 'AgentRouter 已重新登录并刷新凭证；缺少签到前额度，新增奖励待确认',
    });
    const root = await renderAccounts();
    try {
      await act(async () => { await findCheckinButton(root.root).props.onClick(); });
      await flushMicrotasks();
      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('新增奖励待确认');
      expect(rendered).toContain('toast-info');
      expect(rendered).not.toContain('toast-success');
      expect(rendered).not.toContain('签到完成');
      expect(rendered).not.toContain('额度 +$0.00');
    } finally { root.unmount(); }
  });

  it('shows the actual added quota when check-in succeeds', async () => {
    apiMock.triggerCheckin.mockResolvedValue({
      success: true,
      status: 'success',
      message: '签到成功',
      reward: '25',
    });

    const root = await renderAccounts();
    try {
      await act(async () => {
        await findCheckinButton(root.root).props.onClick();
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('签到成功，额度 +$25.00');
      expect(rendered).toContain('toast-success');
    } finally {
      root.unmount();
    }
  });
});
