/**
 * M32 Track A — provider capability registry, honest readiness, adapter
 * lifecycle, retry/cancellation reliability (fixture-based; NO live paid calls).
 * Run: bun test scripts/test-m32-providers.test.ts
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { VideoProvider, VideoTaskHandle, VideoTaskState, JazmiiGenerateParams } from "../src/lib/jazmii/types";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m32-prov-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
// Point the provider CLI at a path that does NOT exist — every probe must
// report CONFIGURATION REQUIRED, never a fake READY.
process.env.BEANFX_ZAI_BIN = "/nonexistent/zai-cli-m32-test";
execSync("bunx prisma db push --skip-generate --accept-data-loss", { env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` }, stdio: ["ignore", "ignore", "ignore"] });

const readiness = await import("../src/lib/providers/readiness");
const { handleJobError, requeueJob } = await import("../src/lib/job-helpers");
const { ProviderError } = await import("../src/lib/jazmii/types");
const { jobManager } = await import("../src/lib/job-runner");
const { db } = await import("../src/lib/db");
const { routeGeneration, syncGenerationAssets } = await import("../src/lib/production/showcase/generation-router");

// ── Deterministic fixture adapter (the existing VideoProvider contract) ─────
class FixtureVideoProvider implements VideoProvider {
  id = "fixture-video";
  label = "Fixture video provider (tests only)";
  capabilities = {
    operations: ["textToVideo", "imageToVideo"] as const,
    qualities: ["speed", "quality"] as const,
    sizes: ["1280x720"] as const,
    fps: ["30"] as const,
    durationsSec: ["5", "10"] as const,
    withAudio: false,
    providerProgress: true,
    commercialUse: "fixture",
    dataRetention: "fixture",
    license: "fixture",
    attribution: "fixture",
    pricingNote: "no pricing available — COST UNKNOWN",
  };
  /** Scripted states per task — deterministic, no network. */
  private scripts = new Map<string, Array<() => VideoTaskState>>();
  private submitted = 0;
  createTask(_params: JazmiiGenerateParams, _imageUrl: string | null): Promise<VideoTaskHandle> {
    this.submitted++;
    const id = `fx-task-${this.submitted}`;
    this.scripts.set(id, [
      () => ({ status: "QUEUED", videoUrl: null, providerProgress: 0, raw: null }),
      () => ({ status: "PROCESSING", videoUrl: null, providerProgress: 40, raw: null }),
      () => ({ status: "SUCCESS", videoUrl: "/tmp/fixture-output.mp4", providerProgress: 100, raw: null }),
    ]);
    return Promise.resolve({ taskId: id, model: "fixture-1", requestId: null });
  }
  pollTask(taskId: string): Promise<VideoTaskState> {
    const script = this.scripts.get(taskId);
    if (!script) throw new ProviderError("INVALID_RESPONSE", `unknown task ${taskId}`);
    const next = script.shift();
    if (!next) return Promise.resolve({ status: "FAIL" as const, videoUrl: null, providerProgress: 0, raw: null });
    return Promise.resolve(next());
  }
  submittedCount(): number { return this.submitted; }
}

describe("M32 — capability registry honesty", () => {
  test("video report: only documented capabilities true; pricing COST UNKNOWN", () => {
    const r = readiness.buildVideoCapabilityReport();
    expect(r.textToVideo).toBe(true);
    expect(r.imageToVideo).toBe(true);
    expect(r.referenceImageConditioning).toBe(true);
    expect(r.referenceVideoConditioning).toBe(false);
    expect(r.negativePrompt).toBe(false);
    expect(r.seedControl).toBe(false);
    expect(r.cancellation).toBe("none");
    expect(r.durationsSec).toEqual(["5", "10"]);
    expect(r.sizes.length).toBe(4);
    expect(r.jobStates).toContain("SUCCESS");
    expect(r.providerProgress).toBe(false); // registry truth: the provider does not return progress values
    expect(r.maxOutputBytes).toBe(500 * 1024 * 1024);
    expect(r.pricing.state).toBe("UNKNOWN"); // pricingNote is a disclaimer, not verified pricing
    expect(r.unsupported.join(" ")).toContain("reference-video conditioning");
    expect(r.unsupported.join(" ")).toContain("provider-side cancellation");
  });
  test("image report: registry honesty list carried verbatim; no invented prompts/seed", () => {
    const r = readiness.buildImageCapabilityReport();
    expect(r.operations).toEqual(["textToImage", "imageToImage"]);
    expect(r.sizes.length).toBe(7);
    expect(r.negativePrompt).toBe(false);
    expect(r.seedControl).toBe(false);
    expect(r.pricing.state).toBe("UNKNOWN");
    expect(r.unsupported.length).toBeGreaterThan(0); // e.g. transparency explicitly unsupported
  });
});

describe("M32 — honest readiness (unconfigured environment)", () => {
  test("missing provider CLI → CONFIGURATION_REQUIRED for BOTH engines (never READY)", async () => {
    const video = await readiness.videoProviderReadiness();
    const image = await readiness.imageProviderReadiness();
    expect(video.status).toBe("CONFIGURATION_REQUIRED");
    expect(video.detail).toMatch(/not installed|not configured|CLI/i);
    expect(image.status).toBe("CONFIGURATION_REQUIRED");
    expect(image.cost.state).toBe("UNKNOWN");
  });
});

describe("M32 — adapter contract (fixture lifecycle + error normalization)", () => {
  test("submit → poll QUEUED/PROCESSING → SUCCESS with url; one submission per task", async () => {
    const fx = new FixtureVideoProvider();
    const handle = await fx.createTask({ prompt: "x" }, null);
    expect(fx.submittedCount()).toBe(1);
    const s1 = await fx.pollTask(handle.taskId);
    expect(s1.status).toBe("QUEUED");
    const s2 = await fx.pollTask(handle.taskId);
    expect(s2.status).toBe("PROCESSING");
    expect(s2.providerProgress).toBeGreaterThan(0);
    const s3 = await fx.pollTask(handle.taskId);
    expect(s3.status).toBe("SUCCESS");
    expect(s3.videoUrl).toBe("/tmp/fixture-output.mp4");
  });
  test("unknown task → INVALID_RESPONSE (typed, safe message)", async () => {
    const fx = new FixtureVideoProvider();
    try {
      await fx.pollTask("fx-unknown");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe("INVALID_RESPONSE");
    }
  });
});

describe("M32 — retry classification (permanent vs transient)", () => {
  test("isTransientProviderError: config/auth/unsupported/invalid are PERMANENT; rate/timeout/failure transient", () => {
    expect(readiness.isTransientProviderError(new ProviderError("NOT_CONFIGURED", "x"))).toBe(false);
    expect(readiness.isTransientProviderError(new ProviderError("AUTH_FAILED", "x"))).toBe(false);
    expect(readiness.isTransientProviderError(new ProviderError("UNSUPPORTED", "x"))).toBe(false);
    expect(readiness.isTransientProviderError(new ProviderError("INVALID_RESPONSE", "x"))).toBe(false);
    expect(readiness.isTransientProviderError(new ProviderError("RATE_LIMITED", "x"))).toBe(true);
    expect(readiness.isTransientProviderError(new ProviderError("TIMEOUT", "x"))).toBe(true);
    expect(readiness.isTransientProviderError(new ProviderError("PROVIDER_FAILURE", "x"))).toBe(true);
  });
  test("handleJobError: AUTH_FAILED fails IMMEDIATELY (no requeue, no paid re-fire)", async () => {
    const job = await db.job.create({ data: { userId: (await db.user.create({ data: { email: `m32p-${Date.now().toString(36)}@t.local`, name: "P", passwordHash: "x", emailVerified: true } })).id, type: "JAZMII_GENERATE", status: "PROCESSING", paramsJson: "{}", maxAttempts: 3 } });
    const result = await handleJobError(job.id, new ProviderError("AUTH_FAILED", "rejected credentials"), 1, 3, "JAZMII_GENERATE");
    expect(result).toBe("failed");
    const row = await db.job.findUnique({ where: { id: job.id } });
    expect(row?.status).toBe("FAILED");
  });
  test("handleJobError: RATE_LIMITED requeues with exponential backoff runAfter", async () => {
    const user = await db.user.create({ data: { email: `m32q-${Date.now().toString(36)}@t.local`, name: "P", passwordHash: "x", emailVerified: true } });
    const job = await db.job.create({ data: { userId: user.id, type: "JAZMII_GENERATE", status: "PROCESSING", paramsJson: "{}", maxAttempts: 3 } });
    const result = await handleJobError(job.id, new ProviderError("RATE_LIMITED", "429"), 1, 3, "JAZMII_GENERATE");
    expect(result).toBe("requeued");
    const row = await db.job.findUnique({ where: { id: job.id } });
    expect(row?.status).toBe("QUEUED");
    expect(row?.runAfter).not.toBeNull();
    expect((row?.message ?? "")).toContain("retrying");
    // bounded: attempts exhausted → failed
    const result2 = await handleJobError(job.id, new ProviderError("TIMEOUT", "slow"), 3, 3, "JAZMII_GENERATE");
    expect(result2).toBe("failed");
  });
});

describe("M32 — duplicate-submission prevention (idempotency key)", () => {
  test("routeGeneration with the same idempotency key returns the EXISTING job — no second submission", async () => {
    const user = await db.user.create({ data: { email: `m32r-${Date.now().toString(36)}@t.local`, name: "P", passwordHash: "x", emailVerified: true } });
    const production = await db.production.create({ data: { userId: user.id, templateId: "showcase-studio", title: "Idem", status: "RUNNING", approvedBudgetCents: 500 } });
    // An asset row that is ALREADY routed (in flight) under key "idem-key-1".
    const routedAsset = await db.productionAsset.create({
      data: { productionId: production.id, category: "video", description: "gen shot", sourceType: "GENERATION", status: "GENERATING", provider: "zai-video", model: "cogvideox-3", idempotencyKey: "idem-key-1", provenanceJson: "{}" },
    });
    const existingJob = await db.job.create({ data: { userId: user.id, type: "JAZMII_GENERATE", status: "PROCESSING", paramsJson: "{}", maxAttempts: 3 } });
    await db.productionAsset.update({ where: { id: routedAsset.id }, data: { jobId: existingJob.id } });
    const jobsBefore = await db.job.count();

    // A SECOND routing call for a DIFFERENT asset row but the SAME key → must
    // return the existing job (deduped), never submit again.
    const secondAsset = await db.productionAsset.create({
      data: { productionId: production.id, category: "video", description: "gen shot 2", sourceType: "GENERATION", status: "PLANNED" },
    });
    const res = await routeGeneration(user.id, { assetId: secondAsset.id, kind: "generated_video", prompt: "shot", approved: true, idempotencyKey: "idem-key-1" });
    expect(res.deduped).toBe(true);
    expect(res.jobId).toBe(existingJob.id);
    const jobsAfter = await db.job.count();
    expect(jobsAfter).toBe(jobsBefore); // no new job row — no second paid call
  });
  test("unconfigured provider + approval → honest CONFIGURATION_REQUIRED, NO job created", async () => {
    const user = await db.user.create({ data: { email: `m32s-${Date.now().toString(36)}@t.local`, name: "P", passwordHash: "x", emailVerified: true } });
    const production = await db.production.create({ data: { userId: user.id, templateId: "showcase-studio", title: "NoProv", status: "RUNNING", approvedBudgetCents: 500 } });
    const asset = await db.productionAsset.create({ data: { productionId: production.id, category: "video", description: "g", sourceType: "GENERATION", status: "PLANNED" } });
    const jobsBefore = await db.job.count();
    try {
      await routeGeneration(user.id, { assetId: asset.id, kind: "generated_video", prompt: "shot", approved: true });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toMatch(/CONFIGURATION REQUIRED/i);
    }
    expect(await db.job.count()).toBe(jobsBefore);
    expect((await db.productionAsset.findUnique({ where: { id: asset.id } }))?.status).toBe("PLANNED");
  });
});

describe("M32 — cancellation reconciliation", () => {
  test("cancelled job → GENERATING asset becomes FAILED with honest detail; asset preserved", async () => {
    const user = await db.user.create({ data: { email: `m32t-${Date.now().toString(36)}@t.local`, name: "P", passwordHash: "x", emailVerified: true } });
    const production = await db.production.create({ data: { userId: user.id, templateId: "showcase-studio", title: "Cancel", status: "RUNNING" } });
    const job = await db.job.create({ data: { userId: user.id, type: "JAZMII_GENERATE", status: "PROCESSING", paramsJson: "{}", maxAttempts: 3 } });
    const asset = await db.productionAsset.create({ data: { productionId: production.id, category: "video", description: "g", sourceType: "GENERATION", status: "GENERATING", jobId: job.id } });
    const cancelled = await jobManager.cancel(job.id, user.id);
    expect(cancelled).toBe(true);
    const sync = await syncGenerationAssets(production.id);
    expect(sync.failed).toBeGreaterThanOrEqual(1);
    const row = await db.productionAsset.findUnique({ where: { id: asset.id } });
    expect(row?.status).toBe("FAILED");
    expect((row?.error ?? "").toLowerCase()).toContain("cancel");
    // mediaAssetId stays null — no fabricated output
    expect(row?.mediaAssetId).toBeNull();
  });
});
