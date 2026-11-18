/**
 * NIIKI — MY AI proposal interface (M6 §11).
 *
 * Maps natural-language instructions to structured, validated COMMAND
 * proposals through a deterministic intent table (no LLM inside NIIKI — the
 * M8 orchestrator will sit on top of this typed surface). Proposals are
 * editor commands (AddGraphic / AddTrack / UpdateClipProperties /
 * SetKeyframe / AddTransition) — they are applied through the M1 command
 * engine's normal validation, so an AI can never execute shell commands,
 * touch media, or create an invalid timeline.
 */
import type { Command } from "@/lib/editor/commands";
import { templateById, NIKKI_TEMPLATES } from "./templates";

export interface NikkiProposal {
  engine: "NIIKI";
  intent: string;
  confidence: number;
  explanation: string;
  caveats: string[];
  /** Validated-shape commands (still re-validated by applyCommand). */
  commands: Command[];
}

interface Rule {
  intent: string;
  patterns: RegExp[];
  confidence: number;
  build: (instruction: string, ctx: ProposalContext) => Omit<NikkiProposal, "engine" | "intent" | "confidence">;
}

export interface ProposalContext {
  seqFps: { num: number; den: number };
  seqWidth: number;
  seqHeight: number;
  /** A new clip id / track id / graphic id source (deterministic caller-provided). */
  newId: (kind: "clip" | "track" | "graphic") => string;
  /** Insert frame on the timeline (playhead or clip start). */
  atFrame: number;
  /** Frames available from atFrame (sequence end by default). */
  availableFrames: number;
  /** Selected graphic clip id, when the user has one. */
  selectedGraphicClipId?: string | null;
  /** The selected graphic clip's CURRENT style (for merge-on-apply updates). */
  selectedGraphicStyle?: import("./types").NikkiGraphicStyle | null;
}

function fpsOf(ctx: ProposalContext): number {
  return ctx.seqFps.num / ctx.seqFps.den;
}

const RULES: Rule[] = [
  {
    intent: "caption-word-reveal",
    patterns: [/word by word/i, /word-by-word/i, /captions? (appear|reveal)/i, /kinetic caption/i],
    confidence: 0.9,
    build: (_ins, ctx) => {
      const t = templateById("caption-word-reveal")!;
      const clipId = ctx.newId("clip");
      const trackId = ctx.newId("track");
      return {
        explanation: `Adds a "${t.label}" graphic: text reveals word by word with a rise + fade.`,
        caveats: ["Edit the caption text in the NIIKI panel after applying."],
        commands: [
          { type: "AddTrack", track: { id: trackId, kind: "GRAPHIC", name: "Graphics", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
          { type: "AddGraphic", clip: graphicClipCore(clipId, trackId, t.id, t.style, ctx, Math.min(ctx.availableFrames, Math.round(fpsOf(ctx) * 5))) },
        ],
      };
    },
  },
  {
    intent: "lower-third",
    patterns: [/lower third/i, /name( and| &)? designation/i, /presenter/i, /speaker (name|tag)/i],
    confidence: 0.92,
    build: (_ins, ctx) => {
      const t = templateById("lower-third-bar")!;
      const clipId = ctx.newId("clip");
      const trackId = ctx.newId("track");
      return {
        explanation: `Adds a "${t.label}": name + designation on an accent bar, slide-in from the left.`,
        caveats: [],
        commands: [
          { type: "AddTrack", track: { id: trackId, kind: "GRAPHIC", name: "Graphics", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
          { type: "AddGraphic", clip: graphicClipCore(clipId, trackId, t.id, t.style, ctx, Math.min(ctx.availableFrames, Math.round(fpsOf(ctx) * 6))) },
        ],
      };
    },
  },
  {
    intent: "title-animation",
    patterns: [/animate this title/i, /title from the left/i, /slide.*title/i, /intro animation/i, /clean intro/i, /animate from the left/i],
    confidence: 0.85,
    build: (_ins, ctx) => {
      const t = templateById("title-intro-slide")!;
      const clipId = ctx.newId("clip");
      const trackId = ctx.newId("track");
      return {
        explanation: `Adds a "${t.label}": title slides up with tracking-in emphasis and fades out.`,
        caveats: [],
        commands: [
          { type: "AddTrack", track: { id: trackId, kind: "GRAPHIC", name: "Graphics", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
          { type: "AddGraphic", clip: graphicClipCore(clipId, trackId, t.id, t.style, ctx, Math.min(ctx.availableFrames, Math.round(fpsOf(ctx) * 5))) },
        ],
      };
    },
  },
  {
    intent: "title-larger-fade",
    patterns: [/make the title larger/i, /larger and fade/i, /scale.*title.*up/i, /fade (the )?title out/i],
    confidence: 0.8,
    build: (_ins, ctx) => {
      const clipId = ctx.selectedGraphicClipId ?? "";
      const commands: Command[] = [];
      if (!clipId) {
        const t = templateById("title-scale-in")!;
        const trackId = ctx.newId("track");
        commands.push(
          { type: "AddTrack", track: { id: trackId, kind: "GRAPHIC", name: "Graphics", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
          { type: "AddGraphic", clip: graphicClipCore(ctx.newId("clip"), trackId, t.id, t.style, ctx, Math.min(ctx.availableFrames, Math.round(fpsOf(ctx) * 5))) },
        );
      } else {
        const dur = Math.round(fpsOf(ctx) * 5);
        commands.push(
          { type: "UpdateClipProperties", clipId, graphicTemplateId: "title-scale-in" } as Command,
          { type: "SetKeyframe", clipId, keyframe: { id: ctx.newId("graphic"), property: "scale", frame: 0, value: 120, interpolation: "EASE_OUT", bezier: null } } as Command,
          { type: "SetKeyframe", clipId, keyframe: { id: ctx.newId("graphic"), property: "scale", frame: dur, value: 100, interpolation: "EASE_OUT", bezier: null } } as Command,
        );
      }
      return {
        explanation: clipId ? "Scales the selected title in from 120% and keeps it editable; fade handled by the template exit." : "Creates a scale-in title (no graphic clip was selected).",
        caveats: clipId ? [] : ["Select a graphic clip to restyle an existing title instead."],
        commands,
      };
    },
  },
  {
    intent: "highlight-words",
    patterns: [/highlight/i, /emphas(i[sz]e|se) .*words?/i, /important words/i, /bold .*word/i],
    confidence: 0.85,
    build: (ins, ctx) => {
      // Take up to 3 quoted or capitalised words as highlights (deterministic).
      const quoted = Array.from(ins.matchAll(/"([^"]{1,40})"|'([^']{1,40})'/g)).map((m) => (m[1] ?? m[2])!.trim());
      const words = quoted.length > 0 ? quoted.slice(0, 3) : ins.match(/\b[A-Z]{3,}\b/g)?.slice(0, 3) ?? [];
      if (words.length === 0) {
        return {
          explanation: "No highlightable words found — name the words in quotes, e.g. highlight \"breaking\".",
          caveats: ["The highlight matcher is exact-match and editable afterwards."],
          commands: [],
        };
      }
      if (!ctx.selectedGraphicClipId || !ctx.selectedGraphicStyle) {
        return {
          explanation: "Select a graphic clip first — highlights edit an existing graphic.",
          caveats: [],
          commands: [],
        };
      }
      return {
        explanation: `Highlights ${words.map((w) => `"${w}"`).join(", ")} with the accent color and a slight scale.`,
        caveats: ["Highlights apply to the selected graphic clip."],
        commands: [
          {
            type: "UpdateClipProperties",
            clipId: ctx.selectedGraphicClipId,
            graphicStyle: {
              ...ctx.selectedGraphicStyle,
              highlights: words.map((w) => ({ word: w, color: "#D4A017", scalePct: 120 })),
            },
          } as Command,
        ],
      };
    },
  },
];

/**
 * Deterministic graphic clip core from a template seed.
 * Graphic clips carry an empty source range convention: sourceIn=0,
 * sourceOut = duration at the sequence fps (a graphics placeholder has no
 * media; missingMedia stays false because a graphic clip has no source).
 */
function graphicClipCore(
  clipId: string,
  trackId: string,
  templateId: string,
  style: import("./types").NikkiGraphicStyle,
  ctx: ProposalContext,
  durationFrames: number,
): Extract<Command, { type: "AddGraphic" }>["clip"] {
  const fps = ctx.seqFps;
  return {
    id: clipId,
    trackId,
    sourceAssetId: "",
    sourceInFrame: 0,
    sourceOutFrame: durationFrames,
    sourceFps: { num: fps.num, den: fps.den },
    timelineStartFrame: Math.max(0, ctx.atFrame),
    playbackSpeed: 1,
    volume: 1,
    muted: false,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null,
    captionStyle: null,
    graphicTemplateId: templateId,
    graphicStyle: { ...style, templateId, templateVersion: 1 },
    label: templateById(templateId)?.label ?? templateId,
    missingMedia: false,
    pan: 0,
    groupId: null,
    effects: [],
    keyframes: [],
  };
}

/** Highest-scoring intent wins; earlier rules break ties deterministically. */
export function proposeNikki(instruction: string, ctx: ProposalContext): NikkiProposal | null {
  const text = instruction.trim();
  if (!text) return null;
  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(text))) {
      const built = rule.build(text, ctx);
      return { engine: "NIIKI", intent: rule.intent, confidence: rule.confidence, ...built };
    }
  }
  return null;
}

/** Engine descriptor — M8 registry groundwork. */
export const NIKKI_ENGINE = {
  id: "NIIKI",
  version: 1,
  deterministic: true,
  usesLLM: false,
  capabilities: [
    "graphic-clips",
    "keyframes",
    "easing",
    "kinetic-typography",
    "lower-thirds",
    "titles",
    "transitions",
    "templates",
  ],
  templates: NIKKI_TEMPLATES.map((t) => ({ id: t.id, version: t.version, category: t.category })),
  propose: proposeNikki,
} as const;
