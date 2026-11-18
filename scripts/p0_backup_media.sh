#!/bin/bash
# P0 — Media backup for BEAN FX (media-store/).
# Strategy: full byte copy (cp -a) + SHA-256 manifest of every file.
# Guarantees: timestamped dir, never overwrites an existing backup, explicit
# disk-space guard (requires ~1.1× source free), no deletion, no retention.
set -euo pipefail

APP_DIR="/home/z/my-project"
SRC="$APP_DIR/media-store"
BACKUP_ROOT="$APP_DIR/backups/media"
TS="$(date +%Y%m%d_%H%M%S)"
DEST="$BACKUP_ROOT/$TS"

[ -d "$SRC" ] || { echo "ERROR: $SRC missing"; exit 1; }

# Disk-space guard: need source size × 1.1 free.
src_bytes=$(du -sb "$SRC" | awk '{print $1}')
need_mb=$(( src_bytes * 11 / 10 / 1024 / 1024 + 1 ))
free_mb=$(df -Pm "$APP_DIR" | awk 'NR==2 {print $4}')
if [ "$free_mb" -lt "$need_mb" ]; then
  echo "ERROR: only ${free_mb} MB free, need ~${need_mb} MB for a full media backup. Aborting."
  exit 2
fi

# Never overwrite: the timestamped leaf is created with plain mkdir (fails if
# it already exists); only the fixed parent is auto-created.
mkdir -p "$BACKUP_ROOT"
mkdir "$DEST"

echo "Copying $(( src_bytes / 1024 / 1024 )) MB ..."
cp -a "$SRC" "$DEST/media-store"

# Manifest: sha256 of every file, relative paths, sorted for stable diffs.
cd "$DEST/media-store"
find . -type f ! -name SHA256MANIFEST.txt -print0 | sort -z | xargs -0 sha256sum > "$DEST/SHA256MANIFEST.txt"
files=$(wc -l < "$DEST/SHA256MANIFEST.txt")
bytes=$(du -sb "$DEST/media-store" | awk '{print $1}')

cat > "$DEST/MANIFEST.txt" <<EOF
backup_type: media-full-copy
source: $SRC
created: $TS
files: $files
bytes: $bytes
manifest: SHA256MANIFEST.txt (sha256, relative paths, sorted)
notes: full copy incl. permissions; no retention/cleanup performed
EOF

echo "BACKUP OK: $DEST/media-store"
echo "files: $files  bytes: $bytes"
echo "manifest: $DEST/SHA256MANIFEST.txt"
