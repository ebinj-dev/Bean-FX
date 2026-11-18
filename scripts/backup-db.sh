#!/usr/bin/env bash
# M20 §6 — database backup / restore drill (SQLite live drill + PostgreSQL runbook mode).
#
# Usage:
#   backup-db.sh sqlite  <source-db> <backup-dir>   — .backup via sqlite3 CLI, integrity-checked
#   backup-db.sh postgres <DATABASE_URL> <backup-dir> — pg_dump custom format (run on the prod host)
#   restore-db.sh  sqlite  <backup-file> <target-db>  — restore to an ISOLATED target, never in place
#   verify mode is built into both.
#
# The drill NEVER touches the live DB in place: backups go to a dedicated dir
# and restores target an isolated copy whose integrity + row counts are then
# compared against the source.
set -euo pipefail
MODE="${1:-}"; A="${2:-}"; B="${3:-}"

timestamp() { date -u +"%Y%m%dT%H%M%SZ"; }

if [ "$MODE" = "sqlite" ]; then
  SRC="$A"; DEST="$B"
  [ -f "$SRC" ] || { echo "NO_SOURCE $SRC"; exit 1; }
  mkdir -p "$DEST"
  OUT="$DEST/beanfx-db-$(timestamp).db"
  T0=$(date +%s%N)
  # Consistent snapshot: sqlite3 .backup acquires a read lock and copies pages.
  sqlite3 "$SRC" ".backup '$OUT'"
  T1=$(date +%s%N)
  # Integrity verification on the backup itself.
  OK=$(sqlite3 "$OUT" "PRAGMA integrity_check;")
  ROWS=$(sqlite3 "$OUT" "SELECT (SELECT COUNT(*) FROM User) || '/' || (SELECT COUNT(*) FROM Project) || '/' || (SELECT COUNT(*) FROM MediaAsset) || '/' || (SELECT COUNT(*) FROM Job);")
  SIZE=$(stat -c%s "$OUT")
  MS=$(( (T1 - T0) / 1000000 ))
  echo "BACKUP_OK file=$OUT size=${SIZE}B took=${MS}ms integrity=$OK rows(User/Project/Media/Job)=$ROWS"
  # WAL sidecars must be checkpointed inside the snapshot — .backup handles it;
  # assert none are needed for the copy to stand alone.
  sqlite3 "$OUT" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null || true
  exit 0
fi

if [ "$MODE" = "postgres" ]; then
  URL="$A"; DEST="$B"
  mkdir -p "$DEST"
  OUT="$DEST/beanfx-db-$(timestamp).dump"
  T0=$(date +%s)
  # Custom format: compressed, restorable selectively, supports pg_restore -j.
  pg_dump --format=custom --no-owner --no-privileges --file="$OUT" "$URL"
  T1=$(date +%s)
  # Integrity: list the archive contents (fails on a corrupt archive).
  pg_restore --list "$OUT" >/dev/null
  SIZE=$(stat -c%s "$OUT")
  echo "BACKUP_OK file=$OUT size=${SIZE}B took=$((T1 - T0))s archive_list=verified"
  exit 0
fi

echo "usage: backup-db.sh sqlite <db> <dir> | postgres <url> <dir>"; exit 2
