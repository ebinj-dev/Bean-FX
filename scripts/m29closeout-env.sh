#!/usr/bin/env bash
# M29-C Phase 1 — dedicated, disposable closeout test environment.
# Isolated from the normal development database (db/custom.db) and the
# default media store (media-store/). NOTHING here touches dev data.
set -euo pipefail
SRC=/home/z/my-project
TEST_DB="$SRC/db/m29closeout.db"
TEST_DATA_DIR="$SRC/media-store-closeout"
PORT=3118
LOG="$SRC/m29closeout-server.log"

echo "=== M29-C test environment identity ==="
echo "test-db:        $TEST_DB"
echo "test-data-dir:  $TEST_DATA_DIR"
echo "dev-db (MUST stay untouched): $SRC/db/custom.db"
echo "port:           $PORT"

# Safety: never recreate the dev database; only create the isolated one.
if [ -f "$TEST_DB" ]; then
  echo "test db exists — resetting the DISPOSABLE closeout db only"
  rm -f "$TEST_DB"
fi
mkdir -p "$TEST_DATA_DIR/proxies" "$TEST_DATA_DIR/media"

# Apply the current prisma schema to the isolated db (no force-reset; the db
# is new/disposable, so plain db push is safe by construction).
cd "$SRC"
DATABASE_URL="file:$TEST_DB" bunx prisma db push --skip-generate 2>&1 | tail -1

# Stop any closeout server from a previous run (only ever PID on :3118).
OLD=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oE "pid=[0-9]+" | head -1 | grep -oE "[0-9]+" || true)
[ -n "$OLD" ] && kill "$OLD" 2>/dev/null && sleep 2 || true

# Start the built standalone server against the isolated env.
(DATABASE_URL="file:$TEST_DB" BEANFX_DATA_DIR="$TEST_DATA_DIR" PORT=$PORT RATE_LIMIT_SCALE=50 \
  nohup bash "$SRC/scripts/dev-server.sh" > "$LOG" 2>&1 &)
sleep 8
CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/" || echo 000)
echo "server-health: $CODE"
DATABASE_URL="file:$TEST_DB" bun -e '
import {PrismaClient} from "@prisma/client";
const db = new PrismaClient();
const counts = { users: await db.user.count(), projects: await db.project.count(), jobs: await db.job.count(), archives: await db.projectArchive.count() };
console.log("fixture-counts:", JSON.stringify(counts));
await db.$disconnect();'
echo "=== isolation check: dev db unchanged ==="
DATABASE_URL="file:$SRC/db/custom.db" bun -e '
import {PrismaClient} from "@prisma/client";
const db = new PrismaClient();
console.log("dev-db users:", await db.user.count(), "(reference snapshot; closeout never writes here)");
await db.$disconnect();'
echo "OK — suites must run with M29_BASE=http://localhost:$PORT"
