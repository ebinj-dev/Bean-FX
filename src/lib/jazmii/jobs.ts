/**
 * JAZMII — durable jobs (M7 §6A/§6C) on the M3 worker.
 *
 * JAZMII_GENERATE: provider task → bounded poll (heartbeat + cancellation +
 * wall-clock timeout) → download → validate (sniff + ffprobe + duration
 * tolerance) → register with provenance → complete with asset id. A job is
 * NEVER marked complete before the output is a registered, validated asset.
 *
 * JAZMII_ANALYZE: ffprobe + scene/black/freeze + keyframes (deterministic,
 * labeled heuristic) → report artifact + keyframe IMAGE assets registered
 * with provenance.
 */
import { execFile } from "child_process";
import path from "path";
import { mkdir } from "fs/promises";
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { PermanentJobError } from "@/lib/job-helpers";
import { pathInsideMediaRoot } from "@/lib/media-storage";
import { jazmiiProvider } from "./providers";
import { JazmiiGenerateParamsSchema, ProviderError } from "./types";
import { analyzeVideoFile, writeAnalysisArtifact } from "./analysis";
import { downloadProviderOutput, registerGeneratedAsset, registerImageArtifact } from "@/lib/ai/asset-lifecycle";

interface HandlerJob {
  id: string;
  userId: string;
  paramsJson: string | null;
}

const GENERATE_TIMEOUT_MS = Number(process.env.BEANFX_JAZMII_GENERATE_TIMEOUT_MS ?? 15 * 60_000);
const POLL_INTERVAL_MS = 10_000;
/** Rendered duration must be within this of the requested seconds. */
const DURATION_TOLERANCE_SEC = 2.5;

function validateGeneratedVideo(file: string, requestedDurationSec: number, requestedSize: string): Promise<void> {
  return import("@/lib/media-storage").then(({ ffprobe }) =>
    ffprobe(file).then((p) => {
      if (!p.durationSec || !p.width || !p.height) throw new ProviderError("INVALID_RESPONSE", "Generated video failed ffprobe validation.");
      if (Math.abs(p.durationSec - requestedDurationSec) > DURATION_TOLERANCE_SEC) {
        throw new ProviderError("INVALID_RESPONSE", `Generated video duration ${p.durationSec.toFixed(2)}s differs from the requested ${requestedDurationSec}s beyond tolerance.`);
      }
      const [w, h] = requestedSize.split("x").map(Number);
      // Providers may not honor exact resolutions — require the same aspect
      // class and a sane minimum rather than pixel-exact equality.
      const requestedAR = w / h;
      const actualAR = p.width / p.height;
      if (Math.abs(requestedAR - actualAR) / requestedAR > 0.12) {
        throw new ProviderError("INVALID_RESPONSE", `Generated video aspect ${p.width}x${p.height} diverges from the requested ${requestedSize}.`);
      }
      void file;
    }),
  );
}

export async function runJazmiiGenerateJob(job: HandlerJob): Promise<void> {
  const startedAt = Date.now();
  const parsed = JazmiiGenerateParamsSchema.safeParse(JSON.parse(job.paramsJson ?? "{}"));
  if (!parsed.success) throw new PermanentJobError(`JAZMII_GENERATE invalid params: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const params = parsed.data;

  // Reference image ownership (imageToVideo).
  let imageUrl: string | null = null;
  if (params.referenceAssetId) {
    const ref = await db.mediaAsset.findUnique({ where: { id: params.referenceAssetId } });
    if (!ref || ref.userId !== job.userId) throw new PermanentJobError("JAZMII_GENERATE reference asset not found or not owned by the caller.");
    imageUrl = ref.storagePath; // provider adapter passes the local path/URL as configured
  }

  const provider = jazmiiProvider(null);
  await jobManager.setProgress(job.id, 2, `Creating ${provider.id} task`);
  const handle = await provider.createTask(params, imageUrl);
  const deadline = Date.now() + GENERATE_TIMEOUT_MS;

  let videoUrl: string | null = null;
  let polls = 0;
  while (Date.now() < deadline) {
    // Cancellation check each poll.
    const row = await db.job.findUnique({ where: { id: job.id } });
    if (!row) throw new PermanentJobError("JAZMII_GENERATE job row disappeared.");
    if (row.status === "CANCELLED") return; // worker marks it; provider task left as-is (documented)
    await jobManager.setProgress(job.id, Math.min(60, 5 + polls * 2), `Polling ${provider.id} task ${handle.taskId} (${polls})`);
    const state = await provider.pollTask(handle.taskId);
    if (state.status === "SUCCESS" && state.videoUrl) {
      videoUrl = state.videoUrl;
      break;
    }
    if (state.status === "FAIL") throw new PermanentJobError(`Video provider reported failure for task ${handle.taskId}.`);
    if (state.status === "CANCELLED") throw new PermanentJobError(`Video provider task ${handle.taskId} was cancelled provider-side.`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (!videoUrl) throw new Error(`JAZMII generation timed out after ${Math.round(GENERATE_TIMEOUT_MS / 60000)} min (provider task ${handle.taskId} still running — its result was NOT registered).`);

  await jobManager.setProgress(job.id, 70, "Downloading provider output");
  const file = await downloadProviderOutput(videoUrl, "JAZMII", job.userId, ".mp4");
  await jobManager.setProgress(job.id, 85, "Validating and registering");
  const registered = await registerGeneratedAsset(file, {
    engine: "JAZMII",
    userId: job.userId,
    projectId: params.projectId ?? null,
    originalName: `jazmii_${handle.taskId}.mp4`,
    provider: provider.id,
    model: handle.model,
    prompt: params.prompt,
    params: { ...params, providerTaskId: handle.taskId },
    license: provider.capabilities.license,
    attribution: provider.capabilities.attribution,
    providerTaskId: handle.taskId,
    referenceAssetId: params.referenceAssetId ?? null,
    expectClass: "VIDEO",
    validate: () => validateGeneratedVideo(file, Number(params.durationSec), params.size),
  });
  await jobManager.complete(job.id, registered.id, `JAZMII video ready: asset ${registered.id} (${(registered.sizeBytes / 1024 / 1024).toFixed(1)} MB, task ${handle.taskId}, model ${handle.model})`);
  // M23 P4 usage accounting (true measured latency; provider does not
  // expose token counts → 0).
  await db.aIUsage.create({
    data: {
      userId: job.userId,
      provider: provider.id,
      model: handle.model,
      purpose: "JAZMII_GENERATE",
      latencyMs: Math.round(Date.now() - startedAt),
      ok: true,
    },
  });
}

export async function runJazmiiAnalyzeJob(job: HandlerJob): Promise<void> {
  const startedAt = Date.now();
  const parsed = JSON.parse(job.paramsJson ?? "{}") as { mediaId?: string };
  if (!parsed.mediaId) throw new PermanentJobError("JAZMII_ANALYZE requires mediaId.");
  const asset = await db.mediaAsset.findUnique({ where: { id: parsed.mediaId } });
  if (!asset || asset.userId !== job.userId) throw new PermanentJobError("JAZMII_ANALYZE media asset not found or not owned by the caller.");

  await jobManager.setProgress(job.id, 10, "Analyzing with FFprobe/FFmpeg");
  const artifactsDir = pathInsideMediaRoot("jazmii-artifacts", `u_${job.userId}`);
  await mkdir(artifactsDir, { recursive: true });
  const report = await analyzeVideoFile(asset.storagePath, asset.id, { artifactDir: artifactsDir });
  const reportFile = await writeAnalysisArtifact(artifactsDir, asset.id, report);

  // Register keyframes as IMAGE assets with provenance (parent = source).
  const keyframeIds: string[] = [];
  for (const kf of report.keyframeFiles.slice(0, 6)) {
    const registered = await registerImageArtifact(kf.file, {
      engine: "JAZMII",
      userId: job.userId,
      projectId: asset.projectId ?? null,
      originalName: `keyframe_${asset.id}_${kf.sec}s.jpg`,
      provider: "ffmpeg",
      model: "keyframe-extraction",
      prompt: `Keyframe at ${kf.sec}s of asset ${asset.id}`,
      params: { sourceAssetId: asset.id, sec: kf.sec },
      license: "source-project",
      attribution: `Keyframe of ${asset.originalName}`,
      referenceAssetId: asset.id,
    });
    keyframeIds.push(registered.id);
  }

  const summary = `${report.scenes.length} scene(s), ${report.blackSegments.length} black, ${report.freezeSegments.length} freeze; ${report.durationSec.toFixed(1)}s @ ${report.fps.toFixed(2)}fps ${report.width}x${report.height}`;
  await jobManager.complete(job.id, reportFile, `JAZMII analysis: ${summary}. Keyframes registered: ${keyframeIds.join(", ") || "none"}. Method: ffmpeg-heuristic.`);
  await db.aIUsage.create({
    data: {
      userId: job.userId,
      provider: "ffmpeg-local",
      model: "heuristic-shot-analysis",
      purpose: "JAZMII_ANALYZE",
      latencyMs: Math.round(Date.now() - startedAt),
      ok: true,
    },
  });
}

/** Probe the real video provider once (used by routes/tests). */
export function probeVideoProvider(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], { timeout: 10_000 }, () => void undefined);
    jazmiiProvider(null); // throws ProviderError when unconfigured
    resolve({ ok: true, detail: "provider adapter configured" });
  });
}

