import type { RequestInit as UndiciRequestInit } from 'undici';
import { createContext, runInContext } from 'node:vm';
import { withSiteProxyRequestInit } from '../siteProxy.js';

const SHIELD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

const SESSION_COOKIE_NAMES = new Set([
  'session',
  'token',
  'auth_token',
  'access_token',
  'jwt',
  'jwt_token',
]);

function stripCredentialPrefix(value: string): string {
  return value
    .trim()
    .replace(/^cookie\s*:\s*/i, '')
    .replace(/^bearer\s+/i, '')
    .trim();
}

function isCookieHeader(value: string): boolean {
  if (value.includes(';')) return true;
  if (/^(?:session|token|auth[_-]?token|access[_-]?token|jwt(?:[_-]?token)?)\s*=/i.test(value)) return true;
  // A padded bare base64 token ends in '='; a named cookie has a value after it.
  return /^[!#$%&'*+.^_`|~0-9a-z-]+\s*=[^=]/i.test(value);
}

function parseCookiePairs(value: string): Array<{ name: string; value: string }> {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const separator = part.indexOf('=');
      if (separator <= 0) return [];
      const name = part.slice(0, separator).trim();
      const cookieValue = part.slice(separator + 1).trim().replace(/[\r\n\t]+/g, '');
      if (!name || !cookieValue) return [];
      return [{ name, value: cookieValue }];
    });
}

function normalizeCookieHeader(value: string): string {
  return parseCookiePairs(value)
    .map(({ name, value: cookieValue }) => `${name}=${cookieValue}`)
    .join('; ');
}

export function normalizeNewApiCredential(token: string): string {
  const stripped = stripCredentialPrefix(token || '');
  if (!stripped) return '';
  if (isCookieHeader(stripped)) return normalizeCookieHeader(stripped);
  return stripped.replace(/\s+/g, '');
}

export function buildNewApiCookieCandidates(token: string): string[] {
  const normalized = normalizeNewApiCredential(token);
  if (!normalized) return [];

  const candidates: string[] = [];
  if (isCookieHeader(normalized)) {
    candidates.push(normalized);
    for (const pair of parseCookiePairs(normalized)) {
      const name = pair.name.toLowerCase();
      if (SESSION_COOKIE_NAMES.has(name) || name.includes('session') || name.includes('token') || name.includes('auth')) {
        candidates.push(`${pair.name}=${pair.value}`);
      }
      if (name === 'session') candidates.push(`session=${pair.value}`);
      if (name === 'token') candidates.push(`token=${pair.value}`);
    }
  } else {
    candidates.push(`session=${normalized}`);
    candidates.push(`token=${normalized}`);
  }

  return Array.from(new Set(candidates));
}

export function hasUsableSessionCookie(cookieHeader: string): boolean {
  if (!cookieHeader) return false;
  return parseCookiePairs(normalizeNewApiCredential(cookieHeader)).some(({ name }) => {
    const normalizedName = name.toLowerCase();
    return !['acw_tc', 'acw_sc__v2', 'cdn_sec_tc'].includes(normalizedName)
      && (SESSION_COOKIE_NAMES.has(normalizedName)
        || normalizedName.includes('session')
        || normalizedName.includes('token')
        || normalizedName.includes('auth'));
  });
}

function parseChallengeArg1(html: string): string | null {
  const match = html.match(/var\s+arg1\s*=\s*['"]([0-9a-fA-F]+)['"]/);
  return match?.[1]?.toUpperCase() || null;
}

function parseChallengeMapping(html: string): number[] | null {
  const match = html.match(/for\(var m=\[([^\]]+)\],p=L\(0x115\)/);
  if (!match?.[1]) return null;

  const values = match[1].split(',').map((raw) => {
    const value = raw.trim().toLowerCase();
    if (!value) return Number.NaN;
    if (value.startsWith('0x')) return Number.parseInt(value.slice(2), 16);
    return Number.parseInt(value, 10);
  });

  if (values.some((value) => Number.isNaN(value))) return null;
  return values;
}

function parseChallengeXorSeed(html: string): string | null {
  const fnStart = html.indexOf('function a0i()');
  const bStart = html.indexOf('function b(');
  const rotateStart = html.indexOf('(function(a,c){');
  const rotateEnd = html.indexOf('),!(function', rotateStart);
  if (fnStart < 0 || bStart < 0 || bStart <= fnStart || rotateStart < 0 || rotateEnd < 0) {
    return null;
  }

  const helperCode = html.slice(fnStart, bStart);
  const rotateCode = `${html.slice(rotateStart, rotateEnd + 1)})`;

  try {
    const sandbox: Record<string, unknown> = { decodeURIComponent };
    createContext(sandbox);
    runInContext(helperCode, sandbox, { timeout: 100 });
    runInContext(rotateCode, sandbox, { timeout: 100 });
    const decoder = sandbox.a0j;
    if (typeof decoder !== 'function') return null;
    const seed = (decoder as (index: number) => unknown)(0x115);
    if (typeof seed !== 'string' || !/^[0-9a-f]+$/i.test(seed)) return null;
    return seed;
  } catch {
    return null;
  }
}

export function solveNewApiAcwScV2(html: string): string | null {
  const arg1 = parseChallengeArg1(html);
  const mapping = parseChallengeMapping(html);
  const xorSeed = parseChallengeXorSeed(html);
  if (!arg1 || !mapping || !xorSeed) return null;

  const reordered: string[] = [];
  for (let i = 0; i < arg1.length; i += 1) {
    const ch = arg1[i];
    for (let j = 0; j < mapping.length; j += 1) {
      if (mapping[j] === i + 1) {
        reordered[j] = ch;
      }
    }
  }

  const source = reordered.join('');
  let out = '';
  for (let i = 0; i < source.length && i < xorSeed.length; i += 2) {
    const left = Number.parseInt(source.slice(i, i + 2), 16);
    const right = Number.parseInt(xorSeed.slice(i, i + 2), 16);
    if (Number.isNaN(left) || Number.isNaN(right)) return null;
    out += (left ^ right).toString(16).padStart(2, '0');
  }

  return out || null;
}

function isShieldChallenge(contentType: string, text: string): boolean {
  const normalizedType = (contentType || '').toLowerCase();
  if (normalizedType.includes('text/html') && /var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc|<script/i.test(text)) {
    return true;
  }
  return /var\s+arg1\s*=/.test(text);
}

function normalizeHeaders(headers?: UndiciRequestInit['headers']): Record<string, string> {
  const output: Record<string, string> = {};
  if (!headers) return output;

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      output[String(key)] = String(value);
    }
    return output;
  }

  const maybeIterable = headers as { forEach?: (fn: (value: string, key: string) => void) => void };
  if (typeof maybeIterable.forEach === 'function') {
    maybeIterable.forEach((value, key) => {
      output[key] = value;
    });
    return output;
  }

  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    output[key] = String(value);
  }
  return output;
}

function upsertCookie(cookieHeader: string, name: string, value: string): string {
  const parts = cookieHeader.split(';').map((part) => part.trim()).filter(Boolean);
  let replaced = false;
  const next = parts.map((part) => {
    const eq = part.indexOf('=');
    if (eq < 0) return part;
    const key = part.slice(0, eq).trim();
    if (key !== name) return part;
    replaced = true;
    return `${name}=${value}`;
  });
  if (!replaced) next.push(`${name}=${value}`);
  return next.join('; ');
}

function mergeSetCookiePairs(cookieHeader: string, setCookieHeaders: string[]): string {
  let merged = cookieHeader;
  for (const raw of setCookieHeaders) {
    if (!raw) continue;
    const firstPair = raw.split(';')[0]?.trim();
    if (!firstPair) continue;
    const eq = firstPair.indexOf('=');
    if (eq <= 0) continue;
    const name = firstPair.slice(0, eq).trim();
    const value = firstPair.slice(eq + 1);
    merged = upsertCookie(merged, name, value);
  }
  return merged;
}

function parseJsonSafe<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function collectSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(headers) || [];
  }

  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export async function fetchJsonWithShieldCookieRetry<T>(
  url: string,
  options?: UndiciRequestInit,
): Promise<{ data: T | null; cookieHeader: string }> {
  const { fetch } = await import('undici');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': SHIELD_USER_AGENT,
    ...normalizeHeaders(options?.headers),
  };

  let cookieHeader = headers.Cookie || headers.cookie || '';
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
    delete headers.cookie;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestOptions: UndiciRequestInit = {
      ...options,
      body: options?.body ?? undefined,
      headers,
    };
    const proxiedRequestOptions = await withSiteProxyRequestInit(url, requestOptions);
    const response = await fetch(url, proxiedRequestOptions);
    const text = await response.text();

    cookieHeader = mergeSetCookiePairs(cookieHeader, collectSetCookieHeaders(response.headers));
    const parsed = parseJsonSafe<T>(text);
    if (parsed) return { data: parsed, cookieHeader };

    if (!isShieldChallenge(response.headers.get('content-type') || '', text)) {
      return { data: null, cookieHeader };
    }
    if (!cookieHeader) {
      return { data: null, cookieHeader };
    }

    const acwScV2 = solveNewApiAcwScV2(text);
    if (!acwScV2) {
      return { data: null, cookieHeader };
    }

    cookieHeader = upsertCookie(cookieHeader, 'acw_sc__v2', acwScV2);
    headers.Cookie = cookieHeader;
  }

  return { data: null, cookieHeader };
}
