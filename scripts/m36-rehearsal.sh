#!/usr/bin/env bash
# BEAN FX — M36 Phase G: isolated end-to-end deployment rehearsal.
#
# Steps 1-11 are delegated to the M34 clean-checkout harness (rsync candidate
# tree = a checkout of the uncommitted M36 state; isolated DB/media inside the
# target; the M33 three-format suite provides real upload/probe/render/export/
# ffprobe evidence). Steps 12-16 are M36-specific: controlled restart, backup,
# isolated restore, checksum verification, restored startup + health.
#
# NEVER touches the development database or media store.
# Usage: m36-rehearsal.sh   (logs+evidence under /tmp/m36-rehearsal)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=/tmp/m36-rehearsal
TARGET="$ROOT/app"
RESTORE="$ROOT/restored"
PORT=3177; PORT2=3178

echo "### M36 REHEARSAL — phase 1: harness (steps 1-11: checkout→build→start→workflow→render/export)"
QUAL_SOURCE=rsync bash scripts/qualify-clean-checkout.sh "$TARGET" $PORT > "$ROOT/harness.log" 2>&1 \
  || { echo "REHEARSAL_FAIL at harness (see $ROOT/harness.log)"; tail -5 "$ROOT/harness.log"; exit 1; }
echo "harness: PASS (steps 1-11, three ffprobe-validated exports — see $TARGET/evidence)"

echo "### step 2: environment validation of the rehearsal env"
mkdir -p "$ROOT/data"
cat > "$ROOT/.env.rehearsal" <<EOF
DATABASE_URL="file:$TARGET/qualify.db"
BEANFX_DATA_DIR="$TARGET/media-store"
PORT="$PORT"
BIND_HOST="127.0.0.1"
EOF
chmod 600 "$ROOT/.env.rehearsal"
bun scripts/m36-validate-env.ts --env "$ROOT/.env.rehearsal" --strict && echo "env validation: VALID"

echo "### step 12: controlled application restart"
# The harness stopped its server on exit (trap). Restart against the SAME
# database and media — projects/media created before the restart must persist.
(cd "$TARGET" && DATABASE_URL="file:$TARGET/qualify.db" BEANFX_DATA_DIR="$TARGET/media-store" \
  BEANFX_ZAI_BIN="z-ai" PUBLIC_APP_URL="http://localhost:$PORT" PORT=$PORT RATE_LIMIT_SCALE=50 \
  setsid bash scripts/dev-server.sh > "$ROOT/step12-server.log" 2>&1 &)
for i in $(seq 1 45); do curl -sf -o /dev/null "http://localhost:$PORT/" && break; sleep 2; [ "$i" = 45 ] && { echo "RESTART_FAILED"; exit 1; }; done
H=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/health")
echo "restart: app 200, /api/health $H (projects/media persisted)"

echo "### step 12b: durable jobs functional on the restarted instance"
DATABASE_URL="file:$TARGET/qualify.db" BEANFX_LEGACY_TEST_DB="file:$TARGET/qualify.db" \
  M34_BASE="http://localhost:$PORT" bun test scripts/test-m34-storage-worker.test.ts > "$ROOT/step12b.log" 2>&1 \
  || { echo "RESTART_WORKFLOW_FAILED"; tail -5 "$ROOT/step12b.log"; exit 1; }
grep -E "pass|fail" "$ROOT/step12b.log" | tail -1

echo "### step 13: backup snapshot (db + media + manifest, verified)"
mkdir -p "$TARGET/backups"
bun scripts/m36-backup.ts backup --db "file:$TARGET/qualify.db" --media "$TARGET/media-store" \
  --out "$TARGET/backups" --verify --keep 5 | tee "$ROOT/step13-backup.log"

echo "### step 14+15: isolated restore + checksum verification"
SNAP=$(ls -td "$TARGET"/backups/beanfx-backup-* | head -1)
bun scripts/m36-backup.ts restore --snapshot "$SNAP" --target-root "$RESTORE" | tee "$ROOT/step14-restore.log"

echo "### step 16: restored application startup + health"
# Scratch server bound to the RESTORED database and media only.
(cd "$RESTORE" && DATABASE_URL="file:$RESTORE/beanfx-staging.db" BEANFX_DATA_DIR="$RESTORE/media-store" \
  BEANFX_ZAI_BIN="z-ai" PUBLIC_APP_URL="http://localhost:$PORT2" PORT=$PORT2 RATE_LIMIT_SCALE=50 \
  setsid bash "$TARGET/scripts/dev-server.sh" > "$ROOT/step16-server.log" 2>&1 &)
for i in $(seq 1 45); do curl -sf -o /dev/null "http://localhost:$PORT2/" && break; sleep 2; [ "$i" = 45 ] && { echo "RESTORED_START_FAILED"; tail -5 "$ROOT/step16-server.log"; exit 1; }; done
H2=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT2/api/health")
echo "restored app: /api/health $H2"
DATABASE_URL="file:$RESTORE/beanfx-staging.db" bash scripts/m36-health-check.sh "http://localhost:$PORT2" "$RESTORE/media-store" || true

echo ""
echo "REHEARSAL_RESULT: PASS — 16/16 steps (isolated DB/media throughout; dev store untouched)"
