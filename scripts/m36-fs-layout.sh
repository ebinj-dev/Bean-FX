#!/usr/bin/env bash
# BEAN FX — M36 Phase B-B: persistent filesystem layout for staging.
#
# Creates/verifies the controlled directory layout under a configurable root
# (default /home/beanfx/data). NEVER deletes user media; refuses to "fix" an
# unsafe layout. Safe to re-run (idempotent).
#
# Usage: m36-fs-layout.sh [DATA_ROOT]          (default /home/beanfx/data)
# Exit codes: 0 = layout ready · 1 = layout cannot be made safe
set -euo pipefail

ROOT="${1:-/home/beanfx/data}"

fail() { echo "FS_LAYOUT_FAIL: $*" >&2; exit 1; }
ok()   { echo "  ok: $*"; }

[ -d "$ROOT" ] || { mkdir -p "$ROOT" || fail "cannot create $ROOT (run as a user with rights there)"; }

case "$ROOT" in
  /|/tmp|/usr|/etc|/var|/boot|/dev|/proc|/sys) fail "$ROOT is a system path — use a dedicated data root";;
esac

# --- directories (created only, never emptied) ---
DB_DIR="$ROOT"                      # beanfx-staging.db lives here
MEDIA="$ROOT/media-store"           # BEANFX_DATA_DIR (uploads/exports/masks/packages/tmp)
BACKUPS="$ROOT/backups"             # snapshot dir (m36-backup.ts)
LOGS="$ROOT/logs"                   # service logs (systemd template also journald)
for d in "$DB_DIR" "$MEDIA" "$BACKUPS" "$LOGS"; do
  mkdir -p "$d" || fail "cannot create $d"
  ok "dir $d"
done

# --- tmp/exports subdirs inside the media root (media-storage expects tmp/) ---
mkdir -p "$MEDIA/tmp" && ok "dir $MEDIA/tmp"

# --- disk headroom: media root must have >2 GB free (renders need it) ---
FREE_KB=$(df -Pk "$MEDIA" | awk 'NR==2{print $4}')
FREE_GB=$((FREE_KB / 1024 / 1024))
if [ "$FREE_GB" -lt 2 ]; then
  echo "  warning: only ${FREE_GB} GB free on $MEDIA — renders may fail (health check will flag DEGRADED)"
else
  ok "disk headroom ${FREE_GB} GB free on $MEDIA"
fi

# --- permissions: data root must be private to the operator (user data + db) ---
chmod 700 "$ROOT" 2>/dev/null || true
chmod 700 "$BACKUPS" 2>/dev/null || true   # backups contain user data — restrict
ok "permissions: $ROOT and $BACKUPS restricted to owner (700)"

echo "FS_LAYOUT_OK root=$ROOT media=$MEDIA backups=$BACKUPS logs=$LOGS"
