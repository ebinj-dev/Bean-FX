#!/bin/bash
# Phase 3 acceptance — steps 3-5 with the already-uploaded media id.
set -e
cd /home/z/my-project
BASE=http://localhost:81
JAR=/tmp/phase3-cookies.txt
MEDIA_ID=cmw60k6t60006tz41uy8hjkqu

echo "== 3. owner's words-to-remove list (from DB, read-only) =="
WORDS=$(python3 -c "
import sqlite3, json
con = sqlite3.connect('file:db/custom.db?mode=ro', uri=True)
rows = [r[0] for r in con.execute(\"SELECT phrase FROM WordsToRemove WHERE userId='cmw09582i0002qdk07x0pfflq' ORDER BY createdAt\").fetchall()]
print(json.dumps(rows, ensure_ascii=False))
")
echo "$WORDS"

echo "== 4. start analysis (sensitivity HIGH, defaults otherwise) =="
AN=$(curl -s -b "$JAR" -X POST -H "Content-Type: application/json" \
  -d "{\"mediaId\":\"$MEDIA_ID\",\"settings\":{\"sensitivity\":\"HIGH\"},\"wordsToRemove\":$WORDS}" \
  "$BASE/api/autocut/analyze")
echo "$AN"
JOB_ID=$(echo "$AN" | python3 -c "import sys,json; print(json.load(sys.stdin).get('jobId',''))")
echo "JOB_ID=$JOB_ID"

echo "== 5. poll job =="
STATUS="?"
for i in $(seq 1 150); do
  ST=$(curl -s -b "$JAR" "$BASE/api/jobs/$JOB_ID")
  STATUS=$(echo "$ST" | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('job',j).get('status','?'))" 2>/dev/null || echo "?")
  MSG=$(echo "$ST" | python3 -c "import sys,json; j=json.load(sys.stdin); print((j.get('job',j).get('message') or '')[:120])" 2>/dev/null || echo "")
  echo "[$i] $STATUS :: $MSG"
  if [ "$STATUS" = "COMPLETED" ] || [ "$STATUS" = "FAILED" ]; then break; fi
  sleep 10
done
echo "FINAL_STATUS=$STATUS"
echo "JOB_ID=$JOB_ID" > /tmp/phase3-jobid.txt
