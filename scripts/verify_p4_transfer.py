#!/usr/bin/env python3
"""Verify BEAN-FX-P4-WINDOWS-TRANSFER.zip.

Checks, per entry:
  1. archive integrity (zip CRC test);
  2. the entry list is EXACTLY the five payload files + SHA256SUMS.txt
     (proves no db/media/backup/.env/.git/node_modules or unrelated content);
  3. every payload entry's SHA-256 matches both the embedded manifest and a
     fresh hash of the source file in the workspace, and the bytes are
     identical to the source (byte-exact transfer).
Exits non-zero on any failure.
"""
import hashlib
import sys
import zipfile
from pathlib import Path

ROOT = Path("/home/z/my-project")
ZIP = ROOT / "download" / "BEAN-FX-P4-WINDOWS-TRANSFER.zip"

PAYLOAD = [
    "src/lib/media-storage.ts",
    ".env.example",
    ".gitignore",
    "scripts/p3_e2e_test.ps1",
    "download/P4_STORAGE_PORTABILITY_REPORT.md",
]
EXPECTED_ENTRIES = set(PAYLOAD) | {"SHA256SUMS.txt"}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    ok = True
    with zipfile.ZipFile(ZIP) as zf:
        bad = zf.testzip()
        if bad is not None:
            print(f"FATAL: CRC failure in entry: {bad}")
            return 2
        print("zip CRC integrity: OK")

        names = set(zf.namelist())
        if names != EXPECTED_ENTRIES:
            ok = False
            print("FATAL: entry list mismatch")
            print(f"  missing: {sorted(EXPECTED_ENTRIES - names)}")
            print(f"  extra  : {sorted(names - EXPECTED_ENTRIES)}")
        else:
            print(f"entry list closed: exactly {len(names)} expected entries, nothing extra")

        manifest = zf.read("SHA256SUMS.txt").decode("utf-8")
        manifest_map: dict[str, str] = {}
        for line in manifest.splitlines():
            if not line.strip():
                continue
            digest, rel = line.split("  ", 1)
            manifest_map[rel] = digest
        if set(manifest_map) != set(PAYLOAD):
            ok = False
            print(f"FATAL: manifest file list mismatch: {sorted(manifest_map)}")
            return 1

        for rel in PAYLOAD:
            data = zf.read(rel)
            entry_hash = sha256_bytes(data)
            src = (ROOT / rel).read_bytes()
            src_hash = sha256_bytes(src)
            checks = {
                "hash==manifest": entry_hash == manifest_map[rel],
                "hash==source": entry_hash == src_hash,
                "bytes==source": data == src,
                "non-empty": len(data) > 0,
            }
            status = "OK  " if all(checks.values()) else "FAIL"
            if not all(checks.values()):
                ok = False
                failed = [k for k, v in checks.items() if not v]
                print(f"{status} {rel}  FAILED: {failed}")
            else:
                print(f"{status} {rel}  {entry_hash}  {len(data)} bytes")

        print(f"SHA256SUMS.txt embedded ({len(manifest_map)} entries, sha256 of manifest: "
              f"{sha256_bytes(manifest.encode('utf-8'))})")

    print("ALL CHECKS PASSED" if ok else "CHECKS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
