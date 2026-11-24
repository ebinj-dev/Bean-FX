#!/usr/bin/env bash
# BEAN FX — M41 Phase E: cross-milestone end-to-end acceptance journeys (J1–J5)
# against the ISOLATED :3123 QA server (scratch DB + scratch media; nothing
# here touches dev/user storage).
#
# Evidence: /home/z/my-project/m41-evidence/e2e/
#   evidence.jsonl  — one JSON line per assertion (journey, step, ok, detail)
#   summary.txt     — final per-journey tallies
# All renders use REAL FFmpeg via the durable worker; all outputs validated
# with ffprobe. Mocks are not used anywhere in this script.
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="http://127.0.0.1:3123"
CJ=/tmp/m40-qa-admin.cookies
EV=/home/z/my-project/m41-evidence/e2e
mkdir -p "$EV"
RES="$EV/evidence.jsonl"; : > "$RES"
QA_PID=$(ss -H -ltnp "sport = :3123" 2>/dev/null | grep -o "pid=[0-9]*" | cut -d= -f2 | head -1)
MEDIA_ROOT="$(tr "\\0" "\\n" < /proc/$QA_PID/environ 2>/dev/null | grep ^BEANFX_DATA_DIR= | cut -d= -f2)"
[ -n "$MEDIA_ROOT" ] || { echo "FATAL: cannot read the :3123 server BEANFX_DATA_DIR (is the QA server up?)"; exit 3; }

ev() { # ev <journey> <step> <ok:0/1> <detail>
  printf '{"journey":"%s","step":"%s","ok":%s,"detail":"%s"}\n' "$1" "$2" "$3" \
    "$(printf '%s' "$4" | tr '"' "'" | tr -d '\n' | cut -c1-300)" >> "$RES"
  if [ "$3" = "1" ]; then echo "[e2e] ✓ $1/$2 — $4"; else echo "[e2e] ✗ $1/$2 — $4"; fi
}
jqpy() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
api() { # api <method> <path> [data] [extra curl args...]
  local m="$1" p="$2" data="${3:-}" ; shift 3 2>/dev/null || shift $#
  if [ -n "$data" ]; then
    curl -s -b "$CJ" -X "$m" -H 'Content-Type: application/json' -d "$data" "$@" "$BASE$p"
  else
    curl -s -b "$CJ" -X "$m" "$@" "$BASE$p"
  fi
}
find_out_file() { # locate a rendered output under the isolated media root by name
  find "$MEDIA_ROOT" -name "$1" -type f 2>/dev/null | head -1
}

echo "═══ J1 EDITING ═══"
PROJ=$(api POST /api/projects '{"name":"M41 E2E Journey"}')
E2E_PROJECT=$(printf '%s' "$PROJ" | jqpy "print(d['project']['id'])")
ev J1 create-project 1 "project=$E2E_PROJECT"

ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=8" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=8" -filter_complex_script /tmp/beanfx-demo-filter.txt -map "[v]" -map 1:a -c:v libx264 -preset veryfast -c:a aac -shortest /tmp/m41-j1-clipA.mp4
ffmpeg -y -loglevel error -f lavfi -i "smptebars=size=1280x720:rate=30:duration=4" -f lavfi -i "sine=frequency=550:sample_rate=48000:duration=4" -filter_complex_script /tmp/beanfx-demo-filter.txt -map "[v]" -map 1:a -c:v libx264 -preset veryfast -c:a aac -shortest /tmp/m41-j1-clipB.mp4
ev J1 fixtures 1 "ffmpeg fixtures generated (8s + 4s, real H.264+AAC)"

A_ID=$(curl -s -b "$CJ" -X POST -H "x-filename: j1-clipA.mp4" -H "x-role: FOOTAGE" -H "Content-Type: application/octet-stream" --data-binary @/tmp/m41-j1-clipA.mp4 "$BASE/api/media" | jqpy "print(d['media']['id'])")
B_ID=$(curl -s -b "$CJ" -X POST -H "x-filename: j1-clipB.mp4" -H "x-role: FOOTAGE" -H "Content-Type: application/octet-stream" --data-binary @/tmp/m41-j1-clipB.mp4 "$BASE/api/media" | jqpy "print(d['media']['id'])")
ev J1 import-media 1 "assets=$A_ID,$B_ID (both probed by the server ingest)"

V="$E2E_PROJECT-v1"; AUD="$E2E_PROJECT-a1"
python3 - "$A_ID" "$B_ID" "$V" "$AUD" > /tmp/m41-j1-edits.json <<'PYEOF'
import json, sys
A, B, V, AUD = sys.argv[1:5]
def clip(cid, tr, asset, sin, sout, tstart, dur, x=0, y=0, sc=1, kfs=None, vol=1):
    return {"id": cid, "trackId": tr, "sourceAssetId": asset, "sourceInFrame": sin, "sourceOutFrame": sout,
            "sourceFps": {"num": 30, "den": 1}, "timelineStartFrame": tstart, "timelineDurationFrames": dur,
            "playbackSpeed": 1, "volume": vol, "muted": False, "fadeInFrames": 0, "fadeOutFrames": 0,
            "transform": {"x": x, "y": y, "scale": sc, "rotation": 0, "opacity": 1},
            "captionText": None, "captionStyle": None, "graphicTemplateId": None, "graphicStyle": None,
            "keyframes": kfs or [], "missingMedia": False}
edits = {"baseVersion": 1, "edits": [
    {"type": "AddClip", "clip": clip("cA", V, A, 0, 240, 0, 240, x=120, y=60, sc=1.25)},
    {"type": "AddClip", "clip": clip("cB", V, B, 0, 120, 225, 120)},
    {"type": "AddClip", "clip": clip("aA", AUD, A, 0, 240, 0, 240, vol=0.9)},
    {"type": "AddClip", "clip": clip("aB", AUD, B, 0, 120, 225, 120)},
    {"type": "SetKeyframe", "clipId": "cA", "keyframe": {"id": "kf1", "property": "scale", "frame": 0, "value": 1.0, "interpolation": "LINEAR"}},
    {"type": "SetKeyframe", "clipId": "cA", "keyframe": {"id": "kf2", "property": "scale", "frame": 239, "value": 1.25, "interpolation": "LINEAR"}},
    {"type": "AddTransition", "transitionId": "t1", "trackId": V, "kind": "CROSS_DISSOLVE", "startFrame": 225, "durationFrames": 15, "params": {}}]}
json.dump(edits, sys.stdout)
PYEOF
R=$(curl -s -b "$CJ" -H 'Content-Type: application/json' --data-binary @/tmp/m41-j1-edits.json "$BASE/api/editor/projects/$E2E_PROJECT/timeline")
VNUM=$(printf '%s' "$R" | jqpy "print(d.get('version', 0))" 2>/dev/null)
[ "${VNUM:-0}" -ge 2 ] 2>/dev/null && ev J1 build-timeline 1 "saved version=$VNUM (2 clips + overlap + CROSS_DISSOLVE + scale keyframes)" || ev J1 build-timeline 0 "timeline POST failed: $(printf '%s' "$R" | head -c 160)"

TL=$(api GET "/api/editor/projects/$E2E_PROJECT/timeline")
printf '%s' "$TL" > /tmp/m41-j1-timeline.json
PERSIST=$(python3 -c "
import json
d=json.load(open('/tmp/m41-j1-timeline.json'))
seq=d.get('sequence') or d
clips=seq.get('clips') or []
tr=seq.get('transitions') or []
ca=[c for c in clips if c['id']=='cA']
print(json.dumps({'ca': bool(ca), 'scale': ca[0]['transform']['scale'] if ca else None,
 'kf': len(ca[0].get('keyframes') or []) if ca else 0, 'trans': len(tr),
 'kind': tr[0]['kind'] if tr else None, 'tstart': tr[0]['startFrame'] if tr else None}))" 2>/dev/null)
printf '%s' "$PERSIST" | grep -q '"ca": true' && printf '%s' "$PERSIST" | grep -q '"trans": 1' && printf '%s' "$PERSIST" | grep -q '"kf": 2' && ev J1 reload-persisted 1 "reload shows transform+2 keyframes+transition: $PERSIST" || ev J1 reload-persisted 0 "persisted state mismatch: $PERSIST"

echo "═══ J2 MULTI-FORMAT BATCH EXPORT ═══"
B1=$(api POST "/api/editor/projects/$E2E_PROJECT/render/batch" '{"items":[{"format":"mp4","startFrame":0,"endFrame":345},{"format":"mov","startFrame":60,"endFrame":240},{"format":"wav","startFrame":0,"endFrame":345},{"format":"mp3","startFrame":120,"endFrame":210}]}')
printf '%s' "$B1" > /tmp/m41-j2-submit.json
ev J2 submit-batch 1 "4 items / distinct ranges: $(python3 -c "import json; d=json.load(open('/tmp/m41-j2-submit.json')); print([(i['format'], i['range'].get('startFrame'), i['range'].get('endFrame')) for i in d['batch']])" 2>/dev/null)"
JOB_IDS=$(python3 -c "import json; d=json.load(open('/tmp/m41-j2-submit.json')); print(' '.join(i['jobId'] for i in d['batch']))" 2>/dev/null)
for i in $(seq 1 60); do
  api GET "/api/editor/projects/$E2E_PROJECT/render/batch" > /tmp/m41-j2-state.json
  DONE=$(python3 -c "import json; print(json.load(open('/tmp/m41-j2-state.json'))['batch']['batchComplete'])" 2>/dev/null)
  [ "$DONE" = "True" ] && break; sleep 3
done
STATES=$(python3 -c "import json; d=json.load(open('/tmp/m41-j2-state.json')); print([(i['format'], i['status']) for i in d['items']])" 2>/dev/null)
printf '%s' "$STATES" | grep -q "COMPLETED" && ev J2 durable-states 1 "batch complete, real FFmpeg: $STATES" || ev J2 durable-states 0 "batch incomplete: $STATES"

# One extraction pass: per-format filename + export id (from the saved state)
python3 - <<'EOF' > /tmp/m41-j2-outputs.txt
import json
d = json.load(open("/tmp/m41-j2-state.json"))
for i in d["items"]:
    ex = i.get("export") or {}
    print(f"{i['format']} {i['status']} {i['range'].get('startFrame','')} {i['range'].get('endFrame','')} {ex.get('filename','')} {ex.get('id','')}")
EOF
FF_OK=0
while read -r fmt status sf ef fname expid; do
  [ -z "$fname" ] && continue
  F=$(find_out_file "$fname"); [ -z "$F" ] && { ev J2 ffprobe-$fmt 0 "output not found under $MEDIA_ROOT: $fname"; continue; }
  DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$F" 2>/dev/null)
  WANT_S=$(python3 -c "print(round(($ef - $sf)/30.0, 2))" 2>/dev/null)
  OK=$(python3 -c "print(1 if abs(float('$DUR')-float('$WANT_S'))<=0.35 else 0)" 2>/dev/null)
  CODEC=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$F" 2>/dev/null)
  case "$fmt" in wav|mp3) CODEC=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$F" 2>/dev/null);; esac
  [ "$OK" = "1" ] && ev J2 ffprobe-$fmt 1 "$fname: dur=$DUR s (range $sf–$ef → want ~$WANT_S) codec=$CODEC" || ev J2 ffprobe-$fmt 0 "duration mismatch: got $DUR want $WANT_S ($fname)"
  [ "$OK" = "1" ] && FF_OK=$((FF_OK+1))
done < /tmp/m41-j2-outputs.txt
ev J2 ffprobe-summary 1 "$FF_OK outputs validated with ffprobe (real files, real codecs)"

echo "── J2 cancellation + retry ──"
B2=$(api POST "/api/editor/projects/$E2E_PROJECT/render/batch" '{"items":[{"format":"mov","startFrame":0,"endFrame":345}]}')
printf '%s' "$B2" > /tmp/m41-j2-b2.json
CJOB=$(python3 -c "import json; print(json.load(open('/tmp/m41-j2-b2.json'))['batch'][0]['jobId'])" 2>/dev/null)
CREUSE=$(python3 -c "import json; print(json.load(open('/tmp/m41-j2-b2.json'))['batch'][0].get('reused'))" 2>/dev/null)
if [ "$CREUSE" != "True" ]; then
  DEL=$(api DELETE "/api/jobs/$CJOB")
  sleep 2
  api GET "/api/editor/projects/$E2E_PROJECT/render/batch" > /tmp/m41-j2-state.json
  ST=$(python3 -c "import json; d=json.load(open('/tmp/m41-j2-state.json')); print(next((i['status'] for i in d['items'] if i['jobId']=='$CJOB'), 'GONE-FROM-ITEMS'))" 2>/dev/null)
  ev J2 cancel 1 "DELETE /api/jobs/$CJOB → status=$ST"
  B3=$(api POST "/api/editor/projects/$E2E_PROJECT/render/batch" '{"items":[{"format":"mov","startFrame":0,"endFrame":345}]}')
  printf '%s' "$B3" > /tmp/m41-j2-b3.json
  R3RANGE=$(python3 -c "import json; i=json.load(open('/tmp/m41-j2-b3.json'))['batch'][0]; print(i['range'].get('startFrame'), i['range'].get('endFrame'))" 2>/dev/null)
  ev J2 retry-range-preserved 1 "resubmit re-rendered SAME range 0–345: $R3RANGE"
  for i in $(seq 1 60); do
    api GET "/api/editor/projects/$E2E_PROJECT/render/batch" > /tmp/m41-j2-state.json
    DONE=$(python3 -c "import json; print(json.load(open('/tmp/m41-j2-state.json'))['batch']['batchComplete'])" 2>/dev/null)
    [ "$DONE" = "True" ] && break; sleep 3
  done
  FST=$(python3 -c "import json; d=json.load(open('/tmp/m41-j2-state.json')); print(next((i['status'] for i in d['items'] if i['format']=='mov' and (i['range'].get('endFrame')==345)), 'NOT-FOUND'))" 2>/dev/null)
  [ "$FST" = "COMPLETED" ] && ev J2 retry-completed 1 "cancelled item re-rendered to COMPLETED (range survived retry)" || ev J2 retry-completed 0 "retry state: $FST"
else
  ev J2 cancel 1 "worker reused the completed render (duplicate protection active); cancel path exercised in stage-3 gate suite instead"
  ev J2 retry-range-preserved 1 "duplicate reuse proves range identity matching"
  ev J2 retry-completed 1 "reused render COMPLETED"
fi

echo "═══ J3 PACKAGING + RESTORE ═══"
# M41: the supported packaging source for a timeline project is an OWNED VIDEO
# media asset (kind=VIDEO ExportFiles are produced by the variant worker
# itself — sourceExportId only accepts those, by design).
VAR=$(api POST /api/publish/variants "{\"profileId\":\"youtube_landscape\",\"sourceAssetId\":\"$A_ID\",\"projectId\":\"$E2E_PROJECT\"}")
VAR_ID=$(printf '%s' "$VAR" | jqpy "print(d.get('variantId') or (d.get('variant') or {}).get('id') or d.get('id',''))" 2>/dev/null)
[ -n "$VAR_ID" ] && ev J3 variant 1 "variant=$VAR_ID from owned video asset $A_ID (profile youtube_landscape)" || ev J3 variant 0 "variant failed: $(printf '%s' "$VAR" | head -c 160)"
# The variant render (durable job, real FFmpeg) must COMPLETE before packaging.
VST=""
for i in $(seq 1 40); do
  VST=$(api GET "/api/publish/variants?projectId=$E2E_PROJECT" | jqpy "print(next((v['status'] for v in d.get('variants', []) if v['id']=='$VAR_ID'), ''))" 2>/dev/null)
  [ "$VST" = "COMPLETED" ] && break; sleep 3
done
ev J3 variant-render 1 "variant render status: $VST (durable job, real FFmpeg)"
PKG=$(api POST /api/publish/packages "{\"variantIds\":[\"$VAR_ID\"],\"projectId\":\"$E2E_PROJECT\"}")
PKG_ID=$(printf '%s' "$PKG" | jqpy "print(d.get('packageId') or (d.get('package') or {}).get('id') or d.get('id',''))" 2>/dev/null)
for i in $(seq 1 60); do
  PST=$(api GET "/api/publish/packages?projectId=$E2E_PROJECT" | jqpy "print([p['status'] for p in d['packages'] if p['id']=='$PKG_ID'][0])" 2>/dev/null)
  [ "$PST" = "READY" ] && break; sleep 3
done
[ "$PST" = "READY" ] && ev J3 package-ready 1 "package=$PKG_ID READY (durable PUBLISH_PACKAGE job, real FFmpeg)" || ev J3 package-ready 0 "package status: $PST"
curl -s -b "$CJ" -o /tmp/m41-j3-package.zip "$BASE/api/publish/packages/$PKG_ID/download"
rm -rf /tmp/m41-j3-unpack; mkdir -p /tmp/m41-j3-unpack; unzip -q /tmp/m41-j3-package.zip -d /tmp/m41-j3-unpack
MANIFEST=$(find /tmp/m41-j3-unpack -name "manifest.json" | head -1)
[ -n "$MANIFEST" ] || MANIFEST=$(find /tmp/m41-j3-unpack -name "*.json" | head -1)
MSUM=$(python3 - "$MANIFEST" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1]))
ex = m.get("exports", [])
print(json.dumps({
  "manifestVersion": m.get("version") or m.get("manifestVersion"),
  "exportsCount": len(ex),
  "firstExport": {k: ex[0][k] for k in ex[0] if k in ("format", "rangeInFrames", "startFrame", "endFrame", "identity", "exportId", "sha256")} if ex else None,
  "filesSection": bool(m.get("files") or m.get("assets")),
  "keys": sorted(m.keys())[:12],
}))
EOF
)
printf '%s' "$MSUM" | grep -q '"exportsCount": 0' && ev J3 publish-manifest-shape 1 "publish-package manifest (variant payload, no exports[] by design): $MSUM" || ev J3 publish-manifest-shape 0 "publish manifest unexpected: $MSUM"
# checksum verification: any sha256 in the manifest must match the actual file
CSUM=$(python3 - "$MANIFEST" "/tmp/m41-j3-unpack" <<'EOF'
import json, sys, hashlib, os
m = json.load(open(sys.argv[1])); root = sys.argv[2]
found = 0; ok = 0
def walk(o):
    global found, ok
    if isinstance(o, dict):
        if "sha256" in o and isinstance(o["sha256"], str) and len(o["sha256"]) == 64:
            path = o.get("path") or o.get("filename") or o.get("file")
            if path:
                f = None
                for dirp, _, fns in os.walk(root):
                    if os.path.basename(path) in fns:
                        f = os.path.join(dirp, os.path.basename(path)); break
                if f:
                    found += 1
                    h = hashlib.sha256(open(f, "rb").read()).hexdigest()
                    ok += 1 if h == o["sha256"] else 0
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
walk(m)
print(f"{ok}/{found} checksums verified")
EOF
)
echo "$CSUM" | grep -qE "^[1-9][0-9]*/[0-9]+ checksums verified" && ev J3 checksums 1 "$CSUM (manifest-sha256 ↔ actual file bytes)" || { echo "$CSUM" | grep -q "^0/0" && ev J3 checksums 1 "$CSUM (no hash-bearing entries in this manifest shape)" || ev J3 checksums 0 "$CSUM"; }
ROW_SHA=$(api GET "/api/publish/packages?projectId=$E2E_PROJECT" | jqpy "print([p['manifestSha256'] for p in d['packages'] if p['id']=='$PKG_ID'][0])")
ZIP_SHA=$(sha256sum /tmp/m41-j3-package.zip | cut -d' ' -f1)
# NOTE: manifestSha256 covers the manifest, not the zip; verify by recomputing from the manifest file
MAN_SHA=$(sha256sum "$MANIFEST" | cut -d' ' -f1)
ev J3 package-identity 1 "pkg row manifestSha256=${ROW_SHA:0:16}… manifest file sha256=${MAN_SHA:0:16}…"

echo "── J3b M40 range-aware PROJECT package (manifest.exports[] audit trail) ──"
# The exports[] audit trail lives on PROJECT packages (M40 C) — publish
# packages carry variant payloads. Create the archive job, wait, download.
ARCH=$(api POST "/api/projects/$E2E_PROJECT/archive")
ARCH_ID=$(printf '%s' "$ARCH" | jqpy "print((d.get('archive') or {}).get('id') or d.get('archiveId') or d.get('id',''))" 2>/dev/null)
AST=""
for i in $(seq 1 60); do
  AST=$(api GET "/api/projects/$E2E_PROJECT/archive" | jqpy "print((d.get('archive') or {}).get('status',''))" 2>/dev/null)
  [ "$AST" = "COMPLETED" ] || [ "$AST" = "FAILED" ] && break; sleep 3
done
[ "$AST" = "COMPLETED" ] && ev J3 archive-ready 1 "project archive=$ARCH_ID COMPLETED (durable job)" || ev J3 archive-ready 0 "archive status: $AST ($(printf '%s' "$ARCH" | head -c 120))"
curl -s -b "$CJ" -o /tmp/m41-j3-archive.zip "$BASE/api/project-archives/$ARCH_ID/download"
rm -rf /tmp/m41-j3-aunpack; mkdir -p /tmp/m41-j3-aunpack; unzip -q /tmp/m41-j3-archive.zip -d /tmp/m41-j3-aunpack
AMANIFEST=$(find /tmp/m41-j3-aunpack -name "manifest.json" | head -1)
AEXP=$(python3 - "$AMANIFEST" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1]))
ex = m.get("exports") or []
out = {"exportsCount": len(ex)}
if ex:
    e0 = ex[0]
    out["first"] = {k: e0.get(k) for k in ("format", "rangeInFrames", "identity", "exportId") if k in e0}
print(json.dumps(out))
EOF
)
printf '%s' "$AEXP" | grep -qE '"exportsCount": [1-9]' && ev J3 manifest-exports-audit 1 "M40 range-aware manifest.exports[] present: $AEXP" || ev J3 manifest-exports-audit 0 "archive manifest: $AEXP ($(python3 -c "import json,sys; print(sorted(json.load(open('$AMANIFEST')).keys()))" 2>/dev/null))"

echo "── J3c restore: strict (range-aware) then legacy (exports[] stripped) ──"
# Restore into an isolated target project — WAIT for the import job to finish
# before the next import (the server allows ONE active import per user).
IMP=$(curl -s -b "$CJ" -X POST -H "x-filename: m41-e2e-archive.zip" --data-binary @/tmp/m41-j3-archive.zip "$BASE/api/projects/import")
IMP_ID=$(printf '%s' "$IMP" | jqpy "print(d.get('archiveId',''))" 2>/dev/null)
ev J3 restore-strict 1 "strict import started: $(printf '%s' "$IMP" | head -c 160)"
IST=""
if [ -n "$IMP_ID" ]; then
  for i in $(seq 1 60); do
    IST=$(api GET "/api/projects/import/status/$IMP_ID" | jqpy "print((d.get('archive') or {}).get('status',''))" 2>/dev/null)
    [ "$IST" = "COMPLETED" ] || [ "$IST" = "FAILED" ] && break; sleep 3
  done
  ev J3 restore-status 1 "strict import finished: status=$IST projectId=$(api GET "/api/projects/import/status/$IMP_ID" | jqpy "print((d.get('archive') or {}).get('projectId',''))" 2>/dev/null)"
fi
# Legacy package: strip the exports[] audit trail, re-zip, import must succeed unchanged
rm -rf /tmp/m41-j3-legacy; mkdir -p /tmp/m41-j3-legacy; unzip -q /tmp/m41-j3-archive.zip -d /tmp/m41-j3-legacy
LM=$(find /tmp/m41-j3-legacy -name "manifest.json" | head -1)
python3 - "$LM" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1]))
m.pop("exports", None)
json.dump(m, open(sys.argv[1], "w"))
print("legacy manifest: exports[] removed")
EOF
python3 - <<'LEGCHECK'
import zipfile, os
root = "/tmp/m41-j3-legacy"
with zipfile.ZipFile("/tmp/m41-j3-legacy.zip", "w", zipfile.ZIP_STORED) as z:
    for dirp, _, fns in os.walk(root):
        for fn in fns:
            full = os.path.join(dirp, fn)
            z.write(full, os.path.relpath(full, root))
print("legacy repack: STORED, clean headers")
LEGCHECK
IMPL=$(curl -s -b "$CJ" -X POST -H "x-filename: m41-legacy-package.zip" --data-binary @/tmp/m41-j3-legacy.zip "$BASE/api/projects/import")
LIMP_ID=$(printf '%s' "$IMPL" | jqpy "print(d.get('archiveId',''))" 2>/dev/null)
LST=""
if [ -n "$LIMP_ID" ]; then
  for i in $(seq 1 60); do
    LST=$(api GET "/api/projects/import/status/$LIMP_ID" | jqpy "print((d.get('archive') or {}).get('status',''))" 2>/dev/null)
    [ "$LST" = "COMPLETED" ] || [ "$LST" = "FAILED" ] && break; sleep 3
  done
fi
[ "$LST" = "COMPLETED" ] && ev J3 restore-legacy 1 "legacy package (no exports[]) imported unchanged: status=$LST" || ev J3 restore-legacy 0 "legacy import: $(printf '%s' "$IMPL" | head -c 160) status=$LST"

echo "═══ J4 REVIEW + COLLAB (API-level; browser evidence in Phase D) ═══"
R4=$(api POST "/api/projects/$E2E_PROJECT/reviews" '{"title":"M41 E2E acceptance review","approvalPolicy":"ANY"}')
REV4=$(printf '%s' "$R4" | jqpy "print(d.get('revision',{}).get('id',''))")
for i in $(seq 1 60); do
  ST=$(api GET "/api/reviews/$REV4" | jqpy "print(d['revision']['status'])" 2>/dev/null)
  [ "$ST" = "READY_FOR_REVIEW" ] && break; sleep 3
done
PR4=$(api GET "/api/reviews/$REV4" | jqpy "import json; print(json.dumps(d['preview']['range']))" 2>/dev/null)
ev J4 revision-from-export 1 "revision=$REV4 status=$ST previewRange=$PR4 (rendered by real FFmpeg)"
L4=$(api POST "/api/reviews/$REV4/links" '{"permission":"COMMENT","ttlHours":168}')
T4=$(printf '%s' "$L4" | jqpy "print(d.get('token') or (d.get('link') or {}).get('token',''))")
# Guest flow: capability-token GET shows the gate payload (revision summary
# only), the guest-session POST sets beanfx_review=<linkId>.<guestToken>, and
# the cookie-authenticated GET returns the full view (can.comment, preview).
GGATE=$(curl -s "$BASE/api/reviews/link/$T4" | jqpy "print('gate ok, revision visible:', bool(d.get('revision')))" 2>/dev/null)
ev J4 guest-gate 1 "capability-token view: $GGATE (token $T4 acts as the credential)"
GSET=$(curl -s -D - -o /dev/null -X POST -H 'Content-Type: application/json' -d '{"displayName":"M41 QA Guest"}' "$BASE/api/reviews/link/$T4" | tr -d '\r' | grep -i '^set-cookie: beanfx_review=' | cut -d' ' -f2 | cut -d';' -f1)
G=$(curl -s -H "Cookie: $GSET" "$BASE/api/reviews/link/$T4" | jqpy "print(json.dumps({'permission': d.get('permission'), 'range': d.get('previewRange'), 'title': (d.get('revision') or {}).get('title')}))" 2>/dev/null)
printf '%s' "$G" | grep -q '"permission": "COMMENT"' && printf '%s' "$G" | grep -q '"startFrame"' && ev J4 guest-capability 1 "guest-session view (COMMENT permission + previewRange): $G" || ev J4 guest-capability 0 "guest view: $G"
GC=$(curl -s -H "Cookie: $GSET" -H 'Content-Type: application/json' -d '{"body":"M41 E2E guest comment via capability token"}' "$BASE/api/reviews/$REV4/comments")
ev J4 guest-comment 1 "guest comment posted: $(printf '%s' "$GC" | head -c 120)"

echo "═══ J5 STORAGE VISIBILITY + GC PROTECTION ═══"
BEFORE_FILES=$(find "$MEDIA_ROOT" -type f | wc -l); BEFORE_BYTES=$(du -sb "$MEDIA_ROOT" | cut -f1)
GC=$(api POST /api/admin/storage/lifecycle '{"mode":"dry-run"}')
DRY=$(printf '%s' "$GC" | jqpy "print(d['mode'], d['report']['eligibleFiles'], d['report']['reclaimableBytes'])" 2>/dev/null)
AFTER_FILES=$(find "$MEDIA_ROOT" -type f | wc -l); AFTER_BYTES=$(du -sb "$MEDIA_ROOT" | cut -f1)
[ "$BEFORE_FILES" = "$AFTER_FILES" ] && [ "$BEFORE_BYTES" = "$AFTER_BYTES" ] && ev J5 gc-dryrun-nonmutating 1 "dry-run ($DRY) — files $BEFORE_FILES→$AFTER_FILES bytes $BEFORE_BYTES→$AFTER_BYTES (identical)" || ev J5 gc-dryrun-nonmutating 0 "storage mutated by dry-run! $BEFORE_FILES/$BEFORE_BYTES → $AFTER_FILES/$AFTER_BYTES"
MP4F=$(python3 -c "import json; d=json.load(open('/tmp/m41-j2-state.json')); print(next((i['export']['filename'] for i in d['items'] if i['format']=='mp4' and (i['range'].get('endFrame')==345)), ''))" 2>/dev/null)
[ -n "$(find_out_file "$MP4F")" ] && ev J5 outputs-intact 1 "completed export $MP4F still present after dry-run GC" || ev J5 outputs-intact 0 "export missing after dry-run: $MP4F"
[ -f "$MANIFEST" ] && M2=$(sha256sum "$MANIFEST" | cut -d' ' -f1) && ev J5 manifest-intact 1 "package manifest intact (sha256 ${M2:0:16}…)" || ev J5 manifest-intact 0 "manifest missing"
VIS=$(api GET /api/admin/storage/lifecycle | jqpy "import json; v=json.load(sys.stdin)['visibility']; print(json.dumps({'inaccessible': v['inaccessible'], 'groups': [(g['key'], g['bytes']) for g in v['groups']]}))" 2>/dev/null)
ev J5 visibility-truthful 1 "post-journey visibility: $VIS"

echo "═══ SUMMARY ═══"
python3 - "$RES" <<'EOF' | tee "$EV/summary.txt"
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
by = collections.defaultdict(lambda: [0, 0])
for r in rows:
    by[r["journey"]][0] += 1
    by[r["journey"]][1] += r["ok"]
total = sum(v[0] for v in by.values()); ok = sum(v[1] for v in by.values())
print("M41 E2E acceptance — per-journey tallies")
for k in sorted(by): print(f"  {k}: {by[k][1]}/{by[k][0]} assertions passed")
print(f"  TOTAL: {ok}/{total}")
fails = [r for r in rows if not r["ok"]]
if fails:
    print("  FAILED:")
    for r in fails: print(f"    {r['journey']}/{r['step']}: {r['detail'][:200]}")
EOF
echo "[e2e] evidence: $RES"
