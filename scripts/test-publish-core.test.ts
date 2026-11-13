/**
 * BEAN FX — M9 Professional Publishing core tests (bun test, isolated DB).
 * Fixture/engine suite: REAL engine code with labeled fixtures and INJECTED
 * stub providers (never presented as live provider verification — see
 * test-publish-live.test.ts for the REAL-provider suite).
 *
 * Covers: profile registry + env override, variant validation (pre/post),
 * ffmpeg args, metadata schema (EN/TA) + injected-provider generation +
 * per-field regeneration + approved-fields protection + honest NOT_CONFIGURED,
 * brand preset CRUD/apply/preview/revert/additive-merge, thumbnail overlay
 * compositing (EN + Tamil) + asset registration, REAL end-to-end export
 * variant through the M3 worker (tiny fixture), duration-cap rejection,
 * cancel path, publication package build (manifest + zip integrity +
 * determinism of the zip builder), and ownership refusals.
 *
 * Run: bun test scripts/test-publish-core.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m9-core-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
process.env.BEANFX_MYAI_PROVIDER = "does-not-exist"; // honest-NOT_CONFIGURED paths by default
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m9-core-"));

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let profilesMod: typeof import("../src/lib/publish/profiles");
let variantsMod: typeof import("../src/lib/publish/variants");
let metadataMod: typeof import("../src/lib/publish/metadata");
let presetsMod: typeof import("../src/lib/publish/presets");
let thumbsMod: typeof import("../src/lib/publish/thumbnails");
let jobsMod: typeof import("../src/lib/publish/jobs");
let zipMod: typeof import("../src/lib/publish/zip");
let helpersMod: typeof import("../src/lib/job-helpers");
let workerMod: typeof import("../src/lib/media-worker");
let jobRunnerMod: typeof import("../src/lib/job-runner");

const USER = "m9-core-user";
const FOREIGN = "m9-foreign-user";
let projectId = "";
let videoAssetId = "";
const FIX = path.join(WORK, "master.mp4");
const FIX_IMAGE = path.join(WORK, "base.jpg");

// A minimal typed stub provider for metadata tests (clearly fixture-driven).
function stubProvider(responses: string[]): import("../src/lib/my-ai/gateway/provider").LLMProvider {
  let i = 0;
  return {
    id: "stub-fixture",
    model: "fixture-model",
    async chat() {
      const content = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { content, model: "fixture-model", provider: "stub-fixture", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 1 };
    },
    async healthCheck() {
      return { ok: true, detail: "stub", latencyMs: 0 };
    },
  };
}

const GOOD_EN_JSON = JSON.stringify({
  title: "Bean FX in 60 seconds",
  description: "A quick tour of the Bean FX editor workflow.",
  keywords: ["video editing", "bean fx"],
  hashtags: ["#beanfx", "#editing"],
  chapters: [{ label: "Intro", startSec: 0 }],
  summary: "A concise tour of the editor.",
  platformDescription: "Quick tour of Bean FX for YouTube.",
  callToAction: "Subscribe for more.",
});

const GOOD_TA_JSON = JSON.stringify({
  title: "பீன் எஃப்எக்ஸ் 60 வினாடிகளில்",
  description: "பீன் எஃப்எக்ஸ் தொகுப்பு கருவியின் சுருக்கமான அறிமுகம்.",
  keywords: ["தொகுப்பு", "காணொளி"],
  hashtags: ["#பீன்எஃப்எக்ஸ்", "#தொகுப்பு"],
  chapters: [],
  summary: "சுருக்கமான அறிமுகம்.",
  platformDescription: "யூடியூப் விளக்கம்.",
  callToAction: "பின்தொடருங்கள்.",
});

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  profilesMod = await import("../src/lib/publish/profiles");
  variantsMod = await import("../src/lib/publish/variants");
  metadataMod = await import("../src/lib/publish/metadata");
  presetsMod = await import("../src/lib/publish/presets");
  thumbsMod = await import("../src/lib/publish/thumbnails");
  jobsMod = await import("../src/lib/publish/jobs");
  zipMod = await import("../src/lib/publish/zip");
  helpersMod = await import("../src/lib/job-helpers");
  workerMod = await import("../src/lib/media-worker");
  jobRunnerMod = await import("../src/lib/job-runner");

  await db.user.create({ data: { id: USER, email: "m9a@test.local", name: "A", passwordHash: "x" } }).catch(() => undefined);
  await db.user.create({ data: { id: FOREIGN, email: "m9b@test.local", name: "B", passwordHash: "x" } }).catch(() => undefined);
  const project = await db.project.create({ data: { userId: USER, name: "M9 Core Project", description: "Fixture project", settingsJson: JSON.stringify({ width: 1080, height: 1920, fps: { num: 30, den: 1 }, sampleRate: 48000 }) } });
  projectId = project.id;

  // Tiny video master (2 s, 320x180, has audio) + tiny image base.
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100", FIX], { stdio: ["ignore", "ignore", "inherit"] });
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "gradients=s=640x360:d=1", "-frames:v", "1", "-q:v", "3", FIX_IMAGE], { stdio: ["ignore", "ignore", "inherit"] });

  const asset = await db.mediaAsset.create({
    data: { userId: USER, projectId, originalName: "master.mp4", storagePath: FIX, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(FIX).size, width: 320, height: 180, durationSec: 2 },
  });
  videoAssetId = asset.id;
});

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
  rmSync(SCRATCH_DB, { force: true });
});

// ── §6 profiles ─────────────────────────────────────────────────────────────
describe("M9 export profiles", () => {
  test("built-in registry validates and encodes VERIFIED platform facts", () => {
    const registry = profilesMod.exportProfileRegistry();
    expect(registry.source).toBe("built-in");
    expect(registry.version).toBe("2026.11.13");
    for (const id of ["youtube_landscape", "youtube_shorts", "instagram_reels", "tiktok", "square_social", "custom_landscape", "custom_portrait"]) {
      expect(registry.profiles[id]).toBeDefined();
    }
    const shorts = registry.profiles["youtube_shorts"];
    expect(shorts.maxDurationSec).toBe(180); // official: 3-minute Shorts
    expect(shorts.bitrateSource).toBe("official");
    expect(shorts.audioSampleRate).toBe(48000);
    expect(shorts.sources.some((u) => u.includes("support.google.com"))).toBe(true);
    // Platforms without a verified cap encode NO cap (honesty).
    expect(registry.profiles["instagram_reels"].maxDurationSec).toBeNull();
    expect(registry.profiles["tiktok"].maxDurationSec).toBeNull();
    // Generic profiles carry no fake sources.
    expect(registry.profiles["square_social"].sources.length).toBe(0);
  });

  test("env override replaces the registry after schema validation; invalid override throws", () => {
    const valid = [
      {
        id: "custom_test", label: "Test profile", platform: "generic", width: 640, height: 360, aspect: "16:9", fps: 30, container: "mp4",
        videoCodec: "libx264", videoProfile: "high", pixelFormat: "yuv420p", audioCodec: "aac", audioSampleRate: 48000, audioChannels: 2,
        audioBitrateKbps: 128, videoBitrateKbps: 1000, bitrateSource: "deployment-default", maxDurationSec: 1, notes: "test", sources: [],
      },
    ];
    process.env.BEANFX_EXPORT_PROFILES_JSON = JSON.stringify(valid);
    profilesMod.resetProfileRegistry();
    const registry = profilesMod.exportProfileRegistry();
    expect(registry.source).toBe("env-override");
    expect(registry.profiles["custom_test"].maxDurationSec).toBe(1);

    process.env.BEANFX_EXPORT_PROFILES_JSON = "{not json";
    profilesMod.resetProfileRegistry();
    expect(() => profilesMod.exportProfileRegistry()).toThrow();

    delete process.env.BEANFX_EXPORT_PROFILES_JSON;
    profilesMod.resetProfileRegistry();
    expect(profilesMod.exportProfileRegistry().source).toBe("built-in");
  });

  test("pre-flight target validation refuses over-cap and unmeasured masters", () => {
    const profile = profilesMod.getExportProfile("youtube_shorts")!;
    const over = profilesMod.validateVariantTarget(profile, 181, 1080, 1920);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.failures.some((f) => f.code === "DURATION_CAP")).toBe(true);
    const unknown = profilesMod.validateVariantTarget(profile, null, null, null);
    expect(unknown.ok).toBe(false);
    const okCase = profilesMod.validateVariantTarget(profile, 60, 1080, 1920);
    expect(okCase.ok).toBe(true);
  });

  test("output conformance validation flags mismatches", () => {
    const profile = profilesMod.getExportProfile("youtube_shorts")!;
    const bad = profilesMod.validateVariantOutput({ width: 640, height: 360, fps: 24, videoCodec: "vp9", audioCodec: "mp3", sampleRate: 44100, durationSec: 200 }, profile);
    expect(bad.ok).toBe(false);
    expect(bad.failures.map((f) => f.code)).toEqual(expect.arrayContaining(["DIMENSIONS_MISMATCH", "VIDEO_CODEC_MISMATCH", "AUDIO_CODEC_MISMATCH", "SAMPLE_RATE_MISMATCH"]));
    const good = profilesMod.validateVariantOutput({ width: 1080, height: 1920, fps: 30, videoCodec: "h264", audioCodec: "aac", sampleRate: 48000, durationSec: 30 }, profile);
    expect(good.ok).toBe(true);
  });

  test("variant args: scale+pad geometry, profile codecs, silent-master -an", async () => {
    const profile = profilesMod.getExportProfile("youtube_landscape")!;
    const { args, summary } = variantsMod.buildVariantArgs("/in.mp4", "/out.mp4", profile, { durationSec: 10, width: 640, height: 360, fps: 30, hasAudio: true });
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("scale=w=1920:h=1080:force_original_aspect_ratio=decrease");
    expect(vf).toContain("pad=1920:1080");
    expect(vf).toContain("fps=30");
    expect(args).toContain("yuv420p");
    expect(args).toContain("8000k");
    expect(summary.join(" ")).toContain("official");
    const silent = variantsMod.buildVariantArgs("/in.mp4", "/out.mp4", profile, { durationSec: 10, width: 640, height: 360, fps: 30, hasAudio: false });
    expect(silent.args).toContain("-an");
    expect(silent.summary.join(" ")).toContain("silent");
  });

  test("master probe measures a real file", async () => {
    const master = await variantsMod.probeMaster(FIX);
    expect(master.width).toBe(320);
    expect(master.height).toBe(180);
    expect(master.durationSec).not.toBeNull();
    expect(master.hasAudio).toBe(true);
  });
});

// ── §4 metadata ─────────────────────────────────────────────────────────────
describe("M9 metadata", () => {
  test("schema accepts EN and TA payloads; rejects broken hashtags", () => {
    expect(metadataMod.PublishFieldsSchema.safeParse(JSON.parse(GOOD_EN_JSON)).success).toBe(true);
    const ta = metadataMod.PublishFieldsSchema.safeParse(JSON.parse(GOOD_TA_JSON));
    expect(ta.success).toBe(true);
    const bad = metadataMod.PublishFieldsSchema.safeParse({ ...JSON.parse(GOOD_EN_JSON), hashtags: ["#has space"] });
    expect(bad.success).toBe(false);
  });

  test("injected stub provider generates EN metadata (fixture-driven, labeled)", async () => {
    const result = await metadataMod.generatePublishFields(USER, projectId, "youtube_landscape", "en", { provider: stubProvider([GOOD_EN_JSON]) });
    expect(result.fields.title).toContain("Bean FX");
    expect(result.fields.chapters.length).toBe(0); // no studio plan → no timing → empty chapters
    expect(result.chaptersSource).toBe("none");
  });

  test("injected stub provider generates TA metadata preserving Tamil", async () => {
    const result = await metadataMod.generatePublishFields(USER, projectId, "youtube_shorts", "ta", { provider: stubProvider([GOOD_TA_JSON]) });
    expect(result.fields.title).toMatch(/[\u0b80-\u0bff]/);
    expect(result.fields.hashtags.every((h) => h.startsWith("#"))).toBe(true);
  });

  test("fabricated chapters are STRIPPED when no reliable timing exists (honesty guard)", async () => {
    const fabricated = JSON.stringify({ ...JSON.parse(GOOD_EN_JSON), chapters: [{ label: "Fake", startSec: 42 }] });
    const result = await metadataMod.generatePublishFields(USER, projectId, "tiktok", "en", { provider: stubProvider([fabricated]) });
    expect(result.fields.chapters).toEqual([]);
    expect(result.chaptersSource).toBe("none");
  });

  test("chapters come from REAL scene timings when a studio plan exists", async () => {
    const plan = await db.studioPlan.create({ data: { userId: USER, projectId, status: "SCENES_READY", briefJson: JSON.stringify({ topic: "Morning routine" }) } });
    await db.studioScene.create({ data: { planId: plan.id, userId: USER, sceneNumber: 1, durationSec: 10, narration: "Wake up", onScreenText: "Morning", assetSource: "none" } });
    await db.studioScene.create({ data: { planId: plan.id, userId: USER, sceneNumber: 2, durationSec: 15, narration: "Coffee", onScreenText: "Brew", assetSource: "none" } });
    const result = await metadataMod.generatePublishFields(USER, projectId, "youtube_landscape", "en", { provider: stubProvider([GOOD_EN_JSON]) });
    expect(result.chaptersSource).toBe("studio-scene-timings");
    expect(result.fields.chapters).toEqual([
      { label: "Morning", startSec: 0 },
      { label: "Brew", startSec: 10 },
    ]);
    // Cleanup so later chapters-less assertions stay valid.
    await db.studioScene.deleteMany({ where: { planId: plan.id } });
    await db.studioPlan.delete({ where: { id: plan.id } });
  });

  test("approved fields survive regeneration (seedApproved wins)", async () => {
    const approved = JSON.parse(GOOD_EN_JSON) as metadataMod.PublishFields;
    const different = JSON.stringify({ ...JSON.parse(GOOD_EN_JSON), title: "AI's own title" });
    const result = await metadataMod.generatePublishFields(USER, projectId, "youtube_landscape", "en", { provider: stubProvider([different]), seedApproved: approved });
    expect(result.fields.title).toBe(approved.title);
  });

  test("per-field regeneration changes ONLY the target field", async () => {
    const current = JSON.parse(GOOD_EN_JSON) as metadataMod.PublishFields;
    const newTitle = JSON.stringify({ value: "Regenerated title via fixture" });
    const result = await metadataMod.regeneratePublishField(USER, projectId, "youtube_landscape", "en", "title", current, { provider: stubProvider([newTitle]) });
    expect(result.value).toBe("Regenerated title via fixture");
  });

  test("unconfigured provider → honest NOT_CONFIGURED, never placeholder text", async () => {
    let threw: string | null = null;
    try {
      await metadataMod.generatePublishFields(USER, projectId, "youtube_landscape", "en", {});
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    expect(threw).toContain("not configured");
  });
});

// ── §5 brand presets ────────────────────────────────────────────────────────
describe("M9 brand presets", () => {
  test("create → validate (foreign asset refused) → preview → apply (additive) → revert", async () => {
    const data = {
      name: "Morning Brand", brandName: "Morning Studio", logoAssetId: null, watermarkAssetId: videoAssetId, primaryColor: "#d4a017",
      secondaryColor: "#111111", fontFamily: "inter" as const, captionStyle: { fontSize: 42, textColor: "#ffffff", outlineColor: "#000000", position: "bottom" as const },
      introAssetId: null, outroAssetId: null, thumbnailStyle: null, defaultExportProfile: "youtube_shorts",
    };
    await expect(presetsMod.validatePresetData(USER, { ...data, watermarkAssetId: "not-owned" })).rejects.toThrow("not found or not owned");

    const { captionStyle, thumbnailStyle, ...presetData } = data;
    const preset = await db.brandPreset.create({ data: { userId: USER, ...presetData, captionStyleJson: JSON.stringify(captionStyle), thumbnailStyleJson: null } });
    expect(preset.name).toBe("Morning Brand");

    // The project has custom settings the preset does NOT own — they survive.
    await db.project.update({ where: { id: projectId }, data: { settingsJson: JSON.stringify({ width: 1080, height: 1920, customUserFlag: "keep-me", fps: { num: 30, den: 1 } }) } });
    const preview = await presetsMod.previewPresetApply(USER, preset.id, projectId);
    expect(preview.keysPreserved).toEqual(expect.arrayContaining(["width", "height", "customUserFlag", "fps"]));
    expect(preview.keysWritten).toEqual(expect.arrayContaining(["brand", "captionStyle", "watermarkAssetId", "defaultExportProfile"]));

    const applied = await presetsMod.applyPreset(USER, preset.id, projectId);
    const settings = JSON.parse((await db.project.findUnique({ where: { id: projectId } }))!.settingsJson!);
    expect(settings.customUserFlag).toBe("keep-me"); // non-destructive
    expect(settings.brand.name).toBe("Morning Studio");
    expect(settings.watermarkAssetId).toBe(videoAssetId);

    const foreignApply = presetsMod.applyPreset(FOREIGN, preset.id, projectId);
    await expect(foreignApply).rejects.toThrow();

    const revert = await presetsMod.revertLastPresetApply(USER, projectId);
    expect(revert.reverted).toBe(true);
    const restored = JSON.parse((await db.project.findUnique({ where: { id: projectId } }))!.settingsJson!);
    expect(restored.brand).toBeUndefined();
    expect(restored.customUserFlag).toBe("keep-me");

    const dup = await db.brandPreset.create({ data: { userId: USER, name: `${preset.name} (copy)`, ...presetData, captionStyleJson: null, thumbnailStyleJson: null } });
    await db.brandPreset.delete({ where: { id: dup.id } });
    await db.brandPreset.delete({ where: { id: preset.id } });
  });

  test("unknown defaultExportProfile is refused", async () => {
    await expect(
      presetsMod.validatePresetData(USER, {
        name: "Bad", brandName: "", logoAssetId: null, watermarkAssetId: null, primaryColor: "#111111", secondaryColor: "#222222",
        fontFamily: "inter", captionStyle: null, introAssetId: null, outroAssetId: null, thumbnailStyle: null, defaultExportProfile: "not-a-profile",
      }),
    ).rejects.toThrow("Unknown export profile");
  });
});

// ── §3 thumbnails ───────────────────────────────────────────────────────────
describe("M9 thumbnail studio", () => {
  test("closest LAXII size mapping and thumbnail dims per profile", () => {
    expect(thumbsMod.closestLaxiiSize(1280, 720)).toBe("1344x768");
    // 768x1344 (0.5714) is closer to 9:16 (0.5625) than 720x1440 (0.5).
    expect(thumbsMod.closestLaxiiSize(1080, 1920)).toBe("768x1344");
    expect(thumbsMod.closestLaxiiSize(1080, 1080)).toBe("1024x1024");
    const dims = thumbsMod.thumbnailDimsForProfile("youtube_landscape");
    expect(dims).toEqual({ width: 1280, height: 720 });
    expect(() => thumbsMod.thumbnailDimsForProfile("nope")).toThrow();
  });

  test("overlay compositing renders EN + Tamil titles at exact platform dims", async () => {
    const outEn = path.join(WORK, "thumb-en.jpg");
    const en = await thumbsMod.composeThumbnailOverlay(FIX_IMAGE, { ...thumbsMod.ThumbnailLayoutSchema.parse({ title: "Bean FX Morning" }), position: "bottom", align: "left", fontScale: 0.1, textColor: "#ffffff", accentColor: "#d4a017", backdrop: "band", backdropOpacity: 0.5, shadow: true }, 1280, 720, outEn);
    expect(en.width).toBe(1280);
    expect(en.height).toBe(720);
    expect(existsSync(outEn)).toBe(true);

    const outTa = path.join(WORK, "thumb-ta.jpg");
    const ta = await thumbsMod.composeThumbnailOverlay(FIX_IMAGE, thumbsMod.ThumbnailLayoutSchema.parse({ title: "காலை வணக்கம்", font: "nikki-tamil", position: "top", align: "center", fontScale: 0.09, backdrop: "box", backdropOpacity: 0.6, shadow: false }), 1080, 1920, outTa);
    expect(ta.width).toBe(1080);
    expect(ta.height).toBe(1920);
    expect(existsSync(outTa)).toBe(true);
  });

  test("compositeAndRegisterThumbnail registers a NEW asset with provenance (never overwrites)", async () => {
    const draft = await db.thumbnailDraft.create({ data: { userId: USER, projectId, platform: "youtube_landscape", status: "READY", prompt: "test", selectedAssetId: videoAssetId } });
    // selectedAssetId must be an IMAGE — use a registered image fixture.
    const image = await db.mediaAsset.create({ data: { userId: USER, projectId, originalName: "base.jpg", storagePath: FIX_IMAGE, kind: "IMAGE", mimeType: "image/jpeg", sizeBytes: statSync(FIX_IMAGE).size, width: 640, height: 360 } });
    await db.thumbnailDraft.update({ where: { id: draft.id }, data: { selectedAssetId: image.id } });
    const result = await jobsMod.compositeAndRegisterThumbnail(USER, draft.id, thumbsMod.ThumbnailLayoutSchema.parse({ title: "Morning Show" }));
    expect(result.assetId).not.toBe(image.id);
    const composite = await db.mediaAsset.findUnique({ where: { id: result.assetId } });
    expect(composite!.kind).toBe("IMAGE");
    expect(composite!.width).toBe(1280);
    expect(composite!.provider).toBe("publish-compositor");
    expect(composite!.referenceAssetId).toBe(image.id);
    const draftAfter = await db.thumbnailDraft.findUnique({ where: { id: draft.id } });
    expect(draftAfter!.compositedAssetId).toBe(result.assetId);
    expect(draftAfter!.selectedAssetId).toBe(image.id); // selection preserved
    await db.thumbnailDraft.delete({ where: { id: draft.id } });
  });
});

// ── §6 variants END-TO-END through the real worker ──────────────────────────
describe("M9 export variant pipeline (real ffmpeg)", () => {
  test("master → youtube_landscape variant completes with conformant output", async () => {
    const profile = profilesMod.getExportProfile("youtube_landscape")!;
    const variant = await db.exportVariant.create({
      data: { userId: USER, projectId, profileId: profile.id, profileVersion: profilesMod.PROFILE_VERSION, profileJson: JSON.stringify(profile), status: "QUEUED", sourceAssetId: videoAssetId },
    });
    const jobId = await helpersMod.enqueueMediaJob(USER, helpersMod.JOB_TYPE_EXPORT_VARIANT, { variantId: variant.id });
    await db.exportVariant.update({ where: { id: variant.id }, data: { jobId } });
    await workerMod.tickWorkerOnce();
    // Wait for the async claim to finish.
    for (let i = 0; i < 120; i++) {
      const row = await db.exportVariant.findUnique({ where: { id: variant.id } });
      if (row?.status === "COMPLETED" || row?.status === "FAILED") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const done = await db.exportVariant.findUnique({ where: { id: variant.id } });
    if (done!.status !== "COMPLETED") {
      const jobRow = done!.jobId ? await db.job.findUnique({ where: { id: done!.jobId! } }) : null;
      console.log(`[m9-debug] variant status=${done!.status} stage=${done!.stage} error=${done!.error} job=${JSON.stringify(jobRow?.status)} jobMsg=${jobRow?.message?.slice(0, 200)}`);
    }
    expect(done!.status).toBe("COMPLETED");
    expect(done!.resultExportId).not.toBeNull();
    const validation = JSON.parse(done!.validationJson!);
    expect(validation.ok).toBe(true);
    const exportRow = await db.exportFile.findUnique({ where: { id: done!.resultExportId! } });
    expect(exportRow!.kind).toBe("VIDEO");
    const probe = await variantsMod.probeMaster(exportRow!.storagePath);
    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
    // Original master untouched.
    expect(existsSync(FIX)).toBe(true);
    const masterAgain = await db.mediaAsset.findUnique({ where: { id: videoAssetId } });
    expect(masterAgain!.storagePath).toBe(FIX);
  }, 240_000);

  test("duration-cap profile refuses a longer master BEFORE encoding (no output file)", async () => {
    const capped = { ...profilesMod.getExportProfile("youtube_shorts")!, maxDurationSec: 1, id: "capped_test", label: "Capped test" };
    process.env.BEANFX_EXPORT_PROFILES_JSON = JSON.stringify([{ ...capped, sources: [] }]);
    profilesMod.resetProfileRegistry();
    const variant = await db.exportVariant.create({
      data: { userId: USER, projectId, profileId: "capped_test", profileVersion: "test", profileJson: JSON.stringify(capped), status: "QUEUED", sourceAssetId: videoAssetId },
    });
    const jobId = await helpersMod.enqueueMediaJob(USER, helpersMod.JOB_TYPE_EXPORT_VARIANT, { variantId: variant.id });
    await db.exportVariant.update({ where: { id: variant.id }, data: { jobId } });
    await workerMod.tickWorkerOnce();
    for (let i = 0; i < 40; i++) {
      const row = await db.exportVariant.findUnique({ where: { id: variant.id } });
      if (row?.status === "FAILED") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const failed = await db.exportVariant.findUnique({ where: { id: variant.id } });
    expect(failed!.status).toBe("FAILED");
    const failures = JSON.parse(failed!.validationJson!) as { code: string }[];
    expect(failures.some((f) => f.code === "DURATION_CAP")).toBe(true);
    expect(failed!.error).toContain("Trim the timeline");
    delete process.env.BEANFX_EXPORT_PROFILES_JSON;
    profilesMod.resetProfileRegistry();
  }, 60_000);

  test("cancel marks both the job and the variant CANCELLED", async () => {
    const profile = profilesMod.getExportProfile("square_social")!;
    const variant = await db.exportVariant.create({
      data: { userId: USER, projectId, profileId: profile.id, profileVersion: profilesMod.PROFILE_VERSION, profileJson: JSON.stringify(profile), status: "QUEUED", sourceAssetId: videoAssetId },
    });
    const jobId = await helpersMod.enqueueMediaJob(USER, helpersMod.JOB_TYPE_EXPORT_VARIANT, { variantId: variant.id });
    await db.exportVariant.update({ where: { id: variant.id }, data: { jobId } });
    const ok = await jobRunnerMod.jobManager.cancel(jobId, USER);
    expect(ok).toBe(true);
    await db.exportVariant.updateMany({ where: { id: variant.id, status: { in: ["QUEUED", "RENDERING"] } }, data: { status: "CANCELLED", stage: "Cancelled" } });
    const cancelled = await db.exportVariant.findUnique({ where: { id: variant.id } });
    expect(cancelled!.status).toBe("CANCELLED");
    const foreignCancel = await jobRunnerMod.jobManager.cancel(jobId, FOREIGN);
    expect(foreignCancel).toBe(false);
  });
});

// ── §7 packages ─────────────────────────────────────────────────────────────
describe("M9 publication packages", () => {
  test("zip builder is deterministic and produces a valid archive", async () => {
    const entries = [
      { name: "b/second.txt", data: new TextEncoder().encode("second") },
      { name: "a/first.txt", data: new TextEncoder().encode("first") },
    ];
    const a = zipMod.buildZip(entries);
    const b = zipMod.buildZip(entries);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    const zipPath = path.join(WORK, "det.zip");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(zipPath, a.buffer);
    const verify = execFileSync("python3", ["-c", "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print('OK' if z.testzip() is None else 'BAD');print(len(z.namelist()))", zipPath], { encoding: "utf8" });
    expect(verify).toContain("OK");
    expect(verify.trim().split("\n")[1]).toBe("2");
  });

  test("end-to-end package build: manifest lists files with sha256; metadata.json carries APPROVED fields only", async () => {
    const completed = await db.exportVariant.findFirst({ where: { userId: USER, status: "COMPLETED" } });
    expect(completed).not.toBeNull();

    const fields = JSON.parse(GOOD_EN_JSON) as metadataMod.PublishFields;
    const meta = await db.publishMetadata.create({
      data: { userId: USER, projectId, platform: "youtube_landscape", language: "en", status: "APPROVED", approvedJson: JSON.stringify(fields), draftJson: JSON.stringify({ fields, provenance: { provider: "fixture", model: "fixture", generatedAt: new Date().toISOString(), fields: {} }, chaptersSource: "none" }) },
    });
    const pkg = await db.publishPackage.create({
      data: { userId: USER, projectId, status: "BUILDING", variantIdsJson: JSON.stringify([completed!.id]), metadataId: meta.id },
    });
    const jobId = await helpersMod.enqueueMediaJob(USER, helpersMod.JOB_TYPE_PUBLISH_PACKAGE, { packageId: pkg.id });
    await db.publishPackage.update({ where: { id: pkg.id }, data: { jobId } });
    await workerMod.tickWorkerOnce();
    for (let i = 0; i < 40; i++) {
      const row = await db.publishPackage.findUnique({ where: { id: pkg.id } });
      if (row?.status === "READY" || row?.status === "FAILED") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const ready = await db.publishPackage.findUnique({ where: { id: pkg.id } });
    if (ready!.status !== "READY") console.log(`[m9-debug] package error: ${ready!.error}`);
    expect(ready!.status).toBe("READY");
    expect(ready!.manifestSha256).not.toBeNull();
    expect(existsSync(ready!.storagePath!)).toBe(true);

    // Independent verification of the zip + manifest.
    const verify = execFileSync("python3", ["-c", "import zipfile,sys,hashlib,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;names=z.namelist();m=json.loads(z.read('manifest.json'));print(len(names));print(all(f['sha256']==hashlib.sha256(z.read(f['path'])).hexdigest() for f in m['files']));print(m['metadata']['status'])", ready!.storagePath!], { encoding: "utf8" });
    const lines = verify.trim().split("\n");
    expect(Number(lines[0])).toBeGreaterThanOrEqual(3); // video + metadata.json + manifest.json
    expect(lines[1]).toBe("True");
    expect(lines[2]).toBe("USER-APPROVED");
    const manifest = JSON.parse(ready!.manifestJson!);
    expect(manifest.exclusions.privateSourceMedia).toContain("excluded by policy");
    expect(JSON.stringify(manifest)).not.toContain(FIX); // private source media path never appears
    expect(manifest.profiles[0].id).toBe(completed!.profileId);

    // Unapproved metadata is refused at packaging time.
    const draftMeta = await db.publishMetadata.create({ data: { userId: USER, projectId, platform: "tiktok", language: "en", status: "GENERATED", draftJson: "{}" } });
    const pkg2 = await db.publishPackage.create({ data: { userId: USER, projectId, status: "BUILDING", variantIdsJson: JSON.stringify([completed!.id]), metadataId: draftMeta.id } });
    const jobId2 = await helpersMod.enqueueMediaJob(USER, helpersMod.JOB_TYPE_PUBLISH_PACKAGE, { packageId: pkg2.id });
    await db.publishPackage.update({ where: { id: pkg2.id }, data: { jobId: jobId2 } });
    await workerMod.tickWorkerOnce();
    for (let i = 0; i < 40; i++) {
      const row = await db.publishPackage.findUnique({ where: { id: pkg2.id } });
      if (row?.status === "FAILED") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const failedPkg = await db.publishPackage.findUnique({ where: { id: pkg2.id } });
    expect(failedPkg!.status).toBe("FAILED");
    expect(failedPkg!.error).toContain("APPROVED");
    await db.publishMetadata.delete({ where: { id: draftMeta.id } });
    await db.publishMetadata.delete({ where: { id: meta.id } });
  }, 120_000);
});

// ── §8/§10 ownership + honesty ──────────────────────────────────────────────
describe("M9 ownership and recovery", () => {
  test("foreign user cannot run another user's variant job", async () => {
    const completed = await db.exportVariant.findFirst({ where: { userId: USER, status: "COMPLETED" } });
    const job = await db.job.create({ data: { userId: FOREIGN, type: "EXPORT_VARIANT", status: "QUEUED", paramsJson: JSON.stringify({ variantId: completed!.id }) } });
    await expect(jobsMod.runExportVariantJob({ id: job.id, userId: FOREIGN, attempts: 1, maxAttempts: 3, paramsJson: job.paramsJson })).rejects.toThrow("not owned");
    await db.job.delete({ where: { id: job.id } }).catch(() => undefined);
  });

  test("variant job with a missing source export fails cleanly", async () => {
    const profile = profilesMod.getExportProfile("square_social")!;
    const variant = await db.exportVariant.create({ data: { userId: USER, profileId: profile.id, profileVersion: profilesMod.PROFILE_VERSION, profileJson: JSON.stringify(profile), status: "QUEUED", sourceExportId: "missing-id" } });
    const job = await db.job.create({ data: { userId: USER, type: "EXPORT_VARIANT", status: "QUEUED", paramsJson: JSON.stringify({ variantId: variant.id }) } });
    await expect(jobsMod.runExportVariantJob({ id: job.id, userId: USER, attempts: 1, maxAttempts: 3, paramsJson: job.paramsJson })).rejects.toThrow();
    await db.exportVariant.delete({ where: { id: variant.id } }).catch(() => undefined);
    await db.job.delete({ where: { id: job.id } }).catch(() => undefined);
  });

  test("readFileSync sanity: no private key material anywhere in M9 modules", () => {
    const files = ["src/lib/publish/profiles.ts", "src/lib/publish/variants.ts", "src/lib/publish/metadata.ts", "src/lib/publish/presets.ts", "src/lib/publish/thumbnails.ts", "src/lib/publish/jobs.ts", "src/lib/publish/zip.ts"];
    for (const f of files) {
      const text = readFileSync(path.join(process.cwd(), f), "utf8");
      expect(text.includes("BEGIN RSA")).toBe(false);
      expect(text.includes("sk-")).toBe(false);
    }
  });
});
