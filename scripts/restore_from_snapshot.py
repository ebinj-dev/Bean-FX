#!/usr/bin/env python3
"""BEAN FX workspace recovery: restore P3/P4 files from the /tmp snapshot.

Safety rules enforced here:
  - The live database is backed up (sqlite3 online backup) and the backup is
    verified BEFORE any other action. No DB writes happen in this script.
  - The 11 known-reverted code files are overwritten only after recording the
    pre-restore SHA-256 (their content is also preserved in git HEAD @ 97b84a7).
  - Everything else is additive: a file that already exists is never touched.
  - Every restored file is hash-verified against the snapshot source.
"""
import hashlib
import json
import os
import shutil
import sqlite3
import sys
from datetime import datetime

CUR = "/home/z/my-project"
SNAP = "/tmp/my-project"
PKG = f"{SNAP}/download/P3-RECONCILIATION-PACKAGE"
report = {"backup": None, "overwritten": [], "additive": [], "errors": [], "skipped": []}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def restore_file(rel, *, overwrite=False, src_root=SNAP):
    src = os.path.join(src_root, rel)
    dst = os.path.join(CUR, rel)
    if not os.path.isfile(src):
        report["errors"].append(f"source missing: {rel}")
        return False
    if os.path.exists(dst) and not overwrite:
        report["skipped"].append(rel)
        return True
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if overwrite and os.path.exists(dst):
        before = sha256(dst)
        report["overwritten"].append({"file": rel, "sha_before": before,
                                      "sha_after_src": sha256(src)})
    shutil.copy2(src, dst)
    if sha256(dst) != sha256(src):
        report["errors"].append(f"hash mismatch after copy: {rel}")
        return False
    report["additive"].append(rel)
    return True


def phase_a_backup():
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    bdir = f"{CUR}/db/backup-{ts}"
    os.makedirs(bdir, exist_ok=True)
    live = f"{CUR}/db/custom.db"
    bdest = f"{bdir}/custom.db"
    src = sqlite3.connect(f"file:{live}?mode=ro", uri=True)
    dst = sqlite3.connect(bdest)
    with dst:
        src.backup(dst)          # online backup, consistent copy
    dst.close()
    pre_counts = dict(src.execute(
        "SELECT name, (SELECT COUNT(*) FROM pragma_table_info(m.name)) FROM sqlite_master m"
    ).fetchall()) if False else None
    tables = [r[0] for r in src.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    counts = {t: src.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in tables}
    ic = src.execute("PRAGMA integrity_check").fetchone()[0]
    src.close()
    # verify the backup copy independently
    v = sqlite3.connect(f"file:{bdest}?mode=ro", uri=True)
    vic = v.execute("PRAGMA integrity_check").fetchone()[0]
    vtables = [r[0] for r in v.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    vcounts = {t: v.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in vtables}
    v.close()
    ok = ic == vic == "ok" and vcounts == counts
    with open(f"{bdir}/SHA256.txt", "w") as f:
        f.write(f"{sha256(bdest)}  custom.db\n")
    with open(f"{bdir}/MANIFEST.txt", "w") as f:
        f.write(f"BEAN FX verified DB backup {ts}\nsource: db/custom.db (read-only online backup)\n"
                f"integrity live={ic} backup={vic}\ncounts_match={vcounts == counts}\n{json.dumps(counts, indent=1)}\n")
    report["backup"] = {"dir": bdir, "sha256": sha256(bdest),
                        "verified": ok, "integrity": [ic, vic], "row_counts": counts}
    return ok


def main():
    print("=== Phase A: verified DB backup ===")
    if not phase_a_backup():
        print("BACKUP VERIFICATION FAILED — aborting before any restore.")
        sys.exit(1)
    print("backup OK:", report["backup"]["dir"])

    print("=== Phase B: 11 reverted code files (overwrite; old content preserved in git HEAD) ===")
    code = [
        "prisma/schema.prisma",
        "src/app/api/autocut/analyses/route.ts",
        "src/app/api/autocut/decisions/route.ts",
        "src/app/api/autocut/analyze/route.ts",
        "src/app/api/process/autocut/route.ts",
        "src/components/bean/tools/auto-cut.tsx",
        "src/lib/autocut-analysis.ts",
        "src/lib/client-api.ts",
        "src/lib/media-storage.ts",
        "src/lib/riishe-safety.ts",
        "src/lib/types.ts",
    ]
    for rel in code:
        if not restore_file(rel, overwrite=True):
            print("FAILED:", rel, "— aborting")
            sys.exit(1)

    print("=== Phase C: scripts, mini-services (additive only) ===")
    import subprocess
    snap_scripts = subprocess.run(
        ["find", f"{SNAP}/scripts", "-type", "f"],
        capture_output=True, text=True).stdout.split()
    for full in snap_scripts:
        rel = "scripts/" + os.path.basename(full)
        restore_file(rel)
    for root, dirs, files in os.walk(f"{SNAP}/mini-services"):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for fn in files:
            rel = os.path.relpath(os.path.join(root, fn), SNAP)
            restore_file(rel)

    print("=== Phase D: docs, migration, patches, transfer artifacts ===")
    for name in ["P3_PRE_IMPLEMENTATION_AUDIT.md", "P3_IMPLEMENTATION_REPORT.md",
                 "P3_DATABASE_MIGRATION_REPORT.md", "P3_TEST_REPORT.md"]:
        restore_file(f"docs/{name}", src_root=PKG)
    restore_file("migration/p3_migration.sql", src_root=PKG)
    restore_file("patches/p3-changes-vs-ce01c3d.patch", src_root=PKG)
    # download/ artifacts from the P4-complete state
    for name in ["P4_STORAGE_PORTABILITY_REPORT.md", "BEAN-FX-P4-WINDOWS-TRANSFER.zip",
                 "BEAN-FX-P3-TRANSFER.zip"]:
        restore_file(f"download/{name}")
    if os.path.isdir(f"{SNAP}/download/P3-RECONCILIATION-PACKAGE"):
        for root, dirs, files in os.walk(f"{SNAP}/download/P3-RECONCILIATION-PACKAGE"):
            for fn in files:
                rel = os.path.relpath(os.path.join(root, fn), SNAP)
                restore_file(rel)

    print("=== Phase E: media-store (additive only, no overwrites) ===")
    n_media = 0
    for root, dirs, files in os.walk(f"{SNAP}/media-store"):
        for fn in files:
            rel = os.path.relpath(os.path.join(root, fn), SNAP)
            dst = os.path.join(CUR, rel)
            if os.path.exists(dst):
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(os.path.join(root, fn), dst)
            if sha256(dst) != sha256(os.path.join(root, fn)):
                report["errors"].append(f"media hash mismatch: {rel}")
            else:
                n_media += 1
    report["media_restored"] = n_media

    with open(f"{CUR}/scripts/restore_report.json", "w") as f:
        json.dump(report, f, indent=1)
    print(f"\n=== SUMMARY === overwritten={len(report['overwritten'])} "
          f"additive={len(report['additive'])} media={n_media} "
          f"skipped(existed)={len(report['skipped'])} errors={len(report['errors'])}")
    if report["errors"]:
        for e in report["errors"]:
            print("ERROR:", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
