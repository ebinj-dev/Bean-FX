# M36 — Backup, Restore & Disaster-Recovery Operations (Phase D)

**Baseline:** M35's `DRILL_PASS` drill (`m35-backup-drill.ts`, M35_BACKUP_DISASTER_RECOVERY.md). Inspected; the real operational gap it identified (no single-command backup with media, manifest, retention, refusals, exit codes) is closed by `scripts/m36-backup.ts`. The M20-era `backup-db.sh`/`restore-db.sh` remain for hosts with the `sqlite3` CLI; no duplicate semantics were invented (same VACUUM-INTO snapshot basis).

## 1. Backup

```
bun scripts/m36-backup.ts backup --db file:<db> --media <root> --out <dir> [--verify] [--keep N]
```

- **Consistent snapshot:** SQLite `VACUUM INTO` from a read-only connection (single pass, consistent pages).
- **Media backup:** full tree copy under the snapshot (`media/`), including uploads/exports/masks/packages; skips health-probe litter (`.health-*`).
- **Manifest (`manifest.json`):** timestamp, tool, db identity (source path, **sha256**, integrity result, byte size, core-table row counts: User/Project/MediaAsset/Job/Session/ExportFile), and **every media file's sha256 + size**. This is the integrity metadata and the restore-verification contract.
- **Verification:** `--verify` re-hashes db + every media file after publish (`BACKUP_VERIFY_OK`).
- **Atomic publish:** assembled in `<snap>.tmp`, then renamed; on any failure the temp dir is removed and the live tree is never touched (F8b: no partial artifacts left).
- **Retention:** `--keep N` (default 14) prunes oldest `beanfx-backup-*` dirs; existing backups are never deleted beyond the newest-N policy.
- **Exit codes:** 0 ok · 1 backup failed · 2 verification failed · 3 restore failed · 4 prune failed — every failure is explicit.

Verified live (isolated data): `BACKUP_OK … integrity=ok` → `OFF-HOST BACKUP: CONFIGURATION REQUIRED` → `BACKUP_VERIFY_OK all hashes re-checked`; retention pruned to the configured count.

## 2. Restore

```
bun scripts/m36-backup.ts restore --snapshot <dir> --target-root <isolated-dir>
```

- **Refuses live overwrite explicitly** (exit 3): target equals the manifest's recorded `db.sourcePath` or `media.sourceRoot`; target DB path equals the *current process* `DATABASE_URL`; target media root equals the *current* `BEANFX_DATA_DIR`. Verified: `RESTORE_FAIL: target root equals a recorded live source path — refuse`.
- **Verification before publish:** `integrity_check` on the restored DB, core-table row-count comparison against the manifest (`2->2 OK … 7->7 OK`), and **sha256 of every restored media file against the manifest**. A single mismatch aborts the restore and cleans the temp dir.
- Publish only after verification; the restored root is self-contained (`beanfx-staging.db` + `media-store/`) — point a scratch env at it and re-run `m36-db-ops verify` + app health (rehearsal steps 14–16 do exactly this).

## 3. Off-host requirement (honest)

A local snapshot is **not** an off-host backup. Until an adapter is configured, every backup prints:

`OFF-HOST BACKUP: CONFIGURATION REQUIRED`

**Adapter contract (documented requirement, not implemented — no uploads to any provider performed):** a small post-snapshot hook that (1) reads only published snapshot dirs, (2) verifies the manifest hash before transfer, (3) transfers to an encrypted, versioned, off-host target over rsync-over-SSH or an S3-compatible endpoint **chosen and paid for by the owner**, (4) records transfer completion in the manifest, (5) never deletes remote data (retention is restore-safe). Until then, off-host DR depends on the owner moving `backups/` snapshots off the host manually.

## 4. Operator runbook

**Nightly backups (cron/systemd timer):**
```
0 3 * * * cd /home/beanfx/Bean-FX && \
  $(grep -E '^DATABASE_URL=' /home/beanfx/.env.staging | sed 's/^DATABASE_URL=//; s/"//g') >/dev/null && \
  bun scripts/m36-backup.ts backup --db "file:/home/beanfx/data/beanfx-staging.db" \
    --media /home/beanfx/data/media-store --out /home/beanfx/data/backups --verify --keep 14 \
  >> /home/beanfx/data/logs/backup.log 2>&1 || echo "BACKUP_FAILED $(date -Is)" >> /home/beanfx/data/logs/backup.log
```
(Non-zero exit + `BACKUP_FAILED` line = explicit failure; the health check flags backups older than 26 h as DEGRADED.)

**Quarterly restore drill (REQUIRED evidence for staging):**
1. `m36-backup.ts restore --snapshot <latest> --target-root /tmp/drill-restore`
2. `DATABASE_URL="file:/tmp/drill-restore/beanfx-staging.db" bun scripts/m36-db-ops.ts verify --url …` → `integrity=ok`
3. Start the app against the restored root on a scratch port; require `/api/health` 200 and a project/media load.
4. Record the evidence (row counts + media hashes from the restore output) in the ops log.

**Backup failure:** check `backup.log` exit line → common causes: disk ≥85% (clean up AFTER confirming a good snapshot exists elsewhere), media-root permission change, DB integrity failure (escalate to restore procedure — never attempt in-place repair).

**Restore failure:** the tool reports the exact mismatch (hash count / row table / integrity); re-verify the snapshot with `--verify`; if the snapshot itself is corrupt, fall back to the previous retained snapshot.

**RPO/RTO (unchanged from M35 — TARGETS, not guarantees):** DB/media RPO ≤ 24 h with the nightly cadence; restore mechanics measured in seconds at beta scale; full-host RTO ≤ 4 h TARGET pending a real-host rehearsal (OWNER ACTION).
