#!/usr/bin/env python3
"""
V2 — Timestamp accuracy of RIISHE's estimated sentence/word timings.

Method: the ASR provider returns text only, so BEAN FX estimates sentence and
word timings from measured speech energy. To score them, this script builds an
AUDIO-VERIFIED reference from the decoded PCM itself: around each estimated
boundary it finds the nearest silence↔speech transition (50 % crossing between
the local noise floor and the local speech peak) and treats that as ground
truth. Error = measured_reference − estimated. Estimated timestamps are never
claimed to be genuine provider word alignment — that is exactly what this
measures.
"""
import json, subprocess, sys, statistics, math

WAV = "/tmp/acc/ref16k.pcm"
SR = 16000
WIN = 160  # 10 ms window in samples

def decode():
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", "/tmp/acc/not-edited-2.mp3",
                    "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", WAV], check=True)
    return open(WAV, "rb").read()

def envelope(raw):
    n = len(raw) // 2
    pcm = memoryview(raw).cast("h")
    frames = n // WIN
    env = [0.0] * frames
    for f in range(frames):
        s = f * WIN
        acc = 0.0
        for i in range(s, s + WIN):
            v = pcm[i] / 32768.0
            acc += v * v
        env[f] = math.sqrt(acc / WIN)
    return env

def smooth(env, k=5):
    out = []
    half = k // 2
    for i in range(len(env)):
        a = max(0, i - half); b = min(len(env), i + half + 1)
        out.append(sum(env[a:b]) / (b - a))
    return out

def nearest_transition(env, est_f, direction, max_span_f=250):
    """Ground-truth boundary near est_f. direction: 'onset' (silence->speech,
    search a rising 50% crossing) or 'offset' (falling). Returns frame or None."""
    n = len(env)
    lo = max(0, est_f - max_span_f)
    hi = min(n - 1, est_f + max_span_f)
    # local speech peak and silence floor inside the window
    peak = max(env[lo:hi + 1])
    floor = min(env[lo:hi + 1])
    theta = (peak + floor) / 2.0
    if peak - floor < 0.02:
        return None  # no usable contrast near this boundary
    best = None
    if direction == "onset":
        i = lo
        while i < hi:
            if env[i] < theta <= env[i + 1]:
                d = abs((i + 1) - est_f)
                if best is None or d < best[1]:
                    best = (i + 1, d)
            i += 1
    else:
        i = lo
        while i < hi:
            if env[i] >= theta > env[i + 1]:
                d = abs(i - est_f)
                if best is None or d < best[1]:
                    best = (i, d)
            i += 1
    return best[0] if best else None

def stats(errs):
    errs = sorted(e for e in errs if e is not None)
    if not errs:
        return "n/a"
    med = statistics.median(errs)
    p95 = errs[min(len(errs) - 1, math.ceil(0.95 * len(errs)) - 1)]
    mae = sum(abs(e) for e in errs) / len(errs)
    return f"n={len(errs)} median={med:+.3f}s p95={p95:+.3f}s MAE={mae:.3f}s within250ms={sum(1 for e in errs if abs(e)<=0.25)/len(errs)*100:.0f}%"

def main():
    d = json.load(open("/tmp/acc/an-v2.json"))
    segs = d["transcript"]["segments"]
    raw = decode()
    env = smooth(envelope(raw))
    dur_f = len(env)
    print(f"decoded {len(raw)/2/SR:.2f}s, envelope {dur_f} frames (10 ms)")

    sent_on, sent_off = [], []
    rows = []
    for s in segs:
        on_ref = nearest_transition(env, int(s["start"] * 100), "onset")
        off_ref = nearest_transition(env, int(s["end"] * 100), "offset")
        e_on = (on_ref - s["start"] * 100) / 100 if on_ref is not None else None
        e_off = (off_ref - s["end"] * 100) / 100 if off_ref is not None else None
        if e_on is not None: sent_on.append(e_on)
        if e_off is not None: sent_off.append(e_off)
        rows.append((s, e_on, e_off))

    print("\n== SENTENCE boundaries vs audio-verified reference ==")
    print("starts:", stats(sent_on))
    print("ends:  ", stats(sent_off))

    # word level (estimated allocations)
    word_on, word_off = [], []
    for s, _, _ in rows:
        for w in s.get("words", []):
            on_ref = nearest_transition(env, int(w["start"] * 100), "onset", max_span_f=80)
            off_ref = nearest_transition(env, int(w["end"] * 100), "offset", max_span_f=80)
            if on_ref is not None: word_on.append((on_ref - w["start"] * 100) / 100)
            if off_ref is not None: word_off.append((off_ref - w["end"] * 100) / 100)
    print("\n== WORD boundaries (estimated allocations) vs audio-verified reference ==")
    print("starts:", stats(word_on))
    print("ends:  ", stats(word_off))

    # special cases
    rms_list = sorted(s["rms"] if "rms" in s else 0 for s, _, _ in rows)
    # segment mean rms from evidence: recompute from envelope quickly
    def seg_rms(s):
        a = max(0, int(s["start"] * 100)); b = min(dur_f, int(s["end"] * 100))
        if b <= a: return 0.0
        return sum(env[a:b]) / (b - a)
    r = sorted((seg_rms(s), s) for s, _, _ in rows)
    quiet = [s for v, s in r if v <= r[len(r)//4][0]]          # lowest quartile = quiet speech
    # long pauses: gaps > 1.2s between consecutive segments
    gaps = []
    for (s1, _, _), (s2, _, _) in zip(rows, rows[1:]):
        if s2["start"] - s1["end"] > 1.2:
            gaps.append((s1, s2, s2["start"] - s1["end"]))
    # chunk boundaries: segments crossing a 25 s multiple or boundary-joined
    cb = [s for s, _, _ in rows if any(abs(s["start"] - k*25) < 2.0 or (s["start"] < k*25 < s["end"]) for k in range(1, 49))]

    def table(title, items):
        on, off = [], []
        for s in items:
            on_ref = nearest_transition(env, int(s["start"] * 100), "onset")
            off_ref = nearest_transition(env, int(s["end"] * 100), "offset")
            if on_ref is not None: on.append((on_ref - s["start"] * 100) / 100)
            if off_ref is not None: off.append((off_ref - s["end"] * 100) / 100)
        print(f"\n== {title} ==")
        print("starts:", stats(on))
        print("ends:  ", stats(off))

    table(f"QUIET speech (lowest-RMS quartile, n={len(quiet)})", quiet)
    table(f"CHUNK-BOUNDARY region (n={len(cb)})", cb)
    print(f"\n== LONG PAUSES (n={len(gaps)}) — gap measured vs reference silence edges ==")
    gerr = []
    for s1, s2, gap in gaps:
        off_ref = nearest_transition(env, int(s1["end"] * 100), "offset")
        on_ref = nearest_transition(env, int(s2["start"] * 100), "onset")
        if off_ref is not None and on_ref is not None:
            ref_gap = (on_ref - off_ref) / 100
            gerr.append(ref_gap - gap)
    print("gap error (reference − estimated):", stats(gerr))

    print("\n== per-sentence sample (first 12) ==")
    for s, e_on, e_off in rows[:12]:
        print(f"  {s['start']:8.2f}->{s['end']:8.2f}  err_on={'—' if e_on is None else f'{e_on:+.2f}'}  err_off={'—' if e_off is None else f'{e_off:+.2f}'}  {s['text'][:48]}")

if __name__ == "__main__":
    main()
