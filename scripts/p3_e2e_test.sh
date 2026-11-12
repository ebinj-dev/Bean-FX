#!/bin/bash
# P3 Phase G — end-to-end tests against an ISOLATED environment.
#
# - Isolated SQLite DB:  /home/z/my-project/.p3-test/test.db   (never the live db)
# - Isolated server:     next dev on port 3100 with DATABASE_URL pointing at the test db
# - Fixture media:       generated WAV in .p3-test/ (hash-verified untouched at the end)
# - Fixture analysis:    result JSONs named p3test* inside media-store/analysis-results/
#                        (the app reads that fixed directory; files are removed on cleanup)
# - Live database:       NOT touched by any test (no request path can reach it).
set -uo pipefail

ROOT=/home/z/my-project
T=$ROOT/.p3-test
OUT=$T/outputs
PORT=3100
BASE=http://localhost:$PORT
MEDIA_ID=p3testmedia0001aaaaaa
JOB1=p3testjob0000000001aaaa
JOB2=p3testjob0000000002bbbb
PASS=0; FAIL=0

mkdir -p "$OUT"
cd "$ROOT"

note() { echo "[$(date +%H:%M:%S)] $*"; }

# ---- check(name, expected, actual) --------------------------------------
check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS  $name  (got $actual)"; PASS=$((PASS+1)); return 0
  else
    echo "FAIL  $name  (expected $expected, got $actual)"; FAIL=$((FAIL+1)); return 1
  fi
}

contains() { # check_contains name needle file
  local name="$1" needle="$2" file="$3"
  if grep -q "$needle" "$file"; then
    echo "PASS  $name"; PASS=$((PASS+1)); return 0
  else
    echo "FAIL  $name  (missing: $needle)"; FAIL=$((FAIL+1)); return 1
  fi
}

extract_token() { # from a raw header dump -> beanfx_session value
  grep -oi 'set-cookie: beanfx_session=[^;]*' "$1" | head -1 | sed 's/.*beanfx_session=//I'
}

api() { # method url jar_out extra... -> writes headers+body to $1.out
  local method="$1" url="$2" tag="$3"; shift 3
  curl -s -o "$OUT/$tag.body" -D "$OUT/$tag.headers" -w '%{http_code}' -X "$method" \
    -H 'Content-Type: application/json' "$@" "$BASE$url"
}

# ============================ 0. fixture ==================================
note "fixture media + isolated db"
rm -rf "$T"; mkdir -p "$T" "$OUT"
ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=3" -ar 44100 -ac 1 "$T/fixture.wav" -y
FIXTURE_SHA_BEFORE=$(sha256sum "$T/fixture.wav" | cut -d' ' -f1)
echo "fixture sha256: $FIXTURE_SHA_BEFORE" | tee "$OUT/fixture_sha_before.txt"
SIZE=$(stat -c%s "$T/fixture.wav")

# isolated schema (additive-only on a FRESH file — no live data involved)
DATABASE_URL="file:$T/test.db" bunx prisma db push --skip-generate >/dev/null 2>"$OUT/dbpush.err" \
  && note "test db schema created" || { echo "FATAL: db push failed"; cat "$OUT/dbpush.err"; exit 1; }

# ============================ 1. server ===================================
note "starting isolated dev server on :$PORT (live server on :3000 stays untouched)"
DATABASE_URL="file:$T/test.db" bunx next dev -p $PORT >"$T/server.log" 2>&1 &
SRV=$!
for i in $(seq 1 90); do
  curl -s --max-time 3 -o /dev/null "$BASE/api" && break
  sleep 1
done
curl -s --max-time 10 -o "$OUT/health.body" -w '%{http_code}' "$BASE/api" | { read -r c; check "server health GET /api" 200 "$c"; }

# ============================ 2. users + fixtures =========================
c=$(api POST /api/auth/register A -c "$T/a.jar" --data-raw '{"email":"p3test-a@example.invalid","password":"p3passw0rdTEST","name":"P3 Test A"}')
check "register user A" 200 "$c"
TOKEN_A=$(extract_token "$OUT/A.headers")
c=$(api POST /api/auth/register B -c "$T/b.jar" --data-raw '{"email":"p3test-b@example.invalid","password":"p3passw0rdTEST","name":"P3 Test B"}')
check "register user B" 200 "$c"
TOKEN_B=$(extract_token "$OUT/B.headers")
[ -n "$TOKEN_A" ] && [ -n "$TOKEN_B" ] || { echo "FATAL: no session tokens"; tail -5 "$T/server.log"; kill $SRV; exit 1; }

USER_A_ID=$(python3 -c "import sqlite3,sys;con=sqlite3.connect('$T/test.db');print(con.execute(\"SELECT id FROM User WHERE email='p3test-a@example.invalid'\").fetchone()[0])")
python3 - "$T/test.db" "$USER_A_ID" "$MEDIA_ID" "$JOB1" "$JOB2" "$SIZE" <<'EOF'
import json, sqlite3, sys
db, user, media, job1, job2, size = sys.argv[1:7]
con = sqlite3.connect(db)
con.execute('INSERT INTO MediaAsset (id,userId,originalName,storagePath,kind,mimeType,sizeBytes,durationSec,audioCodec,sampleRate,channels,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)',
  (media, user, 'p3-fixture.wav', f'/home/z/my-project/.p3-test/fixture.wav', 'AUDIO', 'application/octet-stream', int(size), 3.0, 'pcm_s16le', 44100, 1))
cand = lambda i, s, e, rv, src: {"id": i, "start": s, "end": e, "duration": round(e-s,3), "reason": f"P3 fixture {i}",
  "review": rv, "confidence": 0.8, "classificationSource": src,
  "evidence": {"pauseSec": 1.0, "rms": 0.001, "snr": 5.0, "transcriptWordsInRange": 0, "intraSentence": False, "quietSpeechNearby": False, "repeatedTake": False, "floorReliable": True}}
payload = lambda cands: {"ok": True, "mediaId": media, "originalName": "p3-fixture.wav", "durationSec": 3.0, "sampleRate": 44100,
  "analysis": {"noiseFloor": 0.001, "peak": 0.5, "floorReliable": True, "speechSpanCount": 2, "windowMs": 10},
  "candidates": cands, "transcript": {"available": False, "text": "", "segments": [], "chunkCount": 0, "failedChunks": [], "warnings": [],
    "language": {"code": "unknown", "description": "unknown"}, "alignmentStats": None},
  "peaks": {"min": [0]*10, "max": [0]*10}, "notes": [], "stages": {}, "plan": {"removals": [], "removedSec": 0, "finalDurationSec": 3.0},
  "inference": None, "inferenceNote": None}
open(f'/home/z/my-project/media-store/analysis-results/{job1}.json','w').write(json.dumps(payload([
  cand('sil-1', 0.5, 0.9, 'REVIEW', 'RIISHE_INFERENCE'),
  cand('sil-2', 1.0, 1.5, 'REVIEW', 'DETERMINISTIC'),
  cand('word-1', 2.0, 2.2, 'REMOVE', 'RIISHE_INFERENCE')])))
open(f'/home/z/my-project/media-store/analysis-results/{job2}.json','w').write(json.dumps(payload([cand('sil-1', 0.5, 0.9, 'REVIEW', 'DETERMINISTIC')])))
# job1 older, job2 NEWER (analyses list must return newest first)
con.execute("INSERT INTO Job (id,userId,type,status,progress,paramsJson,createdAt,updatedAt) VALUES (?,?,?,?,1,?,?,?)",
  (job1, user, 'autocut-analysis', 'COMPLETED', json.dumps({"mediaId": media}), '2026-11-09 06:30:00', '2026-11-09 06:30:00'))
con.execute("INSERT INTO Job (id,userId,type,status,progress,paramsJson,createdAt,updatedAt) VALUES (?,?,?,?,1,?,?,?)",
  (job2, user, 'autocut-analysis', 'COMPLETED', json.dumps({"mediaId": media}), '2026-11-09 06:40:00', '2026-11-09 06:40:00'))
con.commit(); con.close()
print('fixtures inserted')
EOF

AUTH_A=(-H "Cookie: beanfx_session=$TOKEN_A")
AUTH_B=(-H "Cookie: beanfx_session=$TOKEN_B")

# ============================ 3. decision tests ===========================
note "decision persistence + scoping + ownership"
c=$(api POST /api/autocut/decisions T01 "${AUTH_A[@]}" --data-raw "{\"jobId\":\"$JOB1\",\"candidateId\":\"sil-2\",\"decision\":\"APPROVE\"}")
check "T1  save APPROVE (sil-2 @ job1)" 200 "$c"
c=$(api GET "/api/autocut/decisions?jobId=$JOB1" T02 "${AUTH_A[@]}")
check "T2  reload decisions job1" 200 "$c"
contains "T2b reloaded APPROVE is present" '"candidateId":"sil-2","decision":"APPROVE"' "$OUT/T02.body"
c=$(api POST /api/autocut/decisions T03 "${AUTH_A[@]}" --data-raw "{\"jobId\":\"$JOB1\",\"candidateId\":\"sil-1\",\"decision\":\"REJECT\"}")
check "T3  save REJECT (sil-1 @ job1)" 200 "$c"
c=$(api GET "/api/autocut/decisions?jobId=$JOB1" T04 "${AUTH_A[@]}")
contains "T4  reloaded REJECT is present" '"candidateId":"sil-1","decision":"REJECT"' "$OUT/T04.body"
c=$(api POST /api/autocut/decisions T05 "${AUTH_A[@]}" --data-raw "{\"jobId\":\"$JOB1\",\"candidateId\":\"word-1\",\"decision\":\"KEEP\"}")
check "T5  save KEEP (word-1 @ job1)" 200 "$c"
c=$(api GET "/api/autocut/decisions?jobId=$JOB2" T06 "${AUTH_A[@]}")
check "T6  other analysis has empty decisions (no inheritance)" 200 "$c"
EMPTY_OK=$(python3 -c "import json,sys;d=json.load(open('$OUT/T06.body'));print('OK' if d.get('decisions')==[] else 'BAD')")
check "T6b job2 decisions empty" "OK" "$EMPTY_OK"
c=$(api POST /api/autocut/decisions T07 "${AUTH_A[@]}" --data-raw "{\"jobId\":\"$JOB2\",\"candidateId\":\"sil-2\",\"decision\":\"APPROVE\"}")
check "T7  candidate of another analysis rejected" 400 "$c"
c=$(api POST /api/autocut/decisions T08a "${AUTH_A[@]}" --data-raw "{\"jobId\":\"$JOB1\",\"candidateId\":\"sil-2\",\"decision\":\"APPROVE\"}")
check "T8  duplicate request still 200" 200 "$c"
ROWS=$(python3 -c "import sqlite3;con=sqlite3.connect('$T/test.db');print(con.execute('SELECT COUNT(*) FROM CutDecision').fetchone()[0])")
check "T8b duplicate request creates no inconsistent row (3 unique decisions)" 3 "$ROWS"
c=$(api POST /api/autocut/decisions T09a "${AUTH_A[@]}" --data-raw '{"jobId":"p3testunknownjob000000000","candidateId":"sil-2","decision":"APPROVE"}')
check "T9  unknown analysis id rejected" 404 "$c"
c=$(api POST /api/autocut/decisions T09b "${AUTH_A[@]}" --data-raw "{\"jobId\":\"$JOB1\",\"candidateId\":\"sil-2\",\"decision\":\"DELETE_ALL\"}")
check "T9b invalid decision value rejected" 400 "$c"
c=$(api POST /api/autocut/decisions T09c "${AUTH_A[@]}" --data-raw "{\"jobId\":\"$JOB1\",\"candidateId\":\"../evil\",\"decision\":\"KEEP\"}")
check "T9c malformed candidate id rejected" 400 "$c"
c=$(api GET "/api/autocut/decisions?jobId=$JOB1" T10 "${AUTH_B[@]}")
check "T10 cross-user GET rejected" 404 "$c"
c=$(api POST /api/autocut/decisions T10b "${AUTH_B[@]}" --data-raw "{\"jobId\":\"$JOB1\",\"candidateId\":\"sil-2\",\"decision\":\"APPROVE\"}")
check "T10b cross-user POST rejected" 404 "$c"
c=$(api GET "/api/autocut/analyses?mediaId=$MEDIA_ID" T10c "${AUTH_B[@]}")
check "T10c cross-user analyses listing rejected" 404 "$c"
c=$(api GET "/api/autocut/analyses?mediaId=$MEDIA_ID" T11 "${AUTH_A[@]}")
check "T11 analyses listing" 200 "$c"
ORDER_OK=$(python3 -c "
import json,sys
d=json.load(open('$OUT/T11.body'))
ids=[a['jobId'] for a in d.get('analyses',[])]
print('OK' if ids[:2]==['$JOB2','$JOB1'] else f'BAD {ids}')")
check "T11b newest analysis first (job2, then job1)" "OK" "$ORDER_OK"
# T12: missing result file -> 410, and NOTHING is written
mv "media-store/analysis-results/$JOB1.json" "media-store/analysis-results/$JOB1.json.bak" 2>/dev/null
c=$(api POST /api/autocut/decisions T12 "${AUTH_A[@]}" --data-raw "{\"jobId\":\"$JOB1\",\"candidateId\":\"sil-1\",\"decision\":\"APPROVE\"}")
check "T12 missing result file -> failed write is NOT silent success (410)" 410 "$c"
ROWS2=$(python3 -c "import sqlite3;con=sqlite3.connect('$T/test.db');print(con.execute('SELECT COUNT(*) FROM CutDecision').fetchone()[0])")
check "T12b no row written on failed validation" 3 "$ROWS2"
mv "media-store/analysis-results/$JOB1.json.bak" "media-store/analysis-results/$JOB1.json" 2>/dev/null

# ============================ 4. export union =============================
note "export consumes only approved intervals"
# Restored client state would be: sil-1=REVIEW(rejected), sil-2=REMOVE(approved), word-1=KEEP.
# The apply union therefore contains ONLY sil-2 = [1.0,1.5).
c=$(api POST /api/process/autocut T13 "${AUTH_A[@]}" --data-raw "{\"mediaId\":\"$MEDIA_ID\",\"cuts\":[{\"start\":1.0,\"end\":1.5}],\"outputFormat\":\"wav\"}")
check "T13 apply approved-only union accepted" 200 "$c"
APPLY_JOB=$(python3 -c "import json;print(json.load(open('$OUT/T13.body'))['jobId'])" 2>/dev/null)
EST=$(python3 -c "import json;print(json.load(open('$OUT/T13.body'))['estimatedFinalSec'])" 2>/dev/null)
check "T13b estimatedFinalSec = 3.0 - 0.5" "2.5" "$EST"
FINAL=FAILED; EXPORT_ID=""
for i in $(seq 1 60); do
  code=$(api GET "/api/jobs/$APPLY_JOB" T13p "${AUTH_A[@]}")
  ST=$(python3 -c "import json;d=json.load(open('$OUT/T13p.body'));print(d['job']['status']);print(d['job'].get('exportId') or '')" 2>/dev/null)
  JST=$(echo "$ST" | head -1); JEXP=$(echo "$ST" | tail -1)
  if [ "$JST" = "COMPLETED" ]; then FINAL="OK exportId=$JEXP"; EXPORT_ID="$JEXP"; break; fi
  if [ "$JST" = "FAILED" ]; then FINAL="FAILED: $JST"; break; fi
  sleep 1
done
echo "apply job: $FINAL" | tee "$OUT/apply_result.txt"
contains "T13c apply job completed" "OK exportId=" "$OUT/apply_result.txt"
c=$(api GET "/api/exports/$EXPORT_ID/file" T13d "${AUTH_A[@]}")
check "T13d export downloads" 200 "$c"
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/T13d.body" 2>/dev/null)
note "export duration: $DUR (expect ~2.5)"
python3 -c "import sys; d=float('$DUR' or 0); sys.exit(0 if abs(d-2.5)<0.05 else 1)" \
  && { echo "PASS  T13e export duration ≈ 2.5s (only approved interval removed)"; PASS=$((PASS+1)); } \
  || { echo "FAIL  T13e export duration $DUR"; FAIL=$((FAIL+1)); }
c=$(api POST /api/process/autocut T14 "${AUTH_A[@]}" --data-raw "{\"mediaId\":\"$MEDIA_ID\",\"cuts\":[{\"start\":0.2,\"end\":1.0},{\"start\":0.5,\"end\":1.5}],\"outputFormat\":\"wav\"}")
check "T14 overlapping raw cuts rejected server-side (client union is the fix)" 400 "$c"

# ============================ 5. integrity ================================
FIXTURE_SHA_AFTER=$(sha256sum "$T/fixture.wav" | cut -d' ' -f1)
check "T15 fixture media SHA-256 unchanged" "$FIXTURE_SHA_BEFORE" "$FIXTURE_SHA_AFTER"
code=$(curl -s -o "$OUT/T16.body" -D "$OUT/T16.headers" -w '%{http_code}' "$BASE/api/autocut/decisions?jobId=$JOB1")
check "T16 unauthenticated decisions GET rejected" 401 "$code"

# ============================ done ========================================
echo "----------------------------------------"
echo "E2E RESULTS: PASS=$PASS FAIL=$FAIL"
echo "$PASS $FAIL" > "$OUT/summary.txt"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
note "isolated server stopped"
[ "$FAIL" = "0" ]
