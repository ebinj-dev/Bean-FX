#!/usr/bin/env bash
# BEAN FX — M40 §4: visual/functional QA server (isolated) + seed.
#
# Boots the production standalone build on ISOLATED resources (scratch DB +
# scratch media, port 3123) and seeds everything the browser QA pass needs:
#   - an ADMIN user (role flipped via Prisma on the scratch DB only)
#   - a REGULAR user (for the admin-inaccessibility check)
#   - a project with a real 3s media fixture, a sequence, and a COMPLETED
#     ranged batch (mp4 0–30f, mov 60–90f, wav 30–90f) so the storage
#     visibility section and the batch queue have REAL data to render.
#
# Prints SESS_ADMIN / SESS_USER / PROJECT_ID for the agent-browser session.
# KEEP=1 keeps the scratch resources for inspection.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3123}"
BASE="http://127.0.0.1:${PORT}"
SCRATCH_DB="$(mktemp /tmp/beanfx-m40-qa-XXXXXX.db)"
SCRATCH_MEDIA="$(mktemp -d /tmp/beanfx-m40-qa-media-XXXXXX)"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true; sleep 2; kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "${KEEP:-0}" != "1" ]; then
    rm -f "$SCRATCH_DB" "$SCRATCH_DB-shm" "$SCRATCH_DB-wal"; rm -rf "$SCRATCH_MEDIA"
  else
    echo "[m40-qa] KEEP=1 — scratch DB: $SCRATCH_DB media: $SCRATCH_MEDIA"
  fi
}
trap cleanup EXIT
case "$SCRATCH_DB" in *"/db/"*) echo "[m40-qa] refusing dev DB"; exit 2; ;; esac

if [ ! -f .next/BUILD_ID ]; then echo "[m40-qa] FATAL: no .next build — run 'bun run build' first"; exit 3; fi
echo "[m40-qa] applying schema to scratch DB…"
DATABASE_URL="file:$SCRATCH_DB" node_modules/.bin/prisma db push --skip-generate >/dev/null

mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static; cp -r .next/static .next/standalone/.next/static
rm -rf .next/standalone/public; cp -r public .next/standalone/public 2>/dev/null || true

echo "[m40-qa] starting standalone server on :$PORT…"
DATABASE_URL="file:$SCRATCH_DB" BEANFX_DATA_DIR="$SCRATCH_MEDIA" PORT="$PORT" \
  HOSTNAME="127.0.0.1" node .next/standalone/server.js > "/tmp/m40-qa-server-${PORT}.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 90); do
  curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "[m40-qa] FATAL: server died — see /tmp/m40-qa-server-${PORT}.log"; exit 3; }
  sleep 1
done
curl -fsS "$BASE/api/health" >/dev/null 2>&1 || { echo "[m40-qa] FATAL: server not healthy"; exit 3; }

STAMP="$(date +%s)"
ADMIN_EMAIL="m40admin-${STAMP}@test.local"
USER_EMAIL="m40user-${STAMP}@test.local"
PW="m40-qa-pass-99"
CJ=/tmp/m40-qa-admin.cookies; CJU=/tmp/m40-qa-user.cookies
rm -f "$CJ" "$CJU"

echo "[m40-qa] seeding users…"
curl -fsS -c "$CJ" -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PW\",\"name\":\"M40 QA Admin\"}" "$BASE/api/auth/register" >/dev/null
curl -fsS -b "$CJ" -c "$CJ" -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PW\"}" "$BASE/api/auth/login" >/dev/null
curl -fsS -c "$CJU" -H 'Content-Type: application/json' -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$PW\",\"name\":\"M40 QA User\"}" "$BASE/api/auth/register" >/dev/null
curl -fsS -b "$CJU" -c "$CJU" -H 'Content-Type: application/json' -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$PW\"}" "$BASE/api/auth/login" >/dev/null

ADMIN_ID=$(DATABASE_URL="file:$SCRATCH_DB" node -e '
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
p.user.findFirst({ where: { email: { contains: "m40admin" } } })
  .then((u) => p.user.update({ where: { id: u.id }, data: { role: "admin" } }).then((x) => { console.log(x.id); return p.$disconnect(); }))
  .catch((e) => { console.error(e); process.exit(1); });')
echo "[m40-qa] admin role set for $ADMIN_ID"

echo "[m40-qa] seeding project, fixture, sequence…"
PROJ=$(curl -fsS -b "$CJ" -H 'Content-Type: application/json' -d "{\"name\":\"M40 QA Project\"}" "$BASE/api/projects")
PROJECT_ID=$(printf '%s' "$PROJ" | python3 -c "import json,sys; print(json.load(sys.stdin)['project']['id'])")
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=480x270:rate=30:duration=3" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest /tmp/m40-qa-fixture.mp4
ASSET=$(curl -fsS -b "$CJ" -X POST -H "x-filename: main.mp4" -H "x-role: FOOTAGE" -H "Content-Type: application/octet-stream" --data-binary @/tmp/m40-qa-fixture.mp4 "$BASE/api/media")
ASSET_ID=$(printf '%s' "$ASSET" | python3 -c "import json,sys; print(json.load(sys.stdin)['media']['id'])")
EDITS='{"baseVersion":1,"edits":[{"type":"AddTrack","track":{"id":"v1","name":"V1","kind":"VIDEO","visible":true,"muted":false,"solo":false,"locked":false}},{"type":"AddTrack","track":{"id":"a1","name":"A1","kind":"AUDIO","visible":true,"muted":false,"solo":false,"locked":false}},{"type":"AddClip","clip":{"id":"m0","trackId":"v1","sourceAssetId":"ASSET","sourceInFrame":0,"sourceOutFrame":90,"sourceFps":{"num":30,"den":1},"timelineStartFrame":0,"timelineDurationFrames":90,"playbackSpeed":1,"volume":1,"muted":false,"fadeInFrames":0,"fadeOutFrames":0,"transform":{"x":0,"y":0,"scale":1,"rotation":0,"opacity":1},"captionText":null,"captionStyle":null,"graphicTemplateId":null,"graphicStyle":null,"keyframes":[],"missingMedia":false}},{"type":"AddClip","clip":{"id":"a0","trackId":"a1","sourceAssetId":"ASSET","sourceInFrame":0,"sourceOutFrame":90,"sourceFps":{"num":30,"den":1},"timelineStartFrame":0,"timelineDurationFrames":90,"playbackSpeed":1,"volume":1,"muted":false,"fadeInFrames":0,"fadeOutFrames":0,"transform":{"x":0,"y":0,"scale":1,"rotation":0,"opacity":1},"captionText":null,"captionStyle":null,"graphicTemplateId":null,"graphicStyle":null,"keyframes":[],"missingMedia":false}}]}'
printf '%s' "$EDITS" | sed "s|\"ASSET\"|\"$ASSET_ID\"|" > /tmp/m40-qa-edits.json
curl -fsS -b "$CJ" -H 'Content-Type: application/json' --data-binary @/tmp/m40-qa-edits.json "$BASE/api/editor/projects/$PROJECT_ID/timeline" >/dev/null

echo "[m40-qa] enqueueing ranged batch (mp4 0-30, mov 60-90, wav 30-90)…"
curl -fsS -b "$CJ" -H 'Content-Type: application/json' -d '{"items":[{"format":"mp4","startFrame":0,"endFrame":30},{"format":"mov","startFrame":60,"endFrame":90},{"format":"wav","startFrame":30,"endFrame":90}]}' "$BASE/api/editor/projects/$PROJECT_ID/render/batch" >/dev/null
for i in $(seq 1 60); do
  STATE=$(curl -fsS -b "$CJ" "$BASE/api/editor/projects/$PROJECT_ID/render/batch")
  DONE=$(printf '%s' "$STATE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['batch']['batchComplete'])")
  [ "$DONE" = "True" ] && break
  sleep 2
done
printf '%s' "$STATE" | python3 -c "import json,sys; d=json.load(sys.stdin); print('[m40-qa] batch complete:', d['batch'])"

SESS_ADMIN=$(grep beanfx_session "$CJ" | awk '{print $NF}')
SESS_USER=$(grep beanfx_session "$CJU" | awk '{print $NF}')
{
  echo "SESS_ADMIN=$SESS_ADMIN"
  echo "SESS_USER=$SESS_USER"
  echo "PROJECT_ID=$PROJECT_ID"
  echo "ADMIN_EMAIL=$ADMIN_EMAIL"
  echo "USER_EMAIL=$USER_EMAIL"
  echo "BASE=$BASE"
} | tee /tmp/m40-qa-session.env
echo "[m40-qa] READY — server on $BASE (pid $SERVER_PID). Keep this process alive during the browser pass."
wait $SERVER_PID 2>/dev/null || true
