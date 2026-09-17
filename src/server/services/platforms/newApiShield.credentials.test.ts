import { describe, expect, it } from 'vitest';
import { buildNewApiCookieCandidates, hasUsableSessionCookie } from './newApiShield.js';

describe('New API pasted credentials', () => {
  it('normalizes an F12 Cookie header while preserving padding and other cookies', () => {
    expect(buildNewApiCookieCandidates(' Cookie: session=abc\n123==;\r\n acw_tc=shield; theme=dark ')).toEqual([
      'session=abc123==; acw_tc=shield; theme=dark',
      'session=abc123==',
    ]);
  });

  it('does not wrap a complete header inside another session cookie', () => {
    expect(buildNewApiCookieCandidates('session=abc==')).toEqual(['session=abc==']);
  });

  it('keeps base64 padding on a bare wrapped session', () => {
    expect(buildNewApiCookieCandidates(' Bearer abc\n123== ')).toEqual([
      'session=abc123==', 'token=abc123==',
    ]);
  });

  it('recognizes a single provider session cookie', () => {
    expect(buildNewApiCookieCandidates('Cookie: user_session=gh\n123==')).toEqual(['user_session=gh123==']);
    expect(hasUsableSessionCookie('Cookie: user_session=gh123==')).toBe(true);
  });

  it('ignores empty session cookies and challenge-only cookies', () => {
    expect(hasUsableSessionCookie('session=; acw_tc=shield')).toBe(false);
    expect(hasUsableSessionCookie('acw_tc=shield; cf_clearance=clearance')).toBe(false);
  });
});
