#!/usr/bin/env bash
# BEAN FX — supported combined test execution mode.
#
# Root cause of the five M3.4/M3.5 failures seen in earlier combined runs:
# bun executes ALL test files in ONE process, so a suite's
# `process.env.DATABASE_URL = file:<scratch>` only works if no other suite
# imported src/lib/db first (the PrismaClient singleton binds to whatever
# environment was active at first import). Running every suite in its own
# process makes each suite's isolation effective — reliable sequential AND
# parallel results.
#
# Usage: bash scripts/run-all-tests.sh [--only <substring>]
set -uo pipefail
cd "$(dirname "$0")/.."

SUITES=(
  scripts/test-gangzii-analysis.test.ts
  scripts/test-gangzii-dsp.test.ts
  scripts/test-gangzii-jobs.test.ts
  scripts/test-nikki-core.test.ts
  scripts/test-nikki-render.test.ts
  scripts/test-jazmii.test.ts
  scripts/test-laxii.test.ts
  scripts/test-ai-registry.test.ts
  scripts/test-myai-gateway.test.ts
  scripts/test-myai-planner.test.ts
  scripts/test-automation-mcp.test.ts
  scripts/test-automation-api.test.ts
  scripts/test-studio-core.test.ts
  scripts/test-publish-core.test.ts
  scripts/test-creative-core.test.ts
  scripts/test-creative-live.test.ts
  scripts/test-multimodal-core.test.ts
  scripts/test-multimodal-live.test.ts
  scripts/test-visual-core.test.ts
  scripts/test-visual-live.test.ts
  scripts/test-temporal-core.test.ts
  scripts/test-temporal-live.test.ts
  scripts/test-m14-core.test.ts
  scripts/test-m14-live.test.ts
  scripts/test-riishe-timeline.test.ts
  scripts/test-editor-regressions.test.ts
  scripts/test-media-pipeline.test.ts
  scripts/p3_union.test.ts
  scripts/test-words-srt.test.ts
  scripts/v5-inference-reliability.test.ts
)

ONLY="${2:-}"
FAILED=()
PASSED=()
for SUITE in "${SUITES[@]}"; do
  if [ -n "$ONLY" ] && [[ "$SUITE" != *"$ONLY"* ]]; then continue; fi
  echo "──────────────────────────────────────────────────────────────"
  echo "SUITE: $SUITE (own process)"
  if bun test "$SUITE" > /tmp/m5-suite-out.txt 2>&1; then
    SUMMARY=$(grep -E "^\s+[0-9]+ (pass|fail)|Ran [0-9]+ tests" /tmp/m5-suite-out.txt | tr '\n' ' ')
    echo "  PASS — $SUMMARY"
    PASSED+=("$SUITE")
  else
    SUMMARY=$(grep -E "^\s+[0-9]+ (pass|fail)|Ran [0-9]+ tests" /tmp/m5-suite-out.txt | tr '\n' ' ')
    echo "  FAIL — $SUMMARY"
    FAILED+=("$SUITE")
    tail -30 /tmp/m5-suite-out.txt | sed 's/^/    /'
  fi
done

echo "══════════════════════════════════════════════════════════════"
echo "RESULT: ${#PASSED[@]} suite(s) passed, ${#FAILED[@]} failed"
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf 'FAILED: %s\n' "${FAILED[@]}"
  exit 1
fi
exit 0
