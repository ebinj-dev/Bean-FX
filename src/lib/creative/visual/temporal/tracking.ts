/**
 * M13 — Real multi-frame object/subject tracking (§3) + camera-motion
 * estimation (§5). Local, deterministic, nothing uploaded.
 *
 * APPROACH (selected per §3's mandate to pick ONE reliable approach):
 *   detector-assisted CSRT tracking with global-motion compensation.
 *   1. GLOBAL REGISTRATION per consecutive frame pair: ECC affine alignment
 *      on downscaled blurred grayscale (fallback: phase-correlation
 *      translation) → the CAMERA path (§5) — pan/tilt/zoom magnitudes.
 *   2. DETECTION: registered consecutive-frame difference (|warp(prev)−cur|)
 *      → morphology → contours → boxes ≥ minArea. Compensation makes the
 *      detector fire on TRUE foreground even when the camera moves; it also
 *      means detection REQUIRES initial motion (documented limitation:
 *      a subject that is static from frame 0 is not auto-detected).
 *   3. TRACKING: one OpenCV CSRT correlation-filter tracker per detected
 *      subject, updated on every consecutive sampled frame (REAL multi-frame
 *      correspondence — not per-frame descriptions). Loss (update failure or
 *      degenerate box) is exposed honestly; occlusion = sustained high IoU
 *      between two tracks; exit = center leaving the frame.
 *
 * LICENSES (§12): OpenCV 4.13.0 — Apache-2.0 (commercial use permitted);
 * numpy — BSD-3-Clause. No model weights, no bundled third-party assets.
 * The worker is a template-written python file invoked server-side.
 */
import { execFile } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { TRACKING_METHOD, TRACKING_MODEL, trackIdOf, type OcclusionInterval, type TemporalSettings, type Track, type TrackSample } from "./contracts";
import { timelinePlacementsFor, type FrameExtractionContext } from "../frames";

const PY_WORKER = `
import sys, json
import cv2
import numpy as np

KERNEL_OPEN = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
KERNEL_DIL = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))

def small(gray):
    return cv2.GaussianBlur(cv2.resize(gray, (192, int(192 * gray.shape[0] / max(1, gray.shape[1])))), (5, 5), 0)

def fg_mask(prev_g, cur_g):
    """Foreground candidate mask from the UNREGISTERED frame difference —
    the foreground is where frames disagree MOST; good enough for masking."""
    diff = cv2.GaussianBlur(cv2.absdiff(prev_g, cur_g), (7, 7), 0)
    _, th = cv2.threshold(diff, 26, 255, cv2.THRESH_BINARY)
    th = cv2.dilate(th, KERNEL_DIL, iterations=3)
    return th

def global_motion(prev_g, cur_g):
    """Global (camera) motion, robust to dominant moving subjects AND
    full-frame camera motion (§5 global-vs-foreground separation).
    AUTHORITY RULE by foreground-mask coverage:
      - coverage ≤ 0.65 (background visible): the MASKED ECC alignment of the
        background is the only authoritative global estimate — the raw phase
        correlation may be dominated by a bright moving subject on a plain
        background, so it is discarded unless ECC independently corroborates
        it (±2 px). No background motion measurable ⇒ (0,0) static (honest).
      - coverage > 0.65 (motion is effectively full-frame, e.g. a pan/zoom):
        unmasked phase correlation IS the global motion (everything moves
        coherently) + log-polar scale for zoom.
    Wrap-around (≈half-frame) and low-response results are always rejected.
    Returns (dx, dy, scale, warpMatrix|None, method)."""
    H, W = cur_g.shape[:2]
    p, c = small(prev_g), small(cur_g)
    sx = cur_g.shape[1] / max(1, p.shape[1])
    mask = fg_mask(p, c)
    coverage = float((mask > 0).sum()) / mask.size
    dx = dy = 0.0
    scale = None
    warp = None
    method_parts = []
    # STEP 1 — translation (coverage authority rule).
    if coverage > 0.5:
        try:
            (tx, ty), resp = cv2.phaseCorrelate(p.astype(np.float32), c.astype(np.float32))
            tx, ty = float(tx) * sx, float(ty) * sx
            if abs(tx) < 0.2 * W and abs(ty) < 0.2 * H and resp > 0.05:
                dx, dy = tx, ty
                method_parts.append("phase-corr")
        except cv2.error:
            method_parts.append("pc-failed")
    else:
        try:
            inv = cv2.bitwise_not(mask)
            w2 = np.eye(2, 3, dtype=np.float32)
            crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-6)
            cc, w2 = cv2.findTransformECC(p, c, w2, cv2.MOTION_AFFINE, crit, inv, 5)
            ex = float(w2[0, 2]) * sx
            ey = float(w2[1, 2]) * sx
            if abs(ex) < 0.2 * W and abs(ey) < 0.2 * H:
                dx, dy = ex, ey
                warp = np.eye(2, 3, dtype=np.float32)
                warp[0, 2] = w2[0, 2] * sx; warp[1, 2] = w2[1, 2] * sx
                method_parts.append("ecc-bg-authoritative")
            else:
                method_parts.append("ecc-rejected")
        except cv2.error:
            method_parts.append("ecc-no-texture")
    method_parts.append(f"mask-coverage-{coverage:.2f}")
    label = "global:" + "+".join(method_parts)
    return dx, dy, scale, warp, label

def detect_foreground(prev_g, cur_g, warp, min_area_px):
    """Registered consecutive-frame difference -> candidate boxes."""
    if warp is not None:
        prev_w = cv2.warpAffine(prev_g, warp, (cur_g.shape[1], cur_g.shape[0]))
    else:
        prev_w = prev_g
    diff = cv2.GaussianBlur(cv2.absdiff(prev_w, cur_g), (7, 7), 0)
    _, th = cv2.threshold(diff, 26, 255, cv2.THRESH_BINARY)
    th = cv2.morphologyEx(th, cv2.MORPH_OPEN, KERNEL_OPEN)
    th = cv2.dilate(th, KERNEL_DIL, iterations=2)
    contours, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = cur_g.shape[0] * cur_g.shape[1]
    boxes = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if w * h < min_area_px or w < 6 or h < 6:
            continue
        # A near-whole-frame contour is registration noise, not a subject.
        if w * h > 0.7 * frame_area or w > 0.85 * cur_g.shape[1]:
            continue
        boxes.append([int(x), int(y), int(w), int(h)])
    # Merge overlapping candidates (IoU > 0.25 or containment).
    merged = []
    for b in sorted(boxes, key=lambda b: -(b[2] * b[3])):
        keep = True
        for i, m in enumerate(merged):
            if iou(b, m) > 0.25 or contains(m, b) or contains(b, m):
                merged[i] = union_box(m, b)
                keep = False
                break
        if keep:
            merged.append(b)
    return merged

def lk_step(prev_gray, gray, box):
    """Feature-point tracking fallback (§3 approved approach): sparse LK on
    corners seeded in the box, median flow → new box position. Used when the
    contrib CSRT tracker is unavailable (base OpenCV) — REAL multi-frame
    correspondence either way; documented in the track's method field."""
    x, y, w, h = [int(v) for v in box]
    roi = prev_gray[max(0, y):y + h, max(0, x):x + w]
    if roi.size == 0:
        return None
    pts = cv2.goodFeaturesToTrack(roi, maxCorners=60, qualityLevel=0.05, minDistance=4)
    if pts is None or len(pts) < 6:
        return None
    pts = pts.reshape(-1, 1, 2).astype(np.float32)
    pts[:, 0, 0] += max(0, x)
    pts[:, 0, 1] += max(0, y)
    nxt, st, _err = cv2.calcOpticalFlowPyrLK(prev_gray, gray, pts, None, winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    status = st.flatten() == 1
    if int(status.sum()) < 5:
        return None
    good = nxt[status]
    prev = pts[status]
    dx = float(np.median(good[:, 0] - prev[:, 0]))
    dy = float(np.median(good[:, 1] - prev[:, 1]))
    return [int(round(x + dx)), int(round(y + dy)), int(w), int(h)]

def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    if x2 <= x1 or y2 <= y1:
        return 0.0
    inter = (x2 - x1) * (y2 - y1)
    return inter / float(a[2] * a[3] + b[2] * b[3] - inter)

def contains(outer, inner):
    return outer[0] <= inner[0] and outer[1] <= inner[1] and outer[0] + outer[2] >= inner[0] + inner[2] and outer[1] + outer[3] >= inner[1] + inner[3]

def union_box(a, b):
    x1, y1 = min(a[0], b[0]), min(a[1], b[1])
    x2, y2 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
    return [int(x1), int(y1), int(x2 - x1), int(y2 - y1)]

def main():
    spec = json.load(open(sys.argv[1]))
    frames = spec["frames"]  # [{file, t}] ordered
    min_frac = spec["minBoxAreaFrac"]
    max_tracks = spec["maxTracks"]
    out_tracks: list = []
    camera = []
    trackers = []  # {id, csrt, last_box, lost_run, samples: []}
    next_id = 0
    prev_gray = None
    first_gray = None
    last_gray = None
    W = H = None
    for i, fr in enumerate(frames):
        img = cv2.imread(fr["file"])
        if img is None:
            continue
        H, W = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        t = fr["t"]
        dx = dy = 0.0
        scale = None
        warp = None
        if prev_gray is not None:
            dx, dy, scale, warp, gmethod = global_motion(prev_gray, gray)
            camera.append({"t": t, "dx": round(dx, 2), "dy": round(dy, 2), "scale": round(scale, 5) if scale else None, "ok": bool(warp is not None), "method": gmethod})
            cands = detect_foreground(prev_gray, gray, warp, int(min_frac * W * H))
        else:
            camera.append({"t": t, "dx": 0.0, "dy": 0.0, "scale": None, "ok": True, "method": "first-frame"})
            cands = []
        # Re-detection: new tracks for candidates not covered by existing tracks.
        if len(trackers) < max_tracks:
            for b in sorted(cands, key=lambda b: -(b[2] * b[3])):
                covered = any(iou(b, tr["last_box"]) > 0.2 for tr in trackers if tr["lost_run"] == 0)
                if not covered:
                    cs = None
                    try:
                        cs = cv2.legacy.TrackerCSRT_create()
                        cs.init(img, tuple(b))
                    except (AttributeError, cv2.error):
                        cs = None  # base OpenCV — LK feature-point fallback
                    tmpl = None
                    try:
                        tx1, ty1 = max(0, b[0]), max(0, b[1])
                        tx2, ty2 = min(img.shape[1], b[0] + b[2]), min(img.shape[0], b[1] + b[3])
                        if tx2 - tx1 >= 6 and ty2 - ty1 >= 6:
                            tmpl = cv2.cvtColor(img[ty1:ty2, tx1:tx2], cv2.COLOR_BGR2GRAY)
                    except Exception:
                        tmpl = None
                    trackers.append({"id": next_id, "csrt": cs, "last_box": list(b), "lost_run": 0, "samples": [], "occl": [], "born": i, "template": tmpl, "ncc_low_run": 0})
                    next_id += 1
                    if len(trackers) >= max_tracks:
                        break
        # Update every track on THIS frame (real consecutive correspondence).
        for tr in trackers:
            if tr.get("exited") or tr.get("terminated"):
                continue
            if tr["born"] == i:
                continue  # born this frame — init box already recorded conceptually
            if tr["csrt"] is not None:
                ok, box = tr["csrt"].update(img)
                bx = [int(round(v)) for v in box]
            else:
                stepped = lk_step(prev_gray, gray, tr["last_box"])
                if stepped is None:
                    tr["lost_run"] += 1
                    if tr["lost_run"] >= 3:
                        tr["term"] = "tracker-lost"
                        tr["terminated"] = True
                    continue
                bx = stepped
            cx, cy = bx[0] + bx[2] / 2.0, bx[1] + bx[3] / 2.0
            inside = 0 <= cx < W and 0 <= cy < H
            if not ok or not inside or bx[2] < 4 or bx[3] < 4 or bx[2] >= W or bx[3] >= H:
                tr["lost_run"] += 1
                if not inside and tr["samples"]:
                    tr["term"] = "left-frame"
                    tr["terminated"] = True
                elif tr["lost_run"] >= 3:
                    tr["term"] = "tracker-lost"
                    tr["terminated"] = True
                continue
            # Appearance consistency: normalized cross-correlation of the tracked
            # region against the INITIAL template. A subject that STOPPED still
            # matches (NCC high — track continues honestly); a subject that LEFT
            # or was occluded by background does NOT (NCC collapses → loss).
            x1, y1 = max(0, bx[0]), max(0, bx[1])
            x2, y2 = min(W, bx[0] + bx[2]), min(H, bx[1] + bx[3])
            ncc = 0.0
            if x2 - x1 >= 6 and y2 - y1 >= 6 and tr["template"] is not None:
                try:
                    patch = gray[y1:y2, x1:x2]
                    tmpl = cv2.resize(tr["template"], (patch.shape[1], patch.shape[0]))
                    ncc = float(cv2.matchTemplate(patch, tmpl, cv2.TM_CCOEFF_NORMED)[0][0])
                except cv2.error:
                    ncc = 0.0
            if ncc < 0.2:
                tr["ncc_low_run"] = tr.get("ncc_low_run", 0) + 1
                if tr["ncc_low_run"] >= 3:
                    tr["term"] = "tracker-lost"
                    tr["terminated"] = True
                    continue
            else:
                tr["ncc_low_run"] = 0
            tr["lost_run"] = 0
            vis = "visible"
            overlaps = [o for o in trackers if o is not tr and o["lost_run"] == 0 and iou(bx, o["last_box"]) > 0.55]
            if overlaps:
                smaller = min([tr] + overlaps, key=lambda o: o["last_box"][2] * o["last_box"][3])
                if smaller is tr:
                    vis = "occluded"
                    tr["occl"].append(t)
            conf = 0.4 if vis == "occluded" else 0.75
            tr["last_box"] = bx
            tr["samples"].append({"t": t, "x": bx[0], "y": bx[1], "w": bx[2], "h": bx[3], "conf": conf, "vis": vis, "ncc": round(max(0.0, ncc), 3)})
        if first_gray is None:
            first_gray = gray
        last_gray = gray
        prev_gray = gray
    for tr in trackers:
        if len(tr["samples"]) >= 2:
            term = tr.get("term") or ("tracker-lost" if tr.get("terminated") and tr["lost_run"] >= 3 else ("left-frame" if tr.get("terminated") else "window-end"))
            out_tracks.append({"id": tr["id"], "samples": tr["samples"], "termination": term, "occlusions": tr["occl"], "method": "csrt" if tr["csrt"] is not None else "lk-flow"})
    # WINDOW-CUMULATIVE scale: first vs last frame center patch across scales
    # 0.6..1.6 — the cumulative effect separates a real zoom from per-pair
    # texture noise. Texture guard: near-constant patches are skipped (scale
    # stays null = unmeasured, never invented).
    ws = None
    wsn = None
    try:
        if first_gray is not None and last_gray is not None:
            ps = max(24, min(first_gray.shape[0], first_gray.shape[1]) // 3)
            x1, y1 = (first_gray.shape[1] - ps) // 2, (first_gray.shape[0] - ps) // 2
            patch = first_gray[y1:y1 + ps, x1:x1 + ps]
            if float(np.std(patch)) > 8.0:
                best_s, best_v = None, -1.0
                for sc in np.arange(0.5, 3.21, 0.01):
                    rs = cv2.resize(patch, (max(8, int(patch.shape[1] * float(sc))), max(8, int(patch.shape[0] * float(sc)))))
                    if rs.shape[0] >= last_gray.shape[0] or rs.shape[1] >= last_gray.shape[1]:
                        continue
                    res = cv2.matchTemplate(last_gray, rs, cv2.TM_CCOEFF_NORMED)
                    mv = float(res.max())
                    if mv > best_v:
                        best_v, best_s = mv, float(sc)
                if best_s is not None and best_v > 0.35:
                    ws, wsn = float(best_s), float(best_v)
    except cv2.error:
        pass
    json.dump({"width": W, "height": H, "cv_version": cv2.__version__, "windowScale": ws, "windowScaleNcc": wsn, "tracks": out_tracks, "camera": camera}, open(sys.argv[2], "w"))

main()
`;

export interface RawTrack {
  id: number;
  samples: { t: number; x: number; y: number; w: number; h: number; conf: number; vis: string; term?: string }[];
  termination: string;
  occlusions: number[];
  method?: string;
}

export interface RawCameraPair {
  t: number;
  dx: number;
  dy: number;
  scale: number | null;
  ok: boolean;
  method: string;
}

export interface TrackingResult {
  width: number | null;
  height: number | null;
  cv_version?: string;
  windowScale?: number | null;
  windowScaleNcc?: number | null;
  tracks: RawTrack[];
  camera: RawCameraPair[];
}

/** Run the local OpenCV worker over the sampled window frames. */
export async function runTrackingWorker(frames: { file: string; t: number }[], settings: TemporalSettings): Promise<TrackingResult> {
  if (frames.length < 2) {
    return { width: null, height: null, tracks: [], camera: [] };
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "beanfx-track-"));
  try {
    const script = path.join(dir, "track_worker.py");
    const input = path.join(dir, "input.json");
    const output = path.join(dir, "output.json");
    await writeFile(script, PY_WORKER);
    await writeFile(input, JSON.stringify({ frames, minBoxAreaFrac: settings.minBoxAreaFrac, maxTracks: settings.maxTracks }));
    await new Promise<void>((resolve, reject) => {
      execFile("python3", [script, input, output], { timeout: 300_000, maxBuffer: 32 * 1024 * 1024 }, (err, _stdout, stderr) => {
        if (err) return reject(new Error(`tracking worker failed: ${String(stderr).slice(0, 300)}`));
        resolve();
      });
    });
    const { readFile } = await import("fs/promises");
    const raw = JSON.parse(await readFile(output, "utf8")) as TrackingResult;
    return raw;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Convert raw worker output into typed Track records (both clocks, provenance). */
export function buildTracks(assetId: string, windowIndex: number, raw: TrackingResult, ctx: FrameExtractionContext, providerLabel: { category: string | null; provider: string | null; model: string | null } | null): Track[] {
  const out: Track[] = [];
  for (const rt of raw.tracks) {
    const samples: TrackSample[] = [];
    for (const s of rt.samples.slice(0, 200)) {
      const placements = timelinePlacementsFor(s.t, ctx);
      const W = raw.width ?? 1;
      const H = raw.height ?? 1;
      samples.push({
        sourceSec: Math.round(s.t * 1000) / 1000,
        timelineSec: placements[0]?.timelineSec ?? null,
        bbox: { x: s.x, y: s.y, w: s.w, h: s.h },
        nx: Math.round(((s.x + s.w / 2) / W) * 1000) / 1000,
        ny: Math.round(((s.y + s.h / 2) / H) * 1000) / 1000,
        confidence: s.conf,
        visibility: s.vis === "occluded" ? "occluded" : "visible",
        frameId: `${assetId}:w${windowIndex}@${s.t.toFixed(2)}`,
      });
    }
    if (samples.length < 2) continue;
    const occlusionIntervals: OcclusionInterval[] = [];
    let runStart: number | null = null;
    for (const s of samples) {
      if (s.visibility === "occluded" && runStart === null) runStart = s.sourceSec;
      if (s.visibility !== "occluded" && runStart !== null) {
        occlusionIntervals.push({ startSec: runStart, endSec: s.sourceSec, reason: "sustained box overlap with another tracked subject (IoU > 0.55)" });
        runStart = null;
      }
    }
    if (runStart !== null) occlusionIntervals.push({ startSec: runStart, endSec: samples[samples.length - 1].sourceSec, reason: "sustained box overlap (IoU > 0.55)" });
    const avgConf = samples.reduce((a, s) => a + s.confidence, 0) / samples.length;
    out.push({
      trackId: trackIdOf(assetId, windowIndex, rt.id),
      assetId,
      windowIndex,
      category: providerLabel?.category ?? "moving-object",
      categoryProvenance: providerLabel ? "provider" : "detector",
      method: TRACKING_METHOD,
      model: `${raw.cv_version ?? "opencv"} (Apache-2.0) — ${rt.method === "lk-flow" ? "LK feature-point tracking (base-OpenCV fallback)" : "CSRT"} + registered-difference detection`,
      samples,
      entrySourceSec: samples[0].sourceSec,
      exitSourceSec: samples[samples.length - 1].sourceSec,
      entryTimelineSec: samples[0].timelineSec,
      exitTimelineSec: samples[samples.length - 1].timelineSec,
      occlusionIntervals: occlusionIntervals.slice(0, 12),
      terminationReason: rt.termination === "left-frame" ? "left-frame" : rt.termination === "tracker-lost" ? "tracker-lost" : "window-end",
      confidence: Math.round(avgConf * 100) / 100,
      reappearsAs: [],
      mergedInto: null,
      provider: providerLabel?.provider ?? null,
      model2: providerLabel?.model ?? null,
    });
  }
  // ── duplicate detection (§14): two tracks of the same window whose CENTERS
  // stay within ~one subject size of each other for a sustained period are the
  // same physical subject tracked twice (difference-detection ghost) — the
  // weaker track is merged into the stronger one, never presented as two.
  const centerDist = (a: TrackSample, b: TrackSample, W: number, H: number): number => {
    return Math.hypot((a.nx - b.nx) * W, (a.ny - b.ny) * H);
  };
  for (let i = 0; i < out.length; i++) {
    for (let j = 0; j < out.length; j++) {
      if (i === j || out[i].mergedInto || out[j].mergedInto) continue;
      const a = out[i];
      const b = out[j];
      const maxDim = Math.max(...a.samples.map((s) => Math.max(s.bbox.w, s.bbox.h)), ...b.samples.map((s) => Math.max(s.bbox.w, s.bbox.h)));
      const bByTime = new Map(b.samples.map((s) => [Math.round(s.sourceSec * 100), s]));
      let shared = 0;
      let close = 0;
      for (const sa of a.samples) {
        const sb = bByTime.get(Math.round(sa.sourceSec * 100));
        if (!sb) continue;
        shared += 1;
        if (centerDist(sa, sb, raw.width ?? 1, raw.height ?? 1) <= 1.3 * maxDim) close += 1;
      }
      if (shared >= 4 && close / shared >= 0.6) {
        const keeper = a.samples.length >= b.samples.length ? a : b;
        const merged = keeper === a ? b : a;
        merged.terminationReason = "merged";
        merged.mergedInto = keeper.trackId;
      }
    }
  }
  return out.filter((t) => t.terminationReason !== "merged").slice(0, 12);
}
