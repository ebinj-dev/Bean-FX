/**
 * M42-D — model capability registry tests.
 * Honesty contracts: real providers only, readiness reasons required for
 * not-ready entries, cost strings never numeric fabrications, capability
 * vocabulary closed, routing discloses fallbacks.
 * Run: bun test scripts/test-m42-models.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  MODEL_CAPABILITIES,
  probeModelRegistry,
  routeForCapability,
  type ModelCapability,
} from "../src/lib/ai/models";
import { toolByName } from "../src/lib/mcp/tools";

describe("M42-D model registry", () => {
  const reg = probeModelRegistry();

  test("registry contains only known providers/integrations (no invented providers)", () => {
    const allowed = new Set(["zai-gateway", "jazmii", "laxii", "beanfx-local", "beanfx-optional"]);
    for (const m of reg.models) expect(allowed.has(m.provider)).toBe(true);
    expect(reg.models.length).toBeGreaterThanOrEqual(7);
  });

  test("capability vocabulary is closed", () => {
    for (const m of reg.models) {
      for (const c of m.capabilities) expect(MODEL_CAPABILITIES).toContain(c);
    }
  });

  test("every model has an honest cost string and every not-ready model has a reason", () => {
    for (const m of reg.models) {
      expect(typeof m.cost).toBe("string");
      if (!m.ready) {
        expect(m.readyReason.length).toBeGreaterThan(5);
        expect(m.readyReason).toMatch(/not found|missing|not installed|disabled|not enabled|unset|present but/);
      }
      if (!(m.cost === "COST UNKNOWN" || m.cost.startsWith("COST UNKNOWN") || m.cost.startsWith("local"))) {
        throw new Error(`fabricated cost for ${m.id}: ${m.cost}`);
      }
    }
  });

  test("ffmpeg/ffprobe analysis tool is ready in this environment (real probe)", () => {
    const ff = reg.models.find((m) => m.id === "ffmpeg-analysis");
    expect(ff?.ready).toBe(true);
  });

  test("routing: unknown capability requirement discloses the fallback reason", () => {
    const pick = routeForCapability(reg, "frame-interpolation");
    expect(pick.chosen).toBeNull();
    expect(pick.fallbackReason).toMatch(/no READY model/);
  });

  test("routing: reasoning picks a ready LLM when the gateway is configured", () => {
    const pick = routeForCapability(reg, "reasoning");
    const llmReady = reg.models.find((m) => m.id === "glm-chat")?.ready;
    if (llmReady) {
      expect(pick.chosen).not.toBeNull();
      expect(pick.fallbackReason).toBeNull();
    } else {
      expect(pick.fallbackReason).toMatch(/no READY model/);
    }
  });

  test("routing: scene-classification exposes candidates with per-candidate readiness", () => {
    const pick = routeForCapability(reg, "scene-classification");
    expect(pick.candidates.length).toBeGreaterThanOrEqual(2);
    for (const c of pick.candidates) expect(typeof c.ready).toBe("boolean");
  });
});

describe("M42-D MCP surface", () => {
  test("ai.models.list tool is registered, read-only, and returns the registry", async () => {
    const t = toolByName("ai.models.list");
    expect(t).toBeDefined();
    expect(t!.mutates).toBe(false);
    const out = (await t!.handler({ auth: { userId: "test" } } as never, {}, {})) as Record<string, unknown>;
    expect(Array.isArray(out.models)).toBe(true);
  });
});
