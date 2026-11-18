#!/usr/bin/env bash
# Overlay the M16 (Professional Editing Engine) file set onto the GitHub clone.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m16}"
cd "$SRC"
FILES=(
  src/lib/editor/playback.ts
  src/lib/editor/edits.ts
  src/lib/editor/audio-mixer.ts
  src/lib/editor/filters.ts
  src/lib/editor/thumbnails.ts
  src/lib/editor/model.ts
  src/lib/editor/tools.ts
  src/components/bean/editor/monitor.tsx
  src/components/bean/editor/timeline.tsx
  src/components/bean/editor/composition-canvas.tsx
  src/components/bean/editor/inspector.tsx
  src/components/bean/editor/ai-studio.tsx
  src/components/bean/tools/editor.tsx
  src/hooks/use-editor-session.ts
  src/lib/publish/timeline-render.ts
  src/lib/job-helpers.ts
  src/lib/media-worker.ts
  src/app/api/editor/projects/[projectId]/render/route.ts
  src/app/api/media/upload/[uploadId]/route.ts
  scripts/test-m16-core.test.ts
  scripts/e2e-m16.sh
  scripts/e2e-m16-browser.sh
  scripts/e2e-m15-browser.sh
  scripts/run-all-tests.sh
  docs/M16_ENGINE_AUDIT.md
)
for f in "${FILES[@]}"; do
  if [ ! -f "$SRC/$f" ]; then echo "MISSING SOURCE FILE: $f"; exit 1; fi
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
chmod +x "$DST/scripts/e2e-m16.sh" "$DST/scripts/e2e-m16-browser.sh"
