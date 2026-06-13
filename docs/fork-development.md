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

The dev container uses `docker/Dockerfile.dev` for Python/make/g++ native rebuild support, bind-mounts the repository into `/app`, and stores Linux dependencies in the named volume `metapi_node_modules`. In dev mode, Vite owns public port `4000`; the backend listens on `4001` inside the container, and `/api` plus `/v1` are proxied back to it. `scripts/dev/docker-entrypoint.sh` installs dependencies only when the volume is missing Vite/tsx/concurrently, then runs the backend watcher and Vite. If `package-lock.json` changes, recreate the dev container or remove the named volume.

Because the repository is bind-mounted, source edits in this directory are reflected inside the dev container. Commit code changes on `Metapi-fork`; do not commit `.env`, `data/`, Cookies, Tokens, callback URLs, or database dumps.

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
- Third-party login credentials: reusable login material for target sites, currently LinuxDO Cookie plus target-site Session material captured after browser login.

GitHub and Google target-site login starts from `连接管理 -> 添加 Session 连接`: select the target site, then click `用 GitHub/Google 浏览器登录该站点`. This opens the target station's own login page so the browser can reuse the already logged-in GitHub/Google identity. The resulting target-site Session is then saved through the browser credential capture flow.

Adding a Session connection can query the selected site's login requirements, open the target station's browser login, or reuse saved third-party credentials to create a normal Session account. Browser-assisted import only parses text the operator pastes manually; it does not read cross-site HttpOnly Cookies.

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
