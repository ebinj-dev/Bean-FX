#!/usr/bin/env python3
"""Decide the correct time base for deliverable A: sample the UPLOADED
original's 100ms RMS at (a) scaled RIISHE segment starts and (b) reference
SRT cue starts. Whichever sits at speech onset matches the audio."""
import array, json, re, statistics, subprocess

SR = 16000
WIN = SR // 10

def windows(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
                          "-f", "s16le", "-"], capture_output=True, check=True).stdout
    samples = array.array("h")
    samples.frombytes(raw)
    out = []
    for i in range(0, len(samples) - WIN, WIN):
        acc = 0
        for s in samples[i:i + WIN]:
            acc += s * s
        out.append((acc / WIN) / (32768 ** 2))
    return out

def db_ms(ms):
    import math
    return 10 * math.log10(max(ms, 1e-12))

w = windows("/home/z/my-project/upload/not edited(2).mp3")
print(f"uploaded original: {len(w)*0.1:.1f}s of 100ms windows")

d = json.load(open("/home/z/my-project/media-store/analysis-results/cmw3du8xh0007r8vcljozo96k.json"))
segs = d["transcript"]["segments"]
SCALE = 1219.732 / 1219.032
riishe_starts = [s["start"] * SCALE for s in segs if s["start"] > 2]

def sample_db(t):
    i = int(t / 0.1)
    return db_ms(w[i]) if 0 <= i < len(w) else 0

riishe_db = [sample_db(t) for t in riishe_starts]

def parse_srt_cues(path):
    txt = open(path, encoding="utf-8", errors="replace").read()
    return [g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000 for g in
            ([int(x) for x in m.groups()] for m in re.finditer(r"(\d+):(\d+):(\d+)[,.](\d+)", txt))][::2]

ref_starts = [t for t in parse_srt_cues("/home/z/my-project/upload/original_audio.srt") if t > 2]
ref_db = [sample_db(t) for t in ref_starts]

import math
def summarize(name, dbs):
    quiet = sum(1 for v in dbs if v < -45)
    print(f"{name}: n={len(dbs)} | median {statistics.median(dbs):6.1f} dB | in-near-silence(<-45dB) {quiet}/{len(dbs)} ({100*quiet/len(dbs):.0f}%)")
summarize("RIISHE seg starts (scaled) at uploaded audio", riishe_db)
summarize("reference SRT cue starts at uploaded audio", ref_db)

# also: ref cue starts shifted +1.77s
ref_db_shift = [sample_db(t + 1.77) for t in ref_starts]
summarize("reference SRT cue starts +1.77s", ref_db_shift)
