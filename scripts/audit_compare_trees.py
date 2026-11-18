#!/usr/bin/env python3
"""Compare current workspace vs /tmp/my-project snapshot (Nov 10 02:08, P4-complete).

Read-only. Excludes dependency caches, build output, git internals and raw data
dirs (db/, media-store/, upload/ are reported separately as data-status lines).
"""
import hashlib
import json
import os
import sys

CUR = "/home/z/my-project"
SNAP = "/tmp/my-project"

EXCLUDE_DIRS = {
    "node_modules", ".deps-mirror", ".models-mirror", ".git", ".next",
    "media-store", "upload", "db", "skills", "sidecar", "models",
    "BEAN-FX-Source-Export", "backups", "download", "examples", "bench",
}
EXCLUDE_FILES = {"dev.log", ".env", "BEAN-FX-Source-Code.zip",
                 ".initial_snapshot.json"}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def walk(root):
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            if fn in EXCLUDE_FILES:
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root)
            try:
                out[rel] = sha256(full)
            except (PermissionError, OSError) as e:
                out[rel] = f"UNREADABLE:{type(e).__name__}"
    return out


cur = walk(CUR)
snap = walk(SNAP)

missing = sorted(set(snap) - set(cur))
added = sorted(set(cur) - set(snap))
common = sorted(set(snap) & set(cur))
reverted = [r for r in common
            if snap[r] != cur[r]
            and not snap[r].startswith("UNREADABLE")
            and not cur[r].startswith("UNREADABLE")]
unreadable_cur = [r for r in common if cur[r].startswith("UNREADABLE")]
unreadable_snap = [r for r in common if snap[r].startswith("UNREADABLE")]

result = {
    "missing_in_current": missing,
    "only_in_current": added,
    "content_differs": reverted,
    "identical_count": len(common) - len(reverted) - len(unreadable_cur),
    "unreadable_in_current": unreadable_cur,
    "unreadable_in_snapshot": unreadable_snap,
}
print(json.dumps(result, indent=1))
