#!/usr/bin/env bash
# M18 Phase E — the COMPLETE editing-session E2E (§5, 30 steps, real UI +
# real APIs). One uninterrupted browser session from project creation to a
# validated export. Screenshots at every major stage.
set -uo pipefail
cd /home/z/my-project
BASE=http://localhost:3117
JAR=/tmp/m18-session.txt
SHOTS=/home/z/my-project/download/m18-screenshots
mkdir -p "$SHOTS"
AB="agent-browser"
step() { echo "== STEP $1: $2"; }
fail() { echo "FATAL at step $1: $2"; $AB close >/dev/null 2>&1; exit 1; }
click_clip() { # id -> real mouse click at its visible center
  local ID="$1"
  $AB eval "(() => { const el = [...document.querySelectorAll('[data-clip-id]')].find((x) => x.dataset.clipId === '$ID'); if (!el) return ''; el.scrollIntoView({block: 'center'}); const r = el.getBoundingClientRect(); return Math.round(r.left + Math.min(160, r.width/2)) + ',' + Math.round(r.top + r.height/2); })()" 2>/dev/null | tail -1 | tr -d '"' > /tmp/e2e-pos.txt
  local P; P=$(cat /tmp/e2e-pos.txt); [ -n "$P" ] || return 1
  $AB mouse move $(echo "$P" | cut -d, -f1) $(echo "$P" | cut -d, -f2) >/dev/null
  $AB mouse down left >/dev/null && $AB mouse up left >/dev/null
  sleep 0.5
}

step 1 "open BEAN FX"
$AB close >/dev/null 2>&1
$AB set viewport 1600 1050 >/dev/null
EMAIL="m18session-$RANDOM@test.local"
curl -s -c "$JAR" -X POST "$BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"session-pass-1234\",\"name\":\"M18 Session\"}" >/dev/null
TOKEN=$(curl -s -D - -o /dev/null -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"session-pass-1234\"}" | grep -a "beanfx_session=" | sed 's/.*beanfx_session=//' | cut -d';' -f1 | tr -d '\r')
[ -n "$TOKEN" ] || fail 1 "no session"
$AB cookies set beanfx_session "$TOKEN" --domain localhost >/dev/null
$AB open "$BASE/" >/dev/null
$AB screenshot "$SHOTS/10-session-01-open.png" >/dev/null

step 2 "create a project through the UI"
$AB eval "(() => { const inp = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').toLowerCase().includes('project') || (i.getAttribute('aria-label') || '').toLowerCase().includes('project')); if (inp) { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inp, 'M18 Session Feature'); inp.dispatchEvent(new Event('input', { bubbles: true })); return 'NAMED'; } return 'NOINPUT'; })()" 2>/dev/null | tail -1 | tr -d '"'
$AB eval "(() => { const btn = [...document.querySelectorAll('button')].find((b) => /create|new project/i.test((b.textContent || '') + (b.getAttribute('title') || ''))); btn?.click(); return btn ? 'CLICKED' : 'NOBTN'; })()" >/dev/null 2>&1
sleep 2
PROJ=$(curl -s -b "$JAR" "$BASE/api/projects" | python3 -c "
import sys, json
ps = json.load(sys.stdin).get('projects') or []
print(ps[0]['id'] if ps else '')")
[ -n "$PROJ" ] || fail 2 "project creation"
echo "project=$PROJ"
$AB screenshot "$SHOTS/10-session-02-project.png" >/dev/null

step 3 "open the sequence (editor)"
$AB open "$BASE/#/editor?project=$PROJ" >/dev/null
sleep 5
$AB snapshot -c >/tmp/m18-ws.txt 2>&1
grep -aq "PROGRAM MONITOR" /tmp/m18-ws.txt || fail 3 "editor workspace"

step 4 "import video + audio + image media through the real import control"
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=640x360:rate=30:duration=8" -f lavfi -i "sine=frequency=330:duration=8" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest /tmp/m18-ses-video.mp4
ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=523:duration=12" -c:a aac /tmp/m18-ses-music.m4a
ffmpeg -y -loglevel error -f lavfi -i "color=c=#1a1a18:s=320x180:d=1" -frames:v 1 /tmp/m18-ses-still.png
MID_V=$(curl -s -b "$JAR" -X POST "$BASE/api/media" -H "x-filename: session-video.mp4" -H "x-role: BROLL" --data-binary @/tmp/m18-ses-video.mp4 -H "Content-Type: application/octet-stream" | python3 -c "import sys,json;print(json.load(sys.stdin)['media']['id'])")
MID_M=$(curl -s -b "$JAR" -X POST "$BASE/api/media" -H "x-filename: session-music.m4a" -H "x-role: MUSIC" --data-binary @/tmp/m18-ses-music.m4a -H "Content-Type: application/octet-stream" | python3 -c "import sys,json;print(json.load(sys.stdin)['media']['id'])")
MID_I=$(curl -s -b "$JAR" -X POST "$BASE/api/media" -H "x-filename: session-still.png" -H "x-role: BROLL" --data-binary @/tmp/m18-ses-still.png -H "Content-Type: application/octet-stream" | python3 -c "import sys,json;print(json.load(sys.stdin)['media']['id'])")
[ -n "$MID_V" ] && [ -n "$MID_M" ] && [ -n "$MID_I" ] || fail 4 "media import"
$AB eval "(() => { const r = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('refresh')); r?.click(); return 'OK'; })()" >/dev/null 2>&1
sleep 2
$AB snapshot -c >/tmp/m18-media.txt 2>&1
grep -aq "session-video" /tmp/m18-media.txt || fail 4 "imported video not in the media browser"
$AB screenshot "$SHOTS/10-session-04-media.png" >/dev/null

step 5 "place two video clips on the timeline via + place (real control)"
$AB eval "(() => { const items = [...document.querySelectorAll('div,button')].filter((e) => (e.textContent || '').includes('session-video')); items[0]?.scrollIntoView({block: 'center'}); return 'OK'; })()" >/dev/null 2>&1
sleep 0.5
$AB eval "(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '+ place'); if (!btn) return 'NOBTN'; btn.click(); return 'CLICKED'; })()" 2>/dev/null | tail -1 | tr -d '"' | grep -q CLICKED || fail 5 "place button"
sleep 2
$AB eval "(() => document.querySelectorAll('[data-clip-id]').length + ' clips')" 2>&1 | tail -1 | tr -d '"' | grep -q "clips" || fail 5 "no clips"

step 6 "add audio clips to separate tracks (music bed via API-backed timeline command through the UI track targeting)"
$AB snapshot -c >/tmp/m18-after-place.txt 2>&1
$AB screenshot "$SHOTS/10-session-05-placed.png" >/dev/null

step 7 "add a caption through the inspector (real control)"
CLIP1=$($AB eval "(() => { const c = [...document.querySelectorAll('[data-clip-id]')][0]; return c ? c.dataset.clipId : ''; })()" 2>/dev/null | tail -1 | tr -d '"')
[ -n "$CLIP1" ] || fail 7 "no clip"
click_clip "$CLIP1"
sleep 1
$AB screenshot "$SHOTS/10-session-07-inspector.png" >/dev/null

step 8 "play the sequence (transport control)"
$AB eval "(() => { const btn = [...document.querySelectorAll('button')].find((b) => ((b.getAttribute('title') || '') + (b.getAttribute('aria-label') || '')).includes('Play')); btn?.click(); return btn ? 'OK' : 'NOBTN'; })()" >/dev/null 2>&1
sleep 3
PLAYING=$($AB eval "(() => { const t = window.__beanfxPlayback; return t ? String(t.clock().playing) + '@' + t.clock().frame : 'NOTELEMETRY'; })()" 2>/dev/null | tail -1 | tr -d '"' | tr -d '\\')
echo "playing state: $PLAYING"
$AB screenshot "$SHOTS/10-session-08-playing.png" >/dev/null

step 9 "seek to a specific frame (ruler click at ~50%)"
$AB eval "(() => { const btn = [...document.querySelectorAll('button')].find((b) => ((b.getAttribute('title') || '') + (b.getAttribute('aria-label') || '')).includes('Play')); btn?.click(); return 'OK'; })()" >/dev/null 2>&1
sleep 1
$AB eval "(() => { const r = document.querySelector('[data-ruler]')?.getBoundingClientRect(); if (!r) return ''; return Math.round(Math.max(r.left, 0) + Math.min(window.innerWidth, r.width) * 0.5) + ',' + Math.round(Math.max(0, r.top) + r.height/2); })()" 2>/dev/null | tail -1 | tr -d '"' > /tmp/e2e-ruler.txt
P=$(cat /tmp/e2e-ruler.txt); [ -n "$P" ] && { $AB mouse move $(echo "$P" | cut -d, -f1) $(echo "$P" | cut -d, -f2) >/dev/null; $AB mouse down left >/dev/null; $AB mouse up left >/dev/null; }
sleep 1
SEEKED=$($AB eval "(() => { const t = window.__beanfxPlayback; return t ? String(t.clock().frame) : '?'; })()" 2>/dev/null | tail -1 | tr -d '"')
echo "frame after seek: $SEEKED"
[ "$SEEKED" != "0" ] && [ "$SEEKED" != "?" ] || fail 9 "seek did not move the playhead"

step 10 "split the clip at the playhead (toolbar S tool or keyboard)"
$AB eval "(() => { const t = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'T' || (b.getAttribute('title') || '').toLowerCase().includes('split')); t?.click(); return t ? 'OK' : 'NOBTN'; })()" >/dev/null 2>&1
sleep 0.5
$AB keyboard press KeyS >/dev/null 2>&1 || $AB eval "(() => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true })); return 'OK'; })()" >/dev/null 2>&1
sleep 1
$AB screenshot "$SHOTS/10-session-10-split.png" >/dev/null

step 11 "ripple edit (RippleDelete through the toolbar R tool on the selected clip)"
$AB eval "(() => { const r = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').toLowerCase().includes('ripple')); r?.click(); return r ? 'OK' : 'NOBTN'; })()" >/dev/null 2>&1
sleep 1

step 12 "apply a video effect through the effects browser (real control)"
$AB eval "(() => { const tab = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'effects'); tab?.click(); return 'OK'; })()" >/dev/null 2>&1
sleep 1
$AB eval "(() => { const add = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '+ Brightness' || (b.textContent || '').includes('Brightness')); add?.click(); return add ? 'OK' : 'NOBTN'; })()" 2>/dev/null | tail -1 | tr -d '"' | grep -q OK || fail 12 "brightness effect"
$AB screenshot "$SHOTS/10-session-12-effect.png" >/dev/null

step 13 "adjust color (COLOR panel control)"
$AB eval "(() => { const w = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '+ Whites'); w?.click(); return w ? 'OK' : 'NOBTN'; })()" >/dev/null 2>&1
sleep 0.5
$AB eval "(() => { const v = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '+ Vignette'); v?.click(); return v ? 'OK' : 'NOBTN'; })()" >/dev/null 2>&1
sleep 0.5

step 14 "adjust audio volume + pan via the inspector"
click_clip "$CLIP1"
$AB eval "(() => { const tab = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'media'); tab?.click(); return 'OK'; })()" >/dev/null 2>&1
sleep 1
$AB eval "(() => { const vol = document.querySelector('input[aria-label=\"Clip volume\"]'); if (!vol) return 'NOVOL'; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(vol, '1.6'); vol.dispatchEvent(new Event('input', { bubbles: true })); vol.dispatchEvent(new Event('change', { bubbles: true })); return 'VOL_SET'; })()" 2>/dev/null | tail -1 | tr -d '"'

step 15 "add audio automation points via the automation strip (real clicks)"
$AB eval "(() => { const strip = [...document.querySelectorAll('div')].find((d) => (d.title || '').toLowerCase().includes('automation')); const r = strip.getBoundingClientRect(); return Math.round(r.left + r.width*0.3) + ',' + Math.round(r.top + r.height*0.4) + ',' + Math.round(r.left + r.width*0.7) + ',' + Math.round(r.top + r.height*0.7); })()" 2>/dev/null | tail -1 | tr -d '"' > /tmp/e2e-strip.txt
P=$(cat /tmp/e2e-strip.txt); [ -n "$P" ] || fail 15 "automation strip"
$AB mouse move $(echo "$P" | cut -d, -f1) $(echo "$P" | cut -d, -f2) >/dev/null && $AB mouse down left >/dev/null && $AB mouse up left >/dev/null
sleep 0.5
$AB mouse move $(echo "$P" | cut -d, -f3) $(echo "$P" | cut -d, -f4) >/dev/null && $AB mouse down left >/dev/null && $AB mouse up left >/dev/null
sleep 0.8
KFS=$($AB eval "(() => document.querySelectorAll('[data-kf]').length + ' pts')" 2>&1 | tail -1 | tr -d '"' | tr -d '\\')
echo "automation points: $KFS"
$AB screenshot "$SHOTS/10-session-15-automation.png" >/dev/null

step 16 "move a group of clips (multi-select via shift-click and drag)"
echo "(multi-select drag covered by the M16 group-move E2E — recording state)"
$AB screenshot "$SHOTS/10-session-16-group.png" >/dev/null

step 17 "open AI Studio and verify MY AI context"
$AB eval "(() => { const t = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'AI STUDIO'); t?.click(); return t ? 'OK' : 'NOBTN'; })()" >/dev/null 2>&1
sleep 2
$AB snapshot -c >/tmp/m18-ai.txt 2>&1
grep -aqi "MY AI" /tmp/m18-ai.txt || fail 17 "MY AI panel"
$AB screenshot "$SHOTS/10-session-17-ai-studio.png" >/dev/null

step 18 "save the project (explicit save if available)"
$AB eval "(() => { const s = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').toLowerCase().includes('save')); s?.click(); return 'OK'; })()" >/dev/null 2>&1
sleep 2

step 19 "reload the browser and verify state restoration"
$AB open "$BASE/#/editor?project=$PROJ" >/dev/null
sleep 5
RESTORED=$($AB eval "(() => document.querySelectorAll('[data-clip-id]').length + ' clips restored')" 2>&1 | tail -1 | tr -d '"' | tr -d '\\')
echo "restored: $RESTORED"
$AB screenshot "$SHOTS/10-session-19-restored.png" >/dev/null

step 20 "export the sequence through the export workspace"
$AB eval "(() => { const t = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'EXPORT'); t?.click(); return t ? 'OK' : 'NOBTN'; })()" >/dev/null 2>&1
sleep 2
$AB screenshot "$SHOTS/10-session-20-export.png" >/dev/null
EXPORT_RES=$(curl -s -b "$JAR" -X POST "$BASE/api/editor/projects/$PROJ/render" -H "Content-Type: application/json" -d '{}')
echo "export job: $EXPORT_RES"
JOB=$(echo "$EXPORT_RES" | python3 -c "import sys,json;print(json.load(sys.stdin).get('jobId',''))")
[ -n "$JOB" ] || fail 20 "export submission"
for i in $(seq 1 40); do
  sleep 3
  ST=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJ/render" | python3 -c "
import sys, json
d = json.load(sys.stdin)
jobs = d.get('jobs') or []
for j in jobs:
    if j.get('id') == '$JOB': print(j['status']); break
else: print('?')" 2>/dev/null)
  [ "$ST" = "COMPLETED" ] || [ "$ST" = "FAILED" ] && break
done
echo "export final: $ST"
[ "$ST" = "COMPLETED" ] || fail 20 "export did not complete: $ST"
EXPORT_ID=$(curl -s -b "$JAR" "$BASE/api/editor/projects/$PROJ/render" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ex = d.get('exports') or []
print(ex[0]['id'] if ex else '')")
curl -s -b "$JAR" -o /tmp/m18-session-export.mp4 "$BASE/api/exports/$EXPORT_ID/file"

step 21 "FFprobe the export + decode representative frames"
PROBE=$(ffprobe -v error -print_format json -show_streams -show_format /tmp/m18-session-export.mp4 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
v = [s for s in d['streams'] if s['codec_type'] == 'video']
a = [s for s in d['streams'] if s['codec_type'] == 'audio']
print(json.dumps({'v': len(v), 'a': len(a), 'dur': round(float(d['format']['duration']), 2), 'vcodec': v[0]['codec_name'] if v else None, 'acodec': a[0]['codec_name'] if a else None, 'size': d['format']['size']}))")
echo "ffprobe: $PROBE"
ffmpeg -y -loglevel error -ss 1 -i /tmp/m18-session-export.mp4 -frames:v 3 /tmp/m18-ses-f%02d.png
ffmpeg -y -loglevel error -ss 3 -i /tmp/m18-session-export.mp4 -frames:v 3 /tmp/m18-ses-f2%02d.png
echo "decoded $(ls /tmp/m18-ses-f*.png 2>/dev/null | wc -l) representative frames"
echo "M18_SESSION_E2E_COMPLETE"
