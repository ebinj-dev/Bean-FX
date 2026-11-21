/**
 * M32 Track B — multi-format campaign variants.
 * Proves: reframing math (focal/center/clamp/crop-loss), generic safe-area
 * validation, derivation from an APPROVED master with REAL fixture media,
 * timing preservation, master immutability, duplicate/own-aspect/non-completed
 * refusals.
 * Run: bun test scripts/test-m32-variants.test.ts
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m32-var-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
execSync("bunx prisma db push --skip-generate --accept-data-loss", { env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` }, stdio: ["ignore", "ignore", "ignore"] });

const { computeReframe, validateSafeAreas, deriveVariant, aspectToDims } = await import("../src/lib/production/variants");
const { getTimelineHead, applyTimelineEdits } = await import("../src/lib/editor/persistence");
const { registerImageArtifact } = await import("../src/lib/ai/asset-lifecycle");
const { db } = await import("../src/lib/db");

describe("M32 — reframing math (deterministic)", () => {
  test("16:9 → 9:16 cover: scale = 16/9; center when no focal evidence; crop loss computed", () => {
    const r = computeReframe({ masterW: 1920, masterH: 1080, targetW: 1080, targetH: 1920, focalPct: null });
    expect(r.scale).toBeCloseTo(1920 / 1080, 4);
    expect(r.strategy).toBe("center");
    expect(r.offsetX).toBe(0);
    expect(r.cropLossPct).toBeGreaterThan(0.6); // 16:9 → 9:16 crops most of the width
    expect(r.warnings.join(" ")).toContain("Center framing");
  });
  test("focal point guides the window; kept inside the frame by clamping", () => {
    // Focal at x=0.25 (left quarter): window must shift LEFT to keep it.
    const r = computeReframe({ masterW: 1920, masterH: 1080, targetW: 1080, targetH: 1920, focalPct: { x: 0.25, y: 0.5 } });
    expect(r.strategy).toBe("focal");
    expect(r.offsetX).toBeLessThan(0); // window moves left
    // focal target position = 0.25*3413 + offsetX stays within the target width
    const scaledW = 1920 * r.scale;
    const focalTargetX = 0.25 * scaledW + r.offsetX;
    expect(focalTargetX).toBeGreaterThanOrEqual(0);
    expect(focalTargetX).toBeLessThanOrEqual(1080);
  });
  test("focal clamping near edges warns honestly", () => {
    const r = computeReframe({ masterW: 1920, masterH: 1080, targetW: 1080, targetH: 1920, focalPct: { x: 0.9, y: 0.5 } });
    expect(r.warnings.join(" ")).toContain("manual framing");
  });
  test("1:1 from 16:9 crops less than 9:16", () => {
    const r1 = computeReframe({ masterW: 1920, masterH: 1080, targetW: 1080, targetH: 1080, focalPct: null });
    const r2 = computeReframe({ masterW: 1920, masterH: 1080, targetW: 1080, targetH: 1920, focalPct: null });
    expect(r1.cropLossPct).toBeLessThan(r2.cropLossPct);
  });
  test("aspect dims per format/resolution", () => {
    expect(aspectToDims("9:16", "1080p")).toEqual({ width: 1080, height: 1920 });
    expect(aspectToDims("16:9", "720p")).toEqual({ width: 1280, height: 720 });
    expect(aspectToDims("1:1", "1080p")).toEqual({ width: 1080, height: 1080 });
  });
});

describe("M32 — safe areas (GENERIC margins, not platform specs)", () => {
  test("overflowing graphic text flagged with honest detail", () => {
    const issues = validateSafeAreas([], [{ sceneKey: "s1", text: "A VERY LONG HEADLINE THAT CANNOT POSSIBLY FIT IN THE SAFE AREA OF ANY FORMAT", anchor: "LOWER_LEFT", offsetX: 6, offsetY: 8, primarySizePct: 6 }], [], "16:9");
    expect(issues.length).toBe(1);
    expect(issues[0].kind).toBe("text-overflow");
    expect(issues[0].detail).toContain("safe area");
  });
  test("short text within margins passes", () => {
    const issues = validateSafeAreas([], [{ sceneKey: "s1", text: "Bean FX", anchor: "LOWER_LEFT", offsetX: 6, offsetY: 8, primarySizePct: 4.2 }], [], "1:1");
    expect(issues.length).toBe(0);
  });
  test("9:16 bottom captions warn (no invented platform specs)", () => {
    const issues = validateSafeAreas([], [], [{ sceneKey: "s1", text: "caption line", position: "BOTTOM" }], "9:16");
    expect(issues.some((i) => i.kind === "caption-position")).toBe(true);
    expect(issues[0].detail).toContain("no invented platform specs");
  });
});

describe("M32 — derivation from an approved master (real fixture media)", () => {
  let userId: string; let masterProdId: string; let masterProjectId: string; let masterStoryboardJson: string; let mediaId: string;
  beforeAll(async () => {
    const user = await db.user.create({ data: { email: `m32v-${Date.now().toString(36)}@t.local`, name: "V", passwordHash: "x", emailVerified: true } });
    userId = user.id;
    // REAL fixture image asset (PIL) through the honest registration path.
    const img = path.join(os.tmpdir(), `m32v-${Date.now().toString(36)}.png`);
    execSync(`python3 -c "
from PIL import Image, ImageDraw
im = Image.new('RGB', (1920, 1080), (18, 18, 18))
d = ImageDraw.Draw(im)
d.ellipse([700, 300, 1220, 780], fill=(212, 160, 23))
im.save('${img}')"`);
    fs.mkdirSync(path.join(os.tmpdir(), `m32vdata-${Date.now().toString(36)}`), { recursive: true });
    const registered = await registerImageArtifact(img, {
      engine: "SHOWCASE", userId, projectId: null,
      originalName: "master-frame.png", provider: "fixture-pil", model: "none",
      prompt: "M32 variant derivation fixture", params: {}, license: "test-fixture",
      width: 1920, height: 1080,
    });
    mediaId = registered.id;
    const project = await db.project.create({ data: { userId, name: "M32 master", settingsJson: JSON.stringify({ fpsNum: 30, fpsDen: 1, width: 1920, height: 1080, sampleRate: 48000 }) } });
    masterProjectId = project.id;
    const storyboard = { scenes: [{ sceneKey: "scene-1", sceneNumber: 1, durationSec: 3, requiredAssetKind: "user_media", approval: "APPROVED" }] };
    masterStoryboardJson = JSON.stringify(storyboard);
    masterProdId = (await db.production.create({ data: { userId, templateId: "showcase-studio", title: "M32 master", status: "COMPLETED", projectId: masterProjectId, briefJson: JSON.stringify({ aspectRatio: "16:9", resolution: "1080p", fps: 30 }), storyboardJson: masterStoryboardJson, scriptJson: "{}", conceptJson: "{}" } })).id;
    // Real master timeline: ONE 3s clip (90 frames @30fps) of the fixture.
    const head = await getTimelineHead(masterProjectId, userId);
    await applyTimelineEdits(masterProjectId, userId, head.version, [
      { type: "AddTrack", track: { id: "mv1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
      { type: "AddClip", clip: { id: "mc1", trackId: "mv1", sourceAssetId: mediaId, sourceInFrame: 0, sourceOutFrame: 90, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 90, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [] } },
    ] as never, false);
  }, 120_000);

  test("deriving 9:16 + 1:1 creates NEW native sequences with reframed transforms; master untouched", async () => {
    const before = await db.production.findUnique({ where: { id: masterProdId } });
    for (const format of ["9:16", "1:1"] as const) {
      const r = await deriveVariant(masterProdId, userId, format);
      expect(r.variantId).toBeTruthy();
      expect(r.projectId).not.toBe(masterProjectId);
      const vh = await getTimelineHead(r.projectId, userId);
      const vseq = vh.sequence as unknown as { width: number; height: number; clips: Array<{ id: string; timelineStartFrame: number; timelineDurationFrames: number; transform?: { scale: number; x: number } }> };
      // native sequence at the TARGET dimensions
      const dims = aspectToDims(format, "1080p");
      expect(vseq.width).toBe(dims.width);
      expect(vseq.height).toBe(dims.height);
      // ONE clip, same frame position (timing preserved)
      expect(vseq.clips.length).toBe(1);
      expect(vseq.clips[0].timelineStartFrame).toBe(0);
      expect(vseq.clips[0].timelineDurationFrames).toBe(90);
      // reframed transform: cover scale for the format
      const expectedScale = format === "9:16" ? 1920 / 1080 : 1.0;
      expect(vseq.clips[0].transform?.scale).toBeCloseTo(expectedScale, 3);
      // variant row exists with safe-area report
      const row = await db.productionVariant.findUnique({ where: { productionId_format: { productionId: masterProdId, format } } });
      expect(row?.status).toBe("READY");
      expect(JSON.parse(row!.safeAreaJson!)["note"]).toContain("not a platform specification");
    }
    // MASTER IMMUTABILITY: storyboard/script/concept/status byte-identical.
    const after = await db.production.findUnique({ where: { id: masterProdId } });
    expect(after?.storyboardJson).toBe(before?.storyboardJson);
    expect(after?.scriptJson).toBe(before?.scriptJson);
    expect(after?.conceptJson).toBe(before?.conceptJson);
    expect(after?.status).toBe("COMPLETED");
    // master timeline untouched (same single clip, scale 1)
    const mh = await getTimelineHead(masterProjectId, userId);
    const mseq = mh.sequence as unknown as { clips: Array<{ transform: { scale: number } }> };
    expect(mseq.clips.length).toBe(1);
    expect(mseq.clips[0].transform.scale).toBe(1);
  }, 120_000);

  test("duplicate format derivation refused; master's own aspect refused", async () => {
    await expect(deriveVariant(masterProdId, userId, "9:16")).rejects.toThrow(/already exists/);
    await expect(deriveVariant(masterProdId, userId, "16:9")).rejects.toThrow(/master's own aspect/);
  });
  test("non-COMPLETED master refused", async () => {
    const p = await db.production.create({ data: { userId, templateId: "showcase-studio", title: "NotDone", status: "RUNNING", projectId: masterProjectId } });
    await expect(deriveVariant(p.id, userId, "9:16")).rejects.toThrow(/not COMPLETED/);
  });
  test("manual focal override changes the framing window (focal strategy)", async () => {
    const prod2 = await db.production.create({ data: { userId, templateId: "showcase-studio", title: "M32 master 2", status: "COMPLETED", projectId: masterProjectId, briefJson: JSON.stringify({ aspectRatio: "16:9", resolution: "1080p", fps: 30 }), storyboardJson: masterStoryboardJson, scriptJson: "{}", conceptJson: "{}" } });
    const r = await deriveVariant(prod2.id, userId, "9:16", { manualFraming: { default: { focalPct: { x: 0.2, y: 0.5 } } } });
    expect(r.reframe.strategy).toBe("focal");
    expect(r.reframe.offsetX).toBeLessThan(0);
    const row = await db.productionVariant.findUnique({ where: { productionId_format: { productionId: prod2.id, format: "9:16" } } });
    const framing = JSON.parse(row!.framingJson!);
    expect(framing.manual["default"].focalPct.x).toBe(0.2);
  }, 60_000);
});
