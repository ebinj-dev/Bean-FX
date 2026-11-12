#!/usr/bin/env python3
"""Measure genuine unwanted content in the 20:19 recording (cmw3274ja0009r6vm7y2hg32k).

Replicates the pipeline's exact VAD (detectSpeechSpans, HIGH sensitivity profile)
on the real decoded audio, then reports the true silence-gap distribution so we
can compare it against (a) the 123-candidate/0-removal result and (b) the
user's ~5-minute expectation.
"""
import json, math, subprocess, sys
import numpy as np

SRC = "/home/z/my-project/media-store/originals/mw3274j8aiu1ad.mp3"
SR = 16000
WINDOW = 0.010  # pipeline default windowMs=10

# --- decode exactly like the pipeline: 16 kHz mono f32 ---
raw = subprocess.run(
    ["ffmpeg", "-v", "error", "-i", SRC, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
    capture_output=True, check=True,
).stdout
pcm = np.frombuffer(raw, dtype=np.float32)
dur = len(pcm) / SR
print(f"decoded duration: {dur:.3f}s  samples={len(pcm)}")

# --- 10 ms RMS envelope (same as pipeline) ---
win = int(SR * WINDOW)
n = len(pcm) // win
frames = pcm[: n * win].reshape(n, win)
env = np.sqrt((frames ** 2).mean(axis=1))

# noise floor: same estimator family (10th percentile of envelope, floor-reliable check)
floor = float(np.percentile(env, 10))
peak = float(env.max())
print(f"noiseFloor≈{floor:.6f}  peak={peak:.4f}  floorReliable={floor < peak * 0.02}")

def median_filter3(v):
    out = v.copy()
    out[1:-1] = np.minimum(np.maximum(v[:-2], v[2:]), v[1:-1])
    return out

def detect_spans(env, floor, sensitivity="HIGH"):
    hi_mult = {"LOW": 2.3, "BALANCED": 3.2, "HIGH": 4.4}[sensitivity]
    hi = max(floor * hi_mult, 0.006)
    lo = hi * 0.55
    min_speech_frames = max(2, round(0.06 / WINDOW))
    hangover = max(1, round(0.12 / WINDOW))
    sm = median_filter3(env)
    spans = []
    active = False; start = 0; quiet = 0; count = 0
    for i, v in enumerate(sm):
        if not active:
            if v >= hi:
                active = True; start = i; count = 1; quiet = 0
        else:
            count += 1
            if v >= lo:
                quiet = 0
            else:
                quiet += 1
                if quiet > hangover:
                    end = i - quiet + 1
                    if count >= min_speech_frames:
                        spans.append((start * WINDOW, end * WINDOW))
                    active = False; count = 0; quiet = 0
    if active and count >= min_speech_frames:
        spans.append((start * WINDOW, len(sm) * WINDOW))
    return spans, hi

for sens in ("HIGH", "BALANCED"):
    spans, hi = detect_spans(env, floor, sens)
    total_speech = sum(e - s for s, e in spans)
    print(f"\n=== sensitivity {sens}: hi={hi:.5f} → {len(spans)} spans, speech {total_speech:.1f}s ({100*total_speech/dur:.1f}%), silence {dur-total_speech:.1f}s ===")
    gaps = []
    for a, b in zip(spans[:-1], spans[1:]):
        g = b[0] - a[1]
        if g >= 0.4:
            seg = env[int(a[1]/WINDOW):int(b[0]/WINDOW)]
            gaps.append((a[1], b[0], g, float(seg.mean())))
    for th in (0.5, 1.0, 1.5, 2.0, 3.0, 5.0):
        sel = [g for g in gaps if g[2] >= th]
        print(f"  gaps ≥ {th:>3}s: {len(sel):3d}  total {sum(g[2] for g in sel):7.2f}s")
    top = sorted(gaps, key=lambda g: -g[2])[:20]
    print("  top 20 gaps (start→end, dur, rms):")
    for s, e, g, r in top:
        m1, s1 = divmod(int(s), 60); m2, s2 = divmod(int(e), 60)
        print(f"    {m1:02d}:{s1:02d}.{int(s*100)%100:02d} → {m2:02d}:{s2:02d}.{int(e*100)%100:02d}  {g:5.2f}s  rms={r:.4f}")

# --- compare with the saved 123-candidate result ---
res = json.load(open("/home/z/my-project/media-store/analysis-results/cmw77i6fu0001pqvclh7lav8g.json"))
cands = res["candidates"]
spans_h, _ = detect_spans(env, floor, "HIGH")
gaps_h = [(a[1], b[0]) for a, b in zip(spans_h[:-1], spans_h[1:]) if b[0] - a[1] >= 0.4]
sil = sorted([c for c in cands if c["id"].startswith("sil")], key=lambda c: c["start"])
print(f"\n=== saved result: {len(cands)} candidates, {len(sil)} sil, sum sil time {sum(c['duration'] for c in sil):.1f}s ===")
print("saved sil intervals cover:", ", ".join(f"{c['start']:.1f}-{c['end']:.1f}" for c in sil[:12]), "…")
# real gaps ≥1.5s NOT represented by any candidate interval
covered = lambda s, e: any(c["start"] - 0.6 <= s and e <= c["end"] + 0.6 for c in cands)
missing = [(s, e, e - s) for s, e in gaps_h if e - s >= 1.5 and not covered(s, e)]
print(f"\nreal gaps ≥1.5s NOT represented in candidate list: {len(missing)}, total {sum(g[2] for g in missing):.1f}s")
for s, e, g in sorted(missing, key=lambda x: -x[2])[:15]:
    m1, s1 = divmod(int(s), 60); m2, s2 = divmod(int(e), 60)
    print(f"    MISSING {m1:02d}:{s1:02d} → {m2:02d}:{s2:02d}  {g:.2f}s")
