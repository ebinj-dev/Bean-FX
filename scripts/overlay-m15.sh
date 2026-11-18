#!/usr/bin/env bash
# Overlay the M15 (Professional Editing Studio) file set onto the GitHub clone.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m15}"

cd "$SRC"
FILES=(
  src/components/bean/tools/editor.tsx
  src/components/bean/app-shell.tsx
  src/components/bean/studio-dashboard.tsx
  src/components/bean/editor/timeline.tsx
  src/components/bean/editor/monitor.tsx
  src/components/bean/editor/composition-canvas.tsx
  src/components/bean/editor/editing-toolbar.tsx
  src/components/bean/editor/media-browser.tsx
  src/components/bean/editor/effects-browser.tsx
  src/components/bean/editor/ai-studio.tsx
  src/components/bean/editor/my-ai-panel.tsx
  src/components/bean/editor/creative-panel.tsx
  src/app/api/projects/[id]/route.ts
  src/lib/editor/tools.ts
  src/app/api/media/upload/[uploadId]/route.ts
  scripts/test-m15-core.test.ts
  scripts/e2e-m15.sh
  scripts/e2e-m15-browser.sh
  scripts/run-all-tests.sh
  docs/M15_WORKSPACE_AUDIT.md
)

for f in "${FILES[@]}"; do
  if [ ! -f "$SRC/$f" ]; then echo "MISSING SOURCE FILE: $f"; exit 1; fi
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
chmod +x "$DST/scripts/e2e-m15.sh" "$DST/scripts/e2e-m15-browser.sh"
