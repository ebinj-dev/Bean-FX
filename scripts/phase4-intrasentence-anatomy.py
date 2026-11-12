#!/usr/bin/env python3
"""Why did every gap classify as intraSentence? Port of isTerminalSentence /
isContinuationStart (autocut-analysis.ts:428,756) applied to the saved
prev/next sentence texts of each silence candidate."""
import json, collections, re

d = json.load(open("/home/z/my-project/media-store/analysis-results/cmw5tdcjm0001slfxsmu5v5ny.json"))

def is_terminal(t):
    t = (t or "").strip()
    if not t: return False
    if re.search(r"(…|\.\.\.|\. \. \.)$", t): return False
    return bool(re.search(r"[.!?।؟。ஃ]$", t))

CONT = r"(because|and|but|so|which|that|was|were|is|are|to|then|just|since|as|for|with|without|after|before|when|while|if)\b"
def is_continuation(t):
    t = (t or "").strip()
    if not t: return False
    if re.match(r"[a-zà-öø-ÿ]", t[0]): return True
    return bool(re.match(CONT, t))

why = collections.Counter()
kinds = collections.Counter()
for c in d["candidates"]:
    if not c["id"].startswith("sil"): continue
    ev = c["evidence"]
    prev, nxt = c.get("prevSentence"), c.get("nextSentence")
    if not prev or not nxt:
        kinds["no-neighbour"] += 1
        why["neighbour-missing"] += 1
        continue
    same = prev.strip() == nxt.strip()
    term = is_terminal(prev)
    cont = is_continuation(nxt)
    if same:
        key = "same-segment"
    elif not term:
        key = "prev-not-terminal"
    elif cont:
        key = "next-continuation"
    else:
        key = "truly-inter-sentence"
    kinds[key] += 1
    if same: why["same-segment"] += 1
    elif not term: why["prev-not-terminal"] += 1
    elif cont: why["next-continuation"] += 1
    else: why["inter-sentence (should NOT be intra)"] += 1

print("intraSentence anatomy over the 119 silence candidates:")
for k, v in kinds.most_common():
    print(f"  {k:28s} {v}")

print("\norigWhy histogram (deterministic rule that fired):")
why2 = collections.Counter()
for line in open("/home/z/my-project/scripts/audit-candidates-20m19-full.tsv"):
    p = line.rstrip("\n").split("\t")
    if p[0] == "id": continue
    why2[p[8]] += 1
for k, v in why2.most_common():
    print(f"  {k:28s} {v}")

print("\nsample prev/next for prev-not-terminal cases:")
n = 0
for c in d["candidates"]:
    if not c["id"].startswith("sil"): continue
    prev, nxt = c.get("prevSentence") or "", c.get("nextSentence") or ""
    if prev and nxt and prev.strip() != nxt.strip() and not is_terminal(prev) and n < 6:
        print(f"  {c['id']}: prev=...{prev[-70:]!r} next={nxt[:60]!r}")
        n += 1
print("\nsample next-continuation cases:")
n = 0
for c in d["candidates"]:
    if not c["id"].startswith("sil"): continue
    prev, nxt = c.get("prevSentence") or "", c.get("nextSentence") or ""
    if prev and nxt and prev.strip() != nxt.strip() and is_terminal(prev) and is_continuation(nxt) and n < 6:
        print(f"  {c['id']}: prev=...{prev[-70:]!r} next={nxt[:60]!r}")
        n += 1
