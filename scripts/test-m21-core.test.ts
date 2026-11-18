/**
 * M21 P1+P3 tests — Core SDK: timebase exactness, canonical format v1,
 * lossless converters, host-adapter contract (reversible ops, CAS,
 * snapshot recovery), API client semantics.
 */
import { describe, test, expect } from "bun:test";
import {
  makeRational, STANDARD_FPS, framesToTicks, ticksToFrames, framesToSamples,
  roundTripFrames, secondsRationalToSamples, framesToSecondsRational, secondsRationalToFrames,
} from "../src/lib/core/timebase";
import { sequenceToCanonical, canonicalToSequence, sequenceRoundTripEqual, stableStringify } from "../src/lib/core/converters";
import { parseCanonicalProject } from "../src/lib/core/project-schema";
import { MockHost, makeOp, inverseOf, checkBaseVersion } from "../src/lib/core/host-adapter";
import { assetRef, parseAssetRef, effectiveRole, roleAtLeast } from "../src/lib/core/types";
import { BeanFxClient, ApiError } from "../src/lib/core/api-client";
import { SequenceSchema, type Sequence } from "../src/lib/editor/model";

// ---- fixtures: a representative M1–M20 sequence (every feature class) ----
function fixtureSequence(): Sequence {
  return {
    id: "seq-1",
    name: "M21 fixture",
    fps: { num: 24000, den: 1001 },
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [
      { id: "t1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false },
      { id: "t2", kind: "AUDIO", name: "A1", visible: true, muted: false, solo: false, locked: false },
    ],
    clips: [
      {
        id: "c1", trackId: "t1", sourceAssetId: "asset-9", sourceInFrame: 0, sourceOutFrame: 240,
        sourceFps: { num: 24000, den: 1001 }, timelineStartFrame: 0, timelineDurationFrames: 240,
        playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 12, fadeOutFrames: 0,
        transform: { x: 0.5, y: 0.5, scale: 1, rotationDeg: 0, opacity: 1 },
        captionText: "hello", captionStyle: { fontSize: 48, color: "#FFFFFF", background: null, position: "BOTTOM" },
        graphicTemplateId: null, graphicStyle: null, label: "intro", missingMedia: false,
        effects: [{ id: "e1", type: "opacity", params: { value: 0.8 } }],
        keyframes: [{ id: "k1", property: "opacity", frame: 10, value: 0.2, easing: "LINEAR" }],
      },
      {
        id: "c2", trackId: "t2", sourceAssetId: "", sourceInFrame: 0, sourceOutFrame: 96,
        sourceFps: { num: 25, den: 1 }, timelineStartFrame: 100, timelineDurationFrames: 96,
        playbackSpeed: 2, volume: 0.5, muted: true, fadeInFrames: 0, fadeOutFrames: 8,
        transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1 },
        captionText: null, captionStyle: null, graphicTemplateId: "tpl-3",
        graphicStyle: { templateId: "tpl-3", templateVersion: 1, primaryText: "Title", secondaryText: "", fontFamily: "nikki-sans" },
        label: null, missingMedia: true, effects: [], keyframes: [],
      },
    ],
    transitions: [
      { id: "tr1", trackId: "t1", kind: "CROSS_DISSOLVE", startFrame: 200, endFrame: 240, durationFrames: 40, clipAId: "c1", clipBId: "c1", params: {} },
    ],
  } as unknown as Sequence;
}

// ---------------- timebase (§8) ----------------
describe("core timebase", () => {
  test("rational frame round-trips are EXACT for every standard rate", () => {
    for (const [name, fps] of Object.entries(STANDARD_FPS)) {
      for (const f of [0, 1, 17, 1000, 99999, 1000000]) {
        expect(roundTripFrames(f, fps)).toBe(f);
      }
    }
  });

  test("23.976 maps to exact Premiere ticks", () => {
    const fps = STANDARD_FPS["23.976"];
    // 1 frame = 1001/24000 s; ticks = 254016000 * 1001/24000 = 10600107? verify:
    // 254016000 * 1001 / 24000 = 254016000/24000 = 10584; 10584*1001 = 10594584
    expect(framesToTicks(1, fps)).toBe(10594584n);
    expect(ticksToFrames(10594584n, fps)).toBe(1);
  });

  test("tick→frame→tick round trip stays put", () => {
    const fps = STANDARD_FPS["29.97"];
    for (let f = 0; f < 500; f += 37) {
      const t = framesToTicks(f, fps);
      expect(ticksToFrames(t, fps)).toBe(f);
    }
  });

  test("audio sample boundaries never shrink (floor start / ceil end)", () => {
    // 0..0.5 s at 48000 → [0, 24000]
    const { startSample, endSample } = secondsRationalToSamples(0n, 1n, 1n, 2n, 48000);
    expect(startSample).toBe(0);
    expect(endSample).toBe(24000);
    // 1/3 s end at 44100: 14700 exactly
    const r2 = secondsRationalToSamples(0n, 1n, 1n, 3n, 44100);
    expect(r2.endSample).toBe(14700);
  });

  test("seconds rational ↔ frames agree with helper", () => {
    const fps = STANDARD_FPS["25"];
    const { num, den } = framesToSecondsRational(50, fps);
    expect(secondsRationalToFrames(num, den, fps)).toBe(50);
    expect(framesToSamples(25, fps, 48000)).toBe(48000);
  });

  test("invalid rationals are rejected", () => {
    expect(() => makeRational(0, 1)).toThrow();
    expect(() => makeRational(30000, 0)).toThrow();
    expect(() => makeRational(1.5, 2)).toThrow();
  });
});

// ---------------- canonical format v1 + converters (§1/§3) ----------------
describe("canonical project format v1", () => {
  test("parse validates formatVersion", () => {
    const bad = parseCanonicalProjectSafe({ formatVersion: "v0", id: "x", name: "n", fps: { num: 24, den: 1 }, width: 640, height: 360, sampleRate: 48000, tracks: [], clips: [], transitions: [] });
    expect(bad.ok).toBe(false);
  });

  test("round trip is LOSSLESS over the full fixture", () => {
    const seq = fixtureSequence();
    expect(sequenceRoundTripEqual(seq)).toBe(true);
    const can = sequenceToCanonical(seq, { baseVersion: 7 }); // same id for lossless round trip
    expect(can.formatVersion).toBe("beanfx-project-v1");
    expect(can.clips[0].asset).toBe("beanfx-asset://asset-9");
    expect(can.clips[1].asset).toBe("");
    expect(can.clips[1].missingMedia).toBe(true);
    expect(can.baseVersion).toBe(7);
    const back = canonicalToSequence(can);
    // Both sides normalized through SequenceSchema (defaults applied) —
    // the contract is no information loss beyond schema normalization.
    expect(stableStringify(SequenceSchema.parse(back))).toBe(stableStringify(SequenceSchema.parse(seq)));
  });

  test("unknown canonical fields are PRESERVED (forward compat)", () => {
    const can = sequenceToCanonical(fixtureSequence());
    const withFuture = { ...can, futureSection: { gpuHints: [1, 2] } };
    const reparsed = parseCanonicalProject(JSON.parse(JSON.stringify(withFuture)));
    expect((reparsed as Record<string, unknown>).futureSection).toEqual({ gpuHints: [1, 2] });
    // and it still converts back to a valid Sequence
    expect(() => canonicalToSequence(reparsed)).not.toThrow();
  });

  test("conversion failure does not mutate input", () => {
    const seq = fixtureSequence();
    const snapshot = JSON.stringify(seq);
    const broken = JSON.parse(JSON.stringify(seq)) as Record<string, unknown>;
    (broken.clips as Array<Record<string, unknown>>)[0].timelineDurationFrames = 0; // invalid
    expect(() => sequenceToCanonical(broken)).toThrow();
    expect(JSON.stringify(seq)).toBe(snapshot);
  });

  test("bad asset refs rejected", () => {
    expect(parseAssetRef("beanfx-asset://abc_1")).toEqual({ id: "abc_1" });
    expect(parseAssetRef("file:///etc/passwd")).toBe(null);
    expect(() => {
      const can = sequenceToCanonical(fixtureSequence());
      const c = JSON.parse(JSON.stringify(can));
      c.clips[0].asset = "sneaky://x";
      parseCanonicalProject(c);
    }).toThrow();
  });
});

function parseCanonicalProjectSafe(raw: unknown) {
  try { return { ok: true, value: parseCanonicalProject(raw) }; } catch (e) { return { ok: false, error: e }; }
}

// ---------------- host adapter contract (§3/§4/§10/§11) ----------------
describe("host adapter contract", () => {
  test("reversible ops: inverse round trip restores state", async () => {
    const host = new MockHost();
    await host.importProject(sequenceToCanonical(fixtureSequence()));
    const st0 = await host.exportProject();
    const ins = makeOp("INSERT_CLIP", { clip: { ...st0.project.clips[0], id: "c-new" } }, null);
    const withInverse = makeOp("INSERT_CLIP", ins.payload, { clipId: "c-new" });
    const applied = await host.applyOp(withInverse);
    expect(applied.ok).toBe(true);
    const st1 = await host.exportProject();
    expect(st1.project.clips.some((c) => c.id === "c-new")).toBe(true);
    expect(st1.project.baseVersion).toBe(st0.project.baseVersion + 1);
    const undo = inverseOf(withInverse);
    expect(undo?.op).toBe("DELETE_CLIP");
    const undone = await host.applyOp(undo!);
    expect(undone.ok).toBe(true);
    const st2 = await host.exportProject();
    expect(st2.project.clips.some((c) => c.id === "c-new")).toBe(false);
  });

  test("failed apply leaves host state unchanged", async () => {
    const host = new MockHost();
    await host.importProject(sequenceToCanonical(fixtureSequence()));
    const before = await host.exportProject();
    host.failNextApply = true;
    const r = await host.applyOp(makeOp("MOVE_CLIP", { clipId: "c1", timelineStartFrame: 999 }, null));
    expect(r.ok).toBe(false);
    const after = await host.exportProject();
    expect(after.ok && before.ok && stableStringify(after.project.clips)).toBe(stableStringify(before.project.clips));
  });

  test("optimistic concurrency: stale baseVersion never applies", () => {
    expect(checkBaseVersion(5, 5)).toEqual({ outcome: "applied" });
    expect(checkBaseVersion(5, 4)).toEqual({ outcome: "conflict", currentBaseVersion: 5 });
    expect(checkBaseVersion(5, undefined)).toEqual({ outcome: "rejected", error: "baseVersion required for host hand-off" });
  });

  test("snapshot recovery restores pre-crash state", async () => {
    const host = new MockHost();
    const imp = await host.importProject(sequenceToCanonical(fixtureSequence()));
    expect(imp.ok).toBe(true);
    const op1 = await host.applyOp(makeOp("SET_CLIP_PROPS", { clipId: "c1", props: { label: "changed" } }, { label: "intro" }));
    const mid = await host.exportProject();
    expect(mid.ok && mid.project.clips[0].label).toBe("changed");
    // Crash simulation: roll back to the state recorded BEFORE op1.
    await host.restoreSnapshot((op1 as { snapshotId: string }).snapshotId);
    const back = await host.exportProject();
    expect(back.ok && back.project.clips[0].label).toBe("intro");
  });

  test("media resolver handles registered and unknown refs", async () => {
    const host = new MockHost();
    host.registerMedia("beanfx-asset://asset-9", "premiere://project/asset-9");
    const hit = await host.resolveMedia("beanfx-asset://asset-9");
    const miss = await host.resolveMedia("beanfx-asset://nope");
    expect(hit.ok).toBe(true);
    expect(miss.ok).toBe(false);
  });
});

// ---------------- roles/scopes (§7) + client (§13) ----------------
describe("roles and api client", () => {
  test("token scopes narrow, never widen", () => {
    expect(effectiveRole(["projects:read"])).toBe("viewer");
    expect(effectiveRole(["projects:read", "projects:write"])).toBe("editor");
    expect(roleAtLeast("editor", "viewer")).toBe(true);
    expect(roleAtLeast("viewer", "editor")).toBe(false);
  });

  test("client throws ApiError with machine-readable code on failure", async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ error: "nope", code: "FORBIDDEN" }), { status: 403 })) as typeof fetch;
    const c = new BeanFxClient({ baseUrl: "http://x", token: "bfx_test", fetchImpl: fetchMock });
    try {
      await c.listProjects();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e instanceof ApiError).toBe(true);
      expect((e as ApiError).status).toBe(403);
      expect((e as ApiError).code).toBe("FORBIDDEN");
    }
  });

  test("client version negotiation honors ±1 window", () => {
    const c = new BeanFxClient({ baseUrl: "http://x", token: "bfx_t" });
    const good = { api: "v1", formatVersions: ["beanfx-project-v1"], features: [], limits: {} };
    const bad = { api: "v1", formatVersions: ["beanfx-project-v2"], features: [], limits: {} };
    expect(() => c.assertCompatible(good as never)).not.toThrow();
    expect(() => c.assertCompatible(bad as never)).toThrow(ApiError);
  });
});
