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

  it('rejects provider oauth callback urls because target-site sessions are imported separately', () => {
    expect(() => parseSiteAuthCaptureText('https://metapi.local/callback?provider=github&code=code-1&state=state-1', 'github')).toThrow(
      'no supported site auth credential found',
    );
  });

  it('rejects unsupported pasted text', () => {
    expect(() => parseSiteAuthCaptureText('hello world', 'linuxdo')).toThrow(
      'no supported site auth credential found',
    );
  });
});
