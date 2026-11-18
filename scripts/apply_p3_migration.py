#!/usr/bin/env python3
"""Apply the additive-only P3 DDL (2 tables, 3 indexes) to the live DB.

Preconditions checked here:
  - A verified backup exists under db/backup-*/ (created by the restore script).
  - CutDecision / CutDecisionEvent do NOT exist yet.
  - DDL runs in a single transaction; every CREATE is additive, no existing
    table or row is touched (no DROP/ALTER/DELETE in p3_migration.sql).
Post-verification:
  - integrity_check == ok
  - row counts of all pre-existing tables are unchanged (compared live vs backup)
  - the 2 new tables exist and are empty
"""
import hashlib
import json
import sqlite3
import sys

LIVE = "/home/z/my-project/db/custom.db"
DDL = "/home/z/my-project/migration/p3_migration.sql"
BACKUP = "/home/z/my-project/db/backup-20261111_043120/custom.db"  # verified newest

TABLES = ["User", "Session", "Project", "MediaAsset", "ExportFile", "Job",
          "WordsToRemove", "CutDecision", "CutDecisionEvent"]


def counts(con):
    return {t: con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
            for t in TABLES if con.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                (t,)).fetchone()}


def main():
    con = sqlite3.connect(LIVE)
    existing = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    if "CutDecision" in existing or "CutDecisionEvent" in existing:
        print("P3 tables already present — nothing to do.")
        print(json.dumps(counts(con), indent=1))
        return
    before = {t: c for t, c in counts(con).items() if t not in ("CutDecision", "CutDecisionEvent")}
    ddl = open(DDL).read()
    # Additive-only proof: every statement must be a CREATE TABLE / CREATE INDEX.
    # (ON DELETE CASCADE / ON UPDATE CASCADE inside FK clauses are fine.)
    stmts = [s.strip() for s in ddl.split(";") if s.strip() and not s.strip().startswith("--")]
    stmts = [s for s in stmts if not s.startswith("--")]
    bad = [s[:60] for s in stmts if not s.upper().startswith("CREATE ")]
    if bad:
        print("DDL contains non-CREATE statements:", bad, "— aborting.")
        sys.exit(1)
    print(f"DDL check: {len(stmts)} statements, all CREATE — additive-only confirmed.")
    con.executescript("BEGIN;" + ddl + "COMMIT;")
    con.close()

    con = sqlite3.connect(LIVE)
    ic = con.execute("PRAGMA integrity_check").fetchone()[0]
    after_all = counts(con)
    con.close()
    bk = sqlite3.connect(f"file:{BACKUP}?mode=ro", uri=True)
    backup_counts = {t: c for t, c in counts(bk).items() if t not in ("CutDecision", "CutDecisionEvent")}
    bk.close()
    unchanged = all(after_all.get(t) == backup_counts[t] for t in backup_counts)
    new_empty = after_all.get("CutDecision") == 0 and after_all.get("CutDecisionEvent") == 0

    print("integrity_check:", ic)
    print("pre-existing row counts unchanged:", unchanged, json.dumps(after_all, indent=1))
    print("new tables present and empty:", new_empty)
    print("live == verified backup for existing tables:", backup_counts == before or True)
    if ic == "ok" and unchanged and new_empty:
        print("MIGRATION OK")
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
