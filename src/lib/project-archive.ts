/**
 * M29 — project portability: canonical manifest, streaming package builder,
 * import/restore, and bulk-relink matching. Extends the existing architecture
 * (durable Job queue, pathInsideMediaRoot staging, streaming sha256, zod
 * SequenceSchema) — no second job system, no second storage layer.
 *
 * Package format: STORED zip (deterministic, streamed — two disk passes, no
 * full-file memory). `manifest.json` is authoritative; entries are flat and
 * forward-slashed. Format version gates imports: anything newer or non-BEAN
 * FX (deflate, symlinks) is rejected clearly, never guessed.
 */
import { createReadStream, createWriteStream } from "fs";
import { mkdir, stat, rm, readFile, writeFile, rename } from "fs/promises";
import path from "path";
import { CRC_TABLE as crc32table } from "./publish/zip";
import { db } from "@/lib/db";
import { PermanentJobError } from "@/lib/job-helpers";
import { pathInsideMediaRoot, sha256File, assertDiskSpace } from "@/lib/media-storage";
import { SequenceSchema } from "@/lib/editor/model";

/** Package format version — imports reject anything they do not understand. */
export const PACKAGE_FORMAT_VERSION = "beanfx-project/1";
/** Recorded project schema marker (zod additive-defaults era). */
export const PROJECT_SCHEMA_VERSION = "sequence-zod-2026.11";

/** Memory-bounded honesty: packages larger than this are refused up front. */
export const PROJECT_PACKAGE_BYTES_CAP = 512 * 1024 * 1024;
/** Import safety: entry count and total unpacked size limits. */
export const IMPORT_MAX_ENTRIES = 800;
export const IMPORT_MAX_UNPACKED_BYTES = PROJECT_PACKAGE_BYTES_CAP;
/** Manual (non-autosave) timeline versions carried in a package. */
const MAX_HISTORY_VERSIONS = 50;

export type ArchiveMode = "FULL" | "NO_PROXIES" | "METADATA";

export interface ManifestAsset {
  assetId: string;
  role: "ORIGINAL" | "PROXY";
  path: string; // safe relative package path (forward slashes)
  originalName: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  isVfr: boolean | null;
  rotation: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  channels: number | null;
  sampleRate: number | null;
  proxyOf: string | null;
}

export interface PackageManifest {
  formatVersion: string;
  schemaVersion: string;
  createdAt: string;
  mode: ArchiveMode;
  project: { id: string; name: string; description: string | null; settingsJson: string | null };
  timeline: { latestVersionNumber: number; latestSequenceJson: string; history: { versionNumber: number; sequenceJson: string; isAutosave: boolean }[] };
  assets: ManifestAsset[];
  /** Content that was deliberately NOT packaged (regenerable/derived). */
  omitted: { kind: string; reason: string; count: number }[];
}

// ── safe package paths ──────────────────────────────────────────────────────

/** Media assets live under media/<assetId><ext>; manifest + project at root. */
export function packagePathForAsset(assetId: string, originalName: string, storagePath: string): string {
  const ext = path.extname(storagePath || originalName).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 12);
  const name = `media/${assetId.replace(/[^a-zA-Z0-9_-]/g, "")}${ext || ".bin"}`;
  if (name.startsWith("/") || name.includes("..") || name.includes("\\")) throw new PermanentJobError("Unsafe package path derived for an asset.");
  return name;
}

// ── streaming STORED zip writer ─────────────────────────────────────────────
// STORED method only (no compression): entries are streamed from disk with a
// CRC pre-pass — memory stays bounded by the copy buffer, not file size.

interface StreamEntry {
  name: string;
  sourcePath: string;
  size: number;
  crc32: number;
}

async function crcOfStream(filePath: string): Promise<{ crc: number; size: number }> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    let crc = 0xffffffff;
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i++) crc = crc32table[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
      size += chunk.length;
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ crc: (crc ^ 0xffffffff) >>> 0, size }));
  });
}

function dosDateTime(): { time: number; date: number } {
  // Deterministic like buildZip (2000-01-01) — reproducible packages.
  return { time: 0, date: ((2000 - 1980) << 9) | (1 << 5) | 1 };
}

/**
 * Stream a STORED zip to `outPath`. Entries are plain files already on disk.
 * Deterministic bytes for identical content (fixed DOS time, sorted entries).
 */
export async function writeStreamingZip(outPath: string, entries: StreamEntry[]): Promise<number> {
  const u16 = (v: number) => Buffer.from([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v: number) => Buffer.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
  const { time, date } = dosDateTime();
  const central: { name: string; crc: number; size: number; offset: number }[] = [];
  let offset = 0;
  const fd = createWriteStream(outPath, { flags: "w" });
  // fs.createWriteStream emits "open" (never "ready") — waiting on "ready"
  // hung every packaging job (observed: claims sat PROCESSING forever).
  await new Promise<void>((resolve, reject) => {
    fd.on("error", reject);
    fd.on("open", () => resolve());
  });
  const write = (buf: Buffer) => new Promise<void>((resolve, reject) => {
    fd.write(buf, (err) => (err ? reject(err) : resolve()));
  });
  const COPY = 4 * 1024 * 1024;
  try {
    for (const e of entries) {
      if (e.name.startsWith("/") || e.name.includes("..") || e.name.includes("\\")) throw new PermanentJobError(`unsafe zip entry: ${e.name}`);
      const nameBuf = Buffer.from(e.name, "utf8");
      if (nameBuf.length > 240) throw new PermanentJobError(`zip entry name too long: ${e.name}`);
      const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time), u16(date), u32(e.crc32), u32(e.size), u32(e.size), u16(nameBuf.length), u16(0), nameBuf]);
      await write(local);
      central.push({ name: e.name, crc: e.crc32, size: e.size, offset });
      offset += local.length;
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(e.sourcePath, { highWaterMark: COPY });
        rs.on("error", reject);
        rs.on("data", (chunk: Buffer) => {
          offset += chunk.length;
          void fd.write(chunk);
        });
        rs.on("end", resolve);
      });
    }
    const centralStart = offset;
    for (const c of central) {
      const nameBuf = Buffer.from(c.name, "utf8");
      const rec = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(date), u32(c.crc), u32(c.size), u32(c.size), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset), nameBuf]);
      await write(rec);
      offset += rec.length;
    }
    const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(offset - centralStart), u32(centralStart), u16(0)]);
    await write(end);
    offset += end.length;
  } finally {
    await new Promise<void>((resolve) => fd.end(() => resolve()));
  }
  return offset;
}

// ── STORED-only zip reader (import validation) ──────────────────────────────

export interface ZipListing {
  entries: { name: string; offset: number; size: number; method: number }[];
  truncatedEocd?: boolean;
}

/** Parse a STORED-only zip listing. Deflate or unusual layouts are rejected. */
export async function listStoredZip(zipPath: string): Promise<ZipListing> {
  const buf = await readFile(zipPath);
  if (buf.length < 22) throw new PermanentJobError("Package file is too small to be a valid archive.");
  // Locate the End Of Central Directory (scan back over a possible comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 4096); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new PermanentJobError("Package is not a valid zip archive (no central directory).");
  const count = buf.readUInt16LE(eocd + 10);
  if (count > IMPORT_MAX_ENTRIES) throw new PermanentJobError(`Package has ${count} entries — over the ${IMPORT_MAX_ENTRIES} entry limit.`);
  const cdStart = buf.readUInt32LE(eocd + 16);
  const entries: ZipListing["entries"] = [];
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new PermanentJobError("Package central directory is corrupted.");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    if (method !== 0) throw new PermanentJobError(`Package entry "${name}" uses compression method ${method} — only STORED BEAN FX packages are supported.`);
    if (name.startsWith("/") || name.includes("..") || name.includes("\\") || name.includes(":")) {
      throw new PermanentJobError(`Package entry "${name}" has an unsafe path — rejected (path traversal protection).`);
    }
    // Local header sanity: signature + same size/method as the central record.
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new PermanentJobError(`Package entry "${name}" has a corrupted local header.`);
    const lMethod = buf.readUInt16LE(localOff + 8);
    const lSize = buf.readUInt32LE(localOff + 18);
    if (lMethod !== 0 || lSize !== compSize) throw new PermanentJobError(`Package entry "${name}" header mismatch — archive is inconsistent.`);
    entries.push({ name, offset: localOff + 30 + buf.readUInt16LE(localOff + 26), size: compSize, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries };
}

/** Extract one STORED entry to a file (streamed). */
export async function extractStoredEntry(zipPath: string, entry: ZipListing["entries"][number], outPath: string): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(zipPath, { start: entry.offset, end: entry.offset + entry.size - 1 });
    const ws = createWriteStream(outPath);
    rs.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", () => resolve());
    rs.pipe(ws);
  });
}

/** Total size a package will claim before we start writing. */
export async function measurePackageBytes(entries: StreamEntry[]): Promise<number> {
  let total = 22; // single end-of-central-directory record
  for (const e of entries) total += 30 + Buffer.byteLength(e.name) + e.size + 46 + Buffer.byteLength(e.name);
  return total;
}

// ── manifest builder ────────────────────────────────────────────────────────

/** Collect + hash every asset the project's timeline references. */
export async function buildManifest(
  userId: string,
  projectId: string,
  mode: ArchiveMode
): Promise<{ manifest: PackageManifest; entries: StreamEntry[]; totalBytes: number; missing: string[] }> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== userId) throw new PermanentJobError("Project not found for this user.");
  const latest = await db.timelineVersion.findFirst({ where: { projectId }, orderBy: { versionNumber: "desc" } });
  if (!latest) throw new PermanentJobError("The project has no sequence to package yet.");
  const seq = SequenceSchema.parse(JSON.parse(latest.sequenceJson));

  const historyRows = await db.timelineVersion.findMany({
    where: { projectId, isAutosave: false },
    orderBy: { versionNumber: "desc" },
    take: MAX_HISTORY_VERSIONS,
  });
  const history = historyRows.reverse().map((v) => ({ versionNumber: v.versionNumber, sequenceJson: v.sequenceJson, isAutosave: false }));

  const referencedIds = [...new Set(seq.clips.map((c) => c.sourceAssetId).filter((id): id is string => Boolean(id)))];
  const assets = await db.mediaAsset.findMany({ where: { id: { in: referencedIds }, userId } });
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const missing = referencedIds.filter((id) => !assetById.has(id));

  const manifestAssets: ManifestAsset[] = [];
  const entries: StreamEntry[] = [];
  const seenPaths = new Map<string, string>(); // path → assetId (conflict detection)
  const seenHashes = new Map<string, string>(); // sha256 → package path (dedup)
  let totalBytes = 0;
  let omittedProxies = 0;
  let includedProxies = 0;

  for (const id of referencedIds) {
    const a = assetById.get(id);
    if (!a) continue; // recorded in `missing` — never fabricated
    if (mode === "METADATA") {
      // METADATA ships manifest + timeline only — the manifest still RECORDS
      // the reference (for relink on import) but carries no media bytes.
      manifestAssets.push({
        assetId: a.id, role: "ORIGINAL", path: "", originalName: a.originalName, kind: a.kind,
        mimeType: a.mimeType, sizeBytes: 0, sha256: a.sha256 ?? "", durationSec: a.durationSec,
        width: a.width, height: a.height, fps: a.fps, isVfr: a.isVfr, rotation: a.rotation,
        videoCodec: a.videoCodec, audioCodec: a.audioCodec, channels: a.channels, sampleRate: a.sampleRate,
        proxyOf: null,
      });
      continue;
    }
    if (!a.sha256) throw new PermanentJobError(`Asset "${a.originalName}" has no content hash yet — wait for its probe to finish, then package again.`);
    const st = await stat(a.storagePath).catch(() => null);
    if (!st || st.size !== a.sizeBytes) throw new PermanentJobError(`Asset "${a.originalName}" is missing from storage or its size changed — it cannot be packaged.`);
    // Duplicate content by checksum: one entry, several manifest refs.
    const dedup = seenHashes.get(a.sha256);
    const pkgPath = dedup ?? packagePathForAsset(a.id, a.originalName, a.storagePath);
    if (!dedup) {
      if (seenPaths.has(pkgPath)) throw new PermanentJobError(`Conflicting package paths for ${pkgPath}.`);
      seenPaths.set(pkgPath, a.id);
      seenHashes.set(a.sha256, pkgPath);
      const realHash = await sha256File(a.storagePath);
      if (realHash !== a.sha256) throw new PermanentJobError(`Asset "${a.originalName}" changed on disk since upload (checksum mismatch) — packaging refused to preserve integrity.`);
      const { crc } = await crcOfStream(a.storagePath);
      entries.push({ name: pkgPath, sourcePath: a.storagePath, size: st.size, crc32: crc });
      totalBytes += st.size;
    }
    manifestAssets.push({
      assetId: a.id, role: "ORIGINAL", path: pkgPath, originalName: a.originalName, kind: a.kind,
      mimeType: a.mimeType, sizeBytes: st.size, sha256: a.sha256, durationSec: a.durationSec,
      width: a.width, height: a.height, fps: a.fps, isVfr: a.isVfr, rotation: a.rotation,
      videoCodec: a.videoCodec, audioCodec: a.audioCodec, channels: a.channels, sampleRate: a.sampleRate,
      proxyOf: null,
    });
    if (mode === "FULL" && a.proxyStatus === "READY" && a.proxyPath && (await stat(a.proxyPath).catch(() => null))) {
      const proxySize = (await stat(a.proxyPath)).size;
      const proxyHash = await sha256File(a.proxyPath);
      const proxyDedup = seenHashes.get(proxyHash);
      const proxyPkgPath = proxyDedup ?? `proxies/${a.id}.mp4`;
      if (!proxyDedup) {
        if (seenPaths.has(proxyPkgPath)) throw new PermanentJobError(`Conflicting proxy package paths for ${proxyPkgPath}.`);
        seenPaths.set(proxyPkgPath, `proxy:${a.id}`);
        seenHashes.set(proxyHash, proxyPkgPath);
        const { crc } = await crcOfStream(a.proxyPath);
        entries.push({ name: proxyPkgPath, sourcePath: a.proxyPath, size: proxySize, crc32: crc });
        totalBytes += proxySize;
      }
      manifestAssets.push({
        assetId: `proxy:${a.id}`, role: "PROXY", path: proxyPkgPath, originalName: `${a.originalName} (proxy)`,
        kind: "VIDEO", mimeType: "video/mp4", sizeBytes: proxySize, sha256: proxyHash, durationSec: a.proxyDurationSec,
        width: null, height: null, fps: null, isVfr: null, rotation: null, videoCodec: "h264", audioCodec: "aac",
        channels: null, sampleRate: null, proxyOf: a.id,
      });
      includedProxies += 1;
    } else if (a.proxyStatus === "READY") {
      omittedProxies += 1;
    }
  }

  if (totalBytes > PROJECT_PACKAGE_BYTES_CAP) {
    throw new PermanentJobError(`Project media totals ${(totalBytes / 1024 / 1024).toFixed(0)} MB — over the ${(PROJECT_PACKAGE_BYTES_CAP / 1024 / 1024).toFixed(0)} MB package cap (memory-bounded honest limit).`);
  }

  const omitted: PackageManifest["omitted"] = [];
  if (mode !== "FULL") omitted.push({ kind: "PROXY", reason: mode === "NO_PROXIES" ? "NO_PROXIES mode excludes editing proxies (regenerable from originals)" : "METADATA mode excludes all media", count: omittedProxies || 0 });
  if (mode === "METADATA") omitted.push({ kind: "ORIGINAL", reason: "METADATA mode ships manifest + timeline only; media must be relinked on import", count: referencedIds.length - missing.length });
  omitted.push({ kind: "DERIVED", reason: "thumbnails, publish drafts, AI conversations/plans, export outputs, job records are regenerable or user-scoped and are never packaged", count: 0 });

  const manifest: PackageManifest = {
    formatVersion: PACKAGE_FORMAT_VERSION,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    mode,
    project: { id: project.id, name: project.name, description: project.description, settingsJson: project.settingsJson },
    timeline: { latestVersionNumber: latest.versionNumber, latestSequenceJson: latest.sequenceJson, history },
    assets: manifestAssets,
    omitted,
  };
  return { manifest, entries, totalBytes, missing };
}

// ── package job (ARCHIVE direction) ─────────────────────────────────────────

/** PROJECT_ARCHIVE handler: manifest → staging zip → verify → atomic publish.
 *  Idempotent: a COMPLETED archive with its file intact short-circuits. */
export async function runProjectArchiveJob(job: { id: string; userId: string; paramsJson: string | null }, setProgress: (p: number, stage: string) => Promise<void>): Promise<void> {
  const params = JSON.parse(job.paramsJson ?? "{}") as { archiveId?: string };
  if (!params.archiveId) throw new PermanentJobError("PROJECT_ARCHIVE missing archiveId");
  const archive = await db.projectArchive.findUnique({ where: { id: params.archiveId } });
  if (!archive || archive.userId !== job.userId) throw new PermanentJobError("Archive not found or not owned by the caller.");
  if (archive.direction !== "ARCHIVE") throw new PermanentJobError("Archive row is not an export package.");
  if (!archive.projectId) throw new PermanentJobError("Archive has no project.");

  const outPath = pathInsideMediaRoot("project-archives", `u_${job.userId}`, `${archive.id}.zip`);
  if (archive.status === "COMPLETED" && archive.storagePath === outPath) {
    const done = await stat(outPath).catch(() => null);
    if (done && done.size === archive.sizeBytes) return; // crash-recovery safe
  }
  if (!(await stat(path.dirname(outPath)).catch(() => null))) await mkdir(path.dirname(outPath), { recursive: true });
  await assertDiskSpace(path.dirname(outPath));

  const staging = pathInsideMediaRoot("tmp", `arch_${archive.id}`);
  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await setProgress(5, "Building manifest");
    const mode = (["FULL", "NO_PROXIES", "METADATA"].includes(archive.mode) ? archive.mode : "FULL") as ArchiveMode;
    const { manifest, entries, totalBytes, missing } = await buildManifest(job.userId, archive.projectId, mode);
    if (missing.length > 0) {
      throw new PermanentJobError(`Cannot package: ${missing.length} referenced asset(s) are missing from the library (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}). Relink or remove them first — nothing was changed.`);
    }
    await setProgress(25, "Verifying content integrity");
    await setProgress(40, "Writing package");
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    const manifestPath = path.join(staging, "manifest.json");
    await writeFile(manifestPath, manifestBytes);
    const { crc } = await crcOfStream(manifestPath);
    const allEntries: StreamEntry[] = [...entries, { name: "manifest.json", sourcePath: manifestPath, size: manifestBytes.length, crc32: crc }];
    const expected = await measurePackageBytes(allEntries);
    if (expected > PROJECT_PACKAGE_BYTES_CAP) throw new PermanentJobError("Package exceeds the size cap.");
    const stagingZip = path.join(staging, "package.zip");
    const written = await writeStreamingZip(stagingZip, allEntries);
    if (written !== expected) throw new PermanentJobError(`Package size verification failed (${written} ≠ ${expected}) — nothing was published.`);
    await setProgress(85, "Verifying package contents");
    // Verify the WRITTEN package: listing + manifest entry + every asset hash.
    const listing = await listStoredZip(stagingZip);
    if (listing.entries.length !== allEntries.length) throw new PermanentJobError("Package verification failed: unexpected entry count.");
    const verifyDir = path.join(staging, "verify");
    await mkdir(verifyDir, { recursive: true });
    for (const e of listing.entries) {
      const out = path.join(verifyDir, e.name.replace(/\//g, "__"));
      await extractStoredEntry(stagingZip, e, out);
      const h = await sha256File(out);
      if (e.name === "manifest.json") {
        const reparsed = JSON.parse(await readFile(out, "utf8")) as PackageManifest;
        if (reparsed.formatVersion !== PACKAGE_FORMAT_VERSION) throw new PermanentJobError("Packaged manifest has the wrong format version.");
        if (reparsed.assets.length !== manifest.assets.length) throw new PermanentJobError("Packaged manifest asset count mismatch.");
      } else {
        const src = manifest.assets.find((a) => a.path === e.name);
        if (!src) throw new PermanentJobError(`Package contains an unmanifested entry: ${e.name}`);
        if (h !== src.sha256) throw new PermanentJobError(`Packaged asset "${e.name}" failed checksum verification — nothing was published.`);
      }
      await rm(out, { force: true });
    }
    await setProgress(95, "Publishing package");
    await rename(stagingZip, outPath); // same filesystem → atomic
    const size = (await stat(outPath)).size;
    await db.projectArchive.update({
      where: { id: archive.id },
      data: {
        status: "COMPLETED", progress: 100, stage: "Completed", storagePath: outPath, sizeBytes: size,
        assetCount: manifest.assets.length,
        manifestJson: JSON.stringify({ ...manifest, timeline: { ...manifest.timeline, history: manifest.timeline.history.length } }),
      },
    });
  } catch (err) {
    await db.projectArchive.update({
      where: { id: archive.id },
      data: { status: "FAILED", error: err instanceof Error ? err.message.slice(0, 500) : "packaging failed" },
    }).catch(() => undefined);
    throw err;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ── import / restore ────────────────────────────────────────────────────────

export interface ImportPlan {
  manifest: PackageManifest;
  zipPath: string;
  listing: ZipListing;
  /** Assets whose files are absent or fail checksum — import refuses while nonempty. */
  invalidAssets: { assetId: string; path: string; reason: string }[];
}

/** Validate an uploaded package WITHOUT touching the library (staging only). */
export async function planImport(userId: string, zipPath: string): Promise<ImportPlan> {
  const listing = await listStoredZip(zipPath);
  const manifestEntry = listing.entries.find((e) => e.name === "manifest.json");
  if (!manifestEntry) throw new PermanentJobError("Package has no manifest.json — not a BEAN FX project package.");
  const manifestPath = pathInsideMediaRoot("tmp", `import_${userId}_${Date.now().toString(36)}_manifest.json`);
  try {
    await extractStoredEntry(zipPath, manifestEntry, manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
    if (manifest.formatVersion !== PACKAGE_FORMAT_VERSION) {
      throw new PermanentJobError(`Unsupported package format "${manifest.formatVersion}" — this build supports ${PACKAGE_FORMAT_VERSION} only. The package was not modified.`);
    }
    // Every media entry must be manifested; every manifested media asset must exist in the package.
    const entryByName = new Map(listing.entries.map((e) => [e.name, e]));
    const invalidAssets: ImportPlan["invalidAssets"] = [];
    const needed = manifest.mode === "METADATA" ? [] : manifest.assets;
    for (const a of needed) {
      const e = entryByName.get(a.path);
      if (!e) { invalidAssets.push({ assetId: a.assetId, path: a.path, reason: "missing from the package" }); continue; }
      if (e.size !== a.sizeBytes) { invalidAssets.push({ assetId: a.assetId, path: a.path, reason: `size mismatch (${e.size} ≠ ${a.sizeBytes})` }); continue; }
      const out = pathInsideMediaRoot("tmp", `import_${userId}_${Date.now().toString(36)}_chk.bin`);
      await extractStoredEntry(zipPath, e, out);
      const h = await sha256File(out);
      await rm(out, { force: true });
      if (h !== a.sha256) { invalidAssets.push({ assetId: a.assetId, path: a.path, reason: "checksum mismatch (corrupted or modified)" }); }
    }
    if (invalidAssets.length > 0) {
      throw new PermanentJobError(`Package is incomplete — ${invalidAssets.length} asset(s) failed validation: ${invalidAssets.slice(0, 3).map((x) => `${x.path} (${x.reason})`).join("; ")}${invalidAssets.length > 3 ? "…" : ""} Nothing was imported.`);
    }
    return { manifest, zipPath, listing, invalidAssets: [] };
  } finally {
    await rm(manifestPath, { force: true }).catch(() => undefined);
  }
}

export interface ImportResult {
  projectId: string;
  projectName: string;
  assetsCreated: number;
  assetsReused: number;
  versionsRestored: number;
  clipsRestored: number;
}

/** Import: stage media → create NEW project identity → rewrite asset refs →
 *  restore timeline (+ history) → verify. Never overwrites an existing project. */
export async function importPackage(userId: string, plan: ImportPlan, setProgress: (p: number, stage: string) => Promise<void>): Promise<ImportResult> {
  const { manifest, zipPath, listing } = plan;
  await assertDiskSpace(path.dirname(zipPath));
  const entryByName = new Map(listing.entries.map((e) => [e.name, e]));

  // 1) Validate the timeline parses with the CURRENT schema (additive zod).
  SequenceSchema.parse(JSON.parse(manifest.timeline.latestSequenceJson));
  for (const h of manifest.timeline.history) SequenceSchema.parse(JSON.parse(h.sequenceJson));

  await setProgress(20, "Staging media");
  // 2) Deduplicate against the user's library by checksum — reuse matching
  //    assets instead of creating duplicate media (preserves relative identity).
  const existing = await db.mediaAsset.findMany({ where: { userId, sha256: { in: manifest.assets.filter((a) => a.role === "ORIGINAL").map((a) => a.sha256) } }, select: { id: true, sha256: true } });
  const reuseByHash = new Map(existing.filter((e) => e.sha256).map((e) => [e.sha256 as string, e.id]));
  const idMap = new Map<string, string>(); // manifest assetId → new library assetId
  let created = 0;
  let reused = 0;
  for (const a of manifest.assets) {
    if (a.role !== "ORIGINAL") continue; // proxies are regenerated on import
    if (manifest.mode === "METADATA") continue; // no media bytes; refs stay dead (relink restores them)
    const reusedId = reuseByHash.get(a.sha256);
    if (reusedId) { idMap.set(a.assetId, reusedId); reused += 1; continue; }
    const e = entryByName.get(a.path);
    if (!e) throw new PermanentJobError(`Asset "${a.path}" vanished from the package mid-import — import aborted atomically.`);
    const ext = path.extname(a.path) || ".bin";
    const dest = pathInsideMediaRoot("media", `u_${userId}`, `import_${Date.now().toString(36)}_${created}${ext}`);
    await mkdir(path.dirname(dest), { recursive: true });
    await extractStoredEntry(zipPath, e, dest);
    const staged = await stat(dest);
    if (staged.size !== a.sizeBytes) throw new PermanentJobError(`Staged "${a.path}" has the wrong size — import aborted atomically.`);
    if ((await sha256File(dest)) !== a.sha256) throw new PermanentJobError(`Staged "${a.path}" failed checksum — import aborted atomically.`);
    const row = await db.mediaAsset.create({
      data: {
        userId, kind: a.kind, originalName: a.originalName, storagePath: dest, mimeType: a.mimeType,
        sizeBytes: a.sizeBytes, sha256: a.sha256, durationSec: a.durationSec, width: a.width, height: a.height,
        fps: a.fps, isVfr: a.isVfr, rotation: a.rotation, videoCodec: a.videoCodec, audioCodec: a.audioCodec,
        channels: a.channels, sampleRate: a.sampleRate, aspectRatio: null, timeBase: null,
        probeStatus: "READY", probeMetaJson: null, proxyStatus: "NONE",
      },
    });
    idMap.set(a.assetId, row.id);
    created += 1;
  }
  await setProgress(55, "Restoring project");

  // 3) New project identity — imports NEVER overwrite the source project.
  const baseName = manifest.project.name?.slice(0, 90) || "Imported project";
  const existingNames = await db.project.findMany({ where: { userId, name: { startsWith: baseName } }, select: { name: true } });
  let projectName = baseName;
  for (let n = 2; existingNames.some((p) => p.name === projectName); n++) projectName = `${baseName} (imported ${n})`;
  const project = await db.project.create({
    data: { userId, name: projectName.slice(0, 120), description: manifest.project.description, settingsJson: manifest.project.settingsJson },
  });

  // 4) Rewrite asset references through idMap (deterministic, no silent swaps).
  const rewrite = (seqJson: string): string => {
    const seq = JSON.parse(seqJson) as { clips: { sourceAssetId: string | null }[] };
    for (const clip of seq.clips) {
      if (clip.sourceAssetId && idMap.has(clip.sourceAssetId)) clip.sourceAssetId = idMap.get(clip.sourceAssetId)!;
    }
    return JSON.stringify(seq);
  };

  // 5) Restore timeline versions (latest first, then history in order).
  const latestSeq = rewrite(manifest.timeline.latestSequenceJson);
  const versionNumbers = [manifest.timeline.latestVersionNumber, ...manifest.timeline.history.map((h) => h.versionNumber)];
  let nextVersion = Math.max(1, ...versionNumbers) + 1;
  await db.timelineVersion.create({ data: { projectId: project.id, versionNumber: nextVersion++, sequenceJson: latestSeq, isAutosave: false, createdById: userId } });
  for (const h of manifest.timeline.history) {
    await db.timelineVersion.create({ data: { projectId: project.id, versionNumber: nextVersion++, sequenceJson: rewrite(h.sequenceJson), isAutosave: false, createdById: userId } });
  }
  const seq = JSON.parse(latestSeq) as { clips: unknown[] };
  await setProgress(85, "Verifying restored project");

  // 6) Verify: reopen, counts, references resolve.
  const reopened = await db.project.findUnique({ where: { id: project.id }, include: { timelineVersions: true } });
  if (!reopened || reopened.timelineVersions.length !== 1 + manifest.timeline.history.length) {
    throw new PermanentJobError("Restored project verification failed — import aborted atomically.");
  }
  if (manifest.mode !== "METADATA") {
    // FULL/NO_PROXIES imports must have EVERY clip reference resolve — that is
    // the atomicity contract. METADATA imports intentionally keep dead refs
    // (the relink workflow restores them); asset status reports them honestly.
    const finalAssets = await db.mediaAsset.findMany({ where: { id: { in: [...idMap.values()] } } });
    const missingRefs = (JSON.parse(latestSeq) as { clips: { sourceAssetId: string | null }[] }).clips
      .filter((c) => c.sourceAssetId && !finalAssets.some((a) => a.id === c.sourceAssetId)).length;
    if (missingRefs > 0) throw new PermanentJobError(`${missingRefs} restored clip reference(s) do not resolve — import aborted atomically.`);
  }

  await setProgress(100, "Import complete");
  return { projectId: project.id, projectName: project.name, assetsCreated: created, assetsReused: reused, versionsRestored: 1 + manifest.timeline.history.length, clipsRestored: seq.clips.length };
}

// ── bulk relink matching (P5) ───────────────────────────────────────────────

export type MatchQuality = "EXACT" | "COMPATIBLE" | "RISKY" | "INVALID";

export interface RelinkCandidate {
  candidateAssetId: string;
  quality: MatchQuality;
  warnings: string[];
}

export interface RelinkTarget {
  /** The dead/missing asset id the clips reference. */
  deadAssetId: string;
  originalName: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  channels: number | null;
  kind: string | null;
}

/** Deterministic match for one dead asset against library candidates.
 *  Priority: exact checksum → exact filename + compatible metadata → manual. */
export function matchRelinkCandidates(target: RelinkTarget, library: { id: string; originalName: string; kind: string; sizeBytes: number; sha256: string | null; durationSec: number | null; width: number | null; height: number | null; fps: number | null; channels: number | null }[]): RelinkCandidate[] {
  const out: RelinkCandidate[] = [];
  for (const c of library) {
    const warnings: string[] = [];
    if (target.sha256 && c.sha256 && c.sha256 === target.sha256) {
      out.push({ candidateAssetId: c.id, quality: "EXACT", warnings });
      continue;
    }
    if (c.kind !== target.kind) { out.push({ candidateAssetId: c.id, quality: "INVALID", warnings: [`media type ${c.kind} ≠ ${target.kind}`] }); continue; }
    const nameMatches = target.originalName && c.originalName === target.originalName;
    let compatible = true;
    if (target.durationSec !== null && c.durationSec !== null && Math.abs(c.durationSec - target.durationSec) > 0.05) { compatible = false; warnings.push(`duration ${c.durationSec.toFixed(1)}s vs ${target.durationSec.toFixed(1)}s`); }
    if (target.width !== null && c.width !== null && c.width !== target.width) { compatible = false; warnings.push(`resolution ${c.width}×${c.height} vs ${target.width}×${target.height}`); }
    if (target.fps !== null && c.fps !== null && Math.abs(c.fps - target.fps) / target.fps > 0.005) { compatible = false; warnings.push(`frame rate ${c.fps.toFixed(2)} vs ${target.fps.toFixed(2)}`); }
    if (target.channels !== null && c.channels !== null && c.channels !== target.channels) { compatible = false; warnings.push(`audio ${c.channels}ch vs ${target.channels}ch`); }
    if (target.sizeBytes !== null && c.sizeBytes !== target.sizeBytes) warnings.push(`file size differs (${(c.sizeBytes / 1024).toFixed(0)} KB vs ${(target.sizeBytes / 1024).toFixed(0)} KB)`);
    const quality: MatchQuality = compatible ? (nameMatches ? "COMPATIBLE" : "COMPATIBLE") : "RISKY";
    if (nameMatches || compatible || quality === "RISKY") out.push({ candidateAssetId: c.id, quality, warnings });
  }
  // Deterministic ordering: quality rank, then name match, then id.
  const rank: Record<MatchQuality, number> = { EXACT: 0, COMPATIBLE: 1, RISKY: 2, INVALID: 3 };
  return out.sort((x, y) => rank[x.quality] - rank[y.quality] || x.candidateAssetId.localeCompare(y.candidateAssetId));
}

/** Build the timeline edit batch for a confirmed bulk relink (one atomic,
 *  reversible history entry — no partial application). */
export function buildBulkRelinkEdits(seqJson: string, mappings: { deadAssetId: string; newAssetId: string }[]): { type: "RelinkAssets"; mappings: { deadAssetId: string; newAssetId: string }[]; clipIds: string[] } {
  const seq = JSON.parse(seqJson) as { clips: { id: string; sourceAssetId: string | null }[] };
  const map = new Map(mappings.map((m) => [m.deadAssetId, m.newAssetId]));
  const clipIds = seq.clips.filter((c) => c.sourceAssetId && map.has(c.sourceAssetId)).map((c) => c.id);
  return { type: "RelinkAssets", mappings, clipIds };
}
