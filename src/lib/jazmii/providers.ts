/**
 * JAZMII — video provider registry (M7 §5).
 *
 * One real provider ships in this milestone: `zai-video` (the environment's
 * configured z-ai video service, model cogvideox-3 — verified live: task
 * creation, async polling, and download). It is invoked through its CLI
 * (`z-ai video`, `z-ai async-result`) with hard timeouts — the same
 * integration pattern as FFmpeg. Credentials stay inside the CLI
 * environment; nothing is exposed to the browser.
 *
 * Behavior rules (§5, enforced by tests):
 *  - Missing/unconfigured CLI → ProviderError NOT_CONFIGURED (honest, actionable).
 *  - Unsupported option → ProviderError UNSUPPORTED (options never silently
 *    dropped).
 *  - Provider failure/auth failure/rate limit → typed ProviderErrors.
 *  - NO silent provider switching, NO fake results, NO simulated progress.
 *  - No Ollama; no local-model claims.
 *
 * Provider metadata (commercial use / retention / license) is recorded from
 * the provider's own terms as configurable strings — values we could not
 * verify are marked "not independently verified" rather than invented.
 */
import { execFile } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { ProviderError, type VideoProvider, type VideoTaskHandle, type VideoTaskState, type JazmiiGenerateParams } from "./types";

/** CLI binary read PER CALL so tests/deployment can reconfigure live; the
 *  default is the environment's configured provider interface. */
const zaiBin = (): string => process.env.BEANFX_ZAI_BIN ?? "z-ai";
/** CLI wall-clock ceiling per invocation (polling calls are short). */
const CLI_TIMEOUT_MS = Number(process.env.BEANFX_JAZMII_CLI_TIMEOUT_MS ?? 120_000);

function runCli(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), "jazmii-cli-"));
    const out = path.join(workDir, "result.json");
    execFile(
      zaiBin(),
      [...args, "-o", out],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        try {
          if (err) {
            const msg = `${String(stderr ?? "").trim()} ${err.message}`.trim();
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              reject(new ProviderError("NOT_CONFIGURED", `Video provider CLI "${zaiBin()}" is not installed on the server — JAZMII generation is unavailable. Install/configure the provider binary to enable it.`));
              return;
            }
            if (err.killed) {
              reject(new ProviderError("TIMEOUT", `Video provider did not respond within ${CLI_TIMEOUT_MS} ms.`));
              return;
            }
            if (/401|403|unauthor|api key|authentication/i.test(msg)) {
              reject(new ProviderError("AUTH_FAILED", `Video provider rejected the credentials: ${msg.slice(0, 200)}`));
              return;
            }
            if (/429|rate limit/i.test(msg)) {
              reject(new ProviderError("RATE_LIMITED", `Video provider rate limit reached: ${msg.slice(0, 200)}`));
              return;
            }
            reject(new ProviderError("PROVIDER_FAILURE", `Video provider failed: ${msg.slice(0, 300)}`));
            return;
          }
          const raw = readFileSync(out, "utf8");
          resolve(JSON.parse(raw) as Record<string, unknown>);
        } catch (e) {
          reject(new ProviderError("INVALID_RESPONSE", `Video provider returned an unparseable result: ${e instanceof Error ? e.message : "unknown"}`));
        } finally {
          rmSync(workDir, { recursive: true, force: true });
        }
      },
    );
  });
}

const PROVIDER_LICENSE = process.env.BEANFX_JAZMII_LICENSE_NOTE ?? "Generated content subject to the provider's own terms; commercial-use rights are NOT independently verified — review the provider terms before commercial distribution.";
const PROVIDER_RETENTION = process.env.BEANFX_JAZMII_RETENTION_NOTE ?? "Provider-side task data retention is governed by the provider's privacy policy (not independently verified); BEAN FX retains only the downloaded output and provenance records.";

interface ZaiTaskResult {
  id?: string;
  model?: string;
  request_id?: string;
  task_status?: string;
  /** Real SUCCESS shape (verified live): video_result[0].url + cover_image_url. */
  video_result?: Array<{ url?: string; cover_image_url?: string }>;
  /** Tolerated alternative shapes for future provider versions. */
  video_url?: string;
  progress?: number;
  failures?: string;
}

function extractVideoUrl(res: ZaiTaskResult): string | null {
  return res.video_result?.[0]?.url ?? res.video_url ?? null;
}

export const ZAI_VIDEO_PROVIDER: VideoProvider = {
  id: "zai-video",
  label: "z-ai video (cogvideox-3 via configured service)",
  capabilities: {
    operations: ["textToVideo", "imageToVideo"],
    qualities: ["speed", "quality"],
    sizes: ["1920x1080", "1280x720", "1080x1920", "720x1280"],
    fps: ["30", "60"],
    durationsSec: ["5", "10"],
    withAudio: true,
    // The provider exposes a task-status poll, not a numeric progress value:
    // we never simulate progress bars — the UI shows poll state honestly.
    providerProgress: false,
    commercialUse: PROVIDER_LICENSE,
    dataRetention: PROVIDER_RETENTION,
    license: "provider-terms",
    attribution: "Generated with the configured z-ai video service (model cogvideox-3) via BEAN FX JAZMII.",
    pricingNote: "Metered by the provider account; BEAN FX records request ids for accounting. Per-generation pricing NOT independently verified.",
  },
  async createTask(params: JazmiiGenerateParams, imageUrl: string | null): Promise<VideoTaskHandle> {
    const args = ["video", "-p", params.prompt, "-q", params.quality, "-s", params.size, "--fps", params.fps, "-d", params.durationSec];
    if (params.withAudio) args.push("--with-audio");
    if (params.operation === "imageToVideo") {
      if (!imageUrl) throw new ProviderError("UNSUPPORTED", "imageToVideo requires a reference image asset owned by the caller.");
      args.push("-i", imageUrl);
    }
    const res = (await runCli(args)) as ZaiTaskResult;
    if (!res.id) throw new ProviderError("INVALID_RESPONSE", "Video provider accepted the request but returned no task id.");
    return { taskId: res.id, model: res.model ?? "cogvideox-3", requestId: res.request_id ?? res.id };
  },
  async pollTask(taskId: string): Promise<VideoTaskState> {
    const res = (await runCli(["async-result", "--id", taskId])) as ZaiTaskResult;
    const status = String(res.task_status ?? "UNKNOWN").toUpperCase();
    const map: Record<string, VideoTaskState["status"]> = {
      SUCCESS: "SUCCESS",
      DONE: "SUCCESS",
      PROCESSING: "PROCESSING",
      QUEUED: "QUEUED",
      NOT_FOUND: "UNKNOWN",
      FAIL: "FAIL",
      FAILED: "FAIL",
      CANCELLED: "CANCELLED",
    };
    return {
      status: map[status] ?? "UNKNOWN",
      videoUrl: extractVideoUrl(res),
      providerProgress: typeof res.progress === "number" ? Math.max(0, Math.min(100, res.progress)) : null,
      raw: res,
    };
  },
};

/** Registry — selection is CONFIGURABLE and never silent-switched. */
const REGISTRY: Record<string, VideoProvider> = {
  "zai-video": ZAI_VIDEO_PROVIDER,
};

export function jazmiiProvider(providerId: string | null | undefined): VideoProvider {
  const key = providerId ?? process.env.BEANFX_JAZMII_PROVIDER ?? "zai-video";
  const p = REGISTRY[key];
  if (!p) {
    throw new ProviderError("NOT_CONFIGURED", `Video provider "${key}" is not configured. Available: ${Object.keys(REGISTRY).join(", ")}.`);
  }
  return p;
}

export function jazmiiProviderIds(): string[] {
  return Object.keys(REGISTRY);
}
