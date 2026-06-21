export type SiteAuthOAuthTokenPayload = Record<string, unknown> & {
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresIn?: number;
  idToken?: string;
};

const TOKEN_REFRESH_SKEW_MS = 60_000;

export function resolveOAuthTokenExpiresAt(expiresIn?: number, nowMs = Date.now()): string | null {
  if (!Number.isFinite(expiresIn) || Number(expiresIn) <= 0) return null;
  return new Date(nowMs + Number(expiresIn) * 1000).toISOString();
}

export function isOAuthTokenExpired(expiresAt?: string | null, nowMs = Date.now()): boolean {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return false;
  return parsed <= nowMs + TOKEN_REFRESH_SKEW_MS;
}

export function mergeRefreshedOAuthPayload(
  current: Record<string, unknown>,
  refreshed: SiteAuthOAuthTokenPayload,
): SiteAuthOAuthTokenPayload {
  return {
    ...current,
    accessToken: refreshed.accessToken,
    ...(refreshed.tokenType ? { tokenType: refreshed.tokenType } : {}),
    ...(refreshed.scope ? { scope: refreshed.scope } : {}),
    ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
    ...(refreshed.expiresIn ? { expiresIn: refreshed.expiresIn } : {}),
    ...(refreshed.idToken ? { idToken: refreshed.idToken } : {}),
  };
}
