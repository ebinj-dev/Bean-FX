#!/bin/bash
# Phase 3 acceptance re-run — same original recording (byte copy), user's settings.
# Registers a fresh audit user, uploads a byte-identical copy of the 39MB ORIGINAL,
# re-runs RIISHE with sensitivity HIGH + the recording owner's words-to-remove list.
set -e
cd /home/z/my-project
BASE=http://localhost:81
JAR=/tmp/phase3-cookies.txt
rm -f "$JAR"

echo "== 1. register (or login) audit user =="
R=$(curl -s -c "$JAR" -X POST -H "Content-Type: application/json" \
  -d '{"email":"phase3-audit@beanfx.test","password":"Phase3-Audit-2026!","name":"Phase 3 Audit"}' \
  "$BASE/api/auth/register")
if echo "$R" | grep -q '"user"'; then echo "registered"; else
  curl -s -c "$JAR" -X POST -H "Content-Type: application/json" \
    -d '{"email":"phase3-audit@beanfx.test","password":"Phase3-Audit-2026!"}' \
    "$BASE/api/auth/login" | head -c 200; echo
fi

echo "== 2. upload byte-copy of the ORIGINAL (39MB) =="
cp media-store/originals/mw3274j8aiu1ad.mp3 /tmp/phase3-rerun-source.mp3
md5sum /tmp/phase3-rerun-source.mp3
UP=$(curl -s -b "$JAR" -X POST -H "x-filename: phase3-rerun-source.mp3" \
  -F "file=@/tmp/phase3-rerun-source.mp3;type=audio/mpeg" "$BASE/api/media")
echo "$UP" | head -c 400; echo
MEDIA_ID=$(echo "$UP" | python3 -c "import sys,json; print(json.load(sys.stdin)['asset']['id'])")
echo "MEDIA_ID=$MEDIA_ID"

echo "== 3. owner's words-to-remove list (from DB, read-only) =="
WORDS=$(python3 -c "
import sqlite3, json
con = sqlite3.connect('file:db/custom.db?mode=ro', uri=True)
rows = [r[0] for r in con.execute(\"SELECT phrase FROM WordsToRemove WHERE userId='cmw09582i0002qdk07x0pfflq' ORDER BY createdAt\").fetchall()]
print(json.dumps(rows))
")
echo "$WORDS"

echo "== 4. start analysis (sensitivity HIGH, defaults otherwise) =="
AN=$(curl -s -b "$JAR" -X POST -H "Content-Type: application/json" \
  -d "{\"mediaId\":\"$MEDIA_ID\",\"settings\":{\"sensitivity\":\"HIGH\"},\"wordsToRemove\":$WORDS}" \
  "$BASE/api/autocut/analyze")
echo "$AN"; echo
JOB_ID=$(echo "$AN" | python3 -c "import sys,json; print(json.load(sys.stdin).get('jobId',''))")
echo "JOB_ID=$JOB_ID"

echo "== 5. poll job =="
for i in $(seq 1 120); do
  ST=$(curl -s -b "$JAR" "$BASE/api/jobs/$JOB_ID")
  STATUS=$(echo "$ST" | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('job',j).get('status','?'))" 2>/dev/null || echo "?")
  MSG=$(echo "$ST" | python3 -c "import sys,json; j=json.load(sys.stdin); print((j.get('job',j).get('message') or '')[:110])" 2>/dev/null || echo "")
  echo "[$i] $STATUS :: $MSG"
  if [ "$STATUS" = "COMPLETED" ] || [ "$STATUS" = "FAILED" ]; then break; fi
  sleep 10
done
echo "FINAL_STATUS=$STATUS"
echo "MEDIA_ID=$MEDIA_ID" > /tmp/phase3-ids.txt
echo "JOB_ID=$JOB_ID" >> /tmp/phase3-ids.txt
