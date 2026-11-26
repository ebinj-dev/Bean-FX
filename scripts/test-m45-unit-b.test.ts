/**
 * M45 Unit B — NIIKI VFX foundation regression tests (pure layer).
 *
 * Covers: VFX effect parity fragments (FFmpeg strings for chromaKey /
 * rectMask / ellipseMask / motionBlur), CSS-preview skip behavior, the exact
 * canvas op math (rect ramp, ellipse ramp, chroma distance), canonical
 * AddEffect acceptance of the new types, and honesty guarantees of the VFX
 * capability registry (every IMPLEMENTED entry names a real command/job path;
 * unavailable entries carry their gate reason).
 * Run: bun test scripts/test-m45-unit-b.test.ts
 */
import { describe, expect, test } from "bun:test";
import { parseCommand } from "../src/lib/editor/commands";
import { CANVAS_VFX_TYPES, ffmpegEffectChain, cssEffectFilter, filterSpec } from "../src/lib/editor/filters";
import { applyChromaKeyToImageData, applyRectMaskToImageData, applyEllipseMaskToImageData, keyColorToRgb } from "../src/lib/editor/vfx-canvas";
import { VFX_CAPABILITIES } from "../src/lib/nikki/vfx-capabilities";
import type { Effect } from "../src/lib/editor/model";

function fx(type: Effect["type"], params: Record<string, number | string | boolean>): Effect {
  return { id: `fx-${type}`, type, enabled: true, params, keyframes: [], animatedParams: [] };
}

describe("M45 VFX — FFmpeg parity fragments", () => {
  test("chromaKey renders a chromakey filter with the key color", () => {
    const chain = ffmpegEffectChain([fx("chromaKey", { color: "#00b140", similarity: 0.25, blend: 0.1 })]);
    expect(chain).toBe("colorkey=color=0x00B140:similarity=0.250:blend=0.100");
  });

  test("chromaKey with an invalid color is rejected (never silently passes through)", () => {
    expect(ffmpegEffectChain([fx("chromaKey", { color: "javascript:alert(1)" })])).toBeNull();
  });

  test("rectMask emits a yuva444p geq alpha ramp with escaped commas", () => {
    const chain = ffmpegEffectChain([fx("rectMask", { left: 10, right: 10, top: 10, bottom: 10, feather: 5 })]);
    expect(chain).toContain("format=yuva444p,geq=");
    expect(chain).toContain("a='");
    expect(chain).toContain("\\,");
    expect(chain).toContain("255*clip(");
  });

  test("rectMask invert flips the ramp polarity", () => {
    const chain = ffmpegEffectChain([fx("rectMask", { left: 10, right: 10, top: 10, bottom: 10, feather: 5, invert: true })]);
    expect(chain).toContain("255*(1-clip(");
  });

  test("degenerate masks (full inset) are rejected instead of black frames", () => {
    expect(ffmpegEffectChain([fx("rectMask", { left: 50, right: 50, top: 50, bottom: 50, feather: 5 })])).toBeNull();
    expect(ffmpegEffectChain([fx("ellipseMask", { centerX: 50, centerY: 50, radiusX: 0.1, radiusY: 0.1, feather: 10 })])).toBeNull();
  });

  test("motionBlur emits tmix with a bounded frame count", () => {
    expect(ffmpegEffectChain([fx("motionBlur", { frames: 5 })])).toBe("tmix=frames=5");
    expect(ffmpegEffectChain([fx("motionBlur", { frames: 99 })])).toBe("tmix=frames=8");
    expect(ffmpegEffectChain([fx("motionBlur", { frames: 1 })])).toBeNull();
  });

  test("canvas-VFX types are skipped by the CSS preview filter (no CSS equivalent)", () => {
    expect(cssEffectFilter([fx("chromaKey", { color: "#00b140" })])).toBeNull();
    expect(cssEffectFilter([fx("rectMask", { left: 10 })])).toBeNull();
    // A mixed stack still yields the CSS-able parts.
    expect(cssEffectFilter([fx("grayscale", {}), fx("chromaKey", { color: "#00b140" })])).toBe("grayscale(1)");
  });

  test("CANVAS_VFX_TYPES match the registry exactly", () => {
    expect(CANVAS_VFX_TYPES.sort()).toEqual(["chromaKey", "ellipseMask", "motionBlur", "rectMask"].sort());
  });
});

describe("M45 VFX — canonical command acceptance", () => {
  test("AddEffect chromaKey with a string color param validates", () => {
    const cmd = parseCommand({ type: "AddEffect", clipId: "clip1", effect: fx("chromaKey", { color: "#00b140", similarity: 0.2, blend: 0.1 }) });
    expect(cmd.type).toBe("AddEffect");
  });

  test("all four VFX types resolve to a filter spec", () => {
    for (const t of CANVAS_VFX_TYPES) expect(filterSpec(t)).not.toBeNull();
  });
});

describe("M45 VFX — canvas op math", () => {
  function imageDataOf(w: number, h: number, fill: (x: number, y: number) => [number, number, number]): ImageData {
    const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as ImageData;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const [r, g, b] = fill(x, y);
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    return img;
  }

  test("rectMask: center opaque, outside transparent, invert swaps", () => {
    const img = imageDataOf(100, 100, () => [200, 100, 50]);
    applyRectMaskToImageData(img, { left: 10, right: 10, top: 10, bottom: 10, feather: 0 });
    const at = (x: number, y: number) => img.data[(y * 100 + x) * 4 + 3];
    expect(at(50, 50)).toBe(255); // fully inside the 10% inset box
    expect(at(2, 50)).toBe(0); // outside the box
    const imgInv = imageDataOf(100, 100, () => [200, 100, 50]);
    applyRectMaskToImageData(imgInv, { left: 10, right: 10, top: 10, bottom: 10, feather: 0, invert: true });
    expect(imgInv.data[(50 * 100 + 50) * 4 + 3]).toBe(0);
    expect(imgInv.data[(2 * 100 + 50) * 4 + 3]).toBe(255);
  });

  test("rectMask feather ramp matches the geq formula", () => {
    const img = imageDataOf(100, 100, () => [200, 100, 50]);
    applyRectMaskToImageData(img, { left: 0, right: 0, top: 0, bottom: 0, feather: 10 });
    // d = x / (w*0.10) → at x=50, d = 5 → clip 1; at x=2, d = 0.2 → alpha 51
    expect(img.data[(50 * 100 + 50) * 4 + 3]).toBe(255);
    expect(img.data[(2 * 100 + 50) * 4 + 3]).toBeCloseTo(51, 0);
  });

  test("ellipseMask: center opaque, corner transparent", () => {
    const img = imageDataOf(100, 100, () => [10, 20, 30]);
    applyEllipseMaskToImageData(img, { centerX: 50, centerY: 50, radiusX: 35, radiusY: 35, feather: 10 });
    expect(img.data[(50 * 100 + 50) * 4 + 3]).toBe(255);
    expect(img.data[(0 * 100 + 0) * 4 + 3]).toBe(0);
  });

  test("chromaKey: pure key color transparent, other colors opaque", () => {
    const img = imageDataOf(10, 10, (x) => (x < 5 ? [0, 177, 64] : [240, 240, 240]));
    applyChromaKeyToImageData(img, { color: "#00b140", similarity: 0.2, blend: 0.1 });
    expect(img.data[(5 * 10 + 0) * 4 + 3]).toBe(0); // green → transparent
    expect(img.data[(5 * 10 + 8) * 4 + 3]).toBe(255); // white → opaque
  });

  test("keyColorToRgb falls back to classic green on garbage", () => {
    const [r, g, b] = keyColorToRgb("javascript:alert(1)");
    expect([r, g, b]).toEqual([0, 0.694, 0.251]);
  });
});

describe("M45 VFX — capability registry honesty", () => {
  test("every IMPLEMENTED capability names a real canonical path", () => {
    for (const c of VFX_CAPABILITIES.filter((x) => x.availability === "IMPLEMENTED")) {
      expect(c.path).toMatch(/AddEffect|RENDER_TIMELINE|MEDIA_STABILIZE|UpdateClipProperties|SetEffectKeyframe|renderer/);
    }
  });

  test("every unavailable capability discloses WHY it is gated", () => {
    for (const c of VFX_CAPABILITIES.filter((x) => x.availability !== "IMPLEMENTED")) {
      expect(c.gate).toBeTruthy();
      expect(c.gate!.length).toBeGreaterThan(20);
    }
  });

  test("registry effectType references stay inside the canonical vocabulary", () => {
    for (const c of VFX_CAPABILITIES.filter((x) => x.effectType)) {
      expect(() => parseCommand({ type: "AddEffect", clipId: "clip1", effect: fx(c.effectType!, {}) })).not.toThrow();
    }
  });

  test("commercial-licensing guardrails are recorded, not hidden", () => {
    const depth = VFX_CAPABILITIES.find((c) => c.id === "depth-effects");
    expect(depth?.gate).toMatch(/CC-BY-NC/);
    const stab = VFX_CAPABILITIES.find((c) => c.id === "stabilization");
    expect(stab?.licenseNote).toMatch(/GPL/);
  });
});
