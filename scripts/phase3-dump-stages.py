#!/usr/bin/env python3
"""Phase 3 — targeted dump: stages, notes, transcript coverage, REMOVE/REVIEW candidates."""
import json
from collections import defaultdict

j = json.load(open('media-store/analysis-results/cmw5z3bxf000etzvdcygc5nkm.json'))

print("=== NOTES ===")
print(json.dumps(j['notes'], indent=1, ensure_ascii=False)[:1500])

print("\n=== STAGES ===")
for k, v in j['stages'].items():
    print(f"-- {k}: {json.dumps(v, ensure_ascii=False)[:450]}")

t = j['transcript']
print("\n=== TRANSCRIPT META ===")
meta = {k: v for k, v in t.items() if k not in ('text', 'segments')}
print(json.dumps(meta, indent=1, ensure_ascii=False)[:1200])
segs = t.get('segments') or []
print(f"segments: {len(segs)}")
if segs:
    print("segment[0]:", json.dumps(segs[0], ensure_ascii=False)[:400])
    print("segment[-1]:", json.dumps(segs[-1], ensure_ascii=False)[:400])
    # coverage
    total_speech = sum(float(s.get('end', 0)) - float(s.get('start', 0)) for s in segs)
    print(f"total speech span (sum of segment durations): {total_speech:.1f}s of {j['durationSec']:.1f}s")
    # inter-segment gaps
    gaps = []
    ordered = sorted(segs, key=lambda s: float(s.get('start', 0)))
    for a, b in zip(ordered, ordered[1:]):
        g = float(b['start']) - float(a['end'])
        if g > 0.05:
            gaps.append((g, float(a['end']), float(b['start'])))
    tot_gaps = sum(g for g, _, _ in gaps)
    print(f"inter-segment gaps >0.05s: n={len(gaps)} total={tot_gaps:.1f}s")
    for th in (0.5, 1.0, 1.5, 2.0, 3.0, 5.0):
        sel = [x for x in gaps if x[0] >= th]
        print(f"  gaps >= {th}s: n={len(sel)} total={sum(x[0] for x in sel):.1f}s")
    big = sorted(gaps, reverse=True)[:15]
    print("  top 15 gaps:")
    for g, s, e in big:
        print(f"    {s:8.2f} -> {e:8.2f}  ({g:5.2f}s)")

print("\n=== REMOVE + REVIEW CANDIDATES (all) ===")
for c in j['candidates']:
    if c.get('review') in ('REMOVE', 'REVIEW'):
        print(json.dumps({k: c[k] for k in ('id', 'start', 'end', 'duration', 'review', 'confidence', 'reason')}, ensure_ascii=False)[:420])

print("\n=== classificationSource distribution ===")
cs = defaultdict(int)
for c in j['candidates']:
    cs[c.get('classificationSource', '?')] += 1
print(dict(cs))

print("\n=== longest candidates (top 20 by duration) ===")
for c in sorted(j['candidates'], key=lambda c: -float(c['duration']))[:20]:
    print(f"  {c['id']:8s} {c['start']:8.2f}-{c['end']:8.2f} dur={c['duration']:5.2f}s review={c['review']:6s} intra={c.get('evidence', {}).get('intraSentence')} conf={c.get('confidence')} :: {str(c.get('reason'))[:100]}")
