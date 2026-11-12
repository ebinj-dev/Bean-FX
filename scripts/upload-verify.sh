#!/usr/bin/env bash
# BEAN FX — upload fix verification matrix (per task §4).
set -u
BASE="http://localhost:3000"
JA=/tmp/jar-local.txt
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $1 ${2:-}"; }
enc() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=\"!~*'()\"))" "$1"; }

BIG=/tmp/audit-large.mp3

echo "=== 0. auth: login + session persists (auth-after-refresh) ==="
code=$(curl -s -c "$JA" -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" -d '{"email":"beanfx-audit@example.com","password":"AuditPass123"}')
[ "$code" = "200" ] && ok "login → 200" || bad "login" "got $code"
me=$(curl -s -b "$JA" "$BASE/api/auth/me")
echo "$me" | grep -q '"user":{"id"' && ok "session persists across 'refresh' (me → user)" || bad "session refresh" "$me"

echo "=== 1. unauthenticated upload → 401 ==="
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/media")
[ "$code" = "401" ] && ok "unauth upload → 401" || bad "unauth upload" "got $code"

echo "=== 2. small MP3 (5s) → 200 ==="
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=330:duration=5" -b:a 128k /tmp/audit-small.mp3
res=$(curl -s -b "$JA" -w "\n%{http_code}" -X POST "$BASE/api/media" \
  -H "x-filename: $(enc 'small audit clip.mp3')" -H "Content-Type: audio/mpeg" --data-binary @/tmp/audit-small.mp3)
code=$(echo "$res" | tail -1)
echo "$res" | grep -q '"audioCodec":"mp3"' && ok "small mp3 → 200, ffprobe validated" || bad "small mp3" "$(echo "$res" | head -c 200)"

echo "=== 3. exact 37.2MB 'not edited(2).mp3' → 200 ==="
res=$(curl -s -b "$JA" -w "\n%{http_code}" -X POST "$BASE/api/media" \
  -H "x-filename: $(enc 'not edited(2).mp3')" -H "Content-Type: audio/mpeg" --data-binary @"/tmp/not edited(2).mp3")
code=$(echo "$res" | tail -1)
if [ "$code" = "200" ] && echo "$res" | grep -q '"originalName":"not edited(2).mp3"'; then
  ok "exact 37.2MB 'not edited(2).mp3' → 200 + stored with original name"
else bad "37.2MB upload" "code=$code body=$(echo "$res" | head -c 200)"; fi

echo "=== 4. larger valid file (~120MB, within 250MB limit) → 200 ==="
if [ ! -s "$BIG" ] || [ "$(stat -c%s "$BIG")" -lt 100000000 ]; then
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=220:duration=3200" -b:a 320k "$BIG"
fi
sz=$(stat -c%s "$BIG"); echo "large file: $((sz/1048576)) MB"
res=$(curl -s -b "$JA" -w "\n%{http_code}" --max-time 600 -X POST "$BASE/api/media" \
  -H "x-filename: $(enc 'large audit file.mp3')" -H "Content-Type: audio/mpeg" --data-binary @"$BIG")
code=$(echo "$res" | tail -1)
[ "$code" = "200" ] && ok "large $(($sz/1048576))MB mp3 → 200" || bad "large upload" "code=$code body=$(echo "$res" | head -c 200)"

echo "=== 5. corrupt media named .mp3 → 415 + actionable JSON error ==="
head -c 1048576 /dev/urandom > /tmp/audit-corrupt.mp3
res=$(curl -s -b "$JA" -w "\n%{http_code}" -X POST "$BASE/api/media" \
  -H "x-filename: $(enc 'corrupt test.mp3')" -H "Content-Type: audio/mpeg" --data-binary @/tmp/audit-corrupt.mp3)
code=$(echo "$res" | tail -1); body=$(echo "$res" | head -1)
if [ "$code" = "415" ] && echo "$body" | grep -q '"error"'; then
  ok "corrupt file → 415 with real error: $(echo "$body" | head -c 120)"
else bad "corrupt file" "code=$code body=$(echo "$body" | head -c 200)"; fi

echo "=== 6. unsupported extension → 415 ==="
echo "not media" > /tmp/audit-file.txt
code=$(curl -s -b "$JA" -o /dev/null -w "%{http_code}" -X POST "$BASE/api/media" \
  -H "x-filename: notes.txt" -H "Content-Type: text/plain" --data-binary @/tmp/audit-file.txt)
[ "$code" = "415" ] && ok "unsupported .txt → 415" || bad "txt upload" "got $code"

echo "=== 7. uploads reach the media library ==="
lib=$(curl -s -b "$JA" "$BASE/api/media")
cnt=$(echo "$lib" | grep -o '"originalName"' | wc -l)
[ "$cnt" -ge 3 ] && ok "media library lists $cnt uploads (small + 37.2MB + large visible)" || bad "library" "$lib" | head -c 200

echo "=== 8. cleanup test uploads ==="
for id in $(echo "$lib" | grep -o '"id":"[^"]*"' | cut -d'"' -f4); do
  curl -s -b "$JA" -o /dev/null -X DELETE "$BASE/api/media/$id"
done
echo "cleaned. remaining: $(curl -s -b "$JA" "$BASE/api/media" | grep -c originalName)"
rm -f /tmp/audit-small.mp3 /tmp/audit-corrupt.mp3 "$BIG" /tmp/audit-file.txt

echo "-------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
exit $FAIL
