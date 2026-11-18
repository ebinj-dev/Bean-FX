#!/bin/bash
# One validation analysis run on the canonical 20:19 recording (cmw3czehc).
# ASR chunks are disk-cached, so this reuses the existing transcription.
set -e
cd /home/z/my-project

TOKEN=$(python3 -c "
import sqlite3
db = sqlite3.connect('db/custom.db')
row = db.execute('SELECT token FROM Session ORDER BY expiresAt DESC LIMIT 1').fetchone()
print(row[0])
")

echo "Starting analysis job..."
RESP=$(curl -s -X POST http://localhost:3000/api/autocut/analyze \
  -H "Content-Type: application/json" \
  -H "Cookie: beanfx_session=$TOKEN" \
  -d '{"mediaId":"cmw3czehc0003r8vcp653yyms","settings":{"minSilenceSec":0.5,"headPaddingSec":0.15,"tailPaddingSec":0.2,"targetPauseSec":0.35,"tightenSentencePauses":true,"sensitivity":"BALANCED","builtinFillers":true,"windowMs":10},"wordsToRemove":[]}')

echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ok=', d.get('ok'), 'jobId=', d.get('jobId'), d.get('error',''))"
JOB=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('jobId',''))")
[ -z "$JOB" ] && { echo "NO JOB ID"; exit 1; }

# Poll job status up to 8 minutes.
for i in $(seq 1 96); do
  sleep 5
  ST=$(curl -s "http://localhost:3000/api/jobs/$JOB" -H "Cookie: beanfx_session=$TOKEN")
  S=$(echo "$ST" | python3 -c "import json,sys; d=json.load(sys.stdin); j=d.get('job',d); print(j.get('status',''), j.get('progress',''), j.get('stage',''))" 2>/dev/null || echo "parse-error")
  echo "[$((i*5))s] $S"
  case "$S" in
    COMPLETED*|FAILED*|*UNAVAILABLE*) break ;;
  esac
done

# If the job completed, pull the result payload summary.
curl -s "http://localhost:3000/api/jobs/$JOB" -H "Cookie: beanfx_session=$TOKEN" > /home/z/my-project/scripts/last-validation-job.json
echo "Job payload saved to scripts/last-validation-job.json"
