#!/usr/bin/env bash
# Overlay the M5 (GANGZII audio intelligence engine) file set onto the GitHub
# clone (feature/ai-creative-studio).
# Excluded deliberately: db/ + backups (dev databases), authdata/ (secrets),
# package.json (workspace dev conveniences), workspace tooling, fixtures.
set -euo pipefail
SRC=/home/z/my-project
DST="${1:-/tmp/beanfx-push-m5}"

cd "$SRC"
FILES=(
  src/lib/gangzii/fft.ts
  src/lib/gangzii/loudness.ts
  src/lib/gangzii/inspect.ts
  src/lib/gangzii/dsp.ts
  src/lib/gangzii/presets.ts
  src/lib/gangzii/proposal.ts
  src/lib/gangzii/types.ts
  src/lib/gangzii/jobs.ts
  src/lib/gangzii/storage.ts
  src/app/api/gangzii/analyze/route.ts
  src/app/api/gangzii/process/route.ts
  src/app/api/gangzii/processes/route.ts
  src/app/api/gangzii/proposal/route.ts
  src/app/api/gangzii/process/[id]/route.ts
  src/components/bean/editor/gangzii-panel.tsx
  scripts/test-gangzii-analysis.test.ts
  scripts/test-gangzii-dsp.test.ts
  scripts/test-gangzii-jobs.test.ts
  scripts/apply_m5_migration.py
  scripts/run-all-tests.sh
  migration/m5_migration.sql
  docs/M5_GANGZII.md
  prisma/schema.prisma
  src/lib/job-helpers.ts
  src/lib/job-runner.ts
  src/lib/media-worker.ts
  src/components/bean/tools/editor.tsx
)
for f in "${FILES[@]}"; do
  test -f "$SRC/$f" || { echo "MISSING IN SOURCE: $f"; exit 1; }
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
echo "overlay: ${#FILES[@]} M5 files copied OK"
