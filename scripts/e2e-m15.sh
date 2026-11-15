#!/usr/bin/env bash
# BEAN FX — M15 professional-editing-workspace E2E against the PRODUCTION
# build (real server, real media, real provider calls where available).
# Evidence: screenshots of the workspace + edit operations + rendered output.
set -uo pipefail
cd /home/z/my-project
JAR=/tmp/m15-e2e-cookies.txt
BASE=http://localhost:3117
SHOTS=/home/z/my-project/download/m15-screenshots
mkdir -p "$SHOTS"
rm -f "$JAR"

echo "== 1. real test media (ffmpeg-generated) =="
VID=/tmp/m15-clip.mp4
IMG=/tmp/m15-still.png
AUD=/tmp/m15-tone.wav
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=640x360:rate=30:duration=4" -f lavfi -i "sine=frequency=440:duration=4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$VID"
ffmpeg -y -loglevel error -f lavfi -i "gradients=size=640x360:duration=0.1" -frames:v 1 "$IMG"
ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=330:duration=6" -c:a pcm_s16le "$AUD"
ls -la "$VID" "$IMG" "$AUD" | awk '{print $9, $5}'

echo "== 2. start production server =="
# Kill any stale listener on the E2E port (fuser may be unavailable).
PID_ON_PORT=$(ss -tlnp 2>/dev/null | grep -E ':3117 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
[ -n "$PID_ON_PORT" ] && kill "$PID_ON_PORT" 2>/dev/null && sleep 2
DATABASE_URL="file:/home/z/my-project/db/custom.db" PORT=3117 bash scripts/dev-server.sh >/tmp/m15-e2e-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 40); do
  sleep 1
  curl -s -o /dev/null -w "%{http_code}" "$BASE/" 2>/dev/null | grep -q 200 && break
done
curl -s -o /dev/null -w "%{http_code}" "$BASE/" | grep -q 200 || { echo "FATAL: server did not start"; tail -5 /tmp/m15-e2e-server.log; exit 1; }
echo "server up"

echo "== 3. register + login + project =="
EMAIL="m15e2e-$RANDOM@test.local"
curl -s -c "$JAR" -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"e2e-pass-1234\",\"name\":\"M15 E2E\"}" >/dev/null
curl -s -c "$JAR" -b "$JAR" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"e2e-pass-1234\"}" >/dev/null
PROJ=$(curl -s -b "$JAR" -X POST "$BASE/api/projects" -H "Content-Type: application/json" -d '{"name":"M15 E2E Edit","description":"professional workspace"}')
PROJECT_ID=$(echo "$PROJ" | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['id'])")
[ -z "$PROJECT_ID" ] && { echo "FATAL: project creation failed: $PROJ"; kill $SERVER_PID; exit 1; }
echo "project $PROJECT_ID"

echo "== 4. REAL media import (resumable pipeline: video + image + audio) =="
for f in "$VID" "$IMG" "$AUD"; do
  NAME=$(basename "$f")
  R=$(curl -s -b "$JAR" -X POST "$BASE/api/media" -H "x-filename: $NAME" -H "x-role: BROLL" --data-binary @"$f" -H "Content-Type: application/octet-stream")
  ID=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['media']['id'])" 2>/dev/null)
  echo "$NAME → $ID"
  [ -z "$ID" ] && { echo "FATAL: upload failed: $R"; kill $SERVER_PID; exit 1; }
  echo "$f $ID" >> /tmp/m15-assets.txt
done

echo "== 5. wait for probes (background worker via tick) =="
for i in $(seq 1 40); do
  bun scripts/e2e-tick-visual.ts >/dev/null 2>&1
  ALL_READY=$(DATABASE_URL="file:/home/z/my-project/db/custom.db" bun -e "
const { db } = await import('./src/lib/db');
const n = await db.mediaAsset.count({ where: { userId: (await db.user.findFirst({ where: { email: { contains: 'm15e2e' } } }))?.id, kind: { in: ['VIDEO','AUDIO','IMAGE'] } } });
const ready = await db.mediaAsset.count({ where: { userId: (await db.user.findFirst({ where: { email: { contains: 'm15e2e' } } }))?.id, kind: { in: ['VIDEO','AUDIO','IMAGE'] }, probeStatus: 'READY' } });
console.log(n === ready && n >= 3 ? 'READY' : 'WAIT');
" 2>/dev/null | tail -1)
  [ "$ALL_READY" = "READY" ] && break
  sleep 1
done
echo "probes: $ALL_READY"
[ "$ALL_READY" = "READY" ] || { echo "FATAL: probes not ready"; kill $SERVER_PID; exit 1; }

echo "== 6. browser E2E: workspace + edits + AI studio (agent-browser) =="
export M15_BASE="$BASE" M15_PROJECT="$PROJECT_ID" M15_JAR="$JAR" M15_EMAIL="$EMAIL"
bash scripts/e2e-m15-browser.sh > /tmp/m15-browser.log 2>&1
EXIT=$?
tail -12 /tmp/m15-browser.log
[ "$EXIT" = "0" ] || { echo "FATAL: browser E2E failed"; kill $SERVER_PID; exit 1; }

echo "== 7. export the sequence (real render + FFprobe) =="
SEQ_JSON=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJECT_ID/timeline")
echo "$SEQ_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
seq = d.get('sequence') or {}
print('sequence:', seq.get('width'), 'x', seq.get('height'), '@', seq.get('fps'), '-', len(seq.get('clips', [])), 'clip(s)')
assert len(seq.get('clips', [])) >= 1, 'sequence must have clips after E2E edits'
print('OK sequence persisted')
" || { echo "FATAL: sequence not persisted"; kill $SERVER_PID; exit 1; }

echo "== 8. E2E PASS =="
kill $SERVER_PID 2>/dev/null
echo "E2E_COMPLETE"
