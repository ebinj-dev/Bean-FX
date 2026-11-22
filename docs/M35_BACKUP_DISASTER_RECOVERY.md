# M35 Track G — Backup & Disaster Recovery

**Principle:** procedures are designed AND drilled where the sandbox allows; anything undrilled is labeled a TARGET, never a guarantee. No existing backups are deleted; no live DB is touched.

## 1. Assets and coverage

| Asset | Backup mechanism | Frequency (TARGET) | Retention (TARGET) |
|---|---|---|---|
| Database (all tables incl. users, sessions, projects, timelines, jobs, exports, masks metadata, provider config metadata) | consistent snapshot (`VACUUM INTO`/`.backup`) to a dedicated dir — `scripts/backup-db.sh` (sqlite) / `scripts/m35-backup-drill.ts` (bun:sqlite equivalent) | nightly + before any maintenance | 7 daily + 4 weekly + 6 monthly |
| Original media, proxies, generated assets | file-tree sync to off-host target — `scripts/p0_backup_media.sh` (existing, rsync-based) | nightly (after DB backup so paths/metadata stay consistent) | same rotation; media is irreplaceable → longest retention |
| Rendered exports | same media sync (export area) | nightly | same rotation; deletable artifacts → may be excluded by owner preference |
| Native project files + project package manifests | contained in DB (timelines) + package area files | nightly (covered by DB+media sync) | same rotation |
| Collaboration data (invitations, reviews) | in DB | nightly (covered) | same |
| User settings | in DB | nightly (covered) | same |
| Provider configuration metadata | in DB (credentials stay in env — NOT backed up, re-injected per Track F §3) | nightly (covered) | same |

**Encryption:** TARGET — backups at rest encrypted (e.g., `age`/`gpg` asymmetric to an owner-held key) before leaving the host. Off-host transport over rsync-over-SSH or S3-compatible with SSE. Key management is an owner action (never in chat/repo).

## 2. RPO / RTO (TARGETS requiring qualification — no guarantees invented)

| Metric | Target | Basis | Status |
|---|---|---|---|
| RPO — database | ≤ 24 h (nightly) | nightly snapshot cadence | TARGET (drill proves restore works; real-host cadence to be scheduled) |
| RPO — media | ≤ 24 h | nightly sync | TARGET |
| RTO — full host loss | ≤ 4 h on a replacement host | restore = provision host → restore DB + media → start service; drill-measured restore times feed the real number | TARGET (restore mechanics VERIFIED in drill; full-host rehearsal INFRASTRUCTURE REQUIRED) |
| RTO — DB only | ≤ 15 min | restore-to-scratch measured in drill (seconds at current size) + cutover | TARGET |

## 3. Restore procedure (drilled)

1. Provision/repair host; create app user + dirs (Track J).
2. Restore DB from latest snapshot **to a scratch file first** (`restore-db.sh sqlite` or drill step 3) — never in place.
3. Verify: `PRAGMA integrity_check` = ok; row-count comparison source-vs-restored across core tables (User/Project/MediaAsset/Job/Session/ExportFile); sample media SHA-256 (drill step 6 verifies restored DB rows still reference existing media files).
4. Point `DATABASE_URL` at the restored file; restart service; run `/api/health` + Track J checklist items 3–10 (login, project create, upload, timeline, render, export download, package/import).
5. **Restored-project media locatability:** the drill's row-count + media-checksum step proves DB paths and files were restored together (they live in the same tree, synced by the same run — path-relative layout keeps them consistent).

## 4. Drill evidence (this milestone, isolated, VERIFIED)

- Tool: `scripts/m35-backup-drill.ts` (bun:sqlite — the `sqlite3` CLI is absent in this sandbox; same semantics: consistent snapshot + integrity + isolated restore + row comparison).
- Result: **DRILL_PASS** — snapshot integrity ok, restored copy integrity ok, row counts equal across core tables, sample media hashed (full output in `download/m35/evidence/backup-drill.log`). Executed against the M35 regression scratch DB (`/tmp/m35-m20.db` + `/tmp/m35-m20-store`), quiescent after the M20 suite — never against the dev DB.
- Existing drills preserved: `backup-db.sh`/`restore-db.sh` (M20 §6) remain the primary tooling where the `sqlite3` CLI exists; `m31-backup-restore.ts` and `p0_backup_media.sh` remain qualified tooling.

## 5. Integrity verification & orphan policy

- Every backup: integrity check + row-count compare at backup time (both scripts do this).
- Quarterly full-media checksum audit (TARGET; script: extend drill to walk the whole tree).
- Orphan cleanup: render tmp files auto-cleaned (M20-verified); orphaned user media = manual review with the reconcile idea documented in Track D §2B (no destructive automation added).
