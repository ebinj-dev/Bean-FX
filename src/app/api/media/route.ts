import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import { createWriteStream, createReadStream, promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import {
  MEDIA_ROOT,
  MAX_UPLOAD_BYTES,
  ensureMediaRoot,
  safeExt,
  classifyByExtension,
  ffprobe,
  getFreeDiskBytes,
  removeFileQuiet,
} from "@/lib/media-storage";
import { parseSrt } from "@/lib/srt";
import { pipeline, finished } from "stream/promises";

export const runtime = "nodejs";
export const maxDuration = 300;

const MB = 1024 * 1024;
/** Orphaned chunk upload scratch is garbage-collected after this long. */
const STALE_UPLOAD_TTL_MS = 60 * 60 * 1000;
const UPLOAD_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

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
  if (
    m.includes("media inspection failed") ||
    m.includes("no audio or video") ||
    m.includes("invalid data") ||
    m.includes("could not be read") ||
    m.includes("moov atom")
  ) {
    return 415;
  }
  return 500;
}

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

/** ffprobe validation + persistent storage + DB row. Shared by both upload paths. */
async function finalizeUpload(userId: string, identity: UploadIdentity, tmpPath: string): Promise<NextResponse> {
  // Subtitle references (SRT) are parsed, not probed: a valid cue list IS the
  // validation. Original text and timestamps are preserved verbatim.
  if (identity.kind === "SUBTITLE") {
    const content = await fs.readFile(tmpPath, "utf8").catch(() => null);
    if (content === null) throw new Error("Subtitle file could not be read.");
    const parsed = parseSrt(content);
    if (!parsed.cues.length) {
      throw new Error(`Invalid SRT: ${parsed.errors[0] ?? "no valid cues found"}.`);
    }
    const stat = await fs.stat(tmpPath);
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
        notes: identity.notes,
      },
    });
    return NextResponse.json({
      media: {
        id: asset.id,
        originalName: asset.originalName,
        kind: asset.kind,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        durationSec: asset.durationSec,
        width: null,
        height: null,
        fps: null,
        videoCodec: null,
        audioCodec: null,
        sampleRate: null,
        channels: null,
        role: null,
        notes: asset.notes,
        createdAt: asset.createdAt.toISOString(),
      },
      srt: { cueCount: parsed.cues.length, parseErrors: parsed.errors.slice(0, 10) },
    });
  }

  // Validate the actual media — never trust the extension alone.
  let meta;
  try {
    meta = await ffprobe(tmpPath);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "Media could not be read.");
  }
  if (!meta.hasAudio && !meta.hasVideo) {
    throw new Error("File contains no audio or video streams.");
  }
  if (identity.kind === "AUDIO" && !meta.hasAudio) {
    throw new Error("This file has no audio stream and cannot be used as audio.");
  }
  const resolvedKind = meta.hasVideo ? "VIDEO" : "AUDIO";

  const stat = await fs.stat(tmpPath);
  const finalName = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${identity.ext}`;
  const finalPath = path.join(MEDIA_ROOT, "originals", finalName);
  await fs.rename(tmpPath, finalPath);

  const asset = await db.mediaAsset.create({
    data: {
      userId,
      originalName: identity.originalName.slice(0, 200),
      storagePath: finalPath,
      kind: resolvedKind,
      mimeType: `application/octet-stream`,
      sizeBytes: stat.size,
      durationSec: meta.durationSec,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      videoCodec: meta.videoCodec,
      audioCodec: meta.audioCodec,
      sampleRate: meta.sampleRate,
      channels: meta.channels,
      role: identity.role,
      notes: identity.notes,
    },
  });

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
      role: asset.role,
      notes: asset.notes,
      createdAt: asset.createdAt.toISOString(),
    },
  });
}

/** Remove orphaned upload scratch (files and dirs) older than the TTL. */
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
      if (now - st.mtimeMs > STALE_UPLOAD_TTL_MS) {
        await fs.rm(p, { recursive: true, force: true });
      }
    } catch {
      // raced with another cleanup — ignore
    }
  }
}

/**
 * Chunked upload path: the client splits large files so no single HTTP request
 * body has to cross the preview gateway at full size. Chunks land as per-index
 * part files (idempotent, order-tolerant) and are assembled on the last chunk;
 * validation and storage are identical to the single-shot path.
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

  if (!UPLOAD_ID_RE.test(uploadId) || !Number.isInteger(chunkIndex) || !Number.isInteger(chunkTotal) || chunkTotal < 1 || chunkIndex < 0 || chunkIndex >= chunkTotal) {
    await discardBody(req);
    return jsonError(!UPLOAD_ID_RE.test(uploadId) ? "Invalid upload id." : "Invalid chunk index or total.", 400);
  }
  if (!totalSize || totalSize <= 0) {
    await discardBody(req);
    return jsonError("Missing upload size (x-upload-size).", 400);
  }
  if (totalSize > MAX_UPLOAD_BYTES) {
    await discardBody(req);
    return jsonError(`File is larger than the ${(MAX_UPLOAD_BYTES / MB).toFixed(0)} MB upload limit.`, 413);
  }
  if (!contentLength || contentLength <= 0) {
    await discardBody(req);
    return jsonError("Missing chunk size (Content-Length).", 400);
  }
  if (contentLength > MAX_UPLOAD_BYTES) {
    await discardBody(req);
    return jsonError(`Chunk is larger than the ${(MAX_UPLOAD_BYTES / MB).toFixed(0)} MB upload limit.`, 413);
  }

  await ensureMediaRoot();
  const partsDir = path.join(MEDIA_ROOT, "tmp", `up_${uploadId}`);
  const partPath = path.join(partsDir, `${String(chunkIndex).padStart(6, "0")}.part`);
  const assembledPath = path.join(MEDIA_ROOT, "tmp", `asm_${uploadId}`);

  try {
    await fs.mkdir(partsDir, { recursive: true });
    await gcStaleUploads();

    if (!req.body) throw new Error("Empty request body.");
    await pipeline(Readable.fromWeb(req.body as import("stream/web").ReadableStream), createWriteStream(partPath));
    const partStat = await fs.stat(partPath);
    if (partStat.size !== contentLength) {
      await removeFileQuiet(partPath);
      throw new Error(`Chunk incomplete: received ${partStat.size} of ${contentLength} bytes.`);
    }

    if (chunkIndex < chunkTotal - 1) {
      return NextResponse.json({ partial: true, received: chunkIndex + 1, total: chunkTotal });
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
      throw new Error(`Upload incomplete: ${missing.length} of ${chunkTotal} chunk(s) missing.`);
    }

    const free = await getFreeDiskBytes();
    // Peak usage: parts + assembled copy + final original — require 3x headroom.
    if (free < totalSize * 3) {
      return jsonError(
        `Insufficient server storage. Need ~${((totalSize * 3) / 1e9).toFixed(2)} GB headroom, ${(free / 1e9).toFixed(2)} GB available.`,
        507
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
      throw new Error(`Upload incomplete: received ${asmStat.size} of ${totalSize} bytes.`);
    }

    const response = await finalizeUpload(user.id, identity, assembledPath);
    await fs.rm(partsDir, { recursive: true, force: true }).catch(() => undefined);
    return response;
  } catch (err) {
    // No resume protocol exists — a failed upload never leaves scratch behind.
    await removeFileQuiet(assembledPath);
    await fs.rm(partsDir, { recursive: true, force: true }).catch(() => undefined);
    const message = err instanceof Error ? err.message : "Upload failed.";
    console.error("[media/upload-chunked]", message);
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
    return jsonError(`File is larger than the ${(MAX_UPLOAD_BYTES / MB).toFixed(0)} MB upload limit.`, 413);
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

    return await finalizeUpload(user.id, identity, tmpPath);
  } catch (err) {
    await removeFileQuiet(tmpPath);
    const message = err instanceof Error ? err.message : "Upload failed.";
    console.error("[media/upload]", message);
    return jsonError(message, errorStatus(message));
  }
}
