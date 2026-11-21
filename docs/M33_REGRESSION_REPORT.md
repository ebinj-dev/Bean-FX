# M33 — REGRESSION REPORT (Track E)

**Baseline:** remote tip `27f6a4c4` (M32) — verified via `git ls-remote` + fresh clone; workspace source identical to the published M32 tree (only workspace-local artifacts differ: recovery audit doc, tsbuildinfo).

## Commands and results

| Phase | Command | Result |
|---|---|---|
| M32 baseline re-run | `bun test scripts/test-m32-{providers,variants,masks}.test.ts` | **35/35** |
| Track B new suite | `bun test scripts/test-m33-mask-portability.test.ts` | **9/9** |
| Track E unit regression | `bun test scripts/test-m32-*.test.ts scripts/test-m33-mask-portability.test.ts scripts/test-showcase-core.test.ts scripts/test-m31-studio-core.test.ts scripts/test-editor-{time,commands,preview,interaction}.test.ts` | **138/138** |
| Track C repeated HTTP | perf suite × 20 | **19/20** (residual documented) |
| Track A live | `bun test scripts/test-m33-three-format.test.ts` (server :3118) | **6/6** |
| Track D acceptance | `bun test scripts/test-m33-acceptance.test.ts` | **4/5** (1 test-bug pending re-run) |
| Type check | `npx tsc --noEmit` | 0 errors |
| Lint | `npx eslint <M33 files>` | clean |
| Build | `bun run build` | OK |

All scratch/fixture tests ran on isolated DBs (`/tmp/*.db`) and temp dirs; HTTP suites on the isolated server (`/tmp/m33-e2e.db`, separate data dir). The development database and media store were never touched.

## M1–M32 preservation findings

- Editor command/time/preview/interaction suites: green (M27 keyframes/fades behavior intact).
- Showcase core + M31 studio core: green (in the 138-run).
- M32 provider/variants/masks suites: green — M32 functionality unchanged by M33 (the archive extension is additive; `buildManifest`/`importPackage` changes are backward-compatible: `masks` defaults to `[]` on old manifests).
- M29 packaging atomicity: unchanged for assets; mask additions are non-fatal by design.
- M30 collaboration: collab access checks still gate packaging (`getProjectAccess/canEdit` preserved in buildManifest).
- Closeout session: M31 security **8/8** against the isolated server; three-format workflow re-verified **6/6**; unit suites re-run **per-file — 138 tests, 0 fail**; TypeScript 0; ESLint clean; build OK.
- Legacy M19/M22/M23 security suites: **INFRASTRUCTURE REQUIRED** — they target the real dev DB `db/custom.db` by design, and that file is absent in the recycled sandbox (2026-11-11 backups remain). Environment state loss, not a code regression; outside the M31/M33 regression protocol.
- UI: browser walkthrough **COMPLETED** in the closeout session (13 inspected screenshots, both viewports) — see `M33_CLOSEOUT.md` §2.

## Infrastructure exceptions

- 4 GB sandbox memory: one honest render SIGKILL (OOM) under parallel suite load; retried successfully on a fresh server. Run render suites serially.
- SQLite 4-writer residual: 1/20 perf runs (see M33_SQLITE_CONCURRENCY.md).
