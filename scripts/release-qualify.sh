#!/usr/bin/env bash
# BEAN FX — M40 §5: RELEASE QUALIFICATION.
#
# The explicit, one-command release qualifier. A release is NOT qualified
# unless this script exits 0. Sequence (each stage's exit code is recorded
# in machine-readable evidence; any required failure stops the run):
#
#   BUILD → UNIT/INTEGRATION → M20 LIVE GATE → SECURITY → RELEASE QUALIFICATION
#
# Stages:
#   1. BUILD          — tsc --noEmit + the production bundle (next build).
#   2. UNIT/INTEGRATION — every suite except the three live-render suites,
#                       run sequentially against one isolated :3117 server.
#   3. M20 LIVE GATE  — scripts/m20-regression-gate.sh: the COMPLETE M20
#                       durable-render live suite (60s/300s/600s renders,
#                       SIGKILL recovery, OOM, cancellation, duplicate
#                       submission) against a REAL standalone server with
#                       real FFmpeg on isolated scratch DB + scratch media.
#                       Mocked renders do not satisfy this stage — there are
#                       none to fake it with.
#   4. SECURITY       — secret-pattern scan of tracked files + staged diff.
#   5. QUALIFICATION  — writes evidence/release-qualification.json with the
#                       per-stage exit codes and the final verdict.
#
# Evidence lands in /home/z/my-project/download/m20-render-logs/ (gate) and
# /home/z/my-project/m40-evidence/ (qualification verdict).
#
# Usage:
#   scripts/release-qualify.sh                  # full qualification
#   SKIP_BUILD=1 scripts/release-qualify.sh     # reuse an existing .next build
#   SKIP_M20_GATE=1                             # NOT allowed for qualification:
#                                               # the gate is mandatory; the flag
#                                               # exists only for dry structural runs
#                                               # and FORCES a FAILED verdict.
set -uo pipefail
cd "$(dirname "$0")/.."

EVID=/home/z/my-project/m40-evidence
mkdir -p "$EVID"
declare -A RESULTS=( [build]="NOT RUN" [tests]="NOT RUN" [m20gate]="NOT RUN" [security]="NOT RUN" )

fail() {
  cat > "$EVID/release-qualification.json" <<EOF
{
  "ranAt": "$(date -u +%FT%TZ)",
  "sequence": ["build", "unit-integration", "m20-live-gate", "security", "qualification"],
  "results": { "build": "${RESULTS[build]}", "unit-integration": "${RESULTS[tests]}", "m20-live-gate": "${RESULTS[m20gate]}", "security": "${RESULTS[security]}" },
  "verdict": "FAILED",
  "reason": "$1"
}
EOF
  echo "[release] VERDICT: FAILED — $1" >&2
  exit 1
}

echo "═══ 1/5 BUILD ═══"
if [ "${SKIP_BUILD:-0}" = "1" ] && [ -f .next/BUILD_ID ]; then
  echo "[release] reusing existing .next build (SKIP_BUILD=1)"
  RESULTS[build]="PASS (reused build)"
else
  if ! node_modules/.bin/tsc --noEmit; then RESULTS[build]="FAIL"; fail "tsc --noEmit failed"; fi
  if ! bun run build; then RESULTS[build]="FAIL"; fail "production build failed"; fi
  RESULTS[build]="PASS"
fi

echo "═══ 2/5 UNIT/INTEGRATION ═══"
# M40 §5 — integration stage: ONE isolated server on the conventional :3117
# (scratch DB + scratch media, same isolation rules as the M20 gate) against
# which every suite except the three live-render suites runs SEQUENTIALLY,
# one `bun test <file>` per file. Sequential per-file execution is required:
# these suites set DATABASE_URL/BEANFX_DATA_DIR at import time and bun's
# parallel file batching collapses that isolation (observed: 136 spurious
# failures in one parallel batch vs green runs per file). The M20 durable
# suite, the M38 live batch suite and the M39 live range suite are excluded
# here — their scenarios are the MANDATORY stage-3 gate's exact job.
LIVE_SUITES="test-m20-durable-render.test.ts|test-m38-live.test.ts|test-m39-batch-ranges.test.ts"
SUITES=$(ls scripts/*.test.ts 2>/dev/null | grep -Ev "$LIVE_SUITES" || true)
[ -z "$SUITES" ] && fail "no suites found for stage 2"

STAGE2_DB="$(mktemp /tmp/beanfx-stage2-XXXXXX.db)"
STAGE2_MEDIA="$(mktemp -d /tmp/beanfx-stage2-media-XXXXXX)"
STAGE2_PID=""
stage2_cleanup() {
  if [ -n "$STAGE2_PID" ] && kill -0 "$STAGE2_PID" 2>/dev/null; then
    kill "$STAGE2_PID" 2>/dev/null || true; sleep 2; kill -9 "$STAGE2_PID" 2>/dev/null || true
  fi
  rm -rf /tmp/beanfx-stage2-*.db /tmp/beanfx-stage2-*.db-shm /tmp/beanfx-stage2-*.db-wal /tmp/beanfx-stage2-media-*
}
trap stage2_cleanup EXIT
case "$STAGE2_DB" in *"/db/"*) fail "stage-2 refusing dev DB"; ;; esac
DATABASE_URL="file:$STAGE2_DB" node_modules/.bin/prisma db push --skip-generate >/dev/null
mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static; cp -r .next/static .next/standalone/.next/static
rm -rf .next/standalone/public; cp -r public .next/standalone/public 2>/dev/null || true
DATABASE_URL="file:$STAGE2_DB" BEANFX_DATA_DIR="$STAGE2_MEDIA" PORT=3117 RATE_LIMIT_SCALE="50" \
  HOSTNAME="127.0.0.1" node .next/standalone/server.js > /tmp/m40-stage2-server.log 2>&1 &
STAGE2_PID=$!
for i in $(seq 1 90); do
  curl -fsS http://127.0.0.1:3117/api/health >/dev/null 2>&1 && break
  kill -0 "$STAGE2_PID" 2>/dev/null || fail "stage-2 server died during startup — see /tmp/m40-stage2-server.log"
  sleep 1
done
curl -fsS http://127.0.0.1:3117/api/health >/dev/null 2>&1 || fail "stage-2 server never became healthy"

FAILED_SUITES=""
# M41-A: suite-loop environment contract for the stage-2 server. The server
# owns ONE scratch DB (:3117). Hybrid suites (direct PrismaClient + HTTP :3117)
# must see the SAME file or their direct reads/writes target a different DB
# than the server (observed: 21 of 96 suites failing on exactly this split:
# record-not-found on rows the server created, and :3118/:hardcoded-path
# defaults from the pre-M39 workspace layout). Suites that set their own
# scratch DATABASE_URL override these; pure-HTTP suites are unaffected.
#   DATABASE_URL           — default-PrismaClient suites (m28-pipeline sweep…)
#   BEANFX_LEGACY_TEST_DB  — scratchLegacyDb hybrid suites (documented contract
#                            in scripts/legacy-fixture.ts: "direct DB + HTTP
#                            :3117 against the same file")
#   M31_DB / M31_BASE / M33_BASE — suite overrides replacing the hardcoded
#                            pre-M39 /home/z/my-project workspace paths and the
#                            never-provided :3118 second server
for f in $SUITES; do
  if ! env DATABASE_URL="file:$STAGE2_DB" BEANFX_LEGACY_TEST_DB="file:$STAGE2_DB" \
       M31_DB="file:$STAGE2_DB" M31_BASE="http://127.0.0.1:3117" M33_BASE="http://127.0.0.1:3117" \
       bun test "$f" > "/tmp/m40-stage2-$(basename "$f").log" 2>&1; then
    FAILED_SUITES="$FAILED_SUITES $(basename "$f")"
    echo "[release] suite FAILED: $(basename "$f") (log: /tmp/m40-stage2-$(basename "$f").log)"
  fi
done
# M42-A (M41 Phase F): truthful failure classification. A failed suite is
# either a PRODUCT/TEST failure (release NOT QUALIFIED) or an evidence-
# classified infrastructure blocker registered in scripts/release-blockers.json
# (verdict BLOCKED BY OWNER / INFRASTRUCTURE; never counted as a pass).
PASSED_COUNT=$(( $(echo "$SUITES" | wc -l) - $(wc -w <<< "$FAILED_SUITES") ))
BLOCKED_SUITES=""; PRODUCT_FAILS=""; BLOCKED_TOTAL=0; BLOCKED_APPROVED=0
for s in $FAILED_SUITES; do
  CLS=$(python3 - "$s" <<'PYB'
import json, sys
reg = json.load(open("scripts/release-blockers.json"))
entry = next((b for b in reg.get("blocked", []) if b.get("suite") == sys.argv[1]), None)
print(("BLOCKED" if entry else "PRODUCT"), str(bool((entry or {}).get("ownerApproved", False))))
PYB
)
  if [ "${CLS%% *}" = "BLOCKED" ]; then
    BLOCKED_SUITES="$BLOCKED_SUITES $s"; BLOCKED_TOTAL=$((BLOCKED_TOTAL+1))
    [ "${CLS#* }" = "True" ] && BLOCKED_APPROVED=$((BLOCKED_APPROVED+1))
  else
    PRODUCT_FAILS="$PRODUCT_FAILS $s"
  fi
done
if [ -n "$PRODUCT_FAILS" ]; then RESULTS[tests]="FAIL"; fail "product/test suites failed against the stage-2 integration server:$PRODUCT_FAILS"; fi
if [ -n "$BLOCKED_SUITES" ]; then
  RESULTS[tests]="BLOCKED ($PASSED_COUNT passed, blocked:$BLOCKED_SUITES — see scripts/release-blockers.json)"
else
  RESULTS[tests]="PASS ($PASSED_COUNT suites)"
fi

echo "═══ 3/5 M20 LIVE GATE ═══"
if [ "${SKIP_M20_GATE:-0}" = "1" ]; then
  RESULTS[m20gate]="FAIL (skipped — gate is mandatory)"
  fail "M20 live gate skipped — a release cannot be qualified without it"
fi
if ! SKIP_BUILD=1 scripts/m20-regression-gate.sh; then RESULTS[m20gate]="FAIL"; fail "M20 live gate failed — see download/m20-render-logs/gate-summary.json"; fi
RESULTS[m20gate]="PASS"

echo "═══ 4/5 SECURITY ═══"
SEC_HITS=$(git ls-files -z | xargs -0 grep -nEIi "(sk-[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN PRIVATE KEY-----|AIza[A-Za-z0-9_-]{20,})" 2>/dev/null | grep -v "example\|placeholder\|\.md:" | head -5 || true)
if [ -n "$SEC_HITS" ]; then
  echo "$SEC_HITS" >&2
  RESULTS[security]="FAIL"; fail "secret-pattern scan found matches in tracked files"
fi
RESULTS[security]="PASS"

echo "═══ 5/5 RELEASE QUALIFICATION ═══"
# M42-A: explicit release states. QUALIFIED requires EVERY stage green AND
# zero failed suites AND zero blocked suites. Infrastructure blockers force a
# fail-closed exit 1 with verdict BLOCKED BY OWNER / INFRASTRUCTURE (or
# QUALIFIED WITH DOCUMENTED LIMITATIONS when every blocker carries explicit
# ownerApproved=true — the verdict string stays non-green and the exit stays 1:
# a partially executed suite set is never presented as a complete passing run).
FAILED_TOTAL=$(( $(wc -w <<< "$FAILED_SUITES") ))
if [ "$FAILED_TOTAL" -eq 0 ] && [ -z "$BLOCKED_SUITES" ]; then
  VERDICT="QUALIFIED"; EXIT_CODE=0
elif [ "$FAILED_TOTAL" -eq 0 ] && [ "$BLOCKED_TOTAL" -eq "$BLOCKED_APPROVED" ]; then
  VERDICT="QUALIFIED WITH DOCUMENTED LIMITATIONS"; EXIT_CODE=1
elif [ "$FAILED_TOTAL" -eq 0 ]; then
  VERDICT="BLOCKED BY OWNER / INFRASTRUCTURE"; EXIT_CODE=1
else
  VERDICT="NOT QUALIFIED"; EXIT_CODE=1
fi
cat > "$EVID/release-qualification.json" <<EOF
{
  "ranAt": "$(date -u +%FT%TZ)",
  "sequence": ["build", "unit-integration", "m20-live-gate", "security", "qualification"],
  "results": { "build": "${RESULTS[build]}", "unit-integration": "${RESULTS[tests]}", "m20-live-gate": "${RESULTS[m20gate]}", "security": "${RESULTS[security]}" },
  "suites": { "passed": $PASSED_COUNT, "failedProduct": $(wc -w <<< "$PRODUCT_FAILS"), "failedProductList": $(python3 scripts/_json_wordlist.py "$PRODUCT_FAILS"), "blocked": $(python3 scripts/_json_wordlist.py "$BLOCKED_SUITES"), "blockedApproved": $BLOCKED_APPROVED, "blockedTotal": $BLOCKED_TOTAL, "blockedRegistry": "scripts/release-blockers.json" },
  "verdict": "$VERDICT",
  "failClosed": true,
  "exitCode": $EXIT_CODE,
  "m20GateEvidence": "/home/z/my-project/download/m20-render-logs/gate-summary.json"
}
EOF
echo "[release] VERDICT: $VERDICT — evidence: $EVID/release-qualification.json"
exit $EXIT_CODE
