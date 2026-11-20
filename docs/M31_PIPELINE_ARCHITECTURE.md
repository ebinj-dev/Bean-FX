# M31 PIPELINE ARCHITECTURE — BEAN AI Production Studio (original implementation)

## Components
- **Prisma models** (additive): `Production` (brief/concept/script/storyboard/research/reference/delivery JSON + budget + qaState), `ProductionStage` (per-template stage rows; unique productionId+key; checkpoint + output JSON), `ProductionDecision` (append-only), `ProductionAsset` (provenance + license state + cost honesty), `ProductionEvent` (append-only real log).
- **Engine** (`src/lib/production/engine.ts`): `PipelineTemplate` type (id, stages, dependencies, capabilities, checkpoints, delivery formats, version, active flag + exact unavailableReason), stage state machine (`STAGE_TRANSITIONS`; `canTransition`), brief schema, concept drafting, script/storyboard schemas, cost gate (`stageCost`), QA module (`preRenderChecks`, `qaOutcome`, `seqClips`).
- **Runner** (`src/lib/production/runner.ts`): deterministic stage runners; restart reconciliation; resume; assembly via `applyTimelineEdits` (canonical commands ONLY); render via `enqueueMediaJob(JOB_TYPE_RENDER_TIMELINE)` on the existing Job table; QA against real ffprobe output; delivery + dedup notifications.
- **Review bridge** (`src/lib/production/review-bridge.ts`): creates M30 review revisions with the same fingerprint/session semantics as the reviews API.
- **API**: `POST/GET /api/productions`, `GET/PUT /api/productions/[id]` (brief/concept/script/storyboard/scene-approval/budget), `POST /api/productions/[id]/stages/[key]` (start|approve|reject|skip|cancel|retry — all server-validated), `POST /api/productions/[id]/assets` (attach|decide|plan-generation), `POST /api/productions/[id]/resume`.
- **UI**: `src/components/bean/produce-tool.tsx` wired at `#/produce` in `app-shell.tsx` (additive; existing Studio untouched).

## Stage state machine
NOT_STARTED → READY → RUNNING → {SUCCEEDED | FAILED | AWAITING_APPROVAL | CANCEL_REQUESTED} ; AWAITING_APPROVAL → {SUCCEEDED | FAILED | RUNNING}; FAILED → READY (retry); BLOCKED → READY; CANCELLED → READY; SUCCEEDED → SUPERSEDED. No state is self-reachable. A stage only becomes SUCCEEDED via verified output or explicit approval of its gate.

## Resumability
Stage rows persist outputs/checkpoints. On restart, RUNNING stages without live jobs re-derive to READY (logged); job-backed stages sync from the Job table. `resumeProduction` walks the template: SUCCEEDED/SKIPPED stages are skipped (never re-run), AWAITING_APPROVAL stages pause, READY/FAILED deterministic stages re-drive. Asset rows keep their state → no duplicated provider calls.

## Render path
FINAL_RENDER enqueues on the EXISTING durable Job system; board sync reads job status + the ExportFile row (with a documented fallback lookup); QA probes the actual file. No second queue, no bypass of plan limits.

## Data flow to the editor
Storyboard + approved assets → `buildAssemblyEdits` → canonical commands validated by the editor's `applyTransaction` → applied with `applyTimelineEdits` (versioned, conflict-checked, undoable) → the rough cut IS the project's head sequence (preview/timeline/history all native).
