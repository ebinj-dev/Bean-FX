#!/usr/bin/env python3
"""Re-measure dead-air candidates on the original and edited reference
recordings, replicating unwanted_sections.txt's methodology exactly:
100 ms RMS windows, < -50 dBFS sustained >= 0.5 s, merging gaps <= 0.15 s.
Also reports the broader < -45 dBFS review ranges."""
import json
import subprocess
import sys

SR = 16000
WIN = SR // 10  # 100 ms


def dbfs(rms_amp: float) -> float:
    return 20 * (rms_amp ** 0.5) if rms_amp <= 0 else 20 * __import__("math").log10(rms_amp)


def measure(path: str):
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
           "-f", "s16le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(raw) // 2
    samples = __import__("array").array("h")
    samples.frombytes(raw)
    dur = n / SR
    windows = []
    for i in range(0, n - WIN, WIN):
        chunk = samples[i:i + WIN]
        acc = 0
        for s in chunk:
            acc += s * s
        rms = (acc / len(chunk)) / (32768 ** 2)  # mean square, full-scale normalized
        windows.append(rms)
    def intervals(threshold_db, min_len, merge):
        thr = 10 ** (threshold_db / 10)  # mean-square: amp_dB = 10*log10(ms)
        runs = []
        start = None
        for idx, r in enumerate(windows):
            if r < thr:
                if start is None:
                    start = idx
            else:
                if start is not None:
                    runs.append([start * 0.1, (idx) * 0.1])
                    start = None
        if start is not None:
            runs.append([start * 0.1, len(windows) * 0.1])
        # merge gaps <= merge seconds
        merged = []
        for r in runs:
            if merged and r[0] - merged[-1][1] <= merge:
                merged[-1][1] = r[1]
            else:
                merged.append(r)
        kept = [(a, b) for a, b in merged if b - a >= min_len]
        return kept
    dead50 = intervals(-50, 0.5, 0.15)
    low45 = intervals(-45, 0.5, 0.15)
    return {
        "durationSec": round(dur, 3),
        "deadAir50": [{"start": round(a, 2), "end": round(b, 2), "dur": round(b - a, 2)} for a, b in dead50],
        "lowEnergy45": [{"start": round(a, 2), "end": round(b, 2), "dur": round(b - a, 2)} for a, b in low45],
    }


for name, path in [("original", sys.argv[1]), ("edited", sys.argv[2])]:
    r = measure(path)
    total50 = sum(x["dur"] for x in r["deadAir50"])
    total45 = sum(x["dur"] for x in r["lowEnergy45"])
    print(f"--- {name}: dur {r['durationSec']}s | dead air <-50dBFS: {len(r['deadAir50'])} intervals, {total50:.1f}s | low-energy <-45dBFS: {len(r['lowEnergy45'])} intervals, {total45:.1f}s")
    json.dump(r, open(f"/home/z/my-project/scripts/deadair_{name}.json", "w"), indent=1)
