#!/usr/bin/env bash
# M18 Phase C — 600s render long-poll with FFprobe validation.
# Polls the durable job until terminal state (long window), downloads the
# output, validates with FFprobe, decodes beginning/middle/end sections.
set -uo pipefail
cd /home/z/my-project
CTX=($(cat /tmp/m18-render-ctx.txt))
PROJ=${CTX[0]}; COOKIE=${CTX[1]}
BASE=http://localhost:3117
JOB=cmwi4gc1j0001qay6ibmi2wkd

for i in $(seq 1 300); do
  sleep 6
  R=$(curl -s -b "$COOKIE" "$BASE/api/editor/projects/$PROJ/render" | python3 -c "
import sys, json
d = json.load(sys.stdin)
jobs = d.get('jobs') or []
for j in jobs:
    if j.get('id') == '$JOB':
        print(json.dumps({'status': j['status'], 'progress': j.get('progress'), 'stage': j.get('stage'), 'message': j.get('message'), 'exportId': j.get('exportId')}))
        break
else:
    print(json.dumps({'status': 'NOT_FOUND'}))" 2>/dev/null)
  STATUS=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
  echo "poll $i: $R"
  [ "$STATUS" = "COMPLETED" ] || [ "$STATUS" = "FAILED" ] || [ "$STATUS" = "CANCELLED" ] && break
done | tee download/m18-render-logs/poll.log | tail -1

EXPORT_ID=$(grep -o '"exportId":"[^"]*"' download/m18-render-logs/poll.log | tail -1 | cut -d'"' -f4)
if [ -n "$EXPORT_ID" ]; then
  curl -s -b "$COOKIE" -o /tmp/m18-600s.mp4 "$BASE/api/exports/$EXPORT_ID/file"
  SIZE=$(stat -c%s /tmp/m18-600s.mp4 2>/dev/null || echo 0)
  echo "downloaded $SIZE bytes"
  ffprobe -v error -print_format json -show_streams -show_format /tmp/m18-600s.mp4 > download/m18-render-logs/ffprobe.json 2>/dev/null
  python3 - <<'PYEOF'
import json
d = json.load(open("download/m18-render-logs/ffprobe.json"))
v = [s for s in d["streams"] if s["codec_type"] == "video"]
a = [s for s in d["streams"] if s["codec_type"] == "audio"]
fmt = d["format"]
print(json.dumps({
  "video_streams": len(v), "audio_streams": len(a),
  "video_codec": v[0]["codec_name"] if v else None, "audio_codec": a[0]["codec_name"] if a else None,
  "resolution": f"{v[0].get('width')}x{v[0].get('height')}" if v else None,
  "fps": v[0].get("r_frame_rate") if v else None,
  "container_duration": float(fmt["duration"]),
  "video_duration": float(v[0].get("duration", 0)) if v else None,
  "audio_duration": float(a[0].get("duration", 0)) if a else None,
  "size_mb": round(int(fmt["size"]) / 1048576, 2),
}, indent=1))
PYEOF
  # Decode beginning / middle / end sections.
  ffmpeg -y -loglevel error -ss 5 -t 2 -i /tmp/m18-600s.mp4 -frames:v 20 /tmp/m18-dec-b%02d.png
  ffmpeg -y -loglevel error -ss 300 -t 2 -i /tmp/m18-600s.mp4 -frames:v 20 /tmp/m18-dec-m%02d.png
  ffmpeg -y -loglevel error -ss 595 -t 2 -i /tmp/m18-600s.mp4 -frames:v 20 /tmp/m18-dec-e%02d.png
  for S in b m e; do
    N=$(ls /tmp/m18-dec-$S*.png 2>/dev/null | wc -l)
    echo "decoded $S: $N frames"
  done
  # Audio presence at three points.
  for T in 5 300 595; do
    RMS=$(ffmpeg -ss $T -t 1 -i /tmp/m18-600s.mp4 -map 0:a -af astats=metadata=1 -f null - 2>&1 | grep -oE "RMS level dB: [-0-9.]+" | head -1)
    echo "audio@$T s: $RMS"
  done
  echo "M18_600S_VALIDATION_COMPLETE"
else
  echo "NO_EXPORT_ID — see poll.log for the final job state"
fi
