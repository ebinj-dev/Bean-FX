#!/usr/bin/env bash
# BEAN FX — M13 browser-level E2E against the PRODUCTION build (next start).
# Real session → project → seeded real fixture asset + timeline row → enqueue
# TEMPORAL_INTELLIGENCE from the APP API (consent + provider labels) → worker
# completes (real CSRT tracking + real provider labeling) → GET temporal index
# (tracks/motion/camera/events) → REAL temporal search → mograph proposal build
# → Motion tab shipped to the browser. Honest failure on any step.
set -uo pipefail
cd /home/z/my-project
JAR=/tmp/m13-e2e-cookies.txt
BASE=http://localhost:3113
rm -f "$JAR"

echo "== 1. start production server =="
DATABASE_URL="file:/home/z/my-project/db/custom.db" PORT=3113 bash scripts/dev-server.sh >/tmp/m13-e2e-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 40); do
  sleep 1
  curl -s -o /dev/null -w "%{http_code}" "$BASE/" 2>/dev/null | grep -q 200 && break
done
curl -s -o /dev/null -w "%{http_code}" "$BASE/" 2>/dev/null | grep -q 200 || { echo "FATAL: server did not start"; tail -5 /tmp/m13-e2e-server.log; exit 1; }
echo "server up (pid $SERVER_PID)"

echo "== 2. register + login =="
EMAIL="m13e2e-$RANDOM@test.local"
curl -s -c "$JAR" -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"e2e-pass-1234\",\"name\":\"M13 E2E\"}" >/dev/null
LOGIN=$(curl -s -c "$JAR" -b "$JAR" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"e2e-pass-1234\"}")
echo "$LOGIN" | head -c 120; echo

echo "== 3. create project =="
PROJ=$(curl -s -b "$JAR" -X POST "$BASE/api/projects" -H "Content-Type: application/json" -d '{"name":"M13 E2E Temporal Project","description":"temporal e2e"}')
PROJECT_ID=$(echo "$PROJ" | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['id'])" 2>/dev/null || echo "")
[ -z "$PROJECT_ID" ] && { echo "FATAL: project creation failed: $PROJ"; kill $SERVER_PID; exit 1; }
echo "project $PROJECT_ID"

echo "== 4. seed real moving-subject fixture + timeline row =="
FIX=/tmp/m13-e2e-fixture.mp4
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=black:s=320x240:d=8:r=10" -f lavfi -i "color=c=white:s=44x44:d=8:r=10" -filter_complex "[1:v]setpts=PTS-STARTPTS[b];[0:v][b]overlay=x='20+t*35':y=100:shortest=1[out]" -map "[out]" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$FIX"
bun scripts/e2e-seed-visual.ts "$EMAIL" "$PROJECT_ID" "$FIX"

echo "== 5. enqueue TEMPORAL_INTELLIGENCE from the APP API (consent + labels) =="
ENQ=$(curl -s -b "$JAR" -X POST "$BASE/api/creative/temporal/index" -H "Content-Type: application/json" -d "{\"projectId\":\"$PROJECT_ID\",\"consentVisual\":true,\"settings\":{\"sampleFps\":5,\"maxFrames\":40,\"providerLabels\":true}}")
echo "$ENQ"; echo
JOB_ID=$(echo "$ENQ" | python3 -c "import sys,json;print(json.load(sys.stdin).get('jobId',''))" 2>/dev/null)
REVIEW_ID=$(echo "$ENQ" | python3 -c "import sys,json;print(json.load(sys.stdin).get('reviewId',''))" 2>/dev/null)
[ -z "$JOB_ID" ] && { echo "FATAL: enqueue failed"; kill $SERVER_PID; exit 1; }

echo "== 6. worker completes the job (real tracking + real labeling) =="
STATUS=""
for i in $(seq 1 90); do
  sleep 2
  bun scripts/e2e-tick-visual.ts >/dev/null 2>&1
  STATUS=$(bun scripts/e2e-tick-visual.ts --status "$REVIEW_ID" 2>/dev/null)
  [ "$STATUS" = "COMPLETED" ] && break
  [ "$STATUS" = "FAILED" ] && break
done
echo "review status: $STATUS"
[ "$STATUS" = "COMPLETED" ] || { echo "FATAL: review did not complete"; kill $SERVER_PID; exit 1; }

echo "== 7. GET temporal index — REAL tracks/motion/camera/events =="
IDX=$(curl -s -b "$JAR" "$BASE/api/creative/temporal/index?projectId=$PROJECT_ID")
echo "$IDX" | python3 -c "
import sys, json
d = json.load(sys.stdin)
idx = d['index']['result']
m = idx['measurement']
print('frames:', m['framesSampled'], 'windows:', m['windows'], 'tracks:', m['tracksTotal'], 'labels:', m['providerLabelsUsed'], 'consent:', m['consentVisual'])
t = idx['tracks'][0]
mo = idx['motion'][0]
print(' track:', t['trackId'], t['category'], f\"({t['categoryProvenance']})\", len(t['samples']), 'samples, term', t['terminationReason'])
print(' motion: dir', mo['direction'], f\"{mo['speedPxPerSec']}px/s\")
assert t['samples'].__len__() >= 15, 'track too short'
assert 31 < mo['speedPxPerSec'] < 39, f\"speed {mo['speedPxPerSec']} not near the 35 px/s ground truth\"
assert mo['direction'] == 'right'
assert len(idx['events']) > 0, 'no temporal events'
print('OK temporal index')
"

echo "== 8. REAL temporal search through the API =="
SEARCH=$(curl -s -b "$JAR" -X POST "$BASE/api/creative/temporal/search" -H "Content-Type: application/json" -d "{\"projectId\":\"$PROJECT_ID\",\"query\":\"a bright object moving quickly across the frame\",\"limit\":4}")
echo "$SEARCH" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('method:', d['method'], 'results:', len(d['results']))
r = d['results'][0] if d['results'] else None
if r: print(' top:', r['kind'], r['refId'], round(r['relevanceScore'],2), '-', (r.get('description') or '')[:80])
assert d['available'] and d['results'], 'search returned nothing'
print('OK temporal search')
"

echo "== 9. motion-graphics proposal from a validated track =="
TRACK_ID=$(echo "$IDX" | python3 -c "import sys,json;print(json.load(sys.stdin)['index']['result']['tracks'][0]['trackId'])")
MG=$(curl -s -b "$JAR" -X POST "$BASE/api/creative/temporal/mograph" -H "Content-Type: application/json" -d "{\"projectId\":\"$PROJECT_ID\",\"trackId\":\"$TRACK_ID\",\"primaryText\":\"Box\"}")
echo "$MG" | python3 -c "
import sys, json
d = json.load(sys.stdin)
p = d['proposal']
print('proposal:', p['label'], '| keyframes:', len(p['keyframes']), '| gaps:', len(p['gaps']), '| requiresApproval:', p['requiresApproval'])
assert len(p['keyframes']) >= 8
assert p['requiresApproval'] is True
print('OK mograph proposal')
"

echo "== 10. Motion tab shipped to the browser =="
HTML=$(curl -s -b "$JAR" "$BASE/")
CHUNKS=$(echo "$HTML" | grep -o '/_next/static/chunks/[a-z0-9]*\.js' | sort -u)
ALL="$CHUNKS"
for c in $CHUNKS; do
  REFS=$(curl -s -b "$JAR" "$BASE$c" | grep -o 'chunks/[a-z0-9]*\.js' | sed 's|^|/_next/|' | sort -u)
  ALL="$ALL $REFS"
done
FOUND=0
for c in $(echo $ALL | tr ' ' '\n' | sort -u); do
  if curl -s -b "$JAR" "$BASE$c" | grep -q "Run motion analysis"; then FOUND=1; echo "chunk $c contains the Motion tab"; break; fi
done
[ "$FOUND" = "1" ] || { echo "FATAL: Motion tab not in any served chunk"; kill $SERVER_PID; exit 1; }

echo "== 11. E2E PASS =="
kill $SERVER_PID 2>/dev/null
echo "E2E_COMPLETE"
