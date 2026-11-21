# M31 ORIGINAL IMPLEMENTATION REGISTER

## Reference product studied (inspiration only)
OpenMontage (github.com/OpenMontageInc/OpenMontage) was reviewed at the PRODUCT-CONCEPT level only: the idea that an agentic system can orchestrate idea→research→script→assets→edit→review→render→delivery, and the general notion of a live production dashboard. NO OpenMontage source file, prompt, schema, YAML pipeline, tool-registry code, Backlot UI, artwork or documentation text was copied, vendored, forked or submodule-imported into BEAN FX. The BEAN FX rendering engine remains the authoritative renderer; no Remotion/HyperFrames or new paid dependency was introduced; no new runtime dependencies at all (bun/zod/prisma/ffmpeg only — all pre-existing).

## Concept → original BEAN FX capability
| Reference concept (observed behavior) | BEAN FX original implementation | Location |
|---|---|---|
| Multi-stage agentic video pipeline | Typed PipelineTemplate definitions with dependency graph + server-enforced state machine | src/lib/production/engine.ts |
| Idea → brief intake | Deterministic NL brief extraction + user-editable structured brief (LLM-enhance only when configured) | runner.ts extractBriefFields; /api/productions |
| Concept options + approval | 3 distinct deterministic directions; append-only ProductionDecision | engine.ts draftConceptOptions; ProductionDecision model |
| Script/storyboard artifacts | Original script schema with duration validation + revision history; storyboard scenes with pending placeholders | engine.ts ProductionScript/Storyboard |
| Asset planning + provenance | ProductionAsset with license states (VERIFIED/ATTRIBUTION_REQUIRED/USER_CONFIRMED/UNKNOWN/RESTRICTED), cost honesty | ProductionAsset model; assets API |
| Production "backlot" dashboard | BEAN PRODUCTION BOARD (original design, persisted state only) | src/components/bean/produce-tool.tsx |
| Stage checkpointing/resume | SUCCEEDED-boundary resume + restart reconciliation + asset-row dedup | runner.ts reconcileAfterRestart/resumeProduction |
| Quality assurance gate | Original QA module (pre/post-render checks, explicit outcome states) | engine.ts QA + runner runProductionQa |
| Cost governance | stageCost gate: config + approved budget + explicit approval; unknown ≠ 0 | engine.ts stageCost; assets API |

## Existing BEAN services reused (not duplicated)
Durable Job system (`enqueueMediaJob`, Job table, RENDER_TIMELINE pipeline); canonical timeline command architecture (`applyTimelineEdits`/`applyTransaction`); M30 review system (fingerprint, revisions, approvals) via review-bridge; notification dedup (`notify`); plan entitlements (maxConcurrentRenders/monthlyExportMinutes via the render path); media storage abstractions; WorkflowRun remains untouched (Production is a distinct superset for creative pipelines); MY AI/RIISHE seams remain the enhancement path when providers are configured.

## Compliance confirmations
1. No OpenMontage source/prompts/schemas/UI assets in the diff (audited before push).
2. No new runtime dependencies; no license obligations introduced.
3. All pipeline UI text, stage names, schemas and prompts in BEAN FX are original.
4. No fabricated provider success anywhere; blockers stated verbatim.
