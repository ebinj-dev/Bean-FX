#!/usr/bin/env bash
# BEAN FX — layered gateway sweep: port 3000 (Next direct) vs port 81 (Caddy gateway).
# Captures exact status, timing, body head and response headers per size.
set -u
JA=/tmp/jar-sweep.txt
ENC_NAME="not%20edited(2).mp3"   # same percent-encoding the client uses
LOG=/home/z/my-project/dev.log

echo "=== login ==="
code=$(curl -s -c "$JA" -o /dev/null -w "%{http_code}" -X POST "http://localhost:3000/api/auth/login" \
  -H "Content-Type: application/json" -d '{"email":"beanfx-audit@example.com","password":"AuditPass123"}')
echo "login -> $code"

# size variants (truncated slices of the real 37.2MB file; sizes are gateway probes,
# a truncated file that reaches the app will 415 — which itself proves it PASSED the gateway)
mk() { head -c "$2" "/tmp/not edited(2).mp3" > "/tmp/slice_$1.mp3"; }
mk 1m   1048576
mk 8m   8388608
mk 16m  16777216
mk 32m  33554432
mk 37m2 39009009   # exact original byte size

post() { # port file label
  local port=$1 file=$2 label=$3
  local out hdr code t
  hdr=$(mktemp)
  out=$(curl -s -b "$JA" -D "$hdr" -o /tmp/resp_body -w "%{http_code} %{time_total}s" \
    -X POST "http://localhost:$port/api/media" \
    -H "x-filename: $ENC_NAME" -H "Content-Type: audio/mpeg" \
    --data-binary @"$file" --max-time 120)
  code=${out%% *}
  echo "--- [$label] $(basename "$file") ($(stat -c%s "$file")B) via port $port => $out"
  echo "    resp-head: $(grep -iE '^(HTTP|server|via|content-type|content-length|connection|cf-|x-)' "$hdr" | tr '\n' ' | ')"
  echo "    body-head: $(head -c 160 /tmp/resp_body | tr '\n' ' ')"
  rm -f "$hdr"
}

for s in 1m 8m 16m 32m 37m2; do
  post 3000 "/tmp/slice_$s.mp3" "DIRECT"
done

echo ""
echo "=== dev.log tail BEFORE caddy sweep (marker) ==="
echo "SWEEP-MARKER-$(date +%s)" >> "$LOG"

for s in 1m 8m 16m 32m 37m2; do
  post 81 "/tmp/slice_$s.mp3" "CADDY"
done

echo ""
echo "=== dev.log requests since marker (did Caddy-sweep requests reach Next?) ==="
awk '/SWEEP-MARKER-/{f=1;next} f' "$LOG" | grep -E "POST /api/media" | tail -20
echo "(all log lines since marker:)"; awk '/SWEEP-MARKER-/{f=1;next} f' "$LOG" | tail -12
