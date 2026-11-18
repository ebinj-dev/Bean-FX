"""M17 render fixture builder: posts an N-second multitrack sequence."""
import json
import sys
import urllib.request

seconds = int(sys.argv[1])
media = sys.argv[2]
project = sys.argv[3]
jar = sys.argv[4]
base = sys.argv[5]
fps = {"num": 30, "den": 1}
clip_len = 120
count = seconds * 30 // clip_len
tracks = [
    {"id": "v1", "name": "V1", "kind": "VIDEO", "visible": True, "muted": False, "solo": False, "locked": False},
    {"id": "a1", "name": "A1", "kind": "AUDIO", "visible": True, "muted": False, "solo": False, "locked": False},
    {"id": "s1", "name": "SUB", "kind": "CAPTION", "visible": True, "muted": False, "solo": False, "locked": False},
]
clips = []
for i in range(count):
    clips.append({"id": f"v{i}", "trackId": "v1", "sourceAssetId": media, "sourceInFrame": 0, "sourceOutFrame": 120,
                  "sourceFps": fps, "timelineStartFrame": i * clip_len, "timelineDurationFrames": clip_len,
                  "playbackSpeed": 1, "volume": 1, "muted": False, "fadeInFrames": 0, "fadeOutFrames": 0,
                  "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1},
                  "captionText": None, "graphicTemplateId": None, "graphicStyle": None, "keyframes": [], "missingMedia": False})
clips.append({"id": "amix", "trackId": "a1", "sourceAssetId": media, "sourceInFrame": 0, "sourceOutFrame": count * clip_len,
              "sourceFps": fps, "timelineStartFrame": 0, "timelineDurationFrames": count * clip_len,
              "playbackSpeed": 1, "volume": 1, "muted": False, "fadeInFrames": 0, "fadeOutFrames": 0,
              "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1},
              "captionText": None, "graphicTemplateId": None, "graphicStyle": None, "keyframes": [], "missingMedia": False})
clips.append({"id": "cap", "trackId": "s1", "sourceAssetId": "", "sourceInFrame": 0, "sourceOutFrame": 60, "sourceFps": fps,
              "timelineStartFrame": 0, "timelineDurationFrames": 60, "playbackSpeed": 1, "volume": 1, "muted": False,
              "fadeInFrames": 0, "fadeOutFrames": 0, "transform": {"x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1},
              "captionText": "M17 long-form validation", "captionStyle": {"fontSize": 48, "color": "#FFFFFF", "background": None, "position": "BOTTOM"},
              "graphicTemplateId": None, "graphicStyle": None, "keyframes": [], "missingMedia": True})  # captions are self-contained text — no media source by design
edits = [{"type": "AddTrack", "track": t} for t in tracks] + [{"type": "AddClip", "clip": c} for c in clips]
body = json.dumps({"baseVersion": 1, "edits": edits}).encode()
req = urllib.request.Request(f"{base}/api/editor/projects/{project}/timeline", data=body,
                             headers={"Content-Type": "application/json", "Cookie": jar}, method="POST")
try:
    with urllib.request.urlopen(req) as r:
        print("SAVED", r.status)
except urllib.error.HTTPError as e:
    print("SAVE-ERR", e.code, e.read()[:400].decode())
