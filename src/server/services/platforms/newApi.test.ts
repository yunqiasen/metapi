import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NewApiAdapter } from './newApi.js';
import { AnyRouterAdapter } from './anyrouter.js';

interface RequestSnapshot {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

const COOKIE_SESSION_TOKEN = 'cookie-session-token';
const COOKIE_REQUIRES_USER_TOKEN = 'cookie-requires-user';
const COOKIE_REQUIRES_X_USER_ID_TOKEN = 'cookie-requires-x-user-id';
const COOKIE_SESSION_FIRST_TOKEN = 'cookie-session-first-token';
const STALE_IMPORTED_SHIELD_SESSION = 'stale-imported-shield-session';
const CHECKIN_ALREADY_TOKEN = 'checkin-already-token';
const CHECKIN_INVALID_URL_TOKEN = 'checkin-invalid-url-token';
const CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN = 'checkin-invalid-url-expired-session-token';
const CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN = 'checkin-invalid-url-forbidden-session-token';
const CHECKIN_CLOUDFLARE_530_TOKEN = 'checkin-cloudflare-530-token';
const BALANCE_FAIL_TOKEN = 'balance-fail-token';
const BALANCE_SHIELD_FAILURE_TOKEN = 'balance-shield-failure-token';
const GROUP_EXPIRED_TOKEN = 'group-expired-token';
const SHIELD_LOGIN_USERNAME = 'shield-user';
const SHIELD_LOGIN_PASSWORD = 'shield-pass';
const SHIELD_LOGIN_TOKEN = 'login-session-token';
const SHIELD_LOGIN_COOKIE = 'challenge-seed';
const COOKIE_ONLY_LOGIN_USERNAME = 'cookie-only-user';
const COOKIE_ONLY_LOGIN_PASSWORD = 'cookie-only-pass';
const COOKIE_ONLY_LOGIN_SESSION = 'cookie-only-session';
const ROTATING_SHIELD_USERNAME = 'rotating-shield-user';
const ROTATING_SHIELD_PASSWORD = 'rotating-shield-pass';
const OPENAI_MODELS_SHIELDED_TOKEN = 'openai-models-shielded-token';
const COOKIE_SHIELDED_TOKEN = Buffer.from(
  `1771864970|${Buffer.from('username=linuxdo_131936').toString('base64')}|sig`,
).toString('base64');
const COOKIE_GOB_USER_TOKEN = Buffer.from(
  `1772806887|${Buffer.from(
    '0d7f040102ff8000011001100000ff93ff80000506737472696e670c060004726f6c6503696e740402000206737472696e670c08000673746174757303696e740402000206737472696e670c07000567726f757006737472696e670c09000764656661756c7406737472696e670c040002696403696e74040500fd04683006737472696e670c0a0008757365726e616d6506737472696e670c09000773756974313539',
    'hex',
  ).toString('base64')}|sig`,
).toString('base64');
const ANYROUTER_CHALLENGE_HTML = readFileSync(
  new URL('./__fixtures__/anyrouter-challenge.html', import.meta.url),
  'utf8',
);
const ANYROUTER_CHALLENGE_ACW = '699dbedad126579b6bc0ebb91eaae8d7af3548b5';
const CLOUDFLARE_530_HTML = `
<!doctype html>
<html lang="en-US">
  <head>
    <title>Cloudflare Tunnel error | newapi.tanmw.top | Cloudflare</title>
  </head>
  <body>
    <h1><span>Error</span><span>1033</span></h1>
    <h2>Cloudflare Tunnel error</h2>
  </body>
</html>
`;

describe('NewApiAdapter', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let requests: RequestSnapshot[] = [];
  let rotatingShieldPhase = 0;
  let cookieSessionFirstPoisoned = false;

  beforeEach(async () => {
    requests = [];
    rotatingShieldPhase = 0;
    cookieSessionFirstPoisoned = false;
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push({
        method: req.method || 'GET',
        url: req.url || '/',
        headers: req.headers,
      });

      if (req.url === '/v1/models') {
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${OPENAI_MODELS_SHIELDED_TOKEN}`) {
          const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
          if (!cookieHeader.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Set-Cookie': `cdn_sec_tc=${SHIELD_LOGIN_COOKIE}; Path=/; HttpOnly`,
            });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (
            !cookieHeader.includes(`cdn_sec_tc=${SHIELD_LOGIN_COOKIE}`)
            || !cookieHeader.includes(`session=${OPENAI_MODELS_SHIELDED_TOKEN}`)
          ) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'missing shield cookie context' } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: [
              { id: 'claude-sonnet-4-5-20250929' },
              { id: 'claude-opus-4-6' },
            ],
          }));
          return;
        }

        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid token' } }));
        return;
      }

      if (req.url === '/api/user/login' && req.method === 'POST') {
        let bodyRaw = '';
        req.on('data', (chunk) => {
          bodyRaw += chunk.toString();
        });
        req.on('end', () => {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(bodyRaw || '{}');
          } catch {}

          const isShieldLogin =
            payload.username === SHIELD_LOGIN_USERNAME &&
            payload.password === SHIELD_LOGIN_PASSWORD;
          const isCookieOnlyLogin =
            payload.username === COOKIE_ONLY_LOGIN_USERNAME &&
            payload.password === COOKIE_ONLY_LOGIN_PASSWORD;
          const isRotatingShieldLogin =
            payload.username === ROTATING_SHIELD_USERNAME &&
            payload.password === ROTATING_SHIELD_PASSWORD;
          if (!isShieldLogin && !isCookieOnlyLogin && !isRotatingShieldLogin) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'invalid credentials' }));
            return;
          }

          const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
          if (isRotatingShieldLogin) {
            const hasSolvedCookie = cookieHeader.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`);
            if (rotatingShieldPhase === 0 && !hasSolvedCookie) {
              rotatingShieldPhase = 1;
              res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Set-Cookie': `cdn_sec_tc=${SHIELD_LOGIN_COOKIE}; Path=/; HttpOnly`,
              });
              res.end(ANYROUTER_CHALLENGE_HTML);
              return;
            }
            if (rotatingShieldPhase === 1 && hasSolvedCookie) {
              rotatingShieldPhase = 2;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, data: { token: SHIELD_LOGIN_TOKEN } }));
              return;
            }
            if (rotatingShieldPhase === 2 && hasSolvedCookie) {
              rotatingShieldPhase = 3;
              res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end('<html><body>stale shield cookie</body></html>');
              return;
            }
            if (rotatingShieldPhase === 3 && !hasSolvedCookie) {
              rotatingShieldPhase = 4;
              res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Set-Cookie': `cdn_sec_tc=${SHIELD_LOGIN_COOKIE}; Path=/; HttpOnly`,
              });
              res.end(ANYROUTER_CHALLENGE_HTML);
              return;
            }
            if (rotatingShieldPhase === 4 && hasSolvedCookie) {
              rotatingShieldPhase = 5;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, data: { token: SHIELD_LOGIN_TOKEN } }));
              return;
            }
          }
          if (!cookieHeader.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Set-Cookie': `cdn_sec_tc=${SHIELD_LOGIN_COOKIE}; Path=/; HttpOnly`,
            });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }

          if (!cookieHeader.includes(`cdn_sec_tc=${SHIELD_LOGIN_COOKIE}`)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing shield cookie' }));
            return;
          }

          if (isCookieOnlyLogin) {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Set-Cookie': `session=${COOKIE_ONLY_LOGIN_SESSION}; Path=/; HttpOnly`,
            });
            res.end(JSON.stringify({
              success: true,
              data: {
                id: 1752,
                username: 'cookie-only-user',
                quota: 775000000,
                used_quota: 0,
              },
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { token: SHIELD_LOGIN_TOKEN },
          }));
        });
        return;
      }

      if (req.url === '/api/user/models') {
        if (req.headers['new-api-user'] !== '11494') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: ['gpt-4o', 'gpt-4.1'] }));
        return;
      }

      if (req.url === '/api/notice') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: 'Welcome to the site',
        }));
        return;
      }

      if (req.url?.startsWith('/api/token/')) {
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SHIELDED_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SHIELDED_TOKEN}`)) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (req.headers['new-api-user'] !== '131936') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'shielded-cookie-key' }],
            },
          }));
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SESSION_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_REQUIRES_USER_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_REQUIRES_X_USER_ID_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'cookie-api-key' }],
            },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_REQUIRES_USER_TOKEN}`)) {
          if (req.headers['new-api-user'] !== '8899') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'cookie-user-key' }],
            },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_REQUIRES_X_USER_ID_TOKEN}`)) {
          if (req.headers['x-user-id'] !== '448') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing X-User-Id' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'cookie-x-user-id-key' }],
            },
          }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            items: [{ key: 'api-key-from-token-list' }],
          },
        }));
        return;
      }

      if (req.url === '/api/user/self') {
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${STALE_IMPORTED_SHIELD_SESSION}`)) {
          if (req.headers.cookie.includes('acw_sc__v2=stale-imported')) {
            res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body>stale imported shield cookie</body></html>');
            return;
          }
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Set-Cookie': `cdn_sec_tc=${SHIELD_LOGIN_COOKIE}; Path=/; HttpOnly`,
            });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 59260, username: 'linuxdo_59260', quota: 108000000, used_quota: 1040000000 },
          }));
          return;
        }

        if (req.headers.authorization === `Bearer ${COOKIE_SESSION_FIRST_TOKEN}`) {
          cookieSessionFirstPoisoned = true;
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body>bearer probe triggered upstream shield</body></html>');
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SESSION_FIRST_TOKEN}`)) {
          if (cookieSessionFirstPoisoned) {
            res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body>request budget exhausted</body></html>');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 182711, username: 'session-first-user', quota: 5000000, used_quota: 1000000 },
          }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${BALANCE_SHIELD_FAILURE_TOKEN}`) {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Set-Cookie': `cdn_sec_tc=${SHIELD_LOGIN_COOKIE}; Path=/; HttpOnly`,
          });
          res.end(ANYROUTER_CHALLENGE_HTML);
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${BALANCE_FAIL_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，access token 无效' }));
          return;
        }

        if (
          typeof req.headers.cookie === 'string' &&
          (
            req.headers.cookie.includes(`session=${BALANCE_SHIELD_FAILURE_TOKEN}`) ||
            req.headers.cookie.includes(`token=${BALANCE_SHIELD_FAILURE_TOKEN}`)
          )
        ) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，未登录且未提供 access token' }));
          return;
        }

        if (
          typeof req.headers.cookie === 'string' &&
          (
            req.headers.cookie.includes(`session=${BALANCE_FAIL_TOKEN}`) ||
            req.headers.cookie.includes(`token=${BALANCE_FAIL_TOKEN}`)
          )
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，access token 无效' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SHIELDED_TOKEN}`)) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (req.headers['new-api-user'] !== '131936') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 131936, username: 'linuxdo_131936', quota: 3000000, used_quota: 1200000 },
          }));
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === 'Bearer session-token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 11494, username: 'demo-user', quota: 1000000, used_quota: 1000 },
          }));
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SESSION_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_REQUIRES_USER_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_REQUIRES_X_USER_ID_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 7788, username: 'cookie-user', quota: 2000000, used_quota: 500000 },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_REQUIRES_USER_TOKEN}`)) {
          if (req.headers['new-api-user'] !== '8899') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 8899, username: 'cookie-user-id-required', quota: 1500000, used_quota: 100000 },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_REQUIRES_X_USER_ID_TOKEN}`)) {
          if (req.headers['x-user-id'] !== '448') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing X-User-Id' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 448, username: 'x-user-id-cookie-user', quota: 1500000, used_quota: 100000 },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_GOB_USER_TOKEN}`)) {
          if (req.headers['new-api-user'] !== '144408') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 144408, username: 'suit159', quota: 50000000, used_quota: 0 },
          }));
          return;
        }

        if (
          typeof req.headers.cookie === 'string'
          && (
            req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_TOKEN}`)
            || req.headers.cookie.includes(`token=${CHECKIN_INVALID_URL_TOKEN}`)
          )
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'temporary self probe failure' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，未登录且未提供 access token' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'forbidden' }));
          return;
        }

        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
        return;
      }

      if (req.url === '/api/user/checkin') {
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_CLOUDFLARE_530_TOKEN}`) {
          res.writeHead(530, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(CLOUDFLARE_530_HTML);
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_INVALID_URL_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_ALREADY_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '今天已经签到过啦' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_ALREADY_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，未登录且未提供 access token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SHIELDED_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SHIELDED_TOKEN}`)) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (req.headers['new-api-user'] !== '131936') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'checked-in-ok' }));
          return;
        }
      }

      if (req.url === '/api/user/self/groups') {
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${GROUP_EXPIRED_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'access token expired' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === 'Bearer session-token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: { default: true, gemini: true } }));
          return;
        }
      }

      if (req.url === '/api/user/sign_in') {
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN}`)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({}));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN}`)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({}));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_ALREADY_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，未登录且未提供 access token' }));
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
  });

  it('falls back to session model endpoint when /v1/models rejects token', async () => {
    const adapter = new NewApiAdapter();
    const models = await adapter.getModels(baseUrl, 'session-token', 11494);

    expect(models).toEqual(['gpt-4o', 'gpt-4.1']);
    expect(requests.some((r) => r.url === '/v1/models')).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/models' && r.headers['new-api-user'] === '11494'),
    ).toBe(true);
  });

  it('reuses shield cookie retry when anyrouter /v1/models returns challenge html', async () => {
    const adapter = new AnyRouterAdapter();
    const models = await adapter.getModels(baseUrl, OPENAI_MODELS_SHIELDED_TOKEN);

    expect(models).toEqual(['claude-sonnet-4-5-20250929', 'claude-opus-4-6']);
    expect(
      requests.some(
        (r) =>
          r.url === '/v1/models'
          && typeof r.headers.cookie === 'string'
          && r.headers.cookie.includes(`session=${OPENAI_MODELS_SHIELDED_TOKEN}`),
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.url === '/v1/models'
          && typeof r.headers.cookie === 'string'
          && r.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`),
      ),
    ).toBe(true);
  });

  it('parses token list response with data.items[] shape', async () => {
    const adapter = new NewApiAdapter();
    const token = await adapter.getApiToken(baseUrl, 'session-token', 11494);

    expect(token).toBe('api-key-from-token-list');
  });

  it('solves anyrouter acw challenge for account-password login', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.login(baseUrl, SHIELD_LOGIN_USERNAME, SHIELD_LOGIN_PASSWORD);

    expect(result.success).toBe(true);
    expect(result.accessToken).toBe(SHIELD_LOGIN_TOKEN);
    expect(
      requests.some(
        (r) =>
          r.url === '/api/user/login' &&
          typeof r.headers.cookie === 'string' &&
          r.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`),
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.url === '/api/user/login' &&
          typeof r.headers.cookie === 'string' &&
          r.headers.cookie.includes(`cdn_sec_tc=${SHIELD_LOGIN_COOKIE}`),
      ),
    ).toBe(true);
  });

  it('reuses solved shield cookies across consecutive anyrouter logins', async () => {
    const adapter = new AnyRouterAdapter();

    const first = await adapter.login(baseUrl, SHIELD_LOGIN_USERNAME, SHIELD_LOGIN_PASSWORD);
    const second = await adapter.login(baseUrl, SHIELD_LOGIN_USERNAME, SHIELD_LOGIN_PASSWORD);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(requests.filter((r) => r.url === '/api/user/login')).toHaveLength(3);
  });

  it('drops stale cached shield cookies and resolves a fresh challenge after proxy rotation', async () => {
    const adapter = new AnyRouterAdapter();

    const first = await adapter.login(baseUrl, ROTATING_SHIELD_USERNAME, ROTATING_SHIELD_PASSWORD);
    const second = await adapter.login(baseUrl, ROTATING_SHIELD_USERNAME, ROTATING_SHIELD_PASSWORD);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(requests.filter((request) => request.url === '/api/user/login')).toHaveLength(5);
  });

  it('does not reuse account session cookies between consecutive anyrouter logins', async () => {
    const adapter = new AnyRouterAdapter();

    const first = await adapter.login(baseUrl, COOKIE_ONLY_LOGIN_USERNAME, COOKIE_ONLY_LOGIN_PASSWORD);
    const second = await adapter.login(baseUrl, SHIELD_LOGIN_USERNAME, SHIELD_LOGIN_PASSWORD);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const loginRequests = requests.filter((request) => request.url === '/api/user/login');
    expect(loginRequests).toHaveLength(3);
    expect(loginRequests[2]?.headers.cookie || '').toContain(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`);
    expect(loginRequests[2]?.headers.cookie || '').not.toContain(`session=${COOKIE_ONLY_LOGIN_SESSION}`);
  });

  it('accepts an F12 Cookie header with wrapped session text', async () => {
    const adapter = new NewApiAdapter();
    const wrapped = `Cookie: session=${COOKIE_SESSION_TOKEN.slice(0, 7)}\n${COOKIE_SESSION_TOKEN.slice(7)};\n acw_tc=shield-tc`;
    const result = await adapter.getUserInfo(baseUrl, wrapped, 7788);
    expect(result).toMatchObject({ username: 'cookie-user' });
    expect(requests.some((request) => request.headers.cookie === `session=${COOKIE_SESSION_TOKEN}; acw_tc=shield-tc`)).toBe(true);
  });

  it('accepts a bare session split across pasted lines', async () => {
    const adapter = new NewApiAdapter();
    const wrapped = `${COOKIE_SESSION_TOKEN.slice(0, 7)}\n${COOKIE_SESSION_TOKEN.slice(7)}`;
    const result = await adapter.getUserInfo(baseUrl, wrapped, 7788);
    expect(result).toMatchObject({ username: 'cookie-user' });
    expect(requests.some((request) => request.headers.cookie === `session=${COOKIE_SESSION_TOKEN}`)).toBe(true);
  });

  it('uses session cookie as access credential when login success has no token payload', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.login(baseUrl, COOKIE_ONLY_LOGIN_USERNAME, COOKIE_ONLY_LOGIN_PASSWORD);

    expect(result.success).toBe(true);
    expect(result.accessToken || '').toContain(`session=${COOKIE_ONLY_LOGIN_SESSION}`);
    expect(result.accessToken || '').toContain(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`);
    expect(result.accessToken || '').toContain(`cdn_sec_tc=${SHIELD_LOGIN_COOKIE}`);
    expect(result.platformUserId).toBe(1752);
    expect(result.userInfo?.username).toBe('cookie-only-user');
    expect(result.balance).toEqual({ balance: 1550, used: 0, quota: 1550, todayIncome: undefined, todayQuotaConsumption: undefined });
  });

  it('skips OpenAI model probing when the caller explicitly verifies a session token', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_SESSION_TOKEN, undefined, 'session');

    expect(result.tokenType).toBe('session');
    expect(requests.some((r) => r.url === '/v1/models')).toBe(false);
  });

  it('verifies explicit session credentials through cookies before bearer probes', async () => {
    const adapter = new AnyRouterAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_SESSION_FIRST_TOKEN, 182711, 'session');

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('session-first-user');
    const selfRequests = requests.filter((request) => request.url === '/api/user/self');
    expect(selfRequests[0]?.headers.cookie).toContain(`session=${COOKIE_SESSION_FIRST_TOKEN}`);
    expect(selfRequests.some((request) => request.headers.authorization === `Bearer ${COOKIE_SESSION_FIRST_TOKEN}`)).toBe(false);
  });

  it('drops stale shield cookies imported with a valid session and rebuilds the WAF state', async () => {
    const adapter = new AnyRouterAdapter();
    const token = `session=${STALE_IMPORTED_SHIELD_SESSION}; acw_tc=stale; cdn_sec_tc=stale; acw_sc__v2=stale-imported`;
    const result = await adapter.verifyToken(baseUrl, token, 59260, 'session');

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('linuxdo_59260');
    const selfRequests = requests.filter((request) => request.url === '/api/user/self');
    expect(selfRequests).toHaveLength(2);
    expect(selfRequests[0]?.headers.cookie).toContain(`session=${STALE_IMPORTED_SHIELD_SESSION}`);
    expect(selfRequests.every((request) => !request.headers.cookie?.includes('acw_sc__v2=stale-imported'))).toBe(true);
    expect(selfRequests[1]?.headers.cookie).toContain(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`);
  });

  it('detects cookie session values as session cookies for anyrouter-like deployments', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_SESSION_TOKEN);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('cookie-user');
    expect(result.apiToken).toBe('cookie-api-key');
    expect(
      requests.some((r) => r.url === '/api/user/self' && typeof r.headers.cookie === 'string' && r.headers.cookie.includes(`session=${COOKIE_SESSION_TOKEN}`)),
    ).toBe(true);
  });

  it('auto-probes New-Api-User for cookie sessions when header is required', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_REQUIRES_USER_TOKEN);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('cookie-user-id-required');
    expect(result.apiToken).toBe('cookie-user-key');
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '8899'),
    ).toBe(true);
  });

  it('sends X-User-Id for cookie sessions when the site requires that New API variant', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_REQUIRES_X_USER_ID_TOKEN, 448);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('x-user-id-cookie-user');
    expect(result.apiToken).toBe('cookie-x-user-id-key');
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['x-user-id'] === '448'),
    ).toBe(true);
    expect(
      requests.some((r) => r.url?.startsWith('/api/token/') && r.headers['x-user-id'] === '448'),
    ).toBe(true);
  });

  it('solves anyrouter acw challenge and probes user id from session payload', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_SHIELDED_TOKEN);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('linuxdo_131936');
    expect(typeof result.apiToken === 'string' && result.apiToken.length > 0).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.url === '/api/user/self' &&
          typeof r.headers.cookie === 'string' &&
          r.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`),
      ),
    ).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '131936'),
    ).toBe(true);
  });

  it('extracts gob-encoded user id from anyrouter session cookie when reading balance', async () => {
    const adapter = new NewApiAdapter();
    const balance = await adapter.getBalance(baseUrl, COOKIE_GOB_USER_TOKEN);

    expect(balance.balance).toBe(100);
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '144408'),
    ).toBe(true);
  });

  it('recovers from mismatched provided user id by probing gob-encoded session payload', async () => {
    const adapter = new NewApiAdapter();
    const balance = await adapter.getBalance(baseUrl, COOKIE_GOB_USER_TOKEN, 159);

    expect(balance.balance).toBe(100);
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '159'),
    ).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '144408'),
    ).toBe(true);
  });

  it('uses shielded cookie flow for balance and checkin', async () => {
    const adapter = new NewApiAdapter();
    const balance = await adapter.getBalance(baseUrl, COOKIE_SHIELDED_TOKEN);
    const checkin = await adapter.checkin(baseUrl, COOKIE_SHIELDED_TOKEN);

    expect(balance).toEqual({
      quota: 8.4,
      used: 2.4,
      balance: 6,
    });
    expect(checkin.success).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/checkin' && r.headers['new-api-user'] === '131936'),
    ).toBe(true);
  });

  it('preserves upstream balance failure message for UI feedback', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getBalance(baseUrl, BALANCE_FAIL_TOKEN)).rejects.toThrow('access token');
  });

  it('prefers post-challenge cookie failure over raw html parse error when reading balance', async () => {
    const adapter = new AnyRouterAdapter();

    await expect(adapter.getBalance(baseUrl, BALANCE_SHIELD_FAILURE_TOKEN)).rejects
      .toThrow('无权进行此操作，未登录且未提供 access token');
  });

  it('preserves nested checkin error message instead of generic fallback', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_INVALID_URL_TOKEN, 11494);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid URL');
  });

  it('prefers cookie session auth failure over invalid-url fallback when cookie session is expired', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN, 131936);

    expect(result.success).toBe(false);
    expect(result.message).toContain('access token');
    expect(result.message).not.toContain('Invalid URL');
  });

  it('treats forbidden self probe responses as cookie session auth failures', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN, 131936);

    expect(result.success).toBe(false);
    expect(result.message).toContain('forbidden');
    expect(result.message).not.toContain('Invalid URL');
  });

  it('summarizes cloudflare tunnel HTML failures to concise checkin error', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_CLOUDFLARE_530_TOKEN, 11494);

    expect(result.success).toBe(false);
    expect(result.message).toBe('HTTP 530: Cloudflare Tunnel error (Error 1033)');
  });

  it('preserves already-checked-in message instead of overriding with cookie fallback error', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_ALREADY_TOKEN, 11494);

    expect(result.success).toBe(false);
    expect(result.message).toBe('今天已经签到过啦');
  });

  it('returns clean groups from data object without envelope keys', async () => {
    const adapter = new NewApiAdapter();
    const groups = await adapter.getUserGroups(baseUrl, 'session-token', 11494);

    expect(groups).toEqual(['default', 'gemini']);
    expect(groups).not.toContain('success');
    expect(groups).not.toContain('message');
  });

  it('throws expired-session error when group endpoint reports invalid access token', async () => {
    const adapter = new NewApiAdapter();
    await expect(adapter.getUserGroups(baseUrl, GROUP_EXPIRED_TOKEN, 11494)).rejects.toThrow('账号会话可能已过期');
  });

  it('sends all compatibility user-id headers when userId is known', async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
    const receivedHeaders: Record<string, string> = {};
    server = createServer((req, res) => {
      for (const name of ['new-api-user', 'veloera-user', 'voapi-user', 'user-id', 'rix-api-user', 'neo-api-user']) {
        const val = req.headers[name];
        if (val) receivedHeaders[name] = String(val);
      }
      if (req.url === '/api/user/self') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { id: 42, username: 'test', quota: 500000, used_quota: 0 } }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const adapter = new NewApiAdapter();
    const fakeJwt = `header.${Buffer.from(JSON.stringify({ id: 42 })).toString('base64url')}.sig`;
    await adapter.getBalance(baseUrl, fakeJwt, 42);

    expect(receivedHeaders['new-api-user']).toBe('42');
    expect(receivedHeaders['veloera-user']).toBe('42');
    expect(receivedHeaders['voapi-user']).toBe('42');
    expect(receivedHeaders['user-id']).toBe('42');
    expect(receivedHeaders['rix-api-user']).toBe('42');
    expect(receivedHeaders['neo-api-user']).toBe('42');
  });

  it('normalizes the global site notice from /api/notice', async () => {
    const adapter = new NewApiAdapter();
    const rows = await adapter.getSiteAnnouncements(baseUrl, 'session-token');

    expect(rows).toEqual([
      {
        sourceKey: `notice:${createHash('sha1').update('Welcome to the site').digest('hex')}`,
        title: 'Site notice',
        content: 'Welcome to the site',
        level: 'info',
        sourceUrl: '/api/notice',
        rawPayload: { success: true, data: 'Welcome to the site' },
      },
    ]);
  });
});
