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

# Seed a retention-probe user + media row so the journey's step-29 cleanup
# check verifies REAL cross-user preservation (an isolated DB has no other
# users otherwise, making the assertion vacuous).
DATABASE_URL="file:/tmp/m20-journey.db" bun -e "
const {PrismaClient} = await import('@prisma/client');
const db = new PrismaClient();
const u = await db.user.upsert({
  where: {email: 'retention-probe@test.local'},
  update: {},
  create: {email: 'retention-probe@test.local', name: 'Retention Probe',
           passwordHash: 'x', emailVerified: true},
});
const existing = await db.mediaAsset.findFirst({where: {userId: u.id, originalName: 'probe-asset.mp4'}});
if (!existing) await db.mediaAsset.create({data: {userId: u.id, originalName: 'probe-asset.mp4', storagePath: '/tmp/probe-asset.mp4', kind: 'VIDEO', mimeType: 'video/mp4', sizeBytes: 1024}});
console.log('PROBE_USER', u.id);
await db.\$disconnect();
" 2>&1 | tail -1
