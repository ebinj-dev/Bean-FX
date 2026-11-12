# BEAN FX — Complete Workspace Integrity Audit & Missing Functionality Recovery

**Date:** 2026-11-11 · **Workspace:** `/home/z/my-project` · **Mode:** code/functionality recovery — no commits, no pushes, no history operations, live data preserved.
**Verdict: all missing P3 + P4 implementation restored from verified sources; every safe validation passes; live user data intact.**

---

## 1. Current workspace condition

**What the rollback was.** The platform restored the workspace from a stale snapshot (git HEAD `97b84a7`, dated **2026-11-05**) while the newest real state was the *P4-complete workspace* of **2026-11-10 02:08** — found intact as a full copy at `/tmp/my-project/` (including a 1 MB `.initial_snapshot.json` mtime manifest). This is the **second** rollback of this kind; the first (Nov 10) was recovered the same way and is documented in `download/P4_STORAGE_PORTABILITY_REPORT.md` §1.

**What survived the rollback untouched (verified byte-identical to the snapshot):**

- All P4-era configuration: `.env.example` (`df90511c…`), `.gitignore` (`7a38a89c…`), `tsconfig.json` (`a68ccf33…` = the P3 version).
- The live database file `db/custom.db` (pre-P3 schema but **real user data**: 6 users, 15 sessions, 26 media assets, 34 jobs, 15 exports, 13 word-removal rules; `PRAGMA integrity_check` = ok).
- All remaining `src/` files (P2-era RIISHE pipeline, all API routes, all UI components).
- `upload/` user media, most of `media-store/` (154 of 261 files).

**What the rollback destroyed (all restored this session, see §3):** the P3 decision-persistence source changes, both new P3 API routes, the P4 `media-storage.ts` portability work, the RIISHE analysis improvements of Nov 6–9, 4 sidecar `mini-services` source files, ~60 scripts, all P0–P4 reports/transfer artifacts, and 107 `media-store` files (mostly analysis results).

**Runtime state at end of this session:** dev server healthy on :3000 serving the restored code (`GET /` → 200; P3 routes answer `401 Authentication required.` unauthenticated, proving they are live behind the auth gate).

## 2. Gap analysis (what was missing / reverted / broken)

Established by hashing every file in the current tree against the `/tmp/my-project` P4-complete snapshot (4,452 files compared) and against the independently SHA-256-verified `P3-RECONCILIATION-PACKAGE`:

| # | Gap | Type | Evidence |
|---|---|---|---|
| 1 | `src/app/api/autocut/decisions/route.ts` absent | Missing file (P3) | In package `SHA256SUMS.txt` (`86aac1e7…`), absent in tree |
| 2 | `src/app/api/autocut/analyses/route.ts` absent | Missing file (P3) | `285af337…`, absent in tree |
| 3 | `prisma/schema.prisma` pre-P3 (3,407 B, no Cut models) | Reverted | Snapshot/package = 4,948 B (`2e4c3a51…`) with `CutDecision` + `CutDecisionEvent` |
| 4 | `src/components/bean/tools/auto-cut.tsx` pre-P3 (78,634 B) | Reverted | P3 version 95,992 B (`65ad3bad…`): decision save/restore flow, SAVED badges |
| 5 | `src/lib/client-api.ts` pre-P3 (11,653 B) | Reverted | P3 version 12,745 B (`1ff29d3b…`): `analyses()`, `decisions()`, `saveDecision()` |
| 6 | `src/lib/types.ts` pre-P3 (11,682 B) | Reverted | P3 version 12,040 B (`bec28dd3…`): `CutDecisionValue`, `SavedDecisionView` |
| 7 | `src/lib/media-storage.ts` pre-P4 (4,451 B, hardcoded root) | Reverted | P4 version 6,088 B (`be242045…`): `BEANFX_DATA_DIR`, Windows drive fallback |
| 8 | `src/lib/autocut-analysis.ts` Nov-3 version (74,327 B) | Reverted | Nov-9 version 78,002 B: phantom-word gap handling, natural-pause skipping |
| 9 | `src/lib/riishe-safety.ts` pre-improvement (1,885 B) | Reverted | Nov-9 version 2,574 B: semantic-KEEP drops candidate, never silently |
| 10 | `src/app/api/autocut/analyze/route.ts` older (21,869 B) | Reverted | Nov-9 version 22,088 B: `dropped` counting in inference note |
| 11 | `src/app/api/process/autocut/route.ts` older (6,281 B) | Reverted | Nov-9 version 6,519 B: `tmp/` dir creation before ffmpeg concat |
| 12 | `mini-services/` source (asr/semantic `server.py`, requirements, Windows cmd scripts, README) | Missing | 9 files + both Python venvs (682 MB) restored |
| 13 | ~60 `scripts/` files (P0 backups, phase2–4 audits, P3/P4 scripts, measurement tools) | Missing | Restored, hash-verified |
| 14 | Live DB had pre-P3 schema (no `CutDecision`/`CutDecisionEvent` tables) | Schema gap | Additive migration applied (§5) |
| 15 | `media-store/` missing 107 files | Missing data files | Restored add-only from snapshot (§5) |
| 16 | `docs/`, `migration/`, `patches/`, transfer packages/reports absent | Missing artifacts | Restored (§3) |

**Frontend↔API integration audit:** all client calls in `src/lib/client-api.ts` map to real routes — `analyses()` → `GET /api/autocut/analyses`, `decisions()` → `GET /api/autocut/decisions`, `saveDecision()` → `POST /api/autocut/decisions`, plus the pre-existing upload/transcribe/riishe/process/export/job/media/project routes. `auto-cut.tsx` calls `api.analyses` (reopen path), `api.decisions` (restore on reopen), and `api.saveDecision` at line 1308 — **UI state changes only after the server confirms 2xx; failed writes leave the candidate unchanged and surface the error** (verified by code reading and E2E T12).

## 3. Files restored (byte-exact from verified sources)

Every restoration was hash-verified against the snapshot source immediately after copy; the 9 overwrites hit files whose pre-rollback content is fully preserved in git HEAD `97b84a7`, and the restore script recorded each file's SHA-256 before and after (`scripts/restore_report.json`).

**P3 source set (7 files — hashes match `P3-RECONCILIATION-PACKAGE/SHA256SUMS.txt` exactly):** `prisma/schema.prisma`, `src/app/api/autocut/decisions/route.ts`, `src/app/api/autocut/analyses/route.ts`, `src/components/bean/tools/auto-cut.tsx`, `src/lib/client-api.ts`, `src/lib/types.ts`, `tsconfig.json` (already present, verified).

**P4 + post-P3 set:** `src/lib/media-storage.ts`, `src/lib/autocut-analysis.ts`, `src/lib/riishe-safety.ts`, `src/app/api/autocut/analyze/route.ts`, `src/app/api/process/autocut/route.ts`.

**Infrastructure and artifacts:** 9 `mini-services/` source files + both sidecar venvs (4,287 files, 0 hash differences); ~60 `scripts/` files (incl. `p3_backup.py`, `p3_union.test.ts`, `p3_e2e_test.sh`, `p3_e2e_test.ps1`, `build_p4_transfer.py`, `verify_p4_transfer.py`); `docs/` (4 P3 reports); `migration/p3_migration.sql`; `patches/p3-changes-vs-ce01c3d.patch`; `download/` reports and transfer packages (P3-RECONCILIATION-PACKAGE complete, `BEAN-FX-P3-TRANSFER.zip`, `BEAN-FX-P4-WINDOWS-TRANSFER.zip` = `ac0f79a1…` exactly as reported in the previous session, P4 report, P0-era audit reports, evidence dirs — 163/163 snapshot files present, 0 differences).

**Nothing was invented:** every restored byte comes from the Nov-10 P4-complete snapshot or the SHA-256-verified P3 package. No Ollama, no new cloud dependencies — `package.json` was never touched (no new npm dependencies; P3 used existing `zod`/Prisma/Next).

## 4. Database status (data-safety-first path)

- **Live DB preserved, not replaced.** The snapshot DB (Nov 10: 28 assets / 47 jobs / 16 exports + Cut tables) contains rows the live DB lacks; per this task's rules the live DB was **not** overwritten. Both verified backups of the live DB were created before any write.
- **Verified backups taken (this session):** `db/backup-20261111_042810/` and `db/backup-20261111_043120/` — online SQLite backups (`sqlite3.backup`), each with `integrity_check ok` on the copy, per-table row counts matching the live DB exactly, plus `SHA256.txt` + `MANIFEST.txt`.
- **Additive P3 migration applied** (`scripts/apply_p3_migration.py`): pre-checked that every statement in `migration/p3_migration.sql` is a `CREATE TABLE`/`CREATE INDEX` (no DROP/ALTER/DELETE/UPDATE/INSERT), that the two tables did not exist, then executed in one transaction. Post-verification: `integrity_check = ok`; **all seven pre-existing tables' row counts unchanged**; `CutDecision` and `CutDecisionEvent` exist and are empty; `bunx prisma validate` passes; client regenerated (v6.19.2) with both new models.
- **Historical user data status (honest):** the newer P3-era data (47 jobs / 28 assets / 16 exports vs live 34/26/15) **can** be recovered — it exists only in `/tmp/my-project/db/custom.db` (and its `/tmp/my-project/backups/db/` copies). `/tmp` is ephemeral; reconciling that data into the live DB is a user decision (data recovery, out of scope for this code-recovery task) and must happen before the sandbox recycles.
- Media backups intact: `backups/media/20261109_051019/` (941 MB, Nov-9 media snapshot — verified fully contained in the current `media-store`, 228/228 hashes identical), `backups/db/`, `backups/p3/`.

## 5. Media storage status

`src/lib/media-storage.ts` (P4 version) verified by full read:

- `MEDIA_ROOT` resolved once from `BEANFX_DATA_DIR` (trim → empty ⇒ `./media-store` resolved against cwd — byte-identical behavior to the old hardcode on this runtime; absolute Windows `C:\`, `/` and UNC paths and spaces supported via `path.normalize`/`path.join`/`path.win32` semantics; **never shell-interpolated**).
- Upload validation: extension whitelist (audio/video/`.srt`), `safeExt` sanitizer, 250 MB cap (`MAX_UPLOAD_BYTES`, mirrored client-side).
- FFmpeg/FFprobe via `execFile` argument arrays with timeouts (30 s ffprobe); JSON-parsed with explicit error surfaces.
- Disk-space check: `fs.statfs` primary; **Windows-safe fallback** for Node < 18.15 via `execFile("powershell.exe", [...])` querying `DriveInfo.AvailableFreeSpace` (arg array, `windowsHide`, 15 s timeout, original error re-thrown).
- Persistence & cleanup: `ensureMediaRoot()` creates `originals/ exports/ tmp/`; `removeFileQuiet()` best-effort deletion after failures; `exportFileName()` sanitized export naming.
- Live store after restoration: originals 32, exports 22, waveforms 11, uploads 1, asr-chunks 149, analysis-results 45, tmp 0 (261 files total = complete snapshot superset, 0 hash differences; E2E synthetic artifacts removed afterwards).

## 6. API integration status (proven, not assumed)

- **Isolated E2E suite ran against a real Next.js 16 server** (`scripts/p3_e2e_test.sh`: fresh `.p3-test/test.db`, port 3100, live DB unreachable): **31 PASS / 0 FAIL, exit 0** — covering registration/auth, decision save for APPROVE/REJECT/KEEP, reload-after-refresh persistence, scoping to the exact analysis result, newest-first analyses listing, duplicate-write convergence (3 rows after 4 writes via unique constraint + upsert, history appended), invalid ID/decision 400/404/410 handling, cross-user 404 rejection, failed-write-is-not-silent-success (410 + no row written), approved-only export union with **ffprobe-verified 2.500000 s duration**, overlapping-raw-cuts server rejection (400), fixture SHA-256 unchanged, unauthenticated 401.
- **Live server probes:** `GET /` → 200; `GET /api/autocut/decisions`, `GET /api/autocut/analyses`, `GET /api/media`, `GET /api/exports` unauthenticated → `401 {"error":"Authentication required."}` (routes compiled and live behind auth).
- **No fabricated results:** the suite's own summary line is quoted (`E2E RESULTS: PASS=31 FAIL=0`); synthetic artifacts it left behind (2 `p3test*.json` fixtures, 1 orphan 2.5 s test export, `.p3-test/`) were identified by name/mtime and removed.

## 7. Test results with actual evidence

| Check | Command | Result |
|---|---|---|
| TypeScript, whole project | `bunx tsc --noEmit` | **0 errors** (exit 0) |
| Prisma schema | `bunx prisma validate` | valid |
| Prisma client | `bunx prisma generate` | v6.19.2 regenerated with `CutDecision`/`CutDecisionEvent` |
| P3 unit tests | `bun test ./scripts/p3_union.test.ts` | **6 pass / 0 fail** |
| Export-safety suite | `bun test ./scripts/test-export-safety.test.ts` | **8 pass / 0 fail** |
| Filler-lexicon suite | `bun test ./scripts/test-filler-lexicon.test.ts` | **7 pass / 0 fail** |
| Timeline-ruler suite | `bun test ./scripts/test-timeline-ruler.test.ts` | **5 pass / 0 fail** |
| ASR adapter suite | `bun test ./scripts/test-asr-adapter.test.ts` | **6 pass / 0 fail** |
| ASR chunk-cache suite | `bun test ./scripts/test-asr-chunk-cache.test.ts` | **4 pass / 0 fail** |
| No-fallback runtime assertions | `bun ./scripts/test-no-fallback-runtime.ts` | **pass=9 fail=0** (proves ASR/semantic errors name the LOCAL endpoint, no zai fallback) |
| P3 E2E (isolated) | `bash scripts/p3_e2e_test.sh` | **PASS=31 FAIL=0**, exit 0 |
| Production build | `bunx next build` | **Compiled successfully in 11.0 s; 21/21 static pages generated**; final *standalone-output copy* step failed ENOSPC (see §8) |
| DB integrity | `PRAGMA integrity_check` | ok (before and after migration) |
| Live server | `curl` probes | `/` 200; P3 routes 401 unauthenticated |

## 8. Remaining blockers

1. **Production `next build` standalone packaging is disk-quota blocked.** Compilation and static generation fully succeed; the final step (Next copies all of `node_modules` into `.next/standalone/`) needs ≈4 GB peak and the 9.9 GB sandbox volume fills (node_modules 1.2 G + media-store 2.3 G + backups 0.9 G + venvs 0.6 G + `.next` partial 3.4 G). **Not a code failure.** Space was reclaimed safely this session: removed the redundant `backups/restore-verify/` duplicate (2.7 GB — its media content verified hash-identical to live `media-store`), the Nov-9 `/tmp` media backup (verified contained in live store), and regenerable caches (`.next`, `.deps-mirror`). A successful standalone build needs a larger volume or `output` adjustment on the Windows machine (where no quota applies).
2. **P3-era user data (47 jobs / 28 assets / 16 exports) lives only in `/tmp/my-project/db/custom.db`.** Recoverable, but reconciling it into the live DB is a deliberate user action (this task forbids overwriting the live database). Do it before the sandbox recycles, or copy that file somewhere durable first.
3. **Platform-injected root-owned dirs** (`models/`, `sidecar/` — empty — were removed; `upload/` is world-readable and untouched). No longer block the build scanner.
4. **Sidecar model weights are not on disk.** The restored sidecars are operator-configured (`--model <dir>`); they never download models. Local inference requires a manually downloaded faster-whisper (CTranslate2) model and a GGUF semantic model (see `mini-services/README.md`); without them, ASR/semantic fall back to the configured cloud provider (see §9).

## 9. Features requiring external services or credentials

- **Cloud ASR (default when `BEANFX_ASR_PROVIDER` is unset):** Z.ai ASR — used by transcribe; quota/errors surface to the job, no silent fallback (proven by `test-no-fallback-runtime.ts`).
- **Cloud semantic inference (default when `BEANFX_SEMANTIC_PROVIDER` is unset):** Z.ai chat-completions for RIISHE candidate classification.
- **Optional local inference (no cloud, no Ollama):** two restored FastAPI sidecars — `mini-services/asr-sidecar/server.py` (faster-whisper, OpenAI-style `/v1/audio/transcriptions` + word timestamps) and `mini-services/semantic-sidecar/server.py` (GGUF qwen2.5-7b-instruct) — require operator-downloaded model weights and `BEANFX_ASR_PROVIDER=local-http` / `BEANFX_SEMANTIC_PROVIDER=local-http` env selection. Both venvs are restored and runnable.
- **FFmpeg/FFprobe:** system binaries (present here; required on Windows too).
- **Windows E2E runner** (`scripts/p3_e2e_test.ps1`): restored, still **not executed** (no Windows runtime here; by design its first run belongs on the Windows machine).

## 10. Exact next steps

1. **Now (this sandbox):** copy `/tmp/my-project/db/custom.db` to a durable location if you want the newer P3-era user data (47 jobs / 28 assets / 16 exports) — `/tmp` will vanish on recycle. Then reconcile or discard it explicitly.
2. **Commit the restored tree** on your side when satisfied (this session deliberately committed nothing; the working tree is fully intact and uncommitted — 12 modified files + additions, see `git status`).
3. **On the Windows machine:** verify the transfer package (`SHA256SUMS.txt` in `BEAN-FX-P4-WINDOWS-TRANSFER.zip`), set `BEANFX_DATA_DIR` per `.env.example`, run `powershell -ExecutionPolicy Bypass -File scripts\p3_e2e_test.ps1` (review its §6 isolation notes in the P4 report first), and run `next build` where the disk quota does not apply.
4. **Optionally enable local inference:** download the two model weights, start both sidecars (`python server.py --model <dir>`), set the two `BEANFX_*_PROVIDER` variables.
5. **If newer user data is reconciled:** back up the live DB again first (`scripts/p3_backup.py` pattern), then copy decision rows only after validating candidate ids against the immutable result files.
