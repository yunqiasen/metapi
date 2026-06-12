export type BrowserSessionCredentialCapture = {
  accessToken: string;
  platformUserId?: string;
  username?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  }
  return '';
}

function extractUserIdFromCookieText(text: string): string | undefined {
  const match = text.match(/(?:^|;\s*)(?:user_id|userid|uid|id|New-Api-User)=([0-9]{1,12})(?:;|$)/i);
  return match?.[1];
}

export function parseBrowserSessionCredentialCapture(rawText: string): BrowserSessionCredentialCapture {
  const text = rawText.trim();
  if (!text) throw new Error('未读取到浏览器凭证内容');

  try {
    const parsed = JSON.parse(text) as unknown;
    const record = asRecord(parsed);
    if (record) {
      const nestedData = asRecord(record.data);
      const source = nestedData || record;
      const accessToken = firstString(source, [
        'accessToken',
        'access_token',
        'token',
        'sessionToken',
        'session',
        'cookie',
        'sessionCookie',
      ]);
      const platformUserId = firstString(source, [
        'platformUserId',
        'userId',
        'user_id',
        'uid',
        'id',
      ]);
      const username = firstString(source, ['username', 'userName', 'name', 'email']);
      if (accessToken) {
        return {
          accessToken,
          ...(platformUserId ? { platformUserId } : {}),
          ...(username ? { username } : {}),
        };
      }
    }
  } catch {
    // Fall back to raw cookie/token parsing below.
  }

  const platformUserId = extractUserIdFromCookieText(text);
  return {
    accessToken: text,
    ...(platformUserId ? { platformUserId } : {}),
  };
}

export const browserSessionCredentialCaptureScript = `(() => {
  const pick = (...keys) => {
    for (const key of keys) {
      const value = localStorage.getItem(key) || sessionStorage.getItem(key);
      if (value) return value;
    }
    return '';
  };
  const payload = {
    accessToken: pick('access_token', 'accessToken', 'token', 'session', 'jwt'),
    userId: pick('user_id', 'userId', 'uid', 'id'),
    username: pick('username', 'userName', 'email'),
    cookie: document.cookie,
  };
  if (!payload.accessToken && payload.cookie) payload.accessToken = payload.cookie;
  copy(JSON.stringify(payload));
  console.log('Metapi browser credential copied:', payload);
})();`;
