#!/usr/bin/env bash
# BEAN FX — M41: live demo preview server.
#
# Boots the production standalone build bound to 0.0.0.0:3000 (Z.ai preview
# port) on ISOLATED resources (scratch DB + scratch media — never dev/user
# data) and seeds a disposable demonstration project:
#   - user demo@beanfx.local (password printed in /tmp/demo-session.env)
#   - project "BEAN FX Demo" with a REAL 12s media fixture (color bars + tone)
#   - a populated timeline (two clips + audio), saved via the editor API
#   - one completed ranged render (mp4 0–120f) so export history has content
# Prints SESS_DEMO / PROJECT_ID for the browser session. KEEP=1 keeps files.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
BASE="http://127.0.0.1:${PORT}"
SCRATCH_DB="$(mktemp /tmp/beanfx-demo-XXXXXX.db)"
SCRATCH_MEDIA="$(mktemp -d /tmp/beanfx-demo-media-XXXXXX)"
SERVER_PID=""
cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
      kill "$SERVER_PID" 2>/dev/null || true; sleep 2; kill -9 "$SERVER_PID" 2>/dev/null || true
    fi
    rm -f "$SCRATCH_DB" "$SCRATCH_DB-shm" "$SCRATCH_DB-wal"; rm -rf "$SCRATCH_MEDIA"
  else
    echo "[demo] KEEP=1 — scratch DB: $SCRATCH_DB media: $SCRATCH_MEDIA"
  fi
}
trap cleanup EXIT
case "$SCRATCH_DB" in *"/db/"*) echo "[demo] refusing dev DB"; exit 2; ;; esac

if [ ! -f .next/BUILD_ID ]; then echo "[demo] FATAL: no .next build — run 'bun run build' first"; exit 3; fi
echo "[demo] applying schema to scratch DB…"
DATABASE_URL="file:$SCRATCH_DB" node_modules/.bin/prisma db push --skip-generate >/dev/null 2>&1

mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static; cp -r .next/static .next/standalone/.next/static
rm -rf .next/standalone/public; cp -r public .next/standalone/public 2>/dev/null || true

echo "[demo] starting BEAN FX on 0.0.0.0:$PORT (isolated scratch resources)…"
DATABASE_URL="file:$SCRATCH_DB" BEANFX_DATA_DIR="$SCRATCH_MEDIA" PORT="$PORT" \
  HOSTNAME="0.0.0.0" RATE_LIMIT_SCALE="50" node .next/standalone/server.js > "/tmp/beanfx-demo-server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 90); do
  curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "[demo] FATAL: server died — see /tmp/beanfx-demo-server.log"; exit 3; }
  sleep 1
done
curl -fsS "$BASE/api/health" >/dev/null 2>&1 || { echo "[demo] FATAL: server not healthy"; exit 3; }
echo "[demo] server healthy (pid $SERVER_PID)"

STAMP="$(date +%s)"
DEMO_EMAIL="demo-${STAMP}@beanfx.local"
DEMO_PW="demo-pass-99"
CJ=/tmp/beanfx-demo.cookies
rm -f "$CJ"
echo "[demo] seeding demo user + project…"
curl -fsS -c "$CJ" -H 'Content-Type: application/json' -d "{\"email\":\"$DEMO_EMAIL\",\"password\":\"$DEMO_PW\",\"name\":\"Demo Editor\"}" "$BASE/api/auth/register" >/dev/null || { echo "[demo] FATAL: register failed"; exit 3; }
curl -fsS -b "$CJ" -c "$CJ" -H 'Content-Type: application/json' -d "{\"email\":\"$DEMO_EMAIL\",\"password\":\"$DEMO_PW\"}" "$BASE/api/auth/login" >/dev/null

PROJ=$(curl -fsS -b "$CJ" -H 'Content-Type: application/json' -d '{"name":"BEAN FX Demo"}' "$BASE/api/projects")
PROJECT_ID=$(printf '%s' "$PROJ" | python3 -c "import json,sys; print(json.load(sys.stdin)['project']['id'])")

echo "[demo] creating 12s real media fixture (color bars + tone)…"
printf "[0:v]format=yuv420p[v]\n" > /tmp/beanfx-demo-filter.txt
ffmpeg -y -loglevel error \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=12" \
  -f lavfi -i "sine=frequency=330:sample_rate=48000:duration=12" \
  -filter_complex_script /tmp/beanfx-demo-filter.txt \
  -map "[v]" -map 1:a -c:v libx264 -preset veryfast -c:a aac -shortest /tmp/beanfx-demo-media-src.mp4
[ -f /tmp/beanfx-demo-media-src.mp4 ] || { echo "[demo] FATAL: fixture generation failed"; exit 3; }
ASSET=$(curl -fsS -b "$CJ" -X POST -H "x-filename: demo-clip.mp4" -H "x-role: FOOTAGE" -H "Content-Type: application/octet-stream" --data-binary @/tmp/beanfx-demo-media-src.mp4 "$BASE/api/media")
ASSET_ID=$(printf '%s' "$ASSET" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['media']['id'] if isinstance(d,dict) and 'media' in d else d.get('id',''))")
[ -n "$ASSET_ID" ] || { echo "[demo] FATAL: media upload failed: $(printf '%s' "$ASSET" | head -c 120)"; exit 3; }

echo "[demo] building timeline (2 video clips + audio on the default V1/A1 tracks)…"
# The default sequence tracks are <project>-v1 / <project>-a1 — reference the
# real IDs (a batch is atomic: an unknown track id rejects the whole POST).
VTRACK="${PROJECT_ID}-v1"; ATRACK="${PROJECT_ID}-a1"
python3 - "$ASSET_ID" "$VTRACK" "$ATRACK" > /tmp/beanfx-demo-edits.json <<'PYEOF'
import json, sys
A, V, AUD = sys.argv[1:4]
def clip(cid, track, sin, sout, tstart, dur, fadein=0, fadeout=0, vol=1):
    return {"id": cid, "trackId": track, "sourceAssetId": A, "sourceInFrame": sin, "sourceOutFrame": sout,
            "sourceFps": {"num": 30, "den": 1}, "timelineStartFrame": tstart, "timelineDurationFrames": dur,
            "playbackSpeed": 1, "volume": vol, "muted": False, "fadeInFrames": fadein, "fadeOutFrames": fadeout,
            "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1},
            "captionText": None, "captionStyle": None, "graphicTemplateId": None, "graphicStyle": None,
            "keyframes": [], "missingMedia": False}
edits = {"baseVersion": 1, "edits": [
    {"type": "AddClip", "clip": clip("d1", V, 0, 180, 0, 180, fadein=10)},
    {"type": "AddClip", "clip": clip("d2", V, 180, 360, 180, 180, fadeout=10)},
    {"type": "AddClip", "clip": clip("a1c", AUD, 0, 360, 0, 360, vol=0.8)}]}
json.dump(edits, sys.stdout)
PYEOF
R=$(curl -s -w "\n%{http_code}" -b "$CJ" -H 'Content-Type: application/json' --data-binary @/tmp/beanfx-demo-edits.json "$BASE/api/editor/projects/$PROJECT_ID/timeline")
echo "$R" | tail -1 | grep -q 200 || { echo "[demo] FATAL: timeline seed failed: $(printf '%s' "$R" | head -c 200)"; exit 3; }
echo "[demo] timeline saved ($(echo "$R" | tail -1))"

echo "[demo] enqueueing a ranged render (mp4 frames 0–120)…"
curl -fsS -b "$CJ" -H 'Content-Type: application/json' -d '{"items":[{"format":"mp4","startFrame":0,"endFrame":120}]}' "$BASE/api/editor/projects/$PROJECT_ID/render/batch" >/dev/null 2>&1 || echo "[demo] render enqueue failed (non-fatal for preview)"

SESS_DEMO=$(grep beanfx_session "$CJ" | awk '{print $NF}')
{
  echo "SESS_DEMO=$SESS_DEMO"
  echo "PROJECT_ID=$PROJECT_ID"
  echo "DEMO_EMAIL=$DEMO_EMAIL"
  echo "BASE=$BASE"
} | tee /tmp/demo-session.env
echo "[demo] READY — BEAN FX live on $BASE (bound 0.0.0.0:$PORT). Server stays up."
wait $SERVER_PID 2>/dev/null || true
