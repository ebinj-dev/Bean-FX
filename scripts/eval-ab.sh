#!/bin/bash
# eval-ab.sh <js> — run agent-browser eval, strip quotes, print raw
agent-browser eval "$1" 2>/dev/null | tail -1 | python3 -c "
import sys, json
s = sys.stdin.read().strip()
try:
    v = json.loads(s)
    if isinstance(v, str): v = json.loads(v) if v.startswith('{') or v.startswith('[') else v
    print(v if isinstance(v, str) else json.dumps(v))
except Exception:
    print(s)"
