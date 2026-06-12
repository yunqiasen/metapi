import { describe, expect, it } from 'vitest';
import { parseSiteAuthCaptureText } from './browserCapture.js';

describe('parseSiteAuthCaptureText', () => {
  it('extracts a LinuxDO session cookie from pasted browser cookies', () => {
    expect(parseSiteAuthCaptureText('ld_auth_session=abc123; theme=light', 'linuxdo')).toMatchObject({
      provider: 'linuxdo',
      credentialType: 'cookie',
      payload: { cookie: 'ld_auth_session=abc123' },
    });
  });

  it('extracts provider oauth callback code and state', () => {
    expect(parseSiteAuthCaptureText('https://metapi.local/callback?provider=github&code=code-1&state=state-1')).toMatchObject({
      provider: 'github',
      credentialType: 'oauth_token',
      payload: { code: 'code-1', state: 'state-1' },
    });
  });

  it('rejects unsupported pasted text', () => {
    expect(() => parseSiteAuthCaptureText('hello world', 'linuxdo')).toThrow(
      'no supported site auth credential found',
    );
  });
});
