#!/usr/bin/env python3
"""P3 Phase B: verified SQLite backup of the live BEAN FX database.

- Uses the SQLite online backup API (sqlite3.Connection.backup) — safe under
  concurrent writers; here no server is running, so the snapshot is trivially
  consistent.
- Records timestamp, SHA-256, integrity_check and full row counts.
- Independently re-verifies the backup by reopening it from disk.
- Confirms the live database file is byte-identical before/after the backup.
"""
import hashlib
import os
import shutil
import sqlite3
import sys
from datetime import datetime, timezone

LIVE = "/home/z/my-project/db/custom.db"
TS = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
DEST_DIR = f"/home/z/my-project/backups/p3/{TS}"
BACKUP = os.path.join(DEST_DIR, "custom.db")
META = os.path.join(DEST_DIR, "MANIFEST.txt")

TABLES = ["User", "Session", "WordsToRemove", "Project", "MediaAsset", "ExportFile", "Job"]

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def rowcounts(con):
    return {t: con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in TABLES}

def main():
    os.makedirs(DEST_DIR, exist_ok=True)
    live_before_hash = sha256(LIVE)
    live_size = os.path.getsize(LIVE)

    src = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True)
    live_integrity = src.execute("PRAGMA integrity_check").fetchone()[0]
    live_counts = rowcounts(src)
    if live_integrity != "ok":
        print(f"ABORT: live db integrity_check = {live_integrity}")
        sys.exit(1)

    dst = sqlite3.connect(BACKUP)
    src.backup(dst)                      # online backup API
    dst.close()
    src.close()

    # Independent verification: fresh connection to the backup file on disk.
    chk = sqlite3.connect(f"file:{BACKUP}?mode=ro", uri=True)
    bak_integrity = chk.execute("PRAGMA integrity_check").fetchone()[0]
    bak_counts = rowcounts(chk)
    job_breakdown = list(chk.execute("SELECT type, status, COUNT(*) FROM Job GROUP BY type, status ORDER BY 3 DESC"))
    chk.close()

    if bak_integrity != "ok" or bak_counts != live_counts:
        print("ABORT: backup verification failed", bak_integrity, bak_counts)
        sys.exit(1)

    live_after_hash = sha256(LIVE)
    live_unchanged = live_after_hash == live_before_hash
    bak_hash = sha256(BACKUP)

    lines = [
        "P3 Phase B — pre-migration SQLite backup",
        f"created_utc        : {datetime.now(timezone.utc).isoformat()}",
        f"source             : {LIVE}",
        f"source_size_bytes  : {live_size}",
        f"source_sha256      : {live_before_hash}",
        f"source_integrity   : {live_integrity}",
        f"backup_file        : {BACKUP}",
        f"backup_size_bytes  : {os.path.getsize(BACKUP)}",
        f"backup_sha256      : {bak_hash}",
        f"backup_integrity   : {bak_integrity}",
        f"live_unchanged_after_backup : {live_unchanged}",
        "row_counts (source == backup verified):",
        *[f"  {t}: {n}" for t, n in live_counts.items()],
        "job_breakdown:",
        *[f"  {t}/{s}: {n}" for t, s, n in job_breakdown],
        "method             : sqlite3 online backup API; independent reopen verification passed",
    ]
    with open(META, "w") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))

if __name__ == "__main__":
    main()
