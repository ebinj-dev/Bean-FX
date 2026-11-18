#!/usr/bin/env python3
"""Phase 3 — before/after acceptance audit of the re-run result."""
import json, sys
from collections import defaultdict

NEW = sys.argv[1] if len(sys.argv) > 1 else None
OLD = 'media-store/analysis-results/cmw5z3bxf000etzvdcygc5nkm.json'

def stats(path):
    j = json.load(open(path))
    c = j['candidates']
    by = defaultdict(lambda: [0, 0.0])
    for x in c:
        by[x['review']][0] += 1
        by[x['review']][1] += x['duration']
    sil = [x for x in c if str(x['id']).startswith('sil')]
    wod = [x for x in c if str(x['id']).startswith('word')]
    rep = [x for x in c if str(x['id']).startswith('rep')]
    return j, {
        'total': len(c), 'sil': len(sil), 'word': len(wod), 'rep': len(rep),
        'candTotalSec': sum(x['duration'] for x in c),
        'classes': {k: (v[0], round(v[1], 2)) for k, v in by.items()},
        'plan': j['plan'],
        'settings': j.get('settings'),
        'speechSpanCount': j['analysis']['speechSpanCount'],
        'noiseFloor': j['analysis']['noiseFloor'],
        'inference': j.get('inference'),
        'sentences': j['transcript']['alignmentStats']['sentenceCount'],
        'energyValidated': j['transcript']['alignmentStats']['energyValidated'],
    }

o, os_ = stats(OLD)
print("=== BEFORE (user's run, job cmw5z3bxf, unfixed engine) ===")
print(json.dumps(os_, indent=1, default=str)[:900])

if NEW:
    n, ns = stats(NEW)
    print("\n=== AFTER (re-run of the same recording on the fixed engine) ===")
    print(json.dumps(ns, indent=1, default=str)[:900])
    print("\n=== SIDE BY SIDE ===")
    for k in ('total', 'sil', 'word', 'rep', 'candTotalSec', 'speechSpanCount', 'sentences'):
        print(f"  {k:16s} {os_[k]!s:>10} -> {ns[k]!s:>10}")
    print("  classes:")
    for k in ('REMOVE', 'REVIEW', 'KEEP'):
        print(f"    {k:8s} {os_['classes'].get(k, ('-', '-'))} -> {ns['classes'].get(k, ('-', '-'))}")
    print(f"  plan removedSec: {os_['plan']['removedSec']} -> {ns['plan']['removedSec']}")
    print(f"  plan final:      {os_['plan']['finalDurationSec']} -> {ns['plan']['finalDurationSec']}")
    print(f"  settings persisted: {ns['settings']}")

    print("\n=== ALL REMOVE PROPOSALS (the proposed cuts) ===")
    for x in sorted(n['candidates'], key=lambda c: c['start']):
        if x['review'] == 'REMOVE':
            print(f"  {x['id']:8s} {x['start']:9.2f}-{x['end']:9.2f} cut={x['duration']:5.2f}s conf={x['confidence']:.2f} rms={x['evidence']['rms']:.4f} :: {str(x['reason'])[:130]}")

    print("\n=== ALL REVIEW PROPOSALS (uncertain, human decides) ===")
    for x in sorted(n['candidates'], key=lambda c: c['start']):
        if x['review'] == 'REVIEW':
            print(f"  {x['id']:8s} {x['start']:9.2f}-{x['end']:9.2f} cut={x['duration']:5.2f}s conf={x['confidence']:.2f} words={x['evidence']['transcriptWordsInRange']} :: {str(x['reason'])[:130]}")

    src = x = None
    ks = n['classes'].get('KEEP', (0, 0))
    print(f"\nKEEP: n={ks[0]} total={ks[1]}s (sub-second rhythm pauses + speech-adjacent)")
    inf = n['inference'] or {}
    print(f"inference: model={inf.get('model')} classified={inf.get('candidatesClassified')} downgraded={inf.get('downgraded')}")
    print(f"summary: {str(inf.get('summary'))[:400]}")
