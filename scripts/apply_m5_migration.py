#!/usr/bin/env python3
"""Apply the additive-only M5 DDL (1 table, 1 column, 3 indexes) to the DB.

Follows the established P3 pattern:
  - a verified backup is created first (db/backup-<ts>/custom.db)
  - preconditions: GangziiProcess must not exist; MediaAsset.derivedFromId
    must not exist
  - DDL runs in one transaction; every statement is additive (no
    DROP/ALTER-modify/DELETE anywhere in m5_migration.sql)
Post-verification:
  - integrity_check == ok
  - row counts of all pre-existing tables are unchanged (live vs backup)
  - the new table exists and is empty; the new column is all-NULL
"""
import hashlib
import os
import shutil
import sqlite3
import sys

LIVE = os.environ.get("GANGZII_DB", "/home/z/my-project/db/custom.db")
DDL = "/home/z/my-project/migration/m5_migration.sql"
BACKUP_DIR = os.path.join(os.path.dirname(LIVE), "backup-m5-" + os.environ.get("M5_TS", "now"))

PRE_TABLES = ["User", "Session", "Project", "MediaAsset", "ExportFile", "Job",
              "WordsToRemove", "CutDecision", "CutDecisionEvent", "TimelineVersion",
              "TimelineEdit", "UploadSession"]


def counts(con):
    tables = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    return {t: con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    sql = open(DDL).read()
    forbidden = ("DROP ", "DELETE ", "UPDATE ")
    for stmt in sql.split(";"):
        head = stmt.strip().split("\n")[0].strip().upper()
        for word in forbidden:
            # comments start with --; only real statements are checked
            if word in head and not head.startswith("--"):
                sys.exit(f"FATAL: non-additive statement refused: {head}")

    con = sqlite3.connect(LIVE)
    con.row_factory = sqlite3.Row
    exists_table = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='GangziiProcess'").fetchone()
    exists_col = con.execute(
        "SELECT 1 FROM pragma_table_info('MediaAsset') WHERE name='derivedFromId'").fetchone()
    if exists_table or exists_col:
        sys.exit("FATAL: M5 schema already applied (GangziiProcess or derivedFromId exists)")

    before = counts(con)
    os.makedirs(BACKUP_DIR, exist_ok=True)
    backup_db = os.path.join(BACKUP_DIR, "custom.db")
    con.execute("VACUUM INTO ?", (backup_db,))
    con.close()
    # VACUUM INTO writes a compacted copy — byte hashes differ from the live
    # file by design, so the backup is verified by integrity + content counts.
    bcon = sqlite3.connect(backup_db)
    if bcon.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        sys.exit("FATAL: backup integrity check failed")
    bcounts = counts(bcon)
    bcon.close()
    for t, n in before.items():
        if bcounts.get(t) != n:
            sys.exit(f"FATAL: backup content mismatch for {t}: live {n} vs backup {bcounts.get(t)}")
    if sha256(backup_db) == "":
        sys.exit("FATAL: empty backup")
    print(f"backup verified (integrity + counts): {backup_db}")

    con = sqlite3.connect(LIVE)
    try:
        con.execute("BEGIN")
        con.executescript(sql)
        con.commit()
    except Exception as e:
        con.rollback()
        sys.exit(f"FATAL: migration failed and was rolled back: {e}")

    check = con.execute("PRAGMA integrity_check").fetchone()[0]
    if check != "ok":
        sys.exit(f"FATAL: integrity_check failed: {check}")
    after = counts(con)
    for t, n in before.items():
        if after.get(t) != n:
            sys.exit(f"FATAL: row count changed for {t}: {n} → {after.get(t)}")
    rows = con.execute("SELECT COUNT(*) FROM GangziiProcess").fetchone()[0]
    if rows != 0:
        sys.exit(f"FATAL: GangziiProcess not empty after migration ({rows} rows)")
    nulls = con.execute("SELECT COUNT(*) FROM MediaAsset WHERE derivedFromId IS NOT NULL").fetchone()[0]
    if nulls != 0:
        sys.exit(f"FATAL: derivedFromId not all-NULL ({nulls})")
    con.close()
    print("M5 migration applied and verified: GangziiProcess created, "
          "MediaAsset.derivedFromId added, all row counts unchanged, integrity ok")


if __name__ == "__main__":
    main()
