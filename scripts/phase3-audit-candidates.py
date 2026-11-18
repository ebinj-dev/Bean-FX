#!/usr/bin/env python3
"""Phase 3 — candidate classification audit for the user's 123-candidate run."""
import json, sys
from collections import defaultdict

PATH = 'media-store/analysis-results/cmw5z3bxf000etzvdcygc5nkm.json'
j = json.load(open(PATH))

cands = j['candidates']
print(f"media={j['mediaId']} name={j['originalName']} duration={j['durationSec']:.3f}s sr={j['sampleRate']}")
print(f"inference: {json.dumps(j['inference'])[:500]}")
print()

def dur(c): return float(c['end']) - float(c['start'])

# group by class
by_class = defaultdict(list)
for c in cands:
    by_class[c.get('classification') or c.get('cls') or c.get('label')].append(c)

print("=== CLASS BREAKDOWN ===")
for cls, lst in sorted(by_class.items()):
    d = sum(dur(c) for c in lst)
    print(f"{cls}: n={len(lst)} total={d:.2f}s avg={d/len(lst):.3f}s min={min(dur(c) for c in lst):.3f}s max={max(dur(c) for c in lst):.3f}s")

# candidate kinds
by_kind = defaultdict(list)
for c in cands:
    by_kind[c.get('kind') or c.get('type') or '?'].append(c)
print("\n=== KIND BREAKDOWN ===")
for k, lst in sorted(by_kind.items()):
    d = sum(dur(c) for c in lst)
    cls_counts = defaultdict(int)
    for c in lst: cls_counts[c.get('classification') or '?'] += 1
    print(f"{k}: n={len(lst)} total={d:.2f}s classes={dict(cls_counts)}")

# plan
p = j['plan']
print(f"\n=== PLAN === removals={len(p['removals'])} removedSec={p['removedSec']:.3f} final={p['finalDurationSec']:.3f}")
for r in p['removals'][:20]:
    print(f"  plan removal: {r.get('start'):.2f}-{r.get('end'):.2f} ({float(r['end'])-float(r['start']):.2f}s) reason={r.get('reason','?')}")

# sample candidate of each class with full fields
print("\n=== SAMPLE CANDIDATE PER CLASS (full record) ===")
seen = set()
for c in cands:
    cls = c.get('classification') or '?'
    if cls not in seen:
        seen.add(cls)
        print(f"[{cls}] {json.dumps(c, ensure_ascii=False)[:700]}")

# approval / override fields
print("\n=== FIELD VALUE DISTRIBUTIONS ===")
for f in ['decision', 'decisionSource', 'source', 'origin', 'approved', 'userAction', 'override', 'semantic', 'semanticClass', 'confidence', 'review']:
    vals = defaultdict(int)
    for c in cands:
        v = c.get(f, '<absent>')
        vals[json.dumps(v) if isinstance(v, (dict, list)) else str(v)] += 1
    if len(vals) > 0:
        top = sorted(vals.items(), key=lambda kv: -kv[1])[:8]
        print(f"{f}: {top}")

# reasons
print("\n=== TOP REASONS PER CLASS ===")
for cls, lst in sorted(by_class.items()):
    reasons = defaultdict(int)
    for c in lst:
        r = c.get('reason') or c.get('why') or c.get('rationale') or '?'
        reasons[str(r)[:110]] += 1
    print(f"[{cls}]")
    for r, n in sorted(reasons.items(), key=lambda kv: -kv[1])[:6]:
        print(f"   {n:3d}x {r}")
