#!/usr/bin/env python3
"""Phase 3c — validate the proposed two-pass adaptive VAD before implementing.

Rule to validate (matches planned TS implementation):
  pass 1: current VAD (hi = max(floor*mult, 0.006), lo = hi*0.55) -> spans
  speechMedian = median of pass-1 span RMS values
  hi2 = max(floor*mult, 0.006, speechMedian * 0.30)   # entry must sit above
                                                      # the room-tone band
  lo2 = hi2 * 0.55
  pass 2: re-run VAD with hi2/lo2 -> final spans/gaps
Report gap budgets per sensitivity for both files, and what the current code
produces for comparison.
"""
import subprocess, tempfile, os, json
import numpy as np

FILES = {
    "USER-ORIGINAL": "media-store/originals/mw3274j8aiu1ad.mp3",
    "PHASE2-COPY": "media-store/originals/mw34d5l04hl99t.mp3",
}
WIN = 0.01

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
    return np.sqrt(np.mean(pcm[: n * win].reshape(n, win) ** 2, axis=1))

def median3(v):
    return np.median(np.vstack([np.r_[v[0], v[:-1]], v, np.r_[v[1:], v[-1]]]), axis=0)

def vad(env, hi, lo, min_speech=6, hangover=12):
    sm = median3(env)
    spans = []
    active = False
    quiet = 0
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
    return [(s * WIN, e * WIN) for s, e in spans]

def span_rms(env, spans):
    return [float(np.mean(env[int(a / WIN):int(b / WIN)])) for a, b in spans]

for label, path in FILES.items():
    pcm = decode(path)
    dur = len(pcm) / 16000
    env = envelope(pcm)
    floor = float(np.percentile(env, 10))
    print(f"\n================ {label} dur={dur:.1f}s floor={floor:.6f} ================")
    for name, mult in (("LOW", 2.3), ("BALANCED", 3.2), ("HIGH", 4.4)):
        hi1 = max(floor * mult, 0.006)
        lo1 = hi1 * 0.55
        s1 = vad(env, hi1, lo1)
        cur_gaps = [b[0] - a[1] for a, b in zip(s1, s1[1:])]
        cur05 = [g for g in cur_gaps if g >= 0.5]
        smed = float(np.median(span_rms(env, s1))) if s1 else 0.0
        hi2 = max(hi1, smed * 0.30)
        lo2 = hi2 * 0.55
        s2 = vad(env, hi2, lo2)
        gaps = [b[0] - a[1] for a, b in zip(s2, s2[1:])]
        g05 = [g for g in gaps if g >= 0.5]
        g10 = [g for g in gaps if g >= 1.0]
        removable05 = sum(max(0.0, g - 0.35) for g in g05)
        print(f"[{name:8s}] pass1 hi={hi1:.5f} spans={len(s1):4d} speech={sum(e-s for s,e in s1):6.1f}s gaps>=.5: {sum(cur05):6.1f}s")
        print(f"           pass2 hi={hi2:.5f} (speechMedian={smed:.4f} x0.30) lo={lo2:.5f} spans={len(s2):4d} speech={sum(e-s for s,e in s2):6.1f}s "
              f"gaps>=.5s: n={len(g05):3d} total={sum(g05):6.1f}s removable≈{removable05:6.1f}s | >=1s: n={len(g10):3d} {sum(g10):5.1f}s")
