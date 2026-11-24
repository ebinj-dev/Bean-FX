#!/usr/bin/env bash
# BEAN FX — M41-A: verify the stage-2 env-contract fixes on the affected suites.
# Same server recipe as release-qualify stage 2; same suite env contract.
set -uo pipefail
cd "$(dirname "$0")/.."

EVDIR=/home/z/my-project/m41-evidence/verify-fixes
rm -rf "$EVDIR"; mkdir -p "$EVDIR"
RES="$EVDIR/results.jsonl"; : > "$RES"

SUITES="$*"
[ -z "$SUITES" ] && SUITES="test-m21-bridge test-m22-bridge-deep test-m22-e2e test-m22-mcp-client test-m22-security test-m23-mcp-raw-client test-m23-security-release test-m25-billing test-m28-api test-m28-pipeline test-m30-collab test-m31-security test-m31-media-qual test-m31-studio-live test-m33-acceptance test-m33-three-format test-showcase-live"

STAGE2_DB="$(mktemp /tmp/beanfx-m41verify-XXXXXX.db)"
STAGE2_MEDIA="$(mktemp -d /tmp/beanfx-m41verify-media-XXXXXX)"
STAGE2_PID=""
cleanup() {
  if [ -n "$STAGE2_PID" ] && kill -0 "$STAGE2_PID" 2>/dev/null; then
    kill "$STAGE2_PID" 2>/dev/null || true; sleep 2; kill -9 "$STAGE2_PID" 2>/dev/null || true
  fi
  rm -f "$STAGE2_DB" "$STAGE2_DB"-shm "$STAGE2_DB"-wal; rm -rf "$STAGE2_MEDIA"
  rm -rf /tmp/beanfx-m41verify-*.db* /tmp/beanfx-m41verify-media-*
}
trap cleanup EXIT
DATABASE_URL="file:$STAGE2_DB" node_modules/.bin/prisma db push --skip-generate >/dev/null
mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static; cp -r .next/static .next/standalone/.next/static
rm -rf .next/standalone/public; cp -r public .next/standalone/public 2>/dev/null || true
DATABASE_URL="file:$STAGE2_DB" BEANFX_DATA_DIR="$STAGE2_MEDIA" PORT=3117 RATE_LIMIT_SCALE="50" \
  HOSTNAME="127.0.0.1" node .next/standalone/server.js > "$EVDIR/server.log" 2>&1 &
STAGE2_PID=$!
for i in $(seq 1 90); do
  curl -fsS http://127.0.0.1:3117/api/health >/dev/null 2>&1 && break
  kill -0 "$STAGE2_PID" 2>/dev/null || { echo "server died"; exit 3; }
  sleep 1
done
echo "[verify] server healthy on :3117"

PASS=0; FAIL=0
for BN in $SUITES; do
  F="scripts/$BN.test.ts"
  [ -f "$F" ] || { echo "MISSING: $F"; continue; }
  printf '[verify] %-40s ' "$BN"
  if env DATABASE_URL="file:$STAGE2_DB" BEANFX_LEGACY_TEST_DB="file:$STAGE2_DB" \
       M31_DB="file:$STAGE2_DB" M31_BASE="http://127.0.0.1:3117" M33_BASE="http://127.0.0.1:3117" \
       BEANFX_DATA_DIR="$STAGE2_MEDIA" \
       timeout 900 bun test "$F" > "$EVDIR/$BN.log" 2>&1; then
    echo "PASS"; PASS=$((PASS+1)); OUT=PASS
  else
    echo "FAIL"; FAIL=$((FAIL+1)); OUT=FAIL
    grep -E "\(fail\)|error:" "$EVDIR/$BN.log" | head -3 | sed 's/^/    /'
  fi
  printf '{"suite":"%s","outcome":"%s"}\n' "$BN" "$OUT" >> "$RES"
done
echo "═══ verify-fixes: $PASS pass, $FAIL fail"
