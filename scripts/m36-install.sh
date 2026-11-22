#!/usr/bin/env bash
# BEAN FX — M36 Phase B-E: fresh installation for the single-server staging topology.
#
# Sequence (every step fails loudly and stops):
#   versions → resources → env → dirs → deps (lockfile) → prisma generate
#   → db init (NON-destructive push) → build → post-verify
#
# Never destructive: no db push --accept-data-loss, no reset, no media touched.
# Usage: m36-install.sh [--env /path/.env.staging]   (default env: /home/beanfx/.env.staging)
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="/home/beanfx/.env.staging"
[ "${1:-}" = "--env" ] && ENV_FILE="${2:?--env needs a path}"

step() { echo "== [install] $1"; }
fail() { echo "INSTALL_FAILED at: $*" >&2; exit 1; }

step "1/9 runtime & tool versions"
command -v bun >/dev/null || fail "bun not on PATH (installed version required)"
command -v node >/dev/null || fail "node not on PATH (standalone server runs under node)"
command -v ffmpeg >/dev/null || fail "ffmpeg not on PATH — rendering cannot work"
command -v ffprobe >/dev/null || fail "ffprobe not on PATH"
echo "  bun $(bun --version) · node $(node --version) · ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"

step "2/9 resource conditions"
MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
[ "$MEM_MB" -ge 7500 ] || echo "  warning: ${MEM_MB} MB RAM < M35 8 GB minimum — renders will OOM-fail honestly, plan a bigger host"
DISK_GB=$(df -Pk . | awk 'NR==2{print int($4/1024/1024)}')
[ "$DISK_GB" -ge 5 ] || fail "only ${DISK_GB} GB free in the checkout — build needs ≥5 GB"
echo "  mem ${MEM_MB} MB · disk ${DISK_GB} GB free"

step "3/9 environment validation"
bun scripts/m36-validate-env.ts --env "$ENV_FILE" --strict || fail "environment invalid — fix the items above (secrets stay on the host)"

step "4/9 persistent directories"
DATA_ROOT="$(grep -oE 'BEANFX_DATA_DIR="[^"]+"' "$ENV_FILE" | cut -d'"' -f2 | xargs dirname)"
bash scripts/m36-fs-layout.sh "$DATA_ROOT" || fail "filesystem layout"

step "5/9 dependencies from the lockfile"
bun install --frozen-lockfile || fail "bun install (lockfile drift? — resolve, never bypass)"

step "6/9 Prisma client generation"
bunx prisma generate || fail "prisma generate"

step "7/9 database initialization (NON-destructive)"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
bunx prisma db push --skip-generate || fail "prisma db push — a FAILURE here means the schema could not be applied; NEVER retry with --accept-data-loss"

step "8/9 production build"
bun run build || fail "build"

step "9/9 post-install verification"
DB_PATH="${DATABASE_URL#file:}"; DB_PATH="${DB_PATH%%\?*}"
[ -f "$DB_PATH" ] || fail "database file $DB_PATH was not created"
bun scripts/m36-db-ops.ts verify --url "$DATABASE_URL" || fail "database verification"
echo "INSTALL_OK — start with: beanfxctl start (systemd) or scripts/beanfxctl.sh start"
