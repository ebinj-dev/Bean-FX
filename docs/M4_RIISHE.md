# M4 — RIISHE: apply proposals as validated timeline commands

Milestone goal (repo audit §3): *"RIISHE → timeline: decisions persisted, not
applied to a timeline → Apply proposals as validated commands."* Until M4, an
RIISHE analysis produced persisted decisions (P3) and export-only cutting;
the editor timeline could not receive the proposals. M4 closes that gap.

## What was built

**`src/lib/riishe-timeline.ts`** — pure mapping module (no I/O, no UI):

- `effectiveRemovalSec(candidates, decisions, durationSec)` — the effective
  removal ranges in source seconds. Membership rule mirrors the export-apply
  path exactly: a persisted `APPROVE` makes a cut; a REMOVE verdict with no
  persisted decision makes a cut; `REJECT`/`KEEP` never do. Equivalence with
  `decisionToReview` (auto-cut) is unit-tested. Ranges are normalized with
  the same `normalizeRanges` used by export and preview (clamp + union +
  adjacent merge), so overlapping proposals never double-count.
- `planRiisheTimelineApply({ sequence, removalsSec, sourceAssetId, reservedIds })` —
  plans ONE atomic command batch for the session's EditHistory:
  - Every cut — head, tail or interior — is expressed as `SplitClip` at its
    boundaries plus `RippleDelete` of the removed piece. Ripple closes the
    gap, so the edited timeline equals the export math
    (final = original − removals, segment for segment). `TrimClip` is
    deliberately NOT used: a trim alone leaves the following material
    unshifted (a hole in the timeline).
  - Cuts are planned against each clip's ORIGINAL geometry and emitted in
    DESCENDING timeline order — each `RippleDelete` only shifts material to
    its right, so earlier (leftward) cut positions stay valid.
  - Timeline positions are computed with the engine's own
    `clipTimelineDuration`, so `SplitClip`'s exactness requirement holds by
    construction (no snap failures from independent rounding).
  - Piece ids are deterministic, collision-free, ≤64 chars; `reservedIds`
    lets the UI compose several per-asset plans into one batch.

**Editor integration** (`src/components/bean/tools/editor.tsx`) — an
"Apply RIISHE cuts" toolbar action (Sparkles icon, spinner while busy):

1. Collects the distinct media assets actually used by sequence clips.
2. For each asset with a completed RIISHE analysis (newest first), fetches
   the stored result (`/api/autocut/analyze/result/[jobId]`) and persisted
   decisions (`/api/autocut/decisions`), computes the effective removals and
   plans the command batch (`reservedIds` chains the plans into one batch).
3. Confirms with a summary (cuts, clips, fully-removed clips, skips), then
   applies via `session.apply` — one transaction, one undo step, autosaved.
4. Honest surfaces: no analysis → explicit notice; nothing to cut → explicit
   notice (already applied / kept / rejected / sub-frame); refusal by the
   command engine → "Nothing was changed" (the transaction is atomic).

**Lint hardening** (same files as the stabilization push):
`monitor.tsx` no longer writes refs during render (React hooks rule) — the
mirror now happens in a post-render effect; four stale `eslint-disable`
directives removed. `eslint src --max-warnings=0` is clean again.

## Safety

- Proposals never touch media or the filesystem; they become zod-validated
  commands from the M1 command model only (`SplitClip` / `RippleDelete`).
- Locked tracks are skipped with a warning — never silently unlocked.
- `missingMedia` clips, captions and clips of other assets are never touched.
- Cuts smaller than one frame of the clip's source timebase are skipped with
  an honest warning instead of being silently rounded away.
- The batch applies through `applyTransaction`: any invalid command aborts
  the whole batch without mutating the sequence (unit-tested).

## Validation (this milestone, executed)

- `bun test scripts/test-riishe-timeline.test.ts` — **14/14 pass** (84
  assertions): interior/head/tail/whole-clip cuts with exact frame math,
  multi-cut ordering, reused-media instances, locked-track and missing-media
  skips, idempotence (re-plan after apply → 0 commands), decision mapping
  equivalence with `decisionToReview`, `normalizeRanges` reuse, sub-frame
  skips, atomic abort without mutation, id allocator bounds.
- Full unit suites in verified combinations: editor regressions + media
  pipeline **33/33**; `p3_union` + words/SRT + v5 inference reliability
  **27/27**; M4 + those three suites together **41/41**. (Running ALL suites
  in one concurrent `bun test` invocation shows 5 failures in the M3.4/M3.5
  worker tests — a test-isolation artifact of concurrent DB/worker state,
  reproducible without any M4 code; the per-suite combinations above are the
  established verification commands.)
- `npx tsc --noEmit` clean; `npx eslint src --max-warnings=0` clean;
  `npm run build` (production) success.

## Limitations (honest)

- Only the NEWEST analysis per asset is offered; re-running an analysis and
  re-deciding supersedes the previous proposal set by design.
- Transitions spanning a removed range are removed with the piece
  (`applyRemoveClip` cleans attached transitions); transitions fully inside
  kept material survive. Crossing-boundary transition semantics are future
  work (the engine's overlap rules make the general case non-trivial).
- Clips with `playbackSpeed ≠ 1` are supported through the engine's duration
  math, but are not covered by a dedicated speed-specific unit test yet.
- The action applies to the current sequence only; there is no "apply to a
  copy" variant yet.

## Deliberately NOT changed

- `prisma/schema.prisma` (the workspace copy carries unused `cutDecisions`
  relation declarations — a cosmetic divergence; no code references them, so
  the repo schema stays canonical).
- `package.json` (workspace-only dev-server conveniences).
- No database switch, no schema migration, no secrets.
