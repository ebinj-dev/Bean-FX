/**
 * BEAN FX — M48-I3 LUT storage (project-scoped, ownership-gated).
 *
 * Cubes live under the media root: luts/<projectId>/<lutId>.cube. The lutId
 * is generated SERVER-SIDE (never a user-controlled path component) and the
 * whole path goes through pathInsideMediaRoot, so there is no traversal
 * surface. Serving re-checks ownership AND membership in the project's
 * current timeline LUT registry (no existence leak, no cross-user access).
 * Nothing is uploaded to any external service.
 */
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { requireOwnedProject, getTimelineHead, ProjectNotFoundError } from "@/lib/editor/persistence";
import { pathInsideMediaRoot } from "@/lib/media-storage";
import { CUBE_MAX_BYTES, parseCube, type CubeLut } from "@/lib/color/lut3d";
import type { Lut } from "@/lib/editor/model";

/** Storage path for a cube (path-only; callers MUST have verified ownership). */
export function lutCubePath(projectId: string, lutId: string): string {
  return lutFilePath(projectId, lutId);
}

function lutFilePath(projectId: string, lutId: string): string {
  if (!/^[a-z0-9]{8,40}$/.test(projectId) || !/^[a-z0-9-]{6,64}$/.test(lutId)) {
    throw new ProjectNotFoundError(); // same "not found" answer — no existence leak
  }
  return pathInsideMediaRoot("luts", projectId, `${lutId}.cube`);
}

export interface SavedLut {
  lut: Lut;
  cube: CubeLut;
}

/** Validate + persist a .cube upload. Throws ProjectNotFoundError for
 *  non-owners and Error with a user-safe message for invalid LUTs. */
export async function saveLutForProject(
  projectId: string,
  userId: string,
  name: string,
  content: string,
  sourceName: string,
): Promise<SavedLut> {
  await requireOwnedProject(projectId, userId);
  if (Buffer.byteLength(content, "utf8") > CUBE_MAX_BYTES) {
    throw new Error("LUT exceeds the 16 MiB size cap");
  }
  const parsed = parseCube(content);
  if (parsed.kind !== "3d") {
    throw new Error("Only 3D .cube LUTs are supported for application (1D parsed but unsupported)");
  }
  if (!name.trim() || name.length > 120) throw new Error("LUT name must be 1..120 characters");
  const lutId = `lut-${randomBytes(9).toString("hex")}`;
  const filePath = lutFilePath(projectId, lutId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return {
    lut: {
      id: lutId,
      name: name.trim(),
      size: parsed.size,
      bytes: Buffer.byteLength(content, "utf8"),
      createdAt: new Date().toISOString().slice(0, 19) + "Z",
      sourceName: sourceName.slice(0, 200),
    },
    cube: parsed,
  };
}

/** Read a cube the caller owns AND that is registered in the project's
 *  current timeline (the registry is the single source of truth). */
export async function readLutForProject(projectId: string, userId: string, lutId: string): Promise<string> {
  await requireOwnedProject(projectId, userId);
  const head = await getTimelineHead(projectId, userId);
  if (!head.sequence.luts.some((l) => l.id === lutId)) throw new ProjectNotFoundError();
  try {
    return await fs.readFile(lutFilePath(projectId, lutId), "utf8");
  } catch {
    throw new ProjectNotFoundError();
  }
}

/** Best-effort file removal after a RemoveLut landed (file may already be gone). */
export async function deleteLutFile(projectId: string, lutId: string): Promise<void> {
  try {
    await fs.unlink(lutFilePath(projectId, lutId));
  } catch {
    /* already absent — fine */
  }
}
