#!/usr/bin/env bash
# M31 SHOWCASE STUDIO — isolated live E2E environment + evidence capture.
# Mirrors the M20 journey pattern: fresh DB copy, standalone server on :3118,
# real-media tests, artifacts written to docs/m31-showcase-evidence/.
set -euo pipefail
cd /home/z/my-project
EVIDENCE=docs/m31-showcase-evidence
mkdir -p "$EVIDENCE"

# 1) isolated DB with the current schema
rm -f /tmp/m31-showcase.db /tmp/m31-showcase.db-journal
rm -rf /tmp/m31-showcase-data
DATABASE_URL="file:/tmp/m31-showcase.db" bunx prisma db push --skip-generate --schema prisma/schema.prisma 2>&1 | tail -1

# 2) kill anything on :3118, start the standalone server
PID3118=$(ss -tlnp 2>/dev/null | grep ':3118 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
[ -n "${PID3118:-}" ] && kill -9 "$PID3118" 2>/dev/null || true
sleep 1
DATABASE_URL="file:/tmp/m31-showcase.db" \
BEANFX_DATA_DIR="/tmp/m31-showcase-data" \
BEANFX_ZAI_BIN="z-ai" \
BEANFX_MYAI_PROVIDER="zai" \
PUBLIC_APP_URL="http://localhost:3118" \
PORT=3118 RATE_LIMIT_SCALE=50 \
nohup bash scripts/dev-server.sh > /tmp/m31-showcase-server.log 2>&1 &
for i in $(seq 1 60); do
  curl -sf -o /dev/null http://localhost:3118/ && break
  sleep 2
done
curl -sf -o /dev/null http://localhost:3118/ && echo "3118 READY" || { tail -20 /tmp/m31-showcase-server.log; exit 1; }

# 3) run the LIVE showcase suite against the isolated server
M31_BASE=http://localhost:3118 M31_DB=file:/tmp/m31-showcase.db \
  bun test scripts/test-showcase-live.test.ts 2>&1 | tee "$EVIDENCE/live-test-output.txt"

# 4) unit suite evidence
bun test scripts/test-showcase-core.test.ts 2>&1 | tee "$EVIDENCE/core-test-output.txt"

echo "EVIDENCE written to $EVIDENCE/"
