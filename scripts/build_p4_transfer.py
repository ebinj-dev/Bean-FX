#!/usr/bin/env python3
"""Build BEAN-FX-P4-WINDOWS-TRANSFER.zip — minimal Windows transfer package.

Transfer-only operation: reads exactly 5 files from the P4 workspace, embeds a
SHA256SUMS.txt manifest, and writes the zip to download/. The source project is
never modified; no database, media, backup, .env (real), .git or node_modules
content is included — the entry list is closed (asserted by the verifier).
"""
import hashlib
import sys
import zipfile
from pathlib import Path

ROOT = Path("/home/z/my-project")
OUT = ROOT / "download" / "BEAN-FX-P4-WINDOWS-TRANSFER.zip"

FILES = [
    "src/lib/media-storage.ts",
    ".env.example",
    ".gitignore",
    "scripts/p3_e2e_test.ps1",
    "download/P4_STORAGE_PORTABILITY_REPORT.md",
]

STAMP = (2026, 11, 10, 0, 0, 0)  # fixed timestamp -> deterministic archive


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    for rel in FILES:
        p = ROOT / rel
        if not p.is_file() or p.stat().st_size == 0:
            print(f"FATAL: missing or empty source file: {rel}", file=sys.stderr)
            return 2

    hashes = {rel: sha256_file(ROOT / rel) for rel in FILES}
    # sha256sum-compatible manifest: "<hex>  <relative-path>" per line, LF endings.
    # SHA256SUMS.txt lists the five payload files; it cannot list itself.
    manifest = "".join(f"{hashes[rel]}  {rel}\n" for rel in FILES)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        def add(name: str, data: bytes) -> None:
            info = zipfile.ZipInfo(name, date_time=STAMP)
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, data)

        for rel in FILES:
            add(rel, (ROOT / rel).read_bytes())
        add("SHA256SUMS.txt", manifest.encode("utf-8"))

    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    for rel in FILES:
        print(f"  {hashes[rel]}  {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
