/**
 * LAXII — image provider registry (M7 §5/§7A).
 *
 * One real provider family ships: `zai-image` (text-to-image) and
 * `zai-image-edit` (image-to-image editing/variations) — the environment's
 * configured z-ai image service, invoked through its CLI with hard timeouts.
 * Live-probed facts baked into the capability map:
 *   - generation latency ≈ 40 s; output is JPEG EVEN when the CLI says
 *     "png format" — LAXII records the SNIFFED format and never trusts the
 *     declared one;
 *   - supported sizes: 1024x1024, 768x1344, 864x1152, 1344x768, 1152x864,
 *     1440x720, 720x1440;
 *   - transparent-background output is NOT supported (honest UNSUPPORTED).
 * Credentials stay in the CLI environment; nothing reaches the browser.
 */
import { execFile } from "child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { ProviderError, type ImageProvider, type ImageResult, type LaxiiGenerateParams } from "./types";

/** CLI binary read PER CALL (see jazmii providers for the rationale). */
const zaiBin = (): string => process.env.BEANFX_ZAI_BIN ?? "z-ai";
const CLI_TIMEOUT_MS = Number(process.env.BEANFX_LAXII_CLI_TIMEOUT_MS ?? 180_000);

/** Run a z-ai image subcommand; the output lands at `outFile` (the CLI
 *  writes exactly that path — the REAL bytes are sniffed afterwards). */
function runImageCli(sub: "image" | "image-edit", args: string[], outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      zaiBin(),
      [sub, ...args, "-o", outFile],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        try {
          if (err) {
            const msg = `${String(stderr ?? "").trim()} ${err.message}`.trim();
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              reject(new ProviderError("NOT_CONFIGURED", `Image provider CLI "${zaiBin()}" is not installed on the server — LAXII generation is unavailable. Configure the provider binary to enable it.`));
              return;
            }
            if (err.killed) {
              reject(new ProviderError("TIMEOUT", `Image provider did not respond within ${CLI_TIMEOUT_MS} ms.`));
              return;
            }
            if (/401|403|unauthor|api key|authentication/i.test(msg)) {
              reject(new ProviderError("AUTH_FAILED", `Image provider rejected the credentials: ${msg.slice(0, 200)}`));
              return;
            }
            if (/429|rate limit/i.test(msg)) {
              reject(new ProviderError("RATE_LIMITED", `Image provider rate limit reached: ${msg.slice(0, 200)}`));
              return;
            }
            reject(new ProviderError("PROVIDER_FAILURE", `Image provider failed: ${msg.slice(0, 300)}`));
            return;
          }
          resolve();
        } catch (e) {
          reject(e instanceof ProviderError ? e : new ProviderError("INVALID_RESPONSE", `Image provider returned an unusable result: ${e instanceof Error ? e.message : "unknown"}`));
        }
      },
    );
  });
}

const LICENSE_NOTE = process.env.BEANFX_LAXII_LICENSE_NOTE ?? "Generated images subject to the provider's own terms; commercial-use rights are NOT independently verified — review provider terms before commercial distribution.";
const RETENTION_NOTE = process.env.BEANFX_LAXII_RETENTION_NOTE ?? "Provider-side retention is governed by the provider privacy policy (not independently verified); BEAN FX retains only downloaded outputs + provenance records.";

/** Sniff + dimension-validate the produced file (content, not claims). */
async function validateImage(file: string, expectedSize: string): Promise<ImageResult> {
  const { readFile } = await import("fs/promises");
  const head = (await readFile(file)).subarray(0, 512);
  const { sniffContainer, sniffMatchesClass } = await import("@/lib/media-storage");
  const sniff = sniffContainer(head);
  if (!sniffMatchesClass(sniff, "IMAGE")) {
    throw new ProviderError("INVALID_RESPONSE", `Provider output is not an image (sniffed ${sniff.family}).`);
  }
  const info = await new Promise<{ width: number; height: number; format: string }>((resolve, reject) => {
    execFile("python3", ["-c", "import sys;from PIL import Image;im=Image.open(sys.argv[1]);print(im.width, im.height, im.format)", file], { timeout: 30_000 }, (err, stdout) => {
      if (err) return reject(new ProviderError("INVALID_RESPONSE", "Provider image failed PIL decode."));
      const [w, h, f] = stdout.trim().split(/\s+/);
      resolve({ width: Number(w), height: Number(h), format: f });
    });
  });
  const [ew, eh] = expectedSize.split("x").map(Number);
  if (Math.abs(info.width / info.height - ew / eh) / (ew / eh) > 0.05) {
    throw new ProviderError("INVALID_RESPONSE", `Provider image ${info.width}x${info.height} diverges from the requested ${expectedSize}.`);
  }
  return { filePath: file, sniffedFormat: info.format, width: info.width, height: info.height };
}

export const ZAI_IMAGE_PROVIDER: ImageProvider = {
  id: "zai-image",
  label: "z-ai image (configured service)",
  capabilities: {
    operations: ["textToImage", "imageToImage"],
    sizes: ["1024x1024", "768x1344", "864x1152", "1344x768", "1152x864", "1440x720", "720x1440"],
    unsupported: [
      "transparent-background output (provider returns JPEG even for .png requests — recorded honestly, conversion to RGBA is possible locally but the source has no alpha)",
      "negative prompts (no provider parameter)",
      "explicit seeds (no provider parameter exposed)",
    ],
    commercialUse: LICENSE_NOTE,
    dataRetention: RETENTION_NOTE,
    license: "provider-terms",
    attribution: "Generated with the configured z-ai image service via BEAN FX LAXII.",
    pricingNote: "Metered by the provider account; BEAN FX records requests for accounting. Per-image pricing NOT independently verified.",
  },
  async generateImage(params: LaxiiGenerateParams, referencePath: string | null): Promise<ImageResult> {
    const workDir = mkdtempSync(path.join(os.tmpdir(), "laxii-cli-"));
    const out = path.join(workDir, "out.img"); // extension-agnostic; bytes are sniffed
    try {
      if (params.mode === "edit") {
        if (!referencePath) throw new ProviderError("UNSUPPORTED", "mode=edit requires a reference image asset owned by the caller.");
        await runImageCli("image-edit", ["-p", params.prompt, "-i", referencePath, "-s", params.size], out);
      } else {
        await runImageCli("image", ["-p", params.prompt, "-s", params.size], out);
      }
      const validated = await validateImage(out, params.size);
      // Move to a stable path BEFORE cleanup — the caller (job) owns it from
      // here (registers it or deletes it; never orphaned either way).
      const stable = path.join(os.tmpdir(), `laxii-out-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.img`);
      const { renameSync } = await import("fs");
      renameSync(validated.filePath, stable);
      return { ...validated, filePath: stable };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  },
};

const REGISTRY: Record<string, ImageProvider> = {
  "zai-image": ZAI_IMAGE_PROVIDER,
};

export function laxiiProvider(providerId: string | null | undefined): ImageProvider {
  const key = providerId ?? process.env.BEANFX_LAXII_PROVIDER ?? "zai-image";
  const p = REGISTRY[key];
  if (!p) throw new ProviderError("NOT_CONFIGURED", `Image provider "${key}" is not configured. Available: ${Object.keys(REGISTRY).join(", ")}.`);
  return p;
}

export function laxiiProviderIds(): string[] {
  return Object.keys(REGISTRY);
}

void readFileSync;
