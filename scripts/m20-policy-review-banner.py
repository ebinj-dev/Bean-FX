#!/usr/bin/env python3
"""M20 §8 — insert the REQUIRES LEGAL REVIEW banner into the three policy pages."""
import re

BASE = "/home/z/my-project/src/app/(public)"
BANNER = (
    '      <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-[13.5px] '
    'leading-relaxed text-[#c9c9c2]">\n'
    '        <strong className="text-red-400">REQUIRES LEGAL REVIEW:</strong> this document describes\n'
    '        verified application behavior and is not legal advice. It must be reviewed and approved by a\n'
    '        qualified legal professional before public commercial launch, together with the owner fields\n'
    '        marked <em>[OWNER TO CONFIRM]</em> in the launch checklist.\n'
    '      </p>\n'
)

pages = ["terms/page.tsx", "privacy/page.tsx", "cookies/page.tsx"]
for rel in pages:
    path = f"{BASE}/{rel}"
    s = open(path).read()
    if "REQUIRES LEGAL REVIEW" in s:
        print(f"{rel}: banner already present — skipped")
        continue
    # insert right after the page h1 line (the last of the h1 lines)
    h1s = list(re.finditer(r'<h1 className="[^"]*">[^<]*</h1>\n', s))
    assert h1s, rel
    anchor = h1s[0]
    s2 = s[: anchor.end()] + BANNER + s[anchor.end():]
    open(path, "w").write(s2)
    print(f"{rel}: banner inserted after h1")
