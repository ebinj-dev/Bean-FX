#!/usr/bin/env bash
# M17 Phase F — long-form render validation (REAL renders, REAL validation).
# Builds 10s / 1m / 5m / 10m multitrack sequences (real generated media,
# synthetic arrangement — reported as fixtures), enqueues durable
# RENDER_TIMELINE jobs, polls to completion, downloads and validates each
# output with FFprobe. Reports render wall time, size, streams, duration.
# Also verifies job CANCELLATION on a queued/processing render.
set -uo pipefail
cd /home/z/my-project
JAR=/tmp/m17-render-cookies.txt
BASE=http://localhost:3117
rm -f "$JAR"

VID=/tmp/m17-bench.mp4
[ -f "$VID" ] || ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=640x360:rate=30:duration=4" -f lavfi -i "sine=frequency=440:duration=4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$VID"

PID_ON_PORT=$(ss -tlnp 2>/dev/null | grep -E ':3117 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
[ -n "$PID_ON_PORT" ] && kill "$PID_ON_PORT" && sleep 2
DATABASE_URL="file:/home/z/my-project/db/custom.db" PORT=3117 bash scripts/dev-server.sh >/tmp/m17-render-server.log 2>&1 &
for i in $(seq 1 40); do sleep 1; curl -s -o /dev/null -w "%{http_code}" "$BASE/" 2>/dev/null | grep -q 200 && break; done
curl -s -o /dev/null -w "%{http_code}" "$BASE/" | grep -q 200 || { echo "FATAL: server"; exit 1; }
echo "server up"

EMAIL="m17render-$RANDOM@test.local"
curl -s -c "$JAR" -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"render-pass-1234\",\"name\":\"M17 Render\"}" >/dev/null
MEDIA_ID=$(curl -s -b "$JAR" -X POST "$BASE/api/media" -H "x-filename: m17-bench.mp4" -H "x-role: BROLL" --data-binary @"$VID" -H "Content-Type: application/octet-stream" | python3 -c "import sys,json;print(json.load(sys.stdin)['media']['id'])")
sleep 4

build_project() {
  local SECONDS_LEN="$1"
  local PROJ=$(curl -s -b "$JAR" -X POST "$BASE/api/projects" -H "Content-Type: application/json" -d "{\"name\":\"M17 Render ${SECONDS_LEN}s\",\"description\":\"long-form render fixture\"}")
  echo "$PROJ" | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['id'])"
}
save_sequence() {
  local PROJECT="$1"; local SECONDS_LEN="$2"
  COOKIE=$(grep beanfx_session "$JAR" | awk '{print "beanfx_session=" $NF}')
  OUT=$(python3 scripts/m17-build-sequence.py "$SECONDS_LEN" "$MEDIA_ID" "$PROJECT" "$COOKIE" "$BASE")
  echo "$OUT" | grep -q SAVED || echo "[${SECONDS}s] SAVE FAILED: $OUT"
}

mkdir -p /home/z/my-project/download/m17-render-logs
for SEC in 10 60 300 600; do
  PROJECT=$(build_project "$SEC")
  save_sequence "$PROJECT" "$SEC"
  T0=$(date +%s%3N)
  JOB=$(curl -s -b "$JAR" -X POST "$BASE/api/editor/projects/$PROJECT/render" -H "Content-Type: application/json" -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('jobId',''))")
  STATUS=""
  for i in $(seq 1 150); do
    sleep 2
    STATUS=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJECT/render" | python3 -c "
import sys, json
d = json.load(sys.stdin)
jobs = d.get('jobs') or []
print(jobs[0]['status'] if jobs else 'UNKNOWN')" 2>/dev/null)
    [ "$STATUS" = "COMPLETED" ] && break
    [ "$STATUS" = "FAILED" ] && break
  done
  T1=$(date +%s%3N)
  WALL=$((T1 - T0))
  EXPORT_ID=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJECT/render" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ex = d.get('exports') or []
print(ex[0]['id'] if ex else '')" 2>/dev/null)
  if [ -n "$EXPORT_ID" ]; then
    curl -s -b "$JAR" -o /tmp/m17-render-$SEC.mp4 "$BASE/api/exports/$EXPORT_ID/file"
    PROBE=$(ffprobe -v error -print_format json -show_streams -show_format /tmp/m17-render-$SEC.mp4 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
v = [s for s in d['streams'] if s['codec_type'] == 'video']
a = [s for s in d['streams'] if s['codec_type'] == 'audio']
size = $(stat -c%s /tmp/m17-render-$SEC.mp4 2>/dev/null || echo 0)
print(f\"video={len(v)} audio={len(a)} dur={float(d['format']['duration']):.2f}s size={size/1048576:.2f}MB fps={v[0].get('r_frame_rate','?') if v else '?'} vcodec={v[0].get('codec_name','?') if v else '?'} acodec={a[0].get('codec_name','?') if a else '?'}\")" 2>/dev/null)
    echo "[${SEC}s] wall=${WALL}ms status=$STATUS ffprobe: $PROBE"
  else
    MSG=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJECT/render" | python3 -c "
import sys, json
d = json.load(sys.stdin)
jobs = d.get('jobs') or []
print((jobs[0].get('message') or jobs[0].get('stage') or 'no message')[:200] if jobs else 'no job')" 2>/dev/null)
    echo "[${SEC}s] wall=${WALL}ms status=$STATUS FAILED: $MSG"
  fi
  echo "{\"seconds\": $SEC, \"wallMs\": $WALL, \"status\": \"$STATUS\", \"exportId\": \"$EXPORT_ID\"}" >> /home/z/my-project/download/m17-render-logs/summary.jsonl
done

# Cancellation: enqueue a long render and cancel it.
PROJECT=$(build_project 600)
save_sequence "$PROJECT" 600
JOB=$(curl -s -b "$JAR" -X POST "$BASE/api/editor/projects/$PROJECT/render" -H "Content-Type: application/json" -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('jobId',''))")
sleep 3
C=$(curl -s -b "$JAR" -X DELETE "$BASE/api/jobs/$JOB" | head -c 120)
sleep 3
FINAL=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJECT/render" | python3 -c "
import sys, json
d = json.load(sys.stdin)
jobs = d.get('jobs') or []
print(jobs[0]['status'] if jobs else 'UNKNOWN')" 2>/dev/null)
echo "[cancel] job=$JOB cancel-response=$C final-status=$FINAL"

PID_ON_PORT=$(ss -tlnp 2>/dev/null | grep -E ':3117 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
[ -n "$PID_ON_PORT" ] && kill "$PID_ON_PORT"
echo "M17_RENDER_VALIDATION_COMPLETE"
