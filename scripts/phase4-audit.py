#!/usr/bin/env python3
"""Phase 4 (zero-cut diagnosis) audit of the 20:19 RIISHE job result."""
import json, collections, sys

F = "/home/z/my-project/media-store/analysis-results/cmw5tdcjm0001slfxsmu5v5ny.json"
d = json.load(open(F))

print("== header ==")
for k in ("ok","mediaId","originalName","durationSec","sampleRate","fromCache","inferenceNote"):
    print(f"  {k} = {d.get(k)!r}")
print("  inference =", json.dumps(d.get("inference"), ensure_ascii=False)[:400])
print("  notes =", json.dumps(d.get("notes"), ensure_ascii=False)[:600])

print("\n== stages ==")
for s in (d.get("stages") or []):
    print("  ", json.dumps(s, ensure_ascii=False)[:300])

print("\n== transcript ==")
t = d.get("transcript")
if isinstance(t, dict):
    print("  keys:", list(t.keys()))
    for k, v in t.items():
        if isinstance(v, list):
            print(f"  {k}: list[{len(v)}]", json.dumps(v[0], ensure_ascii=False)[:200] if v else "")
        else:
            print(f"  {k} = {str(v)[:200]}")
else:
    print("  ", str(t)[:300])

print("\n== plan ==")
print(" ", json.dumps(d.get("plan"), ensure_ascii=False)[:400])

print("\n== analysis (non-candidate fields) ==")
a = d.get("analysis")
if isinstance(a, dict):
    for k, v in a.items():
        if isinstance(v, list):
            print(f"  {k}: list[{len(v)}]")
        elif isinstance(v, dict):
            print(f"  {k}: dict {list(v.keys())[:10]}")
        else:
            print(f"  {k} = {str(v)[:150]}")

cands = d.get("candidates") or []
print(f"\n== candidates: {len(cands)} ==")
print("  fields of first:", list(cands[0].keys()) if cands else None)
kinds = collections.Counter(c["id"].split("-")[0] for c in cands)
print("  id prefixes:", dict(kinds))
finals = collections.Counter(c.get("review") or c.get("classification") for c in cands)
print("  final review distribution:", dict(finals))
origs = collections.Counter(c.get("original") or c.get("provisional") or c.get("detect") for c in cands)
print("  'original/provisional' distribution:", dict(origs))
srcs = collections.Counter(c.get("classificationSource") for c in cands)
print("  classificationSource:", dict(srcs))
conf = collections.Counter(c.get("confidence") for c in cands)
print("  confidence histogram:", dict(sorted(conf.items(), key=lambda x: str(x[0]))))
reasons = collections.Counter(c.get("reason","") for c in cands)
print(f"  distinct reasons: {len(reasons)}")
for r, n in reasons.most_common(12):
    print(f"    [{n:3d}] {r[:130]}")
durs = [c.get("duration") or round((c.get("end",0)-c.get("start",0)),2) for c in cands]
print(f"  candidate durations: min={min(durs)} max={max(durs)} sum={sum(durs):.1f}s")
ev = [c for c in cands if c.get("evidence")]
print(f"  candidates carrying evidence field: {len(ev)}", json.dumps(ev[0], ensure_ascii=False)[:260] if ev else "")

# dump full table
with open("/home/z/my-project/scripts/audit-candidates-20m19.tsv","w") as w:
    w.write("id\tstart\tend\tduration\tfinal\tconfidence\tsource\treason\n")
    for c in cands:
        w.write(f"{c.get('id')}\t{c.get('start')}\t{c.get('end')}\t{c.get('duration')}\t{c.get('review')}\t{c.get('confidence')}\t{c.get('classificationSource')}\t{(c.get('reason') or '').replace(chr(10),' ')}\n")
print("\nwrote scripts/audit-candidates-20m19.tsv")
