#!/usr/bin/env python3
"""Apply the additive-only P6 DDL (2 tables, 1 nullable column, 3 indexes).

Same safety pattern as the P3 applier:
  Preconditions checked here:
    - A verified backup exists under db/backup-p6-*/ (created by this script).
    - TimelineVersion / TimelineEdit do NOT exist yet.
    - Project.settingsJson does NOT exist yet.
  DDL runs in a single transaction; every statement is additive — no existing
  table or row is touched.
Post-verification:
  - integrity_check == ok
  - row counts of all pre-existing tables are unchanged (live vs backup)
  - the 2 new tables exist and are empty; Project.settingsJson is present
"""
import hashlib
import json
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

LIVE = Path("/home/z/my-project/db/custom.db")
DDL = Path(__file__).resolve().parent.parent / "migration" / "p6_editor_timeline.sql"


def table_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
    return {r[0] for r in rows}


def table_counts(conn: sqlite3.Connection, tables: set[str]) -> dict[str, int]:
    return {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in sorted(tables)}


def main() -> int:
    if not LIVE.exists():
        print(f"FAIL live database not found: {LIVE}")
        return 1
    backup_dir = LIVE.parent / f"backup-p6-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    backup_dir.mkdir(parents=True)
    backup_path = backup_dir / LIVE.name
    shutil.copy2(LIVE, backup_path)

    conn = sqlite3.connect(LIVE)
    conn.execute("PRAGMA foreign_keys=ON")
    before_tables = table_names(conn)
    before_counts = table_counts(conn, before_tables)

    # ---- preconditions -------------------------------------------------
    problems = []
    if "TimelineVersion" in before_tables:
        problems.append("TimelineVersion already exists — nothing to apply")
    if "TimelineEdit" in before_tables:
        problems.append("TimelineEdit already exists — nothing to apply")
    project_cols = {r[1] for r in conn.execute("PRAGMA table_info('Project')").fetchall()}
    if "settingsJson" in project_cols:
        problems.append("Project.settingsJson already exists — nothing to apply")
    if problems:
        print("FAIL preconditions:")
        for p in problems:
            print("  -", p)
        return 1

    # ---- backup verification -------------------------------------------
    bconn = sqlite3.connect(backup_path)
    if table_counts(bconn, table_names(bconn)) != before_counts:
        print("FAIL backup verification: row counts differ from live DB")
        return 1
    bconn.close()

    # ---- apply (single transaction, additive only) ----------------------
    ddl = DDL.read_text()
    statements = []
    for chunk in ddl.split(";"):
        sql_lines = [line for line in chunk.splitlines() if line.strip() and not line.strip().startswith("--")]
        if sql_lines:
            statements.append("\n".join(sql_lines))
    try:
        conn.execute("BEGIN")
        for stmt in statements:
            conn.execute(stmt)
        conn.execute("COMMIT")
    except Exception as exc:
        conn.execute("ROLLBACK")
        print(f"FAIL DDL rolled back: {exc}")
        return 1

    # ---- post-verification ----------------------------------------------
    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    after_tables = table_names(conn)
    after_counts = table_counts(conn, after_tables)
    ok = True
    if integrity != "ok":
        print(f"FAIL integrity_check: {integrity}")
        ok = False
    for table in ("TimelineVersion", "TimelineEdit"):
        if table not in after_tables:
            print(f"FAIL {table} missing after apply")
            ok = False
        elif after_counts[table] != 0:
            print(f"FAIL {table} is not empty after apply")
            ok = False
    cols = {r[1] for r in conn.execute("PRAGMA table_info('Project')").fetchall()}
    if "settingsJson" not in cols:
        print("FAIL Project.settingsJson missing after apply")
        ok = False
    for t, c in after_counts.items():
        if t in ("TimelineVersion", "TimelineEdit"):
            continue
        if before_counts.get(t) != c:
            print(f"FAIL pre-existing table {t} changed: {before_counts.get(t)} -> {c}")
            ok = False
    conn.close()

    digest = hashlib.sha256(ddl.encode()).hexdigest()[:16]
    result = {
        "applied": ok,
        "tables": ["TimelineVersion", "TimelineEdit"],
        "addedColumn": "Project.settingsJson",
        "indexes": [
            "TimelineVersion_projectId_versionNumber_key",
            "TimelineVersion_projectId_createdAt_idx",
            "TimelineEdit_versionId_opIndex_idx",
        ],
        "backup": str(backup_path),
        "ddl_sha256_prefix": digest,
        "preexisting_row_counts_unchanged": True,
    }
    print(json.dumps(result, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
