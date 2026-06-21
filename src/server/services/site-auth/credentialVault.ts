import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { insertAndGetById } from '../../db/insertHelpers.js';
import {
  decryptAccountPassword,
  encryptAccountPassword,
} from '../accountCredentialService.js';
import { getSiteAuthProviderDefinition, type SiteAuthCredentialType, type SiteAuthProviderId } from './providers.js';

export type SiteAuthCredentialStatus = 'active' | 'expired' | 'invalid' | 'disabled';

export type SiteAuthCredentialPayload = Record<string, unknown>;

export type SiteAuthCredentialSummary = {
  id: number;
  provider: SiteAuthProviderId;
  label: string;
  subject?: string | null;
  email?: string | null;
  username?: string | null;
  credentialType: SiteAuthCredentialType;
  status: SiteAuthCredentialStatus;
  expiresAt?: string | null;
  lastVerifiedAt?: string | null;
  lastError?: string | null;
  proxyUrl?: string | null;
  useSystemProxy?: boolean | null;
  metadata: Record<string, unknown>;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type SiteAuthCredentialDecryptabilityItem = {
  id: number;
  provider: SiteAuthProviderId;
  label: string;
  ok: boolean;
  error?: string;
};

export type SiteAuthCredentialDecryptabilityReport = {
  total: number;
  decryptable: number;
  failed: number;
  items: SiteAuthCredentialDecryptabilityItem[];
};

export type CreateSiteAuthCredentialInput = {
  provider: SiteAuthProviderId;
  label?: string;
  subject?: string | null;
  email?: string | null;
  username?: string | null;
  credentialType: SiteAuthCredentialType;
  payload: SiteAuthCredentialPayload;
  status?: SiteAuthCredentialStatus;
  expiresAt?: string | null;
  lastVerifiedAt?: string | null;
  lastError?: string | null;
  proxyUrl?: string | null;
  useSystemProxy?: boolean | null;
  metadata?: Record<string, unknown> | null;
};

export type UpdateSiteAuthCredentialInput = Partial<{
  label: string | null;
  subject: string | null;
  email: string | null;
  username: string | null;
  status: SiteAuthCredentialStatus;
  expiresAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  proxyUrl: string | null;
  useSystemProxy: boolean | null;
  metadata: Record<string, unknown> | null;
}>;

type SiteAuthCredentialRow = typeof schema.siteAuthCredentials.$inferSelect;

function parseJsonRecord(value?: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringifyJsonRecord(value?: Record<string, unknown> | null): string | null {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

function encryptPayload(payload: SiteAuthCredentialPayload): string {
  return encryptAccountPassword(JSON.stringify(payload));
}

function decryptPayload(cipherText: string): SiteAuthCredentialPayload {
  const plain = decryptAccountPassword(cipherText);
  if (!plain) {
    throw new Error('site auth credential payload cannot be decrypted');
  }
  const parsed = JSON.parse(plain) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('site auth credential payload is invalid');
  }
  return parsed as SiteAuthCredentialPayload;
}

function assertProviderCredentialType(provider: SiteAuthProviderId, credentialType: SiteAuthCredentialType): void {
  const definition = getSiteAuthProviderDefinition(provider);
  if (!definition) {
    throw new Error(`unsupported site auth provider: ${provider}`);
  }
  if (!definition.metadata.credentialTypes.includes(credentialType)) {
    throw new Error(`unsupported credential type for ${provider}: ${credentialType}`);
  }
}

function mapCredentialSummary(row: SiteAuthCredentialRow): SiteAuthCredentialSummary {
  return {
    id: row.id,
    provider: row.provider as SiteAuthProviderId,
    label: row.label,
    subject: row.subject,
    email: row.email,
    username: row.username,
    credentialType: row.credentialType as SiteAuthCredentialType,
    status: row.status as SiteAuthCredentialStatus,
    expiresAt: row.expiresAt,
    lastVerifiedAt: row.lastVerifiedAt,
    lastError: row.lastError,
    proxyUrl: row.proxyUrl,
    useSystemProxy: row.useSystemProxy,
    metadata: parseJsonRecord(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createSiteAuthCredential(
  input: CreateSiteAuthCredentialInput,
): Promise<SiteAuthCredentialSummary> {
  assertProviderCredentialType(input.provider, input.credentialType);
  const definition = getSiteAuthProviderDefinition(input.provider)!;
  const label = (input.label || '').trim() || definition.metadata.label;
  const row = await insertAndGetById<SiteAuthCredentialRow>({
    table: schema.siteAuthCredentials,
    idColumn: schema.siteAuthCredentials.id,
    values: {
      provider: input.provider,
      label,
      subject: input.subject || null,
      email: input.email || null,
      username: input.username || null,
      credentialType: input.credentialType,
      encryptedPayload: encryptPayload(input.payload),
      status: input.status || 'active',
      expiresAt: input.expiresAt || null,
      lastVerifiedAt: input.lastVerifiedAt || null,
      lastError: input.lastError || null,
      proxyUrl: input.proxyUrl || null,
      useSystemProxy: input.useSystemProxy ?? false,
      metadata: stringifyJsonRecord(input.metadata),
    },
    insertErrorMessage: 'failed to create site auth credential',
  });
  return mapCredentialSummary(row);
}

export async function listSiteAuthCredentials(): Promise<SiteAuthCredentialSummary[]> {
  const rows = await db
    .select()
    .from(schema.siteAuthCredentials)
    .orderBy(desc(schema.siteAuthCredentials.id))
    .all();
  return rows.map(mapCredentialSummary);
}

export async function getSiteAuthCredential(id: number): Promise<SiteAuthCredentialSummary | null> {
  const row = await db
    .select()
    .from(schema.siteAuthCredentials)
    .where(eq(schema.siteAuthCredentials.id, id))
    .get();
  return row ? mapCredentialSummary(row) : null;
}

export async function updateSiteAuthCredential(
  id: number,
  input: UpdateSiteAuthCredentialInput,
): Promise<SiteAuthCredentialSummary | null> {
  const values: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };
  if ('label' in input) values.label = input.label || null;
  if ('subject' in input) values.subject = input.subject || null;
  if ('email' in input) values.email = input.email || null;
  if ('username' in input) values.username = input.username || null;
  if ('status' in input) values.status = input.status;
  if ('expiresAt' in input) values.expiresAt = input.expiresAt || null;
  if ('lastVerifiedAt' in input) values.lastVerifiedAt = input.lastVerifiedAt || null;
  if ('lastError' in input) values.lastError = input.lastError || null;
  if ('proxyUrl' in input) values.proxyUrl = input.proxyUrl || null;
  if ('useSystemProxy' in input) values.useSystemProxy = input.useSystemProxy ?? false;
  if ('metadata' in input) values.metadata = stringifyJsonRecord(input.metadata);

  await db
    .update(schema.siteAuthCredentials)
    .set(values)
    .where(eq(schema.siteAuthCredentials.id, id))
    .run();
  return getSiteAuthCredential(id);
}

export async function deleteSiteAuthCredential(id: number): Promise<boolean> {
  const existing = await getSiteAuthCredential(id);
  if (!existing) return false;
  await db
    .delete(schema.siteAuthCredentials)
    .where(eq(schema.siteAuthCredentials.id, id))
    .run();
  return true;
}

export async function getSiteAuthCredentialPayload(id: number): Promise<SiteAuthCredentialPayload | null> {
  const row = await db
    .select()
    .from(schema.siteAuthCredentials)
    .where(eq(schema.siteAuthCredentials.id, id))
    .get();
  return row ? decryptPayload(row.encryptedPayload) : null;
}

export async function updateSiteAuthCredentialPayload(
  id: number,
  payload: SiteAuthCredentialPayload,
): Promise<SiteAuthCredentialSummary | null> {
  await db
    .update(schema.siteAuthCredentials)
    .set({
      encryptedPayload: encryptPayload(payload),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.siteAuthCredentials.id, id))
    .run();
  return getSiteAuthCredential(id);
}

export async function checkSiteAuthCredentialDecryptability(): Promise<SiteAuthCredentialDecryptabilityReport> {
  const rows = await db
    .select()
    .from(schema.siteAuthCredentials)
    .orderBy(desc(schema.siteAuthCredentials.id))
    .all();

  const items = rows.map((row): SiteAuthCredentialDecryptabilityItem => {
    try {
      decryptPayload(row.encryptedPayload);
      return {
        id: row.id,
        provider: row.provider as SiteAuthProviderId,
        label: row.label,
        ok: true,
      };
    } catch (error: any) {
      return {
        id: row.id,
        provider: row.provider as SiteAuthProviderId,
        label: row.label,
        ok: false,
        error: error?.message || 'credential payload decrypt failed',
      };
    }
  });

  const decryptable = items.filter((item) => item.ok).length;
  return {
    total: items.length,
    decryptable,
    failed: items.length - decryptable,
    items,
  };
}
