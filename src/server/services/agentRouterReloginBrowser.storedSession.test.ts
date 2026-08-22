import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  resolveFingerprint: vi.fn(async () => "seed"),
  installBridge: vi.fn(async () => {}),
  advanceProvider: vi.fn(async () => {}),
  solveWaf: vi.fn(async () => ({ code: 'T001', verified: true, attempts: 1 })),
}));

vi.mock("./browserAutomationRuntime.js", () => ({
  resolvePersistentBrowserFingerprintSeed: mocks.resolveFingerprint,
}));

vi.mock("./site-auth/targetSiteBrowserSession.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    launchTargetProfileNativeContext: mocks.launch,
    installStandaloneOauthNavigationBridge: mocks.installBridge,
    advanceTargetProviderLogin: mocks.advanceProvider,
  };
});

vi.mock("./site-auth/aliyunWafSlider.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    solveAliyunWafSliderPage: mocks.solveWaf,
  };
});

describe("AgentRouter stored target Session bootstrap", () => {
  let dataDir = "";
  const originalDataDir = process.env.DATA_DIR;
  const originalBrowserApiTimeout = process.env.AGENTROUTER_BROWSER_API_TIMEOUT_MS;

  afterEach(async () => {
    mocks.launch.mockReset();
    mocks.installBridge.mockClear();
    mocks.advanceProvider.mockReset();
    mocks.solveWaf.mockClear();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = "";
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalBrowserApiTimeout === undefined) delete process.env.AGENTROUTER_BROWSER_API_TIMEOUT_MS;
    else process.env.AGENTROUTER_BROWSER_API_TIMEOUT_MS = originalBrowserApiTimeout;
    vi.resetModules();
  });

  it("injects the database Session cookie into the staged Profile before reading self", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "metapi-agent-session-"));
    process.env.DATA_DIR = dataDir;
    const accountId = 93002;
    await mkdir(
      join(
        dataDir,
        "browser-profiles",
        "accounts",
        "agentrouter",
        String(accountId),
      ),
      { recursive: true },
    );

    const page = {
      url: vi.fn(() => "https://agentrouter.org/login"),
      on: vi.fn(),
      evaluate: vi.fn(async () => null),
      goto: vi.fn(async () => {}),
    };
    const context = {
      pages: vi.fn(() => [page]),
      on: vi.fn(),
      addCookies: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      cookies: vi.fn(async () => []),
    };
    mocks.launch.mockResolvedValue({ context, page });

    const { openAgentRouterReloginBrowser } =
      await import("./agentRouterReloginBrowser.js");
    const session = await openAgentRouterReloginBrowser(
      {
        id: accountId,
        username: "github_51978",
        accessToken: "acw_sc__v2=stale; acw_sc__v3=solved-waf; acw_tc=stored-waf; session=stored-target-session",
        extraConfig: JSON.stringify({ platformUserId: 51978 }),
      } as never,
      {
        platform: "agentrouter",
        url: "https://agentrouter.org",
      } as never,
    );

    expect(context.addCookies).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          name: "session",
          value: "stored-target-session",
          domain: "agentrouter.org",
        }),
        expect.objectContaining({
          name: "acw_tc",
          value: "stored-waf",
          domain: "agentrouter.org",
        }),
        expect.objectContaining({
          name: "acw_sc__v3",
          value: "solved-waf",
          domain: "agentrouter.org",
        }),
      ]),
    );
    await session.close();
    await session.discardProfile();
  });
  it("opens the console before reading a stored-session balance", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "metapi-agent-stored-balance-"));
    process.env.DATA_DIR = dataDir;
    const accountId = 93005;
    await mkdir(
      join(
        dataDir,
        "browser-profiles",
        "accounts",
        "agentrouter",
        String(accountId),
      ),
      { recursive: true },
    );

    const page = {
      url: vi.fn(() => "https://agentrouter.org/login"),
      on: vi.fn(),
      evaluate: vi.fn(async () => ({
        consoleBalance: {
          balanceText: "当前余额\\n$800.00",
          usedText: "历史消耗\\n$2.22",
        },
        storedUser: null,
        fetchedUsers: [
          { success: true, data: { id: 166363, quota: 0, used_quota: 0 } },
        ],
      })),
      goto: vi.fn(async () => {}),
    };
    const context = {
      pages: vi.fn(() => [page]),
      on: vi.fn(),
      addCookies: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      cookies: vi.fn(async () => []),
    };
    mocks.launch.mockResolvedValue({ context, page });

    const { openAgentRouterReloginBrowser } =
      await import("./agentRouterReloginBrowser.js");
    const session = await openAgentRouterReloginBrowser(
      {
        id: accountId,
        username: "github_166363",
        accessToken: "session=stored-target-session",
        extraConfig: JSON.stringify({ platformUserId: 166363 }),
      } as never,
      {
        platform: "agentrouter",
        url: "https://agentrouter.org",
      } as never,
    );

    await expect(session.readCurrentUser()).resolves.toMatchObject({
      id: 166363,
      balanceInfo: { balance: 800, used: 2.22, quota: 802.22 },
    });
    expect(page.goto).toHaveBeenCalledWith(
      "https://agentrouter.org/console",
      expect.any(Object),
    );
    await session.close();
    await session.discardProfile();
  });

  it("ignores a zero self placeholder and returns the populated browser storage balance after OAuth", async () => {
    dataDir = await mkdtemp(
      join(tmpdir(), "metapi-agent-browser-storage-balance-"),
    );
    process.env.DATA_DIR = dataDir;
    const accountId = 93004;
    await mkdir(
      join(
        dataDir,
        "browser-profiles",
        "accounts",
        "agentrouter",
        String(accountId),
      ),
      { recursive: true },
    );

    let responseHandler: ((response: any) => void) | null = null;
    const pageSnapshot = {
      consoleBalance: null,
      storedUser: {
        id: 166363,
        username: "github_166363",
        quota: 375_000_000,
        used_quota: 0,
      },
      fetchedUsers: [
        { success: true, data: { id: 166363, quota: 0, used_quota: 0 } },
      ],
    };
    const page = {
      url: vi.fn(() => "https://agentrouter.org/login"),
      on: vi.fn((event: string, handler: (response: any) => void) => {
        if (event === "response") responseHandler = handler;
      }),
      evaluate: vi.fn(async (expression: unknown) => {
        expect(typeof expression).toBe("string");
        return pageSnapshot;
      }),
      goto: vi.fn(async (url: string) => {
        if (url !== "https://agentrouter.org/console") return;
        responseHandler?.({
          url: () => "https://agentrouter.org/api/user/self",
          json: async () => ({
            success: true,
            data: {
              id: 166363,
              username: "github_166363",
              quota: 0,
              used_quota: 0,
            },
          }),
        });
        await Promise.resolve();
      }),
    };
    const context = {
      pages: vi.fn(() => [page]),
      on: vi.fn(),
      addCookies: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      cookies: vi.fn(async () => []),
    };
    mocks.launch.mockResolvedValue({ context, page });
    mocks.advanceProvider.mockImplementation(async () => {
      responseHandler?.({
        url: () => "https://agentrouter.org/api/oauth/github",
        json: async () => ({
          success: true,
          data: { id: 166363, checked_in: true, quota: 0, used_quota: 0 },
        }),
      });
      await Promise.resolve();
    });

    const { openAgentRouterReloginBrowser } =
      await import("./agentRouterReloginBrowser.js");
    const session = await openAgentRouterReloginBrowser(
      {
        id: accountId,
        username: "github_166363",
        accessToken: "",
        extraConfig: JSON.stringify({ platformUserId: 166363 }),
      } as never,
      {
        platform: "agentrouter",
        url: "https://agentrouter.org",
      } as never,
    );

    await expect(session.loginWithProvider("github")).resolves.toMatchObject({
      platformUserId: 166363,
      checkedIn: true,
      user: {
        id: 166363,
        balanceInfo: { balance: 750, used: 0, quota: 750 },
      },
    });
    await session.close();
    await session.discardProfile();
  });

  it("returns the browser-captured self balance from the OAuth login response flow", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "metapi-agent-browser-balance-"));
    process.env.DATA_DIR = dataDir;
    const accountId = 93003;
    await mkdir(
      join(
        dataDir,
        "browser-profiles",
        "accounts",
        "agentrouter",
        String(accountId),
      ),
      { recursive: true },
    );

    let responseHandler: ((response: any) => void) | null = null;
    const page = {
      url: vi.fn(() => "https://agentrouter.org/login"),
      on: vi.fn((event: string, handler: (response: any) => void) => {
        if (event === "response") responseHandler = handler;
      }),
      evaluate: vi.fn(async () => null),
      goto: vi.fn(async (url: string) => {
        if (url !== "https://agentrouter.org/console") return;
        responseHandler?.({
          url: () => "https://agentrouter.org/api/user/self",
          json: async () => ({
            success: true,
            data: {
              id: 51978,
              username: "github_51978",
              quota: 875044358,
              used_quota: 74955642,
            },
          }),
        });
        await Promise.resolve();
      }),
    };
    const context = {
      pages: vi.fn(() => [page]),
      on: vi.fn(),
      addCookies: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      cookies: vi.fn(async () => []),
    };
    mocks.launch.mockResolvedValue({ context, page });
    mocks.advanceProvider.mockImplementation(async () => {
      responseHandler?.({
        url: () => "https://agentrouter.org/api/oauth/github",
        json: async () => ({
          success: true,
          data: { id: 51978, checked_in: true },
        }),
      });
      await Promise.resolve();
    });

    const { openAgentRouterReloginBrowser } =
      await import("./agentRouterReloginBrowser.js");
    const session = await openAgentRouterReloginBrowser(
      {
        id: accountId,
        username: "github_51978",
        accessToken: "",
        extraConfig: JSON.stringify({ platformUserId: 51978 }),
      } as never,
      {
        platform: "agentrouter",
        url: "https://agentrouter.org",
      } as never,
    );

    await expect(session.loginWithProvider("github")).resolves.toMatchObject({
      platformUserId: 51978,
      checkedIn: true,
      user: {
        id: 51978,
        balanceInfo: { balance: 1750.088716, used: 149.911284, quota: 1900 },
      },
    });
    expect(page.goto).toHaveBeenCalledWith(
      "https://agentrouter.org/console",
      expect.any(Object),
    );
    await session.close();
    await session.discardProfile();
  });

  it("navigates a fetched Aliyun WAF response into the top-level page, solves it, and re-reads live self JSON", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "metapi-agent-waf-self-"));
    process.env.DATA_DIR = dataDir;
    const accountId = 93006;
    await mkdir(
      join(dataDir, "browser-profiles", "accounts", "agentrouter", String(accountId)),
      { recursive: true },
    );

    const page = {
      url: vi.fn(() => "https://agentrouter.org/console"),
      on: vi.fn(),
      setExtraHTTPHeaders: vi.fn(async () => {}),
      evaluate: vi.fn()
        .mockResolvedValueOnce({
          consoleBalance: null,
          storedUser: null,
          fetchedUsers: [],
          selfResponses: [{
            status: 200,
            contentType: "text/html; charset=utf-8",
            text: '<title>访问验证</title><div id="aliyunCaptcha-sliding-slider">为了更好的访问体验</div>',
          }],
        })
        .mockResolvedValueOnce({
          consoleBalance: null,
          storedUser: null,
          fetchedUsers: [{
            success: true,
            data: {
              id: 166363,
              username: "github_166363",
              quota: 398_891_256,
              used_quota: 1_108_744,
            },
          }],
          selfResponses: [{ status: 200, contentType: "application/json", text: '{"success":true}' }],
        }),
      goto: vi.fn(async () => {}),
    };
    const context = {
      pages: vi.fn(() => [page]),
      on: vi.fn(),
      addCookies: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      cookies: vi.fn(async () => []),
    };
    mocks.launch.mockResolvedValue({ context, page });

    const { openAgentRouterReloginBrowser } = await import("./agentRouterReloginBrowser.js");
    const session = await openAgentRouterReloginBrowser(
      {
        id: accountId,
        username: "github_166363",
        accessToken: "session=stored-target-session",
        extraConfig: JSON.stringify({ platformUserId: 166363 }),
      } as never,
      { platform: "agentrouter", url: "https://agentrouter.org" } as never,
    );

    await expect(session.readCurrentUser()).resolves.toEqual({
      id: 166363,
      username: "github_166363",
      balanceInfo: { balance: 797.782512, used: 2.217488, quota: 800 },
    });
    expect(page.goto).toHaveBeenCalledWith(
      "https://agentrouter.org/api/user/self",
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    expect(mocks.solveWaf).toHaveBeenCalledWith(page, expect.any(Object));
    expect(page.goto).toHaveBeenCalledWith(
      "https://agentrouter.org/console",
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    await session.close();
    await session.discardProfile();
  });


  it("does not overwrite a fresher Profile Session with the stored database Session", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "metapi-agent-profile-session-precedence-"));
    process.env.DATA_DIR = dataDir;
    const accountId = 93007;
    await mkdir(
      join(dataDir, "browser-profiles", "accounts", "agentrouter", String(accountId)),
      { recursive: true },
    );

    const page = {
      url: vi.fn(() => "https://agentrouter.org/login"),
      on: vi.fn(),
      evaluate: vi.fn(async () => null),
      goto: vi.fn(async () => {}),
    };
    const context = {
      pages: vi.fn(() => [page]),
      on: vi.fn(),
      addCookies: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      cookies: vi.fn(async () => [
        { name: "session", value: "fresh-profile-session", domain: "agentrouter.org" },
        { name: "acw_tc", value: "fresh-profile-waf", domain: "agentrouter.org" },
      ]),
    };
    mocks.launch.mockResolvedValue({ context, page });

    const { openAgentRouterReloginBrowser } = await import("./agentRouterReloginBrowser.js");
    const session = await openAgentRouterReloginBrowser(
      {
        id: accountId,
        username: "linuxdo_59260",
        accessToken: "session=stale-database-session; acw_tc=stale-database-waf",
        extraConfig: JSON.stringify({ platformUserId: 59260 }),
      } as never,
      { platform: "agentrouter", url: "https://agentrouter.org" } as never,
    );

    expect(context.addCookies).not.toHaveBeenCalled();
    await session.close();
    await session.discardProfile();
  });

  it("waits for the console's delayed live self response before declaring a Profile mismatch", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "metapi-agent-delayed-self-"));
    process.env.DATA_DIR = dataDir;
    const accountId = 93008;
    await mkdir(
      join(dataDir, "browser-profiles", "accounts", "agentrouter", String(accountId)),
      { recursive: true },
    );

    let responseHandler: ((response: any) => void) | null = null;
    let currentUrl = "https://agentrouter.org/login";
    const page = {
      url: vi.fn(() => currentUrl),
      on: vi.fn((event: string, handler: (response: any) => void) => {
        if (event === "response") responseHandler = handler;
      }),
      evaluate: vi.fn(async () => {
        setTimeout(() => {
          responseHandler?.({
            url: () => "https://agentrouter.org/api/user/self",
            json: async () => ({
              success: true,
              data: {
                id: 59260,
                username: "linuxdo_59260",
                quota: -147_478,
                used_quota: 837_647_478,
              },
            }),
          });
        }, 5);
        return {
          consoleBalance: null,
          storedUser: null,
          fetchedUsers: [],
          selfResponses: [{
            status: 200,
            contentType: "application/json",
            text: '{"success":false,"message":"temporary placeholder"}',
          }],
        };
      }),
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
      }),
    };
    const context = {
      pages: vi.fn(() => [page]),
      on: vi.fn(),
      addCookies: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      cookies: vi.fn(async () => []),
    };
    mocks.launch.mockResolvedValue({ context, page });

    const { openAgentRouterReloginBrowser } = await import("./agentRouterReloginBrowser.js");
    const session = await openAgentRouterReloginBrowser(
      {
        id: accountId,
        username: "linuxdo_59260",
        accessToken: "session=stored-target-session",
        extraConfig: JSON.stringify({ platformUserId: 59260 }),
      } as never,
      { platform: "agentrouter", url: "https://agentrouter.org" } as never,
    );

    await expect(session.readCurrentUser()).resolves.toEqual({
      id: 59260,
      username: "linuxdo_59260",
      balanceInfo: { balance: -0.294956, used: 1675.294956, quota: 1675 },
    });
    await session.close();
    await session.discardProfile();
  });


  it("solves WAF when the fetch promise stalls but the browser response exposes the full challenge body", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "metapi-agent-network-waf-"));
    process.env.DATA_DIR = dataDir;
    process.env.AGENTROUTER_BROWSER_API_TIMEOUT_MS = "20";
    const accountId = 93009;
    await mkdir(
      join(dataDir, "browser-profiles", "accounts", "agentrouter", String(accountId)),
      { recursive: true },
    );

    const responseHandlers: Array<(response: any) => void> = [];
    let evaluateCalls = 0;
    const page = {
      url: vi.fn(() => "https://agentrouter.org/console"),
      on: vi.fn((event: string, handler: (response: any) => void) => {
        if (event === "response") responseHandlers.push(handler);
      }),
      off: vi.fn(),
      setExtraHTTPHeaders: vi.fn(async () => {}),
      evaluate: vi.fn(() => {
        evaluateCalls += 1;
        if (evaluateCalls === 1) {
          setTimeout(() => {
            const wafText = `${"x".repeat(9_400)}访问验证 为了更好的访问体验 aliyunCaptcha-sliding-slider`;
            for (const handler of responseHandlers) {
              handler({
                url: () => "https://agentrouter.org/api/user/self",
                headers: () => ({ "content-type": "text/html; charset=utf-8" }),
                text: async () => wafText,
                json: async () => { throw new Error("not json"); },
              });
            }
          }, 1);
          return new Promise(() => {});
        }
        return Promise.resolve({
          consoleBalance: null,
          storedUser: null,
          fetchedUsers: [{
            success: true,
            data: {
              id: 59260,
              username: "linuxdo_59260",
              quota: -147_478,
              used_quota: 837_647_478,
            },
          }],
          selfResponses: [{ status: 200, contentType: "application/json", text: '{"success":true}' }],
        });
      }),
      goto: vi.fn(async () => {}),
    };
    const context = {
      pages: vi.fn(() => [page]),
      on: vi.fn(),
      addCookies: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      cookies: vi.fn(async () => []),
    };
    mocks.launch.mockResolvedValue({ context, page });

    const { openAgentRouterReloginBrowser } = await import("./agentRouterReloginBrowser.js");
    const session = await openAgentRouterReloginBrowser(
      {
        id: accountId,
        username: "linuxdo_59260",
        accessToken: "session=stored-target-session",
        extraConfig: JSON.stringify({ platformUserId: 59260 }),
      } as never,
      { platform: "agentrouter", url: "https://agentrouter.org" } as never,
    );

    await expect(session.readCurrentUser()).resolves.toMatchObject({
      id: 59260,
      balanceInfo: { quota: 1675 },
    });
    expect(mocks.solveWaf).toHaveBeenCalledTimes(1);
    await session.close();
    await session.discardProfile();
  });

});
