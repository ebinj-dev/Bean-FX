#!/usr/bin/env python3
"""
T5 — Word-level candidate timestamps vs actual audio.

The transcription provider returns TEXT ONLY (no timestamps) — every word
timing in BEAN FX is an ESTIMATE allocated along measured speech energy
(wordMatch.estimatedTiming is always true, and the pipeline warning says so).
This script verifies those estimates against audio-verified reference
boundaries (50 % silence↔speech crossing nearest each estimate).
"""
import json, subprocess, math, statistics, wave, os

def envelope_of(path, sr=16000, win_ms=10):
    pcmf = "/tmp/acc/t5.pcm"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", pcmf], check=True)
    raw = open(pcmf, "rb").read()
    n = len(raw) // 2
    mv = memoryview(raw).cast("h")
    win = sr * win_ms // 1000
    frames = n // win
    env = [0.0] * frames
    for f in range(frames):
        acc = 0.0
        for i in range(f * win, (f + 1) * win):
            v = mv[i] / 32768.0
            acc += v * v
        env[f] = math.sqrt(acc / win)
    return env

def smooth(env, k=5):
    out, half = [], k // 2
    for i in range(len(env)):
        a, b = max(0, i - half), min(len(env), i + half + 1)
        out.append(sum(env[a:b]) / (b - a))
    return out

def transition(env, est_f, direction, span_f=120):
    lo, hi = max(0, est_f - span_f), min(len(env) - 2, est_f + span_f)
    if hi <= lo: return None
    peak, floor = max(env[lo:hi + 1]), min(env[lo:hi + 1])
    if peak - floor < 0.02: return None
    theta = (peak + floor) / 2
    best = None
    for i in range(lo, hi):
        if direction == "onset" and env[i] < theta <= env[i + 1]:
            d = abs(i + 1 - est_f)
            if best is None or d < best[1]: best = (i + 1, d)
        if direction == "offset" and env[i] >= theta > env[i + 1]:
            d = abs(i - est_f)
            if best is None or d < best[1]: best = (i, d)
    return best[0] if best else None

def check(name, media_path, words):
    env = smooth(envelope_of(media_path))
    print(f"\n== {name} ==")
    errs_on, errs_off = [], []
    for w in words:
        on_ref = transition(env, int(w["start"] * 100), "onset")
        off_ref = transition(env, int(w["end"] * 100), "offset")
        e_on = (on_ref - w["start"] * 100) / 100 if on_ref is not None else None
        e_off = (off_ref - w["end"] * 100) / 100 if off_ref is not None else None
        if e_on is not None: errs_on.append(e_on)
        if e_off is not None: errs_off.append(e_off)
        print(f"  '{w.get('phrase', w.get('text', '?'))}' est {w['start']:.2f}-{w['end']:.2f}  err_on={'—' if e_on is None else f'{e_on:+.2f}s'}  err_off={'—' if e_off is None else f'{e_off:+.2f}s'}")
    def stat(x):
        x = sorted(x)
        return f"n={len(x)} median={statistics.median(x):+.3f}s max_abs={max(abs(v) for v in x):.3f}s" if x else "n=0"
    print(f"  onset errors: {stat(errs_on)}")
    print(f"  offset errors: {stat(errs_off)}")

def word_candidates(path):
    d = json.load(open(path))
    return [{"start": c["start"], "end": c["end"], "phrase": c["wordMatch"]["phrase"]} for c in d["candidates"] if c.get("wordMatch")]

check("fillers.mp3 (5 word candidates, est.)", "/tmp/acc/fillers.mp3", word_candidates("/tmp/acc/an-fillers.json"))
check("video-with-audio (1 word candidate, est.)", "/tmp/acc/vwith.mp4", word_candidates("/tmp/acc/an-vwith.json"))
check("ground-truth podcast (2 word candidates, est.)", "/tmp/acc/gt/gt.mp3", word_candidates("/tmp/acc/gt/gt-analysis.json"))
print("\nPROVIDER TIMESTAMPS: none exist — the ASR returns text only; every word timing above is an")
print("ESTIMATE allocated along measured speech energy (wordMatch.estimatedTiming === true by construction).")
