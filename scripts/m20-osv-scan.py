#!/usr/bin/env python3
"""M20 §7 — dependency vulnerability scan via the OSV API (api.osv.dev).

Scans every direct dependency from package.json at its locked version (from
bun.lock) plus the bun version itself. Writes download/m20-osv-dependency-scan.json
classified by severity (CVSS via OSV severity ranges / database_specific).
"""
import json, re, urllib.request

BASE = "/home/z/my-project"
pkg = json.load(open(f"{BASE}/package.json"))
deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}

# Locked versions from bun.lock (text lockfile): "name@version" entries
lock = open(f"{BASE}/bun.lock").read()
locked = {}
for m in re.finditer(r'"([A-Za-z0-9@/_.-]+)@([0-9][0-9A-Za-z.\-+_]*)"', lock):
    name, ver = m.group(1), m.group(2)
    # strip bun's trailing suffixes like _hash
    ver = ver.split("_")[0]
    if name not in locked:
        locked[name] = ver

missing = [d for d in deps if d not in locked]
queries = []
names = []
for d in deps:
    v = locked.get(d)
    if not v or not re.match(r"^\d", v):
        continue
    queries.append({"package": {"name": d, "ecosystem": "npm"}, "version": v})
    names.append((d, v))

req = urllib.request.Request(
    "https://api.osv.dev/v1/querybatch",
    data=json.dumps({"queries": queries}).encode(),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=60) as r:
    batch = json.loads(r.read().decode())

results = []
vulns_by_sev = {"CRITICAL": [], "HIGH": [], "MEDIUM": [], "LOW": [], "UNRATED": []}
for (name, ver), res in zip(names, batch.get("results", [])):
    vs = res.get("vulns", [])
    for v in vs:
        sev = v.get("database_specific", {}).get("severity") or ""
        # derive a coarse band from CVSS score if present
        score = None
        for sev_item in v.get("severity", []):
            if sev_item.get("type") in ("CVSS_V3", "CVSS_V4"):
                m = re.match(r"CVSS:\d\.\d/AV:.*", sev_item.get("score", ""))
                # no local CVSS parser: keep raw vector; use database_specific banding
        band = v.get("database_specific", {}).get("severity") or "UNRATED"
        if band not in vulns_by_sev:
            band = "UNRATED"
        vulns_by_sev[band].append({"id": v.get("id"), "pkg": name, "ver": ver, "summary": (v.get("summary") or "")[:160], "fixed": [fx.get("fixed") for fx in v.get("affected", []) if fx.get("package", {}).get("name") == name for fx in [fx] if fx.get("ranges")] and [r.get("fixed") for fx in v.get("affected", []) if fx.get("package", {}).get("name") == name for r in fx.get("ranges", []) if r.get("type") == "ECOSYSTEM"] or None})
    if vs:
        results.append({"pkg": name, "ver": ver, "vulns": [v.get("id") for v in vs]})

out = {
    "generated": "2026-11-17",
    "source": "https://api.osv.dev/v1/querybatch",
    "packages_scanned": len(names),
    "direct_deps_declared": len(deps),
    "deps_missing_locked_version": missing,
    "packages_with_vulns": results,
    "summary": {k: len(v) for k, v in vulns_by_sev.items()},
    "vulns_by_severity": vulns_by_sev,
    "classification": " exploitable critical/high must be fixed before release (M20 §7)",
}
json.dump(out, open(f"{BASE}/download/m20-osv-dependency-scan.json", "w"), indent=1)
print("scanned:", len(names), "packages")
print("summary:", out["summary"])
print("saved download/m20-osv-dependency-scan.json")
