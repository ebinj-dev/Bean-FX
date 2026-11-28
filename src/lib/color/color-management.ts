/**
 * BEAN FX — M48-I4 SDR color management interpretation.
 *
 * TRUTHFUL, small, and explicit: the editor's working space is the source's
 * STORED gamma with Rec.709 primaries (standard SDR NLE behaviour). Sources
 * whose probed metadata says something else are FLAGGED, never silently
 * re-transformed, and never claimed as HDR/ACES/ICC (those do not exist in
 * this pipeline). Missing metadata gets a documented default interpretation.
 */

import type { FfprobeResult } from "@/lib/media-storage";

export interface ColorInterpretation {
  /** true = the stored-gamma pipeline treats this source as designed. */
  supported: boolean;
  /** What the pipeline assumes for this source (shown in the UI/report). */
  workingSpace: string;
  /** Honest per-field interpretation or conflict notes. */
  notes: string[];
  /** true when the source carries NO color metadata (defaults assumed). */
  metadataMissing: boolean;
}

const KNOWN_SDR_TRANSFER = new Set(["bt709", "smpte170m", "bt470bg", "gamma28", "iec61966-2-1", "srgb", "unknown", "unspecified"]);
const KNOWN_SDR_PRIMARIES = new Set(["bt709", "bt470bg", "smpte170m", "unknown", "unspecified"]);

export function interpretSourceColor(probe: Pick<FfprobeResult, "color">): ColorInterpretation {
  const c = probe.color;
  const notes: string[] = [];
  const missing = !c.space && !c.transfer && !c.primaries && !c.range;
  if (missing) {
    notes.push("Source carries no color metadata — interpreted as limited-range Rec.709/sRGB SDR (the editor default).");
  }
  const range = c.range ?? "tv";
  if (range === "pc") notes.push("Full-range (pc) source — decoded as stored; exports keep the range flag.");
  if (range !== "pc" && !missing) notes.push("Limited-range (tv) source — standard SDR decode.");
  if (c.primaries && !KNOWN_SDR_PRIMARIES.has(c.primaries)) {
    notes.push(`Primaries "${c.primaries}" are outside the supported SDR set (Rec.709 family) — flagged, not converted.`);
  }
  if (c.transfer && !KNOWN_SDR_TRANSFER.has(c.transfer)) {
    notes.push(`Transfer "${c.transfer}" is not an SDR curve this pipeline handles (HDR curves are NOT implemented) — flagged, not converted.`);
  }
  const hdrSuspicion =
    (c.transfer && /arib|smpte2084|hlg|bt2020|dolby/i.test(c.transfer)) ||
    (c.primaries && /bt2020/i.test(c.primaries));
  const supported = !hdrSuspicion && notes.filter((n) => n.includes("not converted")).length === 0;
  if (hdrSuspicion) notes.push("HDR-capable metadata detected — HDR is NOT implemented; the pipeline treats the values as stored SDR. Verify visually.");
  return {
    supported,
    workingSpace: "stored-gamma Rec.709 primaries, SDR (editor working space)",
    notes,
    metadataMissing: missing,
  };
}

/**
 * The honest compatibility matrix (I4). Exported for the docs and the
 * capabilities endpoint — never advertise more than this.
 */
export const COLOR_SUPPORT_MATRIX = {
  input: {
    "Rec.709/sRGB SDR, limited range": "supported (native)",
    "Rec.709/sRGB SDR, full range": "supported (range flag preserved on export)",
    "Rec.601 (bt470bg/smpte170m) SDR": "supported as stored-gamma (no matrix conversion — flagged)",
    "Missing color metadata": "defaulted to Rec.709 limited-range + flagged",
    "HDR10 (smpte2084)": "NOT implemented — flagged, treated as stored values",
    "HLG (arib-std-b67)": "NOT implemented — flagged",
    "Dolby Vision": "NOT implemented — flagged",
    "ACES / ICC profiles": "NOT implemented (no claim, no partial path)",
  },
  working: "stored-gamma RGB [0,1], Rec.709 primaries assumed",
  output: {
    "SDR mp4/webm (yuv420p)": "supported — source range flag preserved via encoder metadata",
    "ProRes 4444": "supported by the container work (M-era), color = stored-gamma",
    "HDR outputs": "NOT implemented",
  },
  lut: {
    "3D .cube (LUT_3D_SIZE 2..128)": "supported (trilinear, domain respected)",
    "1D .cube": "parsed + validated, application NOT supported (never mis-applied)",
    ".3dl/.csp/hald": "NOT supported",
  },
} as const;
