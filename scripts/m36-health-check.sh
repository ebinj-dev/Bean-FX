#!/usr/bin/env bash
# BEAN FX — health-check (M35 four-state model, extended M36 Phase E).
# States: HEALTHY | DEGRADED | CONFIGURATION REQUIRED | UNAVAILABLE
#   (the task-named UNHEALTHY maps to the repository's canonical UNAVAILABLE.)
#   An unconfigured PROVIDER is reported as a separate subsystem and NEVER
#   degrades core health (docs/M36_HEALTH_AND_OBSERVABILITY.md).
# Checks: app 200, /api/health (incl. its 503 component report), DB reach+
#   integrity+perms+contention (m36-db-ops), media-root write, ffmpeg/ffprobe,
#   render-temp accumulation, backup freshness, disk/memory thresholds, job
#   backlog/failed counts, provider readiness (informational).
# Usage: m36-health-check.sh [base-url] [media-root]
# Exit: 0=HEALTHY 1=DEGRADED 2=CONFIGURATION REQUIRED 3=UNAVAILABLE
set -u
BASE="${1:-http://localhost:3000}"
MEDIA_ROOT="${2:-${BEANFX_DATA_DIR:-/home/z/my-project/media-store}}"
DB_URL="${DATABASE_URL:-}"
BACKUP_DIR="${BEANFX_BACKUP_DIR:-}"
verdict="HEALTHY"; notes=(); provs=()

# 1. app availability — total failure is UNAVAILABLE immediately
APP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$BASE/" || echo 000)
if [ "$APP" != "200" ]; then echo "UNAVAILABLE app=$APP"; exit 3; fi

# 2. /api/health — the app's own honest per-component report (DB/storage/disk)
HP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$BASE/api/health" || echo 000)
HP=$(curl -s --max-time 5 "$BASE/api/health" || true)
if [ "$HP_CODE" = "503" ]; then
  echo "UNAVAILABLE /api/health failing component: $(echo "$HP" | head -c 300)"; exit 3
elif [ "$HP_CODE" != "200" ]; then
  notes+=("/api/health http=$HP_CODE"); verdict="DEGRADED"
fi

# 3. DB reachable + integrity + perms + contention (direct, independent of the app)
if [ -n "$DB_URL" ] && [ "${DB_URL#file:}" != "$DB_URL" ]; then
  DBOUT=$(DATABASE_URL="$DB_URL" bun scripts/m36-db-ops.ts verify --url "$DB_URL" 2>&1 | tail -6)
  echo "$DBOUT" | grep -q "integrity=ok" || { echo "UNAVAILABLE db integrity: $(echo "$DBOUT" | head -2)"; exit 3; }
  echo "$DBOUT" | grep -q "perms=.*WARNING" && notes+=("db file group/world readable")
  echo "$DBOUT" | grep -qE "contention=[1-9]" && { notes+=("db lock/timeout signatures in recent FAILED jobs"); verdict="DEGRADED"; }
else
  notes+=("DATABASE_URL not a file: URL — direct db checks skipped"); verdict="CONFIGURATION REQUIRED"
fi

# 4. storage write access
if [ -d "$MEDIA_ROOT" ] && touch "$MEDIA_ROOT/.healthcheck-$$" 2>/dev/null; then
  rm -f "$MEDIA_ROOT/.healthcheck-$$"
else
  echo "UNAVAILABLE media root not writable: $MEDIA_ROOT"; exit 3
fi

# 5. FFmpeg availability (render prerequisite; absence = DEGRADED core)
if command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then
  FFMPEG_VERSION=$(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')
else
  notes+=("ffmpeg/ffprobe not on PATH — renders will fail honestly"); verdict="DEGRADED"; FFMPEG_VERSION="missing"
fi

# 6. render-temp accumulation (seg_*/list_* older than 1h = crash leftovers)
TMP_OLD=$(find "$MEDIA_ROOT" -type f \( -name 'seg_*' -o -name 'list_*' \) -mmin +60 2>/dev/null | wc -l)
[ "$TMP_OLD" -gt 0 ] && { notes+=("$TMP_OLD render temp files older than 1h"); verdict="DEGRADED"; }

# 7. backup freshness (nightly target → none newer than 26h = DEGRADED)
if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
  LATEST=$(find "$BACKUP_DIR" -maxdepth 1 -name 'beanfx-backup-*' -newermt "$(date -d '-26 hours' '+%Y-%m-%d %H:%M:%S')" 2>/dev/null | wc -l)
  [ "$LATEST" -eq 0 ] && { notes+=("no backup newer than 26h in $BACKUP_DIR"); verdict="DEGRADED"; }
else
  provs+=("backup target not configured (BEANFX_BACKUP_DIR unset) — OFF-HOST/LOCAL BACKUP: CONFIGURATION REQUIRED")
fi

# 8. disk & memory thresholds
DISK=$(df -P "$MEDIA_ROOT" 2>/dev/null | awk 'NR==2{gsub("%","",$5);print $5}')
[ -n "$DISK" ] && [ "$DISK" -ge 85 ] && { notes+=("disk ${DISK}% >=85"); verdict="DEGRADED"; }
MEM_TOTAL=$(free -m | awk '/^Mem:/{print $2}'); MEM_AVAIL=$(free -m | awk '/^Mem:/{print $7}')
[ -n "${MEM_TOTAL:-}" ] && [ "$MEM_TOTAL" -gt 0 ] && AVAIL_PCT=$((MEM_AVAIL * 100 / MEM_TOTAL)) \
  && [ "$AVAIL_PCT" -lt 25 ] && { notes+=("available memory ${AVAIL_PCT}% <25"); verdict="DEGRADED"; }

# 9. job backlog + failed jobs (durable-render visibility)
if [ -n "$DB_URL" ] && [ "${DB_URL#file:}" != "$DB_URL" ]; then
  J=$(DATABASE_URL="$DB_URL" bun -e '
import {PrismaClient} from "@prisma/client";
const db=new PrismaClient({log:[]});
const q=await db.job.count({where:{status:"QUEUED"}});
const p=await db.job.count({where:{status:"PROCESSING"}});
const f=await db.job.count({where:{status:"FAILED"}});
const c=await db.job.count({where:{status:"CANCELLED"}});
console.log(`QUEUED=${q} PROCESSING=${p} FAILED=${f} CANCELLED=${c}`);
await db.$disconnect();' 2>/dev/null | tail -1)
  case "$J" in
    *FAILED=0*) : ;;
    *) notes+=("jobs: $J"); [ "$verdict" = "HEALTHY" ] && verdict="DEGRADED" ;;
  esac
  [ -n "$J" ] && provs+=("render-worker: in-process runner (jobs: $J)")
fi

# 10. provider readiness — separate optional subsystem, NEVER affects core verdict
if [ -n "${BEANFX_ZAI_BIN:-}" ]; then
  [ -x "${BEANFX_ZAI_BIN}" ] && provs+=("provider CLI: present (${BEANFX_ZAI_BIN})") \
    || provs+=("provider CLI: configured but NOT executable: ${BEANFX_ZAI_BIN}")
else
  provs+=("provider CLI: unconfigured — AI generation disabled; core editor unaffected (CONFIGURATION REQUIRED, informational)")
fi

echo "$verdict"
[ ${#provs[@]} -gt 0 ] && { printf 'subsystems:\n'; printf ' - %s\n' "${provs[@]}"; }
[ ${#notes[@]} -gt 0 ] && { printf 'notes:\n'; printf ' - %s\n' "${notes[@]}"; }
[ -n "${FFMPEG_VERSION:-}" ] && [ "$FFMPEG_VERSION" != "missing" ] && echo "ffmpeg: $FFMPEG_VERSION"
case "$verdict" in HEALTHY) exit 0;; DEGRADED) exit 1;; "CONFIGURATION REQUIRED") exit 2;; *) exit 3;; esac
