#!/usr/bin/env bash
# Acceptance test: unified RIISHE pipeline on the REAL 20:19 recording
# (media-store/originals/mw066petk1n38j.mp3 — "not edited(2).mp3", 1219.732s).
# One analyze action must run the complete pipeline with truthful stages;
# a re-run must reuse the cache; the export must equal original − union.
set -u
BASE=http://localhost:3000
JAR=/tmp/cj-acc.txt
SRC=/home/z/my-project/media-store/originals/mw066petk1n38j.mp3
OUT=/tmp/acc
mkdir -p "$OUT"

echo "== md5 of original before =="
md5sum "$SRC" | tee "$OUT/md5-before.txt"

echo "== login =="
curl -s -c "$JAR" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"beanfx-audit@example.com","password":"AuditPass123"}' -o "$OUT/login.json"
head -c 120 "$OUT/login.json"; echo

echo "== upload in 8 chunks =="
SIZE=$(stat -c%s "$SRC")
UPID=$(python3 -c "import secrets; print(secrets.token_hex(16))")
CHUNK=5242880
TOTAL=$(( (SIZE + CHUNK - 1) / CHUNK ))
for i in $(seq 0 $((TOTAL-1))); do
  SKIP=$((i*CHUNK)); N=$CHUNK; LEFT=$((SIZE-SKIP)); [ $LEFT -lt $N ] && N=$LEFT
  CODE=$(tail -c "$N" "$SRC" 2>/dev/null | head -c 0; dd if="$SRC" bs=1 skip=$SKIP count=$N 2>/dev/null | curl -s -b "$JAR" -o "$OUT/up-$i.json" -w "%{http_code}" \
    -X POST "$BASE/api/media" \
    -H "x-filename: not%20edited%282%29.mp3" \
    -H "x-upload-id: $UPID" -H "x-chunk-index: $i" -H "x-chunk-total: $TOTAL" -H "x-upload-size: $SIZE" \
    -H "Content-Type: application/octet-stream" --data-binary @-)
  echo "chunk $i: $CODE"
done
MEDIA_ID=$(python3 -c "import json;print(json.load(open('$OUT/up-$((TOTAL-1)).json'))['media']['id'])")
echo "MEDIA_ID=$MEDIA_ID" | tee "$OUT/media-id.txt"
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 \
  "$(python3 -c "import json;print(json.load(open('$OUT/up-$((TOTAL-1)).json'))['media']['storagePath'])" 2>/dev/null || echo /dev/null)" 2>/dev/null || true
