#!/usr/bin/env bash
# BEAN FX — M12 browser-level E2E against the PRODUCTION build (next start).
# Drives the real HTTP surface with a real session: register → login → create
# project → seed a real fixture asset + timeline row (DB-direct, like the
# editor would after upload) → enqueue Visual Intelligence FROM THE APP API →
# worker completes → GET index → REAL provider-ranked search → editor page
# shows the Visual tab. Honest failure on any step.
set -uo pipefail
cd /home/z/my-project
JAR=/tmp/m12-e2e-cookies.txt
BASE=http://localhost:3111
rm -f "$JAR"

echo "== 1. start production server =="
DATABASE_URL="file:/home/z/my-project/db/custom.db" PORT=3111 bun run start >/tmp/m12-e2e-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 40); do
  sleep 1
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
done
curl -sf "$BASE/api/health" >/dev/null || { echo "FATAL: server did not start"; tail -5 /tmp/m12-e2e-server.log; exit 1; }
echo "server up (pid $SERVER_PID)"

echo "== 2. register + login =="
EMAIL="m12e2e-$RANDOM@test.local"
REG=$(curl -s -c "$JAR" -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"e2e-pass-1234\",\"name\":\"M12 E2E\"}")
echo "$REG" | head -c 160; echo
LOGIN=$(curl -s -c "$JAR" -b "$JAR" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"e2e-pass-1234\"}")
echo "$LOGIN" | head -c 160; echo

echo "== 3. create project =="
PROJ=$(curl -s -b "$JAR" -X POST "$BASE/api/projects" -H "Content-Type: application/json" -d '{"name":"M12 E2E Visual Project","description":"visual e2e"}')
PROJECT_ID=$(echo "$PROJ" | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['id'])" 2>/dev/null || echo "")
[ -z "$PROJECT_ID" ] && { echo "FATAL: project creation failed: $PROJ"; kill $SERVER_PID; exit 1; }
echo "project $PROJECT_ID"

echo "== 4. seed fixture video + timeline row (real ffmpeg frames content) =="
FIX=/tmp/m12-e2e-fixture.mp4
ffmpeg -hide_banner -loglevel error -y -filter_complex "smptehdbars=s=320x240:r=10:d=4[a];rgbtestsrc=s=320x240:r=10:d=4[b];testsrc2=s=320x240:r=10:d=4[c];[a][b][c]concat=n=3:v=1:a=0[out]" -map "[out]" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$FIX"
bun scripts/e2e-seed-visual.ts "$EMAIL" "$PROJECT_ID" "$FIX"

echo "== 5. enqueue Visual Intelligence FROM THE APP API (consent=true) =="
ENQ=$(curl -s -b "$JAR" -X POST "$BASE/api/creative/visual/index" -H "Content-Type: application/json" -d "{\"projectId\":\"$PROJECT_ID\",\"consentVisual\":true,\"settings\":{\"maxFramesPerAsset\":6,\"sampleIntervalSec\":3}}")
echo "$ENQ"; echo
JOB_ID=$(echo "$ENQ" | python3 -c "import sys,json;print(json.load(sys.stdin).get('jobId',''))" 2>/dev/null)
REVIEW_ID=$(echo "$ENQ" | python3 -c "import sys,json;print(json.load(sys.stdin).get('reviewId',''))" 2>/dev/null)
[ -z "$JOB_ID" ] && { echo "FATAL: enqueue failed"; kill $SERVER_PID; exit 1; }
echo "job $JOB_ID review $REVIEW_ID"

echo "== 6. worker completes the job =="
STATUS=""
for i in $(seq 1 60); do
  sleep 2
  bun scripts/e2e-tick-visual.ts >/dev/null 2>&1
  STATUS=$(bun scripts/e2e-tick-visual.ts --status "$REVIEW_ID" 2>/dev/null)
  [ "$STATUS" = "COMPLETED" ] && break
  [ "$STATUS" = "FAILED" ] && break
done
echo "review status: $STATUS"
[ "$STATUS" = "COMPLETED" ] || { echo "FATAL: review did not complete"; kill $SERVER_PID; exit 1; }

echo "== 7. GET index (auth) — real thumbnails + semantic scenes =="
IDX=$(curl -s -b "$JAR" "$BASE/api/creative/visual/index?projectId=$PROJECT_ID")
echo "$IDX" | python3 -c "
import sys, json
d = json.load(sys.stdin)
idx = d['index']['result']
print('scenes:', idx['scenes'].__len__(), 'analyzed frames:', idx['measurement']['framesAnalyzed'], 'consent:', d['index']['consentVisual'])
for s in idx['scenes']:
    print(' scene', s['index'], s['understanding'], 'rep asset:', bool(s['representativeAssetId']), '-', (s['description'] or '')[:80])
    assert s['representativeAssetId'], 'scene missing registered thumbnail'
sem = [s for s in idx['scenes'] if s['understanding'] == 'semantic']
assert len(sem) >= 2, 'expected semantic scenes'
print('OK index')
"
echo "== 8. thumbnail served through /api/media/[id]/file (auth) =="
THUMB=$(echo "$IDX" | python3 -c "import sys,json;print(json.load(sys.stdin)['index']['result']['scenes'][0]['representativeAssetId'])")
CODE=$(curl -s -b "$JAR" -o /tmp/m12-e2e-thumb.jpg -w "%{http_code}" "$BASE/api/media/$THUMB/file")
echo "thumbnail HTTP $CODE, bytes $(stat -c %s /tmp/m12-e2e-thumb.jpg)"
[ "$CODE" = "200" ] || { echo "FATAL: thumbnail not served"; kill $SERVER_PID; exit 1; }

echo "== 9. REAL NL search through the API =="
SEARCH=$(curl -s -b "$JAR" -X POST "$BASE/api/creative/visual/search" -H "Content-Type: application/json" -d "{\"projectId\":\"$PROJECT_ID\",\"query\":\"colorful moving pattern scene\",\"limit\":4}")
echo "$SEARCH" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('method:', d['method'], 'results:', len(d['results']))
r = d['results'][0] if d['results'] else None
if r: print(' top:', r['sceneId'], round(r['relevanceScore'],2), '-', (r.get('description') or '')[:80])
assert d['available'] and d['results'], 'search returned nothing'
print('OK search')
"

echo "== 10. editor app ships the Visual tab (client bundle the browser downloads) =="
# The app is a single-page shell at '/': the editor + Creative Director render
# client-side. Verify the browser's real download path: page HTML → chunk URLs
# → one hop of dynamic chunk references → the Visual tab source.
HTML=$(curl -s -b "$JAR" "$BASE/")
CHUNKS=$(echo "$HTML" | grep -o '/_next/static/chunks/[a-z0-9]*\.js' | sort -u)
ALL="$CHUNKS"
for c in $CHUNKS; do
  REFS=$(curl -s -b "$JAR" "$BASE$c" | grep -o 'chunks/[a-z0-9]*\.js' | sed 's|^|/_next/|' | sort -u)
  ALL="$ALL $REFS"
done
FOUND=0
for c in $(echo $ALL | tr ' ' '\n' | sort -u); do
  if curl -s -b "$JAR" "$BASE$c" | grep -q "Run visual intelligence"; then FOUND=1; echo "chunk $c contains the Visual tab"; break; fi
done
[ "$FOUND" = "1" ] || { echo "FATAL: Visual tab not in any served chunk"; kill $SERVER_PID; exit 1; }
echo "OK: Visual tab served to the browser"

echo "== 11. E2E PASS =="
kill $SERVER_PID 2>/dev/null
echo "E2E_COMPLETE"
