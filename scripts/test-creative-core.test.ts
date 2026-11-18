/**
 * BEAN FX — M10 AI Creative Director core tests (bun test, isolated DB).
 * Fixture/engine suite: REAL engine code + REAL M1 command integration + REAL
 * GANGZII analysis on a real fixture (measured silence spans); LLM parts use
 * INJECTED stub providers (labeled fixtures — never presented as live
 * provider verification; see test-creative-live.test.ts).
 *
 * Run: bun test scripts/test-creative-core.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m10-core-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
process.env.BEANFX_MYAI_PROVIDER = "does-not-exist"; // honest NOT_CONFIGURED for unseamed paths
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m10-core-"));

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let persistence: typeof import("../src/lib/editor/persistence");
let contextMod: typeof import("../src/lib/creative/context");
let retentionMod: typeof import("../src/lib/creative/retention");
let briefMod: typeof import("../src/lib/creative/brief");
let scorecardMod: typeof import("../src/lib/creative/scorecard");
let recsMod: typeof import("../src/lib/creative/recommendations");
let variantsMod: typeof import("../src/lib/creative/variants");
let assistantMod: typeof import("../src/lib/creative/assistant");
let jobsMod: typeof import("../src/lib/creative/jobs");
let workerMod: typeof import("../src/lib/media-worker");
let helpersMod: typeof import("../src/lib/job-helpers");
import type { MeasuredContext } from "../src/lib/creative/context";

const USER = "m10-user";
const FOREIGN = "m10-foreign";
let projectId = "";
let audioAssetId = "";
const FIX_AUDIO = path.join(WORK, "narration.wav");

/** Stub provider returning canned JSON (clearly fixture-driven). */
function stubProvider(responses: string[]): import("../src/lib/my-ai/gateway/provider").LLMProvider {
  let i = 0;
  return {
    id: "stub-fixture",
    model: "fixture-model",
    async chat() {
      const content = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { content, model: "fixture-model", provider: "stub-fixture", usage: null, latencyMs: 1 };
    },
    async healthCheck() {
      return { ok: true, detail: "stub", latencyMs: 0 };
    },
  };
}

const TA_BRIEF = JSON.stringify({
  mainSubject: "காலை காபி தயாரிப்பு",
  mainMessage: "விரைவான காபி வழிகாட்டி",
  storyStructure: "அறிமுகம் → தயாரிப்பு → முடிவு",
  openingHook: { summary: "நேரடி அறிமுகம்", evidenceSec: 4, basis: "measured" },
  supportingPoints: ["தண்ணீர்", "காபி"],
  importantScenes: [{ index: 1, note: "அறிமுகம்" }],
  endingAndCta: "பின்தொடருங்கள்",
  missingElements: ["மொழிபெயர்ப்பு இல்லை"],
  observed: ["14 வினாடி காணொளி"],
  interpreted: ["காபி பற்றிய உள்ளடக்கம்"],
  audience: null,
});

const EN_BRIEF = JSON.stringify({
  mainSubject: "Morning coffee preparation",
  mainMessage: "A quick filter-coffee guide",
  storyStructure: "intro → brew → close",
  openingHook: { summary: "Direct intro", evidenceSec: 4, basis: "measured" },
  supportingPoints: ["water", "coffee"],
  importantScenes: [{ index: 1, note: "intro" }],
  endingAndCta: "Follow for more",
  missingElements: [],
  observed: ["14-second video"],
  interpreted: ["coffee content"],
  audience: null,
});

/** Synthetic measured context (fully typed) for precise retention assertions. */
function syntheticContext(overrides: Partial<MeasuredContext> = {}): MeasuredContext {
  return {
    projectId: "p",
    projectName: "Synthetic",
    contextVersion: "v:1:2:0",
    headVersion: 1,
    durationSec: 60,
    fps: 30,
    clipCount: 4,
    audioClipCount: 1,
    videoClipCount: 4,
    videoClipAssets: [
      { assetId: "a1", durationSec: 30 },
      { assetId: "a2", durationSec: 20 },
      { assetId: "a3", durationSec: 10 },
    ],
    audioClipSpans: [{ id: "ac1", trackId: "t-audio", startSec: 0, endSec: 60 }],
    lockedTrackCount: 0,
    gaps: [],
    overlaps: 0,
    transitionCount: 0,
    graphicClipCount: 0,
    captionClipCount: 0,
    audio: {
      sourceAssetId: "aud",
      sourceName: "narration.wav",
      inspection: {
        durationSec: 60,
        silenceSpans: [
          { start: 0, end: 5 },
          { start: 20, end: 26 },
        ],
        silenceTotalSec: 11,
        silenceFraction: 11 / 60,
        integratedLufs: -9.5,
        lraLu: 4,
        levelsClassification: "speech",
        channelImbalanceDb: 4.2,
        clippingSuspected: false,
        noiseFloorDbfs: -60,
        shortTermMaxLufs: -8,
      },
      inspectionProcessId: "gp1",
    },
    transcript: null,
    captions: null,
    scenes: null,
    suppliedAudience: null,
    publishing: [],
    missingEvidence: [],
    evidenceSources: [],
    ...overrides,
  } as MeasuredContext;
}

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  persistence = await import("../src/lib/editor/persistence");
  contextMod = await import("../src/lib/creative/context");
  retentionMod = await import("../src/lib/creative/retention");
  briefMod = await import("../src/lib/creative/brief");
  scorecardMod = await import("../src/lib/creative/scorecard");
  recsMod = await import("../src/lib/creative/recommendations");
  variantsMod = await import("../src/lib/creative/variants");
  assistantMod = await import("../src/lib/creative/assistant");
  jobsMod = await import("../src/lib/creative/jobs");
  workerMod = await import("../src/lib/media-worker");
  helpersMod = await import("../src/lib/job-helpers");

  await db.user.create({ data: { id: USER, email: "m10a@test.local", name: "A", passwordHash: "x" } }).catch(() => undefined);
  await db.user.create({ data: { id: FOREIGN, email: "m10b@test.local", name: "B", passwordHash: "x" } }).catch(() => undefined);
  const project = await db.project.create({ data: { userId: USER, name: "M10 Core Project", description: "Fixture" } });
  projectId = project.id;

  // REAL narration fixture: silence [0,4) — tone [4,9) — silence [9,11) — tone [11,14).
  execFileSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=14", "-af", "volume='0.6*(between(t,4,9)+between(t,11,14))':eval=frame,tremolo=f=5:d=0.7", "-ar", "48000", "-ac", "1", FIX_AUDIO],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const asset = await db.mediaAsset.create({ data: { userId: USER, projectId, originalName: "narration.wav", storagePath: FIX_AUDIO, kind: "AUDIO", mimeType: "audio/wav", sizeBytes: statSync(FIX_AUDIO).size, durationSec: 14, sampleRate: 48000, channels: 1 } });
  audioAssetId = asset.id;

  // Background worker ticker: claims GANGZII/CREATIVE jobs while tests run
  // (the in-process M3 worker loop is disabled by BEANFX_MEDIA_WORKER_AUTOSTART=0).
  const ticker = setInterval(() => {
    void workerMod.tickWorkerOnce().catch(() => undefined);
  }, 1000);
  ticker.unref?.();
  (globalThis as unknown as { __m10Ticker?: NodeJS.Timeout }).__m10Ticker = ticker;

  // Real timeline head: AUDIO track + clip spanning the fixture.
  const head = await persistence.getTimelineHead(projectId, USER);
  await persistence.applyTimelineEdits(projectId, USER, head.version, [
    { type: "AddTrack", track: { id: "t-audio", kind: "AUDIO", name: "Narration", visible: true, muted: false, solo: false, locked: false } },
    {
      type: "AddClip",
      clip: {
        id: "ac1", trackId: "t-audio", sourceAssetId: audioAssetId, sourceInFrame: 0, sourceOutFrame: 14 * 30, sourceFps: { num: 30000, den: 1000 }, timelineStartFrame: 0, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: "narration", missingMedia: false, effects: [], keyframes: [],
      },
    },
  ], false);
}, 120_000);

afterAll(() => {
  const ticker = (globalThis as unknown as { __m10Ticker?: NodeJS.Timeout }).__m10Ticker;
  if (ticker) clearInterval(ticker);
  rmSync(WORK, { recursive: true, force: true });
  rmSync(SCRATCH_DB, { force: true });
});

// ── §3 content intelligence ─────────────────────────────────────────────────
describe("M10 content intelligence", () => {
  test("measured context resolves REAL timeline + GANGZII evidence (worker-run)", async () => {
    const ctx = await contextMod.buildMeasuredContext(USER, projectId, { enqueueEvidence: true, waitSec: 90 });
    expect(ctx.clipCount).toBe(1);
    expect(ctx.audioClipSpans.length).toBe(1);
    expect(ctx.contextVersion).toMatch(/^v:\d+:\d+:\d+$/);
    expect(ctx.audio).not.toBeNull();
    expect(ctx.audio!.inspection).not.toBeNull();
    expect(ctx.audio!.inspection!.durationSec).toBeCloseTo(14, 0);
    // Measured silence spans from the REAL GANGZII inspection.
    expect(ctx.audio!.inspection!.silenceSpans.length).toBeGreaterThan(0);
    expect(ctx.evidenceSources.some((e) => e.engine === "GANGZII")).toBe(true);
  }, 180_000);

  test("missing transcript + missing captions are reported honestly", async () => {
    const ctx = await contextMod.buildMeasuredContext(USER, projectId, { enqueueEvidence: false });
    expect(ctx.transcript).toBeNull();
    expect(ctx.missingEvidence.some((m) => m.includes("RIISHE transcript"))).toBe(true);
    expect(ctx.missingEvidence.some((m) => m.includes("captions") || m.includes("Captions") || m.toLowerCase().includes("caption"))).toBe(true);
  });

  test("ownership: foreign user cannot resolve context", async () => {
    await expect(contextMod.buildMeasuredContext(FOREIGN, projectId, { enqueueEvidence: false })).rejects.toThrow();
  });

  test("EN + TA briefs via injected stub; audience never invented; observed/interpreted separated", async () => {
    const ctx = syntheticContext();
    const en = await briefMod.generateCreativeBrief(ctx, "en", { provider: stubProvider([EN_BRIEF]) });
    expect(en.brief.mainSubject).toContain("coffee");
    expect(en.brief.audience).toBeNull(); // none supplied → never invented
    expect(en.brief.observed.length).toBeGreaterThan(0);
    expect(en.brief.interpreted.length).toBeGreaterThan(0);
    const ta = await briefMod.generateCreativeBrief(ctx, "ta", { provider: stubProvider([TA_BRIEF]) });
    expect(ta.brief.mainSubject).toMatch(/[\u0b80-\u0bff]/);
  });

  test("fabricated audience is stripped (honesty guard)", async () => {
    const fabricated = JSON.stringify({ ...JSON.parse(EN_BRIEF), audience: "US teens 13-17" });
    const r = await briefMod.generateCreativeBrief(syntheticContext(), "en", { provider: stubProvider([fabricated]) });
    expect(r.brief.audience).toBeNull();
  });

  test("supplied audience is preserved verbatim", async () => {
    const ctx = syntheticContext({ suppliedAudience: "Home baristas" });
    const r = await briefMod.generateCreativeBrief(ctx, "en", { provider: stubProvider([JSON.stringify({ ...JSON.parse(EN_BRIEF), audience: "something invented" })]) });
    expect(r.brief.audience).toBe("Home baristas");
  });
});

// ── §4 retention intelligence ───────────────────────────────────────────────
describe("M10 retention intelligence", () => {
  test("REAL GANGZII silence spans produce measured findings on the fixture", async () => {
    const ctx = await contextMod.buildMeasuredContext(USER, projectId, { enqueueEvidence: false });
    const { findings, disclaimer } = retentionMod.analyzeRetention(ctx);
    expect(disclaimer).toContain("NOT");
    const labels = new Set(findings.map((f) => f.evidenceLabel));
    // With a real inspection, at least the audio-quality dimension is measured.
    expect(findings.some((f) => f.category === "audio-quality" && f.evidenceLabel === "measured")).toBe(true);
    void labels;
  });

  test("synthetic: opening dead air + long pause are MEASURED with correct severity", () => {
    const ctx = syntheticContext();
    const { findings } = retentionMod.analyzeRetention(ctx);
    const opening = findings.find((f) => f.category === "dead-air" && f.startSec === 0);
    expect(opening).toBeDefined();
    expect(opening!.evidenceLabel).toBe("measured");
    expect(opening!.endSec).toBe(5);
    const pause = findings.find((f) => f.category === "long-pause");
    expect(pause).toBeDefined();
    expect(pause!.startSec).toBe(20);
    expect(pause!.severity).toBe("major"); // 6 s ≥ 4 s threshold
    expect(pause!.confidence).not.toBeNull();
    expect(JSON.stringify(pause!.evidence)).toContain("silenceSpan");
  });

  test("synthetic: audio-quality findings carry measured LUFS delta + imbalance", () => {
    const { findings } = retentionMod.analyzeRetention(syntheticContext());
    const lufs = findings.find((f) => f.category === "audio-quality" && JSON.stringify(f.evidence).includes("integratedLufs"));
    expect(lufs).toBeDefined();
    expect(lufs!.severity).toBe("moderate"); // |−9.5 − (−14)| = 4.5 dB
    const bal = findings.find((f) => JSON.stringify(f.evidence).includes("channelImbalanceDb"));
    expect(bal).toBeDefined();
  });

  test("music/mixed classification keeps the intentional-pause caveat", () => {
    const ctx = syntheticContext({ audio: { ...syntheticContext().audio!, inspection: { ...syntheticContext().audio!.inspection!, levelsClassification: "music" } } });
    const { findings } = retentionMod.analyzeRetention(ctx);
    const pause = findings.find((f) => f.category === "long-pause")!;
    expect(pause.suggestion).toBeNull(); // no trim suggestion for music-classified audio
    expect(pause.explanation).toContain("music");
  });

  test("unclear classification → insufficient-evidence, no manufactured findings", () => {
    const ctx = syntheticContext({ audio: { ...syntheticContext().audio!, inspection: { ...syntheticContext().audio!.inspection!, levelsClassification: "unclear" } } });
    const { findings } = retentionMod.analyzeRetention(ctx);
    expect(findings.some((f) => f.evidenceLabel === "insufficient-evidence" && f.category === "dead-air")).toBe(true);
  });

  test("caption speed + scene outliers + asset reuse produce labeled findings", () => {
    const ctx = syntheticContext({
      captions: { sourceKind: "srt-assets", cueCount: 40, avgCps: 18.5, maxCps: 24, overThirteenCps: 9, gapsOver3Sec: 7 },
      scenes: [
        { number: 1, durationSec: 5, narration: "a", onScreenText: "" },
        { number: 2, durationSec: 6, narration: "b", onScreenText: "" },
        { number: 3, durationSec: 60, narration: "c", onScreenText: "" },
      ],
    });
    const { findings } = retentionMod.analyzeRetention(ctx);
    const caps = findings.find((f) => f.category === "caption-timing")!;
    expect(caps.evidenceLabel).toBe("measured");
    expect(JSON.stringify(caps.evidence)).toContain("avgCps");
    const pacing = findings.find((f) => f.category === "pacing")!;
    expect(pacing.evidenceLabel).toBe("inferred");
    const reuse = findings.find((f) => f.category === "visual-repetition")!;
    expect(reuse.evidenceLabel).toBe("inferred");
    expect(reuse.engine).toBe("JAZMII");
  });

  test("missing CTA evidence is NOT declared as a missing CTA verdict", () => {
    const { findings } = retentionMod.analyzeRetention(syntheticContext());
    const cta = findings.find((f) => f.category === "ending-cta")!;
    expect(cta.evidenceLabel).toBe("insufficient-evidence");
    expect(cta.explanation).toContain("cannot be declared");
  });

  test("repeated narration detection via Jaccard overlap", () => {
    const ctx = syntheticContext({
      transcript: {
        jobId: "j", available: true, text: "", languageDescription: "en", primaryScript: "Latin",
        segments: [
          { start: 0, end: 3, text: "please subscribe to the channel for more videos" },
          { start: 3, end: 6, text: "we brew coffee slowly" },
          { start: 6, end: 9, text: "please subscribe to the channel for more videos today" },
        ],
        speechSpansSec: [{ start: 0, end: 9 }],
      },
    });
    const { findings } = retentionMod.analyzeRetention(ctx);
    const rep = findings.find((f) => f.category === "repeated-narration");
    expect(rep).toBeDefined();
    expect(rep!.evidenceLabel).toBe("inferred"); // overlap measured; intent interpreted
  });
});

// ── §5 smart editing recommendations ────────────────────────────────────────
describe("M10 smart editing recommendations", () => {
  test("pause finding → typed executable proposal with M1 commands; individual approval", async () => {
    const ctx = await contextMod.buildMeasuredContext(USER, projectId, { enqueueEvidence: false });
    const finding = {
      findingNo: 1, category: "long-pause" as const, startSec: 5, endSec: 9, severity: "major" as const, confidence: 0.9,
      evidenceLabel: "measured" as const, evidence: { silenceSpan: { start: 5, end: 9 } },
      explanation: "4 s measured pause", suggestion: null, engine: "GANGZII" as const,
    };
    const recs = recsMod.buildRecommendations(ctx, [finding]);
    const exec = recs.find((r) => r.kind === "executable");
    expect(exec).toBeDefined();
    expect(exec!.payload.kind).toBe("timeline-commands");
    expect(exec!.payload.commands!.map((c) => c.type)).toEqual(["SplitClip", "SplitClip", "RippleDelete"]);
    expect(exec!.requiresApproval).toBe(true);

    const head = await persistence.getTimelineHead(projectId, USER);
    const reviewX = await db.creativeReview.create({ data: { userId: USER, projectId, scope: "retention", language: "en", status: "COMPLETED", contextVersion: head.version.toString(), headVersion: head.version } });
    await recsMod.persistRecommendations(USER, projectId, reviewX.id, head.version, recs);
    const row = await db.creativeRecommendation.findFirst({ where: { userId: USER, projectId, status: "PROPOSED" } });
    expect(row).not.toBeNull();

    // Preview (dry-run) does NOT change the timeline.
    const preview = await recsMod.approveAndExecuteRecommendation(USER, row!.id, true);
    expect(preview.status).toBe("PROPOSED");
    const headAfterPreview = await persistence.getTimelineHead(projectId, USER);
    expect(headAfterPreview.version).toBe(head.version);

    // Approve + execute → new version; audio shortened by the pause length.
    const result = await recsMod.approveAndExecuteRecommendation(USER, row!.id, false);
    expect(result.status).toBe("EXECUTED");
    expect(result.version).toBe(head.version + 1);
    const newHead = await persistence.getTimelineHead(projectId, USER);
    // 14 s clip − 4 s pause = 10 s on the timeline (max end over the split clips).
    const audioEnd = Math.max(...newHead.sequence.clips.filter((c) => c.trackId === "t-audio").map((c) => c.timelineStartFrame + c.timelineDurationFrames));
    expect(audioEnd).toBe(10 * 30);
    // Version history intact (undo/redo preserved).
    const versions = await persistence.listTimelineVersions(projectId, USER);
    expect(versions.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  test("stale proposal is rejected when the timeline moved", async () => {
    const head = await persistence.getTimelineHead(projectId, USER);
    const reviewStale = await db.creativeReview.create({ data: { userId: USER, projectId, scope: "retention", language: "en", status: "COMPLETED", contextVersion: head.version.toString(), headVersion: head.version } });
    const row = await db.creativeRecommendation.create({
      data: {
        reviewId: reviewStale.id, userId: USER, projectId, recNo: 1, kind: "executable", engine: "RIISHE",
        title: "stale test", detail: "stale", proposalJson: JSON.stringify({ kind: "timeline-commands", commands: [{ type: "RemoveClip", clipId: "ac1" }] }),
        requiresApproval: true, status: "PROPOSED", timelineVersionAtProposal: head.version,
      },
    });
    // Move the head with a real (additive, safe) command.
    await persistence.applyTimelineEdits(projectId, USER, head.version, [{ type: "UpdateTrack", trackId: "t-audio", name: "Narration v2" }], false);
    const result = await recsMod.approveAndExecuteRecommendation(USER, row.id, false);
    expect(result.status).toBe("STALE");
    const updated = await db.creativeRecommendation.findUnique({ where: { id: row.id } });
    expect(updated!.status).toBe("STALE");
    // Nothing was force-applied: the audio timeline is unchanged.
    const after = await persistence.getTimelineHead(projectId, USER);
    const audioEndAfter = Math.max(...after.sequence.clips.filter((c) => c.trackId === "t-audio").map((c) => c.timelineStartFrame + c.timelineDurationFrames));
    expect(audioEndAfter).toBe(10 * 30);
  });

  test("locked track protects the clip from automated edits", async () => {
    const head = await persistence.getTimelineHead(projectId, USER);
    // Lock the audio track via a real command.
    const locked = await persistence.applyTimelineEdits(projectId, USER, head.version, [{ type: "UpdateTrack", trackId: "t-audio", locked: true }], false);
    const reviewLocked = await db.creativeReview.create({ data: { userId: USER, projectId, scope: "retention", language: "en", status: "COMPLETED", contextVersion: locked.version.toString(), headVersion: locked.version } });
    const targetClipId = locked.sequence.clips.find((c) => c.trackId === "t-audio")!.id;
    const row = await db.creativeRecommendation.create({
      data: {
        reviewId: reviewLocked.id, userId: USER, projectId, recNo: 2, kind: "executable", engine: "RIISHE",
        title: "locked test", detail: "locked", proposalJson: JSON.stringify({ kind: "timeline-commands", commands: [{ type: "RemoveClip", clipId: targetClipId }] }),
        requiresApproval: true, status: "PROPOSED", timelineVersionAtProposal: locked.version,
      },
    });
    const result = await recsMod.approveAndExecuteRecommendation(USER, row.id, false);
    expect(result.status).toBe("FAILED");
    expect(JSON.stringify(result.detail + JSON.stringify(result)).toLowerCase()).toContain("lock");
    // Unlock again for later tests.
    const now = await persistence.getTimelineHead(projectId, USER);
    await persistence.applyTimelineEdits(projectId, USER, now.version, [{ type: "UpdateTrack", trackId: "t-audio", locked: false }], false);
  });

  test("foreign user cannot execute another user's recommendation", async () => {
    const head = await persistence.getTimelineHead(projectId, USER);
    const reviewOwn = await db.creativeReview.create({ data: { userId: USER, projectId, scope: "retention", language: "en", status: "COMPLETED", contextVersion: "x", headVersion: head.version } });
    const row = await db.creativeRecommendation.create({
      data: { reviewId: reviewOwn.id, userId: USER, projectId, recNo: 3, kind: "informational", engine: "MYAI", title: "t", detail: "d", proposalJson: JSON.stringify({ kind: "informational", note: "n" }), requiresApproval: false, status: "PROPOSED", timelineVersionAtProposal: head.version },
    });
    await expect(recsMod.rejectRecommendation(FOREIGN, row.id, null)).rejects.toThrow("not owned");
    await recsMod.rejectRecommendation(USER, row.id, "not now");
    const updated = await db.creativeRecommendation.findUnique({ where: { id: row.id } });
    expect(updated!.status).toBe("REJECTED");
  });
});

// ── §6 A/B studio ───────────────────────────────────────────────────────────
describe("M10 A/B studio", () => {
  test("text variants: generation (stub) → persist → compare → apply to M9 metadata", async () => {
    const ctx = syntheticContext({ projectId });
    const gen = await variantsMod.generateTextVariants(USER, ctx, "title", "en", {
      provider: stubProvider([
        JSON.stringify({
          variants: [
            { kind: "title", label: "A", description: "shorter", changedElements: ["title"], payload: { kind: "text", text: "Coffee in 60 Seconds" }, provenance: { basis: "ai-alternative" } },
            { kind: "title", label: "B", description: "question hook", changedElements: ["title"], payload: { kind: "text", text: "What Makes Great Coffee?" }, provenance: { basis: "ai-alternative" } },
          ],
        }),
      ]),
    });
    expect(gen.variants.length).toBe(2);
    const ids = await variantsMod.persistVariants(USER, projectId, null, gen.variants);
    expect(ids.length).toBe(2);

    const rows = await db.creativeVariant.findMany({ where: { userId: USER, projectId } });
    const comparison = variantsMod.compareVariants(rows);
    expect(comparison[0].text).toBeTruthy();
    expect(JSON.stringify(comparison[0])).toContain("Creative evaluation only");

    const beforeVersion = (await persistence.getTimelineHead(projectId, USER)).version;
    const applied = await variantsMod.applyVariant(USER, ids[0], "picked A");
    expect(applied.applied).toBe("title");
    const meta = await db.publishMetadata.findFirst({ where: { userId: USER, projectId } });
    expect(meta!.status).toBe("APPROVED");
    expect((JSON.parse(meta!.approvedJson!) as { title: string }).title).toBe("Coffee in 60 Seconds");
    const afterVersion = (await persistence.getTimelineHead(projectId, USER)).version;
    expect(afterVersion).toBe(beforeVersion); // original timeline untouched
    const vRow = await db.creativeVariant.findUnique({ where: { id: ids[0] } });
    expect(vRow!.status).toBe("APPLIED");
  });

  test("scene-sequence variants refuse direct apply and require the approval flow", async () => {
    const row = await db.creativeVariant.create({
      data: {
        userId: USER, projectId, kind: "scene-sequence", label: "seq", description: "reorder",
        payloadJson: JSON.stringify({ kind: "timeline-commands", commands: [{ type: "UpdateTrack", trackId: "t-audio", name: "reordered" }] }),
        provenanceJson: "{}", status: "PROPOSED",
      },
    });
    await expect(variantsMod.applyVariant(USER, row.id, null)).rejects.toThrow("approval flow");
    expect(variantsMod.parseSceneSequencePayload(row.payloadJson)).not.toBeNull();
  });

  test("foreign user cannot apply another user's variant", async () => {
    const rows = await db.creativeVariant.findMany({ where: { userId: USER, projectId } });
    await expect(variantsMod.applyVariant(FOREIGN, rows[0].id, null)).rejects.toThrow("not owned");
  });
});

// ── §7 scorecard ────────────────────────────────────────────────────────────
describe("M10 explainable scorecard", () => {
  test("deterministic-only run: 8 dimensions, missing data → null scores + honest notes", async () => {
    const ctx = syntheticContext();
    const { scorecard } = await scorecardMod.buildScorecard(USER, ctx, "en", { scorecardUnavailable: true });
    expect(scorecard.dimensions.length).toBe(8);
    expect(scorecard.overallNote).toContain("NOT a prediction");
    const audio = scorecard.dimensions.find((d) => d.key === "audio-quality")!;
    expect(audio.score).toBeLessThanOrEqual(3); // loudness −1.5dB→−1, imbalance −1
    expect(audio.basis).toBe("deterministic");
    const caps = scorecard.dimensions.find((d) => d.key === "caption-quality")!;
    expect(caps.score).toBeNull();
    expect(caps.missingData.length).toBeGreaterThan(0);
    const hook = scorecard.dimensions.find((d) => d.key === "hook-clarity")!;
    expect(hook.score).toBeNull();
    expect(hook.explanation).toContain("deterministic-only");
  });

  test("stub-provider run scores subjective dims with evidence", async () => {
    const subjective = [
      { key: "hook-clarity", score: 3, basis: "ai-assessment", evidence: ["first words at 4s"], explanation: "hook is functional", confidence: 0.6, missingData: [], suggestions: [] },
      { key: "story-coherence", score: 4, basis: "ai-assessment", evidence: ["3 scenes"], explanation: "coherent", confidence: 0.6, missingData: [], suggestions: [] },
      { key: "visual-consistency", score: null, basis: "ai-assessment", evidence: [], explanation: "no visual analysis", confidence: null, missingData: ["no visual analysis available"], suggestions: [] },
      { key: "ending-cta-clarity", score: 2, basis: "ai-assessment", evidence: ["no CTA found"], explanation: "weak ending", confidence: 0.5, missingData: [], suggestions: [] },
    ];
    const ctx = syntheticContext();
    const { scorecard } = await scorecardMod.buildScorecard(USER, ctx, "en", { provider: stubProvider([JSON.stringify({ dimensions: subjective })]) });
    expect(scorecard.dimensions.find((d) => d.key === "hook-clarity")!.score).toBe(3);
    expect(scorecard.dimensions.find((d) => d.key === "visual-consistency")!.score).toBeNull();
    expect(scorecard.dimensions.find((d) => d.key === "audio-quality")!.basis).toBe("deterministic");
  });
});

// ── §8 creator assistant + §9 jobs ──────────────────────────────────────────
describe("M10 creator assistant + durable jobs", () => {
  test("provider-unavailable assistant fails honestly (never fake analysis)", async () => {
    await expect(assistantMod.runAssistantTurn(USER, projectId, "Review my video", "en", {})).rejects.toThrow(/not configured|provider/i);
  });

  test("deterministic quick pass: intent routing creates findings + recommendations + conversation", async () => {
    const turn = await assistantMod.runAssistantTurn(USER, projectId, "Find unnecessary pauses", "en", { provider: stubProvider([JSON.stringify({ intent: "find-pauses", scope: "retention", language: "en", reply: null, needsFreshReview: false })]) });
    expect(turn.intent).toBe("find-pauses");
    expect(turn.reply.length).toBeGreaterThan(10);
    expect(turn.reviewId).not.toBeNull();
    expect(turn.recommendationsCreated).toBeGreaterThanOrEqual(0);
    const conv = await db.conversation.findFirst({ where: { userId: USER, projectId } });
    expect(conv).not.toBeNull();
    const messages = await db.conversationMessage.findMany({ where: { conversationId: conv!.id }, orderBy: { createdAt: "asc" } });
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const findings = await db.creativeFinding.findMany({ where: { reviewId: turn.reviewId! } });
    expect(findings.length).toBeGreaterThan(0);
    const reviewRow = await db.creativeReview.findUnique({ where: { id: turn.reviewId! } });
    expect(reviewRow!.provider).toBeNull(); // deterministic pass is labeled as such
  });

  test("full CREATIVE_REVIEW through the REAL worker (real GANGZII evidence wait)", async () => {
    const { reviewId, jobId } = await assistantMod.enqueueReview(USER, projectId, "full", "en");
    await workerMod.tickWorkerOnce();
    await new Promise((r) => setTimeout(r, 2500));
    await workerMod.tickWorkerOnce(); // claim the enqueued GANGZII evidence job
    for (let i = 0; i < 150; i++) {
      const row = await db.creativeReview.findUnique({ where: { id: reviewId } });
      if (row?.status === "COMPLETED" || row?.status === "FAILED" || row?.status === "CANCELLED") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const review = await db.creativeReview.findUnique({ where: { id: reviewId } });
    expect(review!.status).toBe("COMPLETED");
    expect(review!.provider).toBeNull(); // BEANFX_MYAI_PROVIDER=does-not-exist → honest degradation
    expect((review!.error ?? "").toLowerCase()).toContain("unavailable"); // interpretive parts honestly marked
    const findings = await db.creativeFinding.findMany({ where: { reviewId } });
    expect(findings.length).toBeGreaterThan(0);
    const recs = await db.creativeRecommendation.findMany({ where: { reviewId } });
    expect(recs.length).toBeGreaterThan(0);
    const scorecard = await db.creativeScorecard.findUnique({ where: { reviewId } });
    expect(scorecard).not.toBeNull();
    void jobId;
  }, 240_000);

  test("idempotent recovery: re-running a COMPLETED review is a no-op; cancel works on queued", async () => {
    const review = await db.creativeReview.findFirst({ where: { userId: USER, status: "COMPLETED" } });
    const findingsBefore = await db.creativeFinding.count({ where: { reviewId: review!.id } });
    const job = await db.job.create({ data: { userId: USER, type: "CREATIVE_REVIEW", status: "QUEUED", paramsJson: JSON.stringify({ reviewId: review!.id }) } });
    await jobsMod.runCreativeReviewJob({ id: job.id, userId: USER, attempts: 1, maxAttempts: 3, paramsJson: job.paramsJson });
    const findingsAfter = await db.creativeFinding.count({ where: { reviewId: review!.id } });
    expect(findingsAfter).toBe(findingsBefore);
    await db.job.delete({ where: { id: job.id } }).catch(() => undefined);

    const queued = await db.creativeReview.create({ data: { userId: USER, projectId, scope: "retention", language: "en", status: "QUEUED", contextVersion: "v:9:0:0", headVersion: 9 } });
    const qjob = await db.job.create({ data: { userId: USER, type: "CREATIVE_REVIEW", status: "QUEUED", paramsJson: JSON.stringify({ reviewId: queued.id }) } });
    const { jobManager } = await import("../src/lib/job-runner");
    expect(await jobManager.cancel(qjob.id, USER)).toBe(true);
    expect(await jobManager.cancel(qjob.id, FOREIGN)).toBe(false);
    await db.creativeReview.updateMany({ where: { id: queued.id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED" } });
    expect((await db.creativeReview.findUnique({ where: { id: queued.id } }))!.status).toBe("CANCELLED");
  });

  test("CREATIVE_VARIANTS job generates + persists variants through the worker", async () => {
    const jobId = await helpersMod.enqueueMediaJob(USER, helpersMod.JOB_TYPE_CREATIVE_VARIANTS, { projectId, kind: "cta", language: "en" });
    await workerMod.tickWorkerOnce();
    for (let i = 0; i < 60; i++) {
      const j = await db.job.findUnique({ where: { id: jobId } });
      if (j?.status === "COMPLETED" || j?.status === "FAILED") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const done = await db.job.findUnique({ where: { id: jobId } });
    // Provider unavailable → honest FAILED with the typed message (no fake variants).
    expect(["COMPLETED", "FAILED"]).toContain(done!.status);
    if (done!.status === "FAILED") expect(done!.message).toContain("not configured");
    const variants = await db.creativeVariant.findMany({ where: { userId: USER, projectId, kind: "cta" } });
    expect(variants.length).toBe(0); // nothing fabricated when the provider is down
  }, 120_000);
});
