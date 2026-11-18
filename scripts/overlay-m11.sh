#!/usr/bin/env bash
# Overlay the M11 (Multimodal Intelligence) file set onto the GitHub clone.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m11}"

cd "$SRC"
FILES=(
  prisma/schema.prisma
  tsconfig.json
  src/lib/creative/contracts.ts
  src/lib/creative/context.ts
  src/lib/creative/multimodal.ts
  src/lib/creative/embedded-audio.ts
  src/lib/creative/transcription.ts
  src/lib/creative/crossmodal.ts
  src/lib/creative/crossmodal-recommendations.ts
  src/lib/creative/pause-surgery.ts
  src/lib/creative/preview.ts
  src/lib/creative/multimodal-jobs.ts
  src/lib/creative/jobs.ts
  src/lib/job-helpers.ts
  src/lib/media-worker.ts
  src/app/api/creative/analyze/unified/route.ts
  src/app/api/creative/analyze/transcripts/route.ts
  "src/app/api/creative/analyze/transcripts/[id]/route.ts"
  src/app/api/creative/plans/preview/route.ts
  src/components/bean/editor/creative-panel.tsx
  src/components/bean/tools/editor.tsx
  scripts/test-multimodal-core.test.ts
  scripts/test-multimodal-live.test.ts
  scripts/run-all-tests.sh
  docs/M11_MULTIMODAL_INTELLIGENCE.md
)

for f in "${FILES[@]}"; do
  if [ ! -f "$SRC/$f" ]; then echo "MISSING SOURCE FILE: $f"; exit 1; fi
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
echo "overlaid ${#FILES[@]} files into $DST"
