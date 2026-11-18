# M9 — Professional Publishing & Creator Workflow

Milestone goal: *"Transform the existing Social Video Studio and professional editor into a complete creator publishing workflow — thumbnails, platform-specific metadata, multiple export variants, brand presets, content validation and publication-ready packages."* Everything below reflects what SHIPPED and is backed by the tests and live verification in §13. M10 was not started.

## 1. Architecture and service reuse

M9 adds **no new queue, renderer or storage layer**. Every capability is composed from the existing engines:

| M9 capability | Reused service |
|---|---|
| Durable background work | `Job` table + M3.4 media worker (claim/heartbeat/retry/timeout). Three new job types: `PUBLISH_THUMBNAIL`, `EXPORT_VARIANT`, `PUBLISH_PACKAGE` (registered in `job-helpers.ts` + `media-worker.ts` with per-type timeouts 15/45/30 min and per-user concurrency 1). |
| Video rendering | The existing NIIKI render pipeline produces the master; `EXPORT_VARIANT` transcodes the master through the existing `jobManager.runFfmpeg` path (real `-progress` reporting, cancellation, timeout kill). No duplicate FFmpeg engine. |
| Thumbnail images | LAXII (`laxiiProvider()` — the same provider-independent image gateway M7 ships), outputs registered through the shared `registerGeneratedAsset` lifecycle (sniff → quota → sha256 → provenance). |
| Metadata generation | MY AI (`llmProvider()` + `chatValidated()` — schema-validated LLM output with one informed repair attempt). `chatValidated` gained an additive optional `provider` option (service seam); default behavior unchanged. |
| Transcription/caption context | RIISHE remains the ASR path (M8.1 narration/ASR timing); M9 metadata reads the Studio plan's script/scenes — no new transcription code. |
| Motion graphics / audio | NIIKI (titles/captions) and GANGZII (audio processing) are untouched and remain the paths for their domains; M9 does not duplicate them. |
| Asset storage | `MediaAsset` lifecycle for every generated thumbnail/composite; `ExportFile` for every completed variant output; storage stays under `MEDIA_ROOT` (`media-store/publish-variants/`, `media-store/publish-thumbnails/`, `media-store/packages/`, `media-store/laxii-outputs/`). |
| Auth/ownership | Session auth (`getCurrentUser`) + `userId` ownership checks on every row lookup in every route and job handler. |
| Audit history | `AutomationAudit` records preset applies/reverts, variant create/cancel/retry and package creation. LLM usage lands in `AIUsage` (purpose `publish-metadata` / `publish-metadata-field`). |

New server modules (all typed, zod-validated contracts): `src/lib/publish/profiles.ts`, `variants.ts`, `metadata.ts`, `thumbnails.ts`, `presets.ts`, `jobs.ts`, `zip.ts`. UI: `src/components/bean/editor/publishing-panel.tsx` mounted in the editor tools column (`editor.tsx`) — the BEAN FX visual language is preserved; no unrelated editor section was redesigned.

## 2. Database changes (additive only)

Five new models (SQLite via Prisma; `prisma db push` applied to the runtime DB — the project's documented migration mechanism; no existing model or column changed, all new columns/rows backfill to NULL/default):

- **`BrandPreset`** — user-owned reusable brand profile: `name`, `brandName`, `logoAssetId`/`watermarkAssetId`/`introAssetId`/`outroAssetId` (owned MediaAsset refs), `primaryColor`/`secondaryColor` (hex), `fontFamily` (`inter | nikki-sans | nikki-tamil`), `captionStyleJson`, `thumbnailStyleJson`, `defaultExportProfile` (validated profile id).
- **`ThumbnailDraft`** — per `(projectId, platform)` thumbnail workspace: `status` (DRAFT | GENERATING | READY | FAILED), `prompt`, `layoutJson` (editable overlay), `candidateIdsJson` (ordered generated assets), `selectedAssetId`, `compositedAssetId`, `provenanceJson`, `jobId`.
- **`PublishMetadata`** — per `(projectId, platform)`: `language` (en | ta), `status` (DRAFT | GENERATED | APPROVED), **`draftJson`** (AI suggestions + per-field provenance) and **`approvedJson`** (user-approved values) stored SEPARATELY, `fieldHistoryJson` (bounded regen history), `provider`/`model`.
- **`ExportVariant`** — one variant: `profileId`, `profileVersion`, `profileJson` (the EXACT profile used — audit evidence), `status` (QUEUED | RENDERING | COMPLETED | FAILED | CANCELLED), `progress`, `stage`, `sourceExportId`/`sourceAssetId`, `resultExportId` (completed ExportFile), `validationJson` (ffprobe conformance report), `attempts`, `jobId`.
- **`PublishPackage`** — `variantIdsJson`, `metadataId`, `thumbnailDraftId`, `manifestJson`, `manifestSha256`, `storagePath` (zip), `sizeBytes`, `status` (BUILDING | READY | FAILED), `jobId`.

`prisma validate` ✓. User/Project relations added additively.

## 3. API endpoints (all session-authenticated, ownership-checked, zod-validated)

| Method + path | Purpose |
|---|---|
| `GET /api/publish/profiles` | Versioned profile registry (+ thumbnail geometry per profile). |
| `GET /api/publish/status` | Honest engine + integration status (see §9). |
| `GET/POST /api/publish/presets` · `GET/PATCH/POST(duplicate)/DELETE /api/publish/presets/[id]` | Brand preset CRUD + duplication. |
| `GET/POST/DELETE /api/publish/presets/[id]/apply` | Preview (no writes) → apply (`{"confirm":"apply"}` required) → audit-backed revert. |
| `GET/POST /api/publish/thumbnails` · `GET/PATCH/DELETE /api/publish/thumbnails/[id]` | Draft lifecycle; PATCH edits prompt/layout/selection (selection must be an OWNED image). |
| `POST /api/publish/thumbnails/[id]/generate` | Enqueue durable `PUBLISH_THUMBNAIL` (1–4 alternatives; reference image supported where the provider allows image-to-image). |
| `POST /api/publish/thumbnails/[id]/composite` | Apply the editable title overlay → NEW composited MediaAsset (never overwrites). |
| `GET/POST /api/publish/metadata` | List; generate/refresh a draft via MY AI (503 + typed error when the provider is unavailable — never placeholder text). |
| `GET/PATCH/DELETE /api/publish/metadata/[id]` | Fetch; `{approved: fields}` stores USER-APPROVED values (schema-validated); `{unapprove:true}` clears approval. |
| `POST /api/publish/metadata/[id]/field` | Regenerate ONE field with a targeted LLM call (draft only; approved fields never overwritten). |
| `GET/POST /api/publish/variants` | Export history (§8); create variant — the master is probed with real ffprobe and validated against the profile BEFORE enqueueing (422 with typed failures). |
| `GET/DELETE /api/publish/variants/[id]` · `POST /api/publish/variants/[id]/retry` | Inspect + cancel (queued/rendering only) + retry failed/queued. |
| `GET/POST /api/publish/packages` · `GET/DELETE /api/publish/packages/[id]` · `GET /api/publish/packages/[id]/download` | Package lifecycle + downloadable zip (`X-Manifest-Sha256` header). |

## 4. Export profile definitions and their authoritative sources

Registry version **`2026.11.13`** (`src/lib/publish/profiles.ts`). Rules were verified from platform documentation on 2026-11-13 before being encoded; every profile records its sources, and constraints WITHOUT an authoritative source are marked `bitrateSource: "deployment-default"` and kept configurable (full-registry override via `BEANFX_EXPORT_PROFILES_JSON`, schema-validated — an invalid override is refused loudly).

| Profile | Geometry/fps | Codec/pixfmt | Audio | Video bitrate | Duration cap | Source(s) |
|---|---|---|---|---|---|---|
| `youtube_landscape` | 1920×1080@30 (16:9) | H.264 High, yuv420p, faststart | AAC-LC 48 kHz stereo 384 kbps | 8 Mbps — **official** | **none encoded** (no cap on the encoding page) | support.google.com/youtube/answer/1722171 |
| `youtube_shorts` | 1080×1920@30 (9:16) | same | same | 8 Mbps — **official** | **180 s** (verified: Shorts are up to 3 minutes when square/vertical) | support.google.com/youtube/answer/15424877 (+1722171) |
| `instagram_reels` | 1080×1920@30 (9:16) | H.264 High, yuv420p | AAC 48 kHz stereo 256 kbps | 6 Mbps — deployment default | **none encoded** (Meta's Content Publishing doc, fetched 2026-11-13, documents the flow + 100-posts/24 h limit but no hard Reels duration cap) | developers.facebook.com/documentation/instagram-platform/content-publishing |
| `tiktok` | 1080×1920@30 (9:16) | H.264 High, yuv420p | AAC 48 kHz stereo 256 kbps | 6 Mbps — deployment default | **none encoded** (TikTok in-feed spec lists .mp4/.mov, 9:16 ≥540×960, "no restrictions" duration; the 5–60 s policy cap applies to ADS, not organic) | ads.tiktok.com/resources/help/article/tiktok-auction-in-feed-ads (+ …/tiktok-ads-policy-ad-format-and-functionality) |
| `square_social` | 1080×1080@30 (1:1) | H.264 High, yuv420p | AAC 48 kHz stereo 256 kbps | 6 Mbps — deployment default | none | — (generic geometry; no single platform authority — recorded honestly) |
| `custom_landscape` / `custom_portrait` | 1920×1080 / 1080×1920 @30 | H.264 High, yuv420p | AAC 48 kHz | 8 Mbps / 6 Mbps — deployment defaults | none | youtube encoding table (geometry basis) |

Encoding pipeline (§6): scale preserving aspect → pad to the profile canvas (NO crop/stretch of creator content) → `fps=<profile>` → libx264 `-profile:v high -pix_fmt yuv420p -b:v <profile> -maxrate/-bufsize` → AAC re-encode to the profile spec → `-movflags +faststart`. A silent master yields a silent output (`-an`, disclosed in the variant summary). Post-encode ffprobe conformance checks: dimensions, video codec, audio codec, sample rate, fps tolerance (±0.6), duration cap (where encoded).

**Honest note on M8.1 brief caps:** the M8.1 Studio's brief-level caps (Shorts 60 s, Reels 90 s, TikTok 180 s) are the Studio's own conservative production limits and remain unchanged (M1–M8.1 regression safety). M9's export-profile registry is the authoritative export-side validation layer and encodes ONLY verified rules.

## 5. Thumbnail generation workflow (LAXII)

1. `POST /api/publish/thumbnails` ensures a `(project, platform)` draft; thumbnail geometry derives from the profile (e.g. YouTube landscape cover 1280×720; vertical platforms keep the 1080×1920 canvas).
2. `POST …/generate` enqueues `PUBLISH_THUMBNAIL`: the LAXII provider generates 1–4 alternatives at the CLOSEST SUPPORTED size (ratio-mapped: 16:9→1344×768, 9:16→768×1344, 1:1→1024×1024) from a prompt built from REAL project context (studio topic + script essence + user direction) with an explicit "NO text/letters/words" instruction — the title is composited later so it stays editable; asking the model to bake text in would produce uneditable, often misspelled lettering.
3. Every alternative is registered as an IMAGE `MediaAsset` with full provenance (`createdBy=LAXII`, provider, model, prompt, params incl. `purpose=publish-thumbnail`, license/attribution, `referenceAssetId` when image-to-image was used).
4. The user selects a base (candidate or any OWNED uploaded image), edits the overlay (`layoutJson`: title text, position, align, font scale, text/accent colours, band/box backdrop + opacity, shadow), and `POST …/composite` renders it server-side (PIL + raqm — real Tamil shaping via the bundled Noto Sans Tamil font; auto-detected Tamil script) cover-cropped to the exact platform dims → registered as a NEW asset (`provider=publish-compositor`, `referenceAssetId=<base>`). Regeneration and re-compositing NEVER overwrite previous selections — every output is a new row.
5. Capabilities reported honestly: the z-ai image provider supports text-to-image and image-to-image; per-layer image editing, negative prompts and explicit seeds are NOT supported (surfaced via the provider's capability list and the UI note). The overlay is a real text layer — nothing more is claimed.

## 6. Metadata generation workflow (MY AI)

`generatePublishFields(userId, projectId, platform, language, opts)`:

1. Gathers REAL context — project name/description, latest Studio plan (topic, full script, per-scene narration + on-screen text), and existing approved metadata. Private media never leaves the server (text only).
2. One schema-validated LLM call (`chatValidated`, temperature 0.6, informed repair on validation failure) produces: title, description, keywords, hashtags, chapters, summary, platform-specific description, CTA. The system prompt enforces: user's language (en/ta) and intent preserved; NO invented facts/sources/links; chapters ONLY from verified timing.
3. **Chapters honesty guard:** chapter timestamps are derived ONLY from explicit Studio scene durations (cumulative starts, `chaptersSource: "studio-scene-timings"`). Without a plan with timed scenes the chapters array is FORCED EMPTY (`chaptersSource: "none"`) — fabricated timestamps are stripped even if the model returned them (tested).
4. `seedApproved` (existing approved fields) always wins over regenerated values — AI suggestions never silently replace user-approved content.
5. Per-field regeneration (`regeneratePublishField`) is a targeted single-field call validated against the same schema; the draft records per-field model provenance and a bounded history (last 20 events).
6. AI suggestions (`draftJson`) and USER-APPROVED metadata (`approvedJson`, validated by `PublishFieldsSchema` at the boundary) are stored separately and never conflated; packaging requires APPROVED.
7. Provider unavailable → typed `LLMError` (e.g. `NOT_CONFIGURED`) → 503 with `unavailable: true`. No fake results, ever (tested).

## 7. Brand presets

CRUD + duplicate + delete via `/api/publish/presets*`; asset references are ownership-checked. **Application is additive-merge ONLY**: the preset writes exactly the keys it owns (`brand`, `captionStyle`, `thumbnailStyle`, `defaultExportProfile`, `watermarkAssetId`) into `project.settingsJson`; everything else already there (custom widths, user flags, fps…) survives untouched. `GET …/apply?projectId=` returns a preview (current settings, merged settings, `keysWritten`, `keysPreserved`) with NO writes; `POST …/apply` requires an explicit `{"confirm":"apply"}`; every apply records `AutomationAudit` with the previous settings snapshot, and `DELETE …/apply` reverts to it (audit-backed undo). Previously approved project content is never silently modified (tested, including the revert round-trip).

## 8. Publication package format and manifest

`PUBLISH_PACKAGE` (durable job) packages ONLY: completed variant outputs, the selected/composited thumbnail, and USER-APPROVED metadata. Layout:

```
manifest.json                      — the manifest (below)
metadata.json                      — approved fields + platform/language + approvedAt (only if referenced)
videos/<profileId>.mp4             — one per completed variant
thumbnail/<platform>.jpg|png       — composited (or base) thumbnail (only if referenced)
```

`manifest.json` (schemaVersion 1) contains: packageId, project ref, platform, per-variant profile id + version + the EXACT profile JSON used, metadata status block (`USER-APPROVED` or `NOT-INCLUDED` + note), thumbnail block, an ordered `files[]` (path, bytes, **sha256**, purpose, sourceRef) and an explicit `exclusions` block (private source media / credentials / internal files — excluded by policy). `PublishPackage.manifestSha256` records the sha256 of `manifest.json` for integrity checking; the download endpoint streams the zip with that header.

Determinism: the zip writer (`src/lib/publish/zip.ts`, stored mode, fixed DOS timestamps, sorted entries, CRC-32/IEEE) produces byte-identical archives for identical inputs (tested); manifests sort files and use fixed key order. Bounds: total input > 800 MB is refused honestly (memory-bounded builder); packages contain no private source media, credentials or unrelated assets (verified in tests: the source-media path never appears in the manifest).

## 9. Export lifecycle, history & management (§8) — and publishing-integration status (§9)

**Lifecycle:** variant create → pre-flight (real ffprobe + profile validation; 422 with typed failures) → durable `EXPORT_VARIANT` job (QUEUED → RENDERING with real ffmpeg progress → COMPLETED | FAILED | CANCELLED) → ffprobe conformance report stored on the row → result ExportFile downloadable. History: every variant keeps its profile evidence, attempts, validation and error; retry (failed/queued) and cancel (queued/rendering, job + row both CANCELLED) are ownership-checked; previous successful exports are NEVER deleted when new variants are built; the original timeline and source media are never modified (verified byte-path in tests).

**Publishing integrations — investigated, honestly NOT operational.** Official-API investigation (2026-11-13):

| Platform | API | Requirements found | Status here |
|---|---|---|---|
| YouTube | Data API `videos.insert` (OAuth 2.0, quota-costed) | OAuth client + API enablement; upload quota historically 1600 units/day of 10 000 (≈6 uploads/day) — costs change, verify at integration time | **not-configured** — no OAuth client exists in this deployment; no upload button is offered |
| Instagram | Content Publishing API (two-step container flow, 100 posts/24 h, public `video_url` hosting) | Business/Creator account + app review (Advanced Access) + `instagram_business_content_publish` (IG login) or `instagram_content_publish` (FB login); containers expire in 24 h | **not-configured** |
| TikTok | Content Posting API direct post (chunk upload, `video.publish` scope, init 6 req/min, caption ≤2200 UTF-16 runes, `is_aigc` flag) | Unaudited clients are restricted to PRIVATE viewing only; public posting requires TikTok's audit | **not-configured** |

`GET /api/publish/status` reports each as `operational: false, status: "not-configured"` with the reason and doc link; the UI offers the publication-ready export/package workflow instead. There are NO fake publishing buttons and no simulated uploads anywhere. The provider-independent design (one gateway interface per engine) is the same seam these integrations would plug into later; tokens, when they ever exist, would be server-side only — no token handling ships now.

## 10. Security and privacy

Session auth on every route; every row read/write is ownership-checked (tested with a foreign user). FFmpeg/CLI invocations take NO client text — clients pass ids; the server derives everything from validated profiles and its own measurements (no arbitrary shell execution; the thumbnail compositor runs a FIXED python program with parsed-JSON args). Provider secrets stay server-side (`redactSecrets` scrubbing inherited from the gateway). Packages exclude private source media, credentials and internal files by construction and disclosure. Thumbnails/metadata preserve provenance (provider, model, prompt, params, attribution). No Ollama anywhere.

## 11. Provider requirements

- **MY AI metadata**: a configured `BEANFX_MYAI_PROVIDER` (`zai` verified live). Unconfigured → honest 503/unavailable state.
- **LAXII thumbnails**: the configured image provider CLI (`BEANFX_ZAI_BIN`, default `z-ai`). Sizes are the provider's 7 verified sizes; unsupported features (per-layer editing, negative prompts, seeds, transparency) are reported honestly.
- **Export variants / packages**: ffmpeg/ffprobe on the server + the M3 worker (no external API).
- **Publishing integrations**: would require OAuth clients/app-review per platform (§9) — none configured.

## 12. Known limitations (honest)

- Publishing/upload integrations do NOT exist (§9) — the workflow ends at publication-ready packages.
- Instagram Reels / TikTok organic duration caps are intentionally NOT encoded (no verified authoritative numbers; configurable via `BEANFX_EXPORT_PROFILES_JSON`). Instagram/TikTok bitrates are deployment defaults, labelled as such.
- Non-YouTube profile bitrates and the fixed 30 fps profile rate are deployment choices; source-rate matching (YouTube's recommendation) happens via the sequence fps, not per-variant fps selection in the UI.
- Thumbnail generation depends on the configured image provider (≈40 s/image observed); LAXII cannot do per-layer image editing — the overlay is a server-side text layer (Tamil shaping verified; other complex scripts untested).
- Packaging buffers files in memory (800 MB input cap); packages do not count against the storage quota (documented accounting choice).
- Variant encoding is single-pass `-b:v` targeting (no 2-pass/CRF UI); fps normalization is to the profile rate.
- E2E runs used a 2 s 320×180 fixture upscaled to 1920×1080 — long-form encodes run through the same plan builder with the worker's 45-min budget (not load-tested; no capacity claims).

## 13. Testing evidence (executed 2026-11-13)

| Suite | Result |
|---|---|
| `scripts/test-publish-core.test.ts` (fixture/engine, isolated DB, INJECTED stub providers — labeled) | **27/27** — registry + verified facts + env override; pre/post validation; args builder; EN/TA schema + generation; fabricated-chapters stripping; scene-timing chapters; seedApproved protection; per-field regen; NOT_CONFIGURED honesty; preset validate/preview/apply/revert/additive-merge/ownership; LAXII size mapping; EN+TA overlay compositing at exact dims; composite registration + provenance; **REAL end-to-end variant through the worker (1920×1080, h264/aac-48k conformance)**; duration-cap pre-encode refusal; cancel path; deterministic zip (byte-identical, `zipfile.testzip` verified); **REAL package build (manifest sha256 per file, USER-APPROVED-only metadata, no source paths)**; unapproved-metadata refusal; ownership + recovery |
| `scripts/test-publish-live.test.ts` (REAL providers, clearly separated) | **5/5 live** — real LLM health; real EN metadata (glm-4-plus); real TA metadata (Tamil preserved); real chapters from scene timings [0, 20]; real LAXII thumbnail registered 768×1344 with `publish-thumbnail` provenance |
| Full matrix `scripts/run-all-tests.sh` (M1–M8.1 + M9) | **20 suites, 0 failures** |
| End-to-end HTTP (`scripts/m9-e2e-verify.sh`, live server, real providers) | **28/28** — profiles(7) · preset create/duplicate/delete/preview/apply/revert · upload · LAXII generate+select+composite · LLM metadata+approve · variant queued→COMPLETED+conformance · package READY (2.0 MB zip; manifest sha256 verified; USER-APPROVED only) · honest status · 401 without session |
| Browser verification | Editor mounted with the Publishing panel; Thumbnail tab renders platform select, geometry note, overlay controls and honest capability notes (screenshot taken via headless browser) |
| Gates | `tsc --noEmit` clean · `eslint src --max-warnings=0` clean (repo-wide run flags 12 PRE-EXISTING errors in old probe scripts under `scripts/` — untouched by M9) · `prisma validate` ✓ · `prisma db push` applied · production build ✓ (all `/api/publish/*` routes present) · secret scan clean at push |

Fixture vs live: the core suite uses REAL engine code with labeled fixtures and injected stub providers; the live suite and E2E ran against the REAL configured LLM + image providers and are reported as such. No mocked response is presented as provider verification. No production-readiness or capacity claims are made.

## 14. Files delivered

`src/lib/publish/{profiles,variants,metadata,thumbnails,presets,jobs,zip}.ts` · `src/app/api/publish/**` (15 routes) · `src/components/bean/editor/publishing-panel.tsx` + `editor.tsx` mount · `src/lib/job-helpers.ts` / `src/lib/media-worker.ts` (3 job types) · `src/lib/my-ai/gateway/structured.ts` (additive provider seam) · `prisma/schema.prisma` (5 models) · `scripts/test-publish-core.test.ts`, `scripts/test-publish-live.test.ts`, `scripts/m9-e2e-verify.sh`, `scripts/run-all-tests.sh` (+1 suite) · `docs/M9_PROFESSIONAL_PUBLISHING.md`.
