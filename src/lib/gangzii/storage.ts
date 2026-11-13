/**
 * GANGZII — derived-asset storage (M5).
 *
 * Processed audio lives under `<BEANFX_DATA_DIR>/media-store/derived/` —
 * INSIDE the managed media root, outside Git, one file per process row.
 * Original media is NEVER written to: every GANGZII output is a new file
 * referenced by its own MediaAsset row (derivedFromId → the original).
 */
import { mkdir } from "fs/promises";
import path from "path";
import { MEDIA_ROOT, pathInsideMediaRoot } from "@/lib/media-storage";

export const DERIVED_DIR = path.join(MEDIA_ROOT, "derived");

export async function ensureDerivedDir(): Promise<void> {
  await mkdir(DERIVED_DIR, { recursive: true });
}

/** Safe path for a derived output (always inside the managed media root). */
export function derivedPath(processId: string, ext: string): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").slice(0, 5).toLowerCase() || "flac";
  return pathInsideMediaRoot("derived", `${processId}.${safeExt}`);
}
