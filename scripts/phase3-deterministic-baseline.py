#!/usr/bin/env python3
"""Phase 3d — recompute the DETERMINISTIC classification from the user run's
stored evidence (the inference stage overwrote review on all 123), to split
blame between the deterministic rules and the semantic model."""
import json
from collections import defaultdict

j = json.load(open('media-store/analysis-results/cmw5z3bxf000etzvdcygc5nkm.json'))
cands = j['candidates']

# punctuationKnown: transcript has terminal punctuation -> True (verified: text has periods)
punctuationKnown = True

def deterministic(c):
    e = c['evidence']
    if not e['floorReliable']:
        return "REVIEW", 0.2
    if e['transcriptWordsInRange'] > 0:
        return "REVIEW", 0.25
    if e['repeatedTake']:
        return "REVIEW", 0.4
    if e['intraSentence'] and e['pauseSec'] <= 3:
        return "KEEP", 0.75
    if e['intraSentence']:
        return "REVIEW", 0.45
    if e['quietSpeechNearby'] and e['pauseSec'] < 2.5:
        return "KEEP", 0.6
    if not punctuationKnown and e['pauseSec'] <= 8:
        return "REVIEW", 0.35
    return "REMOVE", min(0.95, 0.55 + e['pauseSec'] * 0.08)

det_count = defaultdict(int)
det_dur = defaultdict(float)
fin_count = defaultdict(int)
fin_dur = defaultdict(float)
overrides = defaultdict(int)
changed = []
for c in cands:
    d, dconf = deterministic(c)
    det_count[d] += 1
    det_dur[d] += c['duration']
    fin_count[c['review']] += 1
    fin_dur[c['review']] += c['duration']
    if d != c['review']:
        overrides[f"{d}->{c['review']}"] += 1
        changed.append((c, d))

print("=== DETERMINISTIC BASELINE (recomputed from evidence) ===")
for k in ("REMOVE", "REVIEW", "KEEP"):
    print(f"  {k:7s} n={det_count[k]:3d} dur={det_dur[k]:7.2f}s")
print("=== FINAL (after RIISHE_INFERENCE) ===")
for k in ("REMOVE", "REVIEW", "KEEP"):
    print(f"  {k:7s} n={fin_count[k]:3d} dur={fin_dur[k]:7.2f}s")
print("=== SEMANTIC OVERRIDES (deterministic -> final) ===")
for k, n in sorted(overrides.items(), key=lambda kv: -kv[1]):
    print(f"  {k}: {n}")
tot_override = sum(overrides.values())
print(f"  total changed: {tot_override}/123")

print("\n=== WHERE DID REMOVE GO? (deterministic REMOVEs and their final class) ===")
for c, d in changed:
    if d == "REMOVE":
        print(f"  {c['id']:8s} {c['start']:8.2f}-{c['end']:8.2f} dur={c['duration']:.2f} -> {c['review']} :: {str(c['reason'])[:90]}")

print("\n=== LONGEST DETERMINISTIC-KEEP CANDIDATES (hidden by KEEP) ===")
det_keep = [(c, deterministic(c)[0]) for c in cands]
for c, d in sorted(det_keep, key=lambda t: -t[0]['duration']):
    if d == "KEEP":
        e = c['evidence']
        print(f"  {c['id']:8s} {c['start']:8.2f}-{c['end']:8.2f} dur={c['duration']:.2f} pause={e['pauseSec']:.2f} intra={e['intraSentence']} quiet={e['quietSpeechNearby']} rms={e['rms']:.4f} :: {str(c['reason'])[:80]}")

print("\n=== REVIEW CANDIDATES WITH ZERO WORDS (dead air parked in REVIEW) ===")
for c in cands:
    e = c['evidence']
    if c['review'] == 'REVIEW' and e['transcriptWordsInRange'] == 0:
        print(f"  {c['id']:8s} {c['start']:8.2f}-{c['end']:8.2f} dur={c['duration']:.2f} pause={e['pauseSec']:.2f} rms={e['rms']:.4f} snr={e['snr']:.1f} :: {str(c['reason'])[:80]}")
