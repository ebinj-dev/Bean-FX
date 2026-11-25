# Editor Command Contract (M43-B)

**Status:** Implemented and tested. This document describes the authoritative editing-command registry exactly as it exists in code — the contract for UI, RIISHE, specialist agents, MCP tools and automation workflows.

## Principle

One canonical executor. Every timeline mutation — a human click, an RIISHE plan step, an MCP tool call or an automation workflow — flows through the same chain:

```
(commandId, params)
   → command-registry (descriptor gate: availability, risk, approval policy)
   → parseCommand (zod — fail-closed)
   → applyCommand / applyTransaction (pure, deterministic, builds the undo inverse)
   → applyTimelineEdits (versioned snapshot + optimistic concurrency + audit)
```

No LLM, agent or tool ever writes timeline JSON, DB rows or shell commands directly. A human action and an AI action produce the identical valid editor operation.

## The registry — `src/lib/editor/command-registry.ts`

Pure layer (no DB). `COMMAND_DESCRIPTORS` holds **exactly one descriptor per canonical command type** (36 total — completeness is asserted by `scripts/test-m43-command-registry.test.ts`). Each `CommandDescriptor` defines:

| Field | Meaning |
| --- | --- |
| `id` | Stable unique id, `timeline.<camelCaseType>` (e.g. `timeline.trimClip`). |
| `commandType` | The exact discriminated-union literal from `src/lib/editor/commands.ts`. |
| `description`, `category`, `paramsDoc` | Agent-facing discovery payload (`commands.describe`). |
| `capabilities` | Caller capabilities required (all timeline commands: `timeline.mutate`). |
| `scope` | `project` — media is never touched by timeline commands. |
| `risk` | `low` (additive/property) · `timeline` (structural) · `destructive` (removes entities). |
| `requiresApproval` | `true` ⟺ `risk === "destructive"`; enforced by the service (see below). |
| `available(seq)` | Cheap enabled-condition pre-check (advisory; the executor stays authoritative). |

`previewCommand(seq, input)` runs the canonical `applyCommand` on a clone and diffs before/after — `{ok:true, diff, sequenceAfter}` or `{ok:false, error}`. **Preview == apply by construction** (same code path); preview never mutates.

## The service — `src/lib/my-ai/commands-service.ts`

DB-facing dispatcher. All results are structured (`{ok:true,...}` or `{ok:false, code, error, currentVersion?, failedIndex?}`) — never thrown across the boundary except persistence internals, which are mapped to structured codes.

| Method | Mutates? | Notes |
| --- | --- | --- |
| `commandsList(projectId, userId)` | no | All 36 commands with LIVE availability against the head sequence + `headVersion`. |
| `commandsDescribe(commandId)` | no | Full descriptor (params doc, risk, approval policy). |
| `commandsValidate(projectId, userId, commandId, params, expectedRevision?)` | no | Registry gate + zod parse + executor re-validation; structured `VALIDATION_FAILED`. |
| `commandsPreview(projectId, userId, commandId, params, expectedRevision?)` | no | Pure before/after diff vs the head. |
| `commandsRun(projectId, userId, commandId, params, expectedRevision, caller, approval?)` | **yes** | Revision-aware single command; returns the exact undo `inverse`; audits provenance. |
| `commandsBatch(projectId, userId, entries[], expectedRevision, caller, approval?)` | **yes** | ATOMIC all-or-nothing: dry-run on clones locates the first failure with `failedIndex` and zero DB writes; valid batches persist as ONE version via `applyTimelineEdits`. |

### Revision awareness

`expectedRevision` is **required** for run/batch and optional (defaults to head) for validate/preview. A stale revision yields `REVISION_CONFLICT` carrying the authoritative `currentVersion` — nothing is applied. Concurrent writers are separated by the existing DB-level optimistic-concurrency check (`VersionConflictError` → same structured code).

### Approval policy (destructive commands)

`requiresApproval` commands (RemoveTrack, RemoveClip, RippleDelete, RelinkAssets, RemoveTransition, RemoveEffect, RemoveKeyframe, RemoveMarker, …) are refused with `APPROVAL_REQUIRED` unless the caller presents an `ApprovalContext`:

- `APPROVED_PLAN` — an M8 §8-approved MY AI plan (the AI path),
- `MCP_APPROVAL` — a consumed hash-bound one-time `McpApproval` (the MCP path, same gate as `jobs.submit`),
- `UI_SESSION` — the authenticated human session (the manual-editor path).

Plan-level approval (M8 §8: every plan is born `AWAITING_APPROVAL`) governs the AI path independently and continues to work unchanged — the executor (`src/lib/my-ai/execution/executor.ts`) keeps dispatching `APPLY_COMMANDS` through the same versioned persistence.

### Provenance

Every mutation writes an `automationAudit` row: `COMMANDS_RUN` / `COMMANDS_BATCH` with `{commandIds, proposedBy: {kind: UI|AGENT|MCP|AUTOMATION|CLI, id}, approval, revisionFrom, revisionTo}` — "which agent proposed and executed each operation" (§7). Undo: `commandsRun`/`commandsBatch` return the executor-built inverse stack; full timeline history + restore remain available via the existing `listTimelineVersions` / `restoreTimelineVersion`.

## MCP surface — `beanfx.commands.*`

Registered through the shared `registerTools` bootstrap (`src/lib/mcp/bootstrap.ts`), served identically by the HTTPS transport (`/api/v1/mcp`) and the stdio bridge:

| Tool | Scope | Mutates | Approval |
| --- | --- | --- | --- |
| `commands.list` | `projects:read` | no | — |
| `commands.describe` | `projects:read` | no | — |
| `commands.validate` | `projects:read` | no | — |
| `commands.preview` | `projects:read` | no | — |
| `commands.run` | `projects:write` | **yes** | one-time hash-bound `McpApproval` (`commands.run`) |
| `commands.batch` | `projects:write` | **yes** | one-time hash-bound `McpApproval` (`commands.batch`) |

## Determinism

Ids involved in structural changes are part of the command payload (callers generate them); the same command from the same sequence yields byte-identical results and inverses (asserted by the test suite). Undo parity is asserted by round-tripping inverse stacks back to the original state.

## Tests

- `scripts/test-m43-command-registry.test.ts` — 25 tests: completeness, describe, availability gating, preview==apply, undo parity (TrimClip/SplitClip/MoveClip/AddMarker/AddTransition/ChangeVolume/GroupClips/RippleDelete), risk/approval policy, determinism.
- `scripts/test-m43-commands.test.ts` — 24 tests on a real scratch DB: list/describe/validate/preview against the live head, revision conflicts, provenance audit rows, destructive approval policy, atomic batch abort (nothing persisted), MCP scope enforcement + hash-bound one-time approval.
- Registry allowlist pins updated: `test-m22-mcp-client`, `test-m23-mcp-raw-client` (nine core tools + the six `commands.*` tools).
