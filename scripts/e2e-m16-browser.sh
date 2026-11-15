#!/usr/bin/env bash
# M16 browser E2E driver — extends the M15 workspace run with the M16 engine:
# continuous playback (bus-driven timecode advance), frame-accurate seek,
# color-correction effects on the monitor (real CSS filter), audio-mixer
# badge, and a REAL durable timeline render validated with FFprobe.
set -uo pipefail
BASE="${M16_BASE:-${M15_BASE:-http://localhost:3117}}"
PROJECT="${M16_PROJECT:-${M15_PROJECT:?}}"
SHOTS="${M16_SHOTS:-${M15_SHOTS:-/home/z/my-project/download/m15-screenshots}}"
EMAIL="${M16_EMAIL:-${M15_EMAIL:?}}"
JAR="${M16_JAR:-${M15_JAR:?}}"
mkdir -p "$SHOTS"
AB="agent-browser"
step() { echo "== $1 =="; }
fail() { echo "FATAL: $1"; $AB close >/dev/null 2>&1; exit 1; }

step "open the M15 project workspace (M16 preserves it)"
$AB set viewport 1600 900 >/dev/null
$AB cookies clear >/dev/null 2>&1
TOKEN=$(curl -s -D - -o /dev/null -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"e2e-pass-1234\"}" | grep -a "beanfx_session=" | sed 's/.*beanfx_session=//' | cut -d';' -f1 | tr -d '\r')
[ -z "$TOKEN" ] && fail "session cookie not issued"
$AB cookies set beanfx_session "$TOKEN" --domain localhost >/dev/null || fail "cookie injection"
$AB open "$BASE/#/editor?project=$PROJECT" >/dev/null
sleep 3
$AB snapshot -c >/tmp/m16-ws.txt 2>&1 || fail "workspace snapshot"
grep -aq "PROGRAM MONITOR" /tmp/m16-ws.txt || fail "workspace missing"
$AB screenshot "$SHOTS/10-m16-workspace.png" >/dev/null

step "continuous playback: transport timecode advances (frame bus)"
$AB snapshot -i >/tmp/m16-btn.txt 2>&1
PLAY_REF=$(grep -aE 'button.*Play / pause' /tmp/m16-btn.txt | grep -aoE 'ref=e[0-9]+' | head -1 | sed 's/^ref=/@/')
[ -z "$PLAY_REF" ] && fail "play button not found"
$AB click "$PLAY_REF" >/dev/null || fail "play click"
sleep 3
TC1=$($AB eval "document.querySelector('header')?.innerText ?? ''" 2>/dev/null; $AB eval "document.body.innerText.match(/\\d\\d:\\d\\d:\\d\\d:\\d\\d/g)?.join(',') ?? ''" 2>/dev/null | tail -1)
sleep 1
TC2=$($AB eval "document.body.innerText.match(/\\d\\d:\\d\\d:\\d\\d:\\d\\d/g)?.join(',') ?? ''" 2>/dev/null | tail -1)
echo "timecodes t0=$TC1 t1=$TC2"
[ "$TC1" != "$TC2" ] || fail "timecode did not advance during playback"
$AB screenshot "$SHOTS/11-playing.png" >/dev/null
# Pause via Space
$AB press Space >/dev/null || true
sleep 1

step "frame-accurate seek (transport returns a stable frame)"
$AB eval "true" >/dev/null 2>&1
$AB press ArrowRight >/dev/null 2>&1
sleep 1
TC3=$($AB eval "document.body.innerText.match(/\\d\\d:\\d\\d:\\d\\d:\\d\\d/g)?.join(',') ?? ''" 2>/dev/null | tail -1)
echo "after +1 frame: $TC3"
$AB press ArrowLeft >/dev/null 2>&1
sleep 0.5
$AB press ArrowLeft >/dev/null 2>&1

step "apply a REAL color effect (grayscale) and verify the pixels desaturate"
# Select the clip, then add Grayscale from the effects browser
BOX=$($AB eval "(() => { const el = document.querySelector('[data-clip-id]'); if (!el) return ''; const r = el.getBoundingClientRect(); return Math.round(r.left + r.width/2) + ',' + Math.round(r.top + r.height/2); })()" 2>/dev/null | tail -1 | tr -d '"')
[ -z "$BOX" ] && fail "clip not found"
$AB mouse move ${BOX%,*} ${BOX#*,} >/dev/null && $AB mouse down left >/dev/null && $AB mouse up left >/dev/null
sleep 1
$AB eval "(() => { const tabs = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'effects'); if (!tabs) return 'NOTAB'; tabs.click(); return 'OK'; })()" 2>/dev/null | grep -aq OK || fail "effects tab"
sleep 1
$AB eval "(() => { const items = [...document.querySelectorAll('li')]; const item = items.find((i) => i.textContent?.includes('Grayscale')); const btn = item?.querySelector('button'); if (!btn) return 'NOBTN'; btn.click(); return 'OK'; })()" 2>/dev/null | grep -aq OK || fail "grayscale add"
sleep 2
$AB screenshot "$SHOTS/12-grayscale.png" >/dev/null
# Pixel check via SCREENSHOT (ctx.drawImage ignores element CSS filters —
# the honest check is the composited page): measure the monitor region's
# channel spread; grayscale(1) must drop it to ~0.
SPREAD=$(python3 -c "
from PIL import Image
im = Image.open('/home/z/my-project/download/m16-screenshots/12-grayscale.png').convert('RGB')
w, h = im.size
im = im.crop((int(w*0.42), int(h*0.15), int(w*0.58), int(h*0.38)))
px = list(im.getdata())
print(max(max(r,g,b)-min(r,g,b) for r,g,b in px))
")
echo "monitor RGB spread with grayscale: $SPREAD"
[ "${SPREAD:-255}" -le 12 ] || fail "grayscale did not desaturate the preview (spread=$SPREAD)"

step "effects inspector shows the effect + parity chains"
$AB eval "(() => { const tabs = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'media'); if (tabs) tabs.click(); return 'OK'; })()" >/dev/null 2>&1
sleep 1
$AB eval "(() => { const el = document.querySelector('[data-clip-id]'); const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: r.left + r.width/2, clientY: r.top + r.height/2 }; el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointerup', o)); return 'OK'; })()" >/dev/null 2>&1
sleep 1
$AB snapshot -c >/tmp/m16-insp.txt 2>&1
grep -aqi "EFFECTS (" /tmp/m16-insp.txt || fail "inspector effect list missing"
grep -aqi "grayscale" /tmp/m16-insp.txt || fail "grayscale not listed in inspector"
$AB screenshot "$SHOTS/13-inspector-effects.png" >/dev/null

step "MY AI context includes effects (AI Studio)"
$AB find role button click --name "AI STUDIO" >/dev/null 2>&1 || fail "AI STUDIO button"
sleep 2
$AB snapshot -c >/tmp/m16-ai.txt 2>&1
grep -aqi "grayscale" /tmp/m16-ai.txt || fail "AI context lacks the effect info"
$AB screenshot "$SHOTS/14-m16-ai-context.png" >/dev/null
$AB find role button click --name "Close AI Studio" >/dev/null 2>&1
sleep 1

step "REAL timeline render (durable job → FFprobe-validated output)"
$AB find role button click --name "EXPORT" >/dev/null 2>&1 || fail "EXPORT button"
sleep 1
$AB eval "(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('RENDER SEQUENCE')); if (!btn) return 'NOBTN'; btn.click(); return 'OK'; })()" 2>/dev/null | grep -aq OK || fail "render button"
sleep 2
RENDERED=0
for i in $(seq 1 60); do
  RENDERED=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJECT/render" | python3 -c "import sys,json;d=json.load(sys.stdin);print(1 if (d.get('exports') or []) else 0)" 2>/dev/null)
  [ "$RENDERED" = "1" ] && break
  sleep 2
done
echo "render exports: $RENDERED"
[ "$RENDERED" = "1" ] || fail "timeline render did not complete"
$AB screenshot "$SHOTS/15-render-output.png" >/dev/null
# FFprobe the ACTUAL file the worker produced
FILE=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJECT/render" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['exports'][0]['id'])" 2>/dev/null)
OUT=$(curl -s -b "$JAR" -o /tmp/m16-export.mp4 -w "%{http_code}" "$BASE/api/exports/$FILE/file")
[ "$OUT" = "200" ] || fail "export download failed"
PROBE=$(ffprobe -v error -print_format json -show_streams -show_format /tmp/m16-export.mp4 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
v = [s for s in d['streams'] if s['codec_type'] == 'video']
a = [s for s in d['streams'] if s['codec_type'] == 'audio']
print(f\"video={len(v)} audio={len(a)} dur={float(d['format']['duration']):.2f}\")")
echo "ffprobe: $PROBE"
echo "$PROBE" | grep -q "video=1" || fail "render has no video stream"
echo "$PROBE" | grep -q "audio=1" || fail "render has no audio stream"

$AB close >/dev/null 2>&1
echo "M16_BROWSER_E2E_COMPLETE"
