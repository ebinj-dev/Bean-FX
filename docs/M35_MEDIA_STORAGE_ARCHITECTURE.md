# M35 Track D — Media Storage Architecture

**Principle honored:** the current local-filesystem storage is the M34-qualified reality. This document audits it completely, designs the future object-storage path, and does **not** change code or move media. No new storage provider dependency is introduced (owner approval required before any such change).

## 1. Media category audit (actual locations, `BEANFX_DATA_DIR` root)

| Category | Path pattern | Written by | Registered in DB? | Retention today |
|---|---|---|---|---|
| Original uploads (+ probe outputs) | media root upload area per user/project | `/api/media` upload + ffprobe | `MediaAsset` rows (id, path, metadata) | until user deletes |
| Proxies | derived under the media root | encode jobs | `MediaAsset` (variant metadata) | until user deletes |
| Generated images (LAXII/posters) | showcase/poster areas | provider jobs | asset rows | until user deletes |
| Generated video/audio | job output areas | render/provider jobs | `ExportFile`/asset rows | until user deletes |
| Captions | sidecar files + DB text | captions editor | DB + files | until user deletes |
| Masks | `masks/u_<userId>/…` (e.g., `import_<ts>_<n>.png`) | mask import | mask rows | until user deletes |
| Project packages (M29) | archive area | `/api/project-archives` | package rows | until user deletes |
| Render intermediates | `seg_*`, `list_*` tmp files | windowed renders (`job-runner`) | **no** (transient) | deleted on completion (M20-verified: zero leftovers) |
| Final exports | export area, `seq_*.mp4` (+ jpg posters) | render jobs | `ExportFile` (with `paramsJson` windowed registration) | until user deletes |
| Thumbnails/previews | derived images | probe/export jobs | asset rows | until user deletes |

**Identity model:** DB rows store filesystem paths (relative to the media root); binary identity on disk = filename; content checksums are computed at qualification time (sha256 in drills) but are **not persisted per object today** — a gap the object-storage design closes and the local design covers with backup-verify (Track G hashes during backup verification).

## 2. Storage approach comparison

### A. Local persistent filesystem (current, qualified)

- Upload path: HTTP POST → server writes into `BEANFX_DATA_DIR` tree (path guards: absolute, dedicated subdir, not fs root).
- Access authorization: every media read/write passes through API routes that check the session and project ownership; media bytes are **not** served from a public static directory.
- Worker read/write: direct fs (same process tree).
- Retry/retention/backup/restore/orphan cleanup: backup = file tree snapshot (Track G), restore = tree restore + DB path integrity check (M35 drill verifies restored DB rows + sample media checksums), orphans = tmp files auto-cleaned (M20), orphaned user media currently only via manual cleanup (documented as an owner action).
- Disk reliability: single-volume risk — mitigated only by off-host backups. Capacity must include ~2× transient render headroom.
- **Cost model:** disk included in host price (sourced host floors in Track I); growth = vertical disk upgrades.

### B. S3-compatible object storage (designed, not implemented)

- API support: S3-compatible endpoints (Cloudflare R2 pricing VERIFIED 2026-11-22: $0.015/GB-mo storage, Class A $4.50/M, Class B $0.36/M, **egress free**, 10 GB free tier; Backblaze B2 VERIFIED: $6.95/TB-mo, egress free ≤3× monthly average then $0.01/GB, PAYG transactions free, 10 GB free tier). AWS S3 figures not sourced this milestone → COST UNKNOWN.
- Upload/download flow: presigned PUT (browser→bucket direct) + server-issued GET URLs; multipart for large uploads.
- Object identity: content-addressed keys `u_<userId>/<mediaId>/<sha256[:16]>_<name>` + DB `MediaAsset.storageKey`; ownership = the owning user's prefix.
- Checksums: SHA-256 computed at upload, stored in DB, optionally verified with S3 `Content-MD5`/checksum trailers.
- Retry: multipart resumable; server retries idempotent PUTs with same key.
- Lifecycle/retention: bucket lifecycle for tmp/intermediate prefix (7-day abort of incomplete multipart); user-deletable objects; exports retained until deletion.
- Backup/restore: bucket versioning + separate replication target; restore = point-in-time object fetch + DB reconcile.
- Orphan cleanup: periodic reconcile job (DB rows vs bucket listing) — **must be written and tested before adoption** (NOT IMPLEMENTED).
- Migration cost: code change in `media-storage.ts` consumers (path→key indirection), presign endpoints, worker read path — a real project (est. design-ready, NOT IMPLEMENTED), gated on owner approval.

### C. Hybrid (local working + durable object storage)

- Pattern: renders and edits work on local NVMe (fast segment I/O), final exports + originals sync to object storage asynchronously; DB rows record both `localPath` and `storageKey`.
- Assessment: best durability/cost balance at scale, but adds a sync worker + consistency rules (two sources of truth must have a defined winner) — designed here as the **Option-2-era target**, not built now.

## 3. Packaging/import independence (VERIFIED constraint)

M29 project packages (`src/lib/project-archive.ts`) bundle manifest + media into a portable archive and import into a fresh media root (`mkdir … media-store/masks/u_<userId>` on import) — the import path is **root-relative and self-contained**, so packaging/import remains independent of the chosen backend: under object storage, import writes into the bucket by the same relative layout. No backend-specific data is embedded in packages. This is exactly what Track J's qualification checklist re-verifies.

## 4. Decision

| Phase | Storage |
|---|---|
| Single-server initial deployment (recommended) | **Local filesystem (current, qualified)** — no change, no new dependency |
| Option-2 split (worker host) | Hybrid: shared FS (NFS) acceptable short-term; object storage preferred |
| Growing production | S3-compatible (R2/B2 sourced; S3 COST UNKNOWN) + reconcile tooling built and tested first |

**Explicitly out of scope this milestone:** moving existing user media (forbidden by task), any new provider dependency, any code change to storage. Current-state gaps recorded honestly: no per-object persisted checksums (compensated by backup verification), manual orphan cleanup, single-volume durability risk mitigated only by Track G backups.
