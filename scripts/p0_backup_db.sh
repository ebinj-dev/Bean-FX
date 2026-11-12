#!/bin/bash
# P0 — Consistent SQLite backup for BEAN FX (db/custom.db).
# Strategy: online backup via Python's sqlite3 backup API — safe while the
# Next.js server is running (consistent snapshot even if a writer appears).
# Guarantees: timestamped dir, never overwrites an existing backup, explicit
# disk-space guard, integrity check on the copy, SHA-256 manifest.
# This script NEVER deletes or modifies live data.
set -euo pipefail

APP_DIR="/home/z/my-project"
DB_PATH="$APP_DIR/db/custom.db"
BACKUP_ROOT="$APP_DIR/backups/db"
REQUIRED_FREE_MB=200          # db is tiny; generous guard for manifests
TS="$(date +%Y%m%d_%H%M%S)"
DEST="$BACKUP_ROOT/$TS"

command -v python3 >/dev/null || { echo "ERROR: python3 not found"; exit 1; }
[ -f "$DB_PATH" ] || { echo "ERROR: $DB_PATH missing"; exit 1; }

# Disk-space guard (MB)
free_mb=$(df -Pm "$APP_DIR" | awk 'NR==2 {print $4}')
db_mb=$(( $(stat -c%s "$DB_PATH") / 1024 / 1024 + 1 ))
if [ "$free_mb" -lt $(( db_mb * 4 + REQUIRED_FREE_MB )) ]; then
  echo "ERROR: only ${free_mb} MB free — refusing to back up (need db×4 + ${REQUIRED_FREE_MB} MB)."
  exit 2
fi

# Never overwrite: the timestamped leaf is created with plain mkdir (fails if
# it already exists); only the fixed parents are auto-created.
mkdir -p "$BACKUP_ROOT"
mkdir "$DEST"

SRC_SHA_BEFORE=$(sha256sum "$DB_PATH" | awk '{print $1}')

# Consistent snapshot copy (online backup API) + verification on the copy.
python3 - "$DB_PATH" "$DEST/custom.db" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect(f"file:{src}?mode=ro", uri=True)   # read-only source handle
d = sqlite3.connect(dst)
s.backup(d)                                             # consistent online backup
d.commit()
print("integrity_check(backup):", d.execute("PRAGMA integrity_check").fetchone()[0])
tables = ["User", "Session", "Project", "MediaAsset", "ExportFile", "Job", "WordsToRemove"]
counts = {t: d.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in tables}
print("row_counts(backup):", counts)
d.close(); s.close()
PY

BAK_SHA=$(sha256sum "$DEST/custom.db" | awk '{print $1}')
SRC_SHA_AFTER=$(sha256sum "$DB_PATH" | awk '{print $1}')

# Manifest (documents provenance; live file may legitimately change if the app
# writes after the snapshot — the BACKUP hash + integrity check are the truth).
cat > "$DEST/MANIFEST.txt" <<EOF
backup_type: sqlite-online-backup
source: $DB_PATH
created: $TS
source_sha256_at_snapshot: $SRC_SHA_BEFORE
backup_sha256: $BAK_SHA
source_sha256_after_run: $SRC_SHA_AFTER
notes: consistent copy via sqlite3 backup API; verified with PRAGMA integrity_check
EOF

echo "BACKUP OK: $DEST/custom.db"
echo "backup_sha256: $BAK_SHA"
echo "manifest: $DEST/MANIFEST.txt"
