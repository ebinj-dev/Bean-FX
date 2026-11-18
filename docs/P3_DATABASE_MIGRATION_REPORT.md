# P3 — Database Migration Report

**Date:** 2026-11-09 · **Live database:** `db/custom.db` (verified: `.env` → `DATABASE_URL=file:/home/z/my-project/db/custom.db`, absolute) · **Result: applied additively, all data intact, rollback available.**

---

## 1. Pre-migration state (Phase A/B verification)

- SQLite file: 114,688 bytes, `PRAGMA integrity_check` → ok, `journal_mode=delete`.
- Tables: `User`(6), `Session`(15), `WordsToRemove`(13), `Project`(0), `MediaAsset`(28), `ExportFile`(16), `Job`(47). No migrations directory exists (this project uses the `db push` workflow), so a reviewed-SQL procedure was used instead of `db push`.

## 2. Backup (created **before** any schema change)

| Item | Value |
|---|---|
| Method | SQLite **online backup API** (`sqlite3.Connection.backup`), then independent reopen verification |
| Location | `/home/z/my-project/backups/p3/20261109_061632/custom.db` |
| Manifest | `backups/p3/20261109_061632/MANIFEST.txt` (timestamp, hashes, integrity, row counts) |
| Backup SHA-256 | `91398ab6d46696dc2c919b0a8db83d9a226796aa05b0ae07c2044e798435c3be` |
| Backup integrity | ok; row counts identical to source (6/15/13/0/28/16/47); live file hash verified **unchanged** by the backup itself (source sha256 `42dc1d98…`) |
| Re-verified immediately before applying the migration | yes — hash matched the manifest (rollback guarantee) |
| P0 backups (`backups/db`, `backups/media`, `backups/restore-verify`) | untouched, preserved |
| Disk space | 3.6 GB free at migration time (backup 113 KB; needs trivially met) |

## 3. Schema change (Phase C — additive only)

New models in `prisma/schema.prisma`: `CutDecision` (FK→User cascade, FK→Job cascade, `@@unique([userId, jobId, candidateId])`, index on `jobId`) and `CutDecisionEvent` (append-only audit log, index `(jobId, candidateId)`, deliberately not FK-bound so history survives even a hypothetical job deletion).

Generated with `bunx prisma migrate diff --from-url "file:/home/z/my-project/db/custom.db" --to-schema-datamodel prisma/schema.prisma --script` (script saved at `scripts/p3_migration.sql`) — **the exact SQL applied, reviewed before execution:**

```sql
-- CreateTable
CREATE TABLE "CutDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CutDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CutDecision_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CutDecisionEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "CutDecision_jobId_idx" ON "CutDecision"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "CutDecision_userId_jobId_candidateId_key" ON "CutDecision"("userId", "jobId", "candidateId");

-- CreateIndex
CREATE INDEX "CutDecisionEvent_jobId_candidateId_idx" ON "CutDecisionEvent"("jobId", "candidateId");
```

**Applied with** `bunx prisma db execute --file scripts/p3_migration.sql --url "file:/home/z/my-project/db/custom.db"` → "Script executed successfully." — no `--accept-data-loss` flag, no `db push`, no `migrate dev`, no destructive operation anywhere. Client updated with `bunx prisma generate` (Prisma 6.19.2).

## 4. Post-migration verification (executed)

- `PRAGMA integrity_check` → **ok**
- Tables now: the 7 original + `CutDecision`, `CutDecisionEvent`
- Row counts after: User 6, Session 15, WordsToRemove 13, Project 0, MediaAsset 28, ExportFile 16, Job 47, **CutDecision 0, CutDecisionEvent 0** — every pre-existing table byte-for-byte unchanged in content
- New indexes present: `CutDecision_jobId_idx`, `CutDecision_userId_jobId_candidateId_key` (unique), `CutDecisionEvent_jobId_candidateId_idx`
- Re-verified again after the entire test phase: identical counts, integrity ok

## 5. Rollback plan (available, not needed)

1. Stop the server (no server was running during migration; the live server was started only after all validation).
2. `cp backups/p3/20261109_061632/custom.db db/custom.db` (verified hash `91398ab6…`).
3. `git checkout prisma/schema.prisma` (or remove the two appended models) + `bunx prisma generate`.
4. Remove `src/app/api/autocut/decisions/`, `src/app/api/autocut/analyses/` and the P3 frontend additions (see implementation report §1.1) — the app then runs exactly as pre-P3.

## 6. Startup-script safety (`.zscripts/dev.sh`)

Verified behavior: every `dev.sh` run executes `bun install` → **`bun run db:push` (= `prisma db push --accept-data-loss`)** → `bun run dev`. Because the live schema now matches `prisma/schema.prisma` exactly (verified by the diff being empty except the two new tables, which are applied), a `dev.sh` start runs `db push` as a **no-op** — safe today. The standing hazard is documented for the future: if anyone edits `schema.prisma` and then starts via `dev.sh`, the script will force-sync (potentially destructively) without a backup. Recommended procedure for future schema work (used by P3, safe and verified):

1. `python3 scripts/p3_backup.py` (or an equivalent verified online backup),
2. `bunx prisma migrate diff --from-url <live> --to-schema-datamodel prisma/schema.prisma --script` — **review the SQL**,
3. `bunx prisma db execute --file <sql> --url <live>`,
4. `bunx prisma generate`, verify row counts + integrity,
5. only then start the server (via `dev.sh` or directly).

P3 did **not** run `dev.sh` at any point; the live server was started directly with `bun run dev`.
