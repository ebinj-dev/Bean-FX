#!/usr/bin/env bash
# Phase 4 validation — full RIISHE re-run + approve/reject/export on the REAL
# recordings, through the live Next.js API with the audit user.
set -u
BASE=http://localhost:3000
JAR=/tmp/cj-p4.txt
OUT=/tmp/p4
mkdir -p "$OUT"
SRC=/home/z/my-project/media-store/originals/mw0958jymiuv7i.mp3        # 20:19.732 original
SRC_SHORT=/home/z/my-project/media-store/originals/mw5rppoutrhjxt.mp3  # 31.66s reference
log(){ echo "[$(date +%H:%M:%S)] $*"; }

login(){ curl -s -c "$JAR" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"beanfx-audit@example.com","password":"AuditPass123"}' -o "$OUT/login.json"; }

upload(){ # $1=file $2=name -> media id
  local SIZE=$(stat -c%s "$1")
  local UPID=$(python3 -c "import secrets;print(secrets.token_hex(16))")
  local CHUNK=5242880
  local TOTAL=$(( (SIZE + CHUNK - 1) / CHUNK ))
  local LAST=""
  for i in $(seq 0 $((TOTAL-1))); do
    local SKIP=$((i*CHUNK)) N=$CHUNK; local LEFT=$((SIZE-SKIP)); [ $LEFT -lt $N ] && N=$LEFT
    LAST="$OUT/up-$2-$i.json"
    local CODE=$(dd if="$1" bs=1 skip=$SKIP count=$N 2>/dev/null | curl -s -b "$JAR" -o "$LAST" -w "%{http_code}" \
      -X POST "$BASE/api/media" -H "x-filename: $2" -H "x-upload-id: $UPID" \
      -H "x-chunk-index: $i" -H "x-chunk-total: $TOTAL" -H "x-upload-size: $SIZE" \
      -H "Content-Type: application/octet-stream" --data-binary @-)
    case "$CODE" in 2*) ;; *) log "upload chunk $i FAILED ($CODE): $(head -c 120 "$LAST")"; return 1;; esac
  done
  python3 -c "import json;print(json.load(open('$LAST'))['media']['id'])"
}

wait_job(){ # $1=jobId $2=label -> 0 on COMPLETED
  for i in $(seq 1 240); do
    ST=$(curl -s -b "$JAR" "$BASE/api/jobs/$1" | python3 -c "import json,sys;j=json.load(sys.stdin).get('job') or {};print(j.get('status',''),j.get('progress',''),(j.get('message') or '')[:100])" 2>/dev/null)
    case "$ST" in
      COMPLETED*) log "$2 job $1 COMPLETED — $ST"; return 0;;
      FAILED*|CANCELLED*) log "$2 job $1 FAILED: $ST"; return 1;;
    esac
    [ $((i % 6)) -eq 0 ] && log "$2 ... $ST"
    sleep 5
  done
  log "$2 job $1 TIMEOUT"; return 1
}

analyze(){ # $1=mediaId $2=tag -> result file
  local JOB=$(curl -s -b "$JAR" -X POST "$BASE/api/autocut/analyze" -H "Content-Type: application/json" \
    -d "{\"mediaId\":\"$1\"}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('jobId',''))")
  [ -z "$JOB" ] && { log "analyze POST rejected for $1"; return 1; }
  log "analyze job $JOB ($2)"
  wait_job "$JOB" "analyze-$2" || return 1
  curl -s -b "$JAR" "$BASE/api/autocut/analyze/result/$JOB" -o "$OUT/result-$2.json"
  python3 - "$OUT/result-$2.json" <<'EOF'
import json, sys, collections
d = json.load(open(sys.argv[1]))
c = collections.Counter(x['review'] for x in d['candidates'])
print('  candidates:', len(d['candidates']), dict(c))
print('  plan:', json.dumps({k: (len(v) if k == 'removals' else v) for k, v in d['plan'].items()}))
print('  transcription stage:', d['stages']['transcription'], '| inference:', json.dumps(d.get('inference'))[:160])
print('  note:', (d.get('inferenceNote') or '')[:360])
for x in d['candidates']:
    if x['review'] == 'REMOVE':
        print(f"    REMOVE {x['id']} {x['start']:.2f}-{x['end']:.2f} pause={x['evidence']['pauseSec']}s rms={x['evidence']['rms']} ratio={x['evidence'].get('speechRatio')} conf={x['confidence']} :: {x['reason'][:90]}")
EOF
}

export_cuts(){ # $1=mediaId $2=cutsJSON $3=tag -> export file
  local RESP=$(curl -s -b "$JAR" -X POST "$BASE/api/process/autocut" -H "Content-Type: application/json" \
    -d "{\"mediaId\":\"$1\",\"cuts\":$2,\"outputFormat\":\"wav\"}")
  local JOB=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('jobId',''))" 2>/dev/null)
  local EST=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('estimatedFinalSec',''))" 2>/dev/null)
  [ -z "$JOB" ] && { log "apply rejected ($3): $RESP"; return 1; }
  log "apply job $JOB ($3) estimatedFinalSec=$EST"
  wait_job "$JOB" "apply-$3" || return 1
  local EXP=$(curl -s -b "$JAR" "$BASE/api/jobs/$JOB" | python3 -c "import json,sys;print(json.load(sys.stdin)['job'].get('exportId',''))")
  curl -s -b "$JAR" -o "$OUT/export-$3.wav" "$BASE/api/exports/$EXP/file"
  local DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT/export-$3.wav" 2>/dev/null)
  echo "$EXP $DUR" > "$OUT/export-$3.meta"
  log "export $3: exportId=$EXP duration=${DUR}s (estimatedFinalSec=$EST)"
}

log "== login =="; login; head -c 80 "$OUT/login.json"; echo
log "== original md5 (before) =="; md5sum "$SRC" | tee "$OUT/md5-before.txt"

log "== upload + analyze 20:19 =="
MEDIA=$(upload "$SRC" "notedited2.mp3") || exit 1
log "MEDIA=$MEDIA"
analyze "$MEDIA" "20m19" || exit 1
PLAN=$(python3 -c "import json;print(json.dumps(json.load(open('$OUT/result-20m19.json'))['plan']['removals']))")
NREM=$(python3 -c "import json;print(len(json.load(open('$OUT/result-20m19.json'))['plan']['removals']))")
log "canonical plan: $NREM interval(s)"

if [ "$NREM" -gt 0 ]; then
  log "== approve ALL proposed removals -> export A =="
  export_cuts "$MEDIA" "$PLAN" "A-all"
  log "== reject the first removal -> export B =="
  PLANB=$(python3 -c "import json;r=json.load(open('$OUT/result-20m19.json'))['plan']['removals'];print(json.dumps(r[1:]))")
  export_cuts "$MEDIA" "$PLANB" "B-reject-first"
else
  log "plan empty — approve/reject exports skipped (see note above)"
fi

log "== original md5 (after) =="; md5sum "$SRC" | tee "$OUT/md5-after.txt"

log "== upload + analyze 31.66s reference =="
MEDIA_S=$(upload "$SRC_SHORT" "reference31s.mp3") || exit 1
log "MEDIA_S=$MEDIA_S"
analyze "$MEDIA_S" "31s"

log "== durations summary =="
python3 - <<'EOF'
import json, subprocess, os
d = json.load(open('/tmp/p4/result-20m19.json'))
print(f"original durationSec = {d['durationSec']}")
for tag in ("A-all", "B-reject-first"):
    m = f"/tmp/p4/export-{tag}.meta"
    if os.path.exists(m):
        exp, dur = open(m).read().split()
        print(f"export {tag}: duration={dur}s exportId={exp}")
md5b = open('/tmp/p4/md5-before.txt').read().split()[0]
md5a = open('/tmp/p4/md5-after.txt').read().split()[0]
print(f"original md5 before={md5b[:12]} after={md5a[:12]} unchanged={md5b == md5a}")
EOF
log "== done =="
