#!/usr/bin/env bash
# Overlay the M3 file set from the durable working tree onto the GitHub clone.
# prisma/schema.prisma is deliberately NOT overlaid (GitHub's copy is a refined
# superset — p7 additions are applied surgically by patch_github_schema_p7.py).
# db/custom.db stays out (dev database never enters Git).
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m3}"

cd "$SRC"
FILES=(
  src/lib/job-runner.ts
  src/lib/media-storage.ts
  src/lib/client-api.ts
  src/lib/types.ts
  src/components/bean/tools/editor.tsx
  "src/app/api/media/route.ts"
  "src/app/api/media/[id]/route.ts"
  "src/app/api/media/[id]/file/route.ts"
  "src/app/api/media/upload/[uploadId]/route.ts"
  src/instrumentation.ts
  src/lib/job-helpers.ts
  src/lib/media-analysis.ts
  src/lib/media-proxy.ts
  src/lib/media-worker.ts
  migration/p7_media_pipeline.sql
  scripts/apply_missing_migrations.py
  scripts/test-media-pipeline.test.ts
  scripts/e2e-media-pipeline.ts
  scripts/e2e-editor-timeline.ts
  docs/M3_MEDIA_PIPELINE.md
)
for f in "${FILES[@]}"; do
  test -f "$SRC/$f" || { echo "MISSING IN SOURCE: $f"; exit 1; }
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
echo "overlay: ${#FILES[@]} M3 files copied OK"
