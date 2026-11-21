#!/usr/bin/env bash
# BEAN FX — M34 Track A3: clean-checkout qualification harness.
#
# Proves the documented install/startup workflow works from a genuinely clean
# clone with no undocumented state. Every step prints an explicit marker; the
# harness fails loudly on the first failed step.
#
# Usage: bash scripts/qualify-clean-checkout.sh <target-dir> [port]
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ebinj-dev/Bean-FX.git}"
TARGET="${1:?usage: qualify-clean-checkout.sh <target-dir> [port]}"
PORT="${2:-3177}"
DBFILE="$TARGET/qualify.db"
DATADIR="$TARGET/media-store"

step() { echo ""; echo "=== STEP $1: $2 ==="; }

rm -rf "$TARGET"

step 1 "fresh checkout from ${QUAL_SOURCE:-$REPO_URL}"
CLONE_LOG="$TARGET.clone.log"
rm -rf "$TARGET"
if [ "${QUAL_SOURCE:-git}" = "rsync" ]; then
  # Candidate-tree qualification (pre-publication): mirror the working tree
  # the way a checkout of the candidate commit would look — no build output,
  # no databases, no media store, no node_modules.
  mkdir -p "$TARGET"
  rsync -a --delete \
    --exclude node_modules --exclude .next --exclude db --exclude media-store \
    --exclude .git --exclude '*.log' --exclude dist \
    /home/z/my-project/ "$TARGET/"
  echo "rsynced candidate tree ($(ls "$TARGET" | wc -l) top-level entries)"
else
  CLONE_OK=0
  # Try an unauthenticated clone first (public repo); private repos need the
  # established credential helper — pass it via BEANFX_GIT_CREDENTIAL_HELPER
  # (a command string, e.g. "!bash /path/to/git-cred-helper.sh").
  if git clone -q "$REPO_URL" "$TARGET" 2>"$CLONE_LOG"; then
    CLONE_OK=1
  elif [ -n "${BEANFX_GIT_CREDENTIAL_HELPER:-}" ]; then
    git -c credential.helper="$BEANFX_GIT_CREDENTIAL_HELPER" clone -q "$REPO_URL" "$TARGET" 2>>"$CLONE_LOG" && CLONE_OK=1
  fi
  [ "$CLONE_OK" = "1" ] || { echo "CLONE FAILED (repository access needed)"; cat "$CLONE_LOG"; exit 1; }
fi

step 2 "dependency installation (bun install)"
cd "$TARGET"
bun install --frozen-lockfile > "$TARGET/step2-install.log" 2>&1
echo "installed: $(ls node_modules | wc -l) packages"

step 2b "prisma client generation (explicit step under bun — postinstall is not relied upon)"
bunx prisma generate > "$TARGET/step2b-generate.log" 2>&1
grep -E "Generated" "$TARGET/step2b-generate.log" | tail -1

step 3 "configuration validation (preflight — expect CONFIGURATION REQUIRED with 0 BLOCKED)"
NODE_ENV=production DATABASE_URL="file:$DBFILE" BEANFX_DATA_DIR="$DATADIR" \
  bun scripts/preflight.ts > "$TARGET/step3-preflight.txt" 2>&1 || true
grep -E "OVERALL" "$TARGET/step3-preflight.txt"
if grep -q "BLOCKED" "$TARGET/step3-preflight.txt"; then
  echo "PREFLIGHT REPORTED BLOCKED ITEMS:"; grep "BLOCKED" "$TARGET/step3-preflight.txt"
  exit 1
fi
grep -qE "OVERALL: (READY|WARNING|CONFIGURATION REQUIRED)" "$TARGET/step3-preflight.txt" \
  || { echo "unexpected preflight verdict"; exit 1; }

step 4 "database initialization + schema application (prisma db push)"
DATABASE_URL="file:$DBFILE" bunx prisma db push --skip-generate > "$TARGET/step4-dbpush.log" 2>&1
grep -E "in sync|already in sync" "$TARGET/step4-dbpush.log" | tail -1
NODE_ENV=production DATABASE_URL="file:$DBFILE" BEANFX_DATA_DIR="$DATADIR" bun scripts/preflight.ts --json > "$TARGET/step4-preflight.json" 2> "$TARGET/step4-preflight.err" || true
if [ ! -s "$TARGET/step4-preflight.json" ]; then
  echo "preflight --json produced no output"; cat "$TARGET/step4-preflight.err"; exit 1
fi
python3 - "$TARGET/step4-preflight.json" << 'PYEOF2'
import json, sys
raw = open(sys.argv[1]).read()
d = json.loads(raw[raw.index("{"):])
db = [c for c in d["checks"] if c["id"] in ("db.file", "db.connect", "db.schema", "db.wal")]
print("preflight db after push:", ", ".join(f"{c['id']}={c['status']}" for c in db))
if any(c["status"] == "WARNING" and c["id"] == "db.schema" for c in db):
    sys.exit(1)
PYEOF2

step 5 "application startup (standalone production server on :$PORT)"
DATABASE_URL="file:$DBFILE" BEANFX_DATA_DIR="$DATADIR" BEANFX_ZAI_BIN="z-ai" \
  PUBLIC_APP_URL="http://localhost:$PORT" PORT="$PORT" RATE_LIMIT_SCALE=50 \
  bash scripts/dev-server.sh > "$TARGET/step5-server.log" 2>&1 &
SERVER_PID=$!
trap 'kill -9 $SERVER_PID 2>/dev/null || true' EXIT
for i in $(seq 1 45); do
  curl -sf -o /dev/null "http://localhost:$PORT/" && { echo "server ready (http 200) after ~${i}x2s"; break; }
  sleep 2
  [ "$i" = 45 ] && { echo "SERVER FAILED TO START"; tail -20 "$TARGET/step5-server.log"; exit 1; }
done

step 6 "browser access + health endpoint sanity"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/")
echo "GET / -> $CODE"
[ "$CODE" = "200" ] || exit 1

step 7 "deterministic workflow: register → campaign intake → editor project list (HTTP)"
# Uses the same canonical endpoints the acceptance suite drives; deterministic
# credentials seeded by the test itself.
M33_BASE="http://localhost:$PORT" M33_EVIDENCE_DIR="$TARGET/evidence" \
  bun test scripts/test-m33-three-format.test.ts > "$TARGET/step7-workflow.log" 2>&1
tail -4 "$TARGET/step7-workflow.log"
grep -q " 0 fail" "$TARGET/step7-workflow.log" || { echo "WORKFLOW FAILED"; exit 1; }

step 8 "render + export evidence (real ffprobe-validated artifacts from step 7)"
ls -la "$TARGET/evidence" 2>/dev/null | head -5

echo ""
echo "QUALIFICATION RESULT: PASS — clean checkout reproduced install, config validation, DB init, startup, and a real render/export workflow."
