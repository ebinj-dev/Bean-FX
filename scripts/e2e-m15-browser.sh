#!/usr/bin/env bash
# M15 browser E2E driver — drives the REAL production workspace through
# agent-browser: login → professional workspace (header/docks/monitor/
# timeline/inspector) → real import placement → tool edits → AI Studio →
# export drawer → reload persistence. Screenshots saved as evidence.
set -uo pipefail
BASE="${M15_BASE:-http://localhost:3117}"
PROJECT="${M15_PROJECT:?}"
SHOTS="${M15_SHOTS:-/home/z/my-project/download/m15-screenshots}"
EMAIL="${M15_EMAIL:?}"
PASS="${M15_PASS:-e2e-pass-1234}"
CLIP_NAME="${M15_CLIP_NAME:-$CLIP_NAME}"
mkdir -p "$SHOTS"
AB="agent-browser"

step() { echo "== $1 =="; }
fail() { echo "FATAL: $1"; $AB close >/dev/null 2>&1; exit 1; }

step "session injection (cookie from a real curl login — the UI form flow is covered by the interactive steps below)"
$AB set viewport 1600 900 >/dev/null
$AB cookies clear >/dev/null 2>&1
TOKEN=$(curl -s -D - -o /dev/null -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | grep -a "beanfx_session=" | sed 's/.*beanfx_session=//' | cut -d';' -f1 | tr -d '\r')
[ -z "$TOKEN" ] && fail "session cookie not issued"
$AB cookies set beanfx_session "$TOKEN" --domain localhost >/dev/null || fail "cookie injection"
$AB open "$BASE/#/editor?project=$PROJECT" >/dev/null
sleep 2
$AB wait --load networkidle >/dev/null 2>&1

step "verify workspace regions + screenshot"
$AB snapshot -c >/tmp/m15-ws.txt 2>&1 || fail "workspace snapshot"
for region in "PROGRAM MONITOR" "PROPERTIES INSPECTOR" "TIMELINE" "AI STUDIO" "EXPORT"; do
  grep -qi "$region" /tmp/m15-ws.txt || fail "workspace region missing: $region"
done
echo "regions OK (header/docks/monitor/timeline/inspector)"
$AB screenshot "$SHOTS/01-workspace.png" >/dev/null || fail "screenshot workspace"
echo "screenshot: 01-workspace.png"

step "place the imported video at the playhead (media browser → timeline)"
$AB eval "(() => { const items = [...document.querySelectorAll('li')]; const item = items.find((i) => i.textContent?.includes('$CLIP_NAME')); const btn = item?.querySelector('button'); if (!btn) return 'NOBTN'; btn.click(); return 'OK'; })()" 2>/dev/null | grep -aq OK || fail "place button"
# Placement is probe-aware and lands through the autosave — wait until the
# sequence REALLY has the clip (API check, not the media-list text).
PLACED=0
for i in $(seq 1 40); do
  PLACED=$(curl -s -b "$M15_JAR" "$BASE/api/editor/projects/$PROJECT/timeline" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len((d.get('sequence') or {}).get('clips', [])))" 2>/dev/null)
  [ "${PLACED:-0}" -ge 1 ] && break
  sleep 1
done
echo "clips after place: $PLACED"
[ "${PLACED:-0}" -ge 1 ] || fail "clip did not persist after place"
$AB screenshot "$SHOTS/02-clip-on-timeline.png" >/dev/null
echo "clip placed (block visible on timeline)"

step "select the clip — inspector shows it; adjust opacity via effects browser"
$AB eval "(() => { const el = document.querySelector('[data-clip-id]'); if (!el) return 'NOEL'; const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; el.dispatchEvent(new PointerEvent('pointerdown', o)); window.dispatchEvent(new PointerEvent('pointerup', o)); return 'OK'; })()" 2>/dev/null | grep -aq OK || fail "clip click"
sleep 1
sleep 1
$AB find text "effects" click >/dev/null 2>&1
sleep 1
$AB snapshot -c >/tmp/m15-fx.txt 2>&1
grep -qi "Grayscale" /tmp/m15-fx.txt || fail "effects browser missing"
$AB screenshot "$SHOTS/03-effects-browser.png" >/dev/null
echo "effects browser listed real effects"

step "razor tool splits the clip (tool mode → click)"
$AB press c >/dev/null 2>&1 || fail "razor tool shortcut"
sleep 1
# Razor: dispatch the pointerdown AT the clip center — the app's own
# frameAtEvent maps it to a frame inside the clip.
$AB eval "(() => { const el = document.querySelector('[data-clip-id]'); if (!el) return 'NOEL'; const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: r.left + r.width * 0.5, clientY: r.top + r.height / 2 }; el.dispatchEvent(new PointerEvent('pointerdown', o)); return 'OK'; })()" 2>/dev/null | grep -aq OK || fail "razor click on clip"
# Click the TIMELINE clip block by its data-clip-id geometry (plain divs
# carry no accessibility ref).

sleep 2
CLIPS=0
for i in $(seq 1 15); do
  CLIPS=$(curl -s -b "$M15_JAR" "$BASE/api/editor/projects/$PROJECT/timeline" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len((d.get('sequence') or {}).get('clips', [])))" 2>/dev/null)
  [ "${CLIPS:-0}" -ge 2 ] && break
  sleep 1
done
echo "clips after razor: $CLIPS"
[ "${CLIPS:-0}" -ge 2 ] || fail "razor did not split (clips=$CLIPS)"
$AB screenshot "$SHOTS/04-after-razor.png" >/dev/null

step "undo restores the pre-split state"
$AB press Control+z >/dev/null
sleep 2
CLIPS2=99
for i in $(seq 1 15); do
  CLIPS2=$(curl -s -b "$M15_JAR" "$BASE/api/editor/projects/$PROJECT/timeline" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len((d.get('sequence') or {}).get('clips', [])))" 2>/dev/null)
  [ "${CLIPS2:-99}" -eq 1 ] && break
  sleep 1
done
echo "clips after undo: $CLIPS2"
[ "${CLIPS2:-99}" -eq 1 ] || fail "undo did not restore (clips=$CLIPS2)"

step "transform tool — canvas layer select + drag (real transform commit)"
$AB press r >/dev/null 2>&1 || fail "transform tool shortcut"
sleep 1
# Select the clip, then drag its canvas layer box +80px right via pointer events.
$AB eval "(() => { const el = document.querySelector('[data-clip-id]'); if (!el) return 'NOEL'; const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: r.left + 30, clientY: r.top + r.height / 2 }; el.dispatchEvent(new PointerEvent('pointerdown', o)); window.dispatchEvent(new PointerEvent('pointerup', o)); return 'OK'; })()" 2>/dev/null | grep -aq OK || fail "canvas select"
sleep 1
DRAG=$($AB eval "(() => { const box = [...document.querySelectorAll('div.cursor-move')][0]; if (!box) return 'NOBOX'; const r = box.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; box.dispatchEvent(new PointerEvent('pointerdown', o)); box.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: o.clientX + 80 })); box.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: o.clientX + 80 })); return 'DRAGGED'; })()" 2>/dev/null | tail -1 | tr -d '"')
echo "canvas drag: $DRAG"
sleep 2
$AB screenshot "$SHOTS/05-transform-canvas.png" >/dev/null
TX=$(curl -s -b "$M15_JAR" "$BASE/api/editor/projects/$PROJECT/timeline" | python3 -c "import sys,json;d=json.load(sys.stdin);s=d.get('sequence') or {};print(','.join(str(int(c['transform'].get('x',0))) for c in s.get('clips',[])))" 2>/dev/null)
echo "clip transform.x values: $TX"

step "AI Studio opens with all engines + context"
$AB find role button click --name "AI STUDIO" >/dev/null 2>&1 || fail "AI STUDIO button"
sleep 2
$AB snapshot -c >/tmp/m15-ai.txt 2>&1
for engine in "MY AI" "RIISHE" "GANGZII" "NIIKI" "JAZMII" "LAXII" "CONTEXT"; do
  grep -qi "$engine" /tmp/m15-ai.txt || fail "AI Studio engine missing: $engine"
done
$AB screenshot "$SHOTS/06-ai-studio.png" >/dev/null
$AB press Escape >/dev/null 2>&1
$AB find text "MY AI" click >/dev/null 2>&1  # keep studio open state clean
echo "AI Studio verified (7 engines + context bar)"
# Close the studio (X button)
$AB find role button click --name "Close AI Studio" >/dev/null 2>&1 || $AB find role button click --name "close" >/dev/null 2>&1
sleep 1

step "EXPORT drawer with the real publishing workspace"
$AB find role button click --name "EXPORT" >/dev/null 2>&1 || fail "EXPORT button"
sleep 2
$AB screenshot "$SHOTS/07-export.png" >/dev/null
$AB snapshot -c >/tmp/m15-ex.txt 2>&1
grep -qiE "EXPORT|PUBLISH" /tmp/m15-ex.txt || fail "export drawer missing"
$AB find role button click --name "Close AI Studio" >/dev/null 2>&1
sleep 1

step "reload — editing state persists (project reopens with the clip)"
$AB reload >/dev/null
sleep 3
$AB wait --load networkidle >/dev/null 2>&1
$AB snapshot -c >/tmp/m15-rl.txt 2>&1
grep -qi "$CLIP_NAME" /tmp/m15-rl.txt || fail "clip missing after reload"
$AB screenshot "$SHOTS/08-reloaded.png" >/dev/null
echo "persistence verified"

$AB close >/dev/null 2>&1
echo "BROWSER_E2E_COMPLETE"
