# M8 — MY AI Orchestration + Intelligent Editing Automation

Milestone goal: *"MY AI as the central intelligent editing orchestrator — a real LLM gateway, project understanding, validated structured plans, five-engine coordination, approval-gated execution, and independently implemented Concat-inspired automation (MCP server + JSON-RPC API + effect discovery + preview frames)."* Everything below reflects what SHIPPED and is backed by the tests named in §18.

## 1. Architecture overview

```
MY AI panel (editor) ─┐
MCP clients (real SDK)─┼─► /api/automation/mcp ─┐   JSON-RPC 2.0, Bearer automation tokens
Scripts / RPC ────────┘  /api/automation/rpc ──┤   (hashed at rest; read-only default profile)
                                               │
                    SHARED TOOL CATALOG (src/lib/automation/catalog.ts)
                    39 tools × typed zod schemas × profile gates × audit
                                               │
MY AI chat/plans (§10/§6) ──► /api/my-ai/{chat,plans,health,conversations}
        │                                     │
        ▼                                     ▼
 LLM gateway (§4) ──► planner (§6) ──► approvals (§8) ──► executor (§8)
 zai SDK adapter      AIPlanSchema v1  TTL + ownership   real engine entry points
 glm-4-plus (live)    + normalize      + audit           M1 commands/M2 persistence
 + usage accounting   + honest         + expiry          M5/M6/M7 durable jobs
                      fallback
```

Support modules: `src/lib/my-ai/context/resolver.ts` (bounded context), `src/lib/my-ai/discovery/effects.ts` (capability metadata), `src/lib/my-ai/preview/frames.ts` (single-frame inspection), `src/lib/automation/tokens.ts`.

## 2. LLM gateway (§4)

- Interface `LLMProvider.chat(messages, options) → {content, model, usage, latencyMs}`; `healthCheck()` performs a REAL round trip.
- Shipped adapter `zai` via the environment's configured SDK — **verified live**: chat round trip with `usage` token counts (`glm-4-plus`); planner call produced a real plan (§18 evidence).
- Typed error normalization (`NOT_CONFIGURED / AUTH_FAILED / RATE_LIMITED / PROVIDER_FAILURE / INVALID_RESPONSE / TIMEOUT / CANCELLED`), bounded retries only for transient codes, per-call timeouts, cooperative `AbortSignal` cancellation, secret redaction (`redactSecrets`) on every error path.
- Provider/model selection: `BEANFX_MYAI_PROVIDER` / `BEANFX_MYAI_MODEL`; unknown provider → honest NOT_CONFIGURED. **No silent provider switching; no Ollama.**
- `chatValidated()` asks for JSON, parses (fence-tolerant), validates with zod, and makes ONE repair attempt that includes the ACTUAL zod violations.
- Usage accounting per call in `AIUsage` (token counts as reported; **no invented cost rates** — the UI states this explicitly).
- Health endpoint: `GET /api/my-ai/health` (60 s cached; `?force=1` re-probes).

## 3. Provider configuration (§12)

Env names (no secrets in repo): `BEANFX_MYAI_PROVIDER`, `BEANFX_MYAI_MODEL`, `BEANFX_MYAI_TIMEOUT_MS`, `BEANFX_MYAI_RETRIES`, `BEANFX_MYAI_PLANNER_TIMEOUT_MS`, `BEANFX_MYAI_PLAN_TTL_MS`, `BEANFX_MYAI_MAX_STEPS`, `BEANFX_MCP_RATE_PER_MIN`, `BEANFX_MCP_CALL_TIMEOUT_MS`. Provider credentials live inside the configured SDK/CLI environment server-side. Connection testing = the health probe (panel shows "LLM connected" vs "LLM unavailable (deterministic mode)"). Automation tokens are created in the MY AI panel (§11 settings section): raw token shown ONCE, only the SHA-256 hash stored, profile `read-only | editing`, optional tool allowlist, revocation.

## 4. Project context model (§5)

`resolveProjectContext(projectId, userId)` returns a BOUNDED text-only snapshot: project header; sequence fps/resolution/duration; tracks with lock/mute/visibility; first 40 clips (caption, keyframes/effects flags); gaps (≥1 s, first 12) and overlap count; media totals by kind + generated (JAZMII/LAXII) counts + 12 samples with provenance; engine results (RIISHE decisions, GANGZII process status, NIIKI graphics/transitions); version history (10), recent plans, storage usage vs quota. Full media never leaves the deployment; the LLM receives only the user's text + this summary. Context version string (`v:<version>:<clips>:<duration>`) powers stale-plan rejection.

## 5. Planner schema (§6)

`AIPlanSchema` v1 (`src/lib/my-ai/planner/schema.ts`): planId/projectId/requestSummary/engines/steps(≤24)/expectedChanges/warnings/estimatedUsage/contextVersion/idempotencyKey. Nine typed step operations (`APPLY_COMMANDS, RIISHE_AUTOCUT, GANGZII_PROCESS, NIIKI_GRAPHIC, JAZMII_GENERATE, JAZMII_ANALYZE, LAXII_GENERATE, INSERT_ASSET, EXPORT`) with per-operation argument validation, dependency integrity (unique ids, existing deps, cycle detection), and risk labels (`timeline | generation | export | analysis`). `normalizeLLMPlan` maps REPRESENTATION deviations deterministically before strict validation (engine casing, key aliases `stepId→id`, `type→operation`, range `"a-b"→object`); it never invents content, and un-mappable output is REJECTED (fixture test: garbage → honest failure, never a guessed plan). `guided` steps (`{guidance}`) are executed as **ROUTED** — recorded honestly as direction, never fake-completed.

Planner modes, clearly labeled in `plannerMode`: `llm:<model>` (real provider) and `deterministic-fallback` (rule-based plans from the same schema when no provider is configured or the call fails — the note states "NOT model reasoning"). Plans persist as `AWAITING_APPROVAL` with a TTL (30 min default).

## 6. Five-engine orchestration (§7)

Executor step routing (all REAL entry points — no shortcuts):
- APPLY_COMMANDS / INSERT_ASSET → `getTimelineHead` + M1 `applyCommand` validation + `applyTimelineEdits` (M2 optimistic concurrency; every write is a new version; undo/redo/autosave native).
- NIIKI_GRAPHIC → M6 `proposeNikki` (typed proposal) → commands → apply.
- GANGZII_PROCESS → GangziiProcess row + durable `GANGZII_PROCESS` job (M5 pattern, preset validated against the REAL preset registry).
- JAZMII_GENERATE / JAZMII_ANALYZE / LAXII_GENERATE → durable M7 jobs (metered, provenance-registered outputs; reference assets ownership-checked).
- EXPORT → `NIKKI_RENDER` job on the current head sequence (M6 render pipeline).
- RIISHE_AUTOCUT → validates context and ROUTES to the M4 review/apply flow (the executor deliberately does not re-implement RIISHE's ffmpeg cut math — documented limitation).

Example flows (A fast-paced edit, B cinematic, C short-form) are supported by the plan vocabulary above; §14 tests exercise multi-engine plans (NIIKI + LAXII via real LLM; RIISHE/GANGZII/JAZMII/LAXII via fixture-driven executor tests).

## 7. Approval and execution lifecycle (§8)

States: DRAFT → AWAITING_APPROVAL → APPROVED → RUNNING → COMPLETED | PARTIALLY_COMPLETED | FAILED | CANCELLED | EXPIRED. All plans require approval (timeline/generation/export all gated per §8). Approval UI shows per-step operation, risk, description, affected assets; warnings; external-call list. Execution: dependency order, status re-check before EVERY step (cancel/expire stops cleanly), per-step retries (2, `VersionConflictError` re-reads head), audit row per step, truthful partial-failure reporting ("completed steps were NOT rolled back" stated explicitly), TTL expiry sweep, plan-level idempotency key (unique per user), stale-context rejection (`Plan is stale: validated against X, timeline now Y`).

## 8. MCP server setup (§9A/§9B)

`POST /api/automation/mcp` — JSON-RPC 2.0: `initialize` (no auth needed for discovery), `notifications/initialized`, `ping`, `tools/list` (profile-filtered), `tools/call` (typed args, profile + allowlist gates, per-token sliding-window rate limit `BEANFX_MCP_RATE_PER_MIN` (default 120/min), per-call timeout, audit rows). `resources/*`/`prompts/*` → honest `-32601` (tools-only server). **Verified with the OFFICIAL `@modelcontextprotocol/sdk` client (v1.32.2, StreamableHTTP transport)**: initialize → listTools (39 tools) → callTool (effects catalog) over real HTTP.

Default mode is read-only; editing tools require an `editing`-profile token; allowlists exclude tools even for editing profiles (FORBIDDEN vs PROJECT_NOT_FOUND distinction proves the gate order). Tokens are hashed (`sha256`, constant-time compare), shown once, revocable; `lastUsedAt` tracked.

## 9. MCP tool catalog (39 tools)

Projects: list/create/get/versions · Timeline: read/get_tracks/get_clips/get_playhead (documented: playhead is session state; server reports version + duration) · Media: list/probe (real ffprobe)/get_metadata (provenance) · Editing: edit_apply/clip_add/clip_trim/clip_split/clip_move/clip_remove/clip_transform — ALL through the M1 command engine with the REAL command shapes (e.g. `SplitClip{atTimelineFrame,newLeftId,newRightId}`, `MoveClip{newTimelineStartFrame,newTrackId?}`, `UpdateClipProperties{transform}`) · Effects/animation: effects_list/effect_apply/keyframe_set/keyframe_clear/template_list/template_apply (NIIKI proposal → commands) · Engines: riishe_analyze (autocut-analysis job), gangzii_analyze/process (row+job), niiki_create_graphic, jazmii_generate_video, laxii_generate_image · AI: ai_plan/get_plan/approve_plan/execute_plan/cancel_plan · Preview/export: preview_frame, export_start/status/cancel (real NIKKI_RENDER lifecycle). Absent by design (documented in the catalog's `unsupported` list): media_import (browser chunked-upload flow), edit_undo/redo (session state — use version restore), arbitrary shell/SQL/FFmpeg tools.

## 10. Automation API (§9C)

`POST /api/automation/rpc` — same catalog, same token auth, simpler envelope (`{"method":"bean_…","params":{…}}`, batch arrays, `rpc.discover`). No second editing engine: every mutation lands in `applyTimelineEdits` with the caller's base version — conflicts surface as honest `VersionConflictError` (tested).

## 11. Effect and template discovery (§9D)

`bean_effects_list` / `capabilityCatalog()` — generated from ACTUAL registries: 6 clip effects (validated M1 `EffectType`) each with parameters, media types, and HONEST preview/export support notes (e.g. grayscale/blur marked "partial — FFmpeg application planned"; transitions marked full via the M6 xfade mapping); 8 transition kinds with their real FFmpeg equivalents; NIIKI templates (id/label/category/version); GANGZII presets with their real parameter blocks; the M1 command list; engine capability maps (JAZMII/LAXII provider capability objects included); explicit unsupported list.

## 12. Preview-frame inspection (§9E)

`bean_preview_frame {projectId, frame, maxWidth≤1280}` — REAL ffmpeg single-frame render from the topmost visible VIDEO-track source at that frame (source seek → scale → clip effects mapped where real: grayscale→hue=s=0, flips, blur→gblur; opacity/volume documented as not applicable to single-source frames). Cached by content key under `MEDIA_ROOT/tmp/preview-frames/`. Every response carries the privacy note: single-source inspection frame; the full composition lives in the editor monitor; **frames never leave the deployment unless the user sends them** (no LLM upload path exists).

## 13. Conversational interface + memory (§10/§11)

`my-ai-panel.tsx` (first panel in the editor tools stack): conversation thread with explicit mode labels (`MY AI (LLM)` vs `MY AI (rules)` vs errors), plan preview with risk-colored steps and approve/execute/cancel controls, execution step results (COMPLETED/ROUTED/SKIPPED/FAILED with details), session reload after successful timeline mutations, provider health + token-usage footer, and an automation-token manager (read-only default, shown-once secret). Conversations/messages/plans/audits/usage are project-scoped, user-owned Prisma rows (cascading deletes, per-user indexes); nothing stores media content. Cross-user isolation is enforced by every query being user-scoped (tested).

## 14. Concat-inspired capabilities — independent implementation

**Source studied (public surface only):** https://github.com/jub0t/Concat — README capability list (timeline ops; effects/transitions; MCP server; JSON-RPC API for scripts; local AI features). Concat is AGPL-3.0-or-later with a separate commercial licence.

**What BEAN FX independently implemented (no Concat code, algorithms, crates, UI, binaries, or assets were copied, ported, vendored, or repackaged):**
- MCP-compatible server — designed from the public JSON-RPC/MCP protocol shape and built on BEAN FX's own tool catalog, zod schemas, M1 command engine, and token model.
- JSON-RPC automation API — same shared catalog over a simpler envelope.
- Effect/template discovery — generated from BEAN FX's own registries (M1 model enums, NIIKI/GANGZII registries, M7 provider capability maps).
- Timeline automation verbs (add/trim/split/move/remove/transform, keyframes) — thin wrappers over BEAN FX's existing validated commands; naming/semantics follow the M1 schema, not Concat's.
- Preview-frame retrieval — BEAN FX's own ffmpeg single-source pipeline with caching.

**Licensing boundary respected:** capabilities were observed from public documentation; the implementation uses BEAN FX's existing architecture and separately reviewed dependencies (`@modelcontextprotocol/sdk` — MIT). BEAN FX makes no compatibility claim with Concat's internal engine, and this note documents the inspiration boundary per the milestone rules.

## 15. Privacy, consent, security model

- Credentials server-side only; automation tokens hashed; secret redaction on all LLM error paths (tested).
- Private media never leaves the deployment: the LLM sees user text + bounded structured context only; preview frames are never uploaded by any code path; external generation calls happen only after explicit approval (plan risk `generation` / panel GENERATE buttons).
- Ownership on every tool/route (project/asset/job lookups are user-scoped — tested cross-user).
- Rate limits: per-token MCP window; per-user M7 job concurrency unchanged; MY AI step budget (`BEANFX_MYAI_MAX_STEPS`) and plan TTL bound runaway orchestration. No infinite tool loops: the executor runs a bounded plan once per explicit call.
- Audit history: plan create/approve/reject/cancel, per-step outcomes, every automation tool call (success AND failure) in `AutomationAudit`.

## 16. Usage and cost controls

Token usage recorded per LLM call (`AIUsage`, provider-reported counts; usage summary endpoint + panel footer). Generation calls go through the M7 durable jobs with their metering/provenance. The panel states: "BEAN FX does not estimate cost without verified pricing data." No concurrency-capacity claims are made beyond what the existing worker enforces (global 2, per-user per-type 1).

## 17. Failure recovery

Executor: per-step bounded retries with conflict re-read; partial completion recorded truthfully; cancellation honored between steps; TTL expiry sweep on every plan read/execute; stale-context rejection prevents acting on outdated plans. Gateway: transient-only retries with capped backoff; timeouts; cancellation. Durable job infrastructure (M3) unchanged for engine work.

## 18. Testing evidence (executed this session)

| Suite | Result |
|---|---|
| `test-myai-gateway.test.ts` — provider config/unknown-id honesty, redaction, cancellation, structured-output failure honesty; **REAL run (`BEANFX_M8_REAL_PROVIDER=1`): health check + real chat with usage + fenced-JSON parsing** | **7/7 (7/7 real)** |
| `test-myai-planner.test.ts` — bounded context + ownership, deterministic-fallback labeling, approval gate, stale-plan rejection, idempotency, approve→execute INSERT_ASSET through M1+persistence (version bump + audit), cross-user execution refusal, cancel, **REAL preview frames (ffmpeg JPEG + cache hit + honest NO_FRAME)**, tool permissions/audit | **15/15** |
| `test-automation-mcp.test.ts` — initialize sans token, auth/allowlist/profile gates, `-32601` for unimplemented methods, rate limit, malformed requests, audit rows, **REAL MCP client (official SDK): connect → 39 tools → callTool** | **10/10** |
| `test-automation-api.test.ts` — inspection, foreign-user isolation, invalid-command rejection, **version-conflict surface**, full clip lifecycle (add/trim/split→new-ids/move/transform/keyframe/effect/remove), export lifecycle via real NIKKI_RENDER (start/status/cancel), plan tools end-to-end with honest ROUTED steps, preview privacy note, rpc.discover scoping | **11/11** |
| Live evidence: real LLM planner run — `mode: llm`, engines LAXII+NIIKI, steps `LAXII_GENERATE(generation) → NIIKI_GRAPHIC(timeline)`, persisted AWAITING_APPROVAL | recorded in this doc |
| Full matrix via `scripts/run-all-tests.sh` (M1–M7 regressions + the four M8 suites) | **18 suites, 0 failures** |

Gates: `tsc --noEmit` clean · `eslint --max-warnings=0` clean · `prisma validate` valid · production build success.

## 19. Migrations

Additive models: `Conversation`, `ConversationMessage`, `AIPlan`, `AutomationToken`, `AutomationAudit`, `AIUsage` (+ relation lists on User/Project, indexes). Applied via `prisma db push` (SQLite dev); Postgres-compatible additive DDL. No existing model changed; no data loss.

## 20. Known limitations (honest)

- One LLM provider (`zai`/glm-4-plus) is configured; the gateway is provider-independent but no second adapter ships.
- The planner's LLM output requires the normalization layer; models that deviate beyond its mapping fall back to the labeled deterministic planner after one informed repair attempt.
- RIISHE_AUTOCUT steps ROUTE to the M4 flow rather than re-implementing its ffmpeg cut math.
- `bean_preview_frame` is a single-source inspection frame (not the full compositor); clip effects grayscale/blur are validated model data with partial render application (documented per-effect).
- MCP rate limiting is per-process (single-node deployment); swap the window store for a shared one when scaling.
- `playhead`/`selection` are editor-session state — the API exposes version-scoped timeline reads instead (documented in-tool).
- Streaming responses are not implemented (the provider's SDK path is request/response); the panel shows final replies with mode labels.
- Cost is tracked in tokens only; no fabricated $/token rates.
