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

Do not commit `.env`, `data/`, or generated local runtime files.
