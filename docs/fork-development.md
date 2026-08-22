# Metapi Fork Development Workflow

This fork keeps three things separate:

- `main`: mirror of upstream `cita-777/metapi`.
- `Metapi-fork`: local customization branch.
- `.env`: machine-local runtime secrets, ignored by Git.

## Remotes

```bash
origin   https://github.com/yunqiasen/metapi.git
upstream https://github.com/cita-777/metapi.git
```

## First deploy on a server

```bash
git clone -b Metapi-fork https://github.com/yunqiasen/metapi.git
cd metapi
cp .env.fork.example .env
# edit .env: AUTH_TOKEN, PROXY_TOKEN, ACCOUNT_CREDENTIAL_SECRET
docker compose up -d --build
```

Production Compose builds from this fork branch, so code changes are included in the image instead of using the upstream public image.

`AUTH_TOKEN` is the admin login token. `PROXY_TOKEN` is the downstream `/v1/*` Bearer token. Keep both unique per deployment.

## Runtime data and credentials

Keep runtime secrets local to each server:

- `.env` stores deployment secrets and is ignored by Git.
- `data/` stores the SQLite database and runtime state and is ignored by Git.
- Third-party login credential payloads are encrypted in the local database. The credential list only shows metadata and masked summaries.

When moving this fork deployment to another server, migrate `data/` and keep the same `ACCOUNT_CREDENTIAL_SECRET`. If the database is moved without the matching secret, saved upstream accounts and site-auth credentials cannot be decrypted.

## Hot-mounted local development

Stop the production container before starting the dev container because both use port `4000` and container name `metapi`.

```bash
docker compose down
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml logs -f metapi
```

Dev URLs:

- Unified UI and proxied API: `http://<host>:4000`
- Direct backend debug port: `http://<host>:4001`
- Tailscale UI and API on this machine: `http://100.126.43.55:4000`
- Tailscale direct backend debug port: `http://100.126.43.55:4001`

The dev container uses `docker/Dockerfile.dev` for Python/make/g++ native rebuild support, bind-mounts the repository into `/app`, and stores Linux dependencies in the named volume `metapi_node_modules`. In dev mode, Vite owns public port `4000`; the backend listens on `4001` inside the container, and `/api` plus `/v1` are proxied back to it. `scripts/dev/docker-entrypoint.sh` compares `package-lock.json` with a checksum stored in the dependency volume. It automatically reruns `npm ci` when dependencies change, then starts the backend watcher and Vite; source-only restarts do not reinstall dependencies.

Because the repository is bind-mounted, source edits in this directory are reflected inside the dev container. Commit code changes on `Metapi-fork`; do not commit `.env`, `data/`, Cookies, Tokens, callback URLs, or database dumps.

### AnyRouter / AgentRouter shielded browser

AnyRouter keeps the CloakBrowser persistent context. AgentRouter uses the system Chromium persistent context because the same Aliyun WAF slider trajectory succeeds there while CloakBrowser is rejected. Xvfb, x11vnc, websockify, noVNC, temporary Profile cleanup, Cookie extraction, and account Profile persistence remain owned by Metapi.

- Runtime cache: `data/cloakbrowser-cache` (`CLOAKBROWSER_CACHE_DIR=/app/data/cloakbrowser-cache`).
- AnyRouter browser proxy: account `extraConfig.proxyUrl` first, then `ANYROUTER_BROWSER_PROXY_URL` / `SITE_AUTH_BROWSER_PROXY_URL`. It must never inherit the AgentRouter-only fixed exit.
- AgentRouter browser proxy: account `agentRouterBrowserProxyUrl` first, then `AGENTROUTER_BROWSER_PROXY_URL`; target site, Aliyun captcha resources, and OAuth provider stay on that fixed exit for one browser operation.
- AnyRouter performs one best-effort visit to the real `/api/status` page before opening `/login`. A verified JSON response marks WAF warmup ready; a challenge, 403, or timeout is logged but never destroys the interactive browser session. Frontend OAuth state and callback state are never locally forged.
- A visible OAuth button is not sufficient verification. The acceptance path is `/register` -> LinuxDO/GitHub -> target `/api/oauth/state` -> provider authorization URL.
- If the solved challenge is followed by ESA `Denied by http_ratelimit`, the current browser proxy exit is blocked for AnyRouter. Change only the browser proxy node; the login window must still be handed to the user instead of failing startup.
- AnyRouter / AgentRouter account-password creation is protocol-only: call the platform adapter, save Session/API Token/User ID/encrypted password, and never start Chromium or write `managedBrowserProfile`. Credential refresh and check-in re-login for these password accounts also stay on the protocol path. A persisted Profile is created only by an explicit target-site browser/OAuth flow or AgentRouter F12 Session browser verification; a missing Profile is never rebuilt from the saved password.
- AgentRouter manual Session verification first uses the normal adapter. If that request reaches the 10-second boundary, Metapi injects the pasted raw F12 Session value into an isolated native-Chromium Profile, reads the real `/api/user/self`, and requires the returned user ID to match `platformUserId`. Verify-only Profiles are deleted; successful account creation atomically moves the staged Profile to the account directory before initialization starts.

The first launch downloads the CloakBrowser binary into the runtime cache. Keep that cache with `data/` so container recreation does not download it again.

Development and production Compose own the `browser-proxy` service (`metapi-browser-proxy`). The runtime config is mounted from `data/browser-proxy/config.yaml`, while Mihomo selector state is retained in `browser_proxy_state`. The AgentRouter fixed listener is `http://metapi-browser-proxy:7891`; AnyRouter continues through the generic routed listener. After changing proxy config, validate both lanes and restart persistence:

```bash
docker exec metapi curl -fsS -x http://metapi-browser-proxy:7891 https://api.ipify.org
docker compose -f docker-compose.dev.yml restart browser-proxy
```

### Browser-login lifecycle checks

The development Compose files enable Docker `init: true`. Browser services share one Fastify shutdown path; do not add service-local `SIGINT` / `SIGTERM` handlers. Target-site login uses temporary profiles under `data/target-site-auth-profiles`, while persisted account profiles live under `data/browser-profiles/accounts/<platform>/<accountId>`.

After changing target-site login, captcha, refresh, or check-in behavior, verify the idle state:

```bash
docker exec metapi sh -lc "ps -eo stat,args | grep -E '\[(chromium|Xvfb|x11vnc|websockify)\] <defunct>' | grep -v grep | wc -l"
docker exec metapi sh -lc "ps -eo args | grep '/usr/lib/chromium/chromium ' | grep -v grep | wc -l"
find data/target-site-auth-profiles -mindepth 2 -maxdepth 2 -type d | wc -l
```

All three counts must be `0` when no login window is open. Do not persist target application `localStorage` or cross-start WAF cookies as an acceleration cache: OAuth flags and challenge cookies can be browser-session-bound and previously caused stale controls, 45-second waits, and failed starts.

## Deployment smoke check

After a server pulls `Metapi-fork` and starts the container, run a masked smoke check before handing it over:

```bash
docker compose exec -T metapi npm run smoke:fork
```

For a remote or non-default URL:

```bash
docker compose exec -T metapi env METAPI_BASE_URL=http://100.126.43.55:4000 npm run smoke:fork
```

The check requires `AUTH_TOKEN` in the container environment. It verifies the UI, admin API, third-party provider registry, credential list, and decryptability endpoint. It fails if credential responses expose payload-looking fields or `ld_auth_session=...` material.

## Provider login credential workflow

Use `Provider 与登录凭证` for two separate things:

- Provider connections: routeable OAuth providers such as Codex, Claude, Gemini CLI, and Antigravity.
- Third-party login credentials: reusable provider login material for L 站 / LinuxDO, GitHub, and Google.

GitHub, Google, and LinuxDO credential capture starts from `Provider 与登录凭证 -> 新建 OAuth 连接 -> 站点登录授权`. Select only the Provider, then click `打开 ... 登录并保存凭证`. The drawer must not ask for a relay site.

Do not use LinuxDO `user-api-key/new` as the main workflow. Some sites disable user API key publishing. The maintained path is provider login -> persist provider credential -> reuse it when creating or refreshing normal Session connections.

Adding a Session connection can query the selected site's login requirements or reuse saved third-party credentials to create a normal Session account. Browser-assisted import only parses text the operator pastes manually; it does not read cross-site HttpOnly Cookies.

## Update from upstream

```bash
docker compose down || true
docker compose -f docker-compose.dev.yml down || true
git checkout main
git fetch upstream main
git merge --ff-only upstream/main
git push origin main
git checkout Metapi-fork
git merge main
# resolve conflicts, run tests/build, then push
git push origin Metapi-fork
```

Stop running Compose services before merging upstream if the merge changes dependencies, schema, or Docker files.

Do not commit `.env`, `data/`, or generated local runtime files.

### AnyRouter browser-visit check-in

AnyRouter declares `checkinMode = browser-visit`, but dispatch is account-specific. Accounts with a concrete persisted Profile acquire the Profile lease, copy the Profile, open the real site through CloakBrowser, and recover an expired target Session only from the configured LinuxDO/GitHub Profile. Password accounts without a Profile stay on the protocol `adapter.checkin()` path and may use encrypted `autoRelogin` only for another protocol login; they never bootstrap a browser Profile. In the browser-backed path Metapi reads `/api/user/self`, sends the real `POST /api/user/sign_in` request with `New-API-User`, `X-Requested-With`, and the current browser Cookie, then polls `/api/user/self` again.

Only a positive **total quota** delta is a successful check-in. Remaining balance may fall while usage grows, so it is not the reward baseline. An HTML/WAF response, account mismatch, missing quota, or unchanged total quota never advances `lastCheckinAt`. An explicit already-signed response with unchanged quota returns `success: false`, `status: skipped`, and no reward; the verified Session/Profile, current balance, and `active` account state are still persisted. Reward parsing accepts explicit reward/increase text only and never treats `current total quota N` as reward `N`.

### AgentRouter browser-reauth check-in

AgentRouter declares `checkinMode = browser-reauth` for accounts that own a concrete persisted Profile. Password accounts without a Profile never enter that browser flow: Metapi only tries the protocol check-in/login path and reports the real unsupported or failed result instead of creating a Profile. For Profile-backed accounts, the primary trigger is the first authenticated browser `GET /api/user/self`: AgentRouter applies the daily quota during that request. Metapi therefore compares that live response with the stored total quota before attempting logout. A positive delta is persisted immediately as the real reward and skips OAuth. If `lastCheckinAt` is already today, the UI action still opens the Profile, re-reads live `/api/user/self`, persists the current Session/balance, restores an expired account to `active`, and returns `skipped`; it does not trust the database snapshot or repeat logout/OAuth.

When the authenticated self request has no positive delta, the maintained fallback is mechanical:

1. Acquire the account Profile lease and copy `data/browser-profiles/accounts/agentrouter/<accountId>` to a staged `reauth-*` Profile.
2. Reject an explicit target-account mismatch. Call `GET /api/user/logout`, then require `/api/user/self` to be anonymous.
3. Reuse the staged Profile's LinuxDO or GitHub session and complete the real `/api/oauth/state -> provider -> /api/oauth/<provider>` flow.
4. Require both the OAuth callback user ID and the post-login `/api/user/self` ID to match the original account.
5. Require a positive total-quota delta even when the callback says `checked_in: true`; otherwise return failed/unconfirmed without a reward.
6. Close the browser, atomically install the staged Profile, persist the new Session/API token and browser balance, then remove the rollback backup.

`managedBrowserProfile.loginProvider` is the source of truth. Legacy usernames may infer it only from `linuxdo_<id>` or `github_<id>`. Each persisted account Profile also owns stable `.metapi-cloak-fingerprint` metadata; changing it between launches invalidates the device identity associated with challenge clearance. A provider login page, OAuth timeout, failed logout, or account mismatch discards the staged Profile and leaves the formal Profile/database unchanged. LinuxDO Cloudflare interstitials are reported as `provider_challenge_required`, not as a callback URL or generic timeout.

Both Router flows return the confirmed `reward` and latest `balanceInfo` to the Accounts UI. The terminal task result directly patches the account row (`balance`, `balanceUsed`, `quota`, runtime health, and today's reward) and does not launch a second 30-second balance snapshot. Synchronous row locking also prevents a double click from submitting duplicate tasks. Only a positive total-quota delta renders success and today's added quota. OAuth completion, HTTP 200, or unchanged quota cannot create a success log.

AgentRouter may return its HTML application shell to Node/undici. Only that `upstream_html_response` case first uses an AgentRouter-only `curl --config -` fallback; Cookie, `New-Api-User`, and proxy credentials go through stdin rather than process arguments. Production and development images must therefore include `curl`.

Some container network exits receive the same HTML shell with curl even though the host receives JSON. The declared `balanceFallbackMode = managed-browser-profile` then acquires the account Profile lease, reads `/api/user/self` through a staged native Chromium Profile, and discards the stage without committing it. If `/api/user/self` returns an Aliyun WAF page, the browser promotes it to a top-level navigation, solves the slider, returns to `/console`, and reads the live JSON again. Do not replace this with a generic New API fallback: it is AgentRouter-specific and intentionally avoids another OAuth login.
