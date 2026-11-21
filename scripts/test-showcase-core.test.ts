/**
 * M31 SHOWCASE STUDIO — core unit suite (fixture-only; no external providers).
 * Proves: SSRF guard, HTML→text extraction (untrusted data), secret redaction,
 * palette quantization, claims lint (no invented claims survive), poster frame
 * choice, ALL 11 composition primitives emit editor-valid motion data, share
 * copy limits/honesty, campaign metadata honesty, additive brief/scene parsing.
 * Run: bun test scripts/test-showcase-core.test.ts
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-showcase-core-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
execSync("bunx prisma db push --skip-generate --accept-data-loss", { env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` }, stdio: ["ignore", "ignore", "ignore"] });

const pu = await import("../src/lib/production/showcase/product-understanding");
const { COMPOSITION_PRIMITIVES, getPrimitive, validateEmission, nikkiStyleFor, PrimitiveContext } = await import("../src/lib/production/showcase/compositions");
const { draftShowcaseConcepts } = await import("../src/lib/production/showcase/concepts");
const { buildShareCopy, PLATFORM_LIMITS } = await import("../src/lib/production/showcase/share-copy");
const { choosePosterFrameSec } = await import("../src/lib/production/showcase/poster");
const { CAMPAIGN_TYPES, CampaignTypeIdSchema, ProductUnderstandingSchema, ShowcaseInputsSchema, DemonstrationPlanSchema } = await import("../src/lib/production/showcase/types");
const { PIPELINE_TEMPLATES, ProductionBriefSchema, StoryboardSchema, getTemplate } = await import("../src/lib/production/engine");

describe("SSRF guard", () => {
  test("rejects non-http schemes, credentials and internal hosts", async () => {
    await expect(pu.assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow(/http/);
    await expect(pu.assertPublicHttpUrl("ftp://example.com")).rejects.toThrow(/http/);
    await expect(pu.assertPublicHttpUrl("https://user:pass@example.com")).rejects.toThrow(/credentials/);
    await expect(pu.assertPublicHttpUrl("http://localhost:3000")).rejects.toThrow(/Internal/);
    await expect(pu.assertPublicHttpUrl("http://127.0.0.1/x")).rejects.toThrow(/Private/);
    await expect(pu.assertPublicHttpUrl("http://10.1.2.3/x")).rejects.toThrow(/Private/);
    await expect(pu.assertPublicHttpUrl("http://192.168.1.4/x")).rejects.toThrow(/Private/);
    await expect(pu.assertPublicHttpUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/Private/);
    await expect(pu.assertPublicHttpUrl("http://nonexistent-host-xyz.invalid")).rejects.toThrow(/resolve/);
  });
});

describe("HTML → text extraction (untrusted data)", () => {
  test("strips scripts/styles and extracts title/meta/headings", () => {
    const html = `<html><head><title>Bean FX | Video Studio</title><meta name="description" content="Edit video with AI."></head>
      <body><script>alert("this must never run or leak")</script><style>.x{color:red}</style>
      <h1>Professional editing</h1><h2>AI captions</h2><p>Bean FX is for creators&nbsp;&amp; teams.</p></body></html>`;
    const out = pu.extractFromHtml(html);
    expect(out.title).toContain("Bean FX");
    expect(out.description).toBe("Edit video with AI.");
    expect(out.headings).toContain("Professional editing");
    expect(out.headings).toContain("AI captions");
    expect(out.text).toContain("creators & teams");
    expect(out.text).not.toContain("alert");
    expect(out.text).not.toContain(".x{color:red}");
  });
});

describe("Secret redaction", () => {
  test("redacts emails, tokens, private URLs and paths — kinds only, values never stored", () => {
    const r = pu.redactSecrets("Contact a@corp.com key sk-abcdefghij1234567890 api http://192.168.1.10:8080/admin path /home/zara/secret.txt");
    expect(r.text).not.toContain("a@corp.com");
    expect(r.text).not.toContain("sk-abcdefghij");
    expect(r.text).not.toContain("192.168.1.10");
    expect(r.text).not.toContain("/home/zara");
    expect(r.text).toContain("[REDACTED:email]");
    expect(r.excludedKinds).toContain("email");
    expect(r.excludedKinds).toContain("private-url");
    expect(r.excludedKinds).toContain("private-path");
    expect(JSON.stringify(r).length).toBeLessThan(1200); // no value leakage into metadata
  });
});

describe("Palette quantization", () => {
  test("returns stable hex colors from raw pixels", () => {
    const px = Buffer.alloc(32 * 32 * 3);
    for (let i = 0; i < px.length; i += 3) { px[i] = 212; px[i + 1] = 160; px[i + 2] = 23; } // #d4a017
    const cols = pu.quantizeColors(px, 3);
    expect(cols[0]).toBe("#D4A017");
  });
});

describe("Claims lint — invented claims never survive", () => {
  test("demotes unbacked numbers and superlatives to unverifiedClaims", () => {
    const data = { capabilities: [{ name: "Real-time collaboration", evidence: "user feature list" }], differentiators: ["10x faster than the competition", "#1 rated editor"], mainBenefit: "Saves 5 hours per week", problem: "", audience: "" };
    const sources = [{ kind: "feature-list" as const, ref: "user feature list", evidence: "Real-time collaboration" }];
    const out = pu.claimsLint(data, sources);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.join(" ")).toContain("10x faster");
    expect(out.join(" ")).toContain("#1");
  });
  test("clean evidence-backed claims pass untouched", () => {
    const out = pu.claimsLint({ capabilities: [], differentiators: ["Real-time collaboration"], mainBenefit: "", problem: "", audience: "" }, [{ kind: "feature-list", ref: "f", evidence: "Real-time collaboration" }]);
    expect(out.length).toBe(0);
  });
});

describe("Feature list parsing", () => {
  test("lines become evidence-backed capabilities", () => {
    const caps = pu.featureListToCapabilities("Timeline editing\nAI captions\n\n- 4K export");
    expect(caps.length).toBe(3);
    expect(caps[0]).toEqual({ name: "Timeline editing", evidence: "user-provided feature list" });
    expect(caps[2].name).toBe("4K export");
  });
});

describe("Poster frame choice (deterministic)", () => {
  test("prefers the midpoint of the closing scene (transition-clear)", () => {
    const timings = [
      { sceneKey: "scene-1", startSec: 0, endSec: 6 },
      { sceneKey: "scene-2", startSec: 6, endSec: 12 },
      { sceneKey: "scene-5-end-card", startSec: 24, endSec: 30 },
    ];
    const c = choosePosterFrameSec(timings, 30);
    expect(c.sceneKey).toBe("scene-5-end-card");
    expect(c.sec).toBe(27);
  });
  test("falls back to 80% of runtime when no closing scene is marked", () => {
    const c = choosePosterFrameSec([{ sceneKey: "scene-1", startSec: 0, endSec: 10 }], 10);
    expect(c.sec).toBe(8);
    expect(c.sceneKey).toBeNull();
  });
});

describe("Composition primitives — editor-valid motion emission", () => {
  const fps = 30;
  const baseCtx: PrimitiveContext = { fps, durationFrames: 90, overlayText: "Bean FX", secondaryText: "Create anything" };

  test("all 11 primitives are registered and emit valid data", () => {
    expect(COMPOSITION_PRIMITIVES.length).toBe(11);
    for (const p of COMPOSITION_PRIMITIVES) {
      const em = p.emit(baseCtx);
      const v = validateEmission(em, baseCtx);
      expect(v.ok).toBe(true);
      // keyframes pre-sorted by frame, clip-relative, within duration
      for (let i = 1; i < em.keyframes.length; i++) expect(em.keyframes[i].frame).toBeGreaterThanOrEqual(em.keyframes[i - 1].frame);
      for (const k of em.keyframes) expect(k.frame).toBeLessThan(baseCtx.durationFrames);
    }
  });

  test("stat-reveal REFUSES unverified stats (evidence required)", () => {
    const refused = getPrimitive("stat-reveal")!.emit(baseCtx);
    expect(refused.graphic).toBeNull();
    expect(refused.note).toContain("REFUSED");
    const accepted = getPrimitive("stat-reveal")!.emit({ ...baseCtx, verifiedStat: { value: "1.2M creators", evidence: "user-stated: verified claim" } });
    expect(accepted.graphic).not.toBeNull();
  });

  test("graphics map onto REAL NIKKI registry templates", () => {
    const title = getPrimitive("cinematic-title")!.emit(baseCtx);
    expect(title.graphic).not.toBeNull();
    const g = nikkiStyleFor(title.graphic!);
    expect(g).not.toBeNull();
    expect(g!.style.primaryText).toBe("Bean FX");
    expect(g!.style.textAnim.mode).toBe("wordReveal");
  });

  test("short clips are rejected honestly (min duration guard)", () => {
    const short: PrimitiveContext = { fps, durationFrames: 5, overlayText: "x" };
    const em = getPrimitive("end-card")!.emit(short);
    expect(validateEmission(em, short).ok).toBe(false);
  });
});

describe("Share copy — platform limits + honesty", () => {
  const product = ProductUnderstandingSchema.parse({
    generatedAt: new Date().toISOString(), basis: "deterministic", inputsUsed: ["description"],
    identity: { name: "Bean FX", tagline: "" }, purpose: "Edit video with AI assistance.", audience: "", problem: "", mainBenefit: "Faster edits with full control.",
    capabilities: [{ name: "Timeline editing", evidence: "user feature list" }, { name: "AI captions", evidence: "user feature list" }],
    differentiators: [], workflow: [], brand: { colors: [], typographyNote: "", logoMediaId: null, notes: "" },
    visualReferences: [], sources: [{ kind: "feature-list", ref: "f", evidence: "Timeline editing" }], unverifiedClaims: [], exclusions: [],
  });
  test("all 6 platforms produced, limits verified honestly", () => {
    const copy = buildShareCopy({ product, ctaText: "Try Bean FX today", durationSec: 30, aspectRatio: "16:9", platforms: ["youtube", "instagram", "tiktok", "linkedin", "x", "whatsapp"], websiteUrl: "https://beanfx.example" });
    expect(copy.items.length).toBe(6);
    for (const item of copy.items) {
      expect([...item.text].length).toBeLessThanOrEqual(PLATFORM_LIMITS[item.platform as keyof typeof PLATFORM_LIMITS]);
      expect(item.withinLimits).toBe(true);
    }
    // CTA and name from approved sources; capability claims traceable
    expect(copy.items[0].text).toContain("Bean FX");
    expect(copy.items[0].text).toContain("Try Bean FX today");
    expect(copy.items.find((i) => i.platform === "youtube")!.text).toContain("Timeline editing");
  });
});

describe("Campaign types — honest capability requirements", () => {
  test("8 types exist; cinematic-trailer honestly requires video generation", () => {
    expect(CAMPAIGN_TYPES.length).toBe(8);
    expect(CampaignTypeIdSchema.options.length).toBe(8);
    const trailer = CAMPAIGN_TYPES.find((c) => c.id === "cinematic-trailer")!;
    expect(trailer.providerNeeds).toContain("video");
    expect(trailer.note).toContain("CONFIGURATION REQUIRED");
    const launch = CAMPAIGN_TYPES.find((c) => c.id === "product-launch")!;
    expect(launch.providerNeeds.length).toBe(0);
  });
});

describe("Showcase template + additive schemas", () => {
  test("showcase-studio template is active with the 9-step stage chain", () => {
    const t = getTemplate("showcase-studio");
    expect(t).not.toBeNull();
    expect(t!.active).toBe(true);
    expect(t!.stages.map((s) => s.key)).toEqual(["INTAKE", "PRODUCT_UNDERSTANDING", "BRIEF", "CONCEPT", "SCRIPT", "STORYBOARD", "ASSET_PLANNING", "ASSET_GENERATION", "EDIT_PLANNING", "TIMELINE_ASSEMBLY", "ROUGH_CUT", "REVIEW", "FINAL_RENDER", "QUALITY_ASSURANCE", "DELIVERY"]);
    // dependency integrity: every dependsOn exists and runs BEFORE the stage
    const order = t!.stages.map((s) => s.key);
    for (const s of t!.stages) for (const d of s.dependsOn) expect(order.indexOf(d)).toBeLessThan(order.indexOf(s.key));
  });
  test("legacy briefs parse unchanged (additive defaults)", () => {
    const b = ProductionBriefSchema.parse({ title: "Old", targetDurationSec: 30 });
    expect(b.campaignType).toBe("product-launch");
    expect(b.posterEnabled).toBe(true);
    expect(b.showcaseInputs).toBeNull();
  });
  test("legacy storyboards parse unchanged; showcase fields default", () => {
    const sb = StoryboardSchema.parse({ scenes: [{ sceneKey: "s1", sceneNumber: 1, durationSec: 3, requiredAssetKind: "user_media" }] });
    expect(sb.scenes[0].compositionPrimitive).toBeNull();
    expect(sb.scenes[0].demonstration).toBeNull();
    expect(sb.scenes[0].textOverlay).toBe("");
  });
  test("showcase inputs schema validates; demonstration plan requires owned media at API layer", () => {
    const inputs = ShowcaseInputsSchema.parse({ productName: "X", screenshotMediaIds: ["a"], demoVideoMediaIds: [] });
    expect(inputs.screenshotMediaIds).toEqual(["a"]);
    expect(() => ShowcaseInputsSchema.parse({ rogue: true })).toThrow();
    const d = DemonstrationPlanSchema.parse({ sourceMediaId: "m1", illustrative: true, maskNotes: ["mask email overlay"] });
    expect(d.illustrative).toBe(true);
  });
});

describe("Showcase concepts — genuinely distinct + honest costs", () => {
  const brief = ProductionBriefSchema.parse({ title: "Bean FX launch", subject: "Bean FX", targetDurationSec: 30, tonePreset: "premium" });
  const product = { identity: { name: "Bean FX", tagline: "" }, purpose: "AI video editing", mainBenefit: "Faster edits", capabilities: [{ name: "Timeline editing", evidence: "user" }], problem: "" };
  test("3 distinct directions with all required fields", () => {
    const opts = draftShowcaseConcepts(brief, product);
    expect(opts.length).toBe(3);
    const ids = new Set(opts.map((o) => o.id));
    expect(ids.size).toBe(3);
    for (const o of opts) {
      expect(o.title).toBeTruthy();
      expect(o.centralIdea).toBeTruthy();
      expect(o.openingHook).toBeTruthy();
      expect(o.productReveal).toBeTruthy();
      expect(o.featureHighlights.length).toBeGreaterThan(0);
      expect(o.motionDirection).toBeTruthy();
      expect(o.musicDirection).toBeTruthy();
      expect(o.narrationDirection).toBeTruthy();
      expect(o.closingCta).toBeTruthy();
      expect(["LOW", "MEDIUM", "HIGH"]).toContain(o.complexity);
      expect(o.requiredCapabilities.length).toBeGreaterThan(0);
      expect(o.costNote).toBeTruthy();
    }
    // silent-music honesty propagates
    const silent = draftShowcaseConcepts({ ...brief, musicPreference: "none" }, product);
    expect(silent[0].musicDirection).toContain("Silence (explicit user preference)");
  });
});
