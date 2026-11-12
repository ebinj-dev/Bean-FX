#!/usr/bin/env python3
"""Generate docs/FILE_INVENTORY.md from the actual BEAN-FX-Source-Export tree."""
import os
from datetime import date

ROOT = "/home/z/my-project/BEAN-FX-Source-Export"
OUT = os.path.join(ROOT, "docs", "FILE_INVENTORY.md")

DIR_NOTES = {
    "src/app/api": "22 API routes (auth, media, projects, jobs, exports, transcribe, riishe, autocut, process/*)",
    "src/components/bean": "application UI (hash-routed studio)",
    "src/components/bean/tools": "the five tools: auto-cut, captions, audio-tool, watermark, broll",
    "src/components/ui": "48 shadcn/radix primitives",
    "src/hooks": "use-mobile, use-toast",
    "src/lib": "engine + server libraries (db, auth, media-storage, job-runner, autocut-analysis, riishe-inference, riishe-safety, asr-providers, srt/srt-vtt, client-api, ...)",
    "prisma": "schema.prisma (SQLite, 7 models; db-push workflow, no migrations)",
    "db": "empty placeholder (.gitkeep) — custom.db is created by `bun run db:push`",
    "public": "logo.svg, robots.txt",
    "tests": "platform packaging checks (shell) — not needed to run the app",
    "examples": "websocket example from the original template — unused by the app, excluded from tsconfig",
    "mini-services": "optional microservice slot; empty is normal",
    "scripts": "developer probes & one-off tooling used during development (NOT needed to build/run; data-dump JSONs and sandbox-specific P0 backup scripts were excluded from the export)",
    ".zscripts": "original deployment scripts (dev.sh, start.sh, build.sh, mini-services-*, runtime builds)",
    "docs": "the documentation you are reading",
}

def dircount(path):
    n = 0
    for _, _, files in os.walk(path):
        n += len(files)
    return n

lines = []
lines.append("# BEAN FX — File Inventory\n")
lines.append(f"Generated from this archive's actual contents on {date.today().isoformat()}. "
             "This is the real file list of the export, not a hand-written summary.\n")

# summary by top-level entry
lines.append("## Top-level overview\n")
lines.append("| Entry | Kind | Files | Notes |")
lines.append("|---|---|---|---|")
entries = sorted(os.listdir(ROOT))
total = 0
for e in entries:
    p = os.path.join(ROOT, e)
    if os.path.isdir(p):
        n = dircount(p)
        total += n
        lines.append(f"| `{e}/` | dir | {n} | {DIR_NOTES.get(e, '')} |")
    else:
        total += 1
        size = os.path.getsize(p)
        lines.append(f"| `{e}` | file | 1 | {size:,} bytes |")
lines.append(f"\n**Total files:** {total} (excluding this document's own directory counting is still accurate — numbers are per directory walk)\n")

# full tree (dirs with files), skipping docs itself to avoid self-reference noise
lines.append("\n## Complete file list\n")
skip_for_tree = {"docs"}
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames.sort()
    rel = os.path.relpath(dirpath, ROOT)
    if rel == ".":
        rel = ""
    top = rel.split(os.sep)[0] if rel else ""
    if top in skip_for_tree:
        continue
    if rel:
        lines.append(f"\n### `{rel}/`" + (f" — {DIR_NOTES.get(top, '')}" if os.path.dirname(rel) == "" and top in DIR_NOTES else ""))
    for f in sorted(filenames):
        fp = os.path.join(dirpath, f)
        size = os.path.getsize(fp)
        kb = f"{size/1024:.1f} KB" if size >= 1024 else f"{size} B"
        lines.append(f"- `{f}` ({kb})")

lines.append("\n### `docs/`\n")
for f in sorted(os.listdir(os.path.join(ROOT, "docs"))):
    lines.append(f"- `{f}`")

lines.append("\n## Deliberately excluded from this archive\n")
lines.append("""
- `node_modules/`, `.next/`, `*.tsbuildinfo` — dependencies and build outputs (recreated by `bun install` / `bun run build`)
- `.git/` — version history
- `.env` — real environment file (`.env.example` with placeholders is included)
- `db/custom.db` — live SQLite database (schema ships in `prisma/`; DB is created by `db:push`)
- `media-store/` — all user media, analysis results, ASR caches, waveforms, exports
- `backups/` — database/media backups and restore-verification copies
- `upload/`, `download/`, `skills/` — sandbox workspace areas unrelated to the source
- `dev.log`, `server.log`, `.zscripts/dev.pid`, `*.tsbuildinfo` — logs, PID files, build cache
- `scripts/ORIGINAL_RESULT.json`, `scripts/alignment.json`, `scripts/audit_accounting.json`,
  `scripts/deadair_edited.json`, `scripts/deadair_original.json` — one-off analysis data dumps
- `scripts/p0_backup_db.sh`, `scripts/p0_backup_media.sh`, `scripts/p0_restore_verify.sh` —
  sandbox-specific backup tooling (hardcoded `/home/z/my-project` paths)
""")

with open(OUT, "w") as fh:
    fh.write("\n".join(lines) + "\n")
print("wrote", OUT, os.path.getsize(OUT), "bytes")
print("total files counted:", total)
