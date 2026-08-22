import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
    batchUpdateAccounts: vi.fn(),
    refreshAccountHealth: vi.fn(),
    refreshAllAccountCredentials: vi.fn(),
    refreshAccountCredential: vi.fn(),
    refreshBalance: vi.fn(),
    triggerCheckinAll: vi.fn(),
    triggerCheckin: vi.fn(),
    getTask: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function collectText(node: any): string {
  return (node.children || []).map((child: any) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

describe('Accounts batch actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
    apiMock.getSites.mockResolvedValue([
      { id: 1, name: 'Site A', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        siteId: 1,
        username: 'alpha',
        accessToken: 'session-alpha',
        status: 'active',
        site: { id: 1, name: 'Site A', status: 'active', platform: 'new-api' },
      },
      {
        id: 2,
        siteId: 1,
        username: 'beta',
        accessToken: 'session-beta',
        status: 'active',
        site: { id: 1, name: 'Site A', status: 'active', platform: 'new-api' },
      },
    ]);
    apiMock.batchUpdateAccounts.mockResolvedValue({
      success: true,
      successIds: [1, 2],
      failedItems: [],
    });
    apiMock.refreshAccountHealth.mockResolvedValue({ success: true });
    apiMock.refreshAllAccountCredentials.mockResolvedValue({
      success: true,
      summary: { success: 1, skipped: 1, failed: 0 },
    });
    apiMock.refreshAccountCredential.mockResolvedValue({
      success: true,
      status: 'success',
      refreshed: true,
    });
    apiMock.refreshBalance.mockResolvedValue({
      success: true,
      balance: 100,
      used: 0,
      quota: 100,
    });
    apiMock.triggerCheckin.mockResolvedValue({ success: true, message: '签到成功' });
    apiMock.triggerCheckinAll.mockResolvedValue({
      success: true,
      queued: true,
      jobId: 'checkin-task-1',
      status: 'pending',
      message: '已开始全部签到，请稍后查看签到日志',
    });
    apiMock.getTask.mockResolvedValue({
      success: true,
      task: {
        id: 'checkin-task-1',
        status: 'pending',
        message: '全部账号签到已开始执行',
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes balance for selected accounts through the batch toolbar', async () => {
    let root!: WebTestRenderer;
    try {
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

      const checkboxA = root.root.find((node) => node.props['data-testid'] === 'account-select-1');
      const checkboxB = root.root.find((node) => node.props['data-testid'] === 'account-select-2');
      await act(async () => {
        checkboxA.props.onChange({ target: { checked: true } });
        checkboxB.props.onChange({ target: { checked: true } });
      });

      const batchButton = root.root.find((node) => node.props['data-testid'] === 'accounts-batch-refresh-balance');
      await act(async () => {
        batchButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.batchUpdateAccounts).toHaveBeenCalledWith({
        ids: [1, 2],
        action: 'refreshBalance',
      });
    } finally {
      root?.unmount();
    }
  });



  it('shows credential health separately from runtime health', async () => {
    let root!: WebTestRenderer;
    try {
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

      const text = collectText(root.root);
      expect(text).toContain('凭证健康状态');
      expect(text).toContain('运行健康状态');
      expect(text).toContain('凭证正常');
    } finally {
      root?.unmount();
    }
  });

  it('shows credential refresh actions for all accounts and one account', async () => {
    let root!: WebTestRenderer;
    try {
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

      const refreshAllCredentialButton = root.root.find(
        (node) => node.props['data-testid'] === 'accounts-refresh-all-credentials',
      );
      await act(async () => {
        refreshAllCredentialButton.props.onClick();
      });
      await flushMicrotasks();
      expect(apiMock.refreshAllAccountCredentials).toHaveBeenCalledTimes(1);

      const accountCredentialButtons = root.root.findAll(
        (node) => node.props['data-testid'] === 'account-refresh-credential-1',
      );
      expect(accountCredentialButtons.length).toBeGreaterThan(0);
      await act(async () => {
        await accountCredentialButtons[0]!.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.refreshAccountCredential).toHaveBeenCalledWith(1);
    } finally {
      root?.unmount();
    }
  });

  it('selects an account when clicking the row instead of only the checkbox', async () => {
    let root!: WebTestRenderer;
    try {
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

      const row = root.root.find((node) => node.props['data-testid'] === 'account-row-1');
      await act(async () => {
        row.props.onClick({ target: { closest: () => null } });
      });
      await flushMicrotasks();

      const checkbox = root.root.find((node) => node.props['data-testid'] === 'account-select-1');
      expect(checkbox.props.checked).toBe(true);
    } finally {
      root?.unmount();
    }
  });

  it('shows a visible background task status after triggering all checkins', async () => {
    let root!: WebTestRenderer;
    try {
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

      const checkinButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('全部签到')
      ));
      await act(async () => {
        await checkinButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.triggerCheckinAll).toHaveBeenCalledTimes(1);
      const text = collectText(root.root);
      expect(text).toContain('签到任务已提交');
      expect(text).toContain('checkin-task-1');
      expect(collectText(checkinButton)).toContain('签到中...');
      expect(checkinButton.props.disabled).toBe(true);
    } finally {
      root?.unmount();
    }
  });

  it('updates the visible checkin status when the background task finishes', async () => {
    apiMock.getTask.mockResolvedValueOnce({
      success: true,
      task: {
        id: 'checkin-task-1',
        status: 'succeeded',
        message: '全部账号签到完成：成功 2，跳过 0，失败 0',
        result: {
          summary: { total: 2, success: 2, skipped: 0, failed: 0 },
        },
      },
    });

    let root!: WebTestRenderer;
    try {
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

      const checkinButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('全部签到')
      ));
      await act(async () => {
        await checkinButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.getTask).toHaveBeenCalledWith('checkin-task-1');
      const text = collectText(root.root);
      expect(text).toContain('签到任务已完成');
      expect(text).toContain('全部账号签到完成：成功 2，跳过 0，失败 0');
    } finally {
      root?.unmount();
    }
  });


  it('shows all-checkin partial failures as an error instead of a completed success', async () => {
    apiMock.getTask.mockResolvedValueOnce({
      success: true,
      task: {
        id: 'checkin-task-1',
        status: 'succeeded',
        message: '全部账号签到完成：成功 1，跳过 0，失败 1',
        result: {
          summary: { total: 2, success: 1, skipped: 0, failed: 1 },
          results: [
            { accountId: 1, result: { success: true, status: 'success' } },
            { accountId: 2, result: { success: false, status: 'failed', message: 'provider_session_expired' } },
          ],
        },
      },
    });

    let root!: WebTestRenderer;
    try {
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

      const checkinButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('全部签到')
      ));
      await act(async () => {
        await checkinButton.props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('签到任务部分失败');
      expect(text).toContain('全部账号签到完成：成功 1，跳过 0，失败 1');
      const errorToasts = root.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('toast-error')
      ));
      expect(errorToasts.some((node) => collectText(node).includes('失败 1'))).toBe(true);
      expect(text).not.toContain('签到任务已完成');
    } finally {
      root?.unmount();
    }
  });

  it('shows the backend failure instead of a fixed check-in completed toast', async () => {
    apiMock.triggerCheckin.mockResolvedValueOnce({
      success: true,
      queued: true,
      jobId: 'checkin-account-1',
      status: 'pending',
      message: '签到任务已提交',
    });
    apiMock.getTask.mockResolvedValueOnce({
      success: true,
      task: {
        id: 'checkin-account-1',
        status: 'failed',
        message: '账号 #1 签到失败：upstream_html_response',
        error: 'upstream_html_response',
      },
    });
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider><Accounts /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const buttons = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node) === '签到'
      ));
      expect(buttons.length).toBeGreaterThan(0);
      await act(async () => { await buttons[0]!.props.onClick(); });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('upstream_html_response');
      expect(text).not.toContain('签到完成');
    } finally {
      root?.unmount();
    }
  });

  it('renders a structured check-in failure as an error toast even when the background runner completed', async () => {
    apiMock.triggerCheckin.mockResolvedValueOnce({
      success: true,
      queued: true,
      jobId: 'checkin-account-1',
      status: 'pending',
      message: '签到任务已提交',
    });
    apiMock.getTask.mockResolvedValueOnce({
      success: true,
      task: {
        id: 'checkin-account-1',
        status: 'succeeded',
        message: 'AgentRouter 已重新登录并保存新凭证，但签到奖励尚未确认',
        result: {
          success: false,
          status: 'failed',
          credentialsRefreshed: true,
          reasonCode: 'agentrouter_balance_unconfirmed',
          message: 'AgentRouter 已重新登录并保存新凭证，但签到奖励尚未确认',
        },
      },
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider><Accounts /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const button = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node) === '签到'
      ))[0]!;
      await act(async () => { await button.props.onClick(); });
      await flushMicrotasks();

      const errorToasts = root.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('toast-error')
      ));
      expect(errorToasts.some((node) => collectText(node).includes('签到奖励尚未确认'))).toBe(true);
      expect(apiMock.getAccountsSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      root?.unmount();
    }
  });

  it('shows the backend reward and latest total quota after a successful single check-in', async () => {
    apiMock.triggerCheckin.mockResolvedValueOnce({
      success: true,
      queued: true,
      jobId: 'checkin-account-1',
      status: 'pending',
      message: '签到任务已提交',
    });
    apiMock.getTask.mockResolvedValueOnce({
      success: true,
      task: {
        id: 'checkin-account-1',
        status: 'succeeded',
        message: '签到成功：总额度 +25，当前总额度 1125',
        result: {
          success: true,
          status: 'success',
          message: '签到成功',
          reward: '总额度 +25',
          balanceInfo: { balance: 1100, used: 25, quota: 1125 },
        },
      },
    });
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider><Accounts /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const button = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node) === '签到'
      ))[0]!;
      await act(async () => { await button.props.onClick(); });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('签到成功');
      expect(text).toContain('总额度 +25');
      expect(text).toContain('当前总额度 1125');
      expect(apiMock.getAccountsSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      root?.unmount();
    }
  });


  it('applies the terminal target balance directly to the row without issuing a second timeout-prone snapshot request', async () => {
    apiMock.triggerCheckin.mockResolvedValueOnce({
      success: true,
      queued: true,
      jobId: 'checkin-account-live-balance',
      status: 'pending',
      message: '签到任务已提交',
    });
    apiMock.getTask.mockResolvedValueOnce({
      success: true,
      task: {
        id: 'checkin-account-live-balance',
        status: 'succeeded',
        message: '已签到，额度无新增，当前总额度 875',
        result: {
          success: false,
          skipped: true,
          status: 'skipped',
          alreadyCheckedIn: true,
          message: '已签到，额度无新增，当前总额度 875',
          balanceInfo: { balance: 875, used: 0, quota: 875 },
        },
      },
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider><Accounts /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const button = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node) === '签到'
      ))[0]!;
      await act(async () => { await button.props.onClick(); });
      await flushMicrotasks();

      expect(collectText(root.root)).toContain('$875.00');
      expect(apiMock.getAccountsSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      root?.unmount();
    }
  });

  it('deduplicates two clicks while the same row check-in submission is in flight', async () => {
    let release!: (value: any) => void;
    apiMock.triggerCheckin.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider><Accounts /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const button = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node) === '签到'
      ))[0]!;
      let first!: Promise<void>;
      let second!: Promise<void>;
      await act(async () => {
        first = button.props.onClick();
        second = button.props.onClick();
        await Promise.resolve();
      });
      expect(apiMock.triggerCheckin).toHaveBeenCalledTimes(1);

      release({ success: false, message: 'target_failed' });
      await act(async () => { await Promise.all([first, second]); });
    } finally {
      root?.unmount();
    }
  });


  it('disables balance refresh and check-in while a credential operation is running for the same account', async () => {
    let releaseStart!: (value: any) => void;
    apiMock.refreshAccountCredential.mockImplementationOnce(() => new Promise((resolve) => {
      releaseStart = resolve;
    }));

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider><Accounts /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const credentialButton = root.root.find(
        (node) => node.props['data-testid'] === 'account-refresh-credential-1',
      );
      await act(async () => {
        void credentialButton.props.onClick();
        await Promise.resolve();
      });

      const balanceButton = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node) === '刷新'
      ))[0]!;
      const checkinButton = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node) === '签到'
      ))[0]!;
      expect(balanceButton.props.disabled).toBe(true);
      expect(checkinButton.props.disabled).toBe(true);

      releaseStart({ success: true, status: 'success', refreshed: true, message: '凭证已刷新' });
      await flushMicrotasks();
    } finally {
      root?.unmount();
    }
  });

  it('polls a queued credential refresh and keeps the row action asynchronous', async () => {
    apiMock.refreshAccountCredential.mockResolvedValueOnce({
      success: true,
      queued: true,
      jobId: 'credential-account-1',
      status: 'pending',
      message: '凭证刷新任务已提交',
    });
    apiMock.getTask.mockResolvedValueOnce({
      success: true,
      task: {
        id: 'credential-account-1',
        status: 'succeeded',
        message: '凭证已刷新',
        result: { accountId: 1, status: 'success', refreshed: true, message: '凭证已刷新' },
      },
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider><Accounts /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const button = root.root.findAll(
        (node) => node.props['data-testid'] === 'account-refresh-credential-1',
      )[0]!;
      await act(async () => { button.props.onClick(); });
      await flushMicrotasks();

      expect(apiMock.getTask).toHaveBeenCalledWith('credential-account-1');
      expect(collectText(root.root)).toContain('凭证已刷新');
      expect(apiMock.getAccountsSnapshot).toHaveBeenCalledWith({ refresh: true });
    } finally {
      root?.unmount();
    }
  });

  it('polls a queued all-credential refresh instead of waiting on one long request', async () => {
    apiMock.refreshAllAccountCredentials.mockResolvedValueOnce({
      success: true,
      queued: true,
      jobId: 'credential-all-1',
      status: 'pending',
      message: '全部账号凭证刷新任务已提交',
    });
    apiMock.getTask.mockResolvedValueOnce({
      success: true,
      task: {
        id: 'credential-all-1',
        status: 'succeeded',
        message: '刷新凭证完成：成功 1，跳过 1，失败 0',
        result: { total: 2, success: 1, skipped: 1, failed: 0, results: [] },
      },
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider><Accounts /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const button = root.root.find(
        (node) => node.props['data-testid'] === 'accounts-refresh-all-credentials',
      );
      await act(async () => { button.props.onClick(); });
      await flushMicrotasks();

      expect(apiMock.getTask).toHaveBeenCalledWith('credential-all-1');
      expect(collectText(root.root)).toContain('刷新凭证完成：成功 1，跳过 1，失败 0');
    } finally {
      root?.unmount();
    }
  });

  it('shows all-credential partial failures as an error instead of a successful refresh', async () => {
    apiMock.refreshAllAccountCredentials.mockResolvedValueOnce({
      success: true,
      queued: true,
      jobId: 'credential-all-1',
      status: 'pending',
      message: '全部账号凭证刷新任务已提交',
    });
    apiMock.getTask.mockResolvedValueOnce({
      success: true,
      task: {
        id: 'credential-all-1',
        status: 'succeeded',
        message: '刷新凭证完成：成功 1，跳过 0，失败 1',
        result: { total: 2, success: 1, skipped: 0, failed: 1, results: [] },
      },
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider><Accounts /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const button = root.root.find(
        (node) => node.props['data-testid'] === 'accounts-refresh-all-credentials',
      );
      await act(async () => { button.props.onClick(); });
      await flushMicrotasks();

      const errorToasts = root.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('toast-error')
      ));
      expect(errorToasts.some((node) => collectText(node).includes('失败 1'))).toBe(true);
      const successToasts = root.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('toast-success')
      ));
      expect(successToasts.some((node) => collectText(node).includes('失败 1'))).toBe(false);
    } finally {
      root?.unmount();
    }
  });

  it('polls a queued balance refresh and shows the refreshed quota', async () => {
    apiMock.refreshBalance.mockResolvedValueOnce({
      success: true,
      queued: true,
      jobId: 'balance-account-1',
      status: 'pending',
      message: '余额刷新任务已提交',
    });
    apiMock.getTask.mockResolvedValueOnce({
      success: true,
      task: {
        id: 'balance-account-1',
        status: 'succeeded',
        message: '账号 #1 余额已刷新，当前总额度 1125',
        result: { balance: 1100, used: 25, quota: 1125 },
      },
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider><Accounts /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const buttons = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node) === '刷新'
      ));
      expect(buttons.length).toBeGreaterThan(0);
      await act(async () => { buttons[0]!.props.onClick(); });
      await flushMicrotasks();

      expect(apiMock.refreshBalance).toHaveBeenCalledWith(1);
      expect(apiMock.getTask).toHaveBeenCalledWith('balance-account-1');
      expect(collectText(root.root)).toContain('当前总额度 1125');
    } finally {
      root?.unmount();
    }
  });

  it('selects an apikey connection when clicking the row in the apikey segment', async () => {
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        siteId: 1,
        username: 'session-user',
        accessToken: 'session-alpha',
        apiToken: 'sk-session',
        credentialMode: 'session',
        status: 'active',
        site: { id: 1, name: 'Site A', status: 'active', platform: 'new-api' },
      },
      {
        id: 2,
        siteId: 1,
        username: '',
        accessToken: '',
        apiToken: 'sk-apikey',
        credentialMode: 'apikey',
        status: 'active',
        site: { id: 1, name: 'Site A', status: 'active', platform: 'new-api' },
      },
    ]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=apikey']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const row = root.root.find((node) => node.props['data-testid'] === 'account-row-2');
      await act(async () => {
        row.props.onClick({ target: { closest: () => null } });
      });
      await flushMicrotasks();

      const checkbox = root.root.find((node) => node.props['data-testid'] === 'account-select-2');
      expect(checkbox.props.checked).toBe(true);
    } finally {
      root?.unmount();
    }
  });
});
