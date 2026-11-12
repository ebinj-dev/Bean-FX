#!/usr/bin/env python3
"""Phase 3b — bimodal valley analysis + transcript-vs-energy cross-check.

1. Otsu threshold on log10(RMS) envelope -> the recording's own speech/quiet
   boundary, per file. This is the adaptive VAD candidate.
2. Where do the user run's transcript words sit? Mean RMS under each sentence
   segment span (original file) -> proves words were stretched across bridged
   room tone.
3. Predicted post-fix candidate budget: gaps >= minSilence with padding math
   (head 0.15, tail 0.20, target pause 0.35) at the valley boundary.
"""
import subprocess, tempfile, os, json
import numpy as np

FILES = {
    "USER-ORIGINAL": "media-store/originals/mw3274j8aiu1ad.mp3",
    "PHASE2-COPY": "media-store/originals/mw34d5l04hl99t.mp3",
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
    return np.sqrt(np.mean(pcm[: n * win].reshape(n, win) ** 2, axis=1))

def otsu_log(env):
    x = np.log10(env + 1e-6)
    hist, edges = np.histogram(x, bins=256)
    p = hist / hist.sum()
    omega = np.cumsum(p)
    mu = np.cumsum(p * np.arange(256))
    mu_t = mu[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        sigma_b = (mu_t * omega - mu) ** 2 / (omega * (1 - omega))
    sigma_b[omega == 0 | (omega == 1)] = 0
    k = int(np.nanargmax(sigma_b))
    thr_log = (edges[k] + edges[k + 1]) / 2
    return 10 ** thr_log, thr_log

envs = {}
for label, path in FILES.items():
    pcm = decode(path)
    env = envelope(pcm)
    envs[label] = env
    dur = len(pcm) / 16000
    valley, thr_log = otsu_log(env)
    print(f"\n=== {label} dur={dur:.1f}s ===")
    print(f"Otsu valley on log10(RMS): {valley:.5f} (log10={thr_log:.3f})")
    # quiet/speech masses around the valley
    for lo, hi in [(0.000, 0.002), (0.002, 0.004), (0.004, 0.006), (0.006, 0.008),
                   (0.008, 0.012), (0.012, 0.020), (0.020, 0.050), (0.050, 1.0)]:
        sec = float(((env >= lo) & (env < hi)).sum()) * 0.01
        print(f"  RMS [{lo:.3f},{hi:.3f}): {sec:7.1f}s ({sec/dur*100:4.1f}%)")

# Transcript cross-check on the USER run
j = json.load(open('media-store/analysis-results/cmw5z3bxf000etzvdcygc5nkm.json'))
env = envs["USER-ORIGINAL"]
segs = j['transcript']['segments']
print(f"\n=== USER RUN: RMS under each of {len(segs)} transcript sentence spans (original file) ===")
rows = []
for s in segs:
    a, b = int(s['start'] * 100), int(s['end'] * 100)
    if b <= a:
        continue
    rows.append((float(np.mean(env[a:b])), float(np.median(env[a:b])), s['start'], s['end'], s['text'][:60]))
rows.sort()
quiet_sents = [r for r in rows if r[1] < 0.008]
print(f"sentences whose MEDIAN span RMS < 0.008 (i.e. text sits on room-tone level): {len(quiet_sents)}")
for r in quiet_sents[:12]:
    print(f"  med={r[1]:.5f} mean={r[0]:.5f} span={r[2]:.2f}-{r[3]:.2f} :: {r[4]}")
loud = [r for r in rows if r[1] >= 0.02]
print(f"sentences with median RMS >= 0.02 (clearly voiced): {len(loud)}")

# Predicted post-fix budget on the ORIGINAL at the valley boundary
valley, _ = otsu_log(env)
hi = max(0.001666 * 4.4, 0.006, valley)
lo = hi * 0.55
sm = np.median(np.vstack([np.r_[env[0], env[:-1]], env, np.r_[env[1:], env[-1]]]), axis=0)
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
            if quiet > 12:
                end = i - quiet + 1
                if end - start >= 6:
                    spans.append((start * 0.01, end * 0.01))
                active = False
if active and len(sm) - start >= 6:
    spans.append((start * 0.01, len(sm) * 0.01))
gaps = [(b[0] - a[1], a[1], b[0]) for a, b in zip(spans, spans[1:])]
head_tail = (spans[0][0], len(env) * 0.01 - spans[-1][1])
print(f"\n=== PREDICTED POST-FIX VAD (original, hi={hi:.5f} lo={lo:.5f}) ===")
print(f"spans={len(spans)} speech={sum(e-s for s,e in spans):.1f}s")
for minsil in (0.5, 0.75, 1.0):
    g = [x for x in gaps if x[0] >= minsil]
    # padding math: removable = gap - head - tail; cut = removable (target 0.35 - paddings = 0)
    cut = sum(max(0.0, g_ - 0.35) for g_, _, _ in g)
    print(f"  minSilence={minsil}: gaps n={len(g)} total={sum(x[0] for x in g):6.1f}s  -> removable after padding ≈ {cut:6.1f}s")
