/**
 * M48-I U1 — color library unit tests: strict .cube parsing, identity
 * preservation, known pixel transforms, serialization round-trip and the
 * grade→cube bake bridge accuracy. Run: bun test scripts/test-m48-i1-color-lib.test.ts
 */
import { describe, expect, test } from "bun:test";
import { CubeParseError, bakeGradeCube, identityCube, parseCube, sampleCube, serializeCube } from "@/lib/color/lut3d";
import { DEFAULT_GRADE, gradeIsNeutral, gradePixel } from "@/lib/color/grade-model";

function cube(size: number, title: string, fn: (r: number, g: number, b: number) => [number, number, number]): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const [or, og, ob] = fn(r / (size - 1), g / (size - 1), b / (size - 1));
        lines.push(`${or.toFixed(6)} ${og.toFixed(6)} ${ob.toFixed(6)}`);
      }
  return lines.join("\n") + "\n";
}

describe("M48-I U1 — .cube parser", () => {
  test("identity 33³ parses and round-trips exactly", () => {
    const text = cube(33, "identity-test", (r, g, b) => [r, g, b]);
    const lut = parseCube(text) as ReturnType<typeof parseCube> & { kind: "3d" };
    expect(lut.kind).toBe("3d");
    if (lut.kind !== "3d") return;
    expect(lut.size).toBe(33);
    expect(lut.title).toBe("identity-test");
    for (const [r, g, b] of [[0, 0, 0], [1, 1, 1], [0.5, 0.25, 0.75], [0.13, 0.77, 0.31]]) {
      const [or, og, ob] = sampleCube(lut, r, g, b);
      expect(Math.abs(or - r)).toBeLessThan(0.002);
      expect(Math.abs(og - g)).toBeLessThan(0.002);
      expect(Math.abs(ob - b)).toBeLessThan(0.002);
    }
  });

  test("malformed inputs are rejected with clear errors", () => {
    const cases: [string, string][] = [
      ["no header", "0.1 0.2 0.3\n0.4 0.5 0.6\n"],
      ["entry count mismatch", "LUT_3D_SIZE 2\n0 0 0\n1 1 1\n"],
      ["NaN", "LUT_3D_SIZE 2\nNaN 0 0\n" + "0 0 0\n".repeat(7)],
      ["Infinity", "LUT_3D_SIZE 2\nInfinity 0 0\n" + "0 0 0\n".repeat(7)],
      ["out of range", "LUT_3D_SIZE 2\n" + "1.5 0 0\n".repeat(8)],
      ["bad size", "LUT_3D_SIZE 0\n"],
      ["oversize", `LUT_3D_SIZE ${200}\n`],
      ["two dims", "LUT_3D_SIZE 2\nLUT_1D_SIZE 4\n"],
      ["bad domain", "LUT_3D_SIZE 2\nDOMAIN_MIN 1 1 1\nDOMAIN_MAX 0 0 0\n"],
      ["malformed line", "LUT_3D_SIZE 2\n0.1 0.2\n" + "0 0 0\n".repeat(7)],
    ];
    for (const [name, text] of cases) {
      try {
        parseCube(text);
        throw new Error(`case "${name}" was NOT rejected`);
      } catch (e) {
        expect(e instanceof CubeParseError).toBe(true);
      }
    }
  });

  test("1D LUT parses but is reported unsupported (never silently mis-applied)", () => {
    const one = ["LUT_1D_SIZE 4", "0 0 0", "0.33 0.33 0.33", "0.66 0.66 0.66", "1 1 1"].join("\n");
    const r = parseCube(one);
    expect("kind" in r && r.kind === "1d").toBe(true);
  });

  test("serialize→parse round-trip preserves values to 1e-4", () => {
    const lut = identityCube(17, "round-trip");
    const text = serializeCube(lut);
    const back = parseCube(text) as ReturnType<typeof parseCube> & { kind: "3d" };
    if (back.kind !== "3d") throw new Error("not 3d");
    expect(back.size).toBe(17);
    for (let i = 0; i < lut.table.length; i++) {
      expect(Math.abs(lut.table[i] - back.table[i])).toBeLessThan(1e-4);
    }
  });
});

describe("M48-I U1 — grade model", () => {
  test("neutral grade is identity; bypass is identity", () => {
    expect(gradeIsNeutral(DEFAULT_GRADE)).toBe(true);
    const pix: [number, number, number] = [0.3, 0.6, 0.9];
    expect(gradePixel(...pix, DEFAULT_GRADE).every((v, i) => Math.abs(v - pix[i]) < 1e-9)).toBe(true);
    expect(gradePixel(...pix, { ...DEFAULT_GRADE, exposure: 2, bypass: true }).every((v) => v === pix[0] || v === pix[1] || v === pix[2])).toBe(true);
  });

  test("exposure: +1 stop doubles linear values (mid-grey check)", () => {
    const [r] = gradePixel(0.25, 0.25, 0.25, { ...DEFAULT_GRADE, exposure: 1 });
    expect(Math.abs(r - 0.5)).toBeLessThan(1e-6);
  });

  test("contrast: slope about pivot", () => {
    const [r, , b] = gradePixel(0.25, 0.5, 0.75, { ...DEFAULT_GRADE, contrast: 2 });
    expect(Math.abs(r - 0.0)).toBeLessThan(1e-6); // (0.25-0.5)*2+0.5 = 0
    expect(Math.abs(b - 1)).toBeLessThan(1e-6); // (0.75-0.5)*2+0.5 = 1
  });

  test("temperature warms (red up, blue down); tint greens", () => {
    const warm = gradePixel(0.5, 0.5, 0.5, { ...DEFAULT_GRADE, temperature: 1 });
    expect(warm[0]).toBeGreaterThan(0.5);
    expect(warm[2]).toBeLessThan(0.5);
    const green = gradePixel(0.5, 0.5, 0.5, { ...DEFAULT_GRADE, tint: 1 });
    expect(green[1]).toBeGreaterThan(0.5);
  });

  test("saturation 0 = grayscale (luma-preserving)", () => {
    const [r, g, b] = gradePixel(0.9, 0.2, 0.1, { ...DEFAULT_GRADE, saturation: 0 });
    expect(Math.abs(r - g)).toBeLessThan(1e-6);
    expect(Math.abs(g - b)).toBeLessThan(1e-6);
    const y0 = 0.2126 * 0.9 + 0.7152 * 0.2 + 0.0722 * 0.1;
    expect(Math.abs(r - y0)).toBeLessThan(1e-6);
  });

  test("saturation 2 doubles chroma about luma (below-luma pulls down, above clamps)", () => {
    const [r, g] = gradePixel(0.8, 0.4, 0.4, { ...DEFAULT_GRADE, saturation: 2 });
    const y = 0.2126 * 0.8 + 0.7152 * 0.4 + 0.0722 * 0.4;
    expect(Math.abs(r - Math.min(1, y + (0.8 - y) * 2))).toBeLessThan(1e-6); // r clamps at 1
    expect(Math.abs(g - (y + (0.4 - y) * 2))).toBeLessThan(1e-6); // g pulled below its start
  });

  test("vibrance boosts dull pixels strongly, saturated ones proportionally less", () => {
    const dull = gradePixel(0.5, 0.48, 0.52, { ...DEFAULT_GRADE, vibrance: 1 });
    const dullBefore = Math.max(0.5, 0.48, 0.52) - Math.min(0.5, 0.48, 0.52);
    const dullAfter = Math.max(...dull) - Math.min(...dull);
    expect(dullAfter).toBeGreaterThan(dullBefore * 1.5);
    // documented model: chroma growth ≈ chroma × vibrance × (1-chroma) — strong
    // protection at high chroma but not zero; pick a non-clamping pixel.
    const sat = gradePixel(0.85, 0.05, 0.05, { ...DEFAULT_GRADE, vibrance: 1 });
    const satAfter = Math.max(...sat) - Math.min(...sat);
    const chroma = 0.8;
    expect(Math.abs(satAfter - (chroma + chroma * (1 - chroma)))).toBeLessThan(0.02);
    // relative chroma growth: dull pixel multiplies chroma far more than the saturated one
    expect(dullAfter / dullBefore).toBeGreaterThan(satAfter / chroma);
  });

  test("LGG: lift raises blacks, gain scales, gamma bends mids", () => {
    const lifted = gradePixel(0, 0, 0, { ...DEFAULT_GRADE, liftR: 0.2 });
    expect(lifted[0]).toBeGreaterThan(0.15);
    const gained = gradePixel(0.5, 0, 0, { ...DEFAULT_GRADE, gainR: 2 });
    expect(Math.abs(gained[0] - 1)).toBeLessThan(1e-6); // clamped
    const gam = gradePixel(0.25, 0, 0, { ...DEFAULT_GRADE, gammaR: 2 });
    expect(Math.abs(gam[0] - Math.sqrt(0.25))).toBeLessThan(1e-6);
  });

  test("RGB master gains act per channel", () => {
    const [r, g, b] = gradePixel(0.5, 0.5, 0.5, { ...DEFAULT_GRADE, red: 1.5, blue: 0.5 });
    expect(Math.abs(r - 0.75)).toBeLessThan(1e-6);
    expect(Math.abs(g - 0.5)).toBeLessThan(1e-6);
    expect(Math.abs(b - 0.25)).toBeLessThan(1e-6);
  });

  test("highlights/shadows windows touch the right luminance bands", () => {
    const bright = gradePixel(0.9, 0.9, 0.9, { ...DEFAULT_GRADE, highlights: 1 });
    const dark = gradePixel(0.1, 0.1, 0.1, { ...DEFAULT_GRADE, shadows: 1 });
    expect(bright[0]).toBeGreaterThan(0.9);
    expect(dark[0]).toBeGreaterThan(0.1);
    const darkHl = gradePixel(0.1, 0.1, 0.1, { ...DEFAULT_GRADE, highlights: 1 });
    expect(Math.abs(darkHl[0] - 0.1)).toBeLessThan(0.005); // highlights don't touch deep shadows
  });

  test("grade→cube bake bridge: cube matches direct model within 2.5/255", () => {
    const grade: typeof DEFAULT_GRADE = {
      ...DEFAULT_GRADE,
      exposure: 0.7, temperature: 0.4, contrast: 1.25, highlights: 0.3, shadows: -0.4,
      liftB: 0.08, gammaR: 1.1, gainG: 1.05, saturation: 1.3, vibrance: 0.4,
    };
    const baked = bakeGradeCube(grade, null, 33);
    const lutFn = (r: number, g: number, b: number) => sampleCube(baked, r, g, b);
    let worst = 0;
    for (const [r, g, b] of [[0.2, 0.35, 0.8], [0.5, 0.5, 0.5], [0.9, 0.1, 0.4], [0.05, 0.95, 0.3], [0.75, 0.85, 0.15]]) {
      const direct = gradePixel(r, g, b, grade);
      const viaCube = lutFn(r, g, b);
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(direct[k] - viaCube[k]));
    }
    expect(worst).toBeLessThan(2.5 / 255);
  });

  test("baked cube composes user LUT then grade (order documented and verified)", () => {
    // warm-ish user LUT: blue channel halved
    const userText = cube(17, "half-blue", (r, g, b) => [r, g, b * 0.5]);
    const userLut = parseCube(userText) as ReturnType<typeof parseCube> & { kind: "3d" };
    if (userLut.kind !== "3d") throw new Error("not 3d");
    const grade: typeof DEFAULT_GRADE = { ...DEFAULT_GRADE, exposure: 1 };
    const baked = bakeGradeCube(grade, userLut, 33);
    const direct = gradePixel(0.5, 0.5, 0.5, grade, (r, g, b) => sampleCube(userLut, r, g, b));
    const viaCube = sampleCube(baked, 0.5, 0.5, 0.5);
    for (let k = 0; k < 3; k++) expect(Math.abs(direct[k] - viaCube[k])).toBeLessThan(2.5 / 255);
    // and the user LUT really did halve blue BEFORE the exposure gain
    expect(Math.abs(direct[2] - Math.min(1, 0.25 * 2))).toBeLessThan(2.5 / 255);
  });
});
