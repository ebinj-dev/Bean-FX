#!/usr/bin/env bash
# Overlay the M8.1 (Social Video Studio) file set onto the GitHub clone.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m81}"

cd "$SRC"
FILES=(
  prisma/schema.prisma
  src/lib/studio/brief.ts
  src/lib/studio/plan.ts
  src/lib/studio/planner.ts
  src/lib/studio/narration.ts
  src/lib/studio/assets.ts
  src/lib/studio/assemble.ts
  src/lib/studio/batch.ts
  src/lib/studio/jobs.ts
  src/app/api/studio/plans/route.ts
  src/app/api/studio/plans/[planId]/route.ts
  src/app/api/studio/plans/[planId]/scenes/[sceneId]/route.ts
  src/app/api/studio/plans/[planId]/assemble/route.ts
  src/app/api/studio/batch/route.ts
  src/components/bean/editor/studio-panel.tsx
  src/components/bean/tools/editor.tsx
  src/lib/nikki/render.ts
  src/lib/media-worker.ts
  src/lib/job-helpers.ts
  scripts/test-studio-core.test.ts
  scripts/test-studio-live.test.ts
  scripts/run-all-tests.sh
  docs/M8_1_SOCIAL_VIDEO_STUDIO.md
)
for f in "${FILES[@]}"; do
  test -f "$SRC/$f" || { echo "MISSING IN SOURCE: $f"; exit 1; }
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
echo "overlay: ${#FILES[@]} M8.1 files copied OK"
