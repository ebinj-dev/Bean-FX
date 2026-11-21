# M33 — MASK LIFECYCLE & PROJECT PORTABILITY (Track B)

**Result: 9/9 tests pass. VERIFIED.**

## The gap found and fixed

M32 shipped mask PROCESSING/COMPOSITING but the M29 package format had NO mask section — masks would silently vanish on package/import. M33 extends `PackageManifest` with `masks: ManifestMask[]` (source asset link, version chain via parentId, validation status, checksums) and restores them on import with identity remapping.

## Lifecycle proven (deterministic fixtures, real M29 machinery)

1. Real mask created via `/api/masks import` → PIL-validated (640×360, alpha stats) → `VALIDATED`.
2. Versioned processing (feather → v2 with partial-alpha band) — parentId chain.
3. Canonical timeline commands (AddTrack/AddClip) reference the masked source; project saved (real head version).
4. Reopen via fresh `getTimelineHead` — mask + project intact (no in-memory state).
5. `buildManifest` (FULL): BOTH mask versions packaged under `masks/<id>.png` with real sha256; manifest association verified.
6. `importPackage` into a CLEAN user library: masks restored with **remapped identities** — new mask ids (never overwriting), `sourceAssetId` remapped via the asset idMap (points at the IMPORTER's restored asset), `parentId` chain remapped (v2.parentId === imported v1 id), content sha256 identical to the original mask file.
7. Relink: mask pointed at a new owned source asset (provenance note `relinked from X → Y`).
8. Render: FFmpeg alphamerge compositing using the IMPORTED mask — output ffprobe-verified AND **pixel-verified** (amber subject inside the mask ellipse, blue background outside; ±4 YUV tolerance).
9. §B4 recovery: a mask whose FILE is missing ships as metadata-only manifest entry (`path:""`, sha256:"") + `MASK_BYTES` omitted entry; import restores an honest **FAILED** row (issue recorded, no silent substitution, project usable).
10. §B3: mask pre-check is NON-fatal — a checksum-bad mask never aborts the import (assets remain atomic as in M29); per-mask failures recorded in `ImportResult.maskIssues`.

Safe-path discipline (`masks/<safe-id>.png`, traversal-checked) and checksum validation (size + sha256 at pre-check AND during extraction) are inherited from the M29 system.

**Evidence:** suite transcript `evidence/` (test-m33-mask-portability run) — model/file identities, manifest entries, checksums before/after, relink notes, rendered output pixel check all asserted programmatically.
