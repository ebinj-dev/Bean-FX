#!/usr/bin/env bash
# BEAN FX — runtime audit: auth/session, upload, Range, autocut apply, validation, stale-job sweep.
# Requires: dev server on :3000, ffmpeg, ffprobe.
set -u
BASE="http://localhost:3000"
JAR="/tmp/beanfx-audit-cookies.txt"
WAV="/tmp/audit-speech.wav"
rm -f "$JAR"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $1 ${2:-}"; }

# --- test media: 8s of tone bursts separated by 1s silences -------------------
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:duration=8" \
  -af "volume='if(lt(mod(t,2),1),1,0)':eval=frame" -ac 1 -ar 16000 "$WAV"
ORIG_MD5=$(md5sum "$WAV" | cut -d' ' -f1)

# --- 1. unauthenticated request is rejected ----------------------------------
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/media")
[ "$code" = "401" ] && ok "upload without session → 401" || bad "upload without session" "got $code"

# --- 2. register + session cookie --------------------------------------------
res=$(curl -s -c "$JAR" -w "\n%{http_code}" -X POST "$BASE/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"beanfx-audit@example.com","password":"AuditPass123","name":"Audit Bot"}')
code=$(echo "$res" | tail -1)
# 200 on fresh register or 409 if the user already exists from a prior run → then login.
if [ "$code" = "200" ]; then ok "register → 200 + cookie"
elif [ "$code" = "409" ]; then
  code=$(curl -s -c "$JAR" -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth/login" \
    -H "Content-Type: application/json" -d '{"email":"beanfx-audit@example.com","password":"AuditPass123"}')
  [ "$code" = "200" ] && ok "existing user login → 200" || bad "login" "got $code"
else bad "register" "got $code"; fi

me=$(curl -s -b "$JAR" "$BASE/api/auth/me")
echo "$me" | grep -q "beanfx-audit@example.com" && ok "GET /api/auth/me with cookie returns user" || bad "auth/me" "$me"
me2=$(curl -s "$BASE/api/auth/me")
echo "$me2" | grep -q '"user":null' && ok "GET /api/auth/me without cookie → user:null" || bad "auth/me anon" "$me2"

# --- 3. upload with percent-encoded name (x-filename decode fix) -------------
res=$(curl -s -b "$JAR" -X POST "$BASE/api/media" \
  -H "x-filename: $(printf 'audit test file.wav' | jq -sRr @uri)" \
  -H "Content-Type: audio/wav" --data-binary @"$WAV")
echo "$res" | grep -q '"originalName":"audit test file.wav"' \
  && ok "x-filename percent-encoding decoded server-side" \
  || bad "x-filename decode" "$res"
MEDIA_ID=$(echo "$res" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$MEDIA_ID" ] && ok "media id returned" || { bad "media id missing" "$res"; exit 1; }

# --- 4. oversized upload → 413 ------------------------------------------------
truncate -s 263000000 /tmp/audit-big.bin
code=$(curl -s -b "$JAR" -o /dev/null -w "%{http_code}" -X POST "$BASE/api/media" \
  -H "x-filename: big.wav" -H "Content-Type: application/octet-stream" --data-binary @/tmp/audit-big.bin)
[ "$code" = "413" ] && ok "263MB upload → 413 before reading body" || bad "oversized upload" "got $code"
rm -f /tmp/audit-big.bin

# --- 5. Range requests on media file -----------------------------------------
r1=$(curl -s -b "$JAR" -o /tmp/r1.bin -D - -H "Range: bytes=0-99" "$BASE/api/media/$MEDIA_ID/file")
echo "$r1" | grep -q "206" && ok "Range 0-99 → 206" || bad "range 206" "$(echo "$r1" | head -1)"
echo "$r1" | grep -qi "Content-Range: bytes 0-99/" && ok "Content-Range correct" || bad "content-range" "$(echo "$r1" | grep -i content-range)"
[ "$(stat -c%s /tmp/r1.bin)" = "100" ] && ok "partial body = 100 bytes" || bad "partial body size" "$(stat -c%s /tmp/r1.bin)"
r2=$(curl -s -b "$JAR" -o /dev/null -D - -H "Range: bytes=-50" "$BASE/api/media/$MEDIA_ID/file")
echo "$r2" | grep -q "206" && ok "suffix range -50 → 206" || bad "suffix range" "$(echo "$r2" | head -1)"
r3=$(curl -s -b "$JAR" -o /dev/null -w "%{http_code}" -H "Range: bytes=99999999-" "$BASE/api/media/$MEDIA_ID/file")
[ "$r3" = "416" ] && ok "out-of-bounds range → 416" || bad "range 416" "got $r3"
r4=$(curl -s -b "$JAR" -o /tmp/full.bin -D - "$BASE/api/media/$MEDIA_ID/file")
echo "$r4" | grep -q "200" && ok "no-range request still 200 full body" || bad "full request" "$(echo "$r4" | head -1)"
[ "$(md5sum /tmp/full.bin | cut -d' ' -f1)" = "$ORIG_MD5" ] && ok "full body identical to source (md5)" || bad "full body md5"

# --- 6. approved cuts applied server-side -------------------------------------
plan='{"mediaId":"'$MEDIA_ID'","cuts":[{"start":1.0,"end":1.9},{"start":3.0,"end":3.9}],"outputFormat":"wav"}'
res=$(curl -s -b "$JAR" -X POST "$BASE/api/process/autocut" -H "Content-Type: application/json" -d "$plan")
JOB_ID=$(echo "$res" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')
[ -n "$JOB_ID" ] && ok "autocut job started" || bad "autocut start" "$res"

EST=$(echo "$res" | sed -n 's/.*"estimatedFinalSec":\([0-9.]*\).*/\1/p')
for i in $(seq 1 40); do
  sleep 1
  job=$(curl -s -b "$JAR" "$BASE/api/jobs/$JOB_ID")
  st=$(echo "$job" | sed -n 's/.*"status":"\([A-Z]*\)".*/\1/p')
  [ "$st" = "COMPLETED" ] && break
  [ "$st" = "FAILED" ] && break
done
[ "$st" = "COMPLETED" ] && ok "autocut job COMPLETED" || bad "autocut job" "$job"
EXPORT_ID=$(echo "$job" | sed -n 's/.*"exportId":"\([^"]*\)".*/\1/p')
curl -s -b "$JAR" -o /tmp/audit-out.wav "$BASE/api/exports/$EXPORT_ID/file"
OUT_DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/audit-out.wav 2>/dev/null)
# plan removes 1.8s of 8s → 6.2s expected
awk -v o="$OUT_DUR" 'BEGIN {exit (o>6.0 && o<6.4)?0:1}' \
  && ok "FFprobe export duration ≈ 6.2s (got $OUT_DUR)" \
  || bad "export duration" "got $OUT_DUR, expected ~6.2 (plan est $EST)"
md5sum "$WAV" | grep -q "$ORIG_MD5" && ok "original file untouched (md5)" || bad "original changed"

# --- 7. invalid plans rejected -------------------------------------------------
badplan='{"mediaId":"'$MEDIA_ID'","cuts":[{"start":1.0,"end":2.5},{"start":2.0,"end":3.0}],"outputFormat":"wav"}'
code=$(curl -s -b "$JAR" -o /dev/null -w "%{http_code}" -X POST "$BASE/api/process/autocut" -H "Content-Type: application/json" -d "$badplan")
[ "$code" = "400" ] && ok "overlapping cuts → 400" || bad "overlap rejection" "got $code"
badplan2='{"mediaId":"'$MEDIA_ID'","cuts":[{"start":7.9,"end":9.0}],"outputFormat":"wav"}'
code=$(curl -s -b "$JAR" -o /dev/null -w "%{http_code}" -X POST "$BASE/api/process/autocut" -H "Content-Type: application/json" -d "$badplan2")
[ "$code" = "400" ] && ok "cut beyond duration → 400" || bad "duration rejection" "got $code"

# --- 8. stale-job sweep ---------------------------------------------------------
node -e '
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
db.job.create({ data: { userId: process.argv[1], type: "AUDIT_STALE", status: "PROCESSING", stage: "Stale", message: null, paramsJson: "{}" } })
  .then(async (j) => { console.log(j.id); await db.$disconnect(); })
  .catch(async (e) => { console.error(e.message); process.exit(1); });
' "$(curl -s -b "$JAR" "$BASE/api/auth/me" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)" > /tmp/stale_job_id 2>/tmp/stale_err
STALE_ID=$(cat /tmp/stale_job_id)
if [ -n "$STALE_ID" ]; then
  # First jobs-route request loads job-runner → startup sweep marks it FAILED.
  sleep 1
  stale=$(curl -s -b "$JAR" "$BASE/api/jobs/$STALE_ID")
  echo "$stale" | grep -q '"status":"FAILED"' && echo "$stale" | grep -q "server restarted" \
    && ok "stale PROCESSING job swept to FAILED on module init" \
    || bad "stale sweep" "$stale"
else
  bad "stale sweep setup" "$(cat /tmp/stale_err)"
fi

# --- 9. transcribe honest failure on tone-only audio ----------------------------
code=$(curl -s -b "$JAR" -o /tmp/transcribe_out.json -w "%{http_code}" -X POST "$BASE/api/transcribe" \
  -H "Content-Type: application/json" -d '{"mediaId":"'$MEDIA_ID'"}')
[ "$code" = "422" ] && ok "transcribe of speech-less tone → 422 honest failure" || bad "transcribe 422" "got $code: $(cat /tmp/transcribe_out.json)"

echo "-------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
exit $FAIL
