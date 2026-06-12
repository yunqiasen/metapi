import { describe, expect, it } from 'vitest';
import { parseBrowserSessionCredentialCapture } from './browserSessionCredential.js';

describe('parseBrowserSessionCredentialCapture', () => {
  it('extracts session credential and user id from browser script JSON', () => {
    expect(parseBrowserSessionCredentialCapture(JSON.stringify({
      accessToken: 'session-token-1',
      userId: 2468,
      username: 'target-user',
    }))).toEqual({
      accessToken: 'session-token-1',
      platformUserId: '2468',
      username: 'target-user',
    });
  });

  it('uses browser cookie text as the session credential and extracts user id cookies', () => {
    expect(parseBrowserSessionCredentialCapture('session=abc; user_id=1357; theme=dark')).toEqual({
      accessToken: 'session=abc; user_id=1357; theme=dark',
      platformUserId: '1357',
    });
  });
});
