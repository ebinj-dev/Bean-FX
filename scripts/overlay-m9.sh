#!/usr/bin/env bash
# Overlay the M9 (Professional Publishing) file set onto the GitHub clone.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m9}"

cd "$SRC"
FILES=(
  prisma/schema.prisma
  src/lib/publish/profiles.ts
  src/lib/publish/variants.ts
  src/lib/publish/metadata.ts
  src/lib/publish/thumbnails.ts
  src/lib/publish/presets.ts
  src/lib/publish/jobs.ts
  src/lib/publish/zip.ts
  src/lib/job-helpers.ts
  src/lib/media-worker.ts
  src/lib/my-ai/gateway/structured.ts
  src/app/api/publish/profiles/route.ts
  src/app/api/publish/status/route.ts
  src/app/api/publish/presets/route.ts
  src/app/api/publish/presets/[id]/route.ts
  src/app/api/publish/presets/[id]/apply/route.ts
  src/app/api/publish/thumbnails/route.ts
  src/app/api/publish/thumbnails/[id]/route.ts
  src/app/api/publish/thumbnails/[id]/generate/route.ts
  src/app/api/publish/thumbnails/[id]/composite/route.ts
  src/app/api/publish/metadata/route.ts
  src/app/api/publish/metadata/[id]/route.ts
  src/app/api/publish/metadata/[id]/field/route.ts
  src/app/api/publish/variants/route.ts
  src/app/api/publish/variants/[id]/route.ts
  src/app/api/publish/variants/[id]/retry/route.ts
  src/app/api/publish/packages/route.ts
  src/app/api/publish/packages/[id]/route.ts
  src/app/api/publish/packages/[id]/download/route.ts
  src/components/bean/editor/publishing-panel.tsx
  src/components/bean/tools/editor.tsx
  scripts/test-publish-core.test.ts
  scripts/test-publish-live.test.ts
  scripts/m9-e2e-verify.sh
  scripts/run-all-tests.sh
  docs/M9_PROFESSIONAL_PUBLISHING.md
)

for f in "${FILES[@]}"; do
  if [ ! -f "$SRC/$f" ]; then echo "MISSING SOURCE FILE: $f"; exit 1; fi
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
echo "overlaid ${#FILES[@]} files into $DST"
