#!/usr/bin/env bash
# Overlay the M4 (RIISHE → timeline) file set onto the GitHub clone
# (feature/ai-creative-studio). Excluded deliberately: db/ (dev database),
# authdata/ (secrets), prisma/ (repo schema stays canonical), package.json
# (workspace-only dev conveniences), workspace tooling and evidence files.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m4}"

cd "$SRC"
FILES=(
  src/lib/riishe-timeline.ts
  scripts/test-riishe-timeline.test.ts
  src/components/bean/tools/editor.tsx
  src/components/bean/editor/monitor.tsx
  src/components/bean/editor/timeline.tsx
  src/components/bean/tools/auto-cut.tsx
  src/hooks/use-editor-session.ts
  src/instrumentation.ts
  docs/M4_RIISHE.md
)
for f in "${FILES[@]}"; do
  test -f "$SRC/$f" || { echo "MISSING IN SOURCE: $f"; exit 1; }
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
echo "overlay: ${#FILES[@]} M4 files copied OK"
