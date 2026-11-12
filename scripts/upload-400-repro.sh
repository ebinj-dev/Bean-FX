#!/usr/bin/env bash
# BEAN FX — upload 400 reproduction: direct (localhost) vs through the preview proxy.
set -u
LOCAL="http://localhost:3000"
PROXY="https://preview-chat-1c17e19e-2de2-4315-8a91-6ffa01c3b90.space-z.ai"
FILE="/tmp/not edited(2).mp3"
JA=/tmp/jar-local.txt; JB=/tmp/jar-proxy.txt
rm -f "$JA" "$JB"

echo "=== 1. generate ~37.2MB MP3 named exactly 'not edited(2).mp3' ==="
if [ ! -s "$FILE" ]; then
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:duration=2438" \
    -b:a 128k -ar 44100 -ac 2 "$FILE"
fi
ls -l "$FILE" | awk '{printf "size: %d bytes (%.1f MB)\n", $5, $5/1048576}'
ffprobe -v error -show_entries format=format_name,duration,bit_rate -of default=nw=1 "$FILE"

ENC=$(python3 -c "import urllib.parse; print(urllib.parse.quote('not edited(2).mp3', safe=\"!~*'()\"))")
echo "encoded x-filename: $ENC"

echo "=== 2. login (local + proxy) ==="
code=$(curl -s -c "$JA" -o /tmp/l1.json -w "%{http_code}" -X POST "$LOCAL/api/auth/login" \
  -H "Content-Type: application/json" -d '{"email":"beanfx-audit@example.com","password":"AuditPass123"}')
echo "local login: $code $(cat /tmp/l1.json)"
code=$(curl -s -c "$JB" -o /tmp/p1.json -w "%{http_code}" --max-time 60 -X POST "$PROXY/api/auth/login" \
  -H "Content-Type: application/json" -d '{"email":"beanfx-audit@example.com","password":"AuditPass123"}')
echo "proxy login: $code $(cat /tmp/p1.json)"

echo "=== 3. upload 37.2MB via LOCALHOST ==="
code=$(curl -s -b "$JA" -o /tmp/up-local.json -D /tmp/up-local.h -w "%{http_code}" --max-time 300 \
  -X POST "$LOCAL/api/media" -H "x-filename: $ENC" -H "Content-Type: audio/mpeg" \
  --data-binary @"$FILE")
echo "LOCAL status: $code"; cat /tmp/up-local.json | head -c 400; echo
grep -i "server:\|content-type" /tmp/up-local.h 2>/dev/null | head -3

echo "=== 4. upload 37.2MB via PROXY ==="
code=$(curl -s -b "$JB" -o /tmp/up-proxy.json -D /tmp/up-proxy.h -w "%{http_code}" --max-time 300 \
  -X POST "$PROXY/api/media" -H "x-filename: $ENC" -H "Content-Type: audio/mpeg" \
  --data-binary @"$FILE")
echo "PROXY status: $code"; cat /tmp/up-proxy.json | head -c 600; echo
echo "--- proxy response headers ---"; head -12 /tmp/up-proxy.h 2>/dev/null
