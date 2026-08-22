import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildAgentRouterUserHeaders,
  classifyAgentRouterOauthPageFailure,
  classifyProviderSessionProbe,
  commitAgentRouterReauthProfile,
  hasAgentRouterAliyunWafResponse,
  hasUsableProviderSessionCookie,
  isProviderConsentText,
  isProviderSessionExpiredPage,
  parseAgentRouterBrowserUserPayload,
  parseAgentRouterOauthCallbackPayload,
  readAgentRouterBalanceFromProfile,
  resolveAgentRouterBrowserProxyUrl,
  selectAgentRouterTargetAuthCookies,
  selectAgentRouterActivePageIndex,
  selectAgentRouterBrowserPageSnapshotUser,
  shouldContinueAgentRouterOauthAfterProviderProbe,
  summarizeAgentRouterOauthCallbackPayload,
  withAgentRouterBrowserOperationTimeout,
} from "./agentRouterReloginBrowser.js";

describe("AgentRouter relogin browser helpers", () => {
  it("stops waiting when an AgentRouter page request never settles", async () => {
    const startedAt = Date.now();
    await expect(
      withAgentRouterBrowserOperationTimeout(
        new Promise<never>(() => {}),
        10,
        null,
      ),
    ).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("prefers the newest target-site page when OAuth opens a popup", () => {
    expect(
      selectAgentRouterActivePageIndex(
        [
          "https://agentrouter.org/login",
          "https://connect.linux.do/oauth2/authorize",
          "https://agentrouter.org/oauth/linuxdo?code=done",
        ],
        "https://agentrouter.org",
      ),
    ).toBe(2);
  });

  it("uses the fixed AgentRouter egress before generic split-routing proxies", () => {
    const environment = {
      AGENTROUTER_BROWSER_PROXY_URL: "http://browser-proxy:7891",
      SITE_AUTH_BROWSER_PROXY_URL: "http://browser-proxy:7890",
    };
    expect(resolveAgentRouterBrowserProxyUrl(null, environment)).toBe(
      "http://browser-proxy:7891",
    );
    expect(
      resolveAgentRouterBrowserProxyUrl(
        JSON.stringify({ proxyUrl: "http://account-proxy:8080" }),
        environment,
      ),
    ).toBe("http://browser-proxy:7891");
    expect(
      resolveAgentRouterBrowserProxyUrl(
        JSON.stringify({ agentRouterBrowserProxyUrl: "http://dedicated-account-proxy:7891" }),
        environment,
      ),
    ).toBe("http://dedicated-account-proxy:7891");
  });

  it("sends the platform user header required by AgentRouter self lookup", () => {
    expect(buildAgentRouterUserHeaders(59260)).toMatchObject({
      "New-API-User": "59260",
      "X-Requested-With": "XMLHttpRequest",
    });
    expect(
      Object.keys(buildAgentRouterUserHeaders(59260)).filter(
        (key) => key.toLowerCase() === "new-api-user",
      ),
    ).toHaveLength(1);
  });

  it("parses browser user identity and balance from one self response", () => {
    expect(
      parseAgentRouterBrowserUserPayload({
        success: true,
        data: {
          id: 59260,
          username: "linuxdo_59260",
          quota: 419058243,
          used_quota: 255941757,
        },
      }),
    ).toEqual({
      id: 59260,
      username: "linuxdo_59260",
      balanceInfo: { balance: 838.116486, used: 511.883514, quota: 1350 },
    });
  });

  it("prefers a populated console balance and rejects zero placeholders from storage and self", () => {
    expect(
      selectAgentRouterBrowserPageSnapshotUser(
        {
          consoleBalance: {
            balanceText: "当前余额\n$750.00",
            usedText: "历史消耗\n$0.00",
          },
          storedUser: {
            id: 166363,
            username: "github_166363",
            quota: 0,
            used_quota: 0,
          },
          fetchedUsers: [
            { success: true, data: { id: 166363, quota: 0, used_quota: 0 } },
          ],
        },
        166363,
      ),
    ).toEqual({
      id: 166363,
      balanceInfo: { balance: 750, used: 0, quota: 750 },
    });
  });

  it("rejects stale console and storage balances when no live self response confirms the session", () => {
    expect(
      selectAgentRouterBrowserPageSnapshotUser(
        {
          consoleBalance: {
            balanceText: "当前余额\n$797.78",
            usedText: "历史消耗\n$2.22",
          },
          storedUser: {
            id: 166363,
            username: "github_166363",
            quota: 398_891_256,
            used_quota: 1_108_744,
          },
          fetchedUsers: [],
        },
        166363,
      ),
    ).toBeNull();
  });

  it("keeps the expected browser identity when WAF replaces every balance response with zero placeholders", () => {
    expect(
      selectAgentRouterBrowserPageSnapshotUser(
        {
          consoleBalance: {
            balanceText: "当前余额\n$0.00",
            usedText: "历史消耗\n$0.00",
          },
          storedUser: {
            id: 166363,
            username: "github_166363",
            quota: 0,
            used_quota: 0,
          },
          fetchedUsers: [
            {
              success: true,
              data: {
                id: 166363,
                username: "github_166363",
                quota: 0,
                used_quota: 0,
              },
            },
          ],
        },
        166363,
      ),
    ).toEqual({ id: 166363, username: "github_166363" });
  });


  it("honors the browser-side WAF flag when the challenge marker is beyond the returned text prefix", () => {
    expect(hasAgentRouterAliyunWafResponse({
      selfResponses: [{
        status: 200,
        contentType: "text/html; charset=utf-8",
        text: "<html><body>challenge shell</body></html>",
        wafDetected: true,
      }],
    } as never)).toBe(true);
  });

  it("summarizes OAuth callback fields without exposing session values", () => {
    const summary = summarizeAgentRouterOauthCallbackPayload({
      success: true,
      data: {
        id: 59260,
        checked_in: true,
        quota: 419058243,
        used_quota: 255941757,
        session: "secret-session-value",
        user: {
          id: 59260,
          quota: 419058243,
          used_quota: 255941757,
          access_token: "secret-token-value",
        },
      },
    });

    expect(summary).toEqual({
      bodyKeys: ["data", "success"],
      dataKeys: ["checked_in", "id", "quota", "session", "used_quota", "user"],
      userKeys: ["access_token", "id", "quota", "used_quota"],
      platformUserId: 59260,
      checkedIn: true,
      quota: 419058243,
      usedQuota: 255941757,
      nestedUserId: 59260,
      nestedQuota: 419058243,
      nestedUsedQuota: 255941757,
    });
    expect(JSON.stringify(summary)).not.toContain("secret-session-value");
    expect(JSON.stringify(summary)).not.toContain("secret-token-value");
  });

  it("parses the OAuth callback user and checked-in fields", () => {
    expect(
      parseAgentRouterOauthCallbackPayload({
        success: true,
        data: {
          id: 59260,
          username: "linuxdo_59260",
          checked_in: true,
          quota: 419058243,
          used_quota: 255941757,
        },
      }),
    ).toEqual({
      platformUserId: 59260,
      checkedIn: true,
      user: {
        id: 59260,
        username: "linuxdo_59260",
        balanceInfo: { balance: 838.116486, used: 511.883514, quota: 1350 },
      },
    });
    expect(
      parseAgentRouterOauthCallbackPayload({
        success: true,
        data: { id: 59260, checked_in: true },
      }),
    ).toEqual({ platformUserId: 59260, checkedIn: true });
    expect(
      parseAgentRouterOauthCallbackPayload({
        success: true,
        data: { id: 59260, checked_in: true, quota: 0, used_quota: 0 },
      }),
    ).toEqual({ platformUserId: 59260, checkedIn: true });
    expect(
      parseAgentRouterOauthCallbackPayload({
        success: false,
        message: "denied",
      }),
    ).toBeNull();
  });

  it("matches consent controls by rendered text or submit value", () => {
    expect(isProviderConsentText("linuxdo", ["Allow"])).toBe(true);
    expect(isProviderConsentText("linuxdo", ["", "允许"])).toBe(true);
    expect(isProviderConsentText("linuxdo", ["Cancel"])).toBe(false);
  });

  it("classifies a provider Cloudflare interstitial before the generic OAuth timeout", () => {
    expect(
      classifyAgentRouterOauthPageFailure(
        "linuxdo",
        "https://linux.do/login",
        "Just a moment...",
        "Just a moment...",
      ),
    ).toBe("provider_challenge_required");
    expect(
      classifyAgentRouterOauthPageFailure(
        "linuxdo",
        "https://linux.do/login",
        "登录 Linux Do",
        "LINUX DO",
      ),
    ).toBe("provider_session_expired");
  });

  it("classifies live provider probes before target-site logout", () => {
    expect(classifyProviderSessionProbe("linuxdo", {
      url: "https://linux.do/session/current.json",
      status: 200,
      bodyText: JSON.stringify({ current_user: { id: 59260, username: "member" } }),
    })).toBe("authenticated");
    expect(classifyProviderSessionProbe("linuxdo", {
      url: "https://linux.do/session/current.json",
      status: 200,
      bodyText: JSON.stringify({ current_user: null }),
    })).toBe("provider_session_expired");
    expect(classifyProviderSessionProbe("github", {
      url: "https://github.com/settings/profile",
      status: 200,
      bodyText: "Profile settings",
    })).toBe("authenticated");
    expect(classifyProviderSessionProbe("github", {
      url: "https://github.com/login?return_to=%2Fsettings%2Fprofile",
      status: 200,
      bodyText: "Sign in to GitHub",
    })).toBe("provider_session_expired");
    expect(classifyProviderSessionProbe("github", {
      url: "https://github.com/settings/profile",
      status: 403,
      title: "Just a moment...",
      bodyText: "Verify you are human",
    })).toBe("provider_challenge_required");
  });

  it("lets a browser OAuth attempt resolve a provider challenge without touching the formal Profile", () => {
    expect(shouldContinueAgentRouterOauthAfterProviderProbe("authenticated")).toBe(true);
    expect(shouldContinueAgentRouterOauthAfterProviderProbe("provider_challenge_required")).toBe(true);
    expect(shouldContinueAgentRouterOauthAfterProviderProbe("provider_session_expired")).toBe(false);
    expect(shouldContinueAgentRouterOauthAfterProviderProbe("provider_session_check_failed")).toBe(false);
  });

  it("selects only target authentication cookies for staged logout and preserves WAF clearance", () => {
    expect(selectAgentRouterTargetAuthCookies([
      { name: "session", value: "target-session", domain: "agentrouter.org", path: "/" },
      { name: "auth_token", value: "target-auth", domain: ".agentrouter.org", path: "/" },
      { name: "acw_tc", value: "waf", domain: "agentrouter.org", path: "/" },
      { name: "cf_clearance", value: "clearance", domain: ".agentrouter.org", path: "/" },
    ])).toEqual([
      { name: "session", value: "target-session", domain: "agentrouter.org", path: "/" },
      { name: "auth_token", value: "target-auth", domain: ".agentrouter.org", path: "/" },
    ]);
  });

  it("rejects missing and expired provider cookies before target-site logout", () => {
    const nowSeconds = 1_800_000_000;
    expect(hasUsableProviderSessionCookie("linuxdo", [
      { name: "_t", value: "linux-session", expires: nowSeconds + 3600 },
    ], nowSeconds)).toBe(true);
    expect(hasUsableProviderSessionCookie("github", [
      { name: "user_session", value: "github-session", expires: -1 },
    ], nowSeconds)).toBe(true);
    expect(hasUsableProviderSessionCookie("github", [
      { name: "user_session", value: "expired", expires: nowSeconds - 1 },
    ], nowSeconds)).toBe(false);
    expect(hasUsableProviderSessionCookie("linuxdo", [], nowSeconds)).toBe(false);
  });

  it("detects expired LinuxDO and GitHub provider sessions from login pages", () => {
    expect(
      isProviderSessionExpiredPage(
        "linuxdo",
        "https://linux.do/login",
        "登录 Linux Do",
      ),
    ).toBe(true);
    expect(
      isProviderSessionExpiredPage(
        "github",
        "https://github.com/login?return_to=%2Flogin%2Foauth",
        "Sign in to GitHub",
      ),
    ).toBe(true);
    expect(
      isProviderSessionExpiredPage(
        "github",
        "https://github.com/login/oauth/authorize?client_id=CLIENT_ID",
        "Authorize AgentRouter",
      ),
    ).toBe(false);
    expect(
      isProviderSessionExpiredPage(
        "github",
        "https://agentrouter.org/console",
        "控制台",
      ),
    ).toBe(false);
  });

  it("reads balance from a staged profile without committing it", async () => {
    const close = vi.fn(async () => {});
    const discardProfile = vi.fn(async () => {});
    const session = {
      readCurrentUser: vi.fn(async () => ({
        id: 59260,
        username: "linuxdo_59260",
        balanceInfo: { balance: 838.116486, used: 511.883514, quota: 1350 },
      })),
      close,
      discardProfile,
    };
    const account = {
      id: 94,
      username: "linuxdo_59260",
      extraConfig: JSON.stringify({ platformUserId: 59260 }),
    };
    const site = { platform: "agentrouter", url: "https://agentrouter.org" };

    await expect(
      readAgentRouterBalanceFromProfile(account as never, site as never, {
        openBrowser: async () => session as never,
      }),
    ).resolves.toEqual({ balance: 838.116486, used: 511.883514, quota: 1350 });
    expect(close).toHaveBeenCalledTimes(1);
    expect(discardProfile).toHaveBeenCalledTimes(1);
  });

  it("can roll back a staged profile replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrouter-profile-"));
    const formal = join(root, "94");
    const staged = join(root, "reauth-94");
    await mkdir(formal);
    await mkdir(staged);
    await writeFile(join(formal, "marker"), "old");
    await writeFile(join(staged, "marker"), "new");

    const transaction = await commitAgentRouterReauthProfile(staged, formal);
    expect(await readFile(join(formal, "marker"), "utf8")).toBe("new");
    await transaction.rollback();
    expect(await readFile(join(formal, "marker"), "utf8")).toBe("old");
  });

  it("leaves the formal profile untouched when the staged profile is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrouter-profile-fail-"));
    const formal = join(root, "94");
    await mkdir(formal);
    await writeFile(join(formal, "marker"), "old");

    await expect(
      commitAgentRouterReauthProfile(join(root, "missing"), formal),
    ).rejects.toThrow();
    expect(await readFile(join(formal, "marker"), "utf8")).toBe("old");
  });
});
