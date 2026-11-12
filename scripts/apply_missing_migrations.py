#!/usr/bin/env python3
"""Apply missing additive-only migrations (P3 decisions, P6 editor timeline).

Safety pattern (identical for every DDL file):
  - verified backup under db/backup-<tag>-*/ before any write
  - per-file preconditions (tables/columns must not exist yet)
  - each file applied in a single transaction, additive only
  - integrity_check + pre-existing row counts unchanged after apply
"""
import json
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

LIVE = Path("/home/z/my-project/db/custom.db")
MIGRATIONS = [
    {
        "tag": "p3",
        "ddl": Path(__file__).resolve().parent.parent / "migration" / "p3_migration.sql",
        "forbidden_tables": ["CutDecision", "CutDecisionEvent"],
        "forbidden_columns": [],
        "expect_tables": ["CutDecision", "CutDecisionEvent"],
        "expect_columns": [],
    },
    {
        "tag": "p6",
        "ddl": Path(__file__).resolve().parent.parent / "migration" / "p6_editor_timeline.sql",
        "forbidden_tables": ["TimelineVersion", "TimelineEdit"],
        "forbidden_columns": [("Project", "settingsJson")],
        "expect_tables": ["TimelineVersion", "TimelineEdit"],
        "expect_columns": [("Project", "settingsJson")],
    },
    {
        "tag": "p7",
        "ddl": Path(__file__).resolve().parent.parent / "migration" / "p7_media_pipeline.sql",
        "forbidden_tables": ["UploadSession"],
        "forbidden_columns": [
            ("MediaAsset", "sha256"),
            ("MediaAsset", "proxyStatus"),
            ("Job", "attempts"),
            ("Job", "claimedAt"),
        ],
        "expect_tables": ["UploadSession"],
        "expect_columns": [
            ("MediaAsset", "sha256"),
            ("MediaAsset", "proxyStatus"),
            ("Job", "attempts"),
            ("Job", "claimedAt"),
        ],
    },
]


def table_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
    return {r[0] for r in rows}


def table_counts(conn: sqlite3.Connection, tables: set[str]) -> dict[str, int]:
    return {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in sorted(tables)}


def columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info('{table}')").fetchall()}


def apply(conn: sqlite3.Connection, mig: dict, before_tables: set[str], before_counts: dict[str, int]) -> tuple[bool, str]:
    problems = []
    for t in mig["forbidden_tables"]:
        if t in before_tables:
            problems.append(f"{t} already exists")
    for table, col in mig["forbidden_columns"]:
        if col in columns(conn, table):
            problems.append(f"{table}.{col} already exists")
    if problems:
        return False, "preconditions unmet: " + "; ".join(problems) + " — nothing to apply"

    statements = []
    for chunk in mig["ddl"].read_text().split(";"):
        sql_lines = [line for line in chunk.splitlines() if line.strip() and not line.strip().startswith("--")]
        if sql_lines:
            statements.append("\n".join(sql_lines))
    conn.execute("BEGIN")
    try:
        for stmt in statements:
            conn.execute(stmt)
        conn.execute("COMMIT")
    except Exception as exc:
        conn.execute("ROLLBACK")
        return False, f"DDL rolled back: {exc}"

    after_tables = table_names(conn)
    if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        return False, "integrity_check failed after apply"
    for t in mig["expect_tables"]:
        if t not in after_tables:
            return False, f"{t} missing after apply"
    for table, col in mig["expect_columns"]:
        if col not in columns(conn, table):
            return False, f"{table}.{col} missing after apply"
    after_counts = table_counts(conn, after_tables)
    for t, c in after_counts.items():
        if t in mig["expect_tables"]:
            continue
        if before_counts.get(t) != c:
            return False, f"pre-existing table {t} changed: {before_counts.get(t)} -> {c}"
    return True, "applied and verified"


def main() -> int:
    if not LIVE.exists():
        print(f"FAIL live database not found: {LIVE}")
        return 1
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = LIVE.parent / f"backup-migrations-{stamp}"
    backup_dir.mkdir(parents=True)
    backup_path = backup_dir / LIVE.name
    shutil.copy2(LIVE, backup_path)

    conn = sqlite3.connect(LIVE)
    conn.execute("PRAGMA foreign_keys=ON")
    before_tables = table_names(conn)
    before_counts = table_counts(conn, before_tables)

    bconn = sqlite3.connect(backup_path)
    if table_counts(bconn, table_names(bconn)) != before_counts:
        print("FAIL backup verification: row counts differ from live DB")
        return 1
    bconn.close()

    results = []
    ok = True
    for mig in MIGRATIONS:
        applied, message = apply(conn, mig, before_tables, table_counts(conn, table_names(conn)))
        results.append({"migration": mig["tag"], "applied": applied, "detail": message})
        ok = ok and applied
    conn.close()
    print(json.dumps({"backup": str(backup_path), "results": results}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
