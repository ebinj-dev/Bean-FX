#!/usr/bin/env bash
# BEAN FX — M39 §5: STANDING M20 durable-render regression gate.
#
# Runs the COMPLETE M20 live suite (scripts/test-m20-durable-render.test.ts:
# 60s/300s/600s renders, SIGKILL recovery, OOM sweep, cancellation, duplicate
# submission) against a REAL production standalone server + real FFmpeg using
# ISOLATED resources only:
#
#   - scratch SQLite DB   (never db/custom.db; refuses to overlap it)
#   - scratch media root  (BEANFX_DATA_DIR — never real user storage)
#   - isolated port       (default 3117; override with PORT=)
#
# The suite writes machine-readable evidence to
#   /home/z/my-project/download/m20-render-logs/durable-render-results.json
# and this gate adds
#   gate-summary.json (scenario table + exit code) and gate-server.log.
#
# Prerequisites: bun, node, ffmpeg/ffprobe, an npm install with dev deps.
#
# Usage:
#   scripts/m20-regression-gate.sh              # build + run (~25-40 min)
#   SKIP_BUILD=1 scripts/m20-regression-gate.sh # reuse an existing .next build
#   KEEP=1 scripts/m20-regression-gate.sh       # keep scratch DB/media/logs
#
# Exit codes: 0 = all M20 scenarios passed; nonzero = REQUIRED FAILURE (the
# gate is a release/pre-publication qualifier — never a soft warning).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3117}"
BASE="http://127.0.0.1:${PORT}"
EVIDENCE="/home/z/my-project/download/m20-render-logs"
mkdir -p "$EVIDENCE"

SCRATCH_DB="$(mktemp /tmp/beanfx-m20-gate-XXXXXX.db)"
SCRATCH_MEDIA="$(mktemp -d /tmp/beanfx-m20-gate-media-XXXXXX)"
SERVER_PID=""
GATE_EXIT=1

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    sleep 2
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  # The M20 T4 scenario RESPAWNS the server itself (detached) — release the
  # gate's own port so the next run cannot adopt a stale server/DB pairing.
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  if [ "${KEEP:-0}" != "1" ]; then
    rm -f "$SCRATCH_DB" "$SCRATCH_DB-shm" "$SCRATCH_DB-wal"
    rm -rf "$SCRATCH_MEDIA"
  else
    echo "[gate] KEEP=1 — scratch DB: $SCRATCH_DB media: $SCRATCH_MEDIA"
  fi
}
trap cleanup EXIT

# Refuse to point the gate at the development database or real media.
case "$SCRATCH_DB" in *"/db/"*) echo "[gate] refusing dev DB"; exit 2; ;; esac

echo "[gate] scratch DB:   $SCRATCH_DB"
echo "[gate] scratch media: $SCRATCH_MEDIA"
echo "[gate] port:          $PORT"

# 1. Build the intended version (unless explicitly reusing an existing build).
if [ "${SKIP_BUILD:-0}" != "1" ] || [ ! -f .next/BUILD_ID ]; then
  echo "[gate] building production bundle…"
  bun run build
else
  echo "[gate] reusing existing .next build (SKIP_BUILD=1)"
fi

# 2. Apply the CURRENT schema to the scratch DB (repo uses prisma db push).
echo "[gate] applying schema to scratch DB…"
DATABASE_URL="file:$SCRATCH_DB" node_modules/.bin/prisma db push --skip-generate >/dev/null

# 3. Standalone server assets (same convention as scripts/dev-server.sh).
mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static
cp -r .next/static .next/standalone/.next/static
rm -rf .next/standalone/public
cp -r public .next/standalone/public 2>/dev/null || true

# 4. Start the REAL server on isolated resources (worker autostarts inside).
echo "[gate] starting standalone server on :$PORT…"
DATABASE_URL="file:$SCRATCH_DB" BEANFX_DATA_DIR="$SCRATCH_MEDIA" PORT="$PORT" \
  HOSTNAME="127.0.0.1" node .next/standalone/server.js > "$EVIDENCE/gate-server.log" 2>&1 &
SERVER_PID=$!

# 5. Health-wait (up to 90 s).
for i in $(seq 1 90); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[gate] FATAL: server exited during startup — see $EVIDENCE/gate-server.log" >&2
    exit 3
  fi
  sleep 1
done
if ! curl -fsS "$BASE/api/health" >/dev/null 2>&1; then
  echo "[gate] FATAL: server never became healthy" >&2
  exit 3
fi
echo "[gate] server healthy — running the FULL M20 live suite…"

# 6. Run the complete M20 suite against the pinned scratch DB (hybrid suite:
#    direct DB reads via BEANFX_LEGACY_TEST_DB + HTTP against the same file).
#    BEANFX_DATA_DIR is EXPORTED so the T4 respawn inherits the isolated
#    media root (the respawn env spreads process.env).
set +e
BASE="$BASE" BEANFX_LEGACY_TEST_DB="$SCRATCH_DB" BEANFX_DATA_DIR="$SCRATCH_MEDIA" \
  bun test scripts/test-m20-durable-render.test.ts 2>&1 | tee "$EVIDENCE/gate-run.log"
TEST_EXIT=${PIPESTATUS[0]}
set -e

# 7. Machine-readable gate summary from the suite's own results file.
node -e '
const fs = require("fs");
const path = "/home/z/my-project/download/m20-render-logs/durable-render-results.json";
let scenarios = [];
let raw = {};
try { raw = JSON.parse(fs.readFileSync(path, "utf8")); } catch { /* suite may have failed early */ }
const renders = raw.renders ?? {};
const ops = raw.ops ?? {};
for (const [k, v] of Object.entries(renders)) scenarios.push({ id: k, kind: "render", ...(typeof v === "object" ? v : { result: v }) });
for (const [k, v] of Object.entries(ops)) scenarios.push({ id: k, kind: "op", ...(typeof v === "object" ? v : { result: v }) });
fs.writeFileSync("/home/z/my-project/download/m20-render-logs/gate-summary.json",
  JSON.stringify({ ranAt: new Date().toISOString(), testExitCode: Number(process.argv[1]), scenarioCount: scenarios.length, scenarios }, null, 1));
' "$TEST_EXIT" || true

if [ "$TEST_EXIT" -ne 0 ]; then
  echo "[gate] RESULT: FAIL (bun test exit $TEST_EXIT) — evidence in $EVIDENCE"
  GATE_EXIT="$TEST_EXIT"
else
  echo "[gate] RESULT: PASS — full M20 live suite green; evidence in $EVIDENCE"
  GATE_EXIT=0
fi
exit "$GATE_EXIT"
