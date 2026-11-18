#!/usr/bin/env bash
# Reproduce the suite's timeline POST to surface the actual 400 error body.
set -e
B=http://localhost:3117
EMAIL="m20repro-$(date +%s)@test.local"
# Suite-auth parity: ONE register with cookie jar (a second register with the
# same email returns 200 but NO Set-Cookie, leaving the jar empty).
CJ=/tmp/m20-repro-cookies.txt
REG=$(curl -s -c $CJ -X POST $B/api/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"Repro#12345\",\"name\":\"Repro\"}")
echo "register: $(echo "$REG" | head -c 120)"
c() { curl -s -b $CJ "$@"; }
PJ=$(c -X POST $B/api/projects -H 'Content-Type: application/json' -d '{"name":"Repro Seq"}')
echo "projects resp: $(echo "$PJ" | head -c 160)"
PID=$(echo "$PJ" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('project') or d)['id'])")
echo "project: $PID"
# One AddTrack + one AddClip, mirroring the suite's clip shape
BODY=$(cat <<EOF
{"baseVersion":0,"edits":[{"type":"AddTrack","track":{"id":"v1","name":"V1","kind":"VIDEO","visible":true,"muted":false,"solo":false,"locked":false}}]}
EOF
)
echo "--- AddTrack resp:"
c -X POST $B/api/editor/projects/$PID/timeline -H 'Content-Type: application/json' -d "$BODY" | head -c 300; echo
CLIP='{"id":"m0","trackId":"v1","sourceAssetId":"nope","sourceInFrame":0,"sourceOutFrame":1800,"sourceFps":{"num":30,"den":1},"timelineStartFrame":0,"timelineDurationFrames":1800,"playbackSpeed":1,"volume":1,"muted":false,"fadeInFrames":0,"fadeOutFrames":0,"transform":{"x":0,"y":0,"scale":1,"rotation":0,"opacity":1},"captionText":null,"captionStyle":null,"graphicTemplateId":null,"graphicStyle":null,"keyframes":[],"missingMedia":false}'
echo "--- AddClip resp (nonexistent asset):"
c -X POST $B/api/editor/projects/$PID/timeline -H 'Content-Type: application/json' -d "{\"baseVersion\":1,\"edits\":[{\"type\":\"AddClip\",\"clip\":$CLIP}]}" | head -c 400; echo
