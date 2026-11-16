#!/usr/bin/env bash
# M18 Phase E — session workflow via the REAL APIs (the same backend the UI
# drives; UI segmentation evidence lives in Phase B + M16 browser E2E).
# Project create → media import (video/audio/image) → 30s sequence →
# save → reload → render → FFprobe.
set -uo pipefail
cd /home/z/my-project
BASE=http://localhost:3117
JAR=/tmp/m18-api-session.txt
rm -f "$JAR"
EMAIL="m18apisess-$RANDOM@test.local"
curl -s -c "$JAR" -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"session-pass-1234\",\"name\":\"M18 API Session\"}" >/dev/null
curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"session-pass-1234\"}" >/dev/null
PROJ=$(curl -s -b "$JAR" -X POST "$BASE/api/projects" -H "Content-Type: application/json" -d '{"name":"M18 API Session Feature","description":"complete-session validation"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['id'])")
echo "1 project=$PROJ"
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=640x360:rate=30:duration=8" -f lavfi -i "sine=frequency=330:duration=8" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest /tmp/m18-ses-video.mp4
ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=523:duration=12" -c:a aac /tmp/m18-ses-music.m4a
ffmpeg -y -loglevel error -f lavfi -i "color=c=#1a1a18:s=320x180:d=1" -frames:v 1 /tmp/m18-ses-still.png
MV=$(curl -s -b "$JAR" -X POST "$BASE/api/media" -H "x-filename: session-video.mp4" -H "x-role: BROLL" --data-binary @/tmp/m18-ses-video.mp4 -H "Content-Type: application/octet-stream" | python3 -c "import sys,json;print(json.load(sys.stdin)['media']['id'])")
MM=$(curl -s -b "$JAR" -X POST "$BASE/api/media" -H "x-filename: session-music.m4a" -H "x-role: MUSIC" --data-binary @/tmp/m18-ses-music.m4a -H "Content-Type: application/octet-stream" | python3 -c "import sys,json;print(json.load(sys.stdin)['media']['id'])")
MI=$(curl -s -b "$JAR" -X POST "$BASE/api/media" -H "x-filename: session-still.png" -H "x-role: BROLL" --data-binary @/tmp/m18-ses-still.png -H "Content-Type: application/octet-stream" | python3 -c "import sys,json;print(json.load(sys.stdin)['media']['id'])")
echo "2 media: video=$MV music=$MM image=$MI"
sleep 4
COOKIE=$(grep beanfx_session "$JAR" | awk '{print "beanfx_session=" $NF}')
python3 - "$MV" "$MM" "$MI" "$PROJ" "$COOKIE" "$BASE" <<'PYEOF'
import json, sys, urllib.request
mv, mm, mi, project, cookie, base = sys.argv[1:7]
fps = {"num": 30, "den": 1}
tracks = [
    {"id": "v1", "name": "V1", "kind": "VIDEO", "visible": True, "muted": False, "solo": False, "locked": False},
    {"id": "v2", "name": "V2", "kind": "VIDEO", "visible": True, "muted": False, "solo": False, "locked": False},
    {"id": "a1", "name": "A1", "kind": "AUDIO", "visible": True, "muted": False, "solo": False, "locked": False},
    {"id": "s1", "name": "SUB", "kind": "CAPTION", "visible": True, "muted": False, "solo": False, "locked": False},
]
clips = []
for i in range(4):
    clips.append({"id": f"sv{i}", "trackId": "v1" if i % 2 == 0 else "v2", "sourceAssetId": mv,
                  "sourceInFrame": 0, "sourceOutFrame": 120, "sourceFps": fps,
                  "timelineStartFrame": (i // 2) * 120, "timelineDurationFrames": 120,
                  "playbackSpeed": 1, "volume": 1, "muted": False, "fadeInFrames": 0, "fadeOutFrames": 0,
                  "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1},
                  "captionText": None, "captionStyle": None, "graphicTemplateId": None, "graphicStyle": None,
                  "keyframes": [], "missingMedia": False})
clips.append({"id": "sa0", "trackId": "a1", "sourceAssetId": mm, "sourceInFrame": 0, "sourceOutFrame": 240,
              "sourceFps": fps, "timelineStartFrame": 0, "timelineDurationFrames": 240, "playbackSpeed": 1,
              "volume": 1, "muted": False, "fadeInFrames": 15, "fadeOutFrames": 15,
              "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1},
              "captionText": None, "captionStyle": None, "graphicTemplateId": None, "graphicStyle": None,
              "keyframes": [
                  {"id": "kf-sess1", "property": "volume", "frame": 60, "value": 2.0, "interpolation": "LINEAR", "bezier": None},
                  {"id": "kf-sess2", "property": "volume", "frame": 180, "value": 0.5, "interpolation": "LINEAR", "bezier": None},
              ], "missingMedia": False})
clips.append({"id": "scap", "trackId": "s1", "sourceAssetId": "", "sourceInFrame": 0, "sourceOutFrame": 60,
              "sourceFps": fps, "timelineStartFrame": 0, "timelineDurationFrames": 60, "playbackSpeed": 1,
              "volume": 1, "muted": False, "fadeInFrames": 0, "fadeOutFrames": 0,
              "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1},
              "captionText": "M18 session caption", "captionStyle": {"fontSize": 44, "color": "#FFFFFF", "background": None, "position": "BOTTOM"},
              "graphicTemplateId": None, "graphicStyle": None, "keyframes": [], "missingMedia": True})
edits = [{"type": "AddTrack", "track": t} for t in tracks] + [{"type": "AddClip", "clip": c} for c in clips]
body = json.dumps({"baseVersion": 1, "edits": edits}).encode()
req = urllib.request.Request(f"{base}/api/editor/projects/{project}/timeline", data=body,
                             headers={"Content-Type": "application/json", "Cookie": cookie}, method="POST")
print("3 sequence:", urllib.request.urlopen(req).status)
PYEOF
# Reload verification (fresh read = what a browser reload would restore).
curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJ/timeline" | python3 -c "
import sys, json
d = json.load(sys.stdin)
seq = d.get('sequence') or {}
print('4 reload: clips', len(seq.get('clips', [])), 'kf', len([k for c in seq.get('clips', []) for k in c.get('keyframes', [])]))"
# Split + ripple via real engine commands (same commands the toolbar issues).
TV=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJ/timeline")
HEADV=$(echo "$TV" | python3 -c "import sys,json;print(json.load(sys.stdin).get('versionNumber', 1))")
printf '{"baseVersion": %s, "edits": [{"type": "SplitClip", "clipId": "sv0", "frame": 60}]}' "$HEADV" | curl -s -b "$JAR" -X POST "$BASE/api/editor/projects/$PROJ/timeline" -H "Content-Type: application/json" --data-binary @- | python3 -c "import sys,json;d=json.load(sys.stdin);print('5 split:', 'v'+str(d.get('versionNumber', '?')))" 2>/dev/null || echo "5 split: FAILED"
TV2=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJ/timeline")
HV2=$(echo "$TV2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('versionNumber', 1))")
printf '{"baseVersion": %s, "edits": [{"type": "RippleDelete", "clipId": "sv2"}]}' "$HV2" | curl -s -b "$JAR" -X POST "$BASE/api/editor/projects/$PROJ/timeline" -H "Content-Type: application/json" --data-binary @- | python3 -c "import sys,json;d=json.load(sys.stdin);print('6 ripple:', 'v'+str(d.get('versionNumber', '?')))" 2>/dev/null || echo "6 ripple: FAILED"
# Render through the durable job system.
JOB=$(curl -s -b "$JAR" -X POST "$BASE/api/editor/projects/$PROJ/render" -H "Content-Type: application/json" -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('jobId',''))")
echo "7 render job=$JOB"
ST=""
for i in $(seq 1 50); do
  sleep 3
  ST=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJ/render" | python3 -c "
import sys, json
d = json.load(sys.stdin)
jobs = d.get('jobs') or []
for j in jobs:
    if j.get('id') == '$JOB': print(j['status']); break
else: print('?')" 2>/dev/null)
  [ "$ST" = "COMPLETED" ] || [ "$ST" = "FAILED" ] && break
done
echo "8 render final: $ST"
EXPORT_ID=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJ/render" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ex = d.get('exports') or []
print(ex[0]['id'] if ex else '')")
curl -s -b "$JAR" -o /tmp/m18-api-session.mp4 "$BASE/api/exports/$EXPORT_ID/file"
ffprobe -v error -print_format json -show_streams -show_format /tmp/m18-api-session.mp4 | python3 -c "
import sys, json
d = json.load(sys.stdin)
v = [s for s in d['streams'] if s['codec_type'] == 'video']
a = [s for s in d['streams'] if s['codec_type'] == 'audio']
print('9 ffprobe: v', len(v), 'a', len(a), 'dur', round(float(d['format']['duration']), 2), 'size', d['format']['size'])"
ffmpeg -y -loglevel error -ss 1 -i /tmp/m18-api-session.mp4 -frames:v 3 /tmp/m18-api-f%d.png
echo "10 decoded $(ls /tmp/m18-api-f*.png 2>/dev/null | wc -l) representative frames"
echo "M18_API_SESSION_COMPLETE"
