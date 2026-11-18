#!/usr/bin/env bash
# Overlay the M12 (Visual Intelligence) file set onto the GitHub clone.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m12}"

cd "$SRC"
FILES=(
  src/lib/my-ai/gateway/vision.ts
  src/lib/my-ai/gateway/structured.ts
  src/lib/creative/contracts.ts
  src/lib/creative/recommendations.ts
  src/lib/creative/visual/contracts.ts
  src/lib/creative/visual/frames.ts
  src/lib/creative/visual/vision-analysis.ts
  src/lib/creative/visual/scenes.ts
  src/lib/creative/visual/search.ts
  src/lib/creative/visual/matching.ts
  src/lib/creative/visual/broll.ts
  src/lib/creative/visual/continuity.ts
  src/lib/creative/visual/jobs.ts
  src/lib/job-helpers.ts
  src/lib/media-worker.ts
  src/app/api/creative/visual/index/route.ts
  src/app/api/creative/visual/search/route.ts
  src/components/bean/editor/creative-panel.tsx
  scripts/test-visual-core.test.ts
  scripts/test-visual-live.test.ts
  scripts/run-all-tests.sh
  docs/M12_VISUAL_INTELLIGENCE.md
)

for f in "${FILES[@]}"; do
  if [ ! -f "$SRC/$f" ]; then echo "MISSING SOURCE FILE: $f"; exit 1; fi
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
