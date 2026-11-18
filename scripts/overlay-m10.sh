#!/usr/bin/env bash
# Overlay the M10 (AI Creative Director) file set onto the GitHub clone.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m10}"

cd "$SRC"
FILES=(
  prisma/schema.prisma
  src/lib/creative/contracts.ts
  src/lib/creative/context.ts
  src/lib/creative/retention.ts
  src/lib/creative/brief.ts
  src/lib/creative/scorecard.ts
  src/lib/creative/recommendations.ts
  src/lib/creative/variants.ts
  src/lib/creative/assistant.ts
  src/lib/creative/jobs.ts
  src/lib/job-helpers.ts
  src/lib/media-worker.ts
  src/app/api/creative/reviews/route.ts
  src/app/api/creative/reviews/[id]/route.ts
  src/app/api/creative/recommendations/[id]/route.ts
  src/app/api/creative/variants/route.ts
  src/app/api/creative/variants/[id]/route.ts
  src/app/api/creative/assistant/route.ts
  src/components/bean/editor/creative-panel.tsx
  src/components/bean/tools/editor.tsx
  scripts/test-creative-core.test.ts
  scripts/test-creative-live.test.ts
  scripts/run-all-tests.sh
  docs/M10_AI_CREATIVE_DIRECTOR.md
)

for f in "${FILES[@]}"; do
  if [ ! -f "$SRC/$f" ]; then echo "MISSING SOURCE FILE: $f"; exit 1; fi
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
echo "overlaid ${#FILES[@]} files into $DST"
