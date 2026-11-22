#!/usr/bin/env bash
# M35 Track H — health-check implementing the four-state model:
#   HEALTHY | DEGRADED | CONFIGURATION REQUIRED | UNAVAILABLE
# Usage: m35-health-check.sh [base-url] [media-root]
#   base-url   default http://localhost:3000
#   media-root default $BEANFX_DATA_DIR (or /home/z/my-project/media-store)
# Checks: app 200, /api/health, DB reachable (Prisma quick read via bun),
#         media root writable, disk/memory thresholds, recent FAILED jobs.
# Exit codes: 0=HEALTHY, 1=DEGRADED, 2=CONFIGURATION REQUIRED, 3=UNAVAILABLE.
set -u
BASE="${1:-http://localhost:3000}"
MEDIA_ROOT="${2:-${BEANFX_DATA_DIR:-/home/z/my-project/media-store}}"
DB_URL="${DATABASE_URL:-}"
verdict="HEALTHY"; notes=()

# 1. app availability
APP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$BASE/" || echo 000)
if [ "$APP" != "200" ]; then echo "UNAVAILABLE app=$APP"; exit 3; fi

# 2. /api/health
HP=$(curl -s --max-time 5 "$BASE/api/health" | head -c 200 || true)
[ -z "$HP" ] && { notes+=("api/health empty"); verdict="DEGRADED"; }

# 3. DB reachable (Prisma via bun, single cheap query)
if [ -n "$DB_URL" ]; then
  DBOUT=$(DATABASE_URL="$DB_URL" bun -e '
import {PrismaClient} from "@prisma/client";
const db=new PrismaClient({log:[]});
await db.$queryRawUnsafe("SELECT 1"); console.log("DB_OK"); await db.$disconnect();' 2>&1 | tail -1)
  if [ "$DBOUT" != "DB_OK" ]; then echo "UNAVAILABLE db unreachable"; exit 3; fi
else
  notes+=("DATABASE_URL not set — DB check skipped"); verdict="CONFIGURATION REQUIRED"
fi

# 4. media root writable
if [ -d "$MEDIA_ROOT" ] && touch "$MEDIA_ROOT/.healthcheck-$$" 2>/dev/null; then
  rm -f "$MEDIA_ROOT/.healthcheck-$$"
else
  notes+=("media root not writable: $MEDIA_ROOT"); verdict="DEGRADED"
fi

# 5. disk / memory thresholds
DISK=$(df -P "$MEDIA_ROOT" 2>/dev/null | awk 'NR==2{gsub("%","",$5);print $5}')
[ -n "$DISK" ] && [ "$DISK" -ge 85 ] && { notes+=("disk ${DISK}% ≥85"); verdict="DEGRADED"; }
MEM_AVAIL=$(free -m | awk '/^Mem:/{print $7}')
MEM_TOTAL=$(free -m | awk '/^Mem:/{print $2}')
[ -n "${MEM_TOTAL:-}" ] && [ "$MEM_TOTAL" -gt 0 ] && AVAIL_PCT=$((MEM_AVAIL * 100 / MEM_TOTAL)) \
  && [ "$AVAIL_PCT" -lt 25 ] && { notes+=("avail mem ${AVAIL_PCT}% <25"); verdict="DEGRADED"; }

# 6. recent FAILED jobs (last 10 job rows via API-independent DB read)
if [ -n "$DB_URL" ]; then
  FAILED=$(DATABASE_URL="$DB_URL" bun -e '
import {PrismaClient} from "@prisma/client";
const db=new PrismaClient({log:[]});
const f=await db.job.count({where:{status:"FAILED"}});
const q=await db.job.count({where:{status:"QUEUED"}});
console.log(`FAILED=${f} QUEUED=${q}`); await db.$disconnect();' 2>/dev/null | tail -1)
  case "$FAILED" in
    *FAILED=0*) : ;;
    *) notes+=("jobs: $FAILED"); [ "$verdict" = "HEALTHY" ] && verdict="DEGRADED" ;;
  esac
fi

# CONFIGURATION REQUIRED overrides DEGRADED only when core is otherwise fine
for cfg in "${notes[@]-}"; do
  case "$cfg" in *"not set"*|*"skipped"*) [ "$verdict" = "DEGRADED" ] && verdict="CONFIGURATION REQUIRED";; esac
done

echo "$verdict"
[ ${#notes[@]} -gt 0 ] && printf 'notes:\n' && printf ' - %s\n' "${notes[@]}"
case "$verdict" in HEALTHY) exit 0;; DEGRADED) exit 1;; "CONFIGURATION REQUIRED") exit 2;; *) exit 3;; esac
