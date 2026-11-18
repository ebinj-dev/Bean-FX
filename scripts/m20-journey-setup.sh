#!/usr/bin/env bash
# M20 §4 — prepare the isolated journey environment (server :3118, fresh DB).
# Run AFTER the durable suite finishes (it pkill's ffmpeg, which would break a
# concurrent export). Produces /tmp/m20-journey.db with the current schema.
set -euo pipefail
rm -f /tmp/m20-journey.db /tmp/m20-journey.db-journal
DATABASE_URL="file:/tmp/m20-journey.db" bunx prisma db push --skip-generate --schema /home/z/my-project/prisma/schema.prisma 2>&1 | tail -1
mkdir -p /tmp/m20-journey-data
# kill anything already on 3118
PID3118=$(ss -tlnp 2>/dev/null | grep ':3118 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
[ -n "${PID3118:-}" ] && kill -9 "$PID3118" 2>/dev/null || true
sleep 1
# M20: m20-work copy was lost to a workspace rollback — the production
# standalone build now lives in my-project itself (next build --webpack).
cd /home/z/my-project
DATABASE_URL="file:/tmp/m20-journey.db" \
BEANFX_DATA_DIR="/tmp/m20-journey-data" \
BEANFX_ZAI_BIN="z-ai" \
BEANFX_MYAI_PROVIDER="zai" \
PUBLIC_APP_URL="http://localhost:3118" \
SMTP_URL="smtp://127.0.0.1:8025" \
PORT=3118 RATE_LIMIT_SCALE=50 \
nohup bash scripts/dev-server.sh > /tmp/m20-journey-server.log 2>&1 &
sleep 7
curl -sf -o /dev/null http://localhost:3118/ && echo "3118 READY" || { tail -5 /tmp/m20-journey-server.log; exit 1; }
