# M39 §8 — Per-profile audio-variant contract (decision record)

Status: **DECIDED — preserve the MP4-only M26 fan-out; no audio variants without an owner decision.**
This record documents the contract as it exists in code, why the conservative
reading wins for now, and exactly what an audio companion would entail.

## 1. What the product contract actually says today

- `src/lib/publish/profiles.ts` (M9 registry, reused by M26): every export
  profile is a social-platform conformance spec — `container: z.literal("mp4")`,
  H.264 video + AAC-LC audio at platform-conformant bitrates (e.g. 1080p30 =
  8 Mbps, AAC 384 kbps stereo). Audio is part of the ONE deliverable; there is
  no audio-only profile and no audio-companion field in the schema.
- `src/lib/publish/variants.ts`: one `EXPORT_VARIANT` job per (master, profile)
  produces exactly one deterministic output, `variant_<variantId>.mp4`, encoded
  with the profile's scale/pad/fps/bitrate spec. Output count per fan-out =
  number of selected profiles.
- `POST /api/editor/projects/[projectId]/batch-export` (M26): fan-out dedup is
  per (master, profile); the queue UI lists one row per profile.
- M29 packaging/zip and M30 review previews attach `ExportVariant` outputs —
  one deliverable per profile is assumed by both.

## 2. The four candidate readings

| Reading | Consequence |
|---|---|
| 1. One primary video per profile (status quo) | Matches every current consumer (registry schema, deterministic output names, zip manifest, review previews, queue UI). |
| 2. Separate audio-only output per profile | Doubles deliverable count per fan-out; audio "profiles" (aspect ratio, fps, video bitrate) are meaningless for audio — the registry model does not fit without a second profile class. |
| 3. Optional audio companion per profile | Backward-compatible in shape (extra row/asset), but changes output naming, zip manifests, review attachment logic, storage accounting, and the batch UI's per-profile result semantics — none of which have an owner-approved design today. |
| 4. Multiple video/audio deliverables per profile | Same as 3, plus platform-conformance questions (which audio specs?) that are a product decision, not an engineering one. |

## 3. Decision

**Preserve reading 1 (MP4-only fan-out) as the default.** The existing M26
behavior is intentional (M9 platform conformance + M26 contract) and every
downstream consumer assumes one deliverable per profile. Adding audio variants
now would silently change deliverable counts, manifests and reviews — exactly
the kind of unapproved contract change M39 §8 forbids.

## 4. What an owner-approved audio companion would require (future work)

1. Registry: an `audioCompanion` spec per profile (codec/bitrate/extension) or
   a separate audio profile class — additive Prisma fields for variants.
2. Output identity: `variant_<id>.m4a` (or .mp3) alongside the MP4; dedup keys
   extended per deliverable kind.
3. UI: per-profile companion toggle + queue rows distinguishing video/audio.
4. Packaging/review: zip manifest and review previews enumerate both kinds.
5. Migration: variants rendered before the change keep one deliverable (no
   backfill required — companions render on demand like any retry).

## 5. Cross-reference

Timeline-level audio exports (WAV/MP3 of the sequence mix) ALREADY exist and
are batch-capable via M38/M39 — `RENDER_TIMELINE` audio jobs. The profile
fan-out remains a video deliverable pipeline; audio needs are met one level up
the stack. This is why the conservative reading costs users nothing today.
