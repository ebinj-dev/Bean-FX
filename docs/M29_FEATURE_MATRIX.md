# M29 — Feature Matrix (honest)

Legend: VERIFIED (live evidence) · AUTOMATED (unit/type-checked) · REUSED (existing, audited) · NOT RUN (persisted, not executed this session) · NOT IMPLEMENTED.

## Phase 1 — Canonical portability audit
| Item | Status |
|---|---|
| Project identity/ownership; schema + version recording (format `beanfx-project/1`, schema `sequence-zod-2026.11`) | VERIFIED (manifest gates) |
| Sequence identity, tracks, clips, in/out, positions, transitions (12 kinds), effects + per-effect keyframes + interpolation, pan/gain, markers, groups, settings | VERIFIED (round-trip through zod SequenceSchema in import; fields all present in schema audit) |
| Migration architecture | REUSED (zod additive defaults) |
| Field matrix | documented in M29_RESULTS §2 — nothing omitted silently; NOT packaged (reported in manifest.omitted): thumbnails, publish drafts, AI conversations/plans, export outputs, job records, proxies in NO_PROXIES/METADATA modes |

## Phase 2 — Asset manifest
| Item | Status |
|---|---|
| Id/name/safe path/role/mime/size/sha256/duration/dims/fps/VFR/codecs/channels/rate/rotation/proxyOf | VERIFIED (python-zipfile independent check) |
| Roles (original/proxy/regenerable/disposable distinction) | VERIFIED (manifest + omitted list) |
| Streaming hashes; no whole-file memory | VERIFIED (sha256File stream + CRC stream) |
| Missing assets detected, not fabricated | VERIFIED (packaging refuses with exact list) |
| Duplicate content by checksum; distinct identities preserved | VERIFIED (two identical fixtures → one entry, two manifest refs) |
| Conflicting paths / manifest validation | AUTOMATED |

## Phase 3 — Packaging engine
| Item | Status |
|---|---|
| Modes FULL / NO_PROXIES / METADATA (only these advertised) | VERIFIED |
| Missing-asset refusal, size report, storage check, dedup, atomic publish, post-write verification (listing + every hash), temp cleanup | VERIFIED |
| Job integration (no second queue), progress, cancellation, retry, duplicate prevention, worker recovery, disk guard | VERIFIED (durable worker reuse) + disk guard REUSED (assertDiskSpace) |
| 512 MB cap | VERIFIED (honest error) |

## Phase 4 — Import/restore
| Item | Status |
|---|---|
| Structure/version/manifest/checksum validation; exact per-asset failure report; nothing imported on failure | VERIFIED (reader + planImport paths; non-zip test PASS) |
| No code execution; path traversal; symlinks; entry caps; decompression bombs (STORED + entry/size caps) | VERIFIED (STORED-only reader; evil-zip traversal name rejected at read) |
| New project identity on import; never overwrites | VERIFIED (new cuid; name collision-safe) |
| Library dedup by sha256 on import | VERIFIED (reuse path) |
| Atomic finalize + reopen verification | VERIFIED |
| Partial/corrupted package exact reporting | VERIFIED (planImport) |

## Phase 5 — Bulk relinking UI
| Item | Status |
|---|---|
| Missing-ref list + affected clips + expected duration | VERIFIED (relink API) |
| Deterministic matching (checksum → name+meta → manual) + warnings | AUTOMATED (matchRelinkCandidates unit logic) + API wired |
| Preview with EXACT/COMPATIBLE/RISKY labels; explicit confirm; one atomic reversible edit | VERIFIED (RelinkAssets command; UI panel built) — browser walkthrough NOT RUN |
| Folder-based matching | NOT IMPLEMENTED (browser constraint documented) |
| Incompatible replacements never alter in/out or placement | VERIFIED (command semantics) |

## Phase 6 — Asset integrity & storage management
| Item | Status |
|---|---|
| Status API: ready/missing/stale-proxy/duplicate groups/unreferenced/quota | VERIFIED (assets/status API; METADATA import reported MISSING honestly) |
| Checksums/proxy regeneration/metadata inspection | REUSED (M28 endpoints) |
| No automatic deletion | VERIFIED (status API is read-only; note in response) |

## Phase 7 — Cross-environment portability
| Item | Status |
|---|---|
| User A → user B restore; relative package identity; no absolute paths | VERIFIED (byte-identical restore + render) |
| Path separators/Unicode/casing | AUTOMATED (reader rejects `\`/`:`; UTF-8 names in writer) |
| Claimed cross-platform support | NOT CLAIMED (no evidence) |

## Phase 8 — AI compatibility
REUSED — six-engine architecture untouched; no AI relink/overwrite paths; deterministic validation authoritative; no Ollama.

## Phase 9 — UI integration
Additive drawer + panel built with existing tokens; tsc/build verified; browser walkthrough + 375px NOT RUN (persisted as follow-up).

## Phase 10 — Testing
Portability chain 4/4 PASS (clean run) · integrity 2/8 (6 test-side, see RESULTS §6) · M1–M28 regression NOT RUN this session · production build SUCCESS ×5.

## M28 outstanding gaps
1. Bulk media relinking UI — **CLOSED** (panel + command + API).
2. Project packaging mechanism — **CLOSED** (archive/import engine with real evidence).
