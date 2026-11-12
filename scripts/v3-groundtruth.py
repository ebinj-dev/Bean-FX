#!/usr/bin/env python3
"""
V3 — Cut accuracy against a controlled ground truth.

Synthesizes a recording from separate espeak pieces assembled sample-exactly,
so every narration sentence, standalone filler, in-sentence filler, long pause
and repeated take has a KNOWN interval. Runs the real RIISHE pipeline on it
and measures: false REMOVE rate, false KEEP rate, REVIEW rate, precision/recall
for REMOVE, sentence-continuity damage, % meaningful speech removed.

Ground truth (by construction):
  narration  = N1, N2 (contains in-sentence "um"), N3, T1, T2 (retake pair)
  filler     = F1 "Um.", F2 "Uh." (standalone between silences)
  pause      = the 2.5 s silence between N3 and the first take
Expected engine behavior:
  - F1/F2 -> REMOVE candidates (words list: um, uh)
  - long pause -> REMOVE candidate (silence analysis)
  - in-sentence "um" -> REVIEW/KEEP, never a silent-blind REMOVE of the sentence
  - retake pair -> REVIEW at most (never auto-REMOVE meaningful speech)
"""
import json, subprocess, sys, wave, os, time

ACC = "/tmp/acc/gt"
os.makedirs(ACC, exist_ok=True)
COOKIE = "/tmp/acc/cj.txt"
BASE = "http://localhost:3000"

SR = 22050

PIECES = [
    ("sil", 0.8),
    ("N1", "The Brihadisvara temple was built by emperor Rajaraja in the year one thousand and ten."),
    ("sil", 0.9),
    ("F1", "Um."),
    ("sil", 0.9),
    ("N2", "I um inspected every wall of the shrine."),
    ("sil", 0.9),
    ("F2", "Uh."),
    ("sil", 0.9),
    ("N3", "Its walls carry more than one hundred inscriptions."),
    ("sil", 2.5),
    ("T1", "The king donated gold jewels and land to the shrine."),
    ("sil", 1.2),
    ("T2", "The king donated gold jewels and land to the shrine."),
    ("sil", 0.8),
]
WORDS = ["um", "uh", "very very", "you know"]
RESCORE = os.environ.get("RESCORE") == "1"

def load_saved():
    gt = json.load(open(f"{ACC}/groundtruth.json"))
    res = json.load(open(f"{ACC}/gt-analysis.json"))
    return gt["labels"], gt["durationSec"], res



def espeak(text, out):
    subprocess.run(["espeak-ng", "-v", "en-us", "-s", "140", "-w", out, text], check=True)

def read_wav(path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == SR, f"{path}: {w.getframerate()}"
        return w.readframes(w.getnframes())

def main():
    if RESCORE:
        labels, total, res = load_saved()
        cands = res["candidates"]
        t = total
        json.dump(res, open(f"{ACC}/gt-analysis.json", "w"), indent=1)
        _score(labels, total, cands)
        return
    labels = []
    buf = b""
    t = 0.0
    for name, val in PIECES:
        if name == "sil":
            n = int(val * SR)
            buf += b"\x00\x00" * n
            t += val
            continue
        f = f"{ACC}/{name}.wav"
        espeak(val, f)
        data = read_wav(f)
        dur = len(data) / 2 / SR
        labels.append({"name": name, "kind": "take" if name in ("T1", "T2") else "narration" if name.startswith("N") else "filler",
                       "text": val, "start": round(t, 3), "end": round(t + dur, 3)})
        buf += data
        t += dur
    gt_path = f"{ACC}/gt.wav"
    with wave.open(gt_path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(buf)
    total = len(buf) / 2 / SR
    json.dump({"durationSec": round(total, 3), "labels": labels, "words": WORDS}, open(f"{ACC}/groundtruth.json", "w"), indent=1)
    print(f"ground truth: {total:.2f}s, {len(labels)} labeled pieces")
    for l in labels: print("  ", l)

    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", gt_path, "-c:a", "libmp3lame", "-b:a", "64k", f"{ACC}/gt.mp3"], check=True)
    up = subprocess.run(["curl", "-s", "-b", COOKIE, "-X", "POST", f"{BASE}/api/media",
                         "-H", "x-filename: gt-podcast.mp3", "-H", "Content-Type: audio/mpeg",
                         "--data-binary", f"@{ACC}/gt.mp3"], capture_output=True, text=True).stdout
    media_id = json.loads(up)["media"]["id"]
    print("uploaded:", media_id)

    req = {"mediaId": media_id, "wordsToRemove": WORDS}
    an = subprocess.run(["curl", "-s", "-b", COOKIE, "--max-time", "300", "-X", "POST", f"{BASE}/api/autocut/analyze",
                         "-H", "Content-Type: application/json", "-d", json.dumps(req)], capture_output=True, text=True).stdout
    res = json.loads(an)
    if not res.get("ok"):
        print("ANALYZE FAILED:", res); sys.exit(1)
    json.dump(res, open(f"{ACC}/gt-analysis.json", "w"), indent=1)
    t = res["transcript"]
    print("transcript:", t["text"][:200])
    print("failed chunks:", len(t["failedChunks"]), "of", t["chunkCount"])
    print("language:", t["language"]["description"][:90])

    cands = res["candidates"]
    print(f"\ncandidates ({len(cands)}):")
    for c in cands:
        wm = f" word='{c['wordMatch']['phrase']}'" if c.get("wordMatch") else ""
        print(f"  {c['start']:7.2f}-{c['end']:7.2f} [{c['review']:6s}] conf={c['confidence']:.2f}{wm}")

def _score(labels, total, cands):
    # ---- scoring ----
    def ov(a1, a2, b1, b2): return max(0.0, min(a2, b2) - max(a1, b1))
    narration = [l for l in labels if l["kind"] in ("narration", "take")]
    fillers = [l for l in labels if l["kind"] == "filler"]
    # silence labels: every inter-piece gap (leading, between, trailing)
    silences = []
    prev_end = 0.0
    for l in labels:
        if l["start"] - prev_end > 0.05:
            silences.append({"name": f"sil-before-{l['name']}", "start": prev_end, "end": l["start"]})
        prev_end = l["end"]
    if total - prev_end > 0.05:
        silences.append({"name": "sil-tail", "start": prev_end, "end": total})

    removes = [c for c in cands if c["review"] == "REMOVE"]
    union = []
    for c in sorted(removes, key=lambda x: x["start"]):
        if union and c["start"] <= union[-1][1] + 0.02: union[-1][1] = max(union[-1][1], c["end"])
        else: union.append([c["start"], c["end"]])

    pause = [x for x in silences if (x["end"] - x["start"]) >= 2.0]  # long pauses = removable per spec
    removable = fillers + pause + silences
    false_remove, correct_remove = [], []
    for c in removes:
        speech_hit = sum(ov(c["start"], c["end"], l["start"], l["end"]) for l in narration)
        removable_hit = sum(ov(c["start"], c["end"], l["start"], l["end"]) for l in removable)
        # correct when the cut is (almost) entirely over removable material;
        # >0.12s over narration words = false remove
        if speech_hit <= 0.12 and removable_hit > 0: correct_remove.append(c)
        else: false_remove.append((c, speech_hit))

    missed_fillers = [l["name"] for l in fillers
                      if not any(c["start"] <= l["start"] + 0.1 and c["end"] >= l["end"] - 0.1 for c in removes)]
    missed_pause = [l for l in pause if not any(c["start"] <= l["start"] + 0.3 and c["end"] >= l["end"] - 0.3 for c in removes)]
    filler_candidates = [c for c in cands if c.get("wordMatch")]
    false_keep = [c for c in cands if c["review"] == "KEEP"
                  and (any(ov(c["start"], c["end"], l["start"], l["end"]) > 0.7 * (c["end"] - c["start"]) for l in fillers)
                       or any(ov(c["start"], c["end"], l["start"], l["end"]) > 0.7 * (c["end"] - c["start"]) for l in pause))]
    damage = []
    for c in removes:
        for l in narration:
            inside = c["start"] > l["start"] + 0.12 and c["end"] < l["end"] - 0.12
            partial = 0 < ov(c["start"], c["end"], l["start"], l["end"]) < (l["end"] - l["start"]) - 0.12
            if inside or partial: damage.append((c, l["name"], round(ov(c["start"], c["end"], l["start"], l["end"]), 3)))
    speech_removed = sum(ov(s, e, l["start"], l["end"]) for s, e in union for l in narration)
    narration_total = sum(l["end"] - l["start"] for l in narration)

    tp, fp = len(correct_remove), len(false_remove)
    print("\n== V3 metrics (controlled ground truth, revised labels) ==")
    print(f"REMOVE candidates: {len(removes)}  (correct {tp}, false {fp})")
    print(f"false REMOVE rate (of all REMOVE): {fp}/{len(removes)}")
    print(f"precision REMOVE: {tp/(tp+fp) if tp+fp else 0:.3f}")
    gt_removable = len(fillers) + len(pause)
    print(f"recall REMOVE (fillers+long-pause found as REMOVE): {tp}/{gt_removable} = {tp/gt_removable:.3f}")
    print(f"filler occurrences found as candidates (any verdict): {len(filler_candidates)} -> {[ (round(c['start'],2), c['review']) for c in filler_candidates ]}")
    print(f"false KEEP (KEEP over labeled filler/pause): {len(false_keep)}")
    print(f"missed fillers (no candidate covering them): {missed_fillers}; missed pause: {len(missed_pause)}")
    print(f"REVIEW rate: {sum(1 for c in cands if c['review']=='REVIEW')}/{len(cands)}")
    print(f"continuity damage: {len(damage)}", [(l, h) for _, l, h in damage])
    print(f"meaningful speech removed: {speech_removed:.2f}s of {narration_total:.2f}s = {speech_removed/narration_total*100:.1f}%")
    print(f"engine REMOVE union: {[[round(x,2) for x in pair] for pair in union]}")

if __name__ == "__main__":
    main()
