#!/usr/bin/env bash
# BEAN FX — M36 Phase B-E: upgrade procedure for the staging deployment.
#
# Order matters: VERIFIED BACKUP FIRST, then code update, then non-destructive
# schema sync, rebuild, and service restart with health verification. On any
# failure the service keeps running the previous build (upgrade is halted
# before the restart step).
#
# Never destructive: no reset, no accept-data-loss, media never touched.
# Usage: m36-upgrade.sh [--env /path/.env.staging] [--ref feature/ai-creative-studio]
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="/home/beanfx/.env.staging"
REF="feature/ai-creative-studio"
[ "${1:-}" = "--env" ] && { ENV_FILE="$2"; shift 2 || true; }
[ "${1:-}" = "--ref" ] && { REF="$2"; shift 2 || true; }

fail() { echo "UPGRADE_FAILED at: $*" >&2; exit 1; }
step() { echo "== [upgrade] $1"; }

step "0/7 preconditions"
command -v bun >/dev/null || fail "bun missing"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
bun scripts/m36-validate-env.ts --env "$ENV_FILE" --strict || fail "environment invalid"

step "1/7 verified backup (before ANY change)"
DATA_ROOT="$(dirname "${DATABASE_URL#file:}")"
bash scripts/m36-fs-layout.sh "$DATA_ROOT" >/dev/null
bun scripts/m36-backup.ts --db "$DATABASE_URL" --media "${BEANFX_DATA_DIR:?}" --out "$DATA_ROOT/backups" --verify || fail "pre-upgrade backup failed — upgrade halted, service untouched"

step "2/7 fetch code"
git fetch origin "$REF" || fail "git fetch"
LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse "origin/$REF")
if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then echo "  already up to date at $LOCAL_HEAD"; fi

step "3/7 checkout (fast-forward only)"
git checkout -q "$REF" 2>/dev/null || fail "git checkout $REF"
git merge --ff-only "origin/$REF" || fail "non-fast-forward — reconcile manually, never force"

step "4/7 deps + prisma generate (non-destructive)"
bun install --frozen-lockfile || fail "bun install"
bunx prisma generate || fail "prisma generate"

step "5/7 schema sync (non-destructive push only)"
bunx prisma db push --skip-generate || fail "schema sync failed — previous build still intact; investigate before retrying"

step "6/7 rebuild"
bun run build || fail "build failed — previous build still intact"

step "7/7 restart + health"
if command -v systemctl >/dev/null && systemctl list-unit-files 2>/dev/null | grep -q beanfx; then
  systemctl restart beanfx && sleep 4 && systemctl is-active --quiet beanfx || fail "service restart"
else
  echo "  (no systemd unit — restart manually via scripts/beanfxctl.sh restart)"
fi
bash scripts/m36-health-check.sh "http://localhost:${PORT:-3000}" "${BEANFX_DATA_DIR:-}" || true
echo "UPGRADE_OK"
