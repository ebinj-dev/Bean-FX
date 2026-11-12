import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import { createWriteStream, createReadStream, promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import {
  MEDIA_ROOT,
  MAX_UPLOAD_BYTES,
  MAX_CHUNKED_BYTES,
  ensureMediaRoot,
  safeExt,
  classifyByExtension,
  getFreeDiskBytes,
  removeFileQuiet,
  sniffContainer,
  sniffMatchesClass,
  sha256File,
  hasQuotaFor,
} from "@/lib/media-storage";
import { enqueueMediaJob, JOB_TYPE_MEDIA_PROBE } from "@/lib/job-helpers";
import { parseSrt } from "@/lib/srt";
import { pipeline, finished } from "stream/promises";

export const runtime = "nodejs";
export const maxDuration = 300;

const MB = 1024 * 1024;
/**
 * Orphaned chunk upload scratch TTLs. The parts of an OPEN session survive
 * 24 h (the resume window — matches the worker's abandonment sweep); assembled
 * scratch is transient and gets 6 h. Originals are never GC'd.
 */
const STALE_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_ASSEMBLED_TTL_MS = 6 * 60 * 60 * 1000;
const UPLOAD_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Deliberately cancel an unread request body (e.g. auth/4xx rejections while
 * the client is still uploading). Without this the aborted web stream races
 * its adapter and surfaces as an uncaught exception in the server.
 */
async function discardBody(req: NextRequest) {
  try {
    await req.body?.cancel();
  } catch {
    // already closed/cancelled — nothing to do
  }
}

/** Accurate status per failure class instead of a uniform 400. */
function errorStatus(message: string): number {
  const m = message.toLowerCase();
  if (m.includes("upload incomplete") || m.includes("empty request body") || m.includes("chunk incomplete")) return 400;
  if (m.includes("quota") || m.includes("larger than the")) return 413;
  if (
    m.includes("no audio or video") ||
    m.includes("invalid data") ||
    m.includes("could not be read") ||
    m.includes("moov atom") ||
    m.includes("does not match its extension") ||
    m.includes("unrecognized file content") ||
    m.includes("cannot be used as audio")
  ) {
    return 415;
  }
  return 500;
}

/**
 * Deterministic upload failures where retrying cannot succeed (bad content,
 * quota). The session is marked FAILED and scratch is cleared; anything else
 * keeps parts on disk so the client can resume.
 */
class PermanentUploadError extends Error {}

type UploadIdentity = {
  originalName: string;
  ext: string;
  kind: ReturnType<typeof classifyByExtension>;
  role: "BROLL" | null;
  notes: string | null;
};

/** Shared request-identity parsing: header decoding + name/extension/type rules. */
function parseIdentity(req: NextRequest): { identity: UploadIdentity } | { error: NextResponse } {
  // Header values are ISO-8859-1 on the wire: the client percent-encodes the
  // file name (and notes) so spaces and non-ASCII survive; decode them back.
  const decodeHeader = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  const originalName = decodeHeader((req.headers.get("x-filename") ?? "").trim());
  const role = req.headers.get("x-role") === "BROLL" ? "BROLL" : null;
  const notes = decodeHeader((req.headers.get("x-notes") ?? "")).slice(0, 500) || null;

  if (!originalName || originalName.includes("/") || originalName.includes("\\") || originalName.includes("..")) {
    return { error: jsonError("Invalid file name.", 400) };
  }
  const ext = safeExt(originalName);
  if (!ext) {
    return { error: jsonError("File has no usable extension.", 400) };
  }
  const kind = classifyByExtension(ext);
  if (kind === "UNSUPPORTED") {
    return {
      error: jsonError(
        `Unsupported file type "${ext}". Supported: MP4, MOV, WebM, MKV, MP3, WAV, M4A, AAC, FLAC, OGG, SRT.`,
        415
      ),
    };
  }
  return { identity: { originalName, ext, kind, role, notes } };
}

/** sha256 declared by the client, validated shape only (optional integrity hint). */
function declaredSha256(req: NextRequest): string | null {
  const declared = (req.headers.get("x-sha256") ?? "").trim().toLowerCase();
  return SHA256_RE.test(declared) ? declared : null;
}

/** Response shape for a finalized asset (probe results arrive async via the worker). */
function mediaResponse(
  asset: {
    id: string;
    originalName: string;
    kind: string;
    mimeType: string;
    sizeBytes: number;
    durationSec: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    videoCodec: string | null;
    audioCodec: string | null;
    sampleRate: number | null;
    channels: number | null;
    probeStatus: string | null;
    proxyStatus: string | null;
    role: string | null;
    notes: string | null;
    createdAt: Date;
  },
  extra: Record<string, unknown> = {}
) {
  return NextResponse.json({
    media: {
      id: asset.id,
      originalName: asset.originalName,
      kind: asset.kind,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      durationSec: asset.durationSec,
      width: asset.width,
      height: asset.height,
      fps: asset.fps,
      videoCodec: asset.videoCodec,
      audioCodec: asset.audioCodec,
      sampleRate: asset.sampleRate,
      channels: asset.channels,
      probeStatus: asset.probeStatus,
      proxyStatus: asset.proxyStatus,
      role: asset.role,
      notes: asset.notes,
      createdAt: asset.createdAt.toISOString(),
    },
    ...extra,
  });
}

/**
 * Validate (content sniffing + checksum), store, dedup, and enqueue analysis.
 * No ffprobe here — deep inspection runs in the background worker (M3.4), so
 * the upload request only does cheap, bounded work regardless of file size.
 */
async function finalizeUpload(
  userId: string,
  identity: UploadIdentity,
  tmpPath: string,
  uploadId: string | null
): Promise<NextResponse> {
  // Subtitle references (SRT) are parsed, not probed: a valid cue list IS the
  // validation. Original text and timestamps are preserved verbatim.
  if (identity.kind === "SUBTITLE") {
    const content = await fs.readFile(tmpPath, "utf8").catch(() => null);
    if (content === null) throw new PermanentUploadError("Subtitle file could not be read.");
    const parsed = parseSrt(content);
    if (!parsed.cues.length) {
      throw new PermanentUploadError(`Invalid SRT: ${parsed.errors[0] ?? "no valid cues found"}.`);
    }
    const stat = await fs.stat(tmpPath);
    const sha = await sha256File(tmpPath);
    const finalName = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${identity.ext}`;
    const finalPath = path.join(MEDIA_ROOT, "originals", finalName);
    await fs.rename(tmpPath, finalPath);

    const lastEnd = Math.max(...parsed.cues.map((c) => c.end));
    const asset = await db.mediaAsset.create({
      data: {
        userId,
        originalName: identity.originalName.slice(0, 200),
        storagePath: finalPath,
        kind: "SUBTITLE",
        mimeType: "application/x-subrip",
        sizeBytes: stat.size,
        durationSec: lastEnd,
        sha256: sha,
        probeStatus: "READY", // fully validated by the cue parse — nothing to probe
        notes: identity.notes,
      },
    });
    if (uploadId) {
      await db.uploadSession
        .updateMany({ where: { id: uploadId, userId, status: "OPEN" }, data: { status: "COMPLETED", mediaAssetId: asset.id } })
        .catch(() => undefined);
    }
    return mediaResponse(asset, { srt: { cueCount: parsed.cues.length, parseErrors: parsed.errors.slice(0, 10) } });
  }

  const stat = await fs.stat(tmpPath);
  if (stat.size <= 0) throw new PermanentUploadError("Empty request body.");

  // Content identity from the file's own bytes — never the client's claims.
  const head = Buffer.alloc(32);
  const fh = await fs.open(tmpPath, "r");
  try {
    await fh.read(head, 0, head.length, 0);
  } finally {
    await fh.close();
  }
  const sniff = sniffContainer(head);
  if (sniff.family === "unknown") {
    throw new PermanentUploadError("Unrecognized file content — not a known media container.");
  }
  if (identity.kind !== "AUDIO" && identity.kind !== "VIDEO") {
    throw new PermanentUploadError("Unsupported file class.");
  }
  if (!sniffMatchesClass(sniff, identity.kind)) {
    throw new PermanentUploadError(
      `File content (${sniff.family}) does not match its extension ("${identity.ext}").`
    );
  }

  const sha = await sha256File(tmpPath);

  // Duplicate upload: same user + same bytes → reuse the stored original.
  // No second copy is written, and the original is never overwritten.
  const existing = await db.mediaAsset.findFirst({
    where: { userId, sha256: sha, kind: { in: ["AUDIO", "VIDEO"] } },
    orderBy: { createdAt: "asc" },
  });
  if (existing && (await fs.stat(existing.storagePath).then(() => true).catch(() => false))) {
    await removeFileQuiet(tmpPath);
    const asset = await db.mediaAsset.create({
      data: {
        userId,
        originalName: identity.originalName.slice(0, 200),
        storagePath: existing.storagePath,
        kind: existing.kind,
        mimeType: existing.mimeType,
        sizeBytes: stat.size,
        durationSec: existing.durationSec,
        width: existing.width,
        height: existing.height,
        fps: existing.fps,
        videoCodec: existing.videoCodec,
        audioCodec: existing.audioCodec,
        sampleRate: existing.sampleRate,
        channels: existing.channels,
        sha256: sha,
        probeStatus: existing.probeStatus, // same content → same analysis applies
        probeMetaJson: existing.probeMetaJson,
        probeError: existing.probeError,
        isVfr: existing.isVfr,
        rotation: existing.rotation,
        aspectRatio: existing.aspectRatio,
        timeBase: existing.timeBase,
        formatName: existing.formatName,
        bitRate: existing.bitRate,
        proxyStatus: existing.proxyStatus,
        proxyPath: existing.proxyPath,
        proxySizeBytes: existing.proxySizeBytes,
        proxyDurationSec: existing.proxyDurationSec,
        role: identity.role,
        notes: identity.notes,
      },
    });
    if (uploadId) {
      await db.uploadSession
        .updateMany({ where: { id: uploadId, userId, status: "OPEN" }, data: { status: "COMPLETED", mediaAssetId: asset.id } })
        .catch(() => undefined);
    }
    return mediaResponse(asset, { deduplicated: true, reusedAssetId: existing.id });
  }

  const quota = await hasQuotaFor(userId, stat.size);
  if (!quota.ok) {
    throw new PermanentUploadError(
      `Storage quota exceeded: ${(quota.usedBytes / 1e9).toFixed(2)} GB used of ${(quota.quotaBytes / 1e9).toFixed(2)} GB, ` +
        `this file needs ${(stat.size / 1e9).toFixed(2)} GB. Remove unused media and try again.`
    );
  }

  const free = await getFreeDiskBytes();
  // Peak usage: original + proxy + processing scratch (2x) — require 3x headroom.
  if (free < stat.size * 3) {
    throw new Error(
      `Insufficient server storage. Need ~${((stat.size * 3) / 1e9).toFixed(2)} GB headroom, ${(free / 1e9).toFixed(2)} GB available.`
    );
  }

  const finalName = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${identity.ext}`;
  const finalPath = path.join(MEDIA_ROOT, "originals", finalName);
  await fs.rename(tmpPath, finalPath);

  const asset = await db.mediaAsset.create({
    data: {
      userId,
      originalName: identity.originalName.slice(0, 200),
      storagePath: finalPath,
      kind: identity.kind,
      mimeType: sniff.mime ?? "application/octet-stream",
      sizeBytes: stat.size,
      sha256: sha,
      probeStatus: "PENDING",
      proxyStatus: "NONE",
      role: identity.role,
      notes: identity.notes,
    },
  });

  // Deep analysis + proxy decision run in the durable worker, never here.
  await enqueueMediaJob(userId, JOB_TYPE_MEDIA_PROBE, { mediaId: asset.id });

  if (uploadId) {
    await db.uploadSession
      .updateMany({ where: { id: uploadId, userId, status: "OPEN" }, data: { status: "COMPLETED", mediaAssetId: asset.id } })
      .catch(() => undefined);
  }
  return mediaResponse(asset, { deduplicated: false });
}

/** Remove orphaned upload scratch (files and dirs) older than their TTLs. */
async function gcStaleUploads() {
  const tmpDir = path.join(MEDIA_ROOT, "tmp");
  let entries: string[];
  try {
    entries = await fs.readdir(tmpDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith("up_") && !entry.startsWith("asm_")) continue;
    const p = path.join(tmpDir, entry);
    try {
      const st = await fs.stat(p);
      const ttl = entry.startsWith("up_") ? STALE_UPLOAD_TTL_MS : STALE_ASSEMBLED_TTL_MS;
      if (now - st.mtimeMs > ttl) {
        await fs.rm(p, { recursive: true, force: true });
      }
    } catch {
      // raced with another cleanup — ignore
    }
  }
}

/** Upsert the resumable-upload session row, enforcing ownership and parameters. */
async function openUploadSession(
  userId: string,
  uploadId: string,
  identity: UploadIdentity,
  chunkTotal: number,
  totalSize: number,
  firstChunkSize: number,
  sha: string | null
): Promise<{ ok: true } | { ok: false; error: NextResponse }> {
  const existing = await db.uploadSession.findUnique({ where: { id: uploadId } });
  if (existing) {
    if (existing.userId !== userId) {
      return { ok: false, error: jsonError("Upload session not found.", 404) };
    }
    if (existing.status !== "OPEN") {
      return {
        ok: false,
        error: NextResponse.json(
          {
            error:
              existing.status === "COMPLETED" && existing.mediaAssetId
                ? `Upload already completed (media ${existing.mediaAssetId}).`
                : `Upload session is ${existing.status} and cannot accept chunks.`,
            ...(existing.mediaAssetId ? { mediaAssetId: existing.mediaAssetId } : {}),
          },
          { status: 409 }
        ),
      };
    }
    if (existing.chunkTotal !== chunkTotal || Number(existing.declaredSize) !== totalSize || existing.ext !== identity.ext) {
      return { ok: false, error: jsonError("Upload session parameters changed mid-upload — restart the upload.", 400) };
    }
    return { ok: true };
  }
  try {
    await db.uploadSession.create({
      data: {
        id: uploadId,
        userId,
        originalName: identity.originalName.slice(0, 200),
        ext: identity.ext,
        kind: identity.kind,
        declaredSize: BigInt(totalSize),
        chunkSize: firstChunkSize,
        chunkTotal,
        status: "OPEN",
        ...(sha ? { sha256: sha } : {}),
      },
    });
    return { ok: true };
  } catch (err) {
    // Unique violation: another chunk of the same session won the race.
    if ((err as { code?: string }).code === "P2002") return { ok: true };
    throw err;
  }
}

async function touchSession(uploadId: string, userId: string): Promise<void> {
  await db.uploadSession.updateMany({
    where: { id: uploadId, userId },
    data: { lastChunkAt: new Date() },
  });
}

async function countReceivedParts(partsDir: string): Promise<number> {
  const entries = await fs.readdir(partsDir).catch(() => [] as string[]);
  return entries.filter((f) => f.endsWith(".part")).length;
}

/**
 * Chunked upload path: resumable, per-index part files (idempotent,
 * order-tolerant), server-tracked session state so the client can recover
 * from any interruption. Validation and storage are identical to the
 * single-shot path. Parts are kept on transient failures; deterministic
 * content failures clear scratch and mark the session FAILED.
 */
async function handleChunkedUpload(req: NextRequest, user: { id: string }): Promise<NextResponse> {
  const parsed = parseIdentity(req);
  if ("error" in parsed) {
    await discardBody(req);
    return parsed.error;
  }
  const identity = parsed.identity;

  const uploadId = (req.headers.get("x-upload-id") ?? "").trim();
  const chunkIndex = Number(req.headers.get("x-chunk-index") ?? "-1");
  const chunkTotal = Number(req.headers.get("x-chunk-total") ?? "0");
  const totalSize = Number(req.headers.get("x-upload-size") ?? "0");
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  const clientChunkSize = Number(req.headers.get("x-chunk-size") ?? "0");
  const sha = declaredSha256(req);

  if (!UPLOAD_ID_RE.test(uploadId) || !Number.isInteger(chunkIndex) || !Number.isInteger(chunkTotal) || chunkTotal < 1 || chunkIndex < 0 || chunkIndex >= chunkTotal) {
    await discardBody(req);
    return jsonError(!UPLOAD_ID_RE.test(uploadId) ? "Invalid upload id." : "Invalid chunk index or total.", 400);
  }
  if (!totalSize || totalSize <= 0 || !Number.isSafeInteger(totalSize)) {
    await discardBody(req);
    return jsonError("Missing upload size (x-upload-size).", 400);
  }
  if (totalSize > MAX_CHUNKED_BYTES) {
    await discardBody(req);
    return jsonError(`File is larger than the ${(MAX_CHUNKED_BYTES / MB / MB).toFixed(0)} GB chunked upload limit.`, 413);
  }
  if (!contentLength || contentLength <= 0) {
    await discardBody(req);
    return jsonError("Missing chunk size (Content-Length).", 400);
  }
  if (contentLength > MAX_UPLOAD_BYTES) {
    await discardBody(req);
    return jsonError(`Chunk is larger than the ${(MAX_UPLOAD_BYTES / MB).toFixed(0)} MB per-request limit.`, 413);
  }

  const session = await openUploadSession(user.id, uploadId, identity, chunkTotal, totalSize, contentLength, sha);
  if (!session.ok) {
    await discardBody(req);
    return session.error;
  }

  await ensureMediaRoot();
  const partsDir = path.join(MEDIA_ROOT, "tmp", `up_${uploadId}`);
  const partPath = path.join(partsDir, `${String(chunkIndex).padStart(6, "0")}.part`);
  const assembledPath = path.join(MEDIA_ROOT, "tmp", `asm_${uploadId}`);

  try {
    await fs.mkdir(partsDir, { recursive: true });
    void gcStaleUploads();

    // Quota is checked against the declared size once per session and
    // re-checked at assembly — reservations stay honest without per-chunk scans.
    const quota = await hasQuotaFor(user.id, totalSize);
    if (!quota.ok) {
      throw new PermanentUploadError(
        `Storage quota exceeded: ${(quota.usedBytes / 1e9).toFixed(2)} GB used of ${(quota.quotaBytes / 1e9).toFixed(2)} GB, ` +
          `this upload needs ${(totalSize / 1e9).toFixed(2)} GB.`
      );
    }

    if (!req.body) throw new Error("Empty request body.");
    await pipeline(Readable.fromWeb(req.body as import("stream/web").ReadableStream), createWriteStream(partPath));
    const partStat = await fs.stat(partPath);
    if (partStat.size !== contentLength) {
      await removeFileQuiet(partPath);
      throw new Error(`Chunk incomplete: received ${partStat.size} of ${contentLength} bytes.`);
    }
    // Optional strict integrity: the client declares its chunk size, so every
    // part except the final one must be exactly that size.
    if (clientChunkSize > 0 && chunkIndex < chunkTotal - 1 && partStat.size !== clientChunkSize) {
      await removeFileQuiet(partPath);
      throw new Error(`Chunk size mismatch: expected ${clientChunkSize} bytes, received ${partStat.size}.`);
    }

    await touchSession(uploadId, user.id);
    const receivedCount = await countReceivedParts(partsDir);
    await db.uploadSession.updateMany({ where: { id: uploadId, userId: user.id }, data: { receivedCount } });


    if (chunkIndex < chunkTotal - 1) {
      return NextResponse.json({ partial: true, received: receivedCount, total: chunkTotal });
    }

    // Final chunk: verify the complete set, then assemble in index order.
    const missing: number[] = [];
    for (let i = 0; i < chunkTotal; i++) {
      try {
        await fs.stat(path.join(partsDir, `${String(i).padStart(6, "0")}.part`));
      } catch {
        missing.push(i);
      }
    }
    if (missing.length > 0) {
      // Keep parts — the client resumes with exactly the missing indexes.
      throw new Error(`Upload incomplete: ${missing.length} of ${chunkTotal} chunk(s) missing (indexes: ${missing.slice(0, 20).join(", ")}).`);
    }

    const free = await getFreeDiskBytes();
    // Peak usage: parts + assembled copy + final original — require 3x headroom.
    if (free < totalSize * 3) {
      throw new Error(
        `Insufficient server storage. Need ~${((totalSize * 3) / 1e9).toFixed(2)} GB headroom, ${(free / 1e9).toFixed(2)} GB available.`
      );
    }

    const out = createWriteStream(assembledPath);
    // Single pipeline over an ordered generator: no per-part error listeners
    // on the shared destination, no {end:false} juggling.
    const concatParts = async function* () {
      for (let i = 0; i < chunkTotal; i++) {
        yield* createReadStream(path.join(partsDir, `${String(i).padStart(6, "0")}.part`));
      }
    };
    await pipeline(concatParts, out);
    out.end();
    await finished(out);

    const asmStat = await fs.stat(assembledPath);
    if (asmStat.size !== totalSize) {
      // Keep parts: the client checks per-part sizes via the status endpoint,
      // re-sends any damaged chunk, then re-sends the final chunk.
      throw new Error(`Upload incomplete: received ${asmStat.size} of ${totalSize} bytes.`);
    }
    if (sha) {
      const actualSha = await sha256File(assembledPath);
      if (actualSha !== sha) {
        throw new PermanentUploadError("Checksum mismatch: the assembled file does not match the declared sha256.");
      }
    }

    const response = await finalizeUpload(user.id, identity, assembledPath, uploadId);
    await fs.rm(partsDir, { recursive: true, force: true }).catch(() => undefined);
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed.";
    console.error("[media/upload-chunked]", message);
    if (err instanceof PermanentUploadError) {
      // Nothing resumable here — clear scratch and close the session.
      await removeFileQuiet(assembledPath);
      await fs.rm(partsDir, { recursive: true, force: true }).catch(() => undefined);
      await db.uploadSession
        .updateMany({ where: { id: uploadId, userId: user.id, status: "OPEN" }, data: { status: "FAILED" } })
        .catch(() => undefined);
      return jsonError(message, errorStatus(message));
    }
    // Transient (missing chunks, disk headroom, network): keep parts for resume.
    await removeFileQuiet(assembledPath);
    return jsonError(message, errorStatus(message));
  }
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("Authentication required.", 401);

  const assets = await db.mediaAsset.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json({
    media: assets.map((a) => ({
      id: a.id,
      originalName: a.originalName,
      kind: a.kind,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      durationSec: a.durationSec,
      width: a.width,
      height: a.height,
      fps: a.fps,
      videoCodec: a.videoCodec,
      audioCodec: a.audioCodec,
      sampleRate: a.sampleRate,
      channels: a.channels,
      probeStatus: a.probeStatus,
      proxyStatus: a.proxyStatus,
      role: a.role,
      notes: a.notes,
      createdAt: a.createdAt.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    await discardBody(req);
    return jsonError("Authentication required.", 401);
  }

  const chunkTotalHeader = req.headers.get("x-chunk-total");
  if (chunkTotalHeader && Number(chunkTotalHeader) > 0) {
    return handleChunkedUpload(req, user);
  }

  const parsed = parseIdentity(req);
  if ("error" in parsed) {
    await discardBody(req);
    return parsed.error;
  }
  const identity = parsed.identity;
  const contentLength = Number(req.headers.get("content-length") ?? "0");

  if (!contentLength || contentLength <= 0) {
    await discardBody(req);
    return jsonError("Missing upload size (Content-Length).", 400);
  }
  if (contentLength > MAX_UPLOAD_BYTES) {
    await discardBody(req);
    return jsonError(`File is larger than the ${(MAX_UPLOAD_BYTES / MB).toFixed(0)} MB single-request limit. Use chunked upload for larger files.`, 413);
  }

  const quota = await hasQuotaFor(user.id, contentLength);
  if (!quota.ok) {
    await discardBody(req);
    return jsonError(
      `Storage quota exceeded: ${(quota.usedBytes / 1e9).toFixed(2)} GB used of ${(quota.quotaBytes / 1e9).toFixed(2)} GB, ` +
        `this file needs ${(contentLength / 1e9).toFixed(2)} GB.`,
      413
    );
  }

  await ensureMediaRoot();
  const free = await getFreeDiskBytes();
  // Peak usage: original + processing scratch (2x) — require 3x headroom.
  if (free < contentLength * 3) {
    await discardBody(req);
    return jsonError(
      `Insufficient server storage. Need ~${((contentLength * 3) / 1e9).toFixed(2)} GB headroom, ${(free / 1e9).toFixed(2)} GB available.`,
      507
    );
  }

  const tmpPath = path.join(MEDIA_ROOT, "tmp", `up_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  try {
    if (!req.body) throw new Error("Empty request body.");
    await pipeline(Readable.fromWeb(req.body as import("stream/web").ReadableStream), createWriteStream(tmpPath));

    const stat = await fs.stat(tmpPath);
    if (stat.size !== contentLength) {
      throw new Error(`Upload incomplete: received ${stat.size} of ${contentLength} bytes.`);
    }

    return await finalizeUpload(user.id, identity, tmpPath, null);
  } catch (err) {
    await removeFileQuiet(tmpPath);
    const message = err instanceof Error ? err.message : "Upload failed.";
    console.error("[media/upload]", message);
    return jsonError(message, errorStatus(message));
  }
}
