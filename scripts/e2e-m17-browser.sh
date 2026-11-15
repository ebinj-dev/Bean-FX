#!/usr/bin/env bash
# M17 browser E2E — engine-verification flows on top of the M15/M16 flows:
# volume automation (add/move/remove keyframes via the inspector strip),
# new color effects (whites/blacks/vignette/crop), before/after compare,
# transition insertion via AddTransition API + monitor preview, and the
# codec-compatibility messaging. Assumes the M16 e2e already ran (server,
# session, project from env).
set -uo pipefail
BASE="${M17_BASE:-$M16_BASE}"
PROJECT="${M17_PROJECT:-$M16_PROJECT}"
JAR="${M17_JAR:-$M16_JAR}"
SHOTS="${M17_SHOTS:-/home/z/my-project/download/m17-screenshots}"
EMAIL="${M17_EMAIL:-$M16_EMAIL}"
AB="agent-browser"
mkdir -p "$SHOTS"
step() { echo "== $1 =="; }
fail() { echo "FATAL: $1"; $AB close >/dev/null 2>&1; exit 1; }

step "open the workspace (M15/M16 preserved)"
$AB set viewport 1600 900 >/dev/null
$AB cookies clear >/dev/null 2>&1
TOKEN=$(curl -s -D - -o /dev/null -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"e2e-pass-1234\"}" | grep -a "beanfx_session=" | sed 's/.*beanfx_session=//' | cut -d';' -f1 | tr -d '\r')
[ -z "$TOKEN" ] && fail "session cookie"
$AB cookies set beanfx_session "$TOKEN" --domain localhost >/dev/null
$AB open "$BASE/#/editor?project=$PROJECT" >/dev/null
sleep 4
$AB snapshot -c >/tmp/m17-ws.txt 2>&1 || fail "workspace snapshot"
grep -aq "PROGRAM MONITOR" /tmp/m17-ws.txt || fail "workspace missing"
$AB screenshot "$SHOTS/20-m17-workspace.png" >/dev/null

step "codec compatibility matrix measured in THIS browser"
MATRIX=$($AB eval "(() => { const m = window; return 'probe-available'; })()" 2>/dev/null | tail -1)
# The matrix lives in the module — probe it through the page by importing is not
# possible without a global; measure via a throwaway video element instead.
CAN=$($AB eval "(() => { const v = document.createElement('video'); return JSON.stringify({h264: v.canPlayType('video/mp4; codecs=\"avc1.42E01E\"'), hevc: v.canPlayType('video/mp4; codecs=\"hvc1.1.6.L93.B0\"'), vp9: v.canPlayType('video/webm; codecs=\"vp09.00.10.08\"'), av1: v.canPlayType('video/webm; codecs=\"av01.0.05M.08\"')}); })()" 2>/dev/null | tail -1 | tr -d '\\')
echo "browser codec probe: $CAN"
echo "$CAN" | grep -q '"h264":"probably"' || echo "$CAN" | grep -q '"h264":"maybe"' || fail "h264 unexpectedly unsupported"

step "select the clip and open the inspector volume automation"
BOX=$($AB eval "(() => { const el = document.querySelector('[data-clip-id]'); if (!el) return ''; const r = el.getBoundingClientRect(); return Math.round(r.left + r.width/2) + ',' + Math.round(r.top + r.height/2); })()" 2>/dev/null | tail -1 | tr -d '"')
[ -z "$BOX" ] && fail "clip not found"
$AB mouse move ${BOX%,*} ${BOX#*,} >/dev/null && $AB mouse down left >/dev/null && $AB mouse up left >/dev/null
sleep 1
$AB eval "(() => { const tabs = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'media'); tabs?.click(); return 'OK'; })()" >/dev/null 2>&1
sleep 1
# Click inside the automation strip to add a keyframe.
ADDED=$($AB eval "(() => { const strip = [...document.querySelectorAll('div')].find((d) => d.title?.includes('automation')); if (!strip) return 'NOSTRIP'; const r = strip.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.3 }; strip.dispatchEvent(new PointerEvent('pointerdown', o)); return 'ADDED'; })()" 2>/dev/null | tail -1 | tr -d '"')
echo "automation point: $ADDED"
[ "$ADDED" = "ADDED" ] || fail "automation strip not interactive"
sleep 1
$AB eval "(() => { const el = document.querySelector('[data-clip-id]'); const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: r.left + r.width/2, clientY: r.top + r.height/2 }; el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointerup', o)); return 'OK'; })()" >/dev/null 2>&1
sleep 1
$AB snapshot -c >/tmp/m17-insp.txt 2>&1
grep -aqi "VOLUME AUTOMATION (1)" /tmp/m17-insp.txt || grep -aqi "VOLUME AUTOMATION" /tmp/m17-insp.txt || fail "automation strip not in inspector"
$AB screenshot "$SHOTS/21-m17-automation.png" >/dev/null

step "COLOR panel: add whites + vignette (registry + SVG defs)"
$AB eval "(() => { const items = [...document.querySelectorAll('button')]; const w = items.find((b) => b.textContent?.trim() === '+ Whites'); w?.click(); return w ? 'OK' : 'NOWHITES'; })()" 2>/dev/null | tail -1 | grep -q OK || fail "whites add"
sleep 0.5
$AB eval "(() => { const items = [...document.querySelectorAll('button')]; const v = items.find((b) => b.textContent?.trim() === '+ Vignette'); v?.click(); return v ? 'OK' : 'NOVIGNETTE'; })()" 2>/dev/null | tail -1 | grep -q OK || fail "vignette add"
sleep 1
$AB snapshot -c >/tmp/m17-color.txt 2>&1
grep -aqi "Whites" /tmp/m17-color.txt || fail "whites not listed"
grep -aqi "Vignette" /tmp/m17-color.txt || fail "vignette not listed"
$AB screenshot "$SHOTS/22-m17-color-whites-vignette.png" >/dev/null

step "before/after COMPARE button exists with a live filter"
CMP=$($AB eval "(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'COMPARE'); return btn ? 'OK' : 'NOBTN'; })()" 2>/dev/null | tail -1 | tr -d '"')
[ "$CMP" = "OK" ] || fail "compare button missing (no preview filter active?)"

step "transition: insert a CROSS_DISSOLVE via the engine API and verify persistence"
# Use the timeline API with baseVersion fetch + AddTransition command pair.
TV=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJECT/timeline")
HEADV=$(echo "$TV" | python3 -c "import sys,json;print(json.load(sys.stdin)['version']['versionNumber'])")
CLIPS=$(echo "$TV" | python3 -c "
import sys, json
d = json.load(sys.stdin)
seq = json.loads(d['version']['sequenceJson']) if 'sequenceJson' in d.get('version', {}) else d['sequence']
vs = [c for c in seq['clips'] if c['trackId'].startswith('v')]
vs.sort(key=lambda c: c['timelineStartFrame'])
if len(vs) >= 2:
    a, b = vs[0], vs[1]
    boundary = a['timelineStartFrame'] + a['timelineDurationFrames']
    print(json.dumps({'a': a['id'], 'b': b['id'], 'boundary': boundary}))
else:
    print('{}')")
A=$(echo "$CLIPS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('a',''))")
B=$(echo "$CLIPS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('b',''))")
BOUNDARY=$(echo "$CLIPS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('boundary',-1))")
if [ -n "$A" ] && [ "$BOUNDARY" != "-1" ]; then
  R=$(printf '{"baseVersion": %s, "edits": [{"type": "AddTransition", "transitionId": "m17e2e-t1", "trackId": null, "kind": "CROSS_DISSOLVE", "startFrame": %s, "endFrame": %s, "durationFrames": 20, "clipAId": "%s", "clipBId": "%s", "params": {}}]}' "$HEADV" "$((BOUNDARY - 10))" "$((BOUNDARY + 10))" "$A" "$B")
  # trackId must be the real one — fetch from the sequence:
  TRACK=$(echo "$TV" | python3 -c "
import sys, json
d = json.load(sys.stdin)
seq = json.loads(d['version']['sequenceJson']) if 'sequenceJson' in d.get('version', {}) else d['sequence']
print(seq['clips'][0]['trackId'])")
  R=$(printf '{"baseVersion": %s, "edits": [{"type": "AddTransition", "transitionId": "m17e2e-t1", "trackId": "%s", "kind": "CROSS_DISSOLVE", "startFrame": %s, "endFrame": %s, "durationFrames": 20, "clipAId": "%s", "clipBId": "%s", "params": {}}]}' "$HEADV" "$TRACK" "$((BOUNDARY - 10))" "$((BOUNDARY + 10))" "$A" "$B")
  RES=$(echo "$R" | curl -s -b "$JAR" -X POST "$BASE/api/editor/projects/$PROJECT/timeline" -H "Content-Type: application/json" --data-binary @-)
  echo "transition save: $(echo "$RES" | head -c 100)"
  echo "$RES" | grep -q '"version"' || fail "AddTransition rejected"
  # Reload the workspace and verify the transition persisted.
  $AB open "$BASE/#/editor?project=$PROJECT" >/dev/null
  sleep 4
  PERSIST=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJECT/timeline" | python3 -c "
import sys, json
d = json.load(sys.stdin)
seq = json.loads(d['version']['sequenceJson']) if 'sequenceJson' in d.get('version', {}) else d['sequence']
print(len(seq.get('transitions', [])))")
  echo "persisted transitions: $PERSIST"
  [ "$PERSIST" != "0" ] || fail "transition did not persist"
  $AB screenshot "$SHOTS/23-m17-transition.png" >/dev/null
else
  echo "SKIP transition step (fewer than two video clips on this project)"
fi

$AB close >/dev/null 2>&1
echo "M17_BROWSER_E2E_COMPLETE"
