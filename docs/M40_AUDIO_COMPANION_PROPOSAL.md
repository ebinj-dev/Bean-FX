# M40 §9 — Per-profile audio companion: contract verification & future proposal

Status: **NO BEHAVIOR CHANGE.** The M39 decision (preserve the MP4-only M26 fan-out) is reaffirmed; this document verifies the contract still holds in the M40 tree and prepares a technically grounded proposal for a future OPTIONAL audio companion, for owner review only. Nothing in this proposal is implemented.

## 1. Contract verification (M40 tree, actual code)

- `src/lib/publish/profiles.ts`: the registry schema still pins `container: z.literal("mp4")` and every built-in profile (lines 78/101/124…) ships MP4/H.264+AAC at platform-conformant bitrates. There is still **no audio-only profile and no audio-companion field**.
- `src/lib/publish/variants.ts`: one `EXPORT_VARIANT` job per (master, profile) still produces exactly one deterministic `variant_<variantId>.mp4`.
- M26 batch fan-out (`POST /api/editor/projects/[projectId]/batch-export`): dedup per (master, profile); the UI lists one row per profile — unchanged in M40 (M40 touched only timeline-range surfaces, not the variant pipeline).
- M29 packaging / M30 reviews still assume one deliverable per profile.
- **Verification result: the M26 contract is intact. No drift, no accidental audio outputs.**

## 2. Newly discovered compatibility notes (from M40 work)

1. The M40 range-aware package manifest (`exports[]`) records TIMELINE_RENDER outputs; publish VARIANTS are deliberately **not** in that section — if a future audio companion is approved, variant deliverables would need their own manifest treatment (identity + range does not apply: variants are full-master transcodes; range fields would be `rangeKind: "full"` by definition).
2. M40 review previews derive their range from render params; companion audio attached to a review would need the same derivation extended to audio deliverables (trivial — the params contract already carries format).

## 3. Proposal for a future OPTIONAL audio companion (owner decision required)

**Design shape (when approved):**
- Registry: additive `audioCompanion?: { codec: "aac" | "mp3"; bitrateKbps: number; container: "m4a" | "mp3" }` per profile; absent = today's behavior byte-for-byte.
- Execution: the SAME `EXPORT_VARIANT` job emits the companion AFTER the MP4 (extract+encode from the already-rendered master — no second render, one extra ffmpeg pass per enabled profile).
- Identity: `variant_<variantId>.<ext>` alongside the MP4; dedup key gains a deliverable-kind dimension; existing variants keep exactly one deliverable (no backfill).
- UI: per-profile "audio companion" toggle; queue rows distinguish video/audio deliverables.
- Packaging/reviews: zip manifest enumerates both kinds; review revisions may attach either (immutable revision rules unchanged — new deliverables bind to NEW revisions only).
- Storage: companions count as publish-variants category bytes (existing lifecycle protections apply).

**Costs / risks:** deliverable-count change for enabled profiles (manifests, reviews, storage accounting), one more transcode per fan-out, and UI complexity in the variant queue. None of it is urgent: timeline-level WAV/MP3 exports already exist through the M38/M39 batch pipeline for users who need audio today.

**Recommendation:** defer until an owner explicitly approves; the conservative MP4-only default costs users nothing today.
