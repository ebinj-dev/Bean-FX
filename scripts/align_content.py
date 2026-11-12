#!/usr/bin/env python3
"""Content alignment original↔edited (deliverable D) with full duration
accounting. Monotonic DP unit alignment (fuzzy token ratios), then:
  retained  — ratio >= 0.65, mapped to edited times
  shortened — 0.35 <= ratio < 0.65 (re-worded/tightened), mapped
  removed   — unmatched original units, grouped into spans INCLUDING the
              inter-unit pauses that disappeared with them
  pause deltas — for retained neighbours, the inter-sentence pause removed
              between them (UNNECESSARY PAUSE evidence)
Cross-checked against measured dead air (RMS < -50 dBFS)."""
import difflib
import json
import re
from collections import Counter

ORIG = "/home/z/my-project/media-store/analysis-results/cmw8nd6dp000jr4vlqs9on2af.json"
EDIT = "/home/z/my-project/media-store/analysis-results/cmw8mvlx5000br4vl0jfur3qp.json"
DEAD = "/home/z/my-project/scripts/deadair_original.json"


def norm_tokens(text):
    return re.sub(r"[^a-z0-9 ]", "", text.lower()).split()


def load(path):
    d = json.load(open(path))
    units = []
    for s in d["transcript"]["segments"]:
        toks = norm_tokens(s["text"])
        if not toks:
            continue
        units.append({"start": s["start"], "end": s["end"], "text": s["text"], "tokens": toks})
    return units


orig = load(ORIG)
edit = load(EDIT)
print(f"units: original {len(orig)} | edited {len(edit)}")

# --- monotonic DP alignment ---
n, m = len(orig), len(edit)
ratios = {}
for i in range(n):
    ti = orig[i]["tokens"]
    for j in range(m):
        tj = edit[j]["tokens"]
        if abs(len(ti) - len(tj)) > max(6, 0.8 * max(len(ti), len(tj))):
            r = 0.0
        else:
            r = difflib.SequenceMatcher(None, ti, tj, autojunk=False).ratio()
        ratios[(i, j)] = r
GAP_PEN = 0.0  # skipping is neutral; matched score must beat skipping
NEG = -1e9
dp = [[NEG] * (m + 1) for _ in range(n + 1)]
bt = [[None] * (m + 1) for _ in range(n + 1)]
dp[0][0] = 0.0
for i in range(n + 1):
    for j in range(m + 1):
        if dp[i][j] == NEG:
            continue
        v = dp[i][j]
        if i + 1 <= n and v > dp[i + 1][j]:
            dp[i + 1][j] = v
            bt[i + 1][j] = ("skip-o", i, j)
        if j + 1 <= m and v > dp[i][j + 1]:
            dp[i][j + 1] = v
            bt[i][j + 1] = ("skip-e", i, j)
        if i + 1 <= n and j + 1 <= m:
            v2 = v + ratios[(i, j)]
            if v2 > dp[i + 1][j + 1]:
                dp[i + 1][j + 1] = v2
                bt[i + 1][j + 1] = ("match", i, j)

match_of = {}
i, j = n, m
while i > 0 or j > 0:
    tag, pi, pj = bt[i][j]
    if tag == "match":
        match_of[pi] = pj
    i, j = pi, pj

kept, shortened, removed = [], [], []
for i in range(n):
    if i in match_of:
        r = ratios[(i, match_of[i])]
        if r >= 0.65:
            kept.append((i, match_of[i], r))
        elif r >= 0.35:
            shortened.append((i, match_of[i], r))
        else:
            removed.append(i)
    else:
        removed.append(i)
print(f"matched: retained {len(kept)} | shortened {len(shortened)} | removed {len(removed)}")
print(f"token mass: original {sum(len(u['tokens']) for u in orig)} | matched retained {sum(len(orig[i]['tokens']) for i,_,_ in kept)}")

# --- group adjacent removed units into spans (pauses included) ---
spans = []
cur = None
for i in range(n):
    if i in removed:
        if cur is None:
            cur = [i, i]
        else:
            cur[1] = i
    else:
        if cur is not None:
            spans.append(cur)
            cur = None
if cur is not None:
    spans.append(cur)

dead = [(x["start"], x["end"]) for x in json.load(open(DEAD))["deadAir50"]]

def dead_overlap(a, b):
    ov = 0.0
    for s, e in dead:
        ov += max(0.0, min(b, e) - max(a, s))
    return ov

sections = []
for i, j, r in kept:
    u, e = orig[i], edit[j]
    sections.append({
        "originalStart": round(u["start"], 2), "originalEnd": round(u["end"], 2),
        "editedStart": round(e["start"], 2), "editedEnd": round(e["end"], 2),
        "status": "retained",
        "matchRatio": round(r, 2),
        "reason": "Transcript content matches the edited recording (monotonic token alignment, ratio %.2f)." % r,
        "transcript": u["text"][:180],
        "confidence": round(min(0.95, 0.6 + r * 0.35), 2),
    })
for i, j, r in shortened:
    u, e = orig[i], edit[j]
    sections.append({
        "originalStart": round(u["start"], 2), "originalEnd": round(u["end"], 2),
        "editedStart": round(e["start"], 2), "editedEnd": round(e["end"], 2),
        "status": "shortened",
        "matchRatio": round(r, 2),
        "reason": "Same passage delivered differently in the edited recording (re-worded or tightened) — token ratio %.2f." % r,
        "transcript": u["text"][:180],
        "confidence": 0.55,
    })
for a, b in spans:
    u0, u1 = orig[a], orig[b]
    txt = " ".join(orig[k]["text"] for k in range(a, b + 1))
    span_dead = dead_overlap(u0["start"], u1["end"])
    words = sum(len(orig[k]["tokens"]) for k in range(a, b + 1))
    # Global fuzzy check: monotonic DP cannot split long merged edit segments,
    # so a removed span may actually exist elsewhere in the edit (rearranged
    # or a duplicate take the editor kept). Verify against ALL edit units.
    span_toks = [t for k in range(a, b + 1) for t in orig[k]["tokens"]]
    best_j, best_r = None, 0.0
    for j, e in enumerate(edit):
        r = difflib.SequenceMatcher(None, span_toks, e["tokens"], autojunk=False).ratio()
        if r > best_r:
            best_r, best_j = r, j
    if best_r >= 0.72:
        e = edit[best_j]
        sections.append({
            "originalStart": round(u0["start"], 2), "originalEnd": round(u1["end"], 2),
            "editedStart": round(e["start"], 2), "editedEnd": round(e["end"], 2),
            "status": "rearranged",
            "matchRatio": round(best_r, 2),
            "reason": f"Same content is present in the edited recording at {e['start']:.1f}s (token ratio {best_r:.2f}) — the monotonic alignment could not split a merged edited segment. NOT removed.",
            "transcript": txt[:250],
            "words": words,
            "confidence": 0.8,
        })
        continue
    if span_dead > 0.6 * (u1["end"] - u0["start"]) and words <= 4:
        cat, conf = "DEAD AIR", 0.85
        reason = f"Span is %.0f%% measured dead air (RMS < -50 dBFS) with no transcribed words retained in the edit." % (100 * span_dead / max(0.01, u1["end"] - u0["start"]))
    elif words <= 3:
        cat, conf = "FILLER / SHORT ARTIFACT", 0.6
        reason = "Very short unit absent from the edited transcript — filler, false start or recognition artifact."
    elif re.search(r"\bokay\b|section \d+|take \d+", txt, re.I):
        cat, conf = "PRODUCTION CHATTER", 0.75
        reason = "Section marker / presenter chatter absent from the edited recording."
    else:
        cat, conf = "REMOVED SPEECH", 0.7
        reason = "Narration block absent from the edited transcript — the professional editor removed this content."
    sections.append({
        "originalStart": round(u0["start"], 2), "originalEnd": round(u1["end"], 2),
        "editedStart": None, "editedEnd": None,
        "status": "removed",
        "category": cat,
        "reason": reason,
        "transcript": txt[:250],
        "words": words,
        "deadAirOverlapSec": round(span_dead, 2),
        "confidence": conf,
    })

# --- pause deltas between retained neighbours ---
pauses = []
kept_sorted = sorted(kept)
for (i1, j1, _), (i2, j2, _) in zip(kept_sorted, kept_sorted[1:]):
    if j2 == j1 + 1:  # consecutive in the edit too — a tightened pause
        gap_o = orig[i2]["start"] - orig[i1]["end"]
        gap_e = edit[j2]["start"] - edit[j1]["end"]
        if gap_o - gap_e > 1.0 and gap_o > 1.5:
            pauses.append({
                "originalStart": round(orig[i1]["end"], 2), "originalEnd": round(orig[i2]["start"], 2),
                "originalPauseSec": round(gap_o, 2), "editedPauseSec": round(gap_e, 2),
                "removedSec": round(gap_o - gap_e, 2),
            })

removed_total = sum(s["originalEnd"] - s["originalStart"] for s in sections if s["status"] == "removed")
pause_total = sum(p["removedSec"] for p in pauses)
out = {
    "method": "RIISHE ASR transcripts of both uploaded files; monotonic DP token alignment with global fuzzy rearrangement check; dead air from 100ms RMS windows (< -50 dBFS)",
    "tokenRatioOverall": round(difflib.SequenceMatcher(None, [t for u in orig for t in u["tokens"]], [t for u in edit for t in u["tokens"]], autojunk=False).ratio(), 3),
    "originalDurationSec": 1219.732,
    "editedDurationSec": 952.372,
    "durationDeltaSec": 267.36,
    "accounting": {
        "removedSpansSec": round(removed_total, 2),
        "tightenedPausesSec": round(pause_total, 2),
        "combinedSec": round(removed_total + pause_total, 2),
    },
    "sections": sorted(sections, key=lambda s: s["originalStart"]),
    "tightenedPauses": pauses,
}
json.dump(out, open("/home/z/my-project/download/original_edited_alignment.json", "w"), indent=1, ensure_ascii=False)
json.dump(out, open("/home/z/my-project/scripts/alignment.json", "w"), indent=1, ensure_ascii=False)
print("accounting:", out["accounting"])
print("categories:", dict(Counter(s.get("category") for s in sections if s["status"] == "removed")))
print("tightened pauses:", len(pauses))
