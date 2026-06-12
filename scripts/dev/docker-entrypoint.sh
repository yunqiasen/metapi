#!/bin/sh
set -eu

FRONTEND_PORT="${FRONTEND_PORT:-4000}"

if [ ! -x ./node_modules/.bin/vite ] || [ ! -x ./node_modules/.bin/tsx ] || [ ! -x ./node_modules/.bin/concurrently ]; then
  npm ci --ignore-scripts --no-audit --no-fund
  npm rebuild esbuild sharp better-sqlite3 --no-audit --no-fund
fi

exec ./node_modules/.bin/concurrently \
  "npm run dev:server" \
  "./node_modules/.bin/vite --host 0.0.0.0 --port ${FRONTEND_PORT}"
