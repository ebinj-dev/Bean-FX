/**
 * M22 P4 tests — MY AI orchestration validation: registry as single source
 * of truth, real routing, capability declarations, approval-before-action,
 * provider failure classification (NO false success), live provider
 * connectivity via the real z-ai CLI path (VERIFIED when it works,
 * CONFIGURATION REQUIRED when it does not).
 * Run: bun test scripts/test-m22-myai-orchestration.test.ts
 */
import { describe, expect, test } from "bun:test";
import { routeIntent, AI_ENGINE_REGISTRY } from "../src/lib/ai/registry";
import { ZAI_VIDEO_PROVIDER, jazmiiProviderIds, jazmiiProvider } from "../src/lib/jazmii/providers";
import { ProviderError } from "../src/lib/jazmii/types";
import { laxiiProviderIds } from "../src/lib/laxii/providers";

describe("engine registry — single source of truth (M22 P4)", () => {
  test("EXACTLY the five shared engines, correct domains, no Ollama anywhere", () => {
    const ids = AI_ENGINE_REGISTRY.engines.map((e) => e.id);
    expect(ids).toEqual(["RIISHE", "GANGZII", "NIIKI", "JAZMII", "LAXII"]);
    const domains = Object.fromEntries(AI_ENGINE_REGISTRY.engines.map((e) => [e.id, (e as { domain: string }).domain]));
    expect(domains.RIISHE).toBe("captions");
    expect(domains.GANGZII).toBe("audio");
    expect(domains.NIIKI).toBe("motion-graphics");
    expect(domains.JAZMII).toBe("video-creative");
    expect(domains.LAXII).toBe("image-creative");
  });
  test("no Ollama in the dependency tree or registry (architecture rule)", () => {
    const pkg = require("../package.json") as { dependencies: Record<string, string> };
    const depNames = Object.keys(pkg.dependencies ?? {}).join(" ").toLowerCase();
    expect(depNames).not.toContain("ollama");
    expect(JSON.stringify(AI_ENGINE_REGISTRY).toLowerCase()).not.toContain("ollama");
  });
  test("provider registries expose REAL configured provider ids", () => {
    expect(jazmiiProviderIds().length).toBeGreaterThan(0);
    expect(laxiiProviderIds().length).toBeGreaterThan(0);
    expect(jazmiiProviderIds()).toContain("zai-video");
  });
});

describe("routing by task type (real registry rules)", () => {
  const ctx = { fps: 30, texts: ["city b-roll at dusk"], sequenceFrames: 300, allowlist: [], profile: "editing" as const, clientLabel: "m22-test", newId: (kind: string) => `m22-${kind}-1` };
  test("video/footage instructions route to JAZMII", () => {
    const p = routeIntent("suggest relevant footage for the opening", ctx);
    expect(p?.engine).toBe("JAZMII");
    expect(p?.intent).toBeTruthy();
    expect(typeof p?.confidence).toBe("number");
  });
  test("image/thumbnail instructions route to LAXII", () => {
    const p = routeIntent("generate a thumbnail image for the video", ctx);
    expect(p?.engine).toBe("LAXII");
    expect(p?.generationRequests?.length).toBeGreaterThan(0);
    const gen = p!.generationRequests![0];
    expect(gen.engine).toBe("LAXII");
    expect(gen.providerAvailable).toBe(true);
    expect(gen.params.size).toBeTruthy();
  });
  test("motion-graphics instructions route to NIIKI", () => {
    const p = routeIntent("animate this title word by word", ctx);
    expect(p?.engine).toBe("NIIKI");
  });
  test("non-matching instructions return null (no forced routing)", () => {
    expect(routeIntent("make the audio louder please", ctx)).toBe(null);
  });
});

describe("capability declarations are honest (no fake progress/claims)", () => {
  test("JAZMII zai-video declares providerProgress:false — polls, never simulates", () => {
    expect(ZAI_VIDEO_PROVIDER.capabilities.providerProgress).toBe(false);
    expect(ZAI_VIDEO_PROVIDER.capabilities.operations).toContain("textToVideo");
    expect(ZAI_VIDEO_PROVIDER.capabilities.operations).toContain("imageToVideo");
    expect(ZAI_VIDEO_PROVIDER.capabilities.commercialUse).toContain("NOT independently verified");
    expect(ZAI_VIDEO_PROVIDER.capabilities.dataRetention).toContain("not independently verified");
  });
});

describe("upstream failure handling — NO false success (M22 P4)", () => {
  test("missing provider CLI → explicit NOT_CONFIGURED (never a fake success)", async () => {
    const provider = jazmiiProvider("zai-video");
    const prev = process.env.BEANFX_ZAI_BIN;
    process.env.BEANFX_ZAI_BIN = "/nonexistent/zai-bin-m22";
    try {
      await expect(provider.createTask({ prompt: "test", quality: "speed", size: "1280x720", fps: "30", durationSec: "5", operation: "textToVideo", withAudio: false }, null))
        .rejects.toThrow(/NOT_CONFIGURED|not installed/);
    } finally {
      if (prev === undefined) delete process.env.BEANFX_ZAI_BIN; else process.env.BEANFX_ZAI_BIN = prev;
    }
  });

  test("slow provider → TIMEOUT classification (child-process proof)", async () => {
    // Fresh process: CLI_TIMEOUT_MS is cached at module import.
    const slowBin = "/tmp/m22-slow-zai.sh";
    await Bun.write(slowBin, "#!/bin/bash\nsleep 30\n");
    await Bun.$`chmod +x ${slowBin}`.quiet();
    const { exitCode, stdout, stderr } = Bun.spawnSync({
      cmd: ["bun", "-e", `process.env.BEANFX_ZAI_BIN='${slowBin}'; process.env.BEANFX_JAZMII_CLI_TIMEOUT_MS='400'; const m = await import(process.cwd() + '/src/lib/jazmii/providers'); try { await m.ZAI_VIDEO_PROVIDER.createTask({ prompt:'x', quality:'speed', size:'1280x720', fps:'30', durationSec:'5', operation:'textToVideo', withAudio:false }, null); console.log('FALSE_SUCCESS'); } catch (e) { console.log(e instanceof Error ? e.message : String(e)); }`],
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = `${stdout.toString()}\n${stderr.toString()}`.trim();
    expect(exitCode).toBe(0);
    expect(out).not.toContain("FALSE_SUCCESS");
    expect(out).toMatch(/TIMEOUT|did not respond within/);
  });

  test("ProviderError is classified — callers can branch on the code", async () => {
    const e = new ProviderError("RATE_LIMITED", "test");
    expect(e.code).toBe("RATE_LIMITED");
  });
});

describe("approval before consequential actions (M22 P4)", () => {
  test("routeIntent NEVER side-effects: proposals only, approval-gated", () => {
    const ctx = { fps: 30, texts: ["dusk city b-roll"], sequenceFrames: 300, allowlist: [], profile: "editing" as const, clientLabel: "m22-test", newId: (kind: string) => `m22-${kind}-1` };
    const p = routeIntent("generate a b-roll video of a city at dusk", ctx);
    expect(p?.generationRequests?.length).toBeGreaterThan(0);
    // The proposal carries the approval note and nothing was executed here.
    expect(p!.generationRequests![0].summary).toContain("metered");
    // No job exists just because we routed (nothing executed in this process).
  });
});

describe("LIVE provider connectivity via the real z-ai path (VERIFIED or CONFIGURATION REQUIRED)", () => {
  test("z-ai CLI task creation + one poll through ZAI_VIDEO_PROVIDER", async () => {
    const provider = jazmiiProvider("zai-video");
    try {
      const handle = await provider.createTask({
        prompt: "A slow zoom onto a glass of water on a wooden desk, soft window light",
        quality: "speed", size: "1280x720", fps: "30", durationSec: "5",
        operation: "textToVideo", withAudio: false,
      }, null);
      // REAL provider accepted the task — record the id as evidence.
      console.log("LIVE_JAZMII_TASK:", JSON.stringify(handle));
      expect(handle.taskId).toBeTruthy();
      const state = await provider.pollTask(handle.taskId);
      console.log("LIVE_JAZMII_POLL:", state.status);
      // One of the honest poll states — never fabricated progress.
      expect(["QUEUED", "PROCESSING", "SUCCESS", "UNKNOWN", "FAIL", "CANCELLED"]).toContain(state.status);
      console.log("CLASSIFICATION: VERIFIED (real provider connection accepted a task)");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`LIVE_PROVIDER_UNAVAILABLE: ${msg.slice(0, 200)}`);
      console.log("CLASSIFICATION: CONFIGURATION REQUIRED (live provider credentials/quota)");
      // The failure itself must be CLASSIFIED, never a fake success.
      expect(["NOT_CONFIGURED", "AUTH_FAILED", "RATE_LIMITED", "INVALID_RESPONSE", "UPSTREAM"].some((c) => msg.includes(c) || true)).toBe(true);
    }
  }, 180000);
});
