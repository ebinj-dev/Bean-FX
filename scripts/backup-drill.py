#!/usr/bin/env python3
"""M20 §6 — database backup / restore drill.

SQLite mode performs a real online backup (python sqlite3 .backup() — the
same consistent-snapshot mechanism as the sqlite3 CLI `.backup`), verifies
integrity on the backup, and the restore drill copies to an ISOLATED target
and compares row counts against the source. The live database is never
modified in place.

PostgreSQL mode is a full command reference (pg_dump/pg_restore) that runs
verbatim on the production host — recorded here because this sandbox has no
PostgreSQL binaries (no root). Marked INFRASTRUCTURE REQUIRED in the report.

Usage:
  backup-drill.py sqlite <source-db> <backup-dir>
  backup-drill.py restore sqlite <backup-file> <source-db>
"""
import os, sqlite3, sys, time, shutil, datetime, json

def count_rows(con, tables):
    parts = []
    for t in tables:
        n = con.execute(f"SELECT COUNT(*) FROM \"{t}\"").fetchone()[0]
        parts.append(f"{t}={n}")
    return " ".join(parts)


def pg_drill():
    """M20 §6 — REAL PostgreSQL drill using pgserver (bundled PG binaries).
    Creates an isolated PG instance in a temp dir, seeds an app-like schema,
    pg_dump → backup file, pg_restore into a SECOND database, verifies row
    counts + content checksums. Nothing touches the app's SQLite database."""
    import pgserver, subprocess, hashlib, glob
    started = time.time()
    datadir = "/tmp/m20-pg-drill"
    subprocess.run(["rm", "-rf", datadir], check=True)
    subprocess.run(["mkdir", "-p", datadir], check=True)
    inst = pgserver.get_server(datadir)
    import psycopg  # pgserver depends on psycopg
    def db_uri(name: str) -> str:
        # pgserver URI: postgresql://postgres:@/postgres?host=<datadir> — swap the DB path segment.
        base = inst.get_uri()
        return base.replace("/postgres?", f"/{name}?")
    admin = psycopg.connect(db_uri("postgres"), autocommit=True)
    admin.execute("CREATE DATABASE beanfx_prod_sim")
    admin.execute("CREATE DATABASE beanfx_restore_sim")
    admin.close()

    prod = psycopg.connect(db_uri("beanfx_prod_sim"), autocommit=True)
    def seed(sql, rows):
        with prod.cursor() as c:
            c.executemany(sql, rows)
    prod.execute("""
        CREATE TABLE "User" (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT,
            password_hash TEXT NOT NULL, role TEXT DEFAULT 'user', created_at TIMESTAMPTZ DEFAULT now());
        CREATE TABLE "Project" (id TEXT PRIMARY KEY, user_id TEXT REFERENCES "User"(id),
            name TEXT, sequence_json TEXT, created_at TIMESTAMPTZ DEFAULT now());
        CREATE TABLE "MediaAsset" (id TEXT PRIMARY KEY, user_id TEXT REFERENCES "User"(id),
            kind TEXT, storage_path TEXT, bytes BIGINT);
        CREATE TABLE "Job" (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, status TEXT, progress INT);
        CREATE TABLE "AuditEvent" (id TEXT PRIMARY KEY, action TEXT, detail TEXT, created_at TIMESTAMPTZ DEFAULT now());
    """)
    import random, string
    def rid(): return "".join(random.choices(string.ascii_lowercase + string.digits, k=12))
    users = [(rid(), f"drill{i}@test.local", f"Drill {i}", "scrypt$fake$" + "x" * 64, "user" if i else "admin") for i in range(120)]
    seed('INSERT INTO "User" (id,email,name,password_hash,role) VALUES (%s,%s,%s,%s,%s)', users)
    projects, assets, jobs = [], [], []
    for i in range(300):
        uid = users[i % 120][0]
        seq = json.dumps({"clips": [{"id": i, "asset": rid(), "in": random.randint(0, 10000)} for _ in range(random.randint(1, 12))]})
        projects.append((rid(), uid, f"Project {i}", seq))
    for i in range(500):
        assets.append((rid(), users[i % 120][0], random.choice(["VIDEO", "AUDIO", "IMAGE"]), f"media/{rid()}.mp4", random.randint(100_000, 2_000_000_000)))
    for i in range(2000):
        jobs.append((rid(), users[i % 120][0], random.choice(["PROBE", "RENDER_TIMELINE", "EXPORT", "AI_JOB"]), random.choice(["COMPLETED", "FAILED", "QUEUED"]), random.randint(0, 100)))
    seed('INSERT INTO "Project" (id,user_id,name,sequence_json) VALUES (%s,%s,%s,%s)', projects)
    seed('INSERT INTO "MediaAsset" (id,user_id,kind,storage_path,bytes) VALUES (%s,%s,%s,%s,%s)', assets)
    seed('INSERT INTO "Job" (id,user_id,type,status,progress) VALUES (%s,%s,%s,%s,%s)', jobs)
    audits = [(rid(), random.choice(["auth.login", "auth.login_failed", "admin.users_listed"]), f"detail-{i}") for i in range(8000)]
    seed('INSERT INTO "AuditEvent" (id,action,detail) VALUES (%s,%s,%s)', audits)
    prod.commit()
    seed_done = time.time()

    tables = ["User", "Project", "MediaAsset", "Job", "AuditEvent"]
    def census(con):
        out = {}
        for t in tables:
            out[t] = con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        return out
    src_counts = census(prod)
    # checksum: order-stable digest of each table's contents
    def checksums(con):
        out = {}
        for t in tables:
            h = hashlib.sha256()
            cur = con.execute(f'SELECT * FROM "{t}" ORDER BY 1')
            for row in cur:
                h.update(repr(row).encode())
            out[t] = h.hexdigest()[:16]
        return out
    src_sums = checksums(prod)
    prod.close()

    dump = "/tmp/m20-pg-drill/beanfx-pg-backup.dump"
    # pgserver bundles the full PG toolchain — use its bin dir explicitly.
    import glob as _g
    pgbin = os.path.dirname(_g.glob("/home/z/.venv/lib/python3.12/site-packages/pgserver/pginstall/bin/pg_dump")[0])
    env = dict(os.environ)
    env["PATH"] = pgbin + ":" + env.get("PATH", "")
    t0 = time.time()
    r = subprocess.run(["pg_dump", "--dbname", db_uri("beanfx_prod_sim"), "--format=custom", "--file", dump, "--compress=6"], capture_output=True, text=True, env=env)
    if r.returncode != 0:
        print("PG_DUMP_FAIL", r.stderr[-400:]); return
    backup_secs = time.time() - t0
    size = os.path.getsize(dump)

    t1 = time.time()
    r = subprocess.run(["pg_restore", "--dbname", db_uri("beanfx_restore_sim"), "--no-owner", dump], capture_output=True, text=True, env=env)
    if r.returncode != 0:
        print("PG_RESTORE_FAIL", r.stderr[-400:]); return
    restore_secs = time.time() - t1

    tgt = psycopg.connect(db_uri("beanfx_restore_sim"), autocommit=True)
    tgt_counts = census(tgt)
    tgt_sums = checksums(tgt)
    integrity = all(src_counts[t] == tgt_counts[t] for t in tables) and all(src_sums[t] == tgt_sums[t] for t in tables)
    tgt.close()

    seed_secs = seed_done - started
    print("PG_DRILL_RESULT " + json.dumps({
        "mode": "postgres (pgserver binaries, isolated temp datadir)",
        "seed_seconds": round(seed_secs, 2),
        "backup_bytes": size, "backup_seconds": round(backup_secs, 2),
        "restore_seconds": round(restore_secs, 2),
        "row_counts_source": src_counts, "row_counts_restored": tgt_counts,
        "checksums_match": integrity,
        "per_table_sums": {t: [src_sums[t], tgt_sums[t]] for t in tables},
        "verdict": "PG_BACKUP_RESTORE_OK" if integrity else "INTEGRITY_MISMATCH",
        "total_seconds": round(time.time() - started, 2),
    }))

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "pg":
        pg_drill(); return
    tables = ["User", "Project", "MediaAsset", "Job", "Session", "ExportFile", "AuditEvent"]

    if mode == "sqlite":
        src, dest = sys.argv[2], sys.argv[3]
        assert os.path.isfile(src), f"no source db: {src}"
        os.makedirs(dest, exist_ok=True)
        stamp = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
        out = os.path.join(dest, f"beanfx-db-{stamp}.db")
        t0 = time.time()
        s = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
        d = sqlite3.connect(out)
        s.backup(d)  # consistent snapshot incl. WAL content
        d.close(); s.close()
        took = round((time.time() - t0) * 1000)
        c = sqlite3.connect(out)
        integrity = c.execute("PRAGMA integrity_check").fetchone()[0]
        rows = count_rows(c, tables)
        size = os.path.getsize(out)
        c.close()
        print(f"BACKUP_OK file={out} size={size}B took_ms={took} integrity={integrity}")
        print(f"BACKUP_ROWS {rows}")
        assert integrity == "ok", "backup failed integrity check"
        # Encrypted-at-rest note: SQLite has no native encryption; production
        # PostgreSQL backups must be encrypted (see M20_BACKUP_DRILL.md).

    elif mode == "restore" and sys.argv[2] == "sqlite":
        backup, src = sys.argv[3], sys.argv[4]
        target = f"/tmp/m20-restore-drill-{int(time.time())}.db"
        t0 = time.time()
        shutil.copyfile(backup, target)
        c = sqlite3.connect(target)
        c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        integrity = c.execute("PRAGMA integrity_check").fetchone()[0]
        rows_t = count_rows(c, tables)
        # Read-back proof: the restored copy answers real application queries.
        active = c.execute("SELECT COUNT(*) FROM User WHERE deletedAt IS NULL").fetchone()[0]
        proj_named = c.execute("SELECT COUNT(*) FROM Project").fetchone()[0]
        c.close()
        took = round((time.time() - t0) * 1000)
        s = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
        rows_s = count_rows(s, tables)
        s.close()
        print(f"RESTORE_OK target={target} took_ms={took} integrity={integrity}")
        print(f"RESTORE_ROWS target: {rows_t}")
        print(f"RESTORE_ROWS source: {rows_s}")
        print(f"READBACK active_users={active} projects={proj_named}")
        match = rows_t == rows_s and integrity == "ok"
        print(f"MATCH={match}")
        os.remove(target)
        sys.exit(0 if match else 1)

    elif mode == "postgres-reference":
        print("""# PostgreSQL drill (run verbatim on the production host — INFRASTRUCTURE REQUIRED here)
# 1) Backup (custom format, compressed, integrity-listable):
pg_dump --format=custom --no-owner --no-privileges \\
  --file=beanfx-db-$(date -u +%Y%m%dT%H%M%SZ).dump "$DATABASE_URL"
pg_restore --list beanfx-db-*.dump >/dev/null   # archive integrity
# 2) Restore to an ISOLATED scratch database (never in place):
createdb beanfx_restore_scratch
pg_restore --no-owner --no-privileges --dbname=beanfx_restore_scratch beanfx-db-*.dump
# 3) Integrity + row counts:
psql beanfx_restore_scratch -c 'SELECT COUNT(*) FROM "User";'
# 4) Encrypt the backup at rest:
age -r <recipient-public-key> beanfx-db-*.dump > beanfx-db-*.dump.age
# 5) Retention: keep 7 daily + 4 weekly + 3 monthly (cron example in M20_BACKUP_DRILL.md)""")
    else:
        print(__doc__); sys.exit(2)

if __name__ == "__main__":
    main()
