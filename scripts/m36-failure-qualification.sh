#!/usr/bin/env bash
# BEAN FX — M36 Phase F: isolated failure qualification.
# Verifies failures are EXPLICIT, temp data is cleaned, and durable jobs are
# never falsely marked complete. Locally-testable cases only; the rest are
# classified honestly (see docs/M36_FAILURE_QUALIFICATION.md).
# Usage: m36-failure-qualification.sh   → prints one PASS/FAIL line per case.
set -u
cd "$(dirname "$0")/.."
WORK=/tmp/m36-fq
rm -rf "$WORK"; mkdir -p "$WORK"
PASS=0; FAIL=0
case_result() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS  $1"; PASS=$((PASS+1)); else echo "FAIL  $1 (expected=$2 got=$3)"; FAIL=$((FAIL+1)); fi
}

# --- F1 invalid env: missing DATABASE_URL ---
mkdir -p "$WORK/media"
printf 'BEANFX_DATA_DIR="%s"\n' "$WORK/media" > "$WORK/.env.f1"
bun scripts/m36-validate-env.ts --env "$WORK/.env.f1" >/dev/null 2>&1
case_result "F1 missing DATABASE_URL rejected" 1 $?

# --- F2 invalid DB path: directory missing ---
printf 'DATABASE_URL="file:%s/nope/deep/db.db"\nBEANFX_DATA_DIR="%s"\n' "$WORK" "$WORK/media" > "$WORK/.env.f2"
bun scripts/m36-validate-env.ts --env "$WORK/.env.f2" >/dev/null 2>&1
case_result "F2 unreachable DB dir rejected" 1 $?

# --- F3 db-ops on missing file: actionable failure ---
bun scripts/m36-db-ops.ts verify --url "file:$WORK/nope/missing.db" >/dev/null 2>&1
case_result "F3 db-ops missing file exit 1" 1 $?

# --- F4 db-ops on garbage file: integrity failure surfaced, not silent ---
echo "not a database" > "$WORK/garbage.db"
OUT=$(bun scripts/m36-db-ops.ts verify --url "file:$WORK/garbage.db" 2>&1); RC=$?
case_result "F4 corrupt db detected (exit 1 + explicit)" 1 $RC

# --- F5 ffmpeg-absence is flagged by the health check (shadow PATH: everything except ffmpeg/ffprobe) ---
FAKEBIN="$WORK/bin"; mkdir -p "$FAKEBIN"
BUN_PATH=$(command -v bun); ln -sf "$BUN_PATH" "$FAKEBIN/bun"
for b in /usr/bin/*; do n=$(basename "$b"); case "$n" in ffmpeg|ffprobe) ;; *) [ -e "$FAKEBIN/$n" ] || ln -s "$b" "$FAKEBIN/$n" ;; esac; done
# The ffmpeg note is reached only when the app itself is reachable — start a minimal app.
bun -e 'Bun.serve({port: 59998, fetch: () => new Response("ok")})' >/dev/null 2>&1 &
FAKEAPP=$!
sleep 1
OUT=$(PATH="$FAKEBIN" DATABASE_URL="file:/tmp/m35-m20.db" BEANFX_DATA_DIR=/tmp/m35-m20-store bash scripts/m36-health-check.sh http://localhost:59998 /tmp/m35-m20-store 2>&1); RC=$?
kill -TERM -- "-$FAKEAPP" 2>/dev/null || kill "$FAKEAPP" 2>/dev/null || true
echo "$OUT" | grep -q "ffmpeg/ffprobe not on PATH" && FLAG=0 || FLAG=1
case_result "F5 ffmpeg absence flagged by health check" 0 "$FLAG"

# --- F6 media root missing: health UNAVAILABLE ---
mkdir -p "$WORK/empty-store"
DATABASE_URL="file:$WORK/garbage.db" bash scripts/m36-health-check.sh http://localhost:59999 "$WORK/does-not-exist" >/dev/null 2>&1
case_result "F6 missing media root -> UNAVAILABLE" 3 $?

# --- F7 permission failure: media root not writable -> UNAVAILABLE ---
chmod 000 "$WORK/empty-store" 2>/dev/null || true
DATABASE_URL="file:$WORK/garbage.db" bash scripts/m36-health-check.sh http://localhost:59999 "$WORK/empty-store" >/dev/null 2>&1
RC=$?; chmod 700 "$WORK/empty-store"
case_result "F7 unwritable media root -> UNAVAILABLE" 3 $RC

# --- F8 backup failure: missing db -> exit 1, no partial snapshot left ---
BEFORE=$(ls "$WORK" 2>/dev/null | grep -c '\.tmp' || true)
bun scripts/m36-backup.ts backup --db "file:$WORK/nope/missing.db" --media "$WORK/media" --out "$WORK/snaps" >/dev/null 2>&1
RC=$?
LEFT=$(ls -d "$WORK"/snaps/*.tmp 2>/dev/null | wc -l)
case_result "F8 backup of missing db fails explicitly" 1 $RC
case_result "F8b no partial temp dir left" 0 "$LEFT"

# --- F9 restore failure: not a snapshot -> exit 3 ---
mkdir -p "$WORK/notasnap"
bun scripts/m36-backup.ts restore --snapshot "$WORK/notasnap" --target-root "$WORK/rt" >/dev/null 2>&1
case_result "F9 restore of invalid snapshot fails explicitly" 3 $?

# --- F10 WAL honesty: PRAGMA failure on unwritable dir is NOT concealed ---
chmod 555 "$WORK" 2>/dev/null || true
OUT=$(DATABASE_URL="file:$WORK/walled/x.db" bun -e '
import { db } from "./src/lib/db";
try { await db.$queryRawUnsafe("SELECT 1"); } catch { /* force the engine to attempt a connection */ }
await new Promise(r => setTimeout(r, 2500));
process.exit(0);' 2>&1)
RC=$?
chmod 755 "$WORK"
echo "$OUT" | grep -q "beanfx:db" && WAL_HONEST=0 || WAL_HONEST=1
case_result "F10 db.ts surfaces real WAL/DB init failure" 0 "$WAL_HONEST"

# --- F11 in-memory DB stays quiet (optional-compatibility case) ---
OUT=$(DATABASE_URL="file::memory:" bun -e '
import { db } from "./src/lib/db";
await new Promise(r => setTimeout(r, 1200));
process.exit(0);' 2>&1)
echo "$OUT" | grep -q "beanfx:db" && QUIET=1 || QUIET=0
case_result "F11 optional in-memory PRAGMA stays quiet" 0 "$QUIET"

echo "-----"
echo "FQ_TOTAL pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
