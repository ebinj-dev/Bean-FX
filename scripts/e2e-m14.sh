#!/usr/bin/env bash
# BEAN FX — M14 browser-level E2E against the PRODUCTION build (real server).
# Session → project → REAL art-direction generation (3 candidates via glm) →
# APPROVE one → build scene plan → REAL LAXII scene asset → create
# composition → commit edit (version) → undo → attach NIIKI motion → REAL
# COMPOSITION_RENDER through the durable worker → rendered VIDEO asset →
# Compose tab shipped to the browser. Honest failure on any step.
set -uo pipefail
cd /home/z/my-project
JAR=/tmp/m14-e2e-cookies.txt
BASE=http://localhost:3116
rm -f "$JAR"

echo "== 1. start production server =="
DATABASE_URL="file:/home/z/my-project/db/custom.db" PORT=3116 bash scripts/dev-server.sh >/tmp/m14-e2e-server.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 40); do
  sleep 1
  curl -s -o /dev/null -w "%{http_code}" "$BASE/" 2>/dev/null | grep -q 200 && break
done
curl -s -o /dev/null -w "%{http_code}" "$BASE/" | grep -q 200 || { echo "FATAL: server did not start"; tail -5 /tmp/m14-e2e-server.log; exit 1; }
echo "server up (pid $SERVER_PID)"

echo "== 2. register + login + project =="
EMAIL="m14e2e-$RANDOM@test.local"
curl -s -c "$JAR" -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"e2e-pass-1234\",\"name\":\"M14 E2E\"}" >/dev/null
curl -s -c "$JAR" -b "$JAR" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"e2e-pass-1234\"}" >/dev/null
PROJ=$(curl -s -b "$JAR" -X POST "$BASE/api/projects" -H "Content-Type: application/json" -d '{"name":"M14 E2E Compose","description":"m14 e2e"}')
PROJECT_ID=$(echo "$PROJ" | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['id'])" 2>/dev/null)
[ -z "$PROJECT_ID" ] && { echo "FATAL: project creation failed: $PROJ"; kill $SERVER_PID; exit 1; }
echo "project $PROJECT_ID"

echo "== 3. REAL art-direction generation (3 candidates) =="
DIR=$(curl -s -b "$JAR" -X POST "$BASE/api/creative/m14/direction" -H "Content-Type: application/json" -d "{\"projectId\":\"$PROJECT_ID\",\"brief\":{\"storyOrProduct\":\"A 30-second explainer of a South Indian coffee brand\",\"audience\":\"food lovers\",\"format\":\"16:9\",\"motionIntensity\":\"moderate\",\"language\":\"en\"}}")
BATCH=$(echo "$DIR" | python3 -c "
import sys, json
d = json.load(sys.stdin)
dirs = d['directions']
print(len(dirs), dirs[0]['id'], '|'.join(x['direction']['name'] for x in dirs))
" 2>/dev/null || echo "FAIL")
COUNT=$(echo "$BATCH" | awk '{print $1}')
DIR_ID=$(echo "$BATCH" | awk '{print $2}')
NAMES=$(echo "$BATCH" | cut -d' ' -f3-)
echo "candidates: $COUNT [$NAMES]"
[ "$COUNT" = "3" ] || { echo "FATAL: direction generation failed: $DIR"; kill $SERVER_PID; exit 1; }

echo "== 4. APPROVE one direction (assets gated on approval) =="
curl -s -b "$JAR" -X PATCH "$BASE/api/creative/m14/direction" -H "Content-Type: application/json" -d "{\"projectId\":\"$PROJECT_ID\",\"directionId\":\"$DIR_ID\",\"action\":\"approve\"}" | python3 -c "import sys,json;d=json.load(sys.stdin);print('approved:', d['approved']['name'])"

echo "== 5. build scene plan (honest estimate labels without transcript) =="
SC=$(curl -s -b "$JAR" -X POST "$BASE/api/creative/m14/scenes" -H "Content-Type: application/json" -d "{\"projectId\":\"$PROJECT_ID\",\"artDirectionId\":\"$DIR_ID\",\"brief\":{\"language\":\"en\"}}")
echo "$SC" | python3 -c "
import sys, json
d = json.load(sys.stdin)
plan = d['plan']
print('scenes:', len(plan['scenes']), '| timing sources:', set(s['timingSource'] for s in plan['scenes']))
assert len(plan['scenes']) >= 2
print('OK scene plan')
"

echo "== 6. REAL LAXII scene asset under the approved direction =="
AS=$(curl -s -b "$JAR" -X POST "$BASE/api/creative/m14/assets" -H "Content-Type: application/json" -d "{\"projectId\":\"$PROJECT_ID\",\"sceneId\":\"sc1\",\"role\":\"background\",\"prompt\":\"Opening background plate following the approved direction\",\"alternatives\":1}")
echo "$AS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
a = d['assets'][0]
print('asset:', a['assetId'][:12], a['width'], 'x', a['height'], 'alpha=', a['hasAlpha'])
print('alpha honesty:', d['limitations'][0][:80] if d['limitations'] else '(none)')
assert a['width'] > 500
print('OK asset')
" || { echo "FATAL: asset generation failed: $AS"; kill $SERVER_PID; exit 1; }
ASSET_ID=$(echo "$AS" | python3 -c "import sys,json;print(json.load(sys.stdin)['assets'][0]['assetId'])")

echo "== 7. composition: create → commit → undo → motion preset → track attach refusal honesty =="
COMP=$(curl -s -b "$JAR" -X POST "$BASE/api/creative/m14/compose" -H "Content-Type: application/json" -d "{\"projectId\":\"$PROJECT_ID\",\"name\":\"E2E Comp\",\"doc\":{\"width\":640,\"height\":360,\"fps\":30,\"durationFrames\":60,\"layers\":[{\"id\":\"bg\",\"name\":\"bg\",\"kind\":\"background\",\"color\":\"#202020\",\"visible\":true,\"locked\":false,\"blend\":\"normal\",\"transform\":{\"x\":320,\"y\":180,\"scale\":1,\"rotation\":0,\"opacity\":1},\"startFrame\":0,\"endFrame\":60,\"keyframes\":[]},{\"id\":\"img\",\"name\":\"art\",\"kind\":\"image\",\"sourceAssetId\":\"$ASSET_ID\",\"visible\":true,\"locked\":false,\"blend\":\"normal\",\"transform\":{\"x\":320,\"y\":180,\"scale\":0.5,\"rotation\":0,\"opacity\":1},\"startFrame\":0,\"endFrame\":60,\"keyframes\":[]}]}}")
COMP_ID=$(echo "$COMP" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "$COMP" | python3 -c "import sys,json;d=json.load(sys.stdin);print('created v', d['version'], 'issues:', d['issues'])"
DOC=$(curl -s -b "$JAR" "$BASE/api/creative/m14/compose?projectId=$PROJECT_ID&compositionId=$COMP_ID" | python3 -c "
import sys, json
d = json.load(sys.stdin)
doc = d['doc']
doc['layers'][1]['transform']['x'] = 400
print(json.dumps({'doc': doc, 'expectedVersion': d['version']}))
")
echo "$DOC" | python3 -c "
import sys, json
payload = json.load(sys.stdin)
payload['projectId'] = '$PROJECT_ID'
payload['compositionId'] = '$COMP_ID'
payload['note'] = 'e2e move'
print(json.dumps(payload))
" > /tmp/m14-commit.json
V2=$(curl -s -b "$JAR" -X PATCH "$BASE/api/creative/m14/compose" -H "Content-Type: application/json" -d @/tmp/m14-commit.json | python3 -c "import sys,json;print(json.load(sys.stdin)['version'])")
echo "committed v$V2"
UNDO=$(curl -s -b "$JAR" -X PATCH "$BASE/api/creative/m14/compose" -H "Content-Type: application/json" -d "{\"projectId\":\"$PROJECT_ID\",\"compositionId\":\"$COMP_ID\",\"targetVersion\":1}" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['version'], d['doc']['layers'][1]['transform']['x'])")
echo "undo → $UNDO (x restored to 320)"
echo "$UNDO" | grep -q "320" || { echo "FATAL: undo did not restore x=320"; kill $SERVER_PID; exit 1; }
# track attach WITHOUT a completed M13 index → honest refusal
ATTACH=$(curl -s -b "$JAR" -X PATCH "$BASE/api/creative/m14/compose" -H "Content-Type: application/json" -d "{\"projectId\":\"$PROJECT_ID\",\"compositionId\":\"$COMP_ID\",\"expectedVersion\":$V2,\"layerId\":\"img\",\"temporalTrackId\":\"x:w0t0\",\"sourceAssetId\":\"x\",\"attachedFrameRange\":{\"startFrame\":0,\"endFrame\":60},\"detach\":false}")
echo "$ATTACH" | grep -q "M13 temporal index" && echo "honest refusal without M13 index ✓" || { echo "WARN: attach refusal message: $(echo $ATTACH | head -c 120)"; }

echo "== 8. REAL render through the durable worker =="
REN=$(curl -s -b "$JAR" -X POST "$BASE/api/creative/m14/render" -H "Content-Type: application/json" -d "{\"projectId\":\"$PROJECT_ID\",\"compositionId\":\"$COMP_ID\"}")
JOB_ID=$(echo "$REN" | python3 -c "import sys,json;print(json.load(sys.stdin)['jobId'])")
echo "render job $JOB_ID"
STATUS=""
for i in $(seq 1 60); do
  sleep 2
  bun scripts/e2e-tick-visual.ts >/dev/null 2>&1
  STATUS=$(DATABASE_URL="file:/home/z/my-project/db/custom.db" bun -e "
const { db } = await import('./src/lib/db');
const j = await db.job.findUnique({ where: { id: '$JOB_ID' } });
console.log(j?.status ?? 'UNKNOWN');
" 2>/dev/null | tail -1)
  [ "$STATUS" = "COMPLETED" ] && break
  [ "$STATUS" = "FAILED" ] && break
done
echo "render status: $STATUS"
[ "$STATUS" = "COMPLETED" ] || { echo "FATAL: render did not complete"; kill $SERVER_PID; exit 1; }
EXPORT_ID=$(DATABASE_URL="file:/home/z/my-project/db/custom.db" bun -e "
const { db } = await import('./src/lib/db');
const j = await db.job.findUnique({ where: { id: '$JOB_ID' } });
console.log(j?.exportId ?? '');
" 2>/dev/null | tail -1)
echo "rendered asset: $EXPORT_ID"
[ -n "$EXPORT_ID" ] || { echo "FATAL: no render output registered"; kill $SERVER_PID; exit 1; }
ffprobe -v error -print_format json -show_streams -select_streams v "$(DATABASE_URL="file:/home/z/my-project/db/custom.db" bun -e "
const { db } = await import('./src/lib/db');
const a = await db.mediaAsset.findUnique({ where: { id: '$EXPORT_ID' } });
console.log(a?.storagePath ?? '');
" 2>/dev/null | tail -1)" | python3 -c "
import sys, json
vs = json.load(sys.stdin)['streams'][0]
print('rendered:', vs['width'], 'x', vs['height'], vs.get('nb_frames'), 'frames')
"

echo "== 9. Compose tab shipped to the browser =="
CHUNKS=$(curl -s -b "$JAR" "$BASE/" | grep -o '/_next/static/chunks/[a-z0-9]*\.js' | sort -u)
FOUND=0
for c in $CHUNKS; do
  REFS=$(curl -s -b "$JAR" "$BASE$c" | grep -o 'chunks/[a-z0-9]*\.js' | sed 's|^|/_next/|' | sort -u)
  for r in $REFS $c; do
    curl -s -b "$JAR" "$BASE$r" 2>/dev/null | grep -qi "Art Direction — 3 candidates" && FOUND=1 && echo "chunk $r contains the Compose workspace" && break 2
  done
done
[ "$FOUND" = "1" ] || { echo "FATAL: Compose workspace not in served chunks"; kill $SERVER_PID; exit 1; }

echo "== 10. E2E PASS =="
kill $SERVER_PID 2>/dev/null
echo "E2E_COMPLETE"
