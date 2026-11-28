/**
 * BEAN FX — M48-I export LUT bridge.
 *
 * Prepares ONE baked cube per graded clip (user LUT ∘ primary grade
 * pre-composed by bakeGradeCube — the SAME numbers the preview shader
 * applies) and writes it to a temp file the FFmpeg graph consumes via
 * `lut3d=file=...:interp=trilinear`. Preview and export therefore run the
 * identical transform — parity by construction, verified by decoded-frame
 * tests. Temp cubes are caller-managed (removed with the render workdir).
 */
import { promises as fs } from "fs";
import path from "path";
import { bakeGradeCube, parseCube, serializeCube, type CubeLut } from "@/lib/color/lut3d";
import { DEFAULT_GRADE, gradeIsNeutral } from "@/lib/color/grade-model";
import { lutCubePath } from "@/lib/editor/lut-store";
import type { Sequence } from "@/lib/editor/model";

export interface PreparedLutCube {
  clipId: string;
  filter: string; // `lut3d=file=...:interp=trilinear`
  filePath: string;
}

export async function prepareLut3dFilters(
  seq: Sequence,
  projectId: string,
  workDir: string,
): Promise<PreparedLutCube[]> {
  const out: PreparedLutCube[] = [];
  for (const clip of seq.clips) {
    if (!clip.grade && !clip.lutId) continue;
    if (clip.grade && !clip.lutId && gradeIsNeutral(clip.grade)) continue;
    const grade = { ...DEFAULT_GRADE, ...(clip.grade ?? {}) };
    let userCube: CubeLut | null = null;
    if (clip.lutId) {
      if (!seq.luts.some((l) => l.id === clip.lutId)) continue; // registry is the gate
      const text = await fs.readFile(lutCubePath(projectId, clip.lutId), "utf8");
      const parsed = parseCube(text);
      if (parsed.kind !== "3d") continue; // 1D LUTs are never mis-applied
      userCube = parsed;
    }
    const baked = bakeGradeCube(grade, userCube);
    const filePath = path.join(workDir, `lut3d_${clip.id}.cube`);
    await fs.writeFile(filePath, serializeCube(baked), "utf8");
    out.push({ clipId: clip.id, filter: `lut3d=file=${filePath}:interp=trilinear`, filePath });
  }
  return out;
}
