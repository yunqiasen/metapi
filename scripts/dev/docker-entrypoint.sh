#!/bin/sh
set -eu

FRONTEND_PORT="${FRONTEND_PORT:-4000}"
LOCK_MARKER="./node_modules/.metapi-package-lock.sha256"
LOCK_HASH="$(sha256sum ./package-lock.json | awk '{print $1}')"
INSTALLED_HASH="$(cat "$LOCK_MARKER" 2>/dev/null || true)"

if [ ! -x ./node_modules/.bin/vite ] \
  || [ ! -x ./node_modules/.bin/tsx ] \
  || [ ! -x ./node_modules/.bin/concurrently ] \
  || [ "$LOCK_HASH" != "$INSTALLED_HASH" ]; then
  npm ci --ignore-scripts --no-audit --no-fund
  npm rebuild esbuild sharp better-sqlite3 --no-audit --no-fund
  printf '%s\n' "$LOCK_HASH" > "$LOCK_MARKER"
fi

exec ./node_modules/.bin/concurrently \
  "npm run dev:server" \
  "./node_modules/.bin/vite --host 0.0.0.0 --port ${FRONTEND_PORT}"
