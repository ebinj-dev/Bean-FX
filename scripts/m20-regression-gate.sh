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
# M40 §5 — detached/CI shells can carry a minimal PATH without /usr/sbin
# (psmisc's fuser). Without it the pre-flight guard silently skips and the
# identity check dies with 127 under set -e. Pin the tool locations.
export PATH="/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin:$PATH"

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
  for OPID in $(port_owner_pids); do kill -9 "$OPID" 2>/dev/null || true; done
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

# M40 §5 — PRE-FLIGHT PORT GUARD: refuse to adopt a server already on the
# port (e.g. a previous run's detached T4 respawn). Adopting a stale server
# pairs the suite's HTTP traffic with the WRONG scratch DB — the M40 run that
# found this produced honest "export row missing" failures instead of silent
# false-passes. Kill the stale holder, then require a genuinely free port.
# Port ownership checks use ss (iproute2) — fuser/psmisc is not installed in
# every deployment image; ss reports the owning PID for LISTEN sockets.
SS_BIN="$(command -v ss || true)"
if [ -z "$SS_BIN" ]; then
  echo "[gate] FATAL: ss (iproute2) not found — required for port-ownership checks." >&2
  exit 4
fi
port_occupied() { [ -n "$("$SS_BIN" -H -ltn "sport = :${PORT}" 2>/dev/null)" ]; }
port_owner_pids() { "$SS_BIN" -H -ltnp "sport = :${PORT}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | tr '
' ' '; }
if port_occupied; then
  echo "[gate] port $PORT is occupied — killing the stale holder (previous run's respawn?)…"
  for OPID in $(port_owner_pids); do kill -9 "$OPID" 2>/dev/null || true; done
  sleep 3
  if port_occupied; then
    echo "[gate] FATAL: port $PORT is still occupied — free it manually (fuser -k ${PORT}/tcp) and re-run." >&2
    exit 4
  fi
fi

# M40 §5 — STALE-ARTIFACT SWEEP: a gate run killed before its EXIT trap fires
# (SIGKILL of the whole session) leaves its scratch files behind. With the
# port now verifiably free, no gate server can be alive, so any leftover
# beanfx-m20-gate-* scratch resources belong to dead runs and are safe to
# remove. The gate then cleans up only its OWN resources as before.
STALE=$(find /tmp -maxdepth 1 \( -name "beanfx-m20-gate-*.db" -o -name "beanfx-m20-gate-*.db-shm" -o -name "beanfx-m20-gate-*.db-wal" -o -name "beanfx-m20-gate-media-*" \) 2>/dev/null || true)
if [ -n "$STALE" ]; then
  echo "[gate] sweeping stale scratch from an abruptly-killed earlier run:"
  printf '%s\n' "$STALE" | sed 's/^/[gate]   /'
  rm -rf /tmp/beanfx-m20-gate-*.db /tmp/beanfx-m20-gate-*.db-shm /tmp/beanfx-m20-gate-*.db-wal /tmp/beanfx-m20-gate-media-*
fi

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
# M40 §5 — IDENTITY CHECK: the process that ANSWERS the port must be OUR
# server. The standalone server does not exit on EADDRINUSE (it logs and
# keeps running without listening), so a stale T4 respawn can answer the
# health probe while our own process holds a dead socket — the suite would
# then run HTTP against a server whose scratch DB is not ours (observed in
# the M40 qualification: honest "export row missing" failures). Compare the
# port owner PID against our child, and refuse runs whose log shows a bind
# failure.
sleep 1
PORT_OWNER="$(port_owner_pids)"
if [ -z "$PORT_OWNER" ]; then
  echo "[gate] FATAL: nothing owns port $PORT although the health probe passed — the answering server vanished; refusing to run against a phantom." >&2
  exit 4
fi
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "[gate] FATAL: our server process died during startup." >&2
  exit 3
fi
case " $PORT_OWNER " in
  *" $SERVER_PID "*) ;; # ours — good
  *)
    echo "[gate] FATAL: port $PORT is owned by PID(s) '$PORT_OWNER', not our server ($SERVER_PID) — refusing to adopt a stale server." >&2
    exit 4 ;;
esac
if grep -q "EADDRINUSE" "$EVIDENCE/gate-server.log" 2>/dev/null; then
  echo "[gate] FATAL: our server failed to bind the port (EADDRINUSE in gate-server.log) — a stale holder raced the startup." >&2
  exit 4
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
