#!/usr/bin/env python3
"""Forensic inventory of the 56 candidates in cmw8ob0qo000tr4vl7955v6o1.json —
the analysis run behind the supplied screenshot (latest calibrated build,
commit a8221fe, media cmw3274ja = byte-identical upload of not edited(2).mp3).
Computes sum-vs-union accounting, overlap structure, and writes deliverable 1
(riishe_56_candidate_audit.csv) + the duration reconciliation JSON body."""
import csv
import json

R = "/home/z/my-project/media-store/analysis-results/cmw8ob0qo000tr4vl7955v6o1.json"
d = json.load(open(R))
cands = d["candidates"]
DUR = d["durationSec"]
assert len(cands) == 56, f"expected 56, got {len(cands)}"

# ---- interval helpers ----
def union(iv):
    out = []
    for s, e in sorted(iv):
        if out and s <= out[-1][1] + 1e-9:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(round(a, 3), round(b, 3)) for a, b in out]

def total(iv):
    return sum(e - s for s, e in iv)

all_iv = [(c["start"], c["end"]) for c in cands]
remove_iv = [(c["start"], c["end"]) for c in cands if c["review"] == "REMOVE"]
review_iv = [(c["start"], c["end"]) for c in cands if c["review"] == "REVIEW"]
plan_iv = [(r["start"], r["end"]) for r in d["plan"]["removals"]]

# pairwise overlap matrix (candidate i overlaps j?)
def overlaps(a, b):
    return min(a[1], b[1]) - max(a[0], b[0]) > 1e-9

ov_pairs = []
for i in range(len(cands)):
    for j in range(i + 1, len(cands)):
        if overlaps(all_iv[i], all_iv[j]):
            ov_pairs.append((cands[i]["id"], cands[j]["id"]))

# word timing method (global disclosure from pipeline)
word_timing = "estimated (RIISHE energy-aligned; no forced aligner)"

rows = []
for c in cands:
    ovl = sum(1 for a, b in ov_pairs if c["id"] in (a, b))
    rows.append({
        "candidateId": c["id"],
        "startSec": c["start"],
        "endSec": c["end"],
        "durationSec": c["duration"],
        "classification": c["review"],
        "confidence": c["confidence"],
        "classificationSource": c.get("classificationSource", "DETERMINISTIC"),
        "builtinLexicon": bool(c.get("builtinLexicon")),
        "wordTimingMethod": word_timing,
        "overlapsOtherCandidates": ovl,
        "eligibleForApproval": c["review"] == "REVIEW",
        "inProposedSum": True,
        "inProposedUnion": True,
        "inApprovedUnion": c["review"] == "REMOVE",
        "detectionEvidence": (c.get("evidence", {}) or {}).get("snr", None),
        "reason": (c.get("reason", "") or "")[:220].replace("\n", " "),
        "prevSentence": (c.get("prevSentence") or "")[:90],
        "nextSentence": (c.get("nextSentence") or "")[:90],
    })

with open("/home/z/my-project/download/riishe_56_candidate_audit.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)

accounting = {
    "run": {
        "resultFile": "media-store/analysis-results/cmw8ob0qo000tr4vl7955v6o1.json",
        "mediaId": d["mediaId"],
        "storageHashMatchesUploadedOriginal": "97f0444364193127fe0f6d2b65fc9cd4f459fa2e8babfc53bc1cd48f74c7d2da",
        "durationSec": DUR,
        "implementation": "latest calibrated build (commit a8221fe; energy-verified phantom-word rule present)",
    },
    "candidates": {
        "total": len(cands),
        "REMOVE": len(remove_iv),
        "REVIEW": len(review_iv),
        "KEEP_cards": 0,
        "KEEP_suppressedBySafetyAndInference": "see inferenceNote in result (semantic KEEP drops; none carried into the panel)",
    },
    "durationAccounting": {
        "sumOfAllCandidateDurations": round(total(all_iv), 3),
        "unionOfAllCandidateIntervals": round(total(union(all_iv)), 3),
        "unionOfREMOVEIntervals": round(total(union(remove_iv)), 3),
        "unionOfREVIEWIntervals": round(total(union(review_iv)), 3),
        "overlapPairs": len(ov_pairs),
        "planIntervals": len(plan_iv),
        "planRemovedSec": round(total(union(plan_iv)), 3),
    },
    "screenshotReconciliation": {
        "proposedCutsDisplay": "56 = cuts.length (all panel cards; KEEP cards are spliced out by the safety layer and never rendered)",
        "proposedRemovedDisplay": "1:15 = SUM of individual candidate durations (line 1088: cuts.filter(review!=='KEEP').reduce(a+c.duration)) — NOT a union",
        "approvedCutsDisplay": "6 = cards with review==='REMOVE' (5 engine REMOVE + 1 user-promoted REVIEW card)",
        "approvedRemovedDisplay": "0:19 = UNION of those 6 intervals (normalizeRanges; line 1086-1087)",
        "finalDisplay": "20:00 = original − approved union (line 1089)",
        "percentDisplay": "1.6% = approved union / original",
    },
}
print(json.dumps(accounting, indent=1))
json.dump(accounting, open("/home/z/my-project/scripts/audit_accounting.json", "w"), indent=1)
print("\nunion detail REMOVE:", union(remove_iv))
print("sum all:", round(total(all_iv), 2), "| union all:", round(total(union(all_iv)), 2), "| overlap pairs:", len(ov_pairs))
