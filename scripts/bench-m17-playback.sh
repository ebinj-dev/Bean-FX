#!/usr/bin/env bash
# M17 Phase B — long-form playback benchmarks (FIXTURE-BASED, synthetic).
# Builds 5/10/20-minute sequences via the API from real generated media,
# then measures in a real browser: startup latency, seek latency,
# playback FPS/dropped frames (controller telemetry), memory growth.
# These are synthetic benchmarks — reported as such, never as user-project results.
set -uo pipefail
cd /home/z/my-project
JAR=/tmp/m17-bench-cookies.txt
BASE=http://localhost:3117
rm -f "$JAR"

VID=/tmp/m17-bench.mp4
[ -f "$VID" ] || ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=640x360:rate=30:duration=4" -f lavfi -i "sine=frequency=440:duration=4" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$VID"

PID_ON_PORT=$(ss -tlnp 2>/dev/null | grep -E ':3117 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
[ -n "$PID_ON_PORT" ] && kill "$PID_ON_PORT" && sleep 2
DATABASE_URL="file:/home/z/my-project/db/custom.db" PORT=3117 bash scripts/dev-server.sh >/tmp/m17-bench-server.log 2>&1 &
for i in $(seq 1 40); do sleep 1; curl -s -o /dev/null -w "%{http_code}" "$BASE/" 2>/dev/null | grep -q 200 && break; done
curl -s -o /dev/null -w "%{http_code}" "$BASE/" | grep -q 200 || { echo "FATAL: server"; exit 1; }
echo "server up"

EMAIL="m17bench-$RANDOM@test.local"
curl -s -c "$JAR" -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"bench-pass-1234\",\"name\":\"M17 Bench\"}" >/dev/null
PROJ=$(curl -s -b "$JAR" -X POST "$BASE/api/projects" -H "Content-Type: application/json" -d '{"name":"M17 Playback Bench","description":"synthetic long-form fixture"}')
PROJECT_ID=$(echo "$PROJ" | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['id'])")
MEDIA_ID=$(curl -s -b "$JAR" -X POST "$BASE/api/media" -H "x-filename: m17-bench.mp4" -H "x-role: BROLL" --data-binary @"$VID" -H "Content-Type: application/octet-stream" | python3 -c "import sys,json;print(json.load(sys.stdin)['media']['id'])")
echo "project=$PROJECT_ID media=$MEDIA_ID"
sleep 4

# Generate the three long sequences (fixture data, clearly synthetic).
gen_sequence() {
  python3 - "$1" "$MEDIA_ID" <<'PYEOF'
import json, sys
minutes = int(sys.argv[1]); media = sys.argv[2]
fps = {"num": 30, "den": 1}
clip_len = 120  # 4s clips
count = minutes * 60 * 30 // clip_len
tracks = [
    {"id": "v1", "name": "V1", "kind": "VIDEO", "visible": True, "muted": False, "solo": False, "locked": False},
    {"id": "v2", "name": "V2", "kind": "VIDEO", "visible": True, "muted": False, "solo": False, "locked": False},
    {"id": "a1", "name": "A1", "kind": "AUDIO", "visible": True, "muted": False, "solo": False, "locked": False},
    {"id": "s1", "name": "SUB", "kind": "CAPTION", "visible": True, "muted": False, "solo": False, "locked": False},
]
clips = []
for i in range(count):
    t = "v1" if i % 2 == 0 else "v2"
    clips.append({
        "id": f"b{i}", "trackId": t, "sourceAssetId": media, "sourceInFrame": 0, "sourceOutFrame": 120,
        "sourceFps": fps, "timelineStartFrame": (i // 2) * clip_len, "timelineDurationFrames": clip_len,
        "playbackSpeed": 1, "volume": 1, "muted": False, "fadeInFrames": 0, "fadeOutFrames": 0,
        "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1},
        "captionText": None, "graphicTemplateId": None, "graphicStyle": None,
        "keyframes": [], "missingMedia": False,
    })
edits = [
    {"type": "AddTrack", "track": t} for t in tracks
] + [
    {"type": "AddClip", "clip": c} for c in clips
]
print(json.dumps({"edits": edits, "note": "M17 synthetic benchmark fixture"}))
PYEOF
}
: # (initial build happens per-iteration in the bench loop)

# Browser benchmark per sequence length.
agent-browser close >/dev/null 2>&1
TOKEN=$(curl -s -D - -o /dev/null -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"bench-pass-1234\"}" | grep -a "beanfx_session=" | sed 's/.*beanfx_session=//' | cut -d';' -f1 | tr -d '\r')
agent-browser cookies set beanfx_session "$TOKEN" --domain localhost >/dev/null
agent-browser set viewport 1600 900 >/dev/null

BENCH_ID=$(curl -s -b "$JAR" "$BASE/api/projects" | python3 -c "import sys,json;print(json.load(sys.stdin)['projects'][0]['id'])")
for NAME in "5m" "10m" "20m"; do
  # find the project whose sequence matches this length (each save replaced the same project's timeline)
  # Instead: benchmark the LAST saved sequence (20m) by name match in the workspace list.
  break
done

bench() {
  local MIN="$1"
  local LABEL="${MIN}m"
  # A FRESH PROJECT per length — avoids the optimistic-concurrency conflict by design.
  PROJ=$(curl -s -b "$JAR" -X POST "$BASE/api/projects" -H "Content-Type: application/json" -d "{\"name\":\"M17 Bench ${MIN}m\",\"description\":\"synthetic long-form fixture\"}")
  local PID_LOCAL=$(echo "$PROJ" | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['id'])")
  curl -s -b "$JAR" "$BASE/api/editor/projects/$PID_LOCAL/timeline" >/dev/null
  gen_sequence "$MIN" | python3 -c "import sys,json;d=json.load(sys.stdin);d['baseVersion']=1;print(json.dumps(d))" | curl -s -b "$JAR" -X POST "$BASE/api/editor/projects/$PID_LOCAL/timeline" -H "Content-Type: application/json" --data-binary @- | head -c 40
  echo " [$LABEL saved]"

  agent-browser close >/dev/null 2>&1
  sleep 1
  agent-browser cookies set beanfx_session "$TOKEN" --domain localhost >/dev/null
  agent-browser open "$BASE/#/editor?project=$PID_LOCAL" >/dev/null
  # Startup latency: wait for the editor AND live telemetry (clips rendered + controller exposed).
  T0=$(date +%s%3N)
  LIVE=NO
  for i in $(seq 1 90); do
    LIVE=$(agent-browser eval "(() => { const ok = Boolean(window.__beanfxPlayback) && document.querySelectorAll('[data-clip-id]').length > 0; return ok ? 'LIVE' : 'NO'; })()" 2>/dev/null | tail -1 | tr -d '"' | tr -d '\\')
    [ "$LIVE" = "LIVE" ] && break
    sleep 1
  done
  T1=$(date +%s%3N)
  echo "[$LABEL] startup-to-live (open→clips+telemetry): $((T1 - T0)) ms"
  [ "$LIVE" = "LIVE" ] || { echo "[$LABEL] FATAL: editor never reached live state"; return 1; }
  # Seek: click the ruler mid-point, wait for the playhead to settle.
  F="unset"
  X=$(agent-browser eval "(() => { const r = document.querySelector('[data-ruler]')?.getBoundingClientRect(); return r ? String(Math.round(Math.max(r.left, 0) + Math.min(window.innerWidth, r.width) * 0.5)) : 'NORULER'; })()" 2>/dev/null | tail -1 | tr -d '"')
  Y=$(agent-browser eval "(() => { const r = document.querySelector('[data-ruler]')?.getBoundingClientRect(); return r ? String(Math.round(Math.max(0, r.top) + r.height/2)) : '0'; })()" 2>/dev/null | tail -1 | tr -d '"')
  S0=$(date +%s%3N)
  if [ "$X" != "NORULER" ]; then
    agent-browser mouse move "$X" "$Y" >/dev/null && agent-browser mouse down left >/dev/null && agent-browser mouse up left >/dev/null
    F="unset"
    for i in $(seq 1 25); do
      F=$(agent-browser eval "(() => String(window.__beanfxPlayback.clock().frame))()" 2>/dev/null | tail -1 | tr -d '"' | tr -d '\\')
      sleep 0.25
      F2=$(agent-browser eval "(() => String(window.__beanfxPlayback.clock().frame))()" 2>/dev/null | tail -1 | tr -d '"' | tr -d '\\')
      [ -n "$F" ] && [ "$F" = "$F2" ] && break
    done
  fi
  S1=$(date +%s%3N)
  echo "[$LABEL] seek-to-mid (click→settle): $((S1 - S0)) ms (settled frame $F)"
  # Playback: 8 seconds, sample FPS + drops + memory from the controller telemetry.
  M0=$(agent-browser eval "(() => String(window.__beanfxPlayback.memoryMB() ?? 'NA'))()" 2>/dev/null | tail -1 | tr -d '"' | tr -d '\\')
  agent-browser eval "(() => { const c = window.__beanfxPlayback.clock(); window.__bench = {start: c.elapsedSeconds, drops: c.droppedFrames}; return 'OK'; })()" >/dev/null 2>&1
  agent-browser eval "(() => { const btn = [...document.querySelectorAll('button')].find((b) => ((b.getAttribute('title') || '') + (b.getAttribute('aria-label') || '')).includes('Play')); if (!btn) return 'NOBTN'; btn.click(); return 'OK'; })()" 2>/dev/null | tail -1 | grep -q OK || echo "[$LABEL] play button click FAILED"
  sleep 8
  STATS=$(agent-browser eval "(() => { const t = window.__beanfxPlayback; const c = t.clock(); const b = window.__bench || {start: 0, drops: 0}; const dt = c.elapsedSeconds - b.start; return JSON.stringify({playFps: dt > 0.5 ? Math.round(((c.frame / (dt)) * 10)) / 10 : 0, drops: c.droppedFrames - b.drops, playing: c.playing, mem: t.memoryMB()}); })()" 2>/dev/null | tail -1 | tr -d '"' | tr -d '\\')
  echo "[$LABEL] playback 8s: $STATS (start mem $M0 MB)"
  # M17 A/V sync: sample the active video element's clock vs the controller
  # projection 8 times during a second of playback (max observed drift).
  agent-browser eval "(() => { const btn = [...document.querySelectorAll('button')].find((b) => ((b.getAttribute('title') || '') + (b.getAttribute('aria-label') || '')).includes('Play')); btn?.click(); return 'OK'; })()" >/dev/null 2>&1
  sleep 1
  MAXDRIFT=0; NSAMPLES=0
  for i in $(seq 1 6); do
    D=$(agent-browser eval "(() => { const t = window.__beanfxPlayback; const v = [...document.querySelectorAll('video')].find((x) => !x.className.includes('hidden') && x.videoWidth > 0); const c = t.clock(); if (!v || !c.playing) return 'skip'; return String(Math.abs(v.currentTime - c.frame / 30).toFixed(4)); })()" 2>/dev/null | tail -1 | tr -d '"' | tr -d '\\')
    if [ "$D" != "skip" ] && [ -n "$D" ]; then
      NSAMPLES=$((NSAMPLES + 1))
      BIGGER=$(python3 -c "print(1 if $D > $MAXDRIFT else 0)")
      [ "$BIGGER" = "1" ] && MAXDRIFT=$D
    fi
    sleep 0.15
  done
  agent-browser eval "(() => { const btn = [...document.querySelectorAll('button')].find((b) => ((b.getAttribute('title') || '') + (b.getAttribute('aria-label') || '')).includes('Play')); btn?.click(); return 'OK'; })()" >/dev/null 2>&1
  echo "[$LABEL] A/V drift (video.currentTime vs controller clock): maxDrift=${MAXDRIFT}s over ${NSAMPLES} samples"
  agent-browser eval "(() => { const btn = [...document.querySelectorAll('button')].find((b) => ((b.getAttribute('title') || '') + (b.getAttribute('aria-label') || '')).includes('Play')); btn?.click(); return 'OK'; })()" >/dev/null 2>&1
  sleep 1
  agent-browser screenshot "/home/z/my-project/download/m17-screenshots/bench-$LABEL.png" >/dev/null
  return 0
}

mkdir -p /home/z/my-project/download/m17-screenshots
for MIN in 5 10 20; do
  bench "$MIN"
done

PID_ON_PORT=$(ss -tlnp 2>/dev/null | grep -E ':3117 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
[ -n "$PID_ON_PORT" ] && kill "$PID_ON_PORT"
echo "M17_BENCH_COMPLETE"
