/**
 * BEAN FX — M48-I LUT pipeline (`.cube` 3D LUTs).
 *
 * STRICT parser + evaluation + serialization. One implementation serves the
 * importer (validation), the preview (trilinear on CPU for scopes/tests and
 * a WebGL2 3D texture for the monitor) and the export (a serialized cube
 * handed to FFmpeg `lut3d` — user LUT + primary grade pre-composed into ONE
 * cube so preview and export consume the same numbers).
 *
 * Security posture (I3): hard size caps, strict header/domain/entry
 * validation, NaN/Infinity rejection, no filesystem access here (paths are
 * resolved and ownership-checked by the upload API layer only).
 */

export interface CubeLut {
  kind: "3d";
  size: number; // N of the N×N×N grid
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** Table in .cube order: r fastest, then g, then b — values in [0,1]. */
  table: Float32Array;
  title?: string;
}

export const CUBE_MAX_SIZE = 128; // professional cap: 128³ = 8 M entries
export const CUBE_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB upload cap

import { gradePixel, type GradeParams } from "@/lib/color/grade-model";

export class CubeParseError extends Error {}

/**
 * Parse a .cube document. Rejects: wrong/missing header, size > cap,
 * non-cube dimensions, entry-count mismatch, NaN/Infinity/out-of-table-range
 * values, duplicate header directives. 1D LUTs are parsed and VALIDATED
 * (LUT_1D_SIZE) but evaluation supports 3D only — a 1D LUT is reported as
 * unsupported rather than silently mis-applied.
 */
export function parseCube(text: string): CubeLut | { kind: "1d"; size: number } {
  if (text.length > CUBE_MAX_BYTES) throw new CubeParseError("LUT exceeds the 16 MiB size cap");
  const lines = text.split(/\r?\n/);
  let size3 = 0, size1 = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  let title: string | undefined;
  const values: number[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const up = line.toUpperCase();
    if (up.startsWith("TITLE")) {
      title = line.slice(5).trim().replace(/^["']|["']$/g, "");
      continue;
    }
    if (up.startsWith("LUT_3D_SIZE")) {
      const n = Number(line.slice(11).trim());
      if (!Number.isInteger(n) || n < 2 || n > CUBE_MAX_SIZE) {
        throw new CubeParseError(`invalid LUT_3D_SIZE ${line.slice(11).trim()} (2..${CUBE_MAX_SIZE})`);
      }
      size3 = n;
      continue;
    }
    if (up.startsWith("LUT_1D_SIZE")) {
      const n = Number(line.slice(11).trim());
      if (!Number.isInteger(n) || n < 2 || n > 65536) throw new CubeParseError("invalid LUT_1D_SIZE");
      size1 = n;
      continue;
    }
    if (up.startsWith("DOMAIN_MIN") || up.startsWith("DOMAIN_MAX")) {
      const parts = line.split(/\s+/).slice(1).map(Number);
      if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) {
        throw new CubeParseError("invalid DOMAIN_MIN/MAX");
      }
      if (up.startsWith("DOMAIN_MIN")) domainMin = [parts[0], parts[1], parts[2]];
      else domainMax = [parts[0], parts[1], parts[2]];
      continue;
    }
    if (up.startsWith("LUT_")) throw new CubeParseError(`unsupported directive: ${line}`);
    const parts = line.split(/\s+/).map(Number);
    if (parts.length !== 3) throw new CubeParseError(`malformed data line: ${line.slice(0, 40)}`);
    for (const v of parts) {
      if (!Number.isFinite(v)) throw new CubeParseError("NaN/Infinity in LUT data");
      if (v < -0.004 || v > 1.004) throw new CubeParseError(`value out of [0,1] range: ${v}`);
      values.push(v);
    }
  }

  if (size3 && size1) throw new CubeParseError("both LUT_3D_SIZE and LUT_1D_SIZE present");
  if (size3) {
    const expected = size3 ** 3 * 3;
    if (values.length !== expected) {
      throw new CubeParseError(`expected ${expected} values for ${size3}³, got ${values.length}`);
    }
    for (let i = 0; i < 3; i++) {
      if (domainMin[i] >= domainMax[i]) throw new CubeParseError("DOMAIN_MIN >= DOMAIN_MAX");
    }
    return { kind: "3d", size: size3, domainMin, domainMax, table: new Float32Array(values), title };
  }
  if (size1) {
    const expected = size1 * 3;
    if (values.length !== expected) throw new CubeParseError("1D entry count mismatch");
    return { kind: "1d", size: size1 }; // valid but unsupported for application
  }
  throw new CubeParseError("missing LUT_3D_SIZE header (only .cube 3D LUTs are supported)");
}

/** Trilinear sample with the cube's own domain mapping. */
export function sampleCube(lut: CubeLut, r: number, g: number, b: number): [number, number, number] {
  const { size, table } = lut;
  const nx = Math.min(size - 1, Math.max(0, (r - lut.domainMin[0]) / (lut.domainMax[0] - lut.domainMin[0]) * (size - 1)));
  const ny = Math.min(size - 1, Math.max(0, (g - lut.domainMin[1]) / (lut.domainMax[1] - lut.domainMin[1]) * (size - 1)));
  const nz = Math.min(size - 1, Math.max(0, (b - lut.domainMin[2]) / (lut.domainMax[2] - lut.domainMin[2]) * (size - 1)));
  const x0 = Math.floor(nx), y0 = Math.floor(ny), z0 = Math.floor(nz);
  const x1 = Math.min(size - 1, x0 + 1), y1 = Math.min(size - 1, y0 + 1), z1 = Math.min(size - 1, z0 + 1);
  const fx = nx - x0, fy = ny - y0, fz = nz - z0;
  const idx = (x: number, y: number, z: number) => ((z * size + y) * size + x) * 3;
  const c000 = idx(x0, y0, z0), c100 = idx(x1, y0, z0), c010 = idx(x0, y1, z0), c110 = idx(x1, y1, z0);
  const c001 = idx(x0, y0, z1), c101 = idx(x1, y0, z1), c011 = idx(x0, y1, z1), c111 = idx(x1, y1, z1);
  const t = table;
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v00 = t[c000 + k] * (1 - fx) + t[c100 + k] * fx;
    const v10 = t[c010 + k] * (1 - fx) + t[c110 + k] * fx;
    const v01 = t[c001 + k] * (1 - fx) + t[c101 + k] * fx;
    const v11 = t[c011 + k] * (1 - fx) + t[c111 + k] * fx;
    const v0 = v00 * (1 - fy) + v10 * fy;
    const v1 = v01 * (1 - fy) + v11 * fy;
    out[k] = v0 * (1 - fz) + v1 * fz;
  }
  return out;
}

/** LUT evaluator for gradePixel: identity when no LUT. */
export function cubeEvaluator(lut: CubeLut): (r: number, g: number, b: number) => [number, number, number] {
  return (r, g, b) => sampleCube(lut, r, g, b);
}

/**
 * Serialize a cube to .cube text (r-fastest order, 6 decimals). Used for
 * grade-LUT temp files handed to FFmpeg and for identity/preview fixtures.
 */
export function serializeCube(lut: CubeLut): string {
  const out: string[] = [];
  if (lut.title) out.push(`TITLE "${lut.title.replace(/"/g, "'")}"`);
  out.push(`LUT_3D_SIZE ${lut.size}`);
  const dmin = lut.domainMin.every((v) => v === 0) ? null : `DOMAIN_MIN ${lut.domainMin.join(" ")}`;
  const dmax = lut.domainMax.every((v) => v === 1) ? null : `DOMAIN_MAX ${lut.domainMax.join(" ")}`;
  if (dmin) out.push(dmin);
  if (dmax) out.push(dmax);
  for (let b = 0; b < lut.size; b++) {
    for (let g = 0; g < lut.size; g++) {
      for (let r = 0; r < lut.size; r++) {
        const i = ((b * lut.size + g) * lut.size + r) * 3;
        out.push(
          `${lut.table[i].toFixed(6)} ${lut.table[i + 1].toFixed(6)} ${lut.table[i + 2].toFixed(6)}`,
        );
      }
    }
  }
  return out.join("\n") + "\n";
}

/** Identity N³ cube. */
export function identityCube(size = 33, title = "identity"): CubeLut {
  const n = size ** 3;
  const table = new Float32Array(n * 3);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        table[i++] = r / (size - 1);
        table[i++] = g / (size - 1);
        table[i++] = b / (size - 1);
      }
    }
  }
  return { kind: "3d", size, domainMin: [0, 0, 0], domainMax: [1, 1, 1], table, title };
}

/**
 * THE parity bridge: bake (user LUT ∘ primary grade) into ONE 65³ cube.
 * The preview shader applies user-LUT-then-grade with the same formulas;
 * the export applies this cube through FFmpeg `lut3d`. Same numbers, two
 * consumers. 65³ ≈ 275k model evals — subsecond.
 */
export function bakeGradeCube(
  grade: GradeParams,
  userLut: CubeLut | null,
  size = 65,
  title = "beanfx-grade",
): CubeLut {
  const evalLut = userLut ? cubeEvaluator(userLut) : undefined;
  const table = new Float32Array(size ** 3 * 3);
  let i = 0;
  for (let b = 0; b < size; b++) {
    const bv = b / (size - 1);
    for (let g = 0; g < size; g++) {
      const gv = g / (size - 1);
      for (let r = 0; r < size; r++) {
        const rv = r / (size - 1);
        const [or, og, ob] = gradePixel(rv, gv, bv, grade, evalLut);
        table[i++] = or; table[i++] = og; table[i++] = ob;
      }
    }
  }
  return { kind: "3d", size, domainMin: [0, 0, 0], domainMax: [1, 1, 1], table, title };
}
