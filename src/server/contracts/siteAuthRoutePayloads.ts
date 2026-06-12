import { z } from 'zod';

const siteAuthCredentialTypeSchema = z.enum(['oauth_token', 'cookie', 'session_artifact', 'manual']);
const siteAuthProviderSchema = z.enum(['linuxdo', 'github', 'google']);

const siteAuthCredentialImportPayloadSchema = z.object({
  provider: siteAuthProviderSchema,
  label: z.string().optional(),
  subject: z.string().optional(),
  email: z.string().optional(),
  username: z.string().optional(),
  credentialType: siteAuthCredentialTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(['active', 'expired', 'invalid', 'disabled']).optional(),
  expiresAt: z.union([z.string(), z.null()]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export type SiteAuthCredentialImportPayload = z.output<typeof siteAuthCredentialImportPayloadSchema>;

function normalizeSiteAuthPayloadInput(input: unknown): unknown {
  return input === undefined ? {} : input;
}

function formatSiteAuthPayloadError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  const [firstPath] = firstIssue?.path ?? [];
  if (firstPath === 'provider') return 'Invalid provider. Expected linuxdo/github/google.';
  if (firstPath === 'label') return 'Invalid label. Expected string.';
  if (firstPath === 'subject') return 'Invalid subject. Expected string.';
  if (firstPath === 'email') return 'Invalid email. Expected string.';
  if (firstPath === 'username') return 'Invalid username. Expected string.';
  if (firstPath === 'credentialType') {
    return 'Invalid credentialType. Expected oauth_token/cookie/session_artifact/manual.';
  }
  if (firstPath === 'payload') return 'Invalid payload. Expected object.';
  if (firstPath === 'status') return 'Invalid status. Expected active/expired/invalid/disabled.';
  if (firstPath === 'expiresAt') return 'Invalid expiresAt. Expected string or null.';
  if (firstPath === 'metadata') return 'Invalid metadata. Expected object.';
  return 'Invalid site auth payload.';
}

export function parseSiteAuthCredentialImportPayload(input: unknown):
{ success: true; data: SiteAuthCredentialImportPayload } | { success: false; error: string } {
  const result = siteAuthCredentialImportPayloadSchema.safeParse(normalizeSiteAuthPayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSiteAuthPayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}
