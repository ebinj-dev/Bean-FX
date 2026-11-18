"""M18 Phase C fixture: a 600s multitrack sequence with EVERYTHING —
3 video tracks (one with effects + a transition), 2 audio tracks (one with
volume automation), captions, a graphic. Real generated media + synthetic
arrangement (clearly distinguished in the report).
Usage: python3 scripts/m18-build-600s.py MEDIA_ID PROJECT_ID COOKIE BASE
"""
import json
import sys
import urllib.request

media = sys.argv[1]
project = sys.argv[2]
cookie = sys.argv[3]
base = sys.argv[4]
fps = {"num": 30, "den": 1}
clip_len = 120  # 4s clips
count = 600 * 30 // clip_len  # 150 clips

tracks = [
    {"id": "v1", "name": "V1", "kind": "VIDEO", "visible": True, "muted": False, "solo": False, "locked": False},
    {"id": "v2", "name": "V2", "kind": "VIDEO", "visible": True, "muted": False, "solo": False, "locked": False},
    {"id": "a1", "name": "A1", "kind": "AUDIO", "visible": True, "muted": False, "solo": False, "locked": False},
    {"id": "a2", "name": "A2", "kind": "AUDIO", "visible": True, "muted": False, "solo": False, "locked": False},
    {"id": "s1", "name": "SUB", "kind": "CAPTION", "visible": True, "muted": False, "solo": False, "locked": False},
]
clips = []
transitions = []
for i in range(count):
    track = "v1" if i % 3 != 2 else "v2"
    start = (i // 3) * clip_len + (clip_len if i % 3 == 2 else 0)
    clips.append({
        "id": f"v{i}", "trackId": track, "sourceAssetId": media, "sourceInFrame": 0, "sourceOutFrame": clip_len,
        "sourceFps": fps, "timelineStartFrame": (i // 2) * clip_len if track == "v1" else (i // 2) * clip_len,
        "timelineDurationFrames": clip_len, "playbackSpeed": 1, "volume": 1, "muted": False,
        "fadeInFrames": 0, "fadeOutFrames": 0,
        "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1},
        "captionText": None, "graphicTemplateId": None, "graphicStyle": None, "keyframes": [], "missingMedia": False,
        "effects": [{"id": f"fx-b{i}", "type": "brightness", "enabled": True, "params": {"value": 0.1}}] if i % 20 == 0 else [],
    })
# transition on the first v1 boundary (real frames from both clips)
clips_v1 = [c for c in clips if c["trackId"] == "v1"]
clips_v1.sort(key=lambda c: c["timelineStartFrame"])
a, b = clips_v1[0], clips_v1[1]
boundary = a["timelineStartFrame"] + a["timelineDurationFrames"]
transitions.append({
    "id": "tr-m18-1", "trackId": "v1", "kind": "CROSS_DISSOLVE",
    "startFrame": boundary - 10, "endFrame": boundary + 10, "durationFrames": 20,
    "clipAId": a["id"], "clipBId": b["id"], "params": {},
})
# audio track 1: full-length bed with volume automation (3 points)
clips.append({
    "id": "amix", "trackId": "a1", "sourceAssetId": media, "sourceInFrame": 0, "sourceOutFrame": count * clip_len,
    "sourceFps": fps, "timelineStartFrame": 0, "timelineDurationFrames": count * clip_len,
    "playbackSpeed": 1, "volume": 1, "muted": False, "fadeInFrames": 0, "fadeOutFrames": 0,
    "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1},
    "captionText": None, "graphicTemplateId": None, "graphicStyle": None,
    "keyframes": [
        {"id": "kf-m18-a1", "property": "volume", "frame": 0, "value": 0.5, "interpolation": "LINEAR", "bezier": None},
        {"id": "kf-m18-a2", "property": "volume", "frame": count * clip_len // 2, "value": 2.0, "interpolation": "LINEAR", "bezier": None},
        {"id": "kf-m18-a3", "property": "volume", "frame": count * clip_len - 60, "value": 1.0, "interpolation": "LINEAR", "bezier": None},
    ],
    "missingMedia": False,
})
# audio track 2: voiceover-ish alternating segments
for i in range(min(20, count // 5)):
    clips.append({
        "id": f"av{i}", "trackId": "a2", "sourceAssetId": media, "sourceInFrame": 0, "sourceOutFrame": clip_len,
        "sourceFps": fps, "timelineStartFrame": i * 5 * clip_len, "timelineDurationFrames": clip_len,
        "playbackSpeed": 1, "volume": 0.8, "muted": False, "fadeInFrames": 15, "fadeOutFrames": 15,
        "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1},
        "captionText": None, "graphicTemplateId": None, "graphicStyle": None, "keyframes": [], "missingMedia": False,
    })
# captions + one graphic
clips.append({
    "id": "cap1", "trackId": "s1", "sourceAssetId": "", "sourceInFrame": 0, "sourceOutFrame": 90,
    "sourceFps": fps, "timelineStartFrame": 0, "timelineDurationFrames": 90,
    "playbackSpeed": 1, "volume": 1, "muted": False, "fadeInFrames": 0, "fadeOutFrames": 0,
    "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1},
    "captionText": "M18 ten-minute validation", "captionStyle": {"fontSize": 48, "color": "#FFFFFF", "background": None, "position": "BOTTOM"},
    "graphicTemplateId": None, "graphicStyle": None, "keyframes": [], "missingMedia": True,
})
clips.append({
    "id": "cap2", "trackId": "s1", "sourceAssetId": "", "sourceInFrame": 0, "sourceOutFrame": 90,
    "sourceFps": fps, "timelineStartFrame": count * clip_len - 90, "timelineDurationFrames": 90,
    "playbackSpeed": 1, "volume": 1, "muted": False, "fadeInFrames": 0, "fadeOutFrames": 0,
    "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1},
    "captionText": "M18 end marker", "captionStyle": {"fontSize": 48, "color": "#FFFF00", "background": None, "position": "BOTTOM"},
    "graphicTemplateId": None, "graphicStyle": None, "keyframes": [], "missingMedia": True,
})
GFX_STYLE = json.load(open("/tmp/tpl-style.json"))
clips.append({
    "id": "gfx1", "trackId": "v2", "sourceAssetId": "", "sourceInFrame": 0, "sourceOutFrame": 60,
    "sourceFps": fps, "timelineStartFrame": 300, "timelineDurationFrames": 60,
    "playbackSpeed": 1, "volume": 1, "muted": False, "fadeInFrames": 0, "fadeOutFrames": 0,
    "transform": {"x": 20, "y": 20, "scale": 1, "rotation": 0, "opacity": 1},
    "captionText": None, "captionStyle": None,
    "graphicTemplateId": "lower-third-bar",
    "graphicStyle": GFX_STYLE,
    "keyframes": [], "missingMedia": True,
})
edits = [{"type": "AddTrack", "track": t} for t in tracks] + [{"type": "AddClip", "clip": c} for c in clips]
body = json.dumps({"baseVersion": 1, "edits": edits}).encode()
req = urllib.request.Request(f"{base}/api/editor/projects/{project}/timeline", data=body,
                             headers={"Content-Type": "application/json", "Cookie": cookie}, method="POST")
try:
    with urllib.request.urlopen(req) as r:
        print("SAVED", r.status)
except urllib.error.HTTPError as e:
    print("SAVE-ERR", e.code, e.read()[:400].decode())
