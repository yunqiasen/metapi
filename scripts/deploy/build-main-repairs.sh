#!/usr/bin/env bash
set -euo pipefail
# The source is the script's worktree, never the caller's working directory.
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$ROOT"
node scripts/deploy/main-repairs-guard.mjs --source "$ROOT"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${MAIN_REPAIRS_BACKUP_DIR:-$(dirname "$ROOT")/metapi-main-build-backup-$STAMP}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
if [[ -d dist ]]; then mv dist "$BACKUP_DIR/dist-before-$STAMP"; fi
npm run build
node scripts/deploy/main-repairs-guard.mjs --write-manifest "$ROOT"
SOURCE_HASH="$(node -p 'JSON.parse(require("fs").readFileSync("main-repairs-manifest.json","utf8")).sourceTreeSha256')"
IMAGE="${1:-metapi:main-repairs-41767a6-$STAMP-${SOURCE_HASH:0:12}}"
CONTEXT="$(mktemp -d /tmp/metapi-main-repairs-runtime-XXXXXX)"
chmod 700 "$CONTEXT"
printf '%s\n' "$CONTEXT" > "$BACKUP_DIR/build-context-path"
cp -a dist drizzle package.json package-lock.json main-repairs-manifest.json "$CONTEXT/"
mkdir -p "$CONTEXT/scripts/deploy"
cp scripts/deploy/main-repairs-guard.mjs "$CONTEXT/scripts/deploy/"
cp scripts/deploy/main-repairs-runtime.Dockerfile "$CONTEXT/Dockerfile"
(
  cd "$CONTEXT"
  npm ci --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund
)
# The host and runtime both use Node 22 ABI 127. Verify the binding inside Docker.
mkdir -p "$CONTEXT/node_modules/better-sqlite3/build/Release"
cp node_modules/better-sqlite3/build/Release/better_sqlite3.node "$CONTEXT/node_modules/better-sqlite3/build/Release/"
BUILD_ARGS=()
if [[ -n "${MAIN_REPAIRS_BUILD_PROXY:-}" ]]; then
  BUILD_ARGS+=(--build-arg "HTTP_PROXY=$MAIN_REPAIRS_BUILD_PROXY" --build-arg "HTTPS_PROXY=$MAIN_REPAIRS_BUILD_PROXY" --build-arg "http_proxy=$MAIN_REPAIRS_BUILD_PROXY" --build-arg "https_proxy=$MAIN_REPAIRS_BUILD_PROXY")
fi
docker build "${BUILD_ARGS[@]}" --label io.metapi.flavor=main-with-local-repairs \
  --label "io.metapi.source-tree=$SOURCE_HASH" \
  --label "io.metapi.source-worktree=$ROOT" \
  --label org.opencontainers.image.source=https://github.com/cita-777/metapi \
  --label org.opencontainers.image.revision=41767a65ec8e5470a9a70f4615b47dc24949afff \
  -t "$IMAGE" "$CONTEXT"
docker run --rm --network none --entrypoint node "$IMAGE" scripts/deploy/main-repairs-guard.mjs --runtime /app
printf '%s\n' "$IMAGE" > "$BACKUP_DIR/restored-image"
printf '%s\n' "$IMAGE" > "$ROOT/.main-repairs-image"
printf 'Built and verified: %s\n' "$IMAGE"
