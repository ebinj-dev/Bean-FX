#!/usr/bin/env bash
# Overlay the stabilization file set onto the GitHub clone (feature/ai-creative-studio).
# Excluded deliberately: db/custom.db (dev database), authdata/ (auth secrets),
# scripts/gh-*.sh (workspace auth tooling). prisma/schema.prisma is unchanged
# this milestone — no patch needed.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-stab}"

cd "$SRC"
FILES=(
  scripts/apply_missing_migrations.py
  scripts/e2e-media-pipeline.ts
  scripts/test-media-pipeline.test.ts
  scripts/test-editor-regressions.test.ts
  src/app/api/media/route.ts
  src/components/bean/app-shell.tsx
  src/components/bean/editor/inspector.tsx
  src/components/bean/editor/monitor.tsx
  src/components/bean/media-picker.tsx
  src/components/bean/tools/auto-cut.tsx
  src/components/bean/tools/editor.tsx
  src/hooks/use-editor-session.ts
  src/lib/client-api.ts
  src/lib/editor/commands.ts
  src/lib/editor/engine.ts
  src/lib/editor/persistence.ts
  src/lib/editor/preview.ts
  src/lib/media-analysis.ts
  src/lib/media-storage.ts
  src/lib/types.ts
  docs/DATABASE_POSTGRES_MIGRATION.md
)
for f in "${FILES[@]}"; do
  test -f "$SRC/$f" || { echo "MISSING IN SOURCE: $f"; exit 1; }
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
echo "overlay: ${#FILES[@]} stabilization files copied OK"
