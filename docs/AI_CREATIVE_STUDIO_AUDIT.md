# BEAN FX × BEAN Intelligence — Repository Audit & Implementation Map (Milestone 0)

Spec: *AI Creative Video Editor — Production Engineering Implementation Directive*.
This audit reflects the actual remote state at implementation start (verified, not assumed).

## 1. Verified repository state

| Item | Value |
|---|---|
| Repository | `https://github.com/ebinj-dev/Bean-FX.git` (private) |
| `main` (verified before work) | `03db01552177b3228bec07d353264d76693c355d` — *Merge pull request #1 (sidecar branch)* |
| Sidecar work | contained in `main` (`2b2d622` is an ancestor of `main`) — preserved |
| `feature/asr-semantic-sidecars` | `2b2d622e3feee3aa05b13c36a3bef240841efea3` (unchanged) |
| Working tree at audit | clean, no uncommitted work |
| This milestone branch | `feature/ai-creative-studio`, based on `main` @ `03db015` |

## 2. Existing architecture (what is reused, not replaced)

**Stack:** Next.js (App Router) + TypeScript + Tailwind 4 + shadcn/ui + Radix, Prisma + SQLite, `bun` as package manager/runner, next-auth (Session model), zod validation, z-ai-web-dev-sdk gateway. **No new package manager, framework, or design system** — spec rule 18.

**Frontend (preserved):** single-page hash-routed studio — `AppShell` renders `#/autocut`, `#/captions`, `#/watermark`, `#/audio`, `#/broll` (nav in `nav-items.ts`), each tool behind `UploadGate` (auth + media selection) with `ToolShell`, `studio-dashboard` (media library, export history), `waveform` visualization. Theme/identity untouched.

**Backend:** Next.js API routes — auth (4), media (upload/list/file/waveform with `ffprobe` inspection), auto-cut pipeline (analyze/analyses/decisions/words), process (audio/autocut/burn-captions/watermark via FFmpeg CLI in `process-helpers`), exports (+ history, file delivery), jobs (in-process `JobManager`), projects, riishe. Secrets never in Git; media outside Git at `MEDIA_ROOT`.

**Database (9 models):** User, Session, Project, MediaAsset, ExportFile, Job, CutDecision, CutDecisionEvent, WordsToRemove. Migrations follow the established **additive-only SQL + verified applier** pattern (`migration/p3_migration.sql`, `scripts/apply_p3_migration.py`).

**AI integrations:** RIISHE inference (`riishe-inference.ts` — zai + OpenAI-compatible local provider, no automatic fallback, honest failure), ASR providers (`asr-providers.ts` — zai + local sidecar), local sidecars (`mini-services/` — faster-whisper + llama.cpp, merged into main). Gateway/provider configuration is env-driven — **no Ollama anywhere**; no model is hardcoded.

**Tests today:** `bun test` suites in `scripts/*.test.ts` (union/adapter/inference/export-safety/timeline-ruler), shell E2E suites, Python sidecar contract suite (23 checks), real-weights verification.

## 3. Capability gaps (the actual work)

| Area | State | Gap |
|---|---|---|
| Timeline engine | only ruler math (`timeline-ruler.ts`, unit-tested) + per-tool cut lists | **No sequence/track/clip model, no commands, no undo/redo, no versioning** — M1 |
| Editor workspace | none (tools are single-purpose) | Add `#/editor` route inside existing `AppShell` + nav item — **addition only**, established design system — M2 |
| Video monitor | HTML5 preview of a source file inside tools | No program monitor composited from timeline — M2 |
| Media pipeline | upload + ffprobe + waveforms; 250 MB limit | Proxies, chunked/resumable uploads, checksums, quotas — M3 |
| RIISHE → timeline | decisions persisted, not applied to a timeline | Apply proposals as validated commands — M4 |
| GANGZII / NIIKI / LAXII / JAZMII | audio tool, watermark, b-roll picker exist as separate tools | Engine adapters over existing services + FFmpeg filters; no duplicate engines — M5–M7 |
| MY AI orchestration | none | Engine registry, structured proposals, storyboard, approvals, targeted revisions — M8 |
| Export | FFmpeg export + history exist | Timeline-driven validated async rendering, progress, cancellation — M9 |
| Platform hardening | single-process jobs, SQLite | Worker/queue separation, quotas, observability, load tests — M10 |

## 4. Open-source candidates — license assessment (no code reused yet)

| Candidate | License (verified) | Decision |
|---|---|---|
| FFmpeg | LGPL-2.1+ (GPL/GPLv3 builds exist; distribution constraints come from *enabled libraries and build flags*) | **Continue using distro/system binary as a separate process** (existing pattern). Never link its libraries into our product; no binary redistribution without a license-reviewed build. Recorded in inventory. |
| MLT framework | LGPL-3.0 framework, but plugin/dependency ecosystem includes GPL components | **Not adopted.** FFmpeg already covers our deterministic processing needs; adopting MLT adds a GPL-tainted dependency surface with no capability we lack for M1–M5. |
| Remotion | Source-available custom license; **commercial use requires paid license** beyond eligibility thresholds | **Not adopted.** NIIKI will render deterministic motion templates (drawtext, overlays, filter graphs, JSON-parameterized animations) through FFmpeg — no per-frame LLM, no Remotion runtime, no licensing exposure. |
| RecAI | Small project; license and maintenance status to be verified at time of any proposed reuse | **Not adopted** for M1. Re-evaluate only if it materially improves a specific milestone; license check is a gate, not a formality. |
| OpenChatCut | Small/new; maintenance and license history thin | **Not adopted.** Chat-driven editing orchestration is built natively (M8) against the validated command model so proposals are schema-checked, which an external chat repo would not guarantee. |

**Rule applied:** zero new third-party dependencies in Milestone 1 (zod/uuid already present and inventoried). A full third-party inventory + SBOM lives in `docs/THIRD_PARTY_NOTICES.md` and grows with every milestone that adds a dependency.

## 5. Risks & compatibility notes

1. **In-process `JobManager`** — acceptable for single-node deployments; the 100k-user target requires queue/worker separation (M10) with CPU/GPU queues, leases and heartbeats. Architecture is documented then, not promised now.
2. **SQLite** — fine for the current product; WAL + additive migrations + per-tenant quotas before any horizontal scale claim. Capacity numbers will be **measured** (M10), not asserted.
3. **UI preservation** — the editor is added inside the existing shell; existing routes/tools/components stay byte-identical except for one nav entry and one route case in `app-shell.tsx` (the minimum wiring a new route requires).
4. **AI safety** — proposals are validated zod commands; the LLM never touches media or shells out (spec §3/§14). The existing RIISHE safety module is reused and extended.
5. **Never merge to main without approval** — enforced: all work lands on `feature/ai-creative-studio`; every milestone is pushed and its remote SHA verified before reporting.

## 6. Implementation order (from spec §20)

M1 shared editing core → M2 real editor integration → M3 media pipeline → M4 RIISHE → M5 GANGZII → M6 NIIKI → M7 JAZMII+LAXII → M8 MY AI orchestration → M9 export → M10 hardening. Each milestone: tests → build checks → diff review → secret scan → commit → push → **verify remote SHA** → report.
