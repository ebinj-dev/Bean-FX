# M36 — Failure Qualification (Phase F)

**Scope honesty:** only the cases the sandbox can actually produce were tested and are claimed. True ENOSPC on a dedicated volume and real-host service behavior are classified INFRASTRUCTURE REQUIRED / OWNER ACTION, not claimed.

## Results — `scripts/m36-failure-qualification.sh` → 12/12 PASS (evidence: `download/m36/evidence/failure-qualification.log`)

| Case | Method | Result | What it proves |
|---|---|---|---|
| F1 missing `DATABASE_URL` | env gate on a bare env file | PASS (exit 1) | fail-cold startup; no insecure substitution |
| F2 unreachable DB directory | env gate | PASS (exit 1) | actionable, pre-boot rejection |
| F3 DB file missing | `m36-db-ops verify` | PASS (exit 1 + `DB_OPS_FAIL` naming the fix) | explicit, actionable |
| F4 corrupt DB file | `m36-db-ops verify` on garbage file | PASS (exit 1, integrity surfaced) | no silent corruption |
| F5 FFmpeg absent | shadow PATH without ffmpeg/ffprobe, app reachable | PASS (health prints the ffmpeg note) | render prerequisite flagged; core app unaffected |
| F6 media root missing | health check | PASS (UNAVAILABLE exit 3) | total storage failure is loud |
| F7 media root unwritable (chmod 000) | health check | PASS (UNAVAILABLE exit 3) | permission failure is loud |
| F8 backup with missing DB | `m36-backup.ts backup` | PASS (exit 1) + **F8b** no `.tmp` leftovers | failure-safe temp cleanup |
| F9 restore from invalid snapshot | `m36-backup.ts restore` | PASS (exit 3) | explicit refusal, no partial restore |
| F10 real DB-init failure concealed? | unwritable dir + fresh client | PASS — `[beanfx:db] WAL setup failed … Error code 14: Unable to open the database file` printed | **the M36 db.ts change works**: real failures surface, with the non-destructive fix named |
| F11 optional in-memory PRAGMA | `file::memory:` | PASS — quiet | compatibility cases remain silent by design |
| Live-overwrite refusal | restore targeting a recorded live source path | PASS (`RESTORE_FAIL … refuse`, exit 3) | backups can't destroy live data by accident (also covered by M36_BACKUP_RESTORE_OPERATIONS) |

Additionally validated during the M36 lifecycle run: SIGTERM shutdown followed by status exit 3 (stopped) — controlled shutdown works; `/api/health` 503-with-component path is exercised by the health check's step 2.

## Mandated cases classified honestly

| Case | Classification | Basis |
|---|---|---|
| Insufficient disk space (true ENOSPC on the render volume) | INFRASTRUCTURE REQUIRED | no mountable loop device in the sandbox; threshold detection IS tested (health ≥85%, `/api/health` <1 GB); ffmpeg write-failure honesty is code-verified |
| Interrupted render / restart during an active job | **VERIFIED via M20 suite** (T4 SIGKILL-mid-render recovery 8/8, T5 OOM fail-not-requeue, T6 cancel) — re-executed this milestone (see regression report) | the durable-job contract covers exactly these cases |
| Render process failure | VERIFIED via M34 storage-worker suite 6/6 + M34/M20 honest-failure design (stderr tail in FAILED message, never falsely COMPLETE) | existing suites re-run this milestone |
| Backup failure / restore failure | VERIFIED (F8/F9 + live refusal case) | this milestone |
| Permission failure | VERIFIED (F7 + db-perms warning) | this milestone |
| Missing media | covered by M28 media-lifecycle handling (unchanged code) + health UNAVAILABLE case F6 | carryover + this milestone |
| Invalid environment | VERIFIED (F1/F2 + template battery in M36_ENVIRONMENT_CONFIGURATION) | this milestone |
| FFmpeg unavailable | VERIFIED (F5) | this milestone |

**Claim boundaries:** no resilience is claimed beyond these cases. Temp-file safety is proven by M20's zero-leftover assertion (re-run), F8b, and the health check's stale-temp detector.
