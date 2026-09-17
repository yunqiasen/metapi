#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$ROOT"
node scripts/deploy/main-repairs-guard.mjs --source "$ROOT"
COMMIT="$(git rev-parse HEAD)"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/metapi-release-XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
SOURCE="$WORK/source"
CONTEXT="$WORK/runtime"
mkdir -p "$SOURCE" "$CONTEXT"
# No branch switch, mutable dist, .env, or database enters the build context.
git archive "$COMMIT" | tar -x -C "$SOURCE"
ln -s "$ROOT/node_modules" "$SOURCE/node_modules"
(cd "$SOURCE" && DOTENV_CONFIG_PATH=/dev/null npm run build)
[[ "$(git rev-parse HEAD)" == "$COMMIT" ]] || { echo 'source commit changed during build' >&2; exit 1; }
node scripts/deploy/main-repairs-guard.mjs --write-manifest "$SOURCE" "$ROOT"
SOURCE_HASH="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sourceTreeSha256' "$SOURCE/main-repairs-manifest.json")"
IMAGE="${1:-metapi:frok2-${COMMIT:0:12}-$STAMP-${SOURCE_HASH:0:12}}"
cp -a "$SOURCE/dist" "$SOURCE/drizzle" "$SOURCE/package.json" "$SOURCE/package-lock.json" "$SOURCE/main-repairs-manifest.json" "$CONTEXT/"
mkdir -p "$CONTEXT/scripts/deploy"
cp "$SOURCE/scripts/deploy/main-repairs-guard.mjs" "$CONTEXT/scripts/deploy/"
cp "$SOURCE/scripts/deploy/main-repairs-runtime.Dockerfile" "$CONTEXT/Dockerfile"
(cd "$CONTEXT" && npm ci --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund)
# Host/runtime use Node 22 ABI 127. Verify the binding again inside the image.
mkdir -p "$CONTEXT/node_modules/better-sqlite3/build/Release"
cp "$ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "$CONTEXT/node_modules/better-sqlite3/build/Release/"
BUILD_ARGS=()
if [[ -n "${MAIN_REPAIRS_BUILD_PROXY:-}" ]]; then
  BUILD_ARGS+=(--build-arg "HTTP_PROXY=$MAIN_REPAIRS_BUILD_PROXY" --build-arg "HTTPS_PROXY=$MAIN_REPAIRS_BUILD_PROXY" --build-arg "http_proxy=$MAIN_REPAIRS_BUILD_PROXY" --build-arg "https_proxy=$MAIN_REPAIRS_BUILD_PROXY")
fi
docker build "${BUILD_ARGS[@]}" --label io.metapi.flavor=main-with-local-repairs \
  --label "io.metapi.source-tree=$SOURCE_HASH" \
  --label "io.metapi.source-worktree=$ROOT" \
  --label org.opencontainers.image.source=https://github.com/yunqiasen/metapi \
  --label io.metapi.upstream=https://github.com/cita-777/metapi \
  --label "org.opencontainers.image.revision=$COMMIT" \
  -t "$IMAGE" "$CONTEXT"
docker run --rm --network none --read-only --entrypoint node "$IMAGE" scripts/deploy/main-repairs-guard.mjs --runtime /app
cp "$SOURCE/main-repairs-manifest.json" "$ROOT/main-repairs-manifest.json"
printf '%s\n' "$IMAGE" > "$ROOT/.main-repairs-image"
printf 'Built and verified: %s\n' "$IMAGE"
