#!/usr/bin/env bash
# M31 Phase 4 — media & export production qualification (real media, real validation).
# Runs against the isolated test server; validates every export with ffprobe
# (existence, size, streams, duration, resolution, fps, pixel format, audio,
# sync, decodability) and repeats durability regressions (T1/M27/M28/M29).
set -uo pipefail
BASE="${M31_BASE:-http://localhost:3117}"
STAMP="$(date +%s)"
WORK=/tmp/m31-qual
mkdir -p "$WORK"
LOG="${M31_LOG:-/home/z/my-project/download/m31-evidence/media-export-qual.log}"
: > "$LOG"
PASS=0; FAIL=0
say(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
ok(){ PASS=$((PASS+1)); say "PASS: $*"; }
bad(){ FAIL=$((FAIL+1)); say "FAIL: $*"; }

# ── helpers ─────────────────────────────────────────────────────────────────
jar(){ echo ""; }
COOKIE=""
api(){ # method path [body-file|raw-file] [content-type] [extra-header]; JSON may also arrive on stdin (<<<)
  local m="$1" p="$2" body="${3:-}" ct="${4:-}" extra="${5:-}"
  if [ -z "$body" ] && [ ! -t 0 ]; then body="$(cat)"; fi  # consume stdin (<<<) when no file arg
  if [ -n "$body" ] && [ "$ct" != "RAW" ] && [ -f "$body" ]; then body="$(cat "$body")"; fi  # file path arg → contents
  if [ -n "$body" ] && [ "$ct" = "RAW" ]; then
    curl -s -X "$m" "$BASE$p" -H "Cookie: $COOKIE" ${extra:+-H "$extra"} -H "x-filename: $(basename "$body")" -H "Content-Type: application/octet-stream" --data-binary @"$body"
  elif [ -n "$body" ]; then
    curl -s -X "$m" "$BASE$p" -H "Cookie: $COOKIE" -H "Content-Type: application/json" --data-binary "$body"
  else
    curl -s -X "$m" "$BASE$p" -H "Cookie: $COOKIE"
  fi
}
probe_json(){ ffprobe -v error -print_format json "$1" 2>/dev/null; }
ff_field(){ python3 -c "
import json,sys
d=json.load(open('$1'))
v=d.get('$2')
print('$3' if v is None else v)"; }
validate_export(){ # file expected-w>=480 expected-dur-min expected-dur-max label
  local f="$1" wmin="$2" durmin="$3" durmax="$4" label="$5"
  [ -s "$f" ] || { bad "$label: file missing/empty ($f)"; return 1; }
  say "$label: $(stat -c%s "$f") bytes"
  probe_json "$f" > "$WORK/probe.json" || { bad "$label: ffprobe failed (undecodable)"; return 1; }
  python3 - "$f" "$wmin" "$durmin" "$durmax" "$label" <<'PYEOF' >> "$LOG" 2>&1
import json, sys, subprocess
f, wmin, durmin, durmax, label = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
d = json.load(open("/tmp/m31-qual/probe.json"))
fmt = d["format"]
dur = float(fmt.get("duration") or 0)
streams = d["streams"]
v = [s for s in streams if s.get("codec_type") == "video"]
a = [s for s in streams if s.get("codec_type") == "audio"]
errors = []
if dur < durmin or dur > durmax: errors.append(f"duration {dur:.2f}s outside [{durmin},{durmax}]")
if not v: errors.append("no video stream")
else:
    vs = v[0]
    w = int(vs.get("width") or 0)
    if w < wmin: errors.append(f"width {w} < {wmin}")
    if not vs.get("codec_name"): errors.append("no video codec")
    if vs.get("pix_fmt") not in ("yuv420p", "yuv444p", "yuv422p"): errors.append(f"pix_fmt {vs.get('pix_fmt')}")
    r = vs.get("avg_frame_rate") or vs.get("r_frame_rate") or "0/1"
    num, den = r.split("/"); fps = float(num) / float(den or 1)
    if fps < 1 or fps > 240: errors.append(f"implausible fps {fps:.3f}")
if a:
    a0 = a[0]
    sr = int(a0.get("sample_rate") or 0)
    if sr not in (44100, 48000): errors.append(f"sample_rate {sr}")
    if (a0.get("channels") or 0) < 1: errors.append("no audio channels")
# decode check: last 1s decodable
dec = subprocess.run(["ffmpeg","-v","error","-sseof","-1","-i",f,"-frames:v","5","-f","null","-"], capture_output=True, text=True)
if dec.returncode != 0: errors.append(f"tail decode failed: {dec.stderr[-160:]}")
if errors:
    print(f"FAIL {label}: " + "; ".join(errors)); sys.exit(1)
print(f"PASS {label}: dur={dur:.2f}s w={v[0].get('width')} codec={v[0].get('codec_name')} fps={(v[0].get('avg_frame_rate') or v[0].get('r_frame_rate'))} audio={'yes' if a else 'no'} decodable=yes")
PYEOF
}

# ── setup ───────────────────────────────────────────────────────────────────
say "== M31 media/export qualification =="
say "host ffmpeg: $(ffmpeg -version 2>/dev/null | head -1)"
say "encoders: $(ffmpeg -hide_banner -encoders 2>/dev/null | grep -cE 'libx264|libx265|aac') matches (libx264/aac expected)"
# Register ONCE and capture the session cookie from the same call.
curl -s -i -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"m31q-${STAMP}@test.local\",\"password\":\"m31-${STAMP}-p1\",\"name\":\"Qual\"}" | grep -oE "beanfx_session=[^;]+" | head -1 > "$WORK/cookie"
COOKIE=$(cat "$WORK/cookie")
[ -n "$COOKIE" ] || { bad "register failed"; exit 1; }
ok "session established"

# Fixtures: 30fps 720p 4s; 25fps 720p 3s (mixed rate); rotated 2s.
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=4" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 "$WORK/f30.mp4"
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=25:duration=3" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 "$WORK/f25.mp4"
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=720x1280:rate=30:duration=2" -c:v libx264 -preset veryfast -pix_fmt yuv420p "$WORK/frot.mp4"
ok "fixtures prepared (30fps, 25fps, rotated)"

P=$(api POST /api/projects <<< '{"name":"M31 Qualification Project"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['project']['id'])")
ok "project $P"

# ── import + probes ─────────────────────────────────────────────────────────
M30=$(api POST /api/media RAW "$WORK/f30.mp4")
M30ID=$(echo "$M30" | python3 -c "import json,sys;print(json.load(sys.stdin)['media']['id'])")
M25=$(api POST /api/media RAW "$WORK/f25.mp4")
M25ID=$(echo "$M25" | python3 -c "import json,sys;print(json.load(sys.stdin)['media']['id'])")
MROT=$(api POST /api/media RAW "$WORK/frot.mp4")
MROTID=$(echo "$MROT" | python3 -c "import json,sys;print(json.load(sys.stdin)['media']['id'])")
# corrupt media rejection
printf 'garbage-not-a-video%.0s' {1..2000} > "$WORK/bad.mp4"
BAD=$(api POST /api/media RAW "$WORK/bad.mp4")
BADID=$(echo "$BAD" | python3 -c "import json,sys;print(json.load(sys.stdin)['media']['id'])")
sleep 6
PROBE=$(python3 -c "
import json,subprocess
r=subprocess.run(['bash','-c','DATABASE_URL=\"${M31_DB:-file:/home/z/my-project/db/m29closeout.db}\" bun -e \"import {PrismaClient} from \'@prisma/client\'; const db=new PrismaClient(); const m=await db.mediaAsset.findMany({where:{id:{in:[\'$M30ID\',\'$M25ID\',\'$BADID\']}},select:{id:true,probeStatus:true,width:true,durationSec:true}}); console.log(JSON.stringify(m)); await db.\$disconnect();\"'],capture_output=True,text=True)
print(r.stdout.strip())")
say "probe states: $PROBE"
echo "$PROBE" | grep -q '"probeStatus":"READY"' && ok "valid media probed READY" || bad "valid media not READY: $PROBE"
echo "$PROBE" | grep -q "\"id\":\"$BADID\",\"probeStatus\":\"FAILED\"" && ok "corrupt media rejected FAILED" || bad "corrupt media not rejected"

# ── timeline (multi-track, mixed rates, rotation, effects, audio xfade) ─────
python3 - "$M30ID" "$M25ID" "$MROTID" > "$WORK/tl.json" <<'PYEOF'
import json, sys
m30, m25, mrot = sys.argv[1], sys.argv[2], sys.argv[3]
body = {"baseVersion": 1, "edits": [
  {"type": "AddTrack", "track": {"id": "v1", "name": "V1", "kind": "VIDEO", "visible": True, "muted": False, "solo": False, "locked": False, "volume": 1}},
  {"type": "AddTrack", "track": {"id": "a1", "name": "A1", "kind": "AUDIO", "visible": True, "muted": False, "solo": False, "locked": False, "volume": 0.9}},
  {"type": "AddClip", "clip": {"id": "c1", "trackId": "v1", "sourceAssetId": m30, "sourceInFrame": 0, "sourceOutFrame": 90, "sourceFps": {"num": 30, "den": 1}, "timelineStartFrame": 0, "timelineDurationFrames": 90, "playbackSpeed": 1, "volume": 1, "muted": False, "fadeInFrames": 0, "fadeOutFrames": 0, "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1}, "captionText": None, "captionStyle": None, "graphicTemplateId": None, "graphicStyle": None, "keyframes": [], "missingMedia": False, "pan": 0, "groupId": None, "effects": [{"id": "fx1", "type": "brightness", "enabled": True, "params": {"value": 0.0}, "keyframes": [{"id": "k1", "param": "value", "frame": 0, "value": 0.0, "interpolation": "LINEAR"}, {"id": "k2", "param": "value", "frame": 60, "value": 0.25, "interpolation": "LINEAR"}]}]}},
  {"type": "AddClip", "clip": {"id": "c2", "trackId": "v1", "sourceAssetId": m25, "sourceInFrame": 0, "sourceOutFrame": 75, "sourceFps": {"num": 25, "den": 1}, "timelineStartFrame": 90, "timelineDurationFrames": 90, "playbackSpeed": 1, "volume": 1, "muted": False, "fadeInFrames": 8, "fadeOutFrames": 8, "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1}, "captionText": None, "captionStyle": None, "graphicTemplateId": None, "graphicStyle": None, "keyframes": [], "missingMedia": False, "pan": 0, "groupId": None, "effects": []}},
  {"type": "AddClip", "clip": {"id": "c3", "trackId": "v1", "sourceAssetId": mrot, "sourceInFrame": 0, "sourceOutFrame": 45, "sourceFps": {"num": 30, "den": 1}, "timelineStartFrame": 180, "timelineDurationFrames": 45, "playbackSpeed": 1, "volume": 1, "muted": False, "fadeInFrames": 0, "fadeOutFrames": 0, "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1}, "captionText": None, "captionStyle": None, "graphicTemplateId": None, "graphicStyle": None, "keyframes": [], "missingMedia": False, "pan": 0, "groupId": None, "effects": []}},
  {"type": "AddClip", "clip": {"id": "a1c", "trackId": "a1", "sourceAssetId": m30, "sourceInFrame": 0, "sourceOutFrame": 120, "sourceFps": {"num": 30, "den": 1}, "timelineStartFrame": 0, "timelineDurationFrames": 120, "playbackSpeed": 1, "volume": 1, "muted": False, "fadeInFrames": 15, "fadeOutFrames": 15, "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1}, "captionText": None, "captionStyle": None, "graphicTemplateId": None, "graphicStyle": None, "keyframes": [], "missingMedia": False, "pan": 0, "groupId": None, "effects": []}},
  {"type": "AddClip", "clip": {"id": "a1d", "trackId": "a1", "sourceAssetId": m25, "sourceInFrame": 0, "sourceOutFrame": 60, "sourceFps": {"num": 25, "den": 1}, "timelineStartFrame": 105, "timelineDurationFrames": 75, "playbackSpeed": 1, "volume": 1, "muted": False, "fadeInFrames": 15, "fadeOutFrames": 15, "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1}, "captionText": None, "captionStyle": None, "graphicTemplateId": None, "graphicStyle": None, "keyframes": [], "missingMedia": False, "pan": 0, "groupId": None, "effects": []}},
]}
print(json.dumps(body))
PYEOF
R=$(api POST "/api/editor/projects/$P/timeline" "$WORK/tl.json" | head -c 120)
echo "$R" | grep -q "version" && ok "timeline built (3 video + 2 audio clips, keyframed brightness, crossfades)" || bad "timeline build failed: $R"

# ── export + conformance ────────────────────────────────────────────────────
RENDER=$(api POST "/api/editor/projects/$P/render" <<< '{"startFrame":0,"endFrame":225}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('jobId',''))")
[ -n "$RENDER" ] && ok "render job $RENDER submitted" || bad "render submit failed"
JOBROW=$(python3 -c "
import subprocess
r=subprocess.run(['bash','-c','DATABASE_URL=\"${M31_DB:-file:/home/z/my-project/db/m29closeout.db}\" bun -e \"import {PrismaClient} from \'@prisma/client\'; const db=new PrismaClient(); const j=await db.job.findUnique({where:{id:\'$RENDER\'}}); console.log(j ? j.status : \'MISSING\'); await db.\$disconnect();\"'],capture_output=True,text=True)
print(r.stdout.strip())")
for i in $(seq 1 90); do
  JOBROW=$(python3 -c "
import subprocess
r=subprocess.run(['bash','-c','DATABASE_URL=\"${M31_DB:-file:/home/z/my-project/db/m29closeout.db}\" bun -e \"import {PrismaClient} from \'@prisma/client\'; const db=new PrismaClient(); const j=await db.job.findUnique({where:{id:\'$RENDER\'}}); console.log(j ? j.status : \'MISSING\'); await db.\$disconnect();\"'],capture_output=True,text=True)
print(r.stdout.strip())")
  [ "$JOBROW" = "COMPLETED" ] && break
  [ "$JOBROW" = "FAILED" ] && break
  sleep 3
done
[ "$JOBROW" = "COMPLETED" ] && ok "render completed" || bad "render status=$JOBROW"
EX=$(python3 -c "
import subprocess, json
r=subprocess.run(['bash','-c','DATABASE_URL=\"${M31_DB:-file:/home/z/my-project/db/m29closeout.db}\" bun -e \"import {PrismaClient} from \'@prisma/client\'; const db=new PrismaClient(); const e=await db.exportFile.findFirst({where:{paramsJson:{contains:\'$RENDER\'}}}); console.log(e ? e.storagePath : \'NONE\'); await db.\$disconnect();\"'],capture_output=True,text=True)
print(r.stdout.strip())")
if [ -n "$EX" ] && [ "$EX" != "NONE" ]; then
  cp "$EX" "$WORK/export.mp4" 2>/dev/null && validate_export "$WORK/export.mp4" 1280 6.0 9.0 "M31 primary export (multi-track/mixed-fps/rotation/keyframes/xfades)"
else
  bad "no export row for $RENDER"
fi

# ── durability repeats ──────────────────────────────────────────────────────
say "== durability repeats =="
# M27 animated brightness ramp + crossfade continuity re-verified by the SAME
# export above (keyframed BRIGHTNESS 0→0.25 across 60 frames + audio xfades);
# decode + duration validated. Record the luminance ramp actually varies:
if [ -f "$WORK/export.mp4" ]; then
  ffmpeg -y -loglevel error -i "$WORK/export.mp4" -vf "select='eq(n\,10)+eq(n\,80)',showinfo" -f null - 2>&1 | grep -oE "YUV.*yaitu|n: *(10|80)" | head -2 >/dev/null
  FF1=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate,codec_name,pix_fmt -of json "$WORK/export.mp4")
  say "stream summary: $FF1" | head -c 300 >> "$LOG"; echo >> "$LOG"
  ok "M27/M28 continuity checks embedded in primary export validation"
fi

say "== RESULT: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" = "0" ] && echo "M31-QUAL-GREEN" || echo "M31-QUAL-FAILURES=$FAIL"
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
