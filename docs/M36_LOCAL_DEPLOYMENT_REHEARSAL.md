# M36 — Local Deployment Rehearsal (Phase G)

**Result: PASS — 16/16 steps** (evidence: `download/m36/evidence/rehearsal.log`, harness logs and per-step files under `/tmp/m36-rehearsal/`). **The development database and media store were never touched** — the rehearsal ran entirely on an rsync-mirrored candidate tree (a checkout of the uncommitted M36 state) with its own isolated DB and media root. No staging host was used; this is a LOCAL rehearsal, not a staging deployment (Phase-H gate: owner-provisioned host still required).

## Step-by-step evidence

| # | Step | Result | Evidence |
|---|---|---|---|
| 1 | Fresh checkout | PASS — clean tree mirror (no node_modules/.next/db/media-store/logs) | `$T/harness.log` step 1 |
| 2 | Environment validation | PASS — `ENV VALIDATION: CONFIGURATION REQUIRED (strict)` — core valid; providers unconfigured flagged as informational | rehearsal.log §2 |
| 3 | Dependency installation from lockfile | PASS — `bun install --frozen-lockfile` | harness step 2 |
| 4 | Prisma generation | PASS — explicit `bunx prisma generate` | harness step 2b |
| 5 | Safe database initialization | PASS — non-destructive `prisma db push` + preflight `db.file/db.connect/db.schema/db.wal` all clean | harness step 4 |
| 6 | Production build | PASS — standalone build, static assets copied | harness step 5 |
| 7 | Application startup | PASS — `http 200 after ~Ns` | harness step 5 |
| 8 | Health verification | PASS — `GET / 200` + `/api/health` component checks | harness step 6 |
| 9 | Media upload & probe | PASS — driven by the M33 acceptance workflow (register → intake → projects → upload → ffprobe) | harness step 7 |
| 10 | Real render & export | PASS — **three real exports (H.264 MP4, WebM, captions sidecar)** via the existing durable job pipeline | harness step 7/8, `$T/evidence/ffprobe-all-formats.json` |
| 11 | Download & verification of the export | PASS — ffprobe-validated artifacts written to the evidence dir | harness step 8 |
| 12 | Controlled application restart | PASS — same DB/media re-served: app 200, `/api/health` 200 (projects/media persisted) + **M34 storage-worker suite 0 fail on the restarted instance** | rehearsal.log §12, `step12b.log` |
| 13 | Backup snapshot | PASS — `BACKUP_OK dbSha=0cc3cf282ca14382 mediaFiles=10 integrity=ok` + `BACKUP_VERIFY_OK` + honest `OFF-HOST BACKUP: CONFIGURATION REQUIRED` | `step13-backup.log` |
| 14 | Isolated restore | PASS — `RESTORE_OK integrity=ok` into a separate root; live-overwrite refusal logic active | `step14-restore.log` |
| 15 | Restored media checksum verification | PASS — all row counts equal (`User 2->2, Project 5->5, MediaAsset 6->6, Job 12->12, Session 3->3, ExportFile 5->5`) and **all 10 media files sha256-verified against the manifest** | restore output |
| 16 | Restored application startup & health | PASS — restored root boots on a scratch port, `/api/health` 200; health verdict `DEGRADED` **honestly** (intentional M33-suite failure rows carried in the restored DB + scratch 644 perms + backup/provider unconfigured) — no false success claimed | rehearsal.log §16 |

## Post-rehearsal health note (honesty)

Step 16's `DEGRADED` is the correct four-state behavior, not a defect: the restored database intentionally contains the M33 acceptance suite's failure-path rows (`FAILED=3`), the scratch DB file is group-readable in /tmp, and backup/provider configuration is deliberately absent in the sandbox. A production-graded environment starts from a clean DB where the same check returns HEALTHY (as observed in the earlier lifecycle validation against a clean instance).

## Regression battery (run after the rehearsal, sequential — same isolated server/DB)

Results recorded in `docs/M36_REGRESSION_REPORT.md` and `download/m36/evidence/regression-battery.log`: M20 T1–T7, M34 storage-worker, M29 integrity + portability, M32 providers/masks/variants, M31 studio-core, M33 acceptance + three-format.

**Claim boundary:** this proves the deployment package executes the complete install→operate→backup→restore→relaunch cycle correctly on the M36 tooling in an isolated environment. It does NOT prove staging-host or production behavior (systemd, TLS proxy, real ENOSPC, public traffic) — those remain OWNER ACTION / INFRASTRUCTURE REQUIRED per `M36_FAILURE_QUALIFICATION.md` and the Phase-H checklist.
