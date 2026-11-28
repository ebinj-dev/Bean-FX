/**
 * M48-I2/I3 — canonical color commands: SetClipGrade / SetClipLut / AddLut /
 * RemoveLut round-trips with inverses, undo/redo parity, refusal cases and
 * legacy persistence compat. Run: bun test scripts/test-m48-i2-color-commands.test.ts
 */
import { describe, expect, test } from "bun:test";
import { applyCommand, parseCommand, EditorError } from "@/lib/editor/commands";
import { SequenceSchema, type Sequence } from "@/lib/editor/model";

function seq(): Sequence {
  const base = {
    id: "s1",
    name: "I2",
    fps: { num: 25, den: 1 },
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [
      { id: "v1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false, volume: 1, busId: null },
    ],
    clips: [
      {
        id: "c1",
        trackId: "v1",
        sourceAssetId: "a1",
        sourceInFrame: 0,
        sourceOutFrame: 100,
        sourceFps: { num: 25, den: 1 },
        timelineStartFrame: 0,
        timelineDurationFrames: 100,
        label: "clip",
        effects: [],
        keyframes: [],
      },
    ],
    transitions: [],
    markers: [],
    buses: [],
  };
  return SequenceSchema.parse(base);
}

const GRADE_A = {
  bypass: false, exposure: 0.5, temperature: 0.2, tint: 0, contrast: 1.25, pivot: 0.5,
  highlights: 0.1, shadows: -0.2, whites: 0.15, blacks: -0.1,
  liftR: 0, liftG: 0.02, liftB: -0.01, gammaR: 1, gammaG: 1.05, gammaB: 1,
  gainR: 1.1, gainG: 1, gainB: 0.95, red: 1.02, green: 1, blue: 0.98,
  saturation: 1.2, vibrance: 0.3,
};

describe("M48-I2 — SetClipGrade", () => {
  test("set → inverse restores null; set twice → inverse chain exact", () => {
    const s0 = seq();
    const r1 = applyCommand(s0, { type: "SetClipGrade", clipId: "c1", grade: GRADE_A });
    expect(r1.sequence.clips[0].grade).toMatchObject({ exposure: 0.5, contrast: 1.25 });
    expect(r1.inverse[0]).toEqual({ type: "SetClipGrade", clipId: "c1", grade: null });

    const r2 = applyCommand(r1.sequence, { type: "SetClipGrade", clipId: "c1", grade: { ...GRADE_A, exposure: 1 } });
    expect(r2.sequence.clips[0].grade?.exposure).toBe(1);
    expect(r2.inverse[0].type === "SetClipGrade" && r2.inverse[0].grade).toMatchObject({ exposure: 0.5 });

    // full undo chain: exposure 1 → A → null
    const undone = applyCommand(applyCommand(r2.sequence, r2.inverse[0]).sequence, r1.inverse[0]);
    expect(undone.sequence.clips[0].grade).toBeNull();
  });

  test("bypass toggle round-trips and keeps the parameters", () => {
    const s1 = applyCommand(seq(), { type: "SetClipGrade", clipId: "c1", grade: GRADE_A }).sequence;
    const s2 = applyCommand(s1, { type: "SetClipGrade", clipId: "c1", grade: { ...GRADE_A, bypass: true } }).sequence;
    expect(s2.clips[0].grade?.bypass).toBe(true);
    expect(s2.clips[0].grade?.exposure).toBe(0.5); // parameters preserved
    const back = applyCommand(s2, { type: "SetClipGrade", clipId: "c1", grade: GRADE_A }).sequence;
    expect(back.clips[0].grade?.bypass).toBe(false);
  });

  test("out-of-bounds parameters are refused (validation, not clamping)", () => {
    for (const bad of [{ exposure: 9 }, { contrast: 0.1 }, { saturation: -1 }, { vibrance: 5 }, { pivot: 2 }]) {
      expect(() => parseCommand({ type: "SetClipGrade", clipId: "c1", grade: { ...GRADE_A, ...bad } })).toThrow();
    }
    // unknown/extra fields refused (strict)
    expect(() => parseCommand({ type: "SetClipGrade", clipId: "c1", grade: { ...GRADE_A, evil: 1 } })).toThrow();
    // missing clip
    try {
      applyCommand(seq(), { type: "SetClipGrade", clipId: "nope", grade: GRADE_A });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e instanceof EditorError && e.code === "CLIP_NOT_FOUND").toBe(true);
    }
  });
});

describe("M48-I3 — LUT commands", () => {
  const LUT = { id: "lut-abc", name: "Warm look", size: 33, bytes: 1024, createdAt: "2026-11-28T00:00:00Z", sourceName: "warm.cube" };

  test("AddLut → SetClipLut → RemoveLut refusal while referenced → remove assignment → RemoveLut ok", () => {
    let s = seq();
    const a = applyCommand(s, { type: "AddLut", lut: LUT });
    expect(a.sequence.luts).toHaveLength(1);
    s = a.sequence;
    const b = applyCommand(s, { type: "SetClipLut", clipId: "c1", lutId: "lut-abc" });
    expect(b.sequence.clips[0].lutId).toBe("lut-abc");
    s = b.sequence;
    // RemoveLut refused while referenced
    let refused = "";
    try {
      applyCommand(s, { type: "RemoveLut", lutId: "lut-abc" });
    } catch (e) {
      refused = e instanceof EditorError ? e.code : String(e);
    }
    expect(refused).toBe("INVALID_COMMAND");
    // unassign, then remove
    const c = applyCommand(s, { type: "SetClipLut", clipId: "c1", lutId: null });
    expect(c.sequence.clips[0].lutId).toBeNull();
    const d = applyCommand(c.sequence, { type: "RemoveLut", lutId: "lut-abc" });
    expect(d.sequence.luts).toHaveLength(0);
    // undo everything (last op first): AddLut → assignment restored → assignment cleared → LUT gone.
    // After the FIRST two undos the LUT + assignment are back; after all four we are at the original state.
    let u = d.sequence;
    u = applyCommand(u, d.inverse[0]).sequence;
    u = applyCommand(u, c.inverse[0]).sequence;
    expect(u.luts).toHaveLength(1);
    expect(u.clips[0].lutId).toBe("lut-abc");
    u = applyCommand(u, b.inverse[0]).sequence;
    u = applyCommand(u, a.inverse[0]).sequence;
    expect(u.luts).toHaveLength(0);
    expect(u.clips[0].lutId).toBeNull();
  });

  test("SetClipLut refuses unknown lut ids; duplicate AddLut refused", () => {
    try {
      applyCommand(seq(), { type: "SetClipLut", clipId: "c1", lutId: "lut-nope" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e instanceof EditorError && e.code === "INVALID_COMMAND").toBe(true);
    }
    const s1 = applyCommand(seq(), { type: "AddLut", lut: LUT }).sequence;
    try {
      applyCommand(s1, { type: "AddLut", lut: { ...LUT, name: "dup" } });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e instanceof EditorError && e.code === "INVALID_COMMAND").toBe(true);
    }
  });
});

describe("M48-I — legacy persistence compat", () => {
  test("sequences without grade/lutId/luts parse with neutral defaults", () => {
    const legacy = {
      ...seq(),
      clips: [{ ...seq().clips[0] }],
    };
    // strip the new fields to simulate a pre-I save
    const c = legacy.clips[0] as Record<string, unknown>;
    delete c.grade;
    delete c.lutId;
    const legacySeq = legacy as Record<string, unknown>;
    delete legacySeq.luts;
    const parsed = SequenceSchema.parse(legacySeq);
    expect(parsed.clips[0].grade).toBeNull();
    expect(parsed.clips[0].lutId).toBeNull();
    expect(parsed.luts).toEqual([]);
  });
});
