#!/usr/bin/env python3
"""M20 §7 — dependency vulnerability scan via the OSV database (api.osv.dev).

Reads exact resolved versions from bun.lock, queries OSV querybatch (1000 pkgs),
classifies findings by severity (CVSS / database_specific.severity), writes JSON.
"""
import json, re, subprocess, urllib.request

BASE = "/home/z/my-project"
lock = open(f"{BASE}/bun.lock", encoding="utf-8").read()

# bun.lock entries look like: "pkg@1.2.3", or "pkg@1.2.3" : resolved link …
# Also workspace packages "name@workspace:...". Collect name -> resolved version.
pairs = []
for m in re.finditer(r'"([A-Za-z0-9@/._-]+)@([0-9][A-Za-z0-9.\-+~_]*)"', lock):
    name, ver = m.group(1), m.group(2)
    if name in ("node",) or ver.startswith(("workspace",)):
        continue
    pairs.append((name, ver))
# dedupe keeping the first (lock is ordered by resolution)
seen = {}
for n, v in pairs:
    seen.setdefault(n, v)
pkgs = sorted(seen.items())
print(f"resolved {len(pkgs)} packages from bun.lock")

# OSV querybatch (chunks of 500)
def osv_querybatch(chunk):
    body = json.dumps({"queries": [{"package": {"name": n, "ecosystem": "npm"}, "version": v} for n, v in chunk]}).encode()
    req = urllib.request.Request("https://api.osv.dev/v1/querybatch", data=body, headers={"Content-Type": "application.json".replace("application.json", "application/json")})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

findings = []
for i in range(0, len(pkgs), 500):
    chunk = pkgs[i:i + 500]
    try:
        res = osv_querybatch(chunk)
    except Exception as e:
        print("OSV batch error:", e)
        continue
    for (n, v), r in zip(chunk, res.get("results", [])):
        for vuln in r.get("vulns", []):
            sev = None
            for s in vuln.get("severity", []):
                if s.get("type") in ("CVSS_V3", "CVSS_V4"):
                    sev = s.get("score")
            sevdb = vuln.get("database_specific", {}).get("severity")
            findings.append({
                "package": n, "version": v,
                "id": vuln.get("id"), "aliases": vuln.get("aliases", [])[:3],
                "summary": (vuln.get("summary") or vuln.get("details", ""))[:160],
                "severity_cvss": sev, "severity_db": sevdb,
                "fixed": [af.get("fixed") for ra in vuln.get("affected", []) for af in ra.get("ranges", []) if af.get("events") for af2 in [af] for af in [af2] if False] or [ev.get("fixed") for ra in vuln.get("affected", []) if (n in str(ra.get("package", {}))) for ev in [e for rg in ra.get("ranges", []) for e in rg.get("events", []) if "fixed" in e]][:2],
            })

def sev_class(f):
    db = (f.get("severity_db") or "").upper()
    cvss = f.get("severity_cvss") or ""
    if "CRITICAL" in db or (cvss.startswith("CVSS") and any(x in cvss for x in ["9.", "10."])):
        return "CRITICAL"
    if "HIGH" in db or (cvss.startswith("CVSS") and any(x in cvss for x in ["7.", "8."])):
        return "HIGH"
    if "MODERATE" in db or "MEDIUM" in db:
        return "MODERATE"
    return "LOW/UNSPECIFIED"

for f in findings:
    f["class"] = sev_class(f)

from collections import Counter
by_class = Counter(f["class"] for f in findings)
print("findings by severity:", dict(by_class))
for f in findings:
    if f["class"] in ("CRITICAL", "HIGH"):
        print(f"  [{f['class']}] {f['package']}@{f['version']} {f['id']}: {f['summary'][:100]}")

out = {"scanned_packages": len(pkgs), "source": "bun.lock resolved versions", "database": "api.osv.dev querybatch", "findings_count": len(findings), "by_severity": dict(by_class), "findings": findings}
json.dump(out, open(f"{BASE}/download/m20-osv-dependency-scan.json", "w"), indent=1)
print("saved download/m20-osv-dependency-scan.json")
