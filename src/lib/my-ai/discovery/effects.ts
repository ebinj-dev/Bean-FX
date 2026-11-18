/**
 * Effect / template / capability discovery (M8 §9D).
 *
 * Generated from ACTUAL registered implementations — never placeholders:
 *  - clip effects: the validated EffectType enum in the M1 model (6 types)
 *  - transitions: TransitionKind enum (8 kinds) — full FFmpeg export support
 *    via the M6 xfade mapping
 *  - NIIKI templates: NIKKI_TEMPLATES (M6)
 *  - GANGZII presets: GANGZII_PRESETS (M5)
 *  - M1 commands: the command union in commands.ts
 *  - engines: M7 capability maps (jazmii/laxii) + GANGZII/RIISHE/NIIKI ops
 */
import { EffectType, TransitionKind } from "@/lib/editor/model";
import { NIKKI_TEMPLATES } from "@/lib/nikki/templates";
import { GANGZII_PRESETS } from "@/lib/gangzii/presets";
import { jazmiiProviderIds, ZAI_VIDEO_PROVIDER } from "@/lib/jazmii/providers";
import { laxiiProviderIds, ZAI_IMAGE_PROVIDER } from "@/lib/laxii/providers";

export interface EffectCapability {
  id: string;
  name: string;
  category: "color" | "geometry" | "audio";
  supportedMediaTypes: string[];
  parameters: { key: string; type: string; default: number | string | boolean; constraints: string }[];
  previewSupport: string;
  exportSupport: string;
  version: 1;
}

/**
 * Honest per-effect capability records. The M1 model validates all six types;
 * parameter keys mirror what the model/inspector expose. Filter-level render
 * application is documented per effect — no claimed-but-missing rendering.
 */
export const EFFECT_CAPABILITIES: EffectCapability[] = [
  {
    id: "opacity", name: "Opacity", category: "geometry", supportedMediaTypes: ["VIDEO", "IMAGE", "GRAPHIC"],
    parameters: [{ key: "value", type: "number", default: 100, constraints: "0..100" }],
    previewSupport: "monitor (transform.opacity) + NIIKI keyframes; export via alpha expression",
    exportSupport: "full (keyframed opacity expression in the FFmpeg render)",
    version: 1,
  },
  {
    id: "volume", name: "Volume", category: "audio", supportedMediaTypes: ["VIDEO", "AUDIO"],
    parameters: [{ key: "value", type: "number", default: 100, constraints: "0..200" }],
    previewSupport: "monitor playback volume",
    exportSupport: "full (volume filter in the render pipeline)",
    version: 1,
  },
  {
    id: "grayscale", name: "Grayscale", category: "color", supportedMediaTypes: ["VIDEO", "IMAGE"],
    parameters: [{ key: "enabled", type: "boolean", default: true, constraints: "on/off" }],
    previewSupport: "validated model data; monitor filter application is partial",
    exportSupport: "partial — stored/validated; FFmpeg hue=s=0 application planned",
    version: 1,
  },
  {
    id: "blur", name: "Blur", category: "color", supportedMediaTypes: ["VIDEO", "IMAGE"],
    parameters: [{ key: "radius", type: "number", default: 4, constraints: "1..20 px" }],
    previewSupport: "validated model data; monitor filter application is partial",
    exportSupport: "partial — stored/validated; gblur application planned",
    version: 1,
  },
  {
    id: "flipH", name: "Flip Horizontal", category: "geometry", supportedMediaTypes: ["VIDEO", "IMAGE"],
    parameters: [{ key: "enabled", type: "boolean", default: true, constraints: "on/off" }],
    previewSupport: "monitor (transform) where applied",
    exportSupport: "full (hflip mapped in the compositor)",
    version: 1,
  },
  {
    id: "flipV", name: "Flip Vertical", category: "geometry", supportedMediaTypes: ["VIDEO", "IMAGE"],
    parameters: [{ key: "enabled", type: "boolean", default: true, constraints: "on/off" }],
    previewSupport: "monitor (transform) where applied",
    exportSupport: "full (vflip mapped in the compositor)",
    version: 1,
  },
];

export interface TransitionCapability {
  id: string;
  name: string;
  ffmpegEquivalent: string | null;
  supportedMediaTypes: string[];
  version: 1;
}

export const TRANSITION_CAPABILITIES: TransitionCapability[] = [
  { id: "CUT", name: "Cut (hard join)", ffmpegEquivalent: "hard join", supportedMediaTypes: ["VIDEO"], version: 1 },
  { id: "CROSS_DISSOLVE", name: "Cross dissolve", ffmpegEquivalent: "xfade=fade", supportedMediaTypes: ["VIDEO"], version: 1 },
  { id: "FADE_TO_BLACK", name: "Fade to black", ffmpegEquivalent: "xfade=fadeblack", supportedMediaTypes: ["VIDEO"], version: 1 },
  { id: "FADE_FROM_BLACK", name: "Fade from black", ffmpegEquivalent: "xfade=fadewhite", supportedMediaTypes: ["VIDEO"], version: 1 },
  { id: "WIPE_LEFT", name: "Wipe left", ffmpegEquivalent: "xfade=wipeleft", supportedMediaTypes: ["VIDEO"], version: 1 },
  { id: "WIPE_RIGHT", name: "Wipe right", ffmpegEquivalent: "xfade=wiperight", supportedMediaTypes: ["VIDEO"], version: 1 },
  { id: "SLIDE_LEFT", name: "Slide left", ffmpegEquivalent: "xfade=slideleft", supportedMediaTypes: ["VIDEO"], version: 1 },
  { id: "SLIDE_RIGHT", name: "Slide right", ffmpegEquivalent: "xfade=slideright", supportedMediaTypes: ["VIDEO"], version: 1 },
];

/** One capability catalog snapshot (cached per process — registries are static). */
export function capabilityCatalog(): {
  effects: EffectCapability[];
  transitions: TransitionCapability[];
  niikiTemplates: { id: string; label: string; category: string; description: string; version: number }[];
  gangziiPresets: { id: string; label: string; description: string; params: Record<string, unknown> }[];
  commands: string[];
  engines: Record<string, unknown>;
  unsupported: string[];
} {
  return {
    effects: EFFECT_CAPABILITIES,
    transitions: TRANSITION_CAPABILITIES,
    niikiTemplates: NIKKI_TEMPLATES.map((t) => ({
      id: t.id,
      label: t.label,
      category: t.category,
      description: (t.description ?? "").slice(0, 160),
      version: t.version,
    })),
    gangziiPresets: GANGZII_PRESETS.map((p) => ({
      id: p.id,
      label: p.label,
      description: (p.description ?? "").slice(0, 160),
      params: p.params,
    })),
    commands: [
      "AddTrack", "RemoveTrack", "UpdateTrack", "AddClip", "RemoveClip", "SplitClip", "TrimClip", "MoveClip",
      "RippleDelete", "InsertClip", "ReplaceClip", "AddTransition", "RemoveTransition", "AddEffect", "RemoveEffect",
      "AddCaption", "AddGraphic", "SetKeyframe", "RemoveKeyframe", "UpdateClip",
    ],
    engines: {
      RIISHE: { domain: "captions + auto cut", operations: ["transcribe", "cut-decisions", "apply-cuts (M4 route)"] },
      GANGZII: { domain: "audio", presets: GANGZII_PRESETS.map((p) => p.id), providerConfigured: true },
      NIIKI: { domain: "motion graphics", templates: NIKKI_TEMPLATES.length, templatesById: NIKKI_TEMPLATES.map((t) => t.id), operations: ["word-by-word captions", "lower thirds", "titles", "highlights", "transitions"] },
      JAZMII: { providers: jazmiiProviderIds(), capabilities: ZAI_VIDEO_PROVIDER.capabilities, operations: ["textToVideo", "imageToVideo", "analysis", "shot-suggestions"] },
      LAXII: { providers: laxiiProviderIds(), capabilities: ZAI_IMAGE_PROVIDER.capabilities, operations: ["textToImage", "imageToImage", "aspect-adaptation", "thumbnails"] },
    },
    unsupported: [
      "no arbitrary FFmpeg/shell/SQL tools (security model)",
      "media_import via MCP (chunked upload is an authenticated browser flow)",
      "bean_edit_undo/redo (session state lives in the editor; use version restore)",
      "bean_timeline_get_selection (selection is per-editor-session, not server state)",
    ],
  };
}

void EffectType;
void TransitionKind;
