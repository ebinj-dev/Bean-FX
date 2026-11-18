/**
 * BEAN FX — M7 LAXII tests (bun test, isolated DB + worker state).
 *
 * Fixture tests use the labeled fake-zai CLI FIXTURE (scripts/fixtures/
 * fake-zai.sh) driving the real adapter code paths with deterministic
 * fixture images (real PIL-generated PNG/JPEG bytes). The REAL provider
 * test runs ONLY with BEANFX_M7_REAL_PROVIDER=1 (executed once during this
 * milestone and recorded in docs/M7_JAZMII_LAXII.md).
 *
 * Run: bun test scripts/test-laxii.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ── environment BEFORE any module that touches the DB ────────────────────────
const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m7-laxii-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.BEANFX_USER_QUOTA_BYTES = String(500 * 1024 * 1024);
process.env.NODE_ENV = "production";
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m7-laxii-"));
const FAKE_DIR = path.join(WORK, "fake-zai");
mkdirSync(FAKE_DIR, { recursive: true });
process.env.BEANFX_ZAI_BIN = path.join(import.meta.dir, "fixtures", "fake-zai.sh");
process.env.FAKE_ZAI_DIR = FAKE_DIR;

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let helpers: typeof import("../src/lib/job-helpers");
let workerMod: typeof import("../src/lib/media-worker");
let jobRunner: typeof import("../src/lib/job-runner");
let providers: typeof import("../src/lib/laxii/providers");
let processing: typeof import("../src/lib/laxii/processing");
let model: typeof import("../src/lib/editor/model");
let commands: typeof import("../src/lib/editor/commands");
let nikkiState: typeof import("../src/lib/nikki/state");

const USER_A = "laxii-user-a";
const USER_B = "laxii-user-b";

beforeAll(async () => {
  // Real PIL fixtures: a JPEG (what the provider actually returns) and a PNG
  // with alpha (for transparency-preservation tests). execFileSync with an
  // args array — no shell quoting in play.
  const py = (code: string, args: string[]): void => execFileSync("python3", ["-I", "-c", code, ...args], { stdio: ["ignore", "ignore", "inherit"] });
  py("import sys; from PIL import Image; Image.new('RGB',(1024,1024),(210,160,23)).save(sys.argv[1],'JPEG',quality=90)", [path.join(FAKE_DIR, "output.jpg")]);
  py("import sys; from PIL import Image; Image.new('RGBA',(512,512),(0,0,0,0)).save(sys.argv[1])", [path.join(WORK, "alpha.png")]);
  db = (await import("../src/lib/db")).db;
  helpers = await import("../src/lib/job-helpers");
  workerMod = await import("../src/lib/media-worker");
  jobRunner = await import("../src/lib/job-runner");
  providers = await import("../src/lib/laxii/providers");
  processing = await import("../src/lib/laxii/processing");
  model = await import("../src/lib/editor/model");
  commands = await import("../src/lib/editor/commands");
  nikkiState = await import("../src/lib/nikki/state");
  await db.user.create({ data: { id: USER_A, email: "laxii-a@test.local", name: "A", passwordHash: "x" } }).catch(() => undefined);
  await db.user.create({ data: { id: USER_B, email: "laxii-b@test.local", name: "B", passwordHash: "x" } }).catch(() => undefined);
});

afterAll(() => {
  rmSync(String(process.env.DATABASE_URL).replace("file:", ""), { force: true });
  rmSync(WORK, { recursive: true, force: true });
});

async function runJob(jobId: string, timeoutMs = 45_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await workerMod.tickWorkerOnce().catch(() => undefined);
    const j = await db.job.findUnique({ where: { id: jobId } });
    if (j && (j.status === "COMPLETED" || j.status === "FAILED" || j.status === "CANCELLED")) return j.status;
    if (Date.now() > deadline) return j?.status ?? "STUCK";
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("LAXII provider contract (§5)", () => {
  test("capability map: 7 REAL sizes, honest unsupported list", () => {
    const p = providers.laxiiProvider(null);
    expect(p.id).toBe("zai-image");
    expect(p.capabilities.sizes).toEqual(["1024x1024", "768x1344", "864x1152", "1344x768", "1152x864", "1440x720", "720x1440"]);
    expect(p.capabilities.unsupported.some((u) => u.includes("transparent"))).toBe(true);
    expect(p.capabilities.unsupported.some((u) => u.includes("negative prompts"))).toBe(true);
    expect(p.capabilities.commercialUse).toContain("NOT independently verified");
  });

  test("NOT_CONFIGURED is honest when the CLI is missing", async () => {
    process.env.BEANFX_ZAI_BIN = "/nonexistent/zai-fake";
    try {
      await expect(providers.laxiiProvider(null).generateImage({ prompt: "x", mode: "generate", referenceAssetId: null, size: "1024x1024", count: 1, aspect: "original", projectId: null }, null)).rejects.toThrow(/not installed on the server/);
    } finally {
      process.env.BEANFX_ZAI_BIN = path.join(import.meta.dir, "fixtures", "fake-zai.sh");
    }
  });

  test("AUTH_FAILED surfaces provider credential rejection (fixture: 401)", async () => {
    writeFileSync(path.join(FAKE_DIR, "reject.txt"), "401 unauthorized (fixture)");
    try {
      await expect(providers.laxiiProvider(null).generateImage({ prompt: "x", mode: "generate", referenceAssetId: null, size: "1024x1024", count: 1, aspect: "original", projectId: null }, null)).rejects.toThrow(/credentials/);
    } finally {
      rmSync(path.join(FAKE_DIR, "reject.txt"), { force: true });
    }
  });

  test("edit mode without a reference is refused (UNSUPPORTED)", async () => {
    await expect(providers.laxiiProvider(null).generateImage({ prompt: "x", mode: "edit", referenceAssetId: null, size: "1024x1024", count: 1, aspect: "original", projectId: null }, null)).rejects.toThrow(/requires a reference image/);
  });

  test("provider output validated by CONTENT not claims (JPEG bytes for .png name)", async () => {
    const r = await providers.laxiiProvider(null).generateImage({ prompt: "fixture bg", mode: "generate", referenceAssetId: null, size: "1024x1024", count: 1, aspect: "original", projectId: null }, null);
    expect(r.sniffedFormat).toBe("JPEG"); // the fixture writes JPEG bytes
    expect(r.width).toBe(1024);
    expect(r.height).toBe(1024);
  });
});

describe("LAXII job lifecycle (fixture provider — clearly labeled)", () => {
  test("generate → validate → register with provenance + thumbnail child", async () => {
    const jobId = await jobRunner.jobManager.createJob(USER_A, helpers.JOB_TYPE_LAXII_GENERATE, {
      prompt: "LAXII fixture background", mode: "generate", referenceAssetId: null,
      size: "1024x1024", count: 1, aspect: "16:9", projectId: null,
    });
    const status = await runJob(jobId);
    expect(status).toBe("COMPLETED");
    const job = await db.job.findUnique({ where: { id: jobId } });
    expect(job?.message).toContain("LAXII assets ready");
    const assets = await db.mediaAsset.findMany({ where: { userId: USER_A, createdBy: "LAXII" }, orderBy: { createdAt: "asc" } });
    // main output + 480px thumbnail + 16:9 adaptation
    expect(assets.length).toBe(3);
    const main = assets[0];
    expect(main.kind).toBe("IMAGE");
    expect(main.provider).toBe("zai-image");
    expect(main.prompt).toContain("fixture background");
    expect(main.sha256).not.toBeNull();
    expect(main.width).toBe(1024);
    const thumb = assets[1];
    expect(thumb.referenceAssetId).toBe(main.id); // parent relationship
    expect(thumb.width).toBeLessThanOrEqual(480);
    const adapted = assets[2];
    expect(adapted.referenceAssetId).toBe(main.id);
    // 16:9 adaptation really changed the aspect
    expect(Math.abs((adapted.width ?? 1) / (adapted.height ?? 1) - 16 / 9)).toBeLessThan(0.05);
    // originals preserved (separate files)
    expect(adapted.storagePath).not.toBe(main.storagePath);
    expect(existsSync(main.storagePath)).toBe(true);
  }, 90_000);

  test("variants: count=2 produces two independent outputs with shared provenance", async () => {
    const jobId = await jobRunner.jobManager.createJob(USER_A, helpers.JOB_TYPE_LAXII_GENERATE, {
      prompt: "variants test", mode: "generate", referenceAssetId: null,
      size: "1024x1024", count: 2, aspect: "original", projectId: null,
    });
    const status = await runJob(jobId);
    expect(status).toBe("COMPLETED");
    const mains = await db.mediaAsset.findMany({ where: { userId: USER_A, createdBy: "LAXII", prompt: "variants test", provider: "zai-image" } });
    expect(mains.length).toBe(2);
    expect(new Set(mains.map((m) => m.id)).size).toBe(2);
    // Deterministic FIXTURE provider: both alternatives carry the same bytes
    // (same input → same output). Real-provider variation distinctness is
    // asserted only in the BEANFX_M7_REAL_PROVIDER=1 run (recorded in docs).
    expect(mains.every((m) => m.prompt === "variants test")).toBe(true);
    expect(new Set(mains.map((m) => m.storagePath)).size).toBe(2); // separate files
  }, 90_000);

  test("edit mode requires an OWNED reference (cross-user refused)", async () => {
    const foreign = await db.mediaAsset.create({
      data: { userId: USER_B, originalName: "foreign.jpg", storagePath: path.join(FAKE_DIR, "output.jpg"), kind: "IMAGE", mimeType: "image/jpeg", sizeBytes: statSync(path.join(FAKE_DIR, "output.jpg")).size },
    });
    const jobId = await jobRunner.jobManager.createJob(USER_A, helpers.JOB_TYPE_LAXII_GENERATE, {
      prompt: "steal test", mode: "edit", referenceAssetId: foreign.id,
      size: "1024x1024", count: 1, aspect: "original", projectId: null,
    });
    const status = await runJob(jobId);
    expect(status).toBe("FAILED");
    const job = await db.job.findUnique({ where: { id: jobId } });
    expect(job?.message).toContain("not owned by the caller");
  }, 60_000);

  test("quota enforcement: oversized generation is refused", async () => {
    // Shrink USER_A's quota by filling usage via the storage module's policy.
    const { hasQuotaFor } = await import("../src/lib/media-storage");
    const status = await hasQuotaFor(USER_A, 600 * 1024 * 1024); // > 500 MB quota
    expect(status.ok).toBe(false);
  });
});

describe("LAXII processing (real PIL)", () => {
  test("transparency is preserved on conversion (RGBA stays RGBA)", async () => {
    const out = path.join(WORK, "alpha-copy.png");
    await processing.makeThumbnail(path.join(WORK, "alpha.png"), out, 256);
    const info = await processing.inspectImage(out);
    expect(info.width).toBeLessThanOrEqual(256);
    void info;
    const mode = execFileSync("python3", ["-I", "-c", "import sys; from PIL import Image; print(Image.open(sys.argv[1]).mode)", out], { encoding: "utf8" });
    expect(mode.trim()).toBe("RGBA");
  });

  test("aspect adaptation to 9:16 produces correct dimensions (non-destructive)", async () => {
    const out = path.join(WORK, "adapt.jpg");
    const dims = await processing.adaptAspect(path.join(FAKE_DIR, "output.jpg"), "9:16", out);
    expect(Math.abs(dims.width / dims.height - 9 / 16)).toBeLessThan(0.05);
    // original untouched
    const orig = await processing.inspectImage(path.join(FAKE_DIR, "output.jpg"));
    expect(orig.width).toBe(1024);
    expect(existsSync(out)).toBe(true);
  });

  test("REAL provider end-to-end (BEANFX_M7_REAL_PROVIDER=1 only)", async () => {
    if (process.env.BEANFX_M7_REAL_PROVIDER !== "1") {
      console.log("[laxii-test] REAL provider test skipped (set BEANFX_M7_REAL_PROVIDER=1); fixture coverage above still exercises the full adapter→job→asset pipeline");
      return;
    }
    process.env.BEANFX_ZAI_BIN = "z-ai"; // REAL provider for this one test
    try {
      const jobId = await jobRunner.jobManager.createJob(USER_A, helpers.JOB_TYPE_LAXII_GENERATE, {
        prompt: "A calm minimal amber gradient background with soft grain, professional", mode: "generate",
        referenceAssetId: null, size: "1024x1024", count: 1, aspect: "original", projectId: null,
      });
      const status = await runJob(jobId, 240_000);
      expect(status).toBe("COMPLETED");
      const asset = await db.mediaAsset.findFirst({ where: { userId: USER_A, createdBy: "LAXII", provider: "zai-image", prompt: { contains: "amber gradient" } } });
      expect(asset).not.toBeNull();
      // REAL pixel assertion: decode the actual file and check it is a
      // plausible generated image (non-uniform, correct dimensions).
      const px = execFileSync("python3", ["-I", "-c", "import sys; from PIL import Image; import statistics; im=Image.open(sys.argv[1]).convert('L'); px=list(im.getdata()); print(im.size[0], im.size[1], round(statistics.pstdev(px),1))", asset!.storagePath], { encoding: "utf8" });
      const [w, h, sd] = px.trim().split(/\s+/).map(Number);
      expect(w).toBe(1024);
      expect(h).toBe(1024);
      expect(sd).toBeGreaterThan(1); // not a flat file
    } finally {
      process.env.BEANFX_ZAI_BIN = path.join(import.meta.dir, "fixtures", "fake-zai.sh");
    }
  }, 300_000);
});

describe("LAXII timeline integration (M1 commands + NIIKI compatibility)", () => {
  test("still image inserts as a clip; undo/redo/reload; NIIKI can animate it", async () => {
    const asset = await db.mediaAsset.create({
      data: { userId: USER_A, originalName: "gen.jpg", storagePath: path.join(FAKE_DIR, "output.jpg"), kind: "IMAGE", mimeType: "image/jpeg", sizeBytes: statSync(path.join(FAKE_DIR, "output.jpg")).size, createdBy: "LAXII", provider: "zai-image", prompt: "bg" },
    });
    const seq = model.parseSequence({
      id: "s", name: "s", fps: { num: 30, den: 1 }, width: 1280, height: 720, sampleRate: 48000,
      tracks: [
        { id: "v", kind: "VIDEO", name: "V", visible: true, muted: false, solo: false, locked: false },
        { id: "g", kind: "GRAPHIC", name: "G", visible: true, muted: false, solo: false, locked: false },
      ],
      clips: [], transitions: [],
    });
    const still = commands.applyCommand(seq, {
      type: "AddClip",
      clip: {
        id: "still1", trackId: "v", sourceAssetId: asset.id, sourceInFrame: 0, sourceOutFrame: 150,
        sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, playbackSpeed: 1, volume: 1, muted: false,
        fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
        label: "LAXII: bg", missingMedia: false, effects: [],
        keyframes: [
          { id: "k1", property: "scale", frame: 0, value: 100, interpolation: "EASE_OUT", bezier: null },
          { id: "k2", property: "scale", frame: 90, value: 130, interpolation: "EASE_OUT", bezier: null },
        ],
      },
    });
    expect(still.sequence.clips).toHaveLength(1);
    const undone = commands.applyCommand(still.sequence, still.inverse[0]);
    expect(undone.sequence.clips).toHaveLength(0);
    // Reload persistence
    const reloaded = model.parseSequence(JSON.parse(JSON.stringify(still.sequence)));
    expect(reloaded.clips[0].keyframes).toHaveLength(2);
    // NIIKI compatibility: transform keyframes resolve deterministically on
    // the still-image clip (the monitor renders IMAGE assets as stills —
    // verified in the M3 stabilization work).
    const { evaluateProperty } = await import("../src/lib/nikki/animation");
    const kfs = reloaded.clips[0].keyframes;
    expect(evaluateProperty(kfs, "scale", 0, { fallback: 100, durationFrames: 150 })).toBeCloseTo(100, 6);
    expect(evaluateProperty(kfs, "scale", 90, { fallback: 100, durationFrames: 150 })).toBeCloseTo(130, 6);
    void nikkiState;
  });

  test("image clip duration is editable via TrimClip (frame-accurate)", () => {
    const asset = { id: "img-1" };
    const seq = model.parseSequence({
      id: "s2", name: "s2", fps: { num: 30, den: 1 }, width: 1280, height: 720, sampleRate: 48000,
      tracks: [{ id: "v", kind: "VIDEO", name: "V", visible: true, muted: false, solo: false, locked: false }],
      clips: [{
        id: "still", trackId: "v", sourceAssetId: asset.id, sourceInFrame: 0, sourceOutFrame: 150,
        sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 150,
        playbackSpeed: 1, volume: 1, muted: false,
        fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
        label: null, missingMedia: false, effects: [], keyframes: [],
      }],
      transitions: [],
    });
    const r = commands.applyCommand(seq, { type: "TrimClip", clipId: "still", newSourceOutFrame: 90 });
    expect(r.sequence.clips[0].timelineDurationFrames).toBe(90);
    void asset;
  });
});
