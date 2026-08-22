import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { schema } from '../db/index.js';
import { config } from '../config.js';
import { resolveAgentRouterBrowserProxyUrl, parseAgentRouterBrowserUserPayload } from './agentRouterReloginBrowser.js';
import {
  buildTargetSessionCookieHeader,
  launchTargetProfileNativeContext,
  parseTargetSessionCookieHeader,
} from './site-auth/targetSiteBrowserSession.js';

type SiteLike = typeof schema.sites.$inferSelect;

export type AgentRouterSessionBrowserVerification = {
  accessToken: string;
  platformUserId: number;
  username?: string;
  balance?: { balance: number; used: number; quota: number };
  profileDir: string;
  provider: 'agentrouter';
};

function normalizeBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('site url is required');
  return baseUrl;
}

function resolveInputCookies(accessToken: string): Array<{ name: string; value: string }> {
  const raw = accessToken.trim().replace(/^Bearer\s+/i, '');
  if (!raw) return [];
  const parsed = parseTargetSessionCookieHeader(raw);
  return parsed.length > 0 ? parsed : [{ name: 'session', value: raw }];
}

export async function discardAgentRouterSessionVerificationProfile(profileDir: string): Promise<void> {
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

export async function verifyAgentRouterSessionInBrowser(input: {
  site: SiteLike;
  accessToken: string;
  platformUserId?: number;
  profileDir?: string;
}): Promise<AgentRouterSessionBrowserVerification> {
  if (String(input.site.platform || '').trim().toLowerCase() !== 'agentrouter') {
    throw new Error('browser_session_verification_not_supported');
  }

  const baseUrl = normalizeBaseUrl(input.site.url);
  const targetHost = new URL(baseUrl).hostname;
  const profileDir = input.profileDir || resolve(
    config.dataDir,
    'browser-profiles',
    'session-verification',
    'agentrouter',
    `pending-${randomUUID()}`,
  );
  const cookies = resolveInputCookies(input.accessToken);
  if (cookies.length === 0) throw new Error('Session Token 不能为空');

  let context: Awaited<ReturnType<typeof launchTargetProfileNativeContext>>['context'] | null = null;
  try {
    const started = await launchTargetProfileNativeContext({
      profileDir,
      loginUrl: `${baseUrl}/login`,
      proxyUrl: resolveAgentRouterBrowserProxyUrl(null),
    });
    context = started.context;
    const page = started.page;
    await context.addCookies(cookies.map((cookie) => ({
      ...cookie,
      domain: targetHost,
      path: '/',
      secure: true,
      httpOnly: true,
    })));

    if (input.platformUserId) {
      await page.setExtraHTTPHeaders({
        'New-API-User': String(Math.trunc(input.platformUserId)),
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      });
    }

    const response = await page.goto(`${baseUrl}/api/user/self`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    const text = await page.locator('body').innerText({ timeout: 8_000 }).catch(() => '');
    let payload: unknown = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    const user = parseAgentRouterBrowserUserPayload(payload);
    if (!response?.ok() || !user) throw new Error('Session Token 浏览器验证失败');
    if (input.platformUserId && user.id !== Math.trunc(input.platformUserId)) {
      throw new Error('profile_account_mismatch');
    }

    const storedCookies = await context.cookies(baseUrl);
    const verifiedAccessToken = buildTargetSessionCookieHeader(storedCookies, targetHost);
    if (!verifiedAccessToken) throw new Error('managed browser login cookie not found');

    await context.close();
    context = null;
    return {
      accessToken: verifiedAccessToken,
      platformUserId: user.id,
      ...(user.username ? { username: user.username } : {}),
      ...(user.balanceInfo ? { balance: user.balanceInfo } : {}),
      profileDir,
      provider: 'agentrouter',
    };
  } catch (error) {
    await context?.close().catch(() => {});
    await discardAgentRouterSessionVerificationProfile(profileDir);
    throw error;
  }
}
