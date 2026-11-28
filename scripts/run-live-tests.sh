#!/usr/bin/env bash
# M48-G0 — disposable live-server test environment for the live suites
# (m19-security, m20-durable-render, export-safety).
#
# The live suites expect a production server on :3117 (documented in
# docs/M19_TEST_RESULTS.md: RATE_LIMIT_SCALE=50). This runner:
#   1. frees :3117 and creates a FRESH scratch SQLite DB (never db/custom.db)
#   2. boots the production server with RATE_LIMIT_SCALE=50
#   3. runs test-m19-security.test.ts against it
#   4. runs test-m20-durable-render.test.ts (it manages its own :3117
#      lifecycle: kills the boot server and respawns from the checkout with
#      its own scratch DB — that is part of the durability sweep by design)
#   5. runs test-export-safety.test.ts (pure unit suite, no server needed)
#   6. tears the environment down and prints a per-suite summary
#
# Assertions are never modified. Run: bash scripts/run-live-tests.sh [outdir]
set -u
cd "$(dirname "$0")/.."

OUTDIR="${1:-/tmp/g0-live}"
mkdir -p "$OUTDIR"
# m20-durable-render binds its own PrismaClient (and respawns :3117 with) the
# scratchLegacyDb("m20-durable-render") path — the boot server MUST run on the
# same file so the suite's setup (via API) and its direct DB reads align.
SCRATCH_DB="/tmp/beanfx-legacy-m20-durable-render.db"
rm -f "$SCRATCH_DB"
LOG="$OUTDIR/server.log"
SUMMARY="$OUTDIR/summary.txt"

free_port() {
  for PID in $(ss -tlnp 2>/dev/null | grep ':3117 ' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
    kill "$PID" 2>/dev/null || true
  done
  sleep 2
}

free_port
export DATABASE_URL="file:$SCRATCH_DB"
npx prisma db push --skip-generate > "$OUTDIR/dbpush.log" 2>&1 || { echo "db push FAILED"; tail -5 "$OUTDIR/dbpush.log"; exit 1; }

echo "== booting disposable production server on :3117 (scratch DB: $SCRATCH_DB)"
PORT=3117 RATE_LIMIT_SCALE=50 DATABASE_URL="file:$SCRATCH_DB" bash scripts/dev-server.sh start > "$LOG" 2>&1 &
BOOT_PID=$!
UP=0
for i in $(seq 1 30); do
  sleep 5
  if curl -s -m 5 http://localhost:3117/api/health | grep -q ok; then UP=1; break; fi
done
if [ "$UP" != "1" ]; then echo "server failed to boot"; tail -10 "$LOG"; exit 1; fi
echo "== server up (~$((i * 5))s)"

run_suite() {
  local name="$1"; shift
  echo "== running $name"
  bun test "$@" > "$OUTDIR/$name.log" 2>&1
  local rc=$?
  local fails
  fails=$(grep -cE '\(fail\)' "$OUTDIR/$name.log" || true)
  local total
  total=$(grep -oE 'Ran [0-9]+ tests' "$OUTDIR/$name.log" | tail -1)
  echo "$name: exit=$rc fails=$fails ($total)" | tee -a "$SUMMARY"
}

: > "$SUMMARY"
run_suite m19-security scripts/test-m19-security.test.ts
run_suite m20-durable-render scripts/test-m20-durable-render.test.ts
run_suite export-safety scripts/test-export-safety.test.ts

# teardown: whatever is on :3117 (m20's respawn or the boot server) + scratch DB
free_port
kill "$BOOT_PID" 2>/dev/null || true
rm -f "$SCRATCH_DB"
echo "== teardown done"
echo "== summary"; cat "$SUMMARY"
