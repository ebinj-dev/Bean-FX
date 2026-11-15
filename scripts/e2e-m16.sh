#!/usr/bin/env bash
# BEAN FX — M16 E2E: runs the M15 workspace flow (regression) then the M16
# engine flow (playback/seek/effects/render) against the production build.
set -uo pipefail
cd /home/z/my-project
JAR=/tmp/m16-e2e-cookies.txt
BASE=http://localhost:3117
SHOTS=/home/z/my-project/download/m16-screenshots
mkdir -p "$SHOTS"
rm -f "$JAR"

echo "== 1. real test media (ffmpeg-generated: video+audio, still, tone) =="
VID=/tmp/m16-clip.mp4
IMG=/tmp/m16-still.png
AUD=/tmp/m16-tone.wav
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=640x360:rate=30:duration=4" -f lavfi -i "sine=frequency=440:duration=4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$VID"
ffmpeg -y -loglevel error -f lavfi -i "gradients=size=640x360:duration=0.1" -frames:v 1 "$IMG"
ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=330:duration=6" -c:a pcm_s16le "$AUD"
ls -la "$VID" "$IMG" "$AUD" | awk '{print $9, $5}'

echo "== 2. production server =="
PID_ON_PORT=$(ss -tlnp 2>/dev/null | grep -E ':3117 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
[ -n "$PID_ON_PORT" ] && kill "$PID_ON_PORT" 2>/dev/null && sleep 2
DATABASE_URL="file:/home/z/my-project/db/custom.db" PORT=3117 bash scripts/dev-server.sh >/tmp/m16-e2e-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 40); do
  sleep 1
  curl -s -o /dev/null -w "%{http_code}" "$BASE/" 2>/dev/null | grep -q 200 && break
done
curl -s -o /dev/null -w "%{http_code}" "$BASE/" | grep -q 200 || { echo "FATAL: server did not start"; tail -5 /tmp/m16-e2e-server.log; exit 1; }
echo "server up"

echo "== 3. user + project + import =="
EMAIL="m16e2e-$RANDOM@test.local"
curl -s -c "$JAR" -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"e2e-pass-1234\",\"name\":\"M16 E2E\"}" >/dev/null
curl -s -c "$JAR" -b "$JAR" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"e2e-pass-1234\"}" >/dev/null
PROJ=$(curl -s -b "$JAR" -X POST "$BASE/api/projects" -H "Content-Type: application/json" -d '{"name":"M16 E2E Edit","description":"engine milestone"}')
PROJECT_ID=$(echo "$PROJ" | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['id'])")
[ -z "$PROJECT_ID" ] && { echo "FATAL: project creation failed: $PROJ"; kill $SERVER_PID; exit 1; }
echo "project $PROJECT_ID"
for f in "$VID" "$IMG" "$AUD"; do
  R=$(curl -s -b "$JAR" -X POST "$BASE/api/media" -H "x-filename: $(basename "$f")" -H "x-role: BROLL" --data-binary @"$f" -H "Content-Type: application/octet-stream")
  ID=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['media']['id'])" 2>/dev/null)
  echo "$(basename "$f") → $ID"
  [ -z "$ID" ] && { echo "FATAL: upload failed: $R"; kill $SERVER_PID; exit 1; }
done
for i in $(seq 1 40); do
  READY=$(curl -s -b "$JAR" "$BASE/api/media/list" | python3 -c "import sys,json;d=json.load(sys.stdin);items=d.get('media') or d.get('assets') or [];print(1 if items and all((m.get('probeStatus') in ('READY','FAILED')) for m in items) else 0)" 2>/dev/null)
  [ "$READY" = "1" ] && break
  sleep 1
done
echo "probes: $READY"

echo "== 4. M15 workspace flow (regression: place → razor → undo → AI studio) =="
export M15_BASE="$BASE" M15_PROJECT="$PROJECT_ID" M15_JAR="$JAR" M15_EMAIL="$EMAIL" M15_SHOTS="$SHOTS" M15_CLIP_NAME="m16-clip.mp4"
bash scripts/e2e-m15-browser.sh > /tmp/m16-m15flow.log 2>&1
EXIT15=$?
tail -6 /tmp/m16-m15flow.log
[ "$EXIT15" = "0" ] || { echo "FATAL: M15 flow regression"; kill $SERVER_PID; exit 1; }

echo "== 5. M16 engine flow (playback/seek/effects/render+FFprobe) =="
export M16_BASE="$BASE" M16_PROJECT="$PROJECT_ID" M16_JAR="$JAR" M16_EMAIL="$EMAIL" M16_SHOTS="$SHOTS"
bash scripts/e2e-m16-browser.sh > /tmp/m16-m16flow.log 2>&1
EXIT16=$?
tail -8 /tmp/m16-m16flow.log
[ "$EXIT16" = "0" ] || { echo "FATAL: M16 engine flow"; kill $SERVER_PID; exit 1; }

echo "== 6. E2E PASS =="
kill $SERVER_PID 2>/dev/null
echo "M16_E2E_COMPLETE"
