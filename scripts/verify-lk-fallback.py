#!/usr/bin/env python3
"""M17 §9.9 — independent LK fallback verification (honest scope).

Verifies the LK feature-point fallback path in two parts:
1. PRIMITIVE: cv2.calcOpticalFlowPyrLK accurately tracks a synthetic moving
   pattern (the exact primitive the worker's fallback uses).
2. WORKER: the REAL PY_WORKER (extracted verbatim from tracking.ts) runs
   end-to-end with the CSRT branch forced to fail — no crash, valid JSON.
The intended environment (opencv-contrib) uses CSRT; LK is the documented
graceful degradation on base OpenCV.
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

# ── Part 1: LK primitive accuracy ────────────────────────────────────────────
pts_expected = []
prev = None
frames = []
for i in range(10):
    img = np.zeros((180, 320), np.uint8)
    x = 40 + i * 4
    img[80:110, x:x + 30] = 235
    img[80:110, x + 10:x + 20] = 120  # inner gradient for corner features
    frames.append(img)
lk_params = dict(winSize=(21, 21), maxLevel=3,
                 criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
gray_prev = None
track = []
for i, img in enumerate(frames):
    gray = img
    if i == 0:
        p0 = cv2.goodFeaturesToTrack(gray, maxCorners=20, qualityLevel=0.05, minDistance=5)
        track = [(p[0][0], p[0][1]) for p in p0]
        first_mean = sum(t[0] for t in track) / max(1, len(track))
        gray_prev = gray
        continue
    pts = np.array([[t] for t in track], np.float32)
    nxt, st, _err = cv2.calcOpticalFlowPyrLK(gray_prev, gray, pts, None, **lk_params)
    moved = [nxt[j][0] for j in range(len(track)) if st[j][0] == 1]
    if moved:
        mean_x = sum(m[0] for m in moved) / len(moved)
        track = [(m[0], m[1]) for m in moved]
    gray_prev = gray
last_mean = sum(t[0] for t in track) / max(1, len(track))
expected_shift = (len(frames) - 1) * 4  # 36 px total
error = abs(last_mean - (first_mean + expected_shift))
print(f"LK primitive: tracked {len(track)} points, mean x drift error {error:.2f}px over {expected_shift}px")
if error > 3.0:
    print("FAIL: LK primitive drift too large")
    sys.exit(1)

# ── Part 2: worker end-to-end with CSRT forced to fail ──────────────────────
src = Path("/home/z/my-project/src/lib/creative/visual/temporal/tracking.ts").read_text()
m = re.search(r"const PY_WORKER = `([\s\S]*?)`;", src)
if not m:
    print("PY_WORKER string not found")
    sys.exit(1)
worker = m.group(1).replace("\\`", "`").replace("\\$", "$").replace("\\\\", "\\")
worker = worker.replace(
    "cs = cv2.legacy.TrackerCSRT_create()",
    "raise AttributeError('forced: base-OpenCV environment (LK fallback test)')",
)
assert "cv2.calcOpticalFlowPyrLK" in worker

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    frames_meta = []
    for i in range(8):
        img = np.zeros((180, 320, 3), np.uint8)
        x = 30 + i * 6
        img[70:115, x:x + 40] = (235, 235, 235)  # 40×35 subject, 6px/frame — above detection thresholds
        p = tmp / f"frame_{i:03d}.png"
        cv2.imwrite(str(p), img)
        frames_meta.append({"file": str(p), "t": i / 30})
    (tmp / "input.json").write_text(json.dumps({
        "frames": frames_meta,
        "minBoxAreaFrac": 0.001,
        "maxTracks": 4,
    }))
    (tmp / "track_worker.py").write_text(worker)
    r = subprocess.run(["python3", str(tmp / "track_worker.py"), str(tmp / "input.json"), str(tmp / "output.json")],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        print("WORKER FAILED (forced LK):", r.stderr[-400:])
        sys.exit(1)
    out = json.loads((tmp / "output.json").read_text())
    n_tracks = len(out.get("tracks", []))
    print(f"Worker (forced LK): rc=0, valid JSON, cv={out.get('cv_version')}, tracks={n_tracks}, camera={len(out.get('camera', []))}")
    print("LK_FALLBACK_VERIFIED")
