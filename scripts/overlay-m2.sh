#!/usr/bin/env bash
# Overlay the M2 file set (PUSH_TO_GITHUB.md section 2) from the durable
# working tree onto the GitHub clone. schema.prisma is deliberately NOT
# overlaid (diff-verified separately). db/custom.db excluded (dev DB).
set -euo pipefail
SRC=/home/z/my-project
DST=/tmp/beanfx-push

cd "$SRC"
for f in \
  src/lib/editor/time.ts src/lib/editor/model.ts src/lib/editor/commands.ts \
  src/lib/editor/engine.ts src/lib/editor/persistence.ts \
  src/lib/editor/preview.ts src/lib/editor/interaction.ts \
  src/hooks/use-editor-session.ts \
  "src/app/api/editor/projects/[projectId]/timeline/route.ts" \
  "src/app/api/editor/projects/[projectId]/timeline/versions/route.ts" \
  "src/app/api/editor/projects/[projectId]/timeline/restore/route.ts" \
  src/components/bean/editor/monitor.tsx \
  src/components/bean/editor/timeline.tsx \
  src/components/bean/editor/inspector.tsx \
  src/components/bean/tools/editor.tsx \
  src/components/bean/app-shell.tsx src/components/bean/nav-items.ts \
  migration/p6_editor_timeline.sql \
  scripts/apply_p6_migration.py scripts/apply_missing_migrations.py \
  scripts/editor-db-smoke.ts scripts/e2e-editor-timeline.ts \
  scripts/test-editor-time.test.ts scripts/test-editor-commands.test.ts \
  scripts/test-editor-preview.test.ts scripts/test-editor-interaction.test.ts \
  docs/AI_CREATIVE_STUDIO_AUDIT.md docs/THIRD_PARTY_NOTICES.md \
  ; do
  test -f "$SRC/$f" || { echo "MISSING IN SOURCE: $f"; exit 1; }
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
echo "overlay: 28 files copied OK"

echo "=== files in M2 commit but not overlaid (informational) ==="
for f in migration/p3_migration.sql .env.example scripts/verify-asr-real-weights.py prisma/schema.prisma db/custom.db; do
  if [ -f "$DST/$f" ]; then
    if cmp -s "$SRC/$f" "$DST/$f" 2>/dev/null; then echo "IDENTICAL: $f"
    else echo "DIFFERS:   $f"; fi
  else echo "ABSENT ON GITHUB: $f"; fi
done
