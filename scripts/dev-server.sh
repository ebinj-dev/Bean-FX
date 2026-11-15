#!/usr/bin/env bash
# BEAN FX — production server helper (referenced by package.json "start").
# The build uses next output:"standalone": run the standalone server with the
# static assets copied into place; build first if the output is missing.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .next/BUILD_ID ]; then
  echo "[dev-server] no build output — building…"
  bun run build
fi
mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static
cp -r .next/static .next/standalone/.next/static
if [ -d public ]; then
  rm -rf .next/standalone/public
  cp -r public .next/standalone/public
fi
PORT="${PORT:-3000}"
HOSTNAME="${BIND_HOST:-0.0.0.0}"
echo "[dev-server] starting standalone server on :$PORT"
exec env DATABASE_URL="${DATABASE_URL:-file:$(pwd)/db/custom.db}" PORT="$PORT" HOSTNAME="${BIND_HOST:-0.0.0.0}" node .next/standalone/server.js
