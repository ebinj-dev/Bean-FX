#!/usr/bin/env bash
# BEAN FX — chunked upload verification matrix (server + gateway hop).
set -u
B3000="http://localhost:3000"
B81="http://localhost:81"
JA=/tmp/jar-chunked.txt
NAME="not%20edited(2).mp3"          # exactly what the client sends
SRC="/tmp/not edited(2).mp3"
SZ=$(stat -c%s "$SRC")              # 39009009
CH=5242880                          # 5 MB chunks like the client
PASS=0; FAIL=0; IDS=()
ok()  { PASS=$((PASS+1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $1 ${2:-}"; }
post() { # port name suffix extra_headers... -> "code\nbody" via global RES
  local port=$1 label=$2; shift 2
  RES=$(curl -s -b "$JA" -w $'\n%{http_code}' -X POST "http://localhost:$port/api/media" \
    -H "x-filename: $NAME" -H "Content-Type: application/octet-stream" "$@")
  echo "--- $label => $(echo "$RES" | tail -1)"
}

echo "=== auth ==="
code=$(curl -s -c "$JA" -o /dev/null -w "%{http_code}" -X POST "$B3000/api/auth/login" \
  -H "Content-Type: application/json" -d '{"email":"beanfx-audit@example.com","password":"AuditPass123"}')
[ "$code" = "200" ] && ok "login -> 200" || bad "login" "got $code"

echo "=== split into 5MB chunks ==="
rm -rf /tmp/chunks && mkdir -p /tmp/chunks
N=0; OFF=0
while [ "$OFF" -lt "$SZ" ]; do
  REMAIN=$CH; [ $((SZ - OFF)) -lt "$CH" ] && REMAIN=$((SZ - OFF))
  dd if="$SRC" of="/tmp/chunks/c$N" bs=$CH skip=$OFF iflag=skip_bytes,count_bytes count=$REMAIN 2>/dev/null
  N=$((N+1)); OFF=$((OFF+CH))
done
echo "chunks: $N ($(for f in /tmp/chunks/c*; do stat -c%s "$f"; done | tr '\n' ' '))"

UID1="a1b2c3d4e5f60718293a4b5c6d7e8f90"
UID2="b2c3d4e5f60718293a4b5c6d7e8f90a1"
UID3="c3d4e5f60718293a4b5c6d7e8f90a1b2"

echo "=== T1 unauthenticated chunked upload -> 401 ==="
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B3000/api/media" \
  -H "x-filename: $NAME" -H "x-upload-id: $UID1" -H "x-chunk-index: 0" -H "x-chunk-total: 8" -H "x-upload-size: $SZ" \
  -H "Content-Type: application/octet-stream" --data-binary @/tmp/chunks/c0)
[ "$code" = "401" ] && ok "unauth chunk -> 401" || bad "unauth chunk" "got $code"

echo "=== T2 small single-shot unchanged (5s mp3, direct) ==="
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=330:duration=5" -b:a 128k /tmp/chunk-small.mp3
RES=$(curl -s -b "$JA" -w $'\n%{http_code}' -X POST "$B3000/api/media" \
  -H "x-filename: small%20clip.mp3" -H "Content-Type: audio/mpeg" --data-binary @/tmp/chunk-small.mp3)
code=$(echo "$RES" | tail -1)
echo "$RES" | grep -q '"audioCodec":"mp3"' && [ "$code" = "200" ] && ok "single-shot small -> 200 ffprobe-validated" || bad "single-shot small" "$code $(echo "$RES" | head -c 120)"
MID=$(echo "$RES" | head -n -1 | python3 -c "import sys,json; print(json.load(sys.stdin)['media']['id'])" 2>/dev/null)
[ -n "${MID:-}" ] && IDS+=("$MID")

echo "=== T3 exact 37.2MB chunked via port 3000 -> 200 ==="
for i in $(seq 0 6); do post 3000 "chunk $i/8" -H "x-upload-id: $UID1" -H "x-chunk-index: $i" -H "x-chunk-total: 8" -H "x-upload-size: $SZ" --data-binary @"/tmp/chunks/c$i" >/dev/null; done
post 3000 "chunk 7/8 (final)" -H "x-upload-id: $UID1" -H "x-chunk-index: 7" -H "x-chunk-total: 8" -H "x-upload-size: $SZ" --data-binary @/tmp/chunks/c7
code=$(echo "$RES" | tail -1)
if [ "$code" = "200" ] && echo "$RES" | grep -q '"originalName":"not edited(2).mp3"'; then
  ok "chunked 37.2MB -> 200, original name preserved"
else bad "chunked 3000" "$code $(echo "$RES" | head -c 160)"; fi
MID=$(echo "$RES" | head -n -1 | python3 -c "import sys,json; print(json.load(sys.stdin)['media']['id'])" 2>/dev/null)
if [ -n "${MID:-}" ]; then
  IDS+=("$MID")
  curl -s -b "$JA" -o /tmp/downloaded.mp3 "$B3000/api/media/$MID/file"
  m1=$(md5sum < "$SRC" | cut -d' ' -f1); m2=$(md5sum < /tmp/downloaded.mp3 | cut -d' ' -f1)
  [ "$m1" = "$m2" ] && ok "byte-perfect assembly (md5 $m1)" || bad "md5 mismatch" "$m1 vs $m2"
fi

echo "=== T4 exact 37.2MB chunked through Caddy :81 (gateway hop) -> 200 ==="
for i in $(seq 0 6); do
  post 81 "c81 chunk $i/8" -H "x-upload-id: $UID2" -H "x-chunk-index: $i" -H "x-chunk-total: 8" -H "x-upload-size: $SZ" --data-binary @"/tmp/chunks/c$i" >/dev/null
done
post 81 "c81 final" -H "x-upload-id: $UID2" -H "x-chunk-index: 7" -H "x-chunk-total: 8" -H "x-upload-size: $SZ" --data-binary @/tmp/chunks/c7
code=$(echo "$RES" | tail -1)
echo "$RES" | head -c 120 | grep -q '"originalName":"not edited(2).mp3"' && [ "$code" = "200" ] && ok "chunked via gateway :81 -> 200" || bad "chunked :81" "$code $(echo "$RES" | head -c 160)"
MID=$(echo "$RES" | head -n -1 | python3 -c "import sys,json; print(json.load(sys.stdin)['media']['id'])" 2>/dev/null)
[ -n "${MID:-}" ] && IDS+=("$MID")

echo "=== T5 out-of-order chunks tolerated (3 chunks sent 1, 0, then final 2) ==="
UID3="c3d4e5f60718293a4b5c6d7e8f90a1b2"
SZ3=$(( CH + CH + $(stat -c%s /tmp/chunks/c2) ))
post 3000 "T5 send index 1 first" -H "x-upload-id: $UID3" -H "x-chunk-index: 1" -H "x-chunk-total: 3" -H "x-upload-size: $SZ3" --data-binary @/tmp/chunks/c1 >/dev/null
post 3000 "T5 send index 0 second" -H "x-upload-id: $UID3" -H "x-chunk-index: 0" -H "x-chunk-total: 3" -H "x-upload-size: $SZ3" --data-binary @/tmp/chunks/c0 >/dev/null
post 3000 "T5 send index 2 (final)" -H "x-upload-id: $UID3" -H "x-chunk-index: 2" -H "x-chunk-total: 3" -H "x-upload-size: $SZ3" --data-binary @/tmp/chunks/c2
code=$(echo "$RES" | tail -1)
echo "$RES" | head -n -1 | grep -q '"originalName":"not edited(2).mp3"' && [ "$code" = "200" ] && ok "out-of-order -> 200 assembled" || bad "out-of-order" "$code $(echo "$RES" | head -c 120)"
MID=$(echo "$RES" | head -n -1 | python3 -c "import sys,json; print(json.load(sys.stdin)['media']['id'])" 2>/dev/null)
[ -n "${MID:-}" ] && IDS+=("$MID")

echo "=== T6 duplicate chunk idempotent ==="
UID4="d4e5f60718293a4b5c6d7e8f90a1b2c3"
post 3000 "T6 index 0 (a)" -H "x-upload-id: $UID4" -H "x-chunk-index: 0" -H "x-chunk-total: 2" -H "x-upload-size: $((CH*2))" --data-binary @/tmp/chunks/c0 >/dev/null
post 3000 "T6 index 0 again (overwrite)" -H "x-upload-id: $UID4" -H "x-chunk-index: 0" -H "x-chunk-total: 2" -H "x-upload-size: $((CH*2))" --data-binary @/tmp/chunks/c0 >/dev/null
post 3000 "T6 index 1 (final)" -H "x-upload-id: $UID4" -H "x-chunk-index: 1" -H "x-chunk-total: 2" -H "x-upload-size: $((CH*2))" --data-binary @/tmp/chunks/c1
code=$(echo "$RES" | tail -1)
[ "$code" = "200" ] && ok "duplicate chunk -> 200" || bad "duplicate" "$code"
MID=$(echo "$RES" | head -n -1 | python3 -c "import sys,json; print(json.load(sys.stdin)['media']['id'])" 2>/dev/null)
[ -n "${MID:-}" ] && IDS+=("$MID")

echo "=== T7 missing chunk on final -> 400 with app JSON ==="
UID5="e5f60718293a4b5c6d7e8f90a1b2c3d4"
post 3000 "T7 final without chunk 0" -H "x-upload-id: $UID5" -H "x-chunk-index: 1" -H "x-chunk-total: 2" -H "x-upload-size: $((CH*2))" --data-binary @/tmp/chunks/c1
code=$(echo "$RES" | tail -1)
echo "$RES" | grep -q '"error":"Upload incomplete: 1 of 2 chunk(s) missing."' && [ "$code" = "400" ] && ok "missing chunk -> 400 + JSON error" || bad "missing chunk" "$code $(echo "$RES" | head -c 140)"

echo "=== T8 corrupt media via chunks -> 415 ==="
head -c 1048576 /dev/urandom > /tmp/chunks/x0; head -c 1048576 /dev/urandom > /tmp/chunks/x1
UID6="f60718293a4b5c6d7e8f90a1b2c3d4e5"
post 3000 "T8 corrupt c0" -H "x-upload-id: $UID6" -H "x-chunk-index: 0" -H "x-chunk-total: 2" -H "x-upload-size: 2097152" --data-binary @/tmp/chunks/x0 >/dev/null
post 3000 "T8 corrupt c1 (final)" -H "x-upload-id: $UID6" -H "x-chunk-index: 1" -H "x-chunk-total: 2" -H "x-upload-size: 2097152" --data-binary @/tmp/chunks/x1
code=$(echo "$RES" | tail -1)
echo "$RES" | grep -q '"error"' && [ "$code" = "415" ] && ok "corrupt -> 415 + actionable JSON" || bad "corrupt" "$code $(echo "$RES" | head -c 140)"

echo "=== T9 total size over limit -> 413 ==="
UID7="0718293a4b5c6d7e8f90a1b2c3d4e5f6"
post 3000 "T9 oversize" -H "x-upload-id: $UID7" -H "x-chunk-index: 0" -H "x-chunk-total: 1" -H "x-upload-size: 268435456" --data-binary @/tmp/chunks/x0
code=$(echo "$RES" | tail -1)
echo "$RES" | grep -q 'larger than the 250 MB' && [ "$code" = "413" ] && ok "oversize -> 413" || bad "oversize" "$code"

echo "=== T10 bad upload id -> 400 ==="
post 3000 "T10 traversal id" -H "x-upload-id: ..%2F..%2Fetc" -H "x-chunk-index: 0" -H "x-chunk-total: 1" -H "x-upload-size: 100" --data-binary @/tmp/chunks/x0
code=$(echo "$RES" | tail -1)
echo "$RES" | grep -q '"error":"Invalid upload id."' && [ "$code" = "400" ] && ok "bad id -> 400" || bad "bad id" "$code"

echo "=== T11 bad chunk index -> 400 ==="
post 3000 "T11 index=9 total=8" -H "x-upload-id: 18293a4b5c6d7e8f90a1b2c3d4e5f607" -H "x-chunk-index: 9" -H "x-chunk-total: 8" -H "x-upload-size: $SZ" --data-binary @/tmp/chunks/x0
code=$(echo "$RES" | tail -1)
echo "$RES" | grep -q '"error":"Invalid chunk index or total."' && [ "$code" = "400" ] && ok "bad index -> 400" || bad "bad index" "$code"

echo "=== T12 library + tmp cleanliness ==="
lib=$(curl -s -b "$JA" "$B3000/api/media")
echo "$lib" | grep -q '"originalName":"not edited(2).mp3"' && ok "library lists 'not edited(2).mp3'" || bad "library" "missing"
leftover=$(ls media-store/tmp 2>/dev/null | grep -c "^up_" || true)
[ "$leftover" = "0" ] && ok "no leftover chunk scratch in tmp" || bad "tmp leftovers" "$leftover dirs"

echo "=== cleanup test uploads ==="
for id in "${IDS[@]:-}"; do [ -n "$id" ] && curl -s -o /dev/null -X DELETE -b "$JA" "$B3000/api/media/$id"; done
curl -s -b "$JA" "$B3000/api/media" | python3 -c "import sys,json; print('media count after cleanup:', len(json.load(sys.stdin)['media']))"
rm -rf /tmp/chunks /tmp/chunk-small.mp3 /tmp/downloaded.mp3
echo ""
echo "RESULT: PASS=$PASS FAIL=$FAIL"
