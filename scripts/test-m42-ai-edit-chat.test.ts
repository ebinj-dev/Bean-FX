/**
 * M42-E/F/G — AI Edit Chat, style engine, intent routing tests (unit).
 * Run: bun test scripts/test-m42-ai-edit-chat.test.ts
 */
import { describe, expect, test } from "bun:test";
import { loadStyleRecipes, matchStyles, combineStyles, styleCapabilities, validateRecipes } from "../src/lib/ai/styles";
import { classifyIntent, playbookInfo } from "../src/lib/ai/riishe";

describe("M42-G style engine", () => {
  const file = loadStyleRecipes();

  test("recipes validate against the REAL editor vocabularies", () => {
    // validateRecipes throws on any non-member transition/param/effect/capability
    expect(() => validateRecipes(file)).not.toThrow();
    expect(file.recipes.length).toBeGreaterThanOrEqual(12);
  });

  test("a recipe referencing a fake effect fails validation (guard against fabricated capabilities)", () => {
    const bad = { version: "t", recipes: [{ ...file.recipes[0], id: "fake-test", transitions: [{ kind: "LIGHT_LEAK" }] }] } as never;
    expect(() => validateRecipes(bad as typeof file)).toThrow(/LIGHT_LEAK/);
  });

  test("prompt matching ranks the right style first", () => {
    const trailer = matchStyles("Turn all these clips into a 45-second cinematic trailer.");
    expect(trailer.length).toBeGreaterThan(0);
    expect(trailer[0].recipe.id).toBe("cinematic-trailer");
    const reel = matchStyles("Make a professional Instagram Reel from these videos.");
    expect(reel[0].recipe.id).toBe("instagram-reel");
    const wedding = matchStyles("Edit this wedding footage into a beautiful emotional highlight film.");
    expect(wedding[0].recipe.id).toBe("wedding-highlight");
    // M42-H regressions (live-demo defects): whole-word matching — "ad" inside
    // "adjustments" must NOT route to product-ad; the acceptance prompt's
    // "cinematic promotional montage" routes to the trailer family.
    expect(matchStyles("apply suitable transitions and cinematic color adjustments, and create a professional ending")[0].recipe.id).not.toBe("product-ad");
    expect(matchStyles("Analyze the selected footage and create a 30-second cinematic promotional montage. Show me the editing plan before applying it.")[0].recipe.id).toBe("cinematic-trailer");
  });

  test("no prompt → no fabricated match", () => {
    expect(matchStyles("hello there").filter((m) => m.score > 3).length).toBe(0);
  });

  test("style combination: one structure style + delivery layers OK; two structures rejected", () => {
    const ok = combineStyles(["cinematic-documentary-does-not-exist"]);
    expect(ok.ok).toBe(false);
    const good = combineStyles(["documentary-interview", "vertical-reframe"]);
    expect(good.ok).toBe(true);
    const bad = combineStyles(["wedding-highlight", "gaming-highlight"]);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/incompatible|structure style/);
  });

  test("capability resolution discloses gaps honestly (never fabricates)", () => {
    const report = styleCapabilities("music-video-montage");
    expect(report).not.toBeNull();
    for (const need of file.recipes.find((r) => r.id === "music-video-montage")!.needs) {
      const inSupported = report!.supported.includes(need);
      const inPartial = report!.partial.some((p) => p.capability === need);
      const inGaps = report!.disclosedGaps.some((g) => g.capability === need);
      expect(inSupported || inPartial || inGaps).toBe(true);
    }
  });
});

describe("M42-F intent routing", () => {
  test("style-compare", () => {
    expect(classifyIntent("Show me three different editing styles for this footage.")).toBe("style-compare");
  });
  test("analysis", () => {
    expect(classifyIntent("Analyze every clip in this project.")).toBe("analysis");
  });
  test("history-op", () => {
    expect(classifyIntent("Undo the last change.")).toBe("history-op");
  });
  test("scoped-revision", () => {
    expect(classifyIntent("Make the intro shorter.")).toBe("scoped-revision");
    expect(classifyIntent("Use warmer colors.")).toBe("scoped-revision");
    expect(classifyIntent("Remove the transition at 00:25.")).toBe("scoped-revision");
  });
  test("build", () => {
    expect(classifyIntent("Turn all these clips into a 45-second cinematic trailer.")).toBe("build");
    expect(classifyIntent("Create a professional product advertisement.")).toBe("build");
    // M42-H regression: analyze + create in ONE prompt is a build (the live
    // demo exposed the analysis branch swallowing it).
    expect(classifyIntent("Analyze the selected footage and create a 30-second cinematic promotional montage. Select the strongest shots, establish a compelling opening, arrange the footage into a coherent progression, apply suitable transitions and cinematic color adjustments, preserve intelligible original audio, and create a professional ending. Show me the editing plan before applying it.")).toBe("build");
    // Pure inspection stays analysis.
    expect(classifyIntent("Analyze every clip in this project.")).toBe("analysis");
    expect(classifyIntent("Analyze the clips and tell me what is in them.")).toBe("analysis");
  });
  test("question fallback", () => {
    expect(classifyIntent("What can you do here?")).toBe("question");
  });
  test("playbook info reflects the registry", () => {
    const info = playbookInfo();
    expect(info.styles).toBe(loadStyleRecipes().recipes.length);
    expect(info.version).toBe(loadStyleRecipes().version);
  });
});

describe("M42-H LLM command normalization (live-demo defect regression)", () => {
  const { normalizePlanCommands } = require("../src/lib/my-ai/planner/schema") as typeof import("../src/lib/my-ai/planner/schema");
  const ctxHint = {
    clips: [{ id: "real-clip-a", startFrame: 0, durationFrames: 360 }, { id: "real-clip-b", startFrame: 120, durationFrames: 240 }],
    tracks: [{ id: "track-v1", kind: "VIDEO" }, { id: "track-a1", kind: "AUDIO" }],
    fps: 30,
  };

  test("LLM-shaped commands map to the canonical union with REAL ids", () => {
    const steps = [{
      id: "s2", operation: "APPLY_COMMANDS",
      args: { commands: [
        { command: "TrimClip", clipId: "d1", startFrame: 30, durationFrames: 90 },
        { command: "AddTransition", clipId: "d2", transitionType: "CROSSFADE", durationFrames: 15 },
        { command: "AddEffect", clipId: "d1", effectType: "COLORGRADE", parameters: { contrast: 1.2, saturation: 1.1, shadows: -0.1 } },
      ] },
    }];
    const { steps: out, warnings } = normalizePlanCommands(steps as never, ctxHint as never);
    const cmds = ((out[0].args as { commands: Array<Record<string, unknown>> }).commands);
    expect(cmds.some((c) => c.type === "TrimClip" && c.clipId === "real-clip-a" && c.newSourceInFrame === 30 && c.newSourceOutFrame === 120)).toBe(true);
    const tr = cmds.find((c) => c.type === "AddTransition");
    expect(tr).toBeDefined();
    expect(tr!.kind).toBe("CROSS_DISSOLVE"); // alias normalized to a real TransitionKind
    expect(tr!.trackId).toBe("track-v1");
    const eff = cmds.filter((c) => c.type === "AddEffect");
    expect(eff.length).toBe(3); // contrast, saturation, shadows — each a REAL EffectType
    expect(eff.every((c) => (c.effect as { type: string }).type !== "COLORGRADE")).toBe(true);
    expect(warnings.length).toBe(0);
  });

  test("unresolvable clip references are dropped WITH warnings — never guessed", () => {
    const steps = [{ id: "s1", operation: "APPLY_COMMANDS", args: { commands: [{ command: "TrimClip", clipId: "d1", startFrame: 0, durationFrames: 30 }, { command: "TrimClip", clipId: "d3", startFrame: 0, durationFrames: 30 }] } }];
    const { steps: out, warnings } = normalizePlanCommands(steps as never, { ...ctxHint, clips: [ctxHint.clips[0]] } as never);
    const cmds = ((out[0].args as { commands: Array<Record<string, unknown>> }).commands);
    expect(cmds.length).toBe(1);
    expect(warnings.some((w) => w.includes("d3"))).toBe(true);
  });

  test("already-canonical commands pass through untouched", () => {
    const steps = [{ id: "s1", operation: "APPLY_COMMANDS", args: { commands: [{ type: "RippleDelete", clipId: "real-clip-a" }] } }];
    const { steps: out, warnings } = normalizePlanCommands(steps as never, ctxHint as never);
    const cmds = ((out[0].args as { commands: Array<Record<string, unknown>> }).commands);
    expect(cmds).toEqual([{ type: "RippleDelete", clipId: "real-clip-a" }]);
    expect(warnings.length).toBe(0);
  });
});
