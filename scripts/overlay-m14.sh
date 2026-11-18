#!/usr/bin/env bash
# Overlay the M14 (AI Art Direction & Motion Composition) file set onto the GitHub clone.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m14}"

cd "$SRC"
FILES=(
  src/lib/creative/m14/contracts.ts
  src/lib/creative/m14/direction.ts
  src/lib/creative/m14/scenes.ts
  src/lib/creative/m14/assets.ts
  src/lib/creative/m14/presets.ts
  src/lib/creative/m14/compose.ts
  src/lib/creative/m14/render.ts
  src/lib/creative/visual/temporal/tracking.ts
  src/app/api/creative/m14/direction/route.ts
  src/app/api/creative/m14/scenes/route.ts
  src/app/api/creative/m14/assets/route.ts
  src/app/api/creative/m14/compose/route.ts
  src/app/api/creative/m14/render/route.ts
  src/lib/my-ai/planner/schema.ts
  src/lib/my-ai/execution/executor.ts
  src/lib/job-helpers.ts
  src/lib/media-worker.ts
  src/components/bean/editor/creative-panel.tsx
  prisma/schema.prisma
  scripts/test-m14-core.test.ts
  scripts/test-m14-live.test.ts
  scripts/e2e-m14.sh
  scripts/run-all-tests.sh
  docs/M14_REFERENCE_AUDIT.md
  docs/M14_AI_ART_DIRECTION_MOTION_COMPOSITION.md
)

for f in "${FILES[@]}"; do
  if [ ! -f "$SRC/$f" ]; then echo "MISSING SOURCE FILE: $f"; exit 1; fi
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
chmod +x "$DST/scripts/e2e-m14.sh"
