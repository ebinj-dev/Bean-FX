#!/usr/bin/env bash
# BEAN FX — M41 Phase B: stage-2 suite classification runner.
#
# Mirrors scripts/release-qualify.sh stage 2 EXACTLY (same server isolation on
# :3117, same live-suite exclusions, same sequential per-file execution — the
# M40-established isolation requirements) but records per-suite evidence for
# the M41 classification:
#   /home/z/my-project/m41-evidence/stage2/
#     suite-logs/<suite>.log     — full bun test output per suite
#     results.jsonl              — {suite, exit, seconds, outcome} per suite
#     server.log                 — stage-2 server log
#     summary.txt                — final pass/fail tally
#
# Safety: the runner shell exports DATABASE_URL pointing at a SCRATCH file so
# any suite that neither sets its own scratch DB nor talks to the :3117 server
# can never create or touch a repo-relative dev DB. Suites that set their own
# DATABASE_URL override this (unchanged behavior). The 3 mandatory-gate live
# suites are excluded exactly as in release-qualify stage 2 (they are stage 3).
set -uo pipefail
cd "$(dirname "$0")/.."

EVDIR=/home/z/my-project/m41-evidence/stage2
rm -rf "$EVDIR"; mkdir -p "$EVDIR/suite-logs"
RES="$EVDIR/results.jsonl"; : > "$RES"

LIVE_SUITES="test-m20-durable-render.test.ts|test-m38-live.test.ts|test-m39-batch-ranges.test.ts"
SUITES=$(ls scripts/*.test.ts 2>/dev/null | grep -Ev "$LIVE_SUITES" || true)
[ -z "$SUITES" ] && { echo "no suites found"; exit 2; }
TOTAL=$(echo "$SUITES" | wc -l)
echo "[m41] stage-2 classification: $TOTAL suites (live gate suites excluded)"

STAGE2_DB="$(mktemp /tmp/beanfx-m41stage2-XXXXXX.db)"
STAGE2_MEDIA="$(mktemp -d /tmp/beanfx-m41stage2-media-XXXXXX)"
SHELL_DB="$(mktemp /tmp/beanfx-m41shell-XXXXXX.db)"
STAGE2_PID=""
cleanup() {
  if [ -n "$STAGE2_PID" ] && kill -0 "$STAGE2_PID" 2>/dev/null; then
    kill "$STAGE2_PID" 2>/dev/null || true; sleep 2; kill -9 "$STAGE2_PID" 2>/dev/null || true
  fi
  rm -f "$STAGE2_DB" "$STAGE2_DB"-shm "$STAGE2_DB"-wal "$SHELL_DB" "$SHELL_DB"-shm "$SHELL_DB"-wal
  rm -rf "$STAGE2_MEDIA"
  rm -rf /tmp/beanfx-m41stage2-*.db* /tmp/beanfx-m41stage2-media-* /tmp/beanfx-m41shell-*.db*
}
trap cleanup EXIT
case "$STAGE2_DB" in *"/db/"*) echo "refusing dev DB"; exit 2; ;; esac

# Schema goes ONLY on the two scratch DBs (server scratch + runner-shell
# scratch). Never the repo-relative default path.
DATABASE_URL="file:$STAGE2_DB" node_modules/.bin/prisma db push --skip-generate >/dev/null
DATABASE_URL="file:$SHELL_DB" node_modules/.bin/prisma db push --skip-generate >/dev/null
mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static; cp -r .next/static .next/standalone/.next/static
rm -rf .next/standalone/public; cp -r public .next/standalone/public 2>/dev/null || true
DATABASE_URL="file:$STAGE2_DB" BEANFX_DATA_DIR="$STAGE2_MEDIA" PORT=3117 RATE_LIMIT_SCALE="50" \
  HOSTNAME="127.0.0.1" node .next/standalone/server.js > "$EVDIR/server.log" 2>&1 &
STAGE2_PID=$!
for i in $(seq 1 90); do
  curl -fsS http://127.0.0.1:3117/api/health >/dev/null 2>&1 && break
  kill -0 "$STAGE2_PID" 2>/dev/null || { echo "stage-2 server died — see $EVDIR/server.log"; exit 3; }
  sleep 1
done
curl -fsS http://127.0.0.1:3117/api/health >/dev/null 2>&1 || { echo "stage-2 server never healthy"; exit 3; }
echo "[m41] stage-2 server healthy on :3117 (pid $STAGE2_PID)"

bun --version > "$EVDIR/env.txt" 2>&1
node --version >> "$EVDIR/env.txt" 2>&1
ffmpeg -version 2>/dev/null | head -1 >> "$EVDIR/env.txt" || echo "ffmpeg MISSING" >> "$EVDIR/env.txt"

FAILCOUNT=0; PASSCOUNT=0; TIMEOUTCOUNT=0; IDX=0
for f in $SUITES; do
  IDX=$((IDX+1)); BN=$(basename "$f")
  printf '[m41] (%d/%d) %s … ' "$IDX" "$TOTAL" "$BN"
  LOG="$EVDIR/suite-logs/$BN.log"
  START=$(date +%s); RC=0
  # The shell scratch DATABASE_URL is a safety net for suites that rely on the
  # prisma default; suites setting their own scratch DB override it, and
  # server-facing suites are unaffected (they speak HTTP to :3117).
  # NOTE: RATE_LIMIT_SCALE is deliberately NOT set here — the :3117 SERVER
  # carries scale=50 (release-qualify stage-2 contract), but suites must see
  # the ambient default (scale=1) or in-process limiter unit assertions (m23
  # R5) cannot observe the documented limits. Mirrors release-qualify.sh.
  if DATABASE_URL="file:$STAGE2_DB" BEANFX_LEGACY_TEST_DB="file:$STAGE2_DB" \
       M31_DB="file:$STAGE2_DB" M31_BASE="http://127.0.0.1:3117" M33_BASE="http://127.0.0.1:3117" \
       BEANFX_DATA_DIR="$STAGE2_MEDIA" \
       timeout 300 bun test "$f" > "$LOG" 2>&1; then
    OUTCOME="PASS"; PASSCOUNT=$((PASSCOUNT+1)); echo "PASS"
  else
    RC=$?
    if [ "$RC" -eq 124 ]; then OUTCOME="TIMEOUT(300s)"; TIMEOUTCOUNT=$((TIMEOUTCOUNT+1)); else OUTCOME="FAIL($RC)"; FAILCOUNT=$((FAILCOUNT+1)); fi
    echo "$OUTCOME"
  fi
  END=$(date +%s)
  ERRHEAD=$(grep -E "\(fail\)|error:|throw|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EADDRINUSE|fetch failed|timed out" "$LOG" | head -2 | tr '\n' ' | ' | cut -c1-220)
  printf '{"suite":"%s","exit":"%s","seconds":%d,"outcome":"%s","errHead":"%s"}\n' \
    "$BN" "$RC" "$((END-START))" "$OUTCOME" "$ERRHEAD" >> "$RES"
done

{
  echo "M41 stage-2 classification — $(date -u +%FT%TZ)"
  echo "total=$TOTAL pass=$PASSCOUNT fail=$FAILCOUNT timeout=$TIMEOUTCOUNT"
  echo "failures:"
  grep '"outcome":"FAIL\|"outcome":"TIMEOUT' "$RES" | sed 's/^/  /' || true
} > "$EVDIR/summary.txt"
cat "$EVDIR/summary.txt"
echo "[m41] evidence: $EVDIR"
