/**
 * NIIKI — versioned motion graphics template registry (M6 §10).
 *
 * Templates are structured, versioned assets: id + version + a fully typed
 * NikkiGraphicStyle seed. Applying a template creates a graphic clip whose
 * style is fully EDITABLE afterwards (every field). Upgrades are explicit:
 * the clip records the version it was seeded from and is never silently
 * migrated.
 *
 * Licensing: templates reference only the bundled Noto fonts (SIL OFL 1.1,
 * redistribution permitted — see public/fonts/NOTICE.txt). No third-party
 * assets beyond those.
 */
import { NikkiGraphicStyleSchema, type NikkiGraphicStyle, type NikkiTemplate } from "./types";

const S = (over: Partial<NikkiGraphicStyle>): NikkiGraphicStyle => NikkiGraphicStyleSchema.parse(over);

export const NIKKI_TEMPLATES: NikkiTemplate[] = [
  {
    id: "lower-third-bar",
    version: 1,
    label: "Lower third · name bar",
    category: "lower-third",
    description: "Name + designation on an accent-edged bar, slide-in from the left, auto fade-out.",
    style: S({
      templateId: "lower-third-bar",
      primaryText: "NAME SURNAME",
      secondaryText: "Designation · Organisation",
      shape: { kind: "bar", color: "#101010CC", accentColor: "#D4A017", thicknessPct: 7, widthPct: 40, accentPct: 3 },
      anchor: "LOWER_LEFT",
      offsetX: 6,
      offsetY: 9,
      align: "LEFT",
      textAnim: { mode: "slide", durationFrames: 16, staggerFrames: 3, direction: "right", distancePct: 10, exitMode: "fade", exitDurationFrames: 12, exitDistancePct: 6, trackingFrom: 0, trackingTo: 0 },
    }),
  },
  {
    id: "lower-third-card",
    version: 1,
    label: "Lower third · presenter card",
    category: "lower-third",
    description: "Two-line presenter identification on a translucent card.",
    style: S({
      templateId: "lower-third-card",
      primaryText: "Presenter",
      secondaryText: "Role · Location",
      shape: { kind: "card", color: "#0B0B0AB8", accentColor: "#D4A017", thicknessPct: 10, widthPct: 34, accentPct: 0 },
      anchor: "LOWER_LEFT",
      offsetX: 5,
      offsetY: 12,
      align: "LEFT",
      textAnim: { mode: "fade", durationFrames: 12, staggerFrames: 3, direction: "up", distancePct: 4, exitMode: "fade", exitDurationFrames: 10, exitDistancePct: 4, trackingFrom: 0, trackingTo: 0 },
    }),
  },
  {
    id: "title-scale-in",
    version: 1,
    label: "Title · scale in",
    category: "title",
    description: "Centre title that scales in and holds; classic intro.",
    style: S({
      templateId: "title-scale-in",
      primaryText: "TITLE TEXT",
      secondaryText: "",
      shape: { kind: "none", color: "#00000000", accentColor: "#D4A017", thicknessPct: 6, widthPct: 40, accentPct: 0 },
      anchor: "CENTER",
      offsetX: 0,
      offsetY: 0,
      align: "CENTER",
      primarySizePct: 7.5,
      textAnim: { mode: "scale", durationFrames: 20, staggerFrames: 3, direction: "up", distancePct: 4, exitMode: "fade", exitDurationFrames: 14, exitDistancePct: 4, trackingFrom: 0, trackingTo: 0 },
    }),
  },
  {
    id: "title-intro-slide",
    version: 1,
    label: "Intro title · slide up",
    category: "title",
    description: "Intro title sliding up with a tracking-in emphasis and exit fade.",
    style: S({
      templateId: "title-intro-slide",
      primaryText: "BEAN FX",
      secondaryText: "A production",
      shape: { kind: "underline", color: "#00000000", accentColor: "#D4A017", thicknessPct: 0.8, widthPct: 30, accentPct: 0 },
      anchor: "CENTER",
      offsetX: 0,
      offsetY: -2,
      align: "CENTER",
      primarySizePct: 8,
      textAnim: { mode: "slide", durationFrames: 18, staggerFrames: 3, direction: "up", distancePct: 12, exitMode: "fade", exitDurationFrames: 16, exitDistancePct: 4, trackingFrom: 8, trackingTo: 0 },
    }),
  },
  {
    id: "caption-word-reveal",
    version: 1,
    label: "Caption · word by word",
    category: "caption",
    description: "Kinetic caption revealing word by word (word-by-word rise + fade).",
    style: S({
      templateId: "caption-word-reveal",
      primaryText: "These words appear one by one",
      secondaryText: "",
      shape: { kind: "none", color: "#00000000", accentColor: "#D4A017", thicknessPct: 6, widthPct: 40, accentPct: 0 },
      anchor: "LOWER_CENTER",
      offsetX: 0,
      offsetY: 10,
      align: "CENTER",
      primarySizePct: 4.6,
      textAnim: { mode: "wordReveal", durationFrames: 10, staggerFrames: 5, direction: "up", distancePct: 3, exitMode: "fade", exitDurationFrames: 10, exitDistancePct: 0, trackingFrom: 0, trackingTo: 0 },
      highlights: [{ word: "one", color: "#D4A017", scalePct: 120 }],
    }),
  },
  {
    id: "caption-typewriter",
    version: 1,
    label: "Caption · typewriter",
    category: "caption",
    description: "Character-by-character typewriter reveal (Unicode grapheme-safe).",
    style: S({
      templateId: "caption-typewriter",
      primaryText: "தமிழ் உரை ஒன்று தோன்றுகிறது",
      secondaryText: "",
      fontFamily: "nikki-tamil",
      shape: { kind: "none", color: "#00000000", accentColor: "#D4A017", thicknessPct: 6, widthPct: 40, accentPct: 0 },
      anchor: "LOWER_CENTER",
      offsetX: 0,
      offsetY: 10,
      align: "CENTER",
      primarySizePct: 4.4,
      textAnim: { mode: "typewriter", durationFrames: 2, staggerFrames: 2, direction: "up", distancePct: 0, exitMode: "fade", exitDurationFrames: 12, exitDistancePct: 0, trackingFrom: 0, trackingTo: 0 },
    }),
  },
  {
    id: "news-banner",
    version: 1,
    label: "News banner",
    category: "banner",
    description: "Breaking-news style top banner with headline and ticker line.",
    style: S({
      templateId: "news-banner",
      primaryText: "BREAKING NEWS",
      secondaryText: "Live updates from the field",
      shape: { kind: "bar", color: "#7A1010E6", accentColor: "#FFFFFF", thicknessPct: 9, widthPct: 72, accentPct: 2 },
      anchor: "UPPER_LEFT",
      offsetX: 3,
      offsetY: 5,
      align: "LEFT",
      primarySizePct: 4.8,
      textAnim: { mode: "slide", durationFrames: 14, staggerFrames: 3, direction: "left", distancePct: 14, exitMode: "slide", exitDurationFrames: 12, exitDistancePct: 14, trackingFrom: 0, trackingTo: 0 },
    }),
  },
  {
    id: "section-heading",
    version: 1,
    label: "Section heading",
    category: "callout",
    description: "Underlined section heading for chapter intros.",
    style: S({
      templateId: "section-heading",
      primaryText: "SECTION ONE",
      secondaryText: "",
      shape: { kind: "underline", color: "#00000000", accentColor: "#D4A017", thicknessPct: 0.7, widthPct: 26, accentPct: 0 },
      anchor: "LOWER_CENTER",
      offsetX: 0,
      offsetY: 16,
      align: "CENTER",
      primarySizePct: 5,
      textAnim: { mode: "fade", durationFrames: 14, staggerFrames: 3, direction: "up", distancePct: 4, exitMode: "fade", exitDurationFrames: 10, exitDistancePct: 0, trackingFrom: 4, trackingTo: 0 },
    }),
  },
  {
    id: "logo-pulse",
    version: 1,
    label: "Logo · scale pulse",
    category: "logo",
    description: "Logo/brand mark that scales in with an emphasis pulse.",
    style: S({
      templateId: "logo-pulse",
      primaryText: "LOGO",
      secondaryText: "",
      shape: { kind: "card", color: "#FFFFFF14", accentColor: "#D4A017", thicknessPct: 16, widthPct: 22, accentPct: 0 },
      anchor: "UPPER_RIGHT",
      offsetX: -4,
      offsetY: 6,
      align: "CENTER",
      primarySizePct: 3.6,
      textAnim: { mode: "scale", durationFrames: 14, staggerFrames: 3, direction: "up", distancePct: 0, exitMode: "fade", exitDurationFrames: 12, exitDistancePct: 0, trackingFrom: 0, trackingTo: 0 },
    }),
  },
];

export function templateById(id: string): NikkiTemplate | null {
  return NIKKI_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** Templates by category for the panel grid (stable order). */
export function templatesByCategory(): Map<string, NikkiTemplate[]> {
  const map = new Map<string, NikkiTemplate[]>();
  for (const t of NIKKI_TEMPLATES) {
    const list = map.get(t.category) ?? [];
    list.push(t);
    map.set(t.category, list);
  }
  return map;
}
