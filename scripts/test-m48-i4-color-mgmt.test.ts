/** M48-I4/I7 — color-management interpretation + RIISHE color intents. */
import { describe, test, expect } from "bun:test";
import { interpretSourceColor, COLOR_SUPPORT_MATRIX } from "@/lib/color/color-management";
import { proposeNikki, type ProposalContext } from "@/lib/nikki/proposal";
import { applyCommand } from "@/lib/editor/commands";
import { SequenceSchema } from "@/lib/editor/model";

const ctx = (over: Partial<ProposalContext> = {}): ProposalContext => ({
  seqFps: { num: 30, den: 1 }, seqWidth: 1920, seqHeight: 1080,
  newId: (k) => `n-${k}-1`, atFrame: 0, availableFrames: 100,
  selectedClipId: "c1", projectId: "p1", ...over,
});

describe("M48-I4 — honest SDR interpretation", () => {
  test("missing metadata → documented default, flagged", () => {
    const r = interpretSourceColor({ color: { space: null, transfer: null, primaries: null, range: null, pixFmt: null } });
    expect(r.metadataMissing).toBe(true);
    expect(r.supported).toBe(true);
    expect(r.notes.join(" ")).toContain("no color metadata");
  });
  test("Rec.709 limited-range = native support, no flags", () => {
    const r = interpretSourceColor({ color: { space: "bt709", transfer: "bt709", primaries: "bt709", range: "tv", pixFmt: "yuv420p" } });
    expect(r.supported).toBe(true);
    expect(r.metadataMissing).toBe(false);
  });
  test("HDR metadata is flagged NOT implemented (no silent transform, no support claim)", () => {
    const r = interpretSourceColor({ color: { space: "bt2020nc", transfer: "smpte2084", primaries: "bt2020", range: "tv", pixFmt: "yuv420p10le" } });
    expect(r.supported).toBe(false);
    expect(r.notes.join(" ")).toContain("NOT implemented");
  });
  test("full range is supported and noted; unknown primaries flagged", () => {
    const r = interpretSourceColor({ color: { space: "bt709", transfer: "bt709", primaries: "xyz-unknown-9", range: "pc", pixFmt: "yuv420p" } });
    expect(r.notes.join(" ")).toContain("Full-range");
    expect(r.notes.join(" ")).toContain("flagged");
  });
  test("the support matrix never claims HDR/ACES", () => {
    const m = JSON.stringify(COLOR_SUPPORT_MATRIX);
    // every HDR/ACES mention must be an explicit NOT-implemented refusal
    for (const term of ["HDR10", "HLG", "Dolby", "ACES", "ICC"]) {
      const idx = m.indexOf(term);
      expect(idx).toBeGreaterThan(-1);
      expect(m.slice(idx, idx + 60)).toContain("NOT implemented");
    }
  });
});

describe("M48-I7 — RIISHE color intents produce canonical commands", () => {
  test("white balance → SetClipGrade with bounded temp/tint; HDR request → honest refusal", () => {
    const p1 = proposeNikki("the footage is too orange", ctx())!;
    expect(p1.intent).toBe("color-white-balance-correction");
    expect(p1.commands[0].type === "SetClipGrade").toBe(true);
    const g = (p1.commands[0] as { grade: { temperature: number } }).grade;
    expect(g.temperature).toBeLessThan(0);
    // the command actually applies + undoes
    const base = SequenceSchema.parse({
      id: "s", name: "i7", fps: { num: 30, den: 1 }, width: 1920, height: 1080, sampleRate: 48000,
      tracks: [{ id: "v1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false, volume: 1, busId: null }],
      clips: [{ id: "c1", trackId: "v1", sourceAssetId: "a", sourceInFrame: 0, sourceOutFrame: 10, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 10, label: null, effects: [], keyframes: [] }],
      transitions: [], markers: [], buses: [],
    });
    const applied = applyCommand(base, p1.commands[0]);
    expect(applied.sequence.clips[0].grade?.temperature).toBeLessThan(0);
    const undone = applyCommand(applied.sequence, applied.inverse[0]);
    expect(undone.sequence.clips[0].grade).toBeNull();
    // HDR refusal: zero commands, explicit explanation
    const p2 = proposeNikki("convert this timeline to HDR10", ctx())!;
    expect(p2.intent).toBe("color-unsupported-refusal");
    expect(p2.commands).toHaveLength(0);
    expect(p2.explanation).toContain("NOT implemented");
  });
  test("exposure correction is relative to the current grade; no clip → no command", () => {
    const p = proposeNikki("fix exposure, footage is too dark", ctx({ selectedGrade: { bypass: false, exposure: 0.2, temperature: 0, tint: 0, contrast: 1, pivot: 0.5, highlights: 0, shadows: 0, whites: 0, blacks: 0, liftR: 0, liftG: 0, liftB: 0, gammaR: 1, gammaG: 1, gammaB: 1, gainR: 1, gainG: 1, gainB: 1, red: 1, green: 1, blue: 1, saturation: 1, vibrance: 0 } }))!;
    const g = (p.commands[0] as { grade: { exposure: number } }).grade;
    expect(Math.abs(g.exposure - 0.7)).toBeLessThan(1e-9);
    const none = proposeNikki("too dark", ctx({ selectedClipId: null }))!;
    expect(none.commands).toHaveLength(0);
    expect(none.explanation).toContain("Select a clip");
  });
});
