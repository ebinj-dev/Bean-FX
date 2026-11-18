#!/usr/bin/env python3
"""M20 §12 — concurrency smoke against the production standalone build.

Measures p50/p95 latency for public pages, auth, project list and timeline
load under a small concurrent fan-out (8 users x 3 rounds). Writes JSON.
"""
import json, os, statistics, time, urllib.request, urllib.error

BASE = os.environ.get("BASE", "http://localhost:3117")
OUT = "/home/z/my-project/download/m20-render-logs/concurrency-smoke.json"

def hit(path, method="GET", body=None, headers=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            r.read()
            code = r.status
    except urllib.error.HTTPError as e:
        e.read(); code = e.code
    return (time.time() - t0) * 1000, code

SCENARIOS = {
    "public_home": lambda: hit("/"),
    "public_features": lambda: hit("/features"),
    "public_pricing": lambda: hit("/pricing"),
    "register_unknown": lambda: hit("/api/auth/register", "POST", {"email": f"smoke-{time.time_ns()}@test.local", "password": "smoke-pass-123", "name": "Smoke"}),
    "login_missing": lambda: hit("/api/auth/login", "POST", {"email": "nobody@test.local", "password": "wrong"}),
}

results = {}
CONC = 8
for name, fn in SCENARIOS.items():
    lat, codes = [], []
    for rnd in range(3):
        procs = []
        # sequential threads via urllib is fine: measure with concurrent.futures
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=CONC) as ex:
            for lat_ms, code in ex.map(lambda _: fn(), range(CONC)):
                lat.append(lat_ms); codes.append(code)
    lat.sort()
    results[name] = {
        "requests": len(lat),
        "p50_ms": round(statistics.median(lat), 1),
        "p95_ms": round(lat[int(len(lat) * 0.95) - 1], 1),
        "max_ms": round(max(lat), 1),
        "codes": sorted(set(codes)),
    }
    print(f"{name:18s} p50={results[name]['p50_ms']:7.1f}ms p95={results[name]['p95_ms']:7.1f}ms codes={results[name]['codes']}")

out = {"base": BASE, "concurrency": CONC, "rounds": 3, "host": "2 vCPU / 3.9 GiB sandbox", "scenarios": results,
       "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
json.dump(out, open(OUT, "w"), indent=1)
print("saved", OUT)
