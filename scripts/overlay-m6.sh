#!/usr/bin/env bash
# Overlay the M6 (NIIKI motion graphics engine) file set onto the GitHub clone.
# Excluded: db/ + backups (dev databases), authdata/ (secrets), /tmp debug scripts.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m6}"

cd "$SRC"
FILES=(
  src/lib/nikki/animation.ts
  src/lib/nikki/types.ts
  src/lib/nikki/typography.ts
  src/lib/nikki/templates.ts
  src/lib/nikki/state.ts
  src/lib/nikki/canvas.ts
  src/lib/nikki/render.ts
  src/lib/nikki/jobs.ts
  src/lib/nikki/proposal.ts
  src/app/api/nikki/render/route.ts
  src/app/api/nikki/proposal/route.ts
  src/components/bean/editor/nikki-panel.tsx
  src/components/bean/editor/monitor.tsx
  src/components/bean/tools/editor.tsx
  src/lib/editor/model.ts
  src/lib/editor/commands.ts
  src/lib/job-helpers.ts
  src/lib/media-worker.ts
  public/fonts/NotoSans-Bold.ttf
  public/fonts/NotoSansTamil-Regular.ttf
  public/fonts/NOTICE.txt
  scripts/test-nikki-core.test.ts
  scripts/test-nikki-render.test.ts
  scripts/run-all-tests.sh
  docs/M6_NIIKI.md
)
for f in "${FILES[@]}"; do
  test -f "$SRC/$f" || { echo "MISSING IN SOURCE: $f"; exit 1; }
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
echo "overlay: ${#FILES[@]} M6 files copied OK"
