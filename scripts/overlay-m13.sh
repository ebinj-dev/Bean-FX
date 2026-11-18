#!/usr/bin/env bash
# Overlay the M13 (Temporal Visual Intelligence) file set onto the GitHub clone.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m13}"

cd "$SRC"
FILES=(
  src/lib/creative/visual/temporal/contracts.ts
  src/lib/creative/visual/temporal/sampling.ts
  src/lib/creative/visual/temporal/tracking.ts
  src/lib/creative/visual/temporal/motion.ts
  src/lib/creative/visual/temporal/events.ts
  src/lib/creative/visual/temporal/search.ts
  src/lib/creative/visual/temporal/mograph.ts
  src/lib/creative/visual/temporal/jobs.ts
  src/lib/creative/visual/frames.ts
  src/lib/job-helpers.ts
  src/lib/media-worker.ts
  src/app/api/creative/temporal/index/route.ts
  src/app/api/creative/temporal/search/route.ts
  src/app/api/creative/temporal/mograph/route.ts
  src/components/bean/editor/creative-panel.tsx
  scripts/test-temporal-core.test.ts
  scripts/test-temporal-live.test.ts
  scripts/run-all-tests.sh
  scripts/dev-server.sh
  scripts/e2e-seed-visual.ts
  scripts/e2e-tick-visual.ts
  scripts/e2e-temporal.sh
  docs/M13_TEMPORAL_VISUAL_INTELLIGENCE.md
)

for f in "${FILES[@]}"; do
  if [ ! -f "$SRC/$f" ]; then echo "MISSING SOURCE FILE: $f"; exit 1; fi
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
chmod +x "$DST/scripts/dev-server.sh" "$DST/scripts/e2e-temporal.sh"
