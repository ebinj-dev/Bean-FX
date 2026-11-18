#!/bin/bash
# P0 — Restore verification for BEAN FX backups (SEPARATE COPIES ONLY).
# Usage:
#   p0_restore_verify.sh <db_backup_dir> <media_backup_dir> <verify_root>
# Behavior:
#   - Restores the db and media backups INTO <verify_root> (never onto the
#     live paths — the script hard-refuses db/custom.db and media-store).
#   - Re-verifies SQLite integrity and row counts on the restored copy.
#   - Regenerates the SHA-256 manifest from the restored media and diffs it
#     against the backup manifest. Exit 0 only if everything matches.
set -euo pipefail

DB_BAK_DIR="${1:?db backup dir}"
MEDIA_BAK_DIR="${2:?media backup dir}"
VERIFY_ROOT="${3:?verify root dir}"
APP_DIR="/home/z/my-project"

[ -f "$DB_BAK_DIR/custom.db" ] || { echo "ERROR: $DB_BAK_DIR/custom.db missing"; exit 1; }
[ -d "$MEDIA_BAK_DIR/media-store" ] || { echo "ERROR: $MEDIA_BAK_DIR/media-store missing"; exit 1; }
[ -f "$MEDIA_BAK_DIR/SHA256MANIFEST.txt" ] || { echo "ERROR: backup manifest missing"; exit 1; }

# Safety: refuse live destinations.
case "$VERIFY_ROOT" in
  "$APP_DIR/db"|"$APP_DIR/db/"*|"$APP_DIR/media-store"|"$APP_DIR/media-store/"*)
    echo "REFUSING: verify root must be a separate copy area, not live data."; exit 3;;
esac
[ -e "$VERIFY_ROOT" ] && { echo "REFUSING: $VERIFY_ROOT already exists (no overwriting)."; exit 3; }

# Absolute paths for every argument: the script cd's into the restored copy
# later and all comparisons must survive that change of directory.
DB_BAK_DIR="$(readlink -f "$DB_BAK_DIR")"
MEDIA_BAK_DIR="$(readlink -f "$MEDIA_BAK_DIR")"
mkdir -p "$VERIFY_ROOT"
VERIFY_ROOT="$(readlink -f "$VERIFY_ROOT")"
rc=0

echo "== 1/3 Restoring database copy =="
cp -a "$DB_BAK_DIR/custom.db" "$VERIFY_ROOT/custom.db.restored"
python3 - "$VERIFY_ROOT/custom.db.restored" <<'PY' || rc=1
import sqlite3, sys
d = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
print("integrity_check(restored):", d.execute("PRAGMA integrity_check").fetchone()[0])
tables = ["User", "Session", "Project", "MediaAsset", "ExportFile", "Job", "WordsToRemove"]
counts = {t: d.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in tables}
print("row_counts(restored):", counts)
expected = {"User": 6, "Session": 15, "Project": 0, "MediaAsset": 28,
            "ExportFile": 16, "Job": 47, "WordsToRemove": 13}  # P0 baseline
print("baseline_match:", counts == expected)
sys.exit(0 if counts == expected else 1)
PY

echo "== 2/3 Restoring media copy =="
cp -a "$MEDIA_BAK_DIR/media-store" "$VERIFY_ROOT/media-store.restored"

echo "== 3/3 Verifying media integrity =="
cd "$VERIFY_ROOT/media-store.restored"
find . -type f -print0 | sort -z | xargs -0 sha256sum > "$VERIFY_ROOT/RESTORED_SHA256MANIFEST.txt"
if diff -q "$MEDIA_BAK_DIR/SHA256MANIFEST.txt" "$VERIFY_ROOT/RESTORED_SHA256MANIFEST.txt" >/dev/null; then
  echo "MEDIA VERIFY: PASS — all $(wc -l < "$VERIFY_ROOT/RESTORED_SHA256MANIFEST.txt") files byte-identical to backup manifest."
else
  echo "MEDIA VERIFY: FAIL — differences:"; diff "$MEDIA_BAK_DIR/SHA256MANIFEST.txt" "$VERIFY_ROOT/RESTORED_SHA256MANIFEST.txt" | head -20; rc=1
fi

db_restored_sha=$(sha256sum "$VERIFY_ROOT/custom.db.restored" | awk '{print $1}')
db_backup_sha=$(sha256sum "$DB_BAK_DIR/custom.db" | awk '{print $1}')
[ "$db_restored_sha" = "$db_backup_sha" ] && echo "DB VERIFY: PASS — restored copy hash matches backup ($db_restored_sha)" || { echo "DB VERIFY: FAIL"; rc=1; }

echo "verify_root: $VERIFY_ROOT"
[ "$rc" -eq 0 ] && echo "RESTORE VERIFICATION: PASS" || echo "RESTORE VERIFICATION: FAIL"
exit "$rc"
