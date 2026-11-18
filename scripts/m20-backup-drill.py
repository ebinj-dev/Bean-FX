#!/usr/bin/env python3
"""M20 §6 — real PostgreSQL backup & restore drill on an isolated instance.

Uses pgserver (embedded PostgreSQL binaries) — a REAL server, real pg_dump,
real pg_restore. No production data touched. Records size/times/integrity.
"""
import json, os, re, shutil, subprocess, time
import pgserver  # provides the PostgreSQL binary distribution

BASE = "/home/z/my-project"
OUT = f"{BASE}/download/m20-backup-drill"
os.makedirs(OUT, exist_ok=True)
DRILL = "/tmp/m20-pg-drill"
if os.path.exists(f"{DRILL}/pgdata"):
    # stop any live server before touching its datadir
    env0 = dict(os.environ, LD_LIBRARY_PATH=os.path.join(os.path.dirname(pgserver.__file__), "pginstall", "bin"))
    subprocess.run([os.path.join(env0["LD_LIBRARY_PATH"], "pg_ctl"), "-D", f"{DRILL}/pgdata", "stop", "-m", "immediate"], capture_output=True, env=env0)
shutil.rmtree(DRILL, ignore_errors=True)
os.makedirs(DRILL)

import random, socket
BIN = os.path.join(os.path.dirname(pgserver.__file__), "pginstall", "bin")
INITDB = os.path.join(BIN, "initdb")
PG_CTL = os.path.join(BIN, "pg_ctl")
POSTGRES = os.path.join(BIN, "postgres")
PG_DUMP, PG_RESTORE, PSQL = (os.path.join(BIN, n) for n in ("pg_dump", "pg_restore", "psql"))

# Start a REAL isolated PostgreSQL on TCP (prisma/psql friendly), trust-auth, sandbox-only.
PGDATA = f"{DRILL}/pgdata"
# Free the port if a previous drill instance is still alive, pick a random free port.
PGPORT = random.randint(54330, 54399)
env = dict(os.environ, LD_LIBRARY_PATH=BIN)
if os.path.exists(f"{DRILL}/pgdata.old"):
    subprocess.run([PG_CTL, "-D", f"{DRILL}/pgdata.old", "stop", "-m", "immediate"], capture_output=True, env=env)
r = subprocess.run([INITDB, "-U", "postgres", "--auth-local=trust", "--auth-host=trust",
                    f"--pgdata={PGDATA}"], capture_output=True, text=True, env=env)
assert r.returncode == 0, r.stderr[-400:]
r = subprocess.run([PG_CTL, "-D", PGDATA, "-o", f"-h 127.0.0.1 -p {PGPORT} -k {DRILL}",
                    "-l", f"{DRILL}/pg.log", "start"], capture_output=True, text=True, env=env)
assert r.returncode == 0, r.stderr[-400:]
pg_url = f"postgresql://postgres@127.0.0.1:{PGPORT}/postgres"
print("drill instance:", pg_url.split("@")[-1])

# 1. PostgreSQL variant of the app schema (same models; provider swapped)
src_schema = open(f"{BASE}/prisma/schema.prisma").read()
pg_schema = re.sub(r'provider\s*=\s*"sqlite"', 'provider = "postgresql"', src_schema, count=1)
pg_schema_path = f"{DRILL}/schema-pg.prisma"
open(pg_schema_path, "w").write(pg_schema)
env = dict(os.environ, DATABASE_URL=pg_url)
r = subprocess.run(["bunx", "prisma", "db", "push", "--skip-generate", "--schema", pg_schema_path],
                   capture_output=True, text=True, cwd=BASE, env=env)
print("schema push:", "OK" if r.returncode == 0 else "FAILED: " + r.stderr[-400:])

# 2. Seed realistic data via psql (25 users, 40 projects with real timeline JSON, audits)
def q(sql):
    r = subprocess.run([PSQL, pg_url, "-tAc", sql], capture_output=True, text=True)
    if r.returncode != 0 or r.stderr.strip():
        print("SQL ERROR:", (r.stderr or r.stdout).strip()[:300])
    return r

q("""INSERT INTO "User" ("id","email","name","passwordHash","role","emailVerified","createdAt","updatedAt")
     SELECT gen_random_uuid()::text, 'drill'||g||'@backup.test', 'Backup Drill '||g, 'x', 'user', false, now(), now()
     FROM generate_series(0,24) g""")
uid = q("""SELECT "id" FROM "User" WHERE email='drill0@backup.test'""").stdout.strip()
clip = '{"start":1,"dur":3.2,"label":"' + "x" * 120 + '"}'
seq = '{"clips":[' + ",".join([clip] * 50) + "]}'"
q(f"""INSERT INTO "Project" ("id","userId","name","description","settingsJson","createdAt","updatedAt")
     SELECT gen_random_uuid()::text, '{uid}', 'Drill Project '||g, 'Backup drill project', '{{"fps":30,"resolution":"1080p"}}', now(), now()
     FROM generate_series(0,39) g""")
q(f"""INSERT INTO "TimelineVersion" ("id","projectId","versionNumber","sequenceJson","isAutosave","createdById","createdAt")
     SELECT gen_random_uuid()::text, p."id", 1, $sq${seq}$sq$, false, '{uid}', now()
     FROM "Project" p WHERE p."userId" = '{uid}'""")
q("""INSERT INTO "TimelineEdit" ("id","versionId","opIndex","type","payloadJson","inverseJson","createdAt")
     SELECT gen_random_uuid()::text, tv."id", 0, 'seed', '{}', '{}', now()
     FROM "TimelineVersion" tv""")
q("""INSERT INTO "AuditEvent" ("id","action","detail","createdAt")
     VALUES (gen_random_uuid()::text, 'drill.seed', 'backup drill seed', now())""")
seeded = q("""SELECT (SELECT count(*) FROM "User")||' users, '||(SELECT count(*) FROM "Project")||' projects, '||(SELECT count(*) FROM "AuditEvent")||' audits'""").stdout.strip()
print("SEEDED:", seeded)

# 3. BACKUP (custom format, compressed) — measure size + time
t0 = time.time()
r = subprocess.run([PG_DUMP, "--format=custom", "--compress=6", f"--file={DRILL}/drill.dump", pg_url], capture_output=True, text=True)
backup_sec = time.time() - t0
dump_size = os.path.getsize(f"{DRILL}/drill.dump") if r.returncode == 0 else 0
print(f"BACKUP: {dump_size/1024:.1f} KB in {backup_sec:.2f}s, exit={r.returncode} {r.stderr[:200]}")

# 4. Restore into a NEW isolated database
subprocess.run([PSQL, pg_url, "-tAc", "DROP DATABASE IF EXISTS drill_restore"], capture_output=True, text=True)
r = subprocess.run([PSQL, pg_url, "-tAc", "CREATE DATABASE drill_restore"], capture_output=True, text=True)
print("create db:", r.stderr.strip()[:120] or "OK")
rest_url = pg_url.rsplit("/", 1)[0] + "/drill_restore"  # TCP URL has no query string
t1 = time.time()
r = subprocess.run([PG_RESTORE, f"--dbname={rest_url}", f"{DRILL}/drill.dump"], capture_output=True, text=True)
restore_sec = time.time() - t1
print(f"RESTORE: exit={r.returncode} in {restore_sec:.2f}s")
err_lines = [l for l in r.stderr.splitlines() if "error" in l.lower()]
print("restore errors (first 3):", err_lines[:3] if err_lines else "none")

# 5. Integrity verification — identical counts + content probe
src_counts = q("""SELECT (SELECT count(*) FROM "User")||' users, '||(SELECT count(*) FROM "Project")||' projects, '||(SELECT count(*) FROM "AuditEvent")||' audits'""").stdout.strip()
rest = subprocess.run([PSQL, rest_url, "-tAc",
    """SELECT (SELECT count(*) FROM "User")||' users, '||(SELECT count(*) FROM "Project")||' projects, '||(SELECT count(*) FROM "AuditEvent")||' audits'"""], capture_output=True, text=True)
restored_counts = rest.stdout.strip()
probe = subprocess.run([PSQL, rest_url, "-tAc",
    """SELECT length("sequenceJson") FROM "TimelineVersion" tv JOIN "Project" p ON p."id"=tv."projectId" WHERE p.name='Drill Project 7'"""], capture_output=True, text=True)
print("SOURCE :", src_counts)
print("RESTORED:", restored_counts, "| probe len:", probe.stdout.strip())
integrity_ok = src_counts == restored_counts and probe.stdout.strip().isdigit()

# 6. gzip-compressed copy (encrypted-at-rest layer documented for production)
subprocess.run(f'gzip -c "{DRILL}/drill.dump" > "{DRILL}/drill.dump.gz"', shell=True)
enc_size = os.path.getsize(f"{DRILL}/drill.dump.gz")

# 7. Retention sweep demo: keep last 3
fake = [f"{DRILL}/ret_{i}.dump" for i in range(5)]
for f in fake: open(f, "wb").write(b"x" * 1024)
kept = sorted(fake, key=lambda f: -os.path.getmtime(f))[:3]
for f in [x for x in fake if x not in kept]: os.remove(f)
print(f"RETENTION: kept {len(kept)}, removed {5 - len(kept)}")

report = {
    "drill": "isolated pgserver PostgreSQL instance (real server + real pg_dump/pg_restore/psql binaries)",
    "schema": "PG variant of the app schema created via `prisma db push --schema` (same models, additive)",
    "seeded": seeded,
    "backup_bytes": dump_size,
    "backup_kb": round(dump_size / 1024, 1),
    "backup_seconds": round(backup_sec, 2),
    "backup_format": "pg_dump custom format, --compress=6",
    "restore_seconds": round(restore_sec, 2),
    "restore_target": "separate database drill_restore (isolated instance)",
    "integrity": {"source": src_counts, "restored": restored_counts, "content_probe_len": probe.stdout.strip(), "match": integrity_ok},
    "compressed_backup_kb": round(enc_size / 1024, 1),
    "retention_policy": "keep 3 most recent backups (demonstrated)",
    "production_data_touched": False,
}
json.dump(report, open(f"{OUT}/backup-restore-drill.json", "w"), indent=1)
print("REPORT SAVED:", f"{OUT}/backup-restore-drill.json")
