# M42 — AI Edit Plan & Command Contract (documentation)

## Plan lifecycle

1. **Create** — `POST /api/my-ai/plans` (or the RIISHE chat with a build/revision intent) → the MY AI planner produces a plan whose steps are timeline COMMANDS (canonical, M1-validated, undoable) and/or GENERATION REQUESTS that require explicit approval before any job is created. Mode is recorded honestly: `llm` (gateway verified healthy) or `deterministic-fallback` (rule-based, labeled — never presented as model reasoning).
2. **Review** — the AI Edit Chat renders the plan summary (steps, warnings, expectedChanges) BEFORE anything is applied. The plan state is PENDING.
3. **Approve** — `POST /api/my-ai/plans/{id} {action:"approve"}` → APPROVED (owner-bound).
4. **Apply** — `{action:"execute"}` → the EXISTING executor validates every step against the LATEST sequence revision (stale plans are rejected/re-validated — a stale AI plan cannot overwrite user edits made after analysis), applies canonical commands through the editor command system, and returns the real execution report (applied/failed counts).
5. **Undo/Redo** — applied steps live in the editor's normal history (the session's EditHistory), so inverse operations are safe and re-validated.
6. **Render** — separate explicit action → the existing durable `RENDER_TIMELINE` batch pipeline; the chat reports job states verbatim and never conflates "timeline updated" with "render complete".

## State semantics (spec §9.4)

`plan (PENDING)` ≠ `approved` ≠ `applied to timeline` ≠ `rendered` ≠ `deliverable`. Every surface in the chat labels the exact state; execution reports carry the real counts; renders carry the real job status/progress/message.

## Safety rules

- Plans validate against the latest project revision at execute time (conflict handling per the session's conflict message convention).
- Only authorized (user-owned) media can be referenced; the plan cannot invent assets.
- Destructive operations (deleting originals, replacing media, publishing, external uploads, paid execution) stay outside plan auto-execution — they require their own explicit approvals.
- Untrusted content (media metadata, transcripts, model output) is data, not instructions.
