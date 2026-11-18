#!/usr/bin/env bash
# Overlay the M7 (JAZMII + LAXII) file set onto the GitHub clone.
# Excluded: db/ + backups (dev databases), authdata/ (secrets), .env, /tmp debug scripts.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m7}"

cd "$SRC"
FILES=(
  prisma/schema.prisma
  src/lib/jazmii/types.ts
  src/lib/jazmii/providers.ts
  src/lib/jazmii/analysis.ts
  src/lib/jazmii/shots.ts
  src/lib/jazmii/jobs.ts
  src/lib/laxii/types.ts
  src/lib/laxii/providers.ts
  src/lib/laxii/processing.ts
  src/lib/laxii/jobs.ts
  src/lib/ai/asset-lifecycle.ts
  src/lib/ai/registry.ts
  src/app/api/jazmii/generate/route.ts
  src/app/api/jazmii/analyze/route.ts
  src/app/api/jazmii/proposal/route.ts
  src/app/api/laxii/generate/route.ts
  src/app/api/ai/route/route.ts
  src/app/api/ai/outputs/route.ts
  src/app/api/media/list/route.ts
  src/lib/job-helpers.ts
  src/lib/media-worker.ts
  src/components/bean/editor/jazmii-panel.tsx
  src/components/bean/editor/laxii-panel.tsx
  src/components/bean/tools/editor.tsx
  scripts/fixtures/fake-zai.sh
  scripts/test-jazmii.test.ts
  scripts/test-laxii.test.ts
  scripts/test-ai-registry.test.ts
  scripts/run-all-tests.sh
  docs/M7_JAZMII_LAXII.md
)
for f in "${FILES[@]}"; do
  test -f "$SRC/$f" || { echo "MISSING IN SOURCE: $f"; exit 1; }
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
echo "overlay: ${#FILES[@]} M7 files copied OK"
