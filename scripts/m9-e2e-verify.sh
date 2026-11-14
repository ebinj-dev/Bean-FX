#!/usr/bin/env bash
# M9 end-to-end HTTP verification against the live dev server (real providers).
# Exercises: profiles, presets (preview→apply→revert), media upload, thumbnail
# generation (REAL LAXII), metadata generation (REAL LLM) + approval, export
# variant (REAL ffmpeg through the durable worker), publication package
# (manifest + zip verified independently), and the honest status endpoint.
set -uo pipefail
cd "$(dirname "$0")/.."
BASE=http://127.0.0.1:3000
JAR=/tmp/m9-e2e-cookies.txt
rm -f "$JAR"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
step() { echo "── $1"; }

jsonget() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }

step "auth: register + login"
curl -s -c "$JAR" -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' -d '{"email":"m9e2e@test.local","password":"e2epass123","name":"M9 E2E"}' >/dev/null 2>&1 || true
LOGIN=$(curl -s -c "$JAR" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"m9e2e@test.local","password":"e2epass123"}')
echo "$LOGIN" | grep -q '"user"' && ok "login" || bad "login: $LOGIN"

step "project"
PROJ=$(curl -s -b "$JAR" -X POST "$BASE/api/projects" -H 'Content-Type: application/json' -d '{"name":"M9 E2E Verification","description":"Live end-to-end check"}')
PID=$(echo "$PROJ" | jsonget "['project']['id']")
[ -n "$PID" ] && ok "project created: $PID" || bad "project: $PROJ"

step "profiles registry"
PROF=$(curl -s -b "$JAR" "$BASE/api/publish/profiles")
PCOUNT=$(echo "$PROF" | jsonget "['profiles'].__len__()")
PVER=$(echo "$PROF" | jsonget "['version']")
[ "$PCOUNT" = "7" ] && ok "7 profiles served (registry $PVER)" || bad "profiles count=$PCOUNT"

step "brand presets: create → preview → apply → revert → delete"
PRESET=$(curl -s -b "$JAR" -X POST "$BASE/api/publish/presets" -H 'Content-Type: application/json' -d '{"name":"E2E Brand","brandName":"E2E Studio","primaryColor":"#d4a017","secondaryColor":"#111111","fontFamily":"inter","defaultExportProfile":"youtube_shorts"}')
PRESET_ID=$(echo "$PRESET" | jsonget "['preset']['id']")
[ -n "$PRESET_ID" ] && ok "preset created" || bad "preset create: $PRESET"
DUP=$(curl -s -b "$JAR" -X POST "$BASE/api/publish/presets/$PRESET_ID")
DUP_ID=$(echo "$DUP" | jsonget "['preset']['id']")
[ -n "$DUP_ID" ] && ok "preset duplicated" || bad "duplicate: $DUP"
curl -s -b "$JAR" -X DELETE "$BASE/api/publish/presets/$DUP_ID" >/dev/null && ok "duplicate deleted" || bad "duplicate delete"
PREVIEW=$(curl -s -b "$JAR" "$BASE/api/publish/presets/$PRESET_ID/apply?projectId=$PID")
echo "$PREVIEW" | grep -q '"keysWritten"' && ok "apply preview served" || bad "preview: $PREVIEW"
APPLY=$(curl -s -b "$JAR" -X POST "$BASE/api/publish/presets/$PRESET_ID/apply" -H 'Content-Type: application/json' -d "{\"projectId\":\"$PID\",\"confirm\":\"apply\"}")
echo "$APPLY" | grep -q '"applied":true' && ok "preset applied additively" || bad "apply: $APPLY"
REVERT=$(curl -s -b "$JAR" -X DELETE "$BASE/api/publish/presets/$PRESET_ID/apply?projectId=$PID")
echo "$REVERT" | grep -q '"reverted":true' && ok "apply reverted" || bad "revert: $REVERT"

step "media upload (tiny mp4 master)"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=s=320x180:d=2" -f lavfi -i "sine=frequency=440:duration=2" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac /tmp/m9-e2e-master.mp4 2>/dev/null
UP=$(curl -s -b "$JAR" -X POST "$BASE/api/media" -H "x-filename: m9e2e_master.mp4" -H "Content-Type: video/mp4" --data-binary @/tmp/m9-e2e-master.mp4)
MEDIA_ID=$(echo "$UP" | jsonget "['media']['id']")
[ -n "$MEDIA_ID" ] && ok "master uploaded: $MEDIA_ID" || bad "upload: $(echo $UP | head -c 200)"

step "thumbnail studio: draft → REAL LAXII generate → select → composite"
TD=$(curl -s -b "$JAR" -X POST "$BASE/api/publish/thumbnails" -H 'Content-Type: application/json' -d "{\"projectId\":\"$PID\",\"platform\":\"youtube_shorts\"}")
DRAFT_ID=$(echo "$TD" | jsonget "['draft']['id']")
[ -n "$DRAFT_ID" ] && ok "draft ensured" || bad "draft: $TD"
GEN=$(curl -s -b "$JAR" -X POST "$BASE/api/publish/thumbnails/$DRAFT_ID/generate" -H 'Content-Type: application/json' -d '{"count":1,"prompt":"golden sunrise over coffee, vivid"}')
[ "$(echo "$GEN" | jsonget "['jobId']")" != "None" ] && ok "LAXII generation job queued" || bad "generate: $GEN"
for i in $(seq 1 90); do
  D=$(curl -s -b "$JAR" "$BASE/api/publish/thumbnails/$DRAFT_ID")
  ST=$(echo "$D" | jsonget "['draft']['status']")
  [ "$ST" = "READY" ] || [ "$ST" = "FAILED" ] && break
  sleep 2
done
if [ "$ST" = "READY" ]; then ok "LAXII thumbnails READY"; else bad "thumbnail status=$ST $(echo "$D" | jsonget "['draft']['error']")"; fi
CAND=$(echo "$D" | jsonget "['candidates'][0]['id']")
SEL=$(curl -s -b "$JAR" -X PATCH "$BASE/api/publish/thumbnails/$DRAFT_ID" -H 'Content-Type: application/json' -d "{\"selectedAssetId\":\"$CAND\"}")
echo "$SEL" | grep -q '"ok":true' && ok "base selected" || bad "select: $SEL"
COMP=$(curl -s -b "$JAR" -X POST "$BASE/api/publish/thumbnails/$DRAFT_ID/composite" -H 'Content-Type: application/json' -d '{"layout":{"title":"Morning Brew","position":"bottom","align":"center","fontScale":0.1,"backdrop":"band","shadow":true}}')
COMP_ID=$(echo "$COMP" | jsonget "['assetId']")
[ -n "$COMP_ID" ] && ok "overlay composited to NEW asset $COMP_ID" || bad "composite: $COMP"

step "metadata: REAL LLM generate → edit → approve"
MD=$(curl -s -b "$JAR" -X POST "$BASE/api/publish/metadata" -H 'Content-Type: application/json' -d "{\"projectId\":\"$PID\",\"platform\":\"youtube_shorts\",\"language\":\"en\"}")
MD_ID=$(echo "$MD" | jsonget "['metadata']['id']")
MD_TITLE=$(echo "$MD" | jsonget "['metadata']['draft']['fields']['title']")
[ -n "$MD_ID" ] && ok "metadata generated (title: ${MD_TITLE:0:50})" || bad "metadata: $(echo $MD | head -c 200)"
APPR=$(curl -s -b "$JAR" -X PATCH "$BASE/api/publish/metadata/$MD_ID" -H 'Content-Type: application/json' -d '{"approved":{"title":"Morning Brew — 60s brew guide","description":"Brew filter coffee the quick way.","keywords":["coffee","brew"],"hashtags":["#coffee","#brew"],"chapters":[],"summary":"A quick brew guide.","platformDescription":"Quick brew for Shorts.","callToAction":"Follow for more."}}')
echo "$APPR" | grep -q '"status":"APPROVED"' && ok "metadata USER-APPROVED" || bad "approve: $APPR"

step "export variant: REAL ffmpeg through the durable worker"
VAR=$(curl -s -b "$JAR" -X POST "$BASE/api/publish/variants" -H 'Content-Type: application/json' -d "{\"profileId\":\"youtube_landscape\",\"projectId\":\"$PID\",\"sourceAssetId\":\"$MEDIA_ID\"}")
VAR_ID=$(echo "$VAR" | jsonget "['variantId']")
[ -n "$VAR_ID" ] && ok "variant queued" || bad "variant create: $VAR"
for i in $(seq 1 90); do
  V=$(curl -s -b "$JAR" "$BASE/api/publish/variants/$VAR_ID")
  VS=$(echo "$V" | jsonget "['variant']['status']")
  [ "$VS" = "COMPLETED" ] || [ "$VS" = "FAILED" ] && break
  sleep 2
done
RESULT_ID=$(echo "$V" | jsonget "['variant']['resultExportId']")
[ "$VS" = "COMPLETED" ] && ok "variant COMPLETED → export $RESULT_ID" || bad "variant status=$VS $(echo "$V" | jsonget "['variant']['error']")"
VAL=$(echo "$V" | jsonget "['variant']['validation']['ok']")
[ "$VAL" = "True" ] && ok "conformance validation ok" || bad "validation: $VAL"

step "publication package: build → download → independent verification"
PKG=$(curl -s -b "$JAR" -X POST "$BASE/api/publish/packages" -H 'Content-Type: application/json' -d "{\"variantIds\":[\"$VAR_ID\"],\"projectId\":\"$PID\",\"metadataId\":\"$MD_ID\",\"thumbnailDraftId\":\"$DRAFT_ID\"}")
PKG_ID=$(echo "$PKG" | jsonget "['packageId']")
[ -n "$PKG_ID" ] && ok "package queued" || bad "package create: $PKG"
for i in $(seq 1 60); do
  P=$(curl -s -b "$JAR" "$BASE/api/publish/packages/$PKG_ID")
  PS=$(echo "$P" | jsonget "['package']['status']")
  [ "$PS" = "READY" ] || [ "$PS" = "FAILED" ] && break
  sleep 2
done
if [ "$PS" = "READY" ]; then ok "package READY ($(echo "$P" | jsonget "['package']['sizeBytes']") bytes)"; else bad "package status=$PS $(echo "$P" | jsonget "['package']['error']")"; fi
curl -s -b "$JAR" -o /tmp/m9-e2e-package.zip "$BASE/api/publish/packages/$PKG_ID/download"
ZIPCHECK=$(python3 -c "import zipfile,json;z=zipfile.ZipFile('/tmp/m9-e2e-package.zip');assert z.testzip() is None;m=json.loads(z.read('manifest.json'));print(','.join(sorted(z.namelist())));print('META_APPROVED' if m['metadata']['status']=='USER-APPROVED' else 'META_MISSING')" 2>&1)
echo "$ZIPCHECK" | grep -q "manifest.json" && ok "zip verified independently: $(echo "$ZIPCHECK" | head -1)" || bad "zip check: $ZIPCHECK"
echo "$ZIPCHECK" | grep -q "META_APPROVED" && ok "manifest carries USER-APPROVED metadata only" || bad "manifest metadata state"
python3 -c "
import zipfile,json,hashlib
z=zipfile.ZipFile('/tmp/m9-e2e-package.zip');m=json.loads(z.read('manifest.json'))
allok=all(f['sha256']==hashlib.sha256(z.read(f['path'])).hexdigest() for f in m['files'])
print('SHA_OK' if allok else 'SHA_BAD')" | grep -q SHA_OK && ok "every manifest sha256 matches file bytes" || bad "sha verification"

step "status honesty"
STATUS=$(curl -s -b "$JAR" "$BASE/api/publish/status")
YT_OP=$(echo "$STATUS" | jsonget "['publishingIntegrations'][0]['operational']")
LLM_AVAIL=$(echo "$STATUS" | jsonget "['engines']['metadataGeneration']['available']")
[ "$YT_OP" = "False" ] && ok "publishing integrations honestly not-operational" || bad "integration status"
[ "$LLM_AVAIL" = "True" ] && ok "LLM engine reported available" || bad "llm status"

step "ownership: unauthenticated request refused"
NOAUTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/publish/variants")
[ "$NOAUTH" = "401" ] && ok "401 without session" || bad "no-auth status=$NOAUTH"

echo "════════════════════════════════════"
echo "E2E RESULT: $PASS passed, $FAIL failed"
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
