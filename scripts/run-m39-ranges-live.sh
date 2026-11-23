#!/usr/bin/env bash
# BEAN FX — M39 §7 runner: per-item batch timeline ranges LIVE suite.
#
# Boots a REAL production standalone server on isolated resources (scratch
# SQLite DB + scratch media root + isolated port, never db/custom.db or real
# user storage) and runs scripts/test-m39-batch-ranges.test.ts with real
# FFmpeg: mixed-format, independent-range batches; all-or-nothing range
# validation; range-aware duplicate protection; ffprobe-validated durations.
#
# Usage:
#   scripts/run-m39-ranges-live.sh              # build + run
#   SKIP_BUILD=1 scripts/run-m39-ranges-live.sh # reuse an existing .next build
#   KEEP=1 scripts/run-m39-ranges-live.sh       # keep scratch DB/media for inspection
#
# Exit code 0 = all range scenarios passed; nonzero = REQUIRED FAILURE.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3121}"
BASE="http://127.0.0.1:${PORT}"

SCRATCH_DB="$(mktemp /tmp/beanfx-m39-ranges-XXXXXX.db)"
SCRATCH_MEDIA="$(mktemp -d /tmp/beanfx-m39-ranges-media-XXXXXX)"
SERVER_PID=""
RUN_EXIT=1

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    sleep 2
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  if [ "${KEEP:-0}" != "1" ]; then
    rm -f "$SCRATCH_DB" "$SCRATCH_DB-shm" "$SCRATCH_DB-wal"
    rm -rf "$SCRATCH_MEDIA"
  else
    echo "[m39-ranges] KEEP=1 — scratch DB: $SCRATCH_DB media: $SCRATCH_MEDIA"
  fi
}
trap cleanup EXIT

case "$SCRATCH_DB" in *"/db/"*) echo "[m39-ranges] refusing dev DB"; exit 2; ;; esac

echo "[m39-ranges] scratch DB:   $SCRATCH_DB"
echo "[m39-ranges] scratch media: $SCRATCH_MEDIA"
echo "[m39-ranges] port:          $PORT"

if [ "${SKIP_BUILD:-0}" != "1" ] || [ ! -f .next/BUILD_ID ]; then
  echo "[m39-ranges] building production bundle…"
  bun run build
else
  echo "[m39-ranges] reusing existing .next build (SKIP_BUILD=1)"
fi

echo "[m39-ranges] applying schema to scratch DB…"
DATABASE_URL="file:$SCRATCH_DB" node_modules/.bin/prisma db push --skip-generate >/dev/null

mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static
cp -r .next/static .next/standalone/.next/static
rm -rf .next/standalone/public
cp -r public .next/standalone/public 2>/dev/null || true

echo "[m39-ranges] starting standalone server on :$PORT…"
DATABASE_URL="file:$SCRATCH_DB" BEANFX_DATA_DIR="$SCRATCH_MEDIA" PORT="$PORT" \
  HOSTNAME="127.0.0.1" node .next/standalone/server.js > "/tmp/m39-ranges-server-${PORT}.log" 2>&1 &
SERVER_PID=$!

for i in $(seq 1 90); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[m39-ranges] FATAL: server exited during startup — see /tmp/m39-ranges-server-${PORT}.log" >&2
    exit 3
  fi
  sleep 1
done
if ! curl -fsS "$BASE/api/health" >/dev/null 2>&1; then
  echo "[m39-ranges] FATAL: server never became healthy" >&2
  exit 3
fi
echo "[m39-ranges] server healthy — running the per-item range live suite…"

set +e
BASE="$BASE" BEANFX_DATA_DIR="$SCRATCH_MEDIA" \
  bun test scripts/test-m39-batch-ranges.test.ts 2>&1 | tee "/tmp/m39-ranges-run-${PORT}.log"
RUN_EXIT=${PIPESTATUS[0]}
set -e

if [ "$RUN_EXIT" -ne 0 ]; then
  echo "[m39-ranges] RESULT: FAIL (bun test exit $RUN_EXIT)"
else
  echo "[m39-ranges] RESULT: PASS — per-item range live suite green; evidence in /home/z/my-project/m39-evidence"
fi
exit "$RUN_EXIT"
