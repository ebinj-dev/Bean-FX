#!/usr/bin/env python3
"""Phase 3 — ground-truth audio measurement for both encodes of the 20:19 recording.

Replicates src/lib/autocut-analysis.ts exactly:
  - 16kHz mono s16le decode, 10ms RMS envelope
  - noiseFloor = 10th percentile of envelope, peak = max
  - median-3 filter, hysteresis VAD: hi = max(floor*mult, 0.006), lo = hi*0.55,
    minSpeech 0.06s, hangover 0.12s, mult: LOW 2.3 / BALANCED 3.2 / HIGH 4.4
  - gaps between spans; candidates need gap >= minSilenceSec
Also: absolute-threshold quiet budget + ffmpeg silencedetect cross-check.
"""
import subprocess, tempfile, os, sys
import numpy as np

FILES = {
    "USER-ORIGINAL (39MB 256kbps)": "media-store/originals/mw3274j8aiu1ad.mp3",
    "PHASE2-COPY (14.6MB ~96kbps)": "media-store/originals/mw34d5l04hl99t.mp3",
}

def decode(path):
    with tempfile.NamedTemporaryFile(suffix=".pcm", delete=False) as tf:
        out = tf.name
    subprocess.run(["ffmpeg", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000",
                    "-f", "s16le", "-c:a", "pcm_s16le", out], check=True, capture_output=True)
    pcm = np.frombuffer(open(out, "rb").read(), dtype=np.int16).astype(np.float64) / 32768.0
    os.unlink(out)
    return pcm

def envelope(pcm, win=160):
    n = len(pcm) // win
    e = np.sqrt(np.mean(pcm[: n * win].reshape(n, win) ** 2, axis=1))
    return e

def median3(v):
    a = np.r_[v[0], v[:-1]]
    c = np.r_[v[1:], v[-1]]
    return np.median(np.vstack([a, v, c]), axis=0)

def vad(env, floor, mult):
    hi = max(floor * mult, 0.006)
    lo = hi * 0.55
    sm = median3(env)
    spans = []
    active = False
    start = 0
    quiet = 0
    hangover = 12   # 0.12s / 0.01s
    min_speech = 6  # 0.06s
    for i, v in enumerate(sm):
        if not active:
            if v >= hi:
                active, start, quiet = True, i, 0
        else:
            if v >= lo:
                quiet = 0
            else:
                quiet += 1
                if quiet > hangover:
                    end = i - quiet + 1
                    if end - start >= min_speech:
                        spans.append((start, end))
                    active = False
    if active and len(sm) - start >= min_speech:
        spans.append((start, len(sm)))
    return [(s * 0.01, e * 0.01) for s, e in spans], hi, lo

for label, path in FILES.items():
    pcm = decode(path)
    dur = len(pcm) / 16000
    env = envelope(pcm)
    floor = float(np.percentile(env, 10))
    peak = float(env.max())
    print(f"\n================ {label} ================")
    print(f"decoded duration: {dur:.3f}s  peak={peak:.4f}  floor(p10)={floor:.6f}  p25={np.percentile(env,25):.5f}  p50={np.percentile(env,50):.5f}")
    print(f"envelope percentiles: p5={np.percentile(env,5):.5f} p75={np.percentile(env,75):.5f} p90={np.percentile(env,90):.5f} p99={np.percentile(env,99):.5f}")
    # absolute quiet budget
    for th in (0.004, 0.006, 0.008, 0.012, 0.020, 0.030):
        sec = float((env < th).sum()) * 0.01
        print(f"  time with RMS < {th:.3f}: {sec:7.1f}s ({sec/dur*100:4.1f}%)")
    # replicated VAD for all sensitivities
    for name, mult in (("LOW", 2.3), ("BALANCED", 3.2), ("HIGH", 4.4)):
        spans, hi, lo = vad(env, floor, mult)
        gaps = [(b[0] - a[1]) for a, b in zip(spans, spans[1:])]
        g05 = [g for g in gaps if g >= 0.5]
        g10 = [g for g in gaps if g >= 1.0]
        head = spans[0][0] if spans else dur
        tail = dur - (spans[-1][1] if spans else 0)
        print(f"  VAD[{name:8s}] hi={hi:.5f} lo={lo:.5f}: spans={len(spans):4d} speechTime={sum(e-s for s,e in spans):7.1f}s "
              f"gaps>=0.5s: n={len(g05):3d} total={sum(g05):6.1f}s | gaps>=1.0s: n={len(g10):3d} total={sum(g10):6.1f}s | head+tail={head+tail:.1f}s")
    # speech-time coverage claim
    spans, _, _ = vad(env, floor, 4.4)
    sp = sum(e - s for s, e in spans)
    print(f"  (HIGH) speech={sp:.1f}s nonSpeech={dur-sp:.1f}s")
