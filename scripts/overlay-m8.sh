#!/usr/bin/env bash
# Overlay the M8 (MY AI Orchestration) file set onto the GitHub clone.
# Excluded: db/ + backups (dev databases), authdata/ (secrets), .env, /tmp debug scripts.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m8}"

cd "$SRC"
FILES=(
  prisma/schema.prisma
  src/lib/my-ai/gateway/provider.ts
  src/lib/my-ai/gateway/structured.ts
  src/lib/my-ai/gateway/usage.ts
  src/lib/my-ai/context/resolver.ts
  src/lib/my-ai/planner/schema.ts
  src/lib/my-ai/planner/planner.ts
  src/lib/my-ai/approvals.ts
  src/lib/my-ai/ids.ts
  src/lib/my-ai/execution/executor.ts
  src/lib/my-ai/discovery/effects.ts
  src/lib/my-ai/preview/frames.ts
  src/lib/automation/tokens.ts
  src/lib/automation/catalog.ts
  src/lib/automation/mcp/server.ts
  src/app/api/my-ai/chat/route.ts
  src/app/api/my-ai/plans/route.ts
  src/app/api/my-ai/plans/[planId]/route.ts
  src/app/api/my-ai/conversations/route.ts
  src/app/api/my-ai/health/route.ts
  src/app/api/automation/mcp/route.ts
  src/app/api/automation/rpc/route.ts
  src/app/api/automation/tokens/route.ts
  src/components/bean/editor/my-ai-panel.tsx
  src/components/bean/tools/editor.tsx
  scripts/test-myai-gateway.test.ts
  scripts/test-myai-planner.test.ts
  scripts/test-automation-mcp.test.ts
  scripts/test-automation-api.test.ts
  scripts/run-all-tests.sh
  package.json
  package-lock.json
  docs/M8_MY_AI_ORCHESTRATION.md
)
for f in "${FILES[@]}"; do
  test -f "$SRC/$f" || { echo "MISSING IN SOURCE: $f"; exit 1; }
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
echo "overlay: ${#FILES[@]} M8 files copied OK"
