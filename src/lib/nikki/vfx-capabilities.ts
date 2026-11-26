/**
 * BEAN FX — M45 Unit B NIIKI VFX capability registry.
 *
 * ONE authoritative, typed answer to "which VFX capabilities exist, how real
 * are they, and what gates them". Every entry states implementation status
 * honestly; nothing is advertised as working unless both a canonical command
 * path AND a validated export path exist. The NIIKI workspace renders its
 * availability list from this registry — never from hardcoded UI claims.
 *
 * License notes:
 *  - libvidstab (stabilization) is GPL-2.0-or-later; this deployment's ffmpeg
 *    build already ships GPL components (libx264), so enabling vidstab adds
 *    no new licensing class. Recorded here deliberately.
 *  - No AI segmentation/rotoscoping/depth model is verified in this
 *    environment — those stay CONFIGURATION REQUIRED and are never faked
 *    (see lib/production/masks.ts for the same honesty rule).
 */
import type { EffectType } from "@/lib/editor/model";

export type VfxAvailability =
  | "IMPLEMENTED"
  | "PARTIAL"
  | "CONFIGURATION_REQUIRED"
  | "NOT_IMPLEMENTED";

export interface VfxCapability {
  id: string;
  label: string;
  group: "compositing" | "keying" | "masks" | "tracking" | "advanced" | "motion";
  availability: VfxAvailability;
  /** How it actually works today (real implementation summary). */
  how: string;
  /** What is missing / gated and WHY — shown to the user verbatim. */
  gate?: string;
  /** Canonical command or job path (proves it is wired, not decorative). */
  path: string;
  effectType?: EffectType;
  licenseNote?: string;
}

export const VFX_CAPABILITIES: VfxCapability[] = [
  {
    id: "layer-compositing",
    label: "Layer compositing",
    group: "compositing",
    availability: "IMPLEMENTED",
    how: "Multi-track overlays composite in track order with per-clip opacity and transform (position/scale/rotation); monitor canvas and FFmpeg overlay graph use the same geometry.",
    path: "canonical UpdateClipProperties + RENDER_TIMELINE overlay graph",
  },
  {
    id: "blend-modes",
    label: "Blend modes",
    group: "compositing",
    availability: "NOT_IMPLEMENTED",
    how: "FFmpeg blend/blend_all requires filter-graph branching (split + two inputs per layer); the current per-clip linear chain and the canvas layer model do not carry a blend-mode parameter yet.",
    gate: "Planned: extend the overlay graph with split/blend when a branch-capable chain builder lands. Do not fake with opacity alone.",
    path: "—",
  },
  {
    id: "alpha-handling",
    label: "Alpha-channel handling",
    group: "compositing",
    availability: "IMPLEMENTED",
    how: "Overlays render through yuva420p/rgba alpha paths; masks and chroma key write real alpha; keyed clips composite over lower tracks with straight alpha.",
    path: "renderer alpha pipeline + effects",
  },
  {
    id: "chroma-key",
    label: "Chroma key (green/blue screen)",
    group: "keying",
    availability: "IMPLEMENTED",
    how: "Per-clip effect with key color, similarity and soft-edge blend; FFmpeg chromakey on export, YCbCr canvas keying in preview. Spill suppression on semi-keyed pixels.",
    path: "AddEffect chromaKey → ffmpeg chromakey",
    effectType: "chromaKey",
  },
  {
    id: "rect-mask",
    label: "Rectangle mask + feather",
    group: "masks",
    availability: "IMPLEMENTED",
    how: "Percent-inset rectangle with feather ramp and invert; FFmpeg yuva444p+geq alpha (exact ramp) mirrored pixel-exact by the canvas op.",
    path: "AddEffect rectMask → ffmpeg geq",
    effectType: "rectMask",
  },
  {
    id: "ellipse-mask",
    label: "Ellipse mask + feather",
    group: "masks",
    availability: "IMPLEMENTED",
    how: "Center/radii ellipse with normalized-distance feather ramp and invert; same geq/canvas pairing as the rectangle mask.",
    path: "AddEffect ellipseMask → ffmpeg geq",
    effectType: "ellipseMask",
  },
  {
    id: "mask-animation",
    label: "Animated masks",
    group: "masks",
    availability: "PARTIAL",
    how: "Effect parameters ride the M27 keyframe system (SetEffectKeyframe), so mask insets/feather can animate; the NIIKI workspace exposes keyframing on the numeric params.",
    gate: "No mask-path editing (bezier shape animation) — rectangle and ellipse shapes only.",
    path: "SetEffectKeyframe on mask params",
  },
  {
    id: "motion-blur",
    label: "Motion blur",
    group: "motion",
    availability: "IMPLEMENTED",
    how: "FFmpeg tmix=frames=N uniform frame mixing on export; ring-buffer frame averaging in preview (approximate — disclosed).",
    path: "AddEffect motionBlur → ffmpeg tmix",
    effectType: "motionBlur",
  },
  {
    id: "stabilization",
    label: "Stabilization",
    group: "advanced",
    availability: "IMPLEMENTED",
    how: "Two-pass libvidstab through the durable job system: vidstabdetect writes the transforms file, vidstabtransform renders a stabilized derivative asset with provenance.",
    path: "MEDIA_STABILIZE job (NIIKI workspace action)",
    licenseNote: "libvidstab is GPL-2.0-or-later; this deployment's ffmpeg build already ships GPL components (libx264) — no new licensing class.",
  },
  {
    id: "motion-tracking",
    label: "Point/object tracking",
    group: "tracking",
    availability: "NOT_IMPLEMENTED",
    how: "Real tracking needs OpenCV CSRT/KCF trackers; this environment ships legacy/CSRT-missing cv2 and no tracking results flow exists into graphics anchoring.",
    gate: "Install opencv-contrib-python and define the track→NIIKI anchor contract before advertising tracking. A confidence/failure surface is part of that contract.",
    path: "—",
  },
  {
    id: "ai-rotoscoping",
    label: "AI-assisted rotoscoping",
    group: "tracking",
    availability: "CONFIGURATION_REQUIRED",
    how: "The M32 mask pipeline accepts refined alpha masks (invert/feather/edge-refine) and composites via alphamerge — but NO verified segmentation model exists here.",
    gate: "Requires a licensed segmentation provider/model with provenance before any auto-matte is offered. Never faked with blur/rectangles (M32 rule).",
    path: "M32 mask pipeline (manual masks today)",
  },
  {
    id: "object-removal",
    label: "Object removal",
    group: "advanced",
    availability: "NOT_IMPLEMENTED",
    how: "Genuine object removal needs tracking + inpainting models; neither exists verified in this environment.",
    gate: "Blocked until a licensed inpainting model and the tracking prerequisite land.",
    path: "—",
  },
  {
    id: "screen-replacement",
    label: "Screen replacement",
    group: "advanced",
    availability: "NOT_IMPLEMENTED",
    how: "Requires corner-pinning on tracked points (tracking is unavailable) plus perspective compositing in the overlay graph.",
    gate: "Blocked by motion-tracking availability.",
    path: "—",
  },
  {
    id: "particle-effects",
    label: "Particle effects",
    group: "advanced",
    availability: "NOT_IMPLEMENTED",
    how: "No particle engine exists in the canvas layer model; NIIKI graphics are deterministic templates and typed proposals.",
    gate: "Planned as NIIKI graphic templates with real keyframes — not a fake toggle.",
    path: "—",
  },
  {
    id: "depth-effects",
    label: "Depth-based effects",
    group: "advanced",
    availability: "CONFIGURATION_REQUIRED",
    how: "Depth estimation requires a verified (and commercially licensed) monocular depth model; Woosh-class weights on record are CC-BY-NC and MUST NOT be enabled for commercial use.",
    gate: "Blocked by model licensing (CC-BY-NC weights are forbidden in commercial BEAN FX).",
    path: "—",
  },
];

export function vfxCapabilityById(id: string): VfxCapability | null {
  return VFX_CAPABILITIES.find((c) => c.id === id) ?? null;
}
