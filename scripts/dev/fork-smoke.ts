const baseUrl = (process.env.METAPI_BASE_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const authToken = (process.env.AUTH_TOKEN || '').trim();

if (!authToken) {
  console.error('AUTH_TOKEN is required');
  process.exit(1);
}

async function fetchText(path: string, init: RequestInit = {}): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.text();
}

function assertNoCredentialPayload(rawText: string): void {
  const secretPattern = /ld_auth_session=|"(?:accessToken|refreshToken|encryptedPayload|payload|cookie|token)"\s*:/i;
  if (secretPattern.test(rawText)) {
    throw new Error('credentials response contains a secret-looking payload');
  }
}

async function main(): Promise<void> {
  const uiResponse = await fetch(baseUrl, { method: 'HEAD' });
  if (!uiResponse.ok) {
    throw new Error(`UI returned ${uiResponse.status}`);
  }

  await fetchText('/api/site-auth/providers');
  const credentials = await fetchText('/api/site-auth/credentials');
  assertNoCredentialPayload(credentials);

  const decryptability = await fetchText('/api/site-auth/credentials/decryptability');
  assertNoCredentialPayload(decryptability);

  console.log(`fork smoke passed: ${baseUrl}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
