/**
 * BEAN FX — M14 Art Direction & Motion Composition core tests (bun test,
 * isolated DB). Deterministic engines with an INJECTED STUB provider (clearly
 * labeled) + REAL local rendering (PIL compositor + FFmpeg) over real pixel
 * fixtures. Real-provider evidence lives in test-m14-live.test.ts.
 *
 * Run: bun test scripts/test-m14-core.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m14-core-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m14-core-"));
execSync("node_modules/.bin/prisma db push --skip-generate --accept-data-loss", { env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` }, stdio: ["ignore", "ignore", "inherit"] });

let db: typeof import("../src/lib/db").db;
let direction: typeof import("../src/lib/creative/m14/direction");
let scenes: typeof import("../src/lib/creative/m14/scenes");
let assets: typeof import("../src/lib/creative/m14/assets");
let presets: typeof import("../src/lib/creative/m14/presets");
let compose: typeof import("../src/lib/creative/m14/compose");
let render: typeof import("../src/lib/creative/m14/render");
let workerMod: typeof import("../src/lib/media-worker");

const USER = "m14-user";
let projectId = "";
let directionId = "";
let planId = "";
let compositionId = "";

/** STUB LLM provider (labeled): deterministic 3-direction output. */
function stubProvider(): unknown {
  const mk = (n: number): Record<string, unknown> => ({
    name: ["Cinematic Editorial", "Vintage Sketch", "Poster Color-Block"][n],
    rationale: [`Borrowed-light editorial look`, `Hand-sketched archive feel`, `Bold flat poster blocks`][n],
    styleProfile: {
      palette: [
        { hex: ["#101010", "#2a2a20", "#303030"][n], role: "bg", source: "direction" },
        { hex: ["#d4a017", "#8a6d1a", "#e0b02a"][n], role: "accent", source: "direction" },
        { hex: "#f2f0e8", role: "ink", source: "system" },
      ],
      medium: ["photographic montage", "graphite sketch", "flat vector"][n],
      texture: ["film grain", "paper tooth", "none"][n],
      lineTreatment: ["soft vignette", "inked contour", "geometric"][n],
      lighting: ["low-key", "flat", "poster-flat"][n],
      composition: "rule-of-thirds with a persistent subject",
      shapeLanguage: ["rectangles", "organic", "blocks"][n],
      consistencyRules: ["one palette per scene", "persistent subject silhouette"],
    },
    typography: "sentence-case, 30px minimum on a 1080 stage",
    backgroundTreatment: "never static — subtle drift",
    illustrationApproach: "layered cutouts",
    compositionApproach: "one persistent world",
    motionLanguage: n === 2 ? "kinetic blocks" : "motivated push-ins",
    sceneContinuity: "shared palette + persistent subject",
    assetRequirements: ["background plate", "foreground subject"],
    transitions: ["cut", "match-cut"],
    constraints: ["independent generations do NOT guarantee identical character identity"],
  });
  return {
    id: "stub-llm",
    label: "stub (test seam)",
    model: "stub-m14",
    async chat(messages: unknown[], options: unknown) {
      void messages;
      void options;
      const wantsScenes = JSON.stringify(messages).includes("sceneId");
      const content = wantsScenes
        ? JSON.stringify({ scenes: [{ sceneId: "sc1", visualConcept: "opening beat concept", compositionDescription: "subject left third", onScreenText: "திறப்பு", motionRecommendation: "soft-reveal", cameraMovement: "push-in", transitionRecommendation: "cut", confidence: 0.8 }, { sceneId: "sc2", visualConcept: "payoff concept", compositionDescription: "subject center", onScreenText: "முடிவு", motionRecommendation: "emphasis-pulse", cameraMovement: "static", transitionRecommendation: "fade", confidence: 0.7 }] })
        : JSON.stringify({ directions: [mk(0), mk(1), mk(2)] });
      return { content, model: "stub-m14", usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, latencyMs: 5 };
    },
  };
}

function tickUntil(jobId: string, timeoutMs = 300_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  return (async function loop(): Promise<string> {
    while (Date.now() < deadline) {
      await workerMod.tickWorkerOnce().catch(() => undefined);
      const row = await db.job.findUnique({ where: { id: jobId } });
      if (row && (row.status === "COMPLETED" || row.status === "FAILED" || row.status === "CANCELLED")) return row.status;
      await new Promise((r) => setTimeout(r, 700));
    }
    return "timeout";
  })();
}

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  direction = await import("../src/lib/creative/m14/direction");
  scenes = await import("../src/lib/creative/m14/scenes");
  assets = await import("../src/lib/creative/m14/assets");
  presets = await import("../src/lib/creative/m14/presets");
  compose = await import("../src/lib/creative/m14/compose");
  render = await import("../src/lib/creative/m14/render");
  workerMod = await import("../src/lib/media-worker");
  await db.user.create({ data: { id: USER, email: "m14@test.local", name: "M", passwordHash: "x" } }).catch(() => undefined);
  const p = await db.project.create({ data: { userId: USER, name: "M14 Core", description: "core" } });
  projectId = p.id;
  const ticker = setInterval(() => {
    void workerMod.tickWorkerOnce().catch(() => undefined);
  }, 700);
  ticker.unref?.();
  (globalThis as unknown as { __m14Ticker?: NodeJS.Timeout }).__m14Ticker = ticker;
}, 120_000);

afterAll(() => {
  const t = (globalThis as unknown as { __m14Ticker?: NodeJS.Timeout }).__m14Ticker;
  if (t) clearInterval(t);
  rmSync(WORK, { recursive: true, force: true });
  rmSync(SCRATCH_DB, { force: true });
});

describe("M14 art direction (§4)", () => {
  test("three DISTINCT directions generate; approval gates assets; fingerprints differ", async () => {
    const res = await direction.generateDirections(USER, projectId, { storyOrProduct: "A short explainer about filter coffee", motionIntensity: "moderate", language: "en" }, { provider: stubProvider() as never });
    expect(res.directions.length).toBe(3);
    const names = new Set(res.directions.map((d) => d.direction.name));
    expect(names.size).toBe(3);
    const fps = new Set(res.directions.map((d) => d.direction.fingerprint));
    expect(fps.size).toBe(3);
    for (const d of res.directions) {
      for (const sw of d.direction.styleProfile.palette) expect(["direction", "system", "user-brand"]).toContain(sw.source);
      expect(d.direction.constraints.join(" ")).toContain("identity");
    }
    directionId = res.directions[0].id;
    const approved = await direction.approveDirection(USER, projectId, directionId);
    expect(approved.name).toBe("Cinematic Editorial");
    const approvedRow = await direction.getApprovedDirection(USER, projectId);
    expect(approvedRow?.direction.name).toBe("Cinematic Editorial");
  });

  test("provider failures surface honestly (no silent fallback)", async () => {
    const failing = { id: "fail", label: "fail", model: "x", async chat() { throw new Error("provider down"); } };
    await expect(direction.generateDirections(USER, projectId, { storyOrProduct: "x" }, { provider: failing as never })).rejects.toThrow("provider down");
  });
});

describe("M14 scene composer (§5)", () => {
  test("RIISHE timestamps remain VERBATIM; Tamil survives end-to-end", async () => {
    const { scenes: seg } = scenes.segmentScenes({
      transcriptSegments: [
        { start: 0.53, end: 3.47, text: "Filter coffee needs fresh grounds." },
        { start: 3.47, end: 8.91, text: "தமிழ் உரை சரியாக சேமிக்கப்படுகிறது." },
        { start: 8.91, end: 12.2, text: "The pour decides the crema." },
      ],
      targetDurationSec: null,
      format: "16:9",
    });
    expect(seg.length).toBe(2); // 3 segments → ceil(3/2.5)=2 scenes (2+1 grouping)
    expect(seg[0].startSec).toBe(0.53);
    expect(seg[0].endSec).toBe(8.91); // VERBATIM: segments 0+1 grouped, real endpoints copied
    expect(seg[0].timingSource).toBe("riishe-verbatim");
    expect(seg[0].segmentRefs).toEqual([0, 1]);
    expect(seg[1].startSec).toBe(8.91);
    const doc = await scenes.buildScenePlan(USER, projectId, { artDirectionId: directionId, provider: stubProvider() as never, precomputedScenes: seg, precomputedNotes: ["test-seeded verbatim scenes"] });
    const tamilScene = doc.scenes.find((s) => s.segmentRefs.includes(1));
    // AI enrichment (stub) wrote Tamil on-screen text for the Tamil segment.
    expect(tamilScene?.onScreenText).toContain("திறப்பு");
    const row = await db.scenePlan.findFirst({ where: { userId: USER, projectId }, orderBy: { updatedAt: "desc" } });
    planId = row!.id;
    const roundtrip = JSON.parse(row!.scenesJson) as { scenes: { onScreenText: string }[] };
    expect(roundtrip.scenes.some((s) => s.onScreenText.includes("திறப்பு"))).toBe(true);
  });

  test("estimated timings are explicitly labelled when no transcript exists", () => {
    const { scenes: est, notes } = scenes.segmentScenes({ transcriptSegments: null, targetDurationSec: 18, format: "16:9" });
    expect(est.every((s) => s.timingSource === "estimated")).toBe(true);
    expect(notes.join(" ")).toContain("ESTIMATES");
    expect(est[0].evidence).toContain("ESTIMATE");
  });

  test("manual edit: duration override flags REVISED + re-labels as estimate; reorder works", async () => {
    const edited = await scenes.editScenePlan(USER, projectId, planId, {
      durations: [{ sceneId: "sc1", endSec: 4.0 }],
      order: ["sc2", "sc1", "sc3"],
      note: "test edit",
    });
    expect(edited.scenes[0].sceneId).toBe("sc2");
    const sc1 = edited.scenes.find((s) => s.sceneId === "sc1");
    expect(sc1?.timingSource).toBe("estimated");
    expect(sc1?.approvalStatus).toBe("REVISED");
    expect(sc1?.endSec).toBe(4.0);
  });

  test("regenerating ONE scene preserves approved scenes (stub provider)", async () => {
    await scenes.editScenePlan(USER, projectId, planId, { approve: ["sc2"] });
    const regenerated = await scenes.regenerateScene(USER, projectId, planId, "sc1", { provider: stubProvider() as never });
    const sc2 = regenerated.scenes.find((s) => s.sceneId === "sc2");
    expect(sc2?.approvalStatus).toBe("APPROVED");
    const sc1 = regenerated.scenes.find((s) => s.sceneId === "sc1");
    expect(sc1?.approvalStatus).toBe("REVISED");
  });
});

describe("M14 LAXII asset workflow (§6)", () => {
  test("alpha verification uses ACTUAL pixels (RGBA PNG vs JPEG)", async () => {
    const rgba = path.join(WORK, "alpha.png");
    execFileSync("python3", ["-c", `from PIL import Image\nim = Image.new("RGBA", (32, 32), (200, 160, 23, 128))\nim.save("${rgba}")`]);
    const jpg = path.join(WORK, "flat.jpg");
    execFileSync("python3", ["-c", `from PIL import Image\nim = Image.new("RGB", (32, 32), (10, 10, 10))\nim.save("${jpg}")`]);
    const a = await assets.verifyAlpha(rgba);
    expect(a.hasAlpha).toBe(true);
    expect(a.alphaCoverage ?? 0).toBeGreaterThan(0.5);
    const b = await assets.verifyAlpha(jpg);
    expect(b.hasAlpha).toBe(false);
  });

  test("asset generation requires an APPROVED direction (refusal otherwise)", async () => {
    // Foreign project with no approved direction.
    const p2 = await db.project.create({ data: { userId: USER, name: "M14 NoDirection" } });
    await expect(assets.generateSceneAsset(USER, p2.id, { projectId: p2.id, sceneId: "sc1", role: "background", prompt: "x" })).rejects.toThrow("APPROVED");
  });
});

describe("M14 NIIKI motion presets (§7)", () => {
  test("all 9 presets produce deterministic, valid keyframes (rational FPS frame math)", () => {
    const ids = ["soft-reveal", "cinematic-push-in", "floating-movement", "bounce-entrance", "kinetic-typography", "scene-transition", "parallax-drift", "track-following-graphic", "emphasis-pulse"] as const;
    for (const id of ids) {
      const a = presets.applyMotionPreset(id, { startFrame: 0, endFrame: 60, restX: 320, restY: 180, intensity: 2, fps: 29.97 });
      const b = presets.applyMotionPreset(id, { startFrame: 0, endFrame: 60, restX: 320, restY: 180, intensity: 2, fps: 29.97 });
      expect(a.length).toBe(b.length);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // deterministic
      for (const k of a) {
        expect(Number.isInteger(k.frame)).toBe(true);
        expect(Number.isFinite(k.value)).toBe(true);
        expect(["x", "y", "scale", "rotation", "opacity"]).toContain(k.property);
      }
    }
  });

  test("evalKeyframes mirrors the NIIKI easing family (EASE_OUT spot value)", () => {
    const kfs = [
      { id: "k1", property: "opacity" as const, frame: 0, value: 0, interpolation: "EASE_OUT" as const },
      { id: "k2", property: "opacity" as const, frame: 20, value: 1, interpolation: "EASE_OUT" as const },
    ];
    // easeProgress EASE_OUT at u=0.5 = 0.875 → 0.875.
    expect(presets.evalKeyframes(kfs, "opacity", 10, 0)).toBeCloseTo(0.875, 3);
    expect(presets.evalKeyframes(kfs, "opacity", 25, 0)).toBe(1);
    expect(presets.evalKeyframes(kfs, "opacity", -5, 0)).toBe(0);
  });
});

describe("M14 composition engine (§8/§9)", () => {
  test("create + validation gates (limits, NaN, unknown mask, anti-PowerPoint)", async () => {
    const created = await compose.createComposition(USER, projectId, "Core Comp", {
      width: 640, height: 360, fps: 30, durationFrames: 60,
      layers: [
        { id: "bg", name: "bg", kind: "background", color: "#101010", visible: true, locked: false, blend: "normal", transform: { x: 320, y: 180, scale: 1, rotation: 0, opacity: 1 }, startFrame: 0, endFrame: 60, keyframes: [], mask: null },
        { id: "fg", name: "fg", kind: "shape", color: "#d4a017", visible: true, locked: false, blend: "normal", transform: { x: 320, y: 180, scale: 1, rotation: 0, opacity: 1 }, startFrame: 0, endFrame: 60, keyframes: [{ id: "k1", property: "opacity", frame: 0, value: 0.5, interpolation: "LINEAR" }], mask: null },
      ],
    });
    compositionId = created.id;
    expect(created.version).toBe(1);
    expect(created.issues.length).toBe(0);
    // Validation gates:
    await expect(compose.createComposition(USER, projectId, "Bad NaN", { width: 640, height: 360, fps: 30, durationFrames: 60, layers: [{ id: "l", name: "l", kind: "shape", color: "#d4a017", visible: true, locked: false, blend: "normal", transform: { x: Number.NaN, y: 0, scale: 1, rotation: 0, opacity: 1 }, startFrame: 0, endFrame: 60, keyframes: [], mask: null }] })).rejects.toThrow();
    const { issues } = compose.validateComposition({ width: 640, height: 360, fps: 30, durationFrames: 60, layers: [{ id: "m", name: "m", kind: "shape", color: "#d4a017", visible: true, locked: false, blend: "normal", transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, startFrame: 0, endFrame: 60, keyframes: [], mask: { sourceLayerId: "ghost" } }] });
    expect(issues.join(" ")).toContain("unknown layer");
    const staticGate = compose.validateComposition({ width: 640, height: 360, fps: 30, durationFrames: 60, layers: [{ id: "b", name: "b", kind: "background", color: "#101010", visible: true, locked: false, blend: "normal", transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, startFrame: 0, endFrame: 60, keyframes: [], mask: null }, { id: "f", name: "f", kind: "shape", color: "#d4a017", visible: true, locked: false, blend: "normal", transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, startFrame: 0, endFrame: 60, keyframes: [], mask: null }] });
    expect(staticGate.issues.join(" ")).toContain("Anti-PowerPoint");
  });

  test("evaluator: frame-range visibility, keyframe interpolation, opacity clamp", () => {
    const doc = {
      analysisVersion: "m14-composition-1.0", width: 640, height: 360, fps: 30, durationFrames: 60,
      layers: [
        { id: "bg", name: "bg", kind: "background", color: "#101010", visible: true, locked: false, blend: "normal", transform: { x: 320, y: 180, scale: 1, rotation: 0, opacity: 1 }, startFrame: 0, endFrame: 60, keyframes: [], mask: null },
        { id: "fg", name: "fg", kind: "shape", color: "#d4a017", visible: true, locked: false, blend: "normal", transform: { x: 320, y: 180, scale: 1, rotation: 0, opacity: 1.5 }, startFrame: 10, endFrame: 30, keyframes: [{ id: "kx", property: "x", frame: 10, value: 100, interpolation: "LINEAR" }, { id: "kx2", property: "x", frame: 20, value: 200, interpolation: "LINEAR" }], mask: null },
      ],
    } as never;
    const st0 = compose.evaluateCompositionAt(doc as never, 0);
    expect(st0.layers.length).toBe(1); // fg not yet active
    const st15 = compose.evaluateCompositionAt(doc as never, 15);
    const fg = st15.layers.find((l) => l.layerId === "fg")!;
    expect(fg.x).toBe(150); // mid-interpolation
    expect(fg.opacity).toBeLessThanOrEqual(1); // clamped
    const st40 = compose.evaluateCompositionAt(doc as never, 40);
    expect(st40.layers.find((l) => l.layerId === "fg")).toBeUndefined(); // ended
  });

  test("optimistic concurrency: stale version rejected; commit bumps version", async () => {
    const row = await db.composition.findUnique({ where: { id: compositionId } });
    const doc = JSON.parse(row!.docJson);
    await expect(compose.commitComposition(USER, projectId, compositionId, row!.version + 5, doc, "stale")).rejects.toThrow("Concurrent edit");
    const committed = await compose.commitComposition(USER, projectId, compositionId, row!.version, doc, "bump");
    expect(committed.version).toBe(row!.version + 1);
  });

  test("undo/redo: version switch restores the EXACT prior document", async () => {
    const row = await db.composition.findUnique({ where: { id: compositionId } });
    const before = row!.docJson;
    const doc = JSON.parse(before);
    (doc.layers[1].transform as { x: number }).x = 999;
    await compose.commitComposition(USER, projectId, compositionId, row!.version, doc, "moved");
    const switched = await compose.switchCompositionVersion(USER, projectId, compositionId, row!.version);
    expect(JSON.stringify(switched.doc)).toBe(JSON.stringify(JSON.parse(before)));
    const after = await db.composition.findUnique({ where: { id: compositionId } });
    expect(JSON.parse(after!.docJson).layers[1].transform.x).toBe(320);
  });

  test("M13 tracking attach: REAL sample math, gap HOLD policy, honest refusals", async () => {
    // Seed a FIXTURE temporal index (real M13 schema shape; the M13 suite
    // covers real tracking — here the binding math is under test).
    await db.creativeAnalysisArtifact.create({ data: { userId: USER, projectId, kind: "temporal-index", status: "COMPLETED", depsHash: "m14-fixture", depsJson: "{}", resultJson: JSON.stringify({ assetId: "assetX", tracks: [{ trackId: "assetX:w0t0", samples: [{ sourceSec: 0, nx: 0.25, ny: 0.5, visibility: "visible" }, { sourceSec: 0.2, nx: 0.5, ny: 0.5, visibility: "visible" }, { sourceSec: 0.4, nx: 0.75, ny: 0.5, visibility: "occluded" }, { sourceSec: 0.6, nx: 0.9, ny: 0.5, visibility: "visible" }] }] }) } });
    const row = await db.composition.findUnique({ where: { id: compositionId } });
    const attached = await compose.attachLayerToTrack(USER, projectId, compositionId, row!.version, "fg", "assetX:w0t0", "assetX", { startFrame: 0, endFrame: 60 }, { x: 0, y: 0 });
    expect(attached.version).toBe(row!.version + 1);
    expect(attached.warnings.join(" ")).toContain("HOLDS");
    const comp = await compose.getComposition(USER, projectId, compositionId);
    // Frame 15 (0.5s @30fps): last VISIBLE sample ≤ 0.5s is nx=0.5 → x = 0.5*640.
    const st15 = compose.evaluateCompositionAt(comp.doc, 15, [{ layerId: "fg", samples: [{ sourceSec: 0, nx: 0.25, ny: 0.5, visibility: "visible" }, { sourceSec: 0.2, nx: 0.5, ny: 0.5, visibility: "visible" }, { sourceSec: 0.4, nx: 0.75, ny: 0.5, visibility: "occluded" }, { sourceSec: 0.6, nx: 0.9, ny: 0.5, visibility: "visible" }], sourceOffsetSec: 0 }]);
    const fg15 = st15.layers.find((l) => l.layerId === "fg")!;
    expect(fg15.trackX).toBe(320); // HOLDS the last VISIBLE measurement (0.2s, nx=0.5) — the occluded 0.4s sample is NOT trusted
    expect(fg15.trackGap).toBe(true); // honestly flagged: the interval since 0.4s is occluded
    // Frame 21 (0.7s): sample at 0.4 is occluded, 0.6 visible → holds LAST VISIBLE (0.6 → x=576), not the occluded 0.75.
    const st21 = compose.evaluateCompositionAt(comp.doc, 21, [{ layerId: "fg", samples: [{ sourceSec: 0, nx: 0.25, ny: 0.5, visibility: "visible" }, { sourceSec: 0.2, nx: 0.5, ny: 0.5, visibility: "visible" }, { sourceSec: 0.4, nx: 0.75, ny: 0.5, visibility: "occluded" }, { sourceSec: 0.6, nx: 0.9, ny: 0.5, visibility: "visible" }], sourceOffsetSec: 0 }]);
    const fg21 = st21.layers.find((l) => l.layerId === "fg")!;
    expect(fg21.trackX).toBe(576);
    expect(fg21.trackGap).toBe(false);
    const detached = await compose.detachLayerFromTrack(USER, projectId, compositionId, attached.version, "fg");
    expect(detached.version).toBe(attached.version + 1);
    await expect(compose.loadTrackSamples(USER, projectId, "assetX:w0t9", "assetX")).rejects.toThrow("not found");
    await expect(compose.loadTrackSamples(USER, projectId, "assetX:w0t0", "assetOTHER")).rejects.toThrow("belongs to asset");
  });
});

describe("M14 real rendering (§8) — PIL compositor + FFmpeg through the REAL worker", () => {
  test("REAL render: alpha/blend pixel fixtures, encode, provenance, cleanup", async () => {
    const { enqueueCompositionRender } = render;
    // Composition with known pixel math:
    // bg #202020; red shape #ff0000 normal @ opacity 1; green #00ff00 multiply over red;
    // white #ffffff screen over the multiply result; text layer excluded from pixel check.
    const created = await compose.createComposition(USER, projectId, "Pixel Comp", {
      width: 320, height: 180, fps: 10, durationFrames: 10,
      layers: [
        { id: "bg", name: "bg", kind: "background", color: "#202020", visible: true, locked: false, blend: "normal", transform: { x: 160, y: 90, scale: 1, rotation: 0, opacity: 1 }, startFrame: 0, endFrame: 10, keyframes: [], mask: null },
        { id: "red", name: "red", kind: "shape", color: "#ff0000", visible: true, locked: false, blend: "normal", transform: { x: 80, y: 90, scale: 1, rotation: 0, opacity: 1 }, startFrame: 0, endFrame: 10, keyframes: [], mask: null },
        { id: "green", name: "green", kind: "shape", color: "#00ff00", visible: true, locked: false, blend: "multiply", transform: { x: 80, y: 90, scale: 1, rotation: 0, opacity: 1 }, startFrame: 0, endFrame: 10, keyframes: [], mask: null },
        { id: "white", name: "white", kind: "shape", color: "#ffffff", visible: true, locked: false, blend: "screen", transform: { x: 240, y: 90, scale: 0.5, rotation: 0, opacity: 1 }, startFrame: 0, endFrame: 10, keyframes: [], mask: null },
      ],
    });
    const enq = await enqueueCompositionRender(USER, projectId, created.id, 0, 10);
    const status = await tickUntil(enq.jobId);
    expect(status).toBe("COMPLETED");
    const job = await db.job.findUnique({ where: { id: enq.jobId } });
    expect(job?.exportId).toBeTruthy();
    const video = await db.mediaAsset.findUnique({ where: { id: job!.exportId! } });
    expect(video?.kind).toBe("VIDEO");
    // Probe the real encoded file.
    const probe = JSON.parse(execSync(`ffprobe -v error -print_format json -show_streams -select_streams v "${video!.storagePath}"`, { encoding: "utf8" }));
    const vs = probe.streams[0];
    expect(vs.width).toBe(320);
    expect(vs.height).toBe(180);
    expect(Number(vs.nb_frames)).toBe(10);
    // PIXEL PARITY: extract frame 5 and compare against the deterministic math.
    const frame5 = path.join(WORK, "f5.png");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", video!.storagePath, "-vf", "select=eq(n\\,4)", "-frames:v", "1", frame5]);
    const pixelOut = execFileSync("python3", ["-c", `
import sys
from PIL import Image
im = Image.open("${frame5}").convert("RGB")
# multiply: red(255,0,0) x green(0,255,0) = (0,0,0); over bg at (80,90)
print("mult", im.getpixel((80, 90)))
# screen: white screen over bg(32,32,32) = (255,255,255) at (240,90)
print("screen", im.getpixel((240, 90)))
# plain bg at (280, 30) (outside the multiply region x0..240)
print("bg", im.getpixel((280, 30)))
`], { encoding: "utf8" });
    const mult = pixelOut.match(/mult \((\d+), (\d+), (\d+)\)/)!.slice(1).map(Number);
    const screen = pixelOut.match(/screen \((\d+), (\d+), (\d+)\)/)!.slice(1).map(Number);
    const bg = pixelOut.match(/bg \((\d+), (\d+), (\d+)\)/)!.slice(1).map(Number);
    // Documented pixel tolerance ±6 (JPEG + chroma subsampling).
    expect(Math.abs(mult[0] - 0)).toBeLessThanOrEqual(6);
    expect(Math.abs(mult[1] - 0)).toBeLessThanOrEqual(6);
    expect(Math.abs(mult[2] - 0)).toBeLessThanOrEqual(6);
    for (const v of screen) expect(Math.abs(v - 255)).toBeLessThanOrEqual(6);
    for (const v of bg) expect(Math.abs(v - 32)).toBeLessThanOrEqual(6);
    // Limits: oversized canvas refused.
    await expect(compose.createComposition(USER, projectId, "TooBig", { width: 2560, height: 1440, fps: 30, durationFrames: 10, layers: [] })).rejects.toThrow();
  }, 420_000);
});
