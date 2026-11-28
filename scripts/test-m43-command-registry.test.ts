/**
 * M43-B — authoritative command registry (pure layer, no DB).
 *
 * Covers: registry completeness (one descriptor per canonical command type),
 * describe lookup, availability gating, preview==apply parity, undo/inverse
 * round-trips, risk/approval policy, deterministic execution.
 * Run: bun test scripts/test-m43-command-registry.test.ts
 */
import { describe, expect, test } from "bun:test";
import { applyCommand, parseCommand, type Command } from "../src/lib/editor/commands";
import type { Clip, Sequence } from "../src/lib/editor/model";
import {
  COMMAND_DESCRIPTORS,
  descriptorById,
  descriptorForType,
  previewCommand,
  registryCommandTypes,
} from "../src/lib/editor/command-registry";

const FPS = { num: 30000, den: 1001 };

/** State equality for round-trips: object key order and clip array order are
 *  NOT semantic (remove+re-add reorders), so compare canonical form. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalSeqJson(seq: Sequence): string {
  return canonicalJson({ ...seq, clips: [...seq.clips].sort((a, b) => (a.id < b.id ? -1 : 1)) });
}

/** Overlap layout for transition semantics: A ends at 300, B starts at 295 —
 *  the executor's professional overlap rule (A tail ↔ B head share the range). */
function overlapSeq(): Sequence {
  const seq = baseSeq([videoClip("c1", 0, 0, 300), videoClip("c2", 295, 295, 595)]);
  return seq;
}

function videoClip(id: string, timelineStartFrame: number, sourceInFrame: number, sourceOutFrame: number, trackId = "v1"): Clip {
  return {
    id,
    trackId,
    sourceAssetId: "asset-1",
    sourceInFrame,
    sourceOutFrame,
    sourceFps: FPS,
    timelineStartFrame,
    timelineDurationFrames: sourceOutFrame - sourceInFrame, // same fps → exact 1:1
    playbackSpeed: 1,
    volume: 1,
    muted: false,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null,
    captionStyle: null,
    graphicTemplateId: null,
    graphicStyle: null,
    label: null,
    missingMedia: false,
    pan: 0,
    groupId: null,
    effects: [],
    keyframes: [],
    // M48-H1–H3 additive defaults — the undo-parity snapshots compare the
    // canonical state, which now carries these fields on every clip.
    audioSourceInFrame: null,
    audioSourceOutFrame: null,
    avLinked: true,
    multicamGroupId: null,
    multicamAngleId: null,
  };
}

function baseSeq(clips: Clip[] = [videoClip("c1", 0, 0, 300), videoClip("c2", 300, 300, 600)]): Sequence {
  return {
    id: "seq-m43",
    name: "M43 registry fixture",
    fps: FPS,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [
      { id: "v1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false, volume: 1 },
      { id: "a1", kind: "AUDIO", name: "A1", visible: true, muted: false, solo: false, locked: false, volume: 1 },
      { id: "cap1", kind: "CAPTION", name: "Captions", visible: true, muted: false, solo: false, locked: false, volume: 1 },
      { id: "gfx1", kind: "GRAPHIC", name: "Graphics", visible: true, muted: false, solo: false, locked: false, volume: 1 },
    ],
    clips,
    // M48-H2/H3 additive sequence fields (canonical state carries them)
    buses: [],
    multicamGroups: [],
    transitions: [],
    markers: [],
  };
}

describe("M43-B registry completeness", () => {
  test("one descriptor per canonical command type, ids unique and canonical", () => {
    const types = registryCommandTypes();
    expect(types.length).toBe(46); // M48-H1–H3 added 10 canonical commands
    expect(COMMAND_DESCRIPTORS.length).toBe(46);
    const ids = new Set(COMMAND_DESCRIPTORS.map((c) => c.id));
    expect(ids.size).toBe(46);
    for (const d of COMMAND_DESCRIPTORS) {
      expect(ids.has(d.id)).toBe(true);
      expect(d.id.startsWith("timeline.")).toBe(true);
      const camel = d.commandType.charAt(0).toLowerCase() + d.commandType.slice(1);
      expect(d.id).toBe(`timeline.${camel}`);
      expect(d.capabilities).toContain("timeline.mutate");
      expect(d.scope).toBe("project");
      expect(d.description.length).toBeGreaterThan(10);
      expect(d.paramsDoc.length).toBeGreaterThan(3);
    }
    // Bidirectional mapping descriptor ↔ union literal.
    for (const t of types) expect(descriptorForType(t)?.commandType).toBe(t);
    for (const d of COMMAND_DESCRIPTORS) expect(types).toContain(d.commandType);
  });

  test("describe lookup + unknown id", () => {
    expect(descriptorById("timeline.trimClip")?.commandType).toBe("TrimClip");
    expect(descriptorById("timeline.addMarker")?.risk).toBe("low");
    expect(descriptorById("nope.notHere")).toBeUndefined();
  });

  test("risk/approval policy: destructive ⇒ requiresApproval", () => {
    for (const d of COMMAND_DESCRIPTORS) {
      if (d.risk === "destructive") expect(d.requiresApproval).toBe(true);
      else expect(d.requiresApproval).toBe(false);
    }
    for (const id of ["timeline.removeTrack", "timeline.removeClip", "timeline.rippleDelete", "timeline.relinkAssets", "timeline.removeTransition", "timeline.removeEffect", "timeline.removeMarker"]) {
      expect(descriptorById(id)?.requiresApproval).toBe(true);
    }
    for (const id of ["timeline.addMarker", "timeline.changeVolume", "timeline.updateTrack"]) {
      expect(descriptorById(id)?.risk).toBe("low");
    }
  });
});

describe("M43-B availability gating", () => {
  test("clip-dependent commands refuse an empty timeline", () => {
    const empty = baseSeq([]);
    for (const id of ["timeline.trimClip", "timeline.moveClip", "timeline.splitClip", "timeline.rippleDelete", "timeline.rollEdit", "timeline.changeVolume"]) {
      const d = descriptorById(id)!;
      expect(d.available(empty).ok).toBe(false);
      expect(d.available(baseSeq()).ok).toBe(true);
    }
  });

  test("AddTransition needs a VIDEO/AUDIO track and ≥2 clips", () => {
    const onlyCaption = baseSeq([]) as Sequence;
    onlyCaption.clips = [];
    expect(descriptorById("timeline.addTransition")!.available(onlyCaption).ok).toBe(false);
    expect(descriptorById("timeline.addTransition")!.available(baseSeq()).ok).toBe(true);
  });

  test("marker/transition removal gated on existence", () => {
    const noMarkers = baseSeq();
    expect(descriptorById("timeline.removeMarker")!.available(noMarkers).ok).toBe(false);
    noMarkers.markers.push({ id: "m1", frame: 10, label: "x" });
    expect(descriptorById("timeline.removeMarker")!.available(noMarkers).ok).toBe(true);
    expect(descriptorById("timeline.removeTransition")!.available(noMarkers).ok).toBe(false);
  });
});

describe("M43-B preview == apply", () => {
  const CASES: Command[] = [
    { type: "AddMarker", marker: { id: "mk1", frame: 120, label: "scene" } },
    { type: "AddTrack", track: { id: "v2", kind: "VIDEO", name: "V2", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
    { type: "TrimClip", clipId: "c1", newSourceInFrame: 30 },
    { type: "MoveClip", clipId: "c1", newTimelineStartFrame: 10 },
    { type: "ChangeVolume", clipId: "c1", volume: 1.5 },
    { type: "UpdateTrack", trackId: "v1", muted: true },
    { type: "SetClipGroup", clipId: "c1", groupId: "g1" },
    { type: "RemoveMarker", markerId: "mk1" },
  ];

  for (const cmd of CASES) {
    test(`${cmd.type}: preview diff matches the real apply`, () => {
      const seq = baseSeq();
      // Marker remove case needs the marker present: seed then preview+apply.
      const seeded = cmd.type === "RemoveMarker" ? applyCommand(seq, { type: "AddMarker", marker: { id: "mk1", frame: 120, label: "scene" } }).sequence : seq;
      const preview = previewCommand(seeded, cmd);
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      const real = applyCommand(seeded, cmd);
      expect(preview.sequenceAfter).toEqual({
        clipCount: real.sequence.clips.length,
        trackCount: real.sequence.tracks.length,
        transitionCount: real.sequence.transitions.length,
        markerCount: real.sequence.markers.length,
        durationFrames: real.sequence.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0),
      });
      const beforeMarkerCount = seeded.markers.length;
      const afterMarkerCount = real.sequence.markers.length;
      expect(preview.diff.markersAdded.length - preview.diff.markersRemoved.length).toBe(afterMarkerCount - beforeMarkerCount);
      // The input sequence is never mutated (pure preview).
      expect(JSON.stringify(seeded)).toBe(JSON.stringify(cmd.type === "RemoveMarker" ? applyCommand(seq, { type: "AddMarker", marker: { id: "mk1", frame: 120, label: "scene" } }).sequence : seq));
    });
  }

  test("invalid command: preview.ok=false AND applyCommand throws (same verdict)", () => {
    const seq = baseSeq();
    const bad = { type: "TrimClip", clipId: "ghost", newSourceInFrame: 5 };
    const preview = previewCommand(seq, bad);
    expect(preview.ok).toBe(false);
    expect(() => applyCommand(seq, bad)).toThrow();
    // Schema-invalid input: preview and parseCommand agree.
    const worse = { type: "Nonsense" };
    expect(previewCommand(seq, worse).ok).toBe(false);
    expect(() => parseCommand(worse)).toThrow();
  });

  test("preview of a transition reports the added transition id (overlap semantics)", () => {
    // Adjacent layout [0,300)+[300,600) has NO overlap → the executor refuses
    // (professional overlap rule: A's tail and B's head share the range).
    const adjacent = baseSeq();
    expect(previewCommand(adjacent, { type: "AddTransition", transitionId: "t1", trackId: "v1", kind: "CROSS_DISSOLVE", startFrame: 295, durationFrames: 5, params: {} }).ok).toBe(false);
    // Overlap layout: A ends at 300, B starts at 295 → [295,300) is valid.
    const good = previewCommand(overlapSeq(), { type: "AddTransition", transitionId: "t1", trackId: "v1", kind: "CROSS_DISSOLVE", startFrame: 295, durationFrames: 5, params: {} });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.diff.transitionsAdded).toEqual(["t1"]);
  });
});

describe("M43-B undo parity (inverse round-trips)", () => {
  const CASES: Array<{ seq: Sequence; cmd: Command }> = [
    { seq: baseSeq(), cmd: { type: "TrimClip", clipId: "c1", newSourceInFrame: 30, newTimelineStartFrame: 30 } },
    { seq: baseSeq(), cmd: { type: "SplitClip", clipId: "c1", atTimelineFrame: 100, newLeftId: "c1", newRightId: "c1r" } },
    { seq: baseSeq(), cmd: { type: "MoveClip", clipId: "c2", newTimelineStartFrame: 310 } },
    { seq: baseSeq(), cmd: { type: "AddMarker", marker: { id: "mk", frame: 50, label: "L" } } },
    { seq: overlapSeq(), cmd: { type: "AddTransition", transitionId: "t2", trackId: "v1", kind: "CROSS_DISSOLVE", startFrame: 295, durationFrames: 5, params: {} } },
    { seq: baseSeq(), cmd: { type: "ChangeVolume", clipId: "c1", volume: 2 } },
    { seq: baseSeq(), cmd: { type: "GroupClips", clipIds: ["c1", "c2"], groupId: "grp" } },
  ];

  for (const { seq: original, cmd } of CASES) {
    test(`${cmd.type}: apply → inverse(reversed) ⇒ original state`, () => {
      const { sequence, inverse } = applyCommand(original, cmd);
      expect(inverse.length).toBeGreaterThan(0);
      let undone = sequence;
      for (let i = inverse.length - 1; i >= 0; i--) undone = applyCommand(undone, inverse[i]).sequence;
      expect(canonicalSeqJson(undone)).toBe(canonicalSeqJson(original));
    });
  }

  test("RippleDelete inverse restores shifted neighbors exactly", () => {
    const original = baseSeq([videoClip("a", 0, 0, 100), videoClip("b", 100, 100, 200), videoClip("c", 200, 200, 300)]);
    const { sequence, inverse } = applyCommand(original, { type: "RippleDelete", clipId: "a" });
    expect(sequence.clips.length).toBe(2);
    expect(sequence.clips.find((c) => c.id === "b")!.timelineStartFrame).toBe(0);
    let undone = sequence;
    for (let i = inverse.length - 1; i >= 0; i--) undone = applyCommand(undone, inverse[i]).sequence;
    expect(canonicalSeqJson(undone)).toBe(canonicalSeqJson(original));
  });
});

describe("M43-B deterministic execution", () => {
  test("same command from the same sequence ⇒ byte-identical result", () => {
    const seq = baseSeq();
    const cmd: Command = { type: "SplitClip", clipId: "c1", atTimelineFrame: 100, newLeftId: "c1", newRightId: "c1r" };
    const a = applyCommand(seq, cmd);
    const b = applyCommand(seq, cmd);
    expect(JSON.stringify(a.sequence)).toBe(JSON.stringify(b.sequence));
    expect(JSON.stringify(a.inverse)).toBe(JSON.stringify(b.inverse));
  });
});
