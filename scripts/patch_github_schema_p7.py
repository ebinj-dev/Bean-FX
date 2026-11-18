#!/usr/bin/env python3
"""Apply the M3 (p7) schema additions to the GITHUB clone's schema.prisma.

Why not overlay: GitHub's schema.prisma carries refined content from M1
(explicit cascade relations on CutDecision, richer comments) that the local
working copy does not have. This script anchors on lines that exist in BOTH
versions and inserts exactly the M3 blocks, with pre- and post-conditions.

Usage: python3 patch_github_schema_p7.py /tmp/beanfx-push-m3
"""
import sys
from pathlib import Path

SCHEMA = Path(sys.argv[1]) / "prisma" / "schema.prisma"
src = SCHEMA.read_text()

M3_MEDIA_ASSET_FIELDS = """
  // ── M3 media pipeline (all additive, backfilled to NULL for legacy rows) ──
  /// Content hash of the original file (hex sha256) — dedup + integrity.
  sha256          String?
  /// PENDING | PROCESSING | READY | FAILED — deep ffprobe runs in the worker,
  /// never in the upload request. NULL = legacy asset or SUBTITLE.
  probeStatus     String?
  probeError      String?
  /// Full ffprobe format+streams summary (trimmed JSON) from the deep probe.
  probeMetaJson   String?
  /// True when r_frame_rate and avg_frame_rate diverge (variable frame rate).
  isVfr           Boolean?
  /// Display-matrix rotation in degrees (0 = unrotated).
  rotation        Int?
  /// ffprobe display_aspect_ratio (e.g. "16:9").
  aspectRatio     String?
  /// Video stream time_base (e.g. "1/90000").
  timeBase        String?
  /// ffprobe format_name (e.g. "mov,mp4,m4a,3gp,3g2,mj2").
  formatName      String?
  /// Overall bit rate in bits/s.
  bitRate         Int?
  /// NONE | QUEUED | PROCESSING | READY | FAILED | UNSUPPORTED — editing
  /// proxies live in media-store/proxies; exports always use the original.
  proxyStatus       String?
  proxyPath         String?
  proxySizeBytes    Int?
  proxyDurationSec  Float?
  proxyError        String?

  @@index([userId, sha256])"""

M3_JOB_FIELDS = """
  // ── M3 worker fields (additive; legacy job types ignore them) ──
  /// Completed claim attempts. One attempt = one claim; retries re-queue with backoff.
  attempts        Int      @default(0)
  /// Maximum claims before the job is FAILED permanently.
  maxAttempts     Int      @default(3)
  /// Earliest time the worker may claim this job (retry backoff).
  runAfter        DateTime?
  /// Worker liveness marker — stale heartbeats trigger recovery.
  lastHeartbeatAt DateTime?
  /// When the current claim started (lease start, for stale-claim detection).
  claimedAt       DateTime?
  /// Hard wall-clock limit for this job's handler (seconds).
  timeoutSec      Int?"""

M3_UPLOAD_SESSION_MODEL = """
/// Server-side bookkeeping for one resumable chunked upload (M3). Chunks land
/// in media-store/tmp/up_{id}/ as per-index part files; the row tracks what
/// arrived so a client can resume after any interruption. Abandoned sessions
/// are swept (scratch removed) — assembled originals are never touched.
model UploadSession {
  id            String   @id // client-generated upload id (hex), shared by all chunks
  userId        String
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  originalName  String
  ext           String
  kind          String // VIDEO | AUDIO | SUBTITLE (from extension allowlist)
  declaredSize  BigInt // client-declared total byte count
  chunkSize     Int
  chunkTotal    Int
  receivedCount Int      @default(0)
  /// OPEN | COMPLETED | FAILED | CANCELLED
  status        String   @default("OPEN")
  /// Optional client-declared checksum, verified against the assembled bytes.
  sha256        String?
  mediaAssetId  String? // set when the session produced an asset
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  lastChunkAt   DateTime @default(now())

  @@index([userId, status])
  @@index([lastChunkAt])
}
"""

# ── preconditions ────────────────────────────────────────────────────────────
for token in ["sha256", "proxyStatus", "attempts", "claimedAt", "model UploadSession"]:
    if token in src:
        print(f"FAIL precondition: {token} already present in schema.prisma — nothing to apply")
        sys.exit(1)
for anchor in [
    "  wordsToRemove WordsToRemove[]",
    "  exportFiles  ExportFile[]",
    "  exportId   String?",
    "// AUDIO_PROCESS | AUTOCUT_APPLY | WATERMARK | BURN_CAPTIONS",
]:
    if anchor not in src:
        print(f"FAIL precondition: anchor missing from schema.prisma: {anchor!r}")
        sys.exit(1)

# ── apply ────────────────────────────────────────────────────────────────────
src = src.replace(
    "  wordsToRemove WordsToRemove[]",
    "  wordsToRemove WordsToRemove[]\n  uploadSessions UploadSession[]",
    1,
)
src = src.replace(
    "// AUDIO_PROCESS | AUTOCUT_APPLY | WATERMARK | BURN_CAPTIONS",
    "// AUDIO_PROCESS | AUTOCUT_APPLY | WATERMARK | BURN_CAPTIONS | MEDIA_PROBE | MEDIA_PROXY",
    1,
)
# MediaAsset: fields + index before the closing brace of that model.
media_block_start = src.index("model MediaAsset {")
media_block_end = src.index("}", src.index("exportFiles  ExportFile[]", media_block_start))
src = src[:media_block_end] + M3_MEDIA_ASSET_FIELDS + "\n" + src[media_block_end:]
# Job: worker fields before createdAt.
job_anchor = src.index("  exportId   String?")
insert_at = src.index("\n", job_anchor) + 1
src = src[:insert_at] + M3_JOB_FIELDS + "\n" + src[insert_at:]
# UploadSession model appended at the end.
if not src.endswith("\n"):
    src += "\n"
src += M3_UPLOAD_SESSION_MODEL

# ── postconditions ───────────────────────────────────────────────────────────
required = [
    "uploadSessions UploadSession[]",
    "sha256          String?",
    "proxyDurationSec  Float?",
    "@@index([userId, sha256])",
    "attempts        Int      @default(0)",
    "timeoutSec      Int?",
    "model UploadSession {",
    "MEDIA_PROBE | MEDIA_PROXY",
]
missing = [t for t in required if t not in src]
if missing:
    print(f"FAIL postcondition: missing after apply: {missing}")
    sys.exit(1)
model_count = src.count("\nmodel ")
if model_count != 12:  # 11 existing + UploadSession
    print(f"FAIL postcondition: model count is {model_count}, expected 12")
    sys.exit(1)

SCHEMA.write_text(src)
print("p7 schema patch applied and verified (12 models, all M3 blocks present)")
