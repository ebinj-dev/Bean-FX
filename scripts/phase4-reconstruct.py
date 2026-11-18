#!/usr/bin/env python3
"""Phase 4 audit: reconstruct the DETERMINISTIC (pre-inference) classification
of every candidate of the 20:19 job from its saved evidence, and diff it
against the final (post zai-chat inference) classification.

The rules ported here are verbatim from src/lib/autocut-analysis.ts
buildCandidates() lines 899-938 (order matters) and buildWordCandidates
(builtin lexicon -> REVIEW 0.5). Settings confirmed = defaults (pauseSec 1.19
-> duration 0.84 = pause - target 0.35 exactly).
"""
import json, collections

F = "/home/z/my-project/media-store/analysis-results/cmw5tdcjm0001slfxsmu5v5ny.json"
d = json.load(open(F))
cands = d["candidates"]

PUNCT_KNOWN = True  # transcript available, text contains [.!?] (verified)
TIGHTEN = True

def deterministic(c):
    ev = c["evidence"]
    pause = ev["pauseSec"]
    if not ev.get("floorReliable", True):
        return ("REVIEW", 0.2, "floor-unreliable")
    if ev["transcriptWordsInRange"] > 0:
        return ("REVIEW", 0.25, "words-in-range")
    if ev.get("repeatedTake"):
        return ("REVIEW", 0.4, "repeated-take")
    if ev.get("intraSentence") and pause <= 3.0:
        return ("KEEP", 0.75, "intra-sentence<=3s")
    if ev.get("intraSentence"):
        return ("REVIEW", 0.45, "intra-sentence>3s")
    if ev.get("quietSpeechNearby") and pause < 2.5:
        return ("KEEP", 0.6, "quiet-speech-nearby")
    if not PUNCT_KNOWN and pause <= 8.0:
        return ("REVIEW", 0.35, "punctuation-unknown")
    conf = min(0.95, 0.55 + pause * 0.08 + (0 if TIGHTEN else 0.05))
    return ("REMOVE", round(conf, 2), "inter-sentence-silence")

rows = []
for c in cands:
    if c["id"].startswith("word"):
        orig = ("REVIEW", 0.5, "builtin-lexicon")
    else:
        orig = deterministic(c)
    fin = (c["review"], c.get("confidence"))
    rows.append({
        "id": c["id"], "start": c["start"], "end": c["end"], "dur": c["duration"],
        "pause": c["evidence"]["pauseSec"], "orig": orig[0], "origConf": orig[1], "origWhy": orig[2],
        "final": fin[0], "finalConf": fin[1],
        "overridden": orig[0] != fin[0],
        "inPlan": fin[0] == "REMOVE",
        "rms": c["evidence"]["rms"],
        "reason": (c.get("reason") or "").replace("\n", " "),
    })

print("== BEFORE (deterministic) vs AFTER (zai-chat inference) ==")
b = collections.Counter(r["orig"] for r in rows)
a = collections.Counter(r["final"] for r in rows)
print("  before:", dict(b), " after:", dict(a))
cross = collections.Counter((r["orig"], r["final"]) for r in rows)
print("  transition matrix (orig -> final):")
for (o, f), n in sorted(cross.items()):
    print(f"    {o:7s} -> {f:7s}: {n}")
plan = [r for r in rows if r["inPlan"]]
print(f"  entered canonical plan (final REMOVE): {len(plan)}")

print("\n== deterministic REMOVEs and what inference did to them ==")
for r in rows:
    if r["orig"] == "REMOVE":
        print(f"  {r['id']}  {r['start']:.2f}-{r['end']:.2f}s pause={r['pause']}s rms={r['rms']:.4f}  -> final {r['final']} conf={r['finalConf']}: {r['reason'][:100]}")

print("\n== long pauses (pause >= 2s) and their fate ==")
for r in sorted((x for x in rows if x["pause"] >= 2), key=lambda x: -x["pause"]):
    print(f"  {r['id']:8s} pause={r['pause']:.2f}s rms={r['rms']:.4f} intra={r['origWhy']:22s} {r['orig']}->{r['final']} conf={r['finalConf']}")

print("\n== REVIEW survivors (final REVIEW) ==")
for r in rows:
    if r["final"] == "REVIEW":
        print(f"  {r['id']:8s} pause={r['pause']:.2f}s {r['orig']}->REVIEW conf={r['finalConf']}: {r['reason'][:110]}")

# full table file
with open("/home/z/my-project/scripts/audit-candidates-20m19-full.tsv", "w") as w:
    w.write("id\tstart\tend\tdur\tpause\trms\torig\torigConf\torigWhy\tfinal\tfinalConf\toverridden\tinPlan\treason\n")
    for r in rows:
        w.write(f"{r['id']}\t{r['start']}\t{r['end']}\t{r['dur']}\t{r['pause']}\t{r['rms']}\t{r['orig']}\t{r['origConf']}\t{r['origWhy']}\t{r['final']}\t{r['finalConf']}\t{r['overridden']}\t{r['inPlan']}\t{r['reason']}\n")
print("\nwrote scripts/audit-candidates-20m19-full.tsv")
tot = sum(r["pause"] for r in rows)
print(f"total pause across candidates: {tot:.1f}s of {d['durationSec']:.0f}s")
