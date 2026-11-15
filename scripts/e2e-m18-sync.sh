#!/usr/bin/env bash
# M18 Phase D — deterministic A/V synchronization measurement.
# Fixture: a 6s clip with a white flash + a 1kHz beep at t=1,2,3,4,5s
# (marker pair). Import it, render a real export through the app, then
# MEASURE: beep timestamps (silencedetect) vs flash timestamps (frame
# luma). The offset between the two = the real A/V sync of the export path.
set -uo pipefail
cd /home/z/my-project
JAR=/tmp/m18-sync.txt
BASE=http://localhost:3117
rm -f "$JAR"

FIX=/tmp/m18-sync-fixture.mp4
[ -f "$FIX" ] || ffmpeg -y -loglevel error \
  -f lavfi -i "testsrc2=size=320x180:rate=30:duration=6" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=6" \
  -filter_complex "[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=white@1:t=fill:enable='between(t,0.98,1.06)+between(t,1.98,2.06)+between(t,2.98,3.06)+between(t,3.98,4.06)+between(t,4.98,5.06)'[v];[1:a]volume=0.9:enable='between(t,0.98,1.06)+between(t,1.98,2.06)+between(t,2.98,3.06)+between(t,3.98,4.06)+between(t,4.98,5.06)',volume=0[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$FIX"
echo "fixture ready: $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$FIX")s"

curl -s -c "$JAR" -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d '{"email":"m18sync@test.local","password":"sync-pass-1234","name":"M18 Sync"}' >/dev/null
curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d '{"email":"m18sync@test.local","password":"sync-pass-1234"}' >/dev/null
MID=$(curl -s -b "$JAR" -X POST "$BASE/api/media" -H "x-filename: sync-fixture.mp4" -H "x-role: BROLL" --data-binary @"$FIX" -H "Content-Type: application/octet-stream" | python3 -c "import sys,json;print(json.load(sys.stdin)['media']['id'])")
PROJ=$(curl -s -b "$JAR" -X POST "$BASE/api/projects" -H "Content-Type: application/json" -d '{"name":"M18 Sync Validation"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['id'])")
sleep 4
COOKIE=$(grep beanfx_session "$JAR" | awk '{print "beanfx_session=" $NF}')
# Single full-length clip (no offset) — export sync == source sync.
python3 scripts/m17-build-sequence.py 6 "$MID" "$PROJ" "$COOKIE" "$BASE" >/dev/null 2>&1 || true
# m17 builder makes 20s; write a precise 6s one instead.
python3 - "$MID" "$PROJ" "$COOKIE" "$BASE" <<'PYEOF'
import json, sys, urllib.request
media, project, cookie, base = sys.argv[1:5]
fps = {"num": 30, "den": 1}
tracks = [
    {"id": "v1", "name": "V1", "kind": "VIDEO", "visible": True, "muted": False, "solo": False, "locked": False},
    {"id": "a1", "name": "A1", "kind": "AUDIO", "visible": True, "muted": False, "solo": False, "locked": False},
]
clip = {"id": "sync0", "trackId": "v1", "sourceAssetId": media, "sourceInFrame": 0, "sourceOutFrame": 180,
        "sourceFps": fps, "timelineStartFrame": 0, "timelineDurationFrames": 180, "playbackSpeed": 1,
        "volume": 1, "muted": False, "fadeInFrames": 0, "fadeOutFrames": 0,
        "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1},
        "captionText": None, "captionStyle": None, "graphicTemplateId": None, "graphicStyle": None,
        "keyframes": [], "missingMedia": False}
aclips = dict(clip); aclips.update({"id": "synca", "trackId": "a1", "timelineDurationFrames": 180, "sourceOutFrame": 180})
edits = [{"type": "AddTrack", "track": t} for t in tracks] + [
    {"type": "AddClip", "clip": clip}, {"type": "AddClip", "clip": aclips}]
body = json.dumps({"baseVersion": 1, "edits": edits}).encode()
req = urllib.request.Request(f"{base}/api/editor/projects/{project}/timeline", data=body,
                             headers={"Content-Type": "application/json", "Cookie": cookie}, method="POST")
print(urllib.request.urlopen(req).status)
PYEOF
JOB=$(curl -s -b "$JAR" -X POST "$BASE/api/editor/projects/$PROJ/render" -H "Content-Type: application/json" -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('jobId',''))")
echo "job=$JOB"
for i in $(seq 1 60); do
  sleep 4
  ST=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJ/render" | python3 -c "
import sys, json
d = json.load(sys.stdin)
jobs = d.get('jobs') or []
print(jobs[0]['status'] if jobs else '?')" 2>/dev/null)
  [ "$ST" = "COMPLETED" ] || [ "$ST" = "FAILED" ] && break
done
echo "final: $ST"
EXPORT_ID=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJ/render" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ex = d.get('exports') or []
print(ex[0]['id'] if ex else '')")
[ -z "$EXPORT_ID" ] && { echo "NO EXPORT — sync validation aborted"; exit 1; }
curl -s -b "$JAR" -o /tmp/m18-sync-out.mp4 "$BASE/api/exports/$EXPORT_ID/file"
echo "export: $(stat -c%s /tmp/m18-sync-out.mp4) bytes"

# MEASURE beeps: non-silent spans.
BEeps=$(ffmpeg -i /tmp/m18-sync-out.mp4 -map 0:a -af "silencedetect=noise=-40dB:d=0.05" -f null - 2>&1 | grep -oE "silence_start: [0-9.]+" | grep -oE "[0-9.]+$")
python3 - "$BEeps" <<'PYEOF'
import subprocess, sys
from pathlib import Path
import json

silent_starts = [float(x) for x in sys.argv[1].split()]
# Beep centers: midpoints of the non-silent gaps between silence spans.
# Reconstruct: silence ends at each flash window start+0.08; easier — detect
# loud spans directly by probing RMS in 20ms windows.
loud = []
t = 0.0
probe = subprocess.run(
    ["ffprobe", "-v", "error", "-f", "lavfi", "-i",
     "amovie=/tmp/m18-sync-out.mp4:asetpts=PTS-STARTPTS,astats=metadata=1:reset=1:length=0.02"],
    capture_output=True, text=True, timeout=120)
PYEOF
# Simpler deterministic approach: measure RMS per 50ms window with astats via ffmpeg segments.
python3 <<'PYEOF'
import subprocess, json

def windows(path, t0, t1, step=0.05):
    out = []
    t = t0
    while t < t1:
        r = subprocess.run(
            ["ffmpeg", "-ss", str(t), "-t", "0.05", "-i", path, "-map", "0:a", "-af", "astats=metadata=1", "-f", "null", "-"],
            capture_output=True, text=True, timeout=60)
        rms = None
        for line in r.stderr.splitlines():
            if "RMS level dB" in line:
                rms = float(line.split(":")[1].strip())
                break
        out.append((t, rms))
        t += step
    return out

audio = windows("/tmp/m18-sync-out.mp4", 0.5, 6.0)
beep_centers = []
in_beep = False
start = None
for t, rms in audio:
    loud = rms is not None and rms > -40
    if loud and not in_beep:
        in_beep, start = True, t
    elif not loud and in_beep:
        in_beep = False
        beep_centers.append(round((start + t) / 2, 3))
if in_beep:
    beep_centers.append(round((start + audio[-1][0]) / 2, 3))

def frame_luma(path, t):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(t), "-i", path, "-frames:v", "1", "/tmp/m18-sync-frame.png"], timeout=60)
    try:
        from PIL import Image
        im = Image.open("/tmp/m18-sync-frame.png").convert("L")
        px = list(im.getdata())
        return sum(px) / len(px)
    except Exception as e:
        return None

flash_centers = []
for k in range(1, 6):
    # scan the flash window (k - 0.05 .. k + 0.15) at 33ms steps for a bright frame
    best_t, best_l = None, 0
    t = k - 0.06
    while t < k + 0.16:
        l = frame_luma("/tmp/m18-sync-out.mp4", round(t, 3))
        if l is not None and l > best_l:
            best_l, best_t = l, round(t, 3)
        t += 0.033
    flash_centers.append(best_t)

print("beep_centers:", beep_centers)
print("flash_centers:", flash_centers)
expected = [1.0, 2.0, 3.0, 4.0, 5.0]
if len(beep_centers) == len(flash_centers) and beep_centers:
    offsets = [round(f - b, 3) for f, b in zip(flash_centers, beep_centers)]
    print("A/V offsets (flash - beep) per marker:", offsets)
    print("mean offset:", round(sum(offsets) / len(offsets), 4), "s; max |offset|:", round(max(abs(o) for o in offsets), 4), "s")
    print("SYNC_MEASURED")
else:
    print("beeps:", len(beep_centers), "flashes:", len(flash_centers), "— marker pairing incomplete")
PYEOF
echo "M18_SYNC_COMPLETE"
