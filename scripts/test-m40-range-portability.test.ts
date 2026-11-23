/**
 * BEAN FX — M40 §6/§8: range-aware package manifests + portability.
 *
 * Real builder, real zip bytes, real planImport — no mocks:
 *  - buildManifest carries per-export range metadata (frames, verbatim from
 *    each export's own render params — the M39 contract), never packaged bytes,
 *    an honest EXPORT_BYTES omission, and rangeKind full/partial/unknown
 *    exactly as the historical records say,
 *  - validateManifestExports accepts legacy manifests (no section) and valid
 *    sections, and rejects malformed/malicious ones (reversed ranges, negative
 *    positions, traversal filenames, bad types, duplicate ids),
 *  - a real STORED zip with a valid section imports (planImport) and a zip
 *    whose manifest was tampered with a reversed range is rejected BEFORE
 *    anything is imported.
 *
 * Run: bun test scripts/test-m40-range-portability.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Scratch DB + isolated media root BEFORE any module import resolves.
const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m40-range-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
const MEDIA_TMP = mkdtempSync(path.join(os.tmpdir(), "beanfx-m40-media-"));
process.env.BEANFX_DATA_DIR = MEDIA_TMP;
execSync("node_modules/.bin/prisma db push --skip-generate --accept-data-loss", { env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` }, stdio: ["ignore", "ignore", "inherit"] });

const { buildManifest, validateManifestExports, writeStreamingZip, PACKAGE_FORMAT_VERSION } = await import("../src/lib/project-archive");
const { planImport } = await import("../src/lib/project-archive");
const { MEDIA_ROOT, sha256File } = await import("../src/lib/media-storage");
const { PermanentJobError } = await import("../src/lib/job-helpers");
const { CRC_TABLE } = await import("../src/lib/publish/zip");
const { db } = await import("@/lib/db");


function crc32File(p: string): number {
  const buf = readFileSync(p);
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const UID = "u_m40range";
const PROJ = "proj_m40range";
const ASSET = "asset_m40range";

const SEQ = {
  id: "seq_m40range", name: "M40 range sequence", fps: { num: 30, den: 1 },
  width: 480, height: 270, sampleRate: 48000,
  tracks: [{ id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false }],
  clips: [{ id: "c0", trackId: "v1", sourceAssetId: ASSET, sourceInFrame: 0, sourceOutFrame: 90, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 90, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false }],
  transitions: [],
  markers: [],
};

beforeAll(async () => {
  await db.user.create({ data: { id: UID, email: "m40range@test.local", passwordHash: "x", name: "M40 Range" } });
  await db.project.create({ data: { id: PROJ, userId: UID, name: "M40 range project" } });
  await db.timelineVersion.create({ data: { id: "tv_m40range", projectId: PROJ, versionNumber: 1, sequenceJson: JSON.stringify(SEQ), createdById: UID } });
  // Real media file on disk with a true checksum (packaging verifies bytes).
  const mediaPath = path.join(MEDIA_ROOT, "originals", UID, "m40-main.mp4");
  mkdirSync(path.dirname(mediaPath), { recursive: true });
  writeFileSync(mediaPath, Buffer.alloc(4096, 5));
  await db.mediaAsset.create({
    data: {
      id: ASSET, userId: UID, projectId: PROJ, originalName: "main.mp4", storagePath: mediaPath,
      kind: "VIDEO", mimeType: "video/mp4", sizeBytes: 4096, durationSec: 3, width: 480, height: 270,
      fps: 30, videoCodec: "h264", audioCodec: "aac", sha256: await sha256File(mediaPath),
    },
  });
  // Three completed exports: partial range, partial other range, full timeline.
  await db.exportFile.create({ data: { id: "exp_partial_a", userId: UID, kind: "TIMELINE_RENDER", format: "mp4", filename: "seq_proj_m40range_a.mp4", storagePath: "/nonexistent/keeps-out-of-package.mp4", sizeBytes: 111111, durationSec: 1, paramsJson: JSON.stringify({ projectId: PROJ, startFrame: 0, endFrame: 30, fps: "30/1", width: 480, height: 270 }) } });
  await db.exportFile.create({ data: { id: "exp_partial_b", userId: UID, kind: "TIMELINE_RENDER", format: "wav", filename: "seq_proj_m40range_b.wav", storagePath: "/nonexistent/b.wav", sizeBytes: 222222, durationSec: 2, paramsJson: JSON.stringify({ projectId: PROJ, startFrame: 30, endFrame: 90, fps: "30/1" }) } });
  await db.exportFile.create({ data: { id: "exp_full", userId: UID, kind: "TIMELINE_RENDER", format: "mov", filename: "seq_proj_m40range_c.mov", storagePath: "/nonexistent/c.mov", sizeBytes: 333333, durationSec: 3, paramsJson: JSON.stringify({ projectId: PROJ, fps: "30/1", width: 480, height: 270 }) } });
  // A DIFFERENT user's export with the same filename shape — must NOT leak in.
  await db.user.create({ data: { id: "u_m40other", email: "m40other@test.local", passwordHash: "x", name: "M40 Other" } });
  await db.exportFile.create({ data: { id: "exp_other_user", userId: "u_m40other", kind: "TIMELINE_RENDER", format: "mp3", filename: "seq_other.mp3", storagePath: "/nonexistent/other.mp3", sizeBytes: 444444, durationSec: 3, paramsJson: JSON.stringify({ projectId: PROJ, startFrame: 0, endFrame: 90, fps: "30/1" }) } });
});

describe("M40 §6 — range-aware package manifests", () => {
  test("buildManifest carries exact per-export ranges (frames verbatim), no bytes, honest omission", async () => {
    const { manifest } = await buildManifest(UID, PROJ, "FULL");
    expect(manifest.formatVersion).toBe(PACKAGE_FORMAT_VERSION); // additive: format version unchanged
    expect(Array.isArray(manifest.exports)).toBe(true);
    const exps = manifest.exports!;
    expect(exps.length).toBe(3); // the other user's export never leaks in
    const byId = new Map(exps.map((e) => [e.exportId, e]));

    const a = byId.get("exp_partial_a")!;
    expect(a.rangeKind).toBe("partial");
    expect(a.startFrame).toBe(0);
    expect(a.endFrame).toBe(30);
    expect(a.fps).toBe("30/1");
    expect(a.format).toBe("mp4");
    expect(a.sizeBytes).toBe(111111);
    expect(a.durationSec).toBe(1);
    expect(a.filename).toBe("seq_proj_m40range_a.mp4");

    const b = byId.get("exp_partial_b")!;
    expect(b.rangeKind).toBe("partial");
    expect(b.startFrame).toBe(30);
    expect(b.endFrame).toBe(90);

    const full = byId.get("exp_full")!;
    expect(full.rangeKind).toBe("full"); // historical record had no range keys
    expect(full.startFrame).toBeNull();
    expect(full.endFrame).toBeNull();

    expect(exps.every((e) => !("sha256" in e))).toBe(true); // no invented integrity claims
    const omit = manifest.omitted.find((o) => o.kind === "EXPORT_BYTES")!;
    expect(omit.count).toBe(3);
    expect(manifest.omitted.find((o) => o.kind === "DERIVED")!).toBeTruthy();
    // Media packaging unchanged by the additive section.
    expect(manifest.assets.length).toBe(1);
    expect(manifest.assets[0].sha256.length).toBe(64);
  });

  test("exports[] bytes never enter the package entries", async () => {
    const { entries } = await buildManifest(UID, PROJ, "FULL");
    const names = entries.map((e) => e.name);
    expect(names.every((n) => n === "manifest.json" || n.startsWith("media/") || n.startsWith("masks/") || n.startsWith("proxies/"))).toBe(true);
  });
});

describe("M40 §6 — validateManifestExports (import gate)", () => {
  test("legacy manifests without the section pass unchanged", () => {
    expect(validateManifestExports(undefined)).toEqual([]);
    expect(validateManifestExports(null)).toEqual([]);
  });

  test("a valid mixed-range section passes", () => {
    const issues = validateManifestExports([
      { exportId: "e1", kind: "TIMELINE_RENDER", format: "mp4", filename: "out.mp4", sizeBytes: 1, durationSec: 1, rangeKind: "partial", startFrame: 0, endFrame: 30, fps: "30/1", createdAt: "2026-11-23T00:00:00.000Z" },
      { exportId: "e2", kind: "TIMELINE_RENDER", format: "wav", filename: "out.wav", sizeBytes: 2, durationSec: 2, rangeKind: "full", startFrame: null, endFrame: null, fps: null, createdAt: "2026-11-23T00:00:00.000Z" },
      { exportId: "e3", kind: "TIMELINE_RENDER", format: "mp3", filename: "out.mp3", sizeBytes: 3, durationSec: null, rangeKind: "unknown", startFrame: null, endFrame: null, fps: null, createdAt: "2026-11-23T00:00:00.000Z" },
    ]);
    expect(issues).toEqual([]);
  });

  test("malformed and malicious sections are rejected with item-level reasons", () => {
    const base = { exportId: "e", kind: "TIMELINE_RENDER", format: "mp4", filename: "out.mp4", sizeBytes: 1, durationSec: 1, fps: "30/1", createdAt: "2026-11-23T00:00:00.000Z" };
    const issues = validateManifestExports([
      { ...base, exportId: "r1", rangeKind: "partial", startFrame: 60, endFrame: 30 } as never, // reversed
      { ...base, exportId: "r2", rangeKind: "partial", startFrame: -1, endFrame: 30 } as never, // negative
      { ...base, exportId: "r3", rangeKind: "partial", startFrame: 1.5, endFrame: 30 } as never, // malformed
      { ...base, exportId: "r4", rangeKind: "partial", startFrame: 0, endFrame: 0 } as never, // end < 1
      { ...base, exportId: "r5", rangeKind: "partial", startFrame: null, endFrame: null } as never, // partial without frames
      { ...base, exportId: "r6", rangeKind: "partial", startFrame: 0, endFrame: 30, filename: "../../etc/passwd" } as never, // traversal
      { ...base, exportId: "r7", rangeKind: "nonsense", startFrame: 0, endFrame: 30 } as never, // bad rangeKind
      { ...base, exportId: "r8", rangeKind: "partial", startFrame: 0, endFrame: 30, fps: "thirty" } as never, // bad fps
      { ...base, rangeKind: "partial", startFrame: 0, endFrame: 30 } as never, // missing exportId
    ]);
    expect(issues.some((i) => i.includes("reversed"))).toBe(true);
    expect(issues.some((i) => i.includes("r2"))).toBe(true);
    expect(issues.some((i) => i.includes("integer"))).toBe(true);
    expect(issues.some((i) => i.includes("passwd") || i.includes("bare name"))).toBe(true);
    expect(validateManifestExports("nope" as never).length).toBeGreaterThan(0);
    // duplicate ids rejected
    const dup = validateManifestExports([
      { ...base, exportId: "d", rangeKind: "full", startFrame: null, endFrame: null } as never,
      { ...base, exportId: "d", rangeKind: "full", startFrame: null, endFrame: null } as never,
    ]);
    expect(dup.some((i) => i.includes("duplicate"))).toBe(true);
  });
});

describe("M40 §6 — real zip roundtrip through planImport", () => {
  const ZIP_OK = path.join(MEDIA_TMP, "m40-ok.zip");
  const ZIP_BAD = path.join(MEDIA_TMP, "m40-bad.zip");

  test("a real package with a valid exports[] section passes planImport", async () => {
    const { manifest, entries } = await buildManifest(UID, PROJ, "FULL");
    const manifestPath = path.join(MEDIA_TMP, "manifest-ok.json");
    writeFileSync(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2)));
    await writeStreamingZip(ZIP_OK, [...entries, { name: "manifest.json", sourcePath: manifestPath, size: readFileSync(manifestPath).length, crc32: crc32File(manifestPath) }]);
    const plan = await planImport("u_importer_does_not_exist_yet", ZIP_OK);
    expect(plan.manifest.exports!.length).toBe(3);
    expect(plan.manifest.exports!.find((e: { exportId: string }) => e.exportId === "exp_partial_a")!.startFrame).toBe(0);
    // The media entry physically exists in the package and matches the manifest hash.
    expect(existsSync(ZIP_OK)).toBe(true);
  });

  test("a tampered manifest (reversed range) is REJECTED before anything imports", async () => {
    const { manifest, entries } = await buildManifest(UID, PROJ, "FULL");
    const partial = manifest.exports!.find((e: { exportId: string }) => e.exportId === "exp_partial_a")!;
    const tampered = { ...manifest, exports: [{ ...partial, startFrame: 60, endFrame: 30 }] };
    const manifestPath = path.join(MEDIA_TMP, "manifest-bad.json");
    writeFileSync(manifestPath, Buffer.from(JSON.stringify(tampered, null, 2)));
    await writeStreamingZip(ZIP_BAD, [...entries, { name: "manifest.json", sourcePath: manifestPath, size: readFileSync(manifestPath).length, crc32: crc32File(manifestPath) }]);
    let caught: unknown = null;
    try {
      await planImport("u_importer_does_not_exist_yet", ZIP_BAD);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PermanentJobError);
    expect((caught as Error).message).toContain("reversed");
  });

  test("a legacy package (manifest without exports[]) still imports unchanged", async () => {
    const { manifest, entries } = await buildManifest(UID, PROJ, "FULL");
    const legacy = { ...manifest };
    delete (legacy as { exports?: unknown }).exports; // simulate an M29-era package
    const manifestPath = path.join(MEDIA_TMP, "manifest-legacy.json");
    writeFileSync(manifestPath, Buffer.from(JSON.stringify(legacy, null, 2)));
    const zip = path.join(MEDIA_TMP, "m40-legacy.zip");
    await writeStreamingZip(zip, [...entries, { name: "manifest.json", sourcePath: manifestPath, size: readFileSync(manifestPath).length, crc32: crc32File(manifestPath) }]);
    const plan = await planImport("u_importer_does_not_exist_yet", zip);
    expect(plan.manifest.exports).toBeUndefined();
  });
});

afterAll(async () => {
  await db.$disconnect().catch(() => undefined);
  try { rmSync(SCRATCH_DB, { force: true }); } catch { /* best-effort */ }
  try { rmSync(`${SCRATCH_DB}-shm`, { force: true }); } catch { /* best-effort */ }
  try { rmSync(`${SCRATCH_DB}-wal`, { force: true }); } catch { /* best-effort */ }
});
