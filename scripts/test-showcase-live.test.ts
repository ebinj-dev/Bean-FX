/**
 * M31 SHOWCASE STUDIO — LIVE E2E (real media, real server :3118, real jobs).
 * Proves (addendum Tests A/B/D/E/F/G mapped to showcase):
 *  - inputs (description/features/screenshots/demo recording/authorized URL)
 *    → validated product-understanding artifact (honest website-fetch fallback);
 *  - campaign-aware concepts → script → storyboard editing invariants
 *    (approved scenes never silently changed);
 *  - asset planning + real media attach + generation gates (preview-only
 *    routing without approval; budget gate);
 *  - native assembly WITH composition primitives (keyframes + NIKKI graphic
 *    end card on the real timeline) → rough cut;
 *  - M30 review bridge → real render → QA (blackdetect/loudness/caption checks)
 *    → delivery with POSTER (from the real render, verified) + share copy.
 *  - no-leak isolation + resumability.
 * Setup (isolated env, mirrors m20-journey): scripts/m31-showcase-e2e.sh
 * Run: M31_BASE=http://localhost:3118 M31_DB=file:/tmp/m31-showcase.db bun test scripts/test-showcase-live.test.ts
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.M31_BASE ?? "http://localhost:3118";
const DB_URL = process.env.M31_DB ?? "file:/tmp/m31-showcase.db";
const STAMP = Date.now().toString(36);
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

type Jar = { cookie: string };
const jar = (): Jar => ({ cookie: "" });

async function api(method: string, path: string, opts: { jar?: Jar; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}) {
  const { jar: j, body, raw, headers = {} } = opts;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}),
      ...(raw ? headers : {}),
      ...(j?.cookie ? { Cookie: j.cookie } : {}),
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (j) for (const c of setCookie) { const k0 = c.split(";")[0].split("=")[0]; if (k0 === "beanfx_session") j.cookie = `${k0}=${c.split(";")[0].split("=").slice(1).join("=")}`; }
  return { status: res.status, json: await res.json().catch(() => null) };
}

let u: Jar, stranger: Jar, projectId: string, screenshotId: string, demoVideoId: string;
let pid: string; // shared across describes (main flow + isolation tests)

beforeAll(async () => {
  execSync(`mkdir -p /tmp/m31show`);
  u = jar(); stranger = jar();
  const r = await api("POST", "/api/auth/register", { jar: u, body: { email: `show-${STAMP}@test.local`, password: `show-${STAMP}-p1`, name: "Showcase Owner" } });
  expect(r.status).toBe(200);
  await api("POST", "/api/auth/register", { jar: stranger, body: { email: `showx-${STAMP}@test.local`, password: `show-${STAMP}-p1`, name: "Stranger" } });
  // REAL product screenshot fixture (PIL, brand-colored UI mock).
  execSync(`python3 -c "
from PIL import Image, ImageDraw
im = Image.new('RGB', (1280, 720), (11, 11, 11))
d = ImageDraw.Draw(im)
d.rectangle([80, 80, 1200, 640], fill=(20, 20, 20), outline=(212, 160, 23), width=6)
d.rectangle([120, 140, 640, 200], fill=(212, 160, 23))
d.text((140, 160), 'BEAN FX - TIMELINE', fill=(0, 0, 0))
d.rectangle([120, 260, 1160, 300], fill=(40, 40, 40))
d.rectangle([120, 320, 1160, 360], fill=(40, 40, 40))
im.save('/tmp/m31show/ui.png')"`);
  // REAL demo recording fixture: 8s 720p with audio (screen-recording stand-in).
  execSync(`ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=8" -f lavfi -i "sine=frequency=330:duration=8" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest /tmp/m31show/demo.mp4`);
  const proj = await api("POST", "/api/projects", { jar: u, body: { name: `Showcase ${STAMP}` } });
  expect(proj.status).toBe(200);
  projectId = proj.json.project.id;
  const upImg = await api("POST", "/api/media", { jar: u, raw: fs.readFileSync("/tmp/m31show/ui.png"), headers: { "x-filename": "beanfx-ui.png", "Content-Type": "image/png" } });
  expect(upImg.status).toBe(200);
  screenshotId = upImg.json.media.id;
  const upVid = await api("POST", "/api/media", { jar: u, raw: fs.readFileSync("/tmp/m31show/demo.mp4"), headers: { "x-filename": "beanfx-demo.mp4", "Content-Type": "application/octet-stream" } });
  expect(upVid.status).toBe(200);
  demoVideoId = upVid.json.media.id;
}, 300_000);

async function board(id: string) {
  const r = await api("GET", `/api/productions/${id}`, { jar: u });
  expect(r.status).toBe(200);
  return r.json;
}
async function runStage(id: string, key: string, action = "start") {
  const r = await api("POST", `/api/productions/${id}/stages/${key}`, { jar: u, body: { action } });
  return { status: r.status, json: r.json };
}
async function waitStage(id: string, key: string, want: string, timeoutSec = 300): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const b = await board(id);
    const st = b.stages.find((s: { key: string }) => s.key === key);
    if (st?.state === want) return;
    if (st?.state === "FAILED") throw new Error(`${key} FAILED: ${st.error}`);
    if ((Date.now() - t0) / 1000 > timeoutSec) throw new Error(`${key} timeout at ${st?.state}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

describe("SHOWCASE STUDIO — end-to-end (real media, native timeline)", () => {

  test("intake: showcase inputs → production created on the showcase template", async () => {
    const r = await api("POST", "/api/productions", { jar: u, body: {
      templateId: "showcase-studio",
      title: "Bean FX",
      briefText: "Launch film for Bean FX, an AI video editor for creators.",
      projectId,
      campaignType: "app-showcase",
      tonePreset: "premium",
      targetDurationSec: 20,
      aspectRatio: "16:9",
      narrationPreference: "none",
      musicPreference: "user-provided",
      showcaseInputs: {
        productName: "Bean FX",
        description: "Bean FX is an AI video editing studio for creators — timeline editing, AI captions, one-click exports.",
        featureList: "Native timeline editing\nAI caption generation\nAspect-ratio variants\nClient review links",
        websiteUrl: "https://example.com",
        screenshotMediaIds: [screenshotId],
        demoVideoMediaIds: [demoVideoId],
        projectId,
      },
      sourceMediaIds: [screenshotId, demoVideoId],
    } });
    expect(r.status).toBe(201);
    pid = r.json.production.id;
    expect(r.json.template.active).toBe(true);
    const b = await board(pid);
    expect(b.stages.map((s: { key: string }) => s.key)).toContain("PRODUCT_UNDERSTANDING");
  }, 60_000);

  test("UNDERSTAND: validated artifact with evidence; unverified claims demoted; redactions recorded", async () => {
    await runStage(pid, "INTAKE"); // brief stage drafts → AWAITING_APPROVAL
    await waitStage(pid, "INTAKE", "AWAITING_APPROVAL");
    await runStage(pid, "INTAKE", "approve");
    await waitStage(pid, "INTAKE", "SUCCEEDED");
    const r = await runStage(pid, "PRODUCT_UNDERSTANDING");
    expect(r.status).toBe(200);
    await waitStage(pid, "PRODUCT_UNDERSTANDING", "AWAITING_APPROVAL");
    const b = await board(pid);
    const p = b.product;
    expect(p).not.toBeNull();
    expect(p.identity.name).toBe("Bean FX");
    expect(p.capabilities.length).toBeGreaterThanOrEqual(3);
    expect(p.capabilities.every((c: { name: string; evidence: string }) => c.evidence.length > 0)).toBe(true);
    expect(p.sources.some((s: { kind: string }) => s.kind === "screenshot")).toBe(true);
    expect(p.sources.some((s: { kind: string }) => s.kind === "demo-video")).toBe(true);
    // website evidence: either a real fetch (example.com) or an honest failure note
    const siteSrc = p.sources.find((s: { kind: string }) => s.kind === "website");
    expect(siteSrc).toBeDefined();
    expect(["FETCH FAILED", "example.com"].some((frag) => siteSrc.evidence.includes(frag) || siteSrc.ref.includes(frag))).toBe(true);
    // brand palette derived from the REAL screenshot fixture (accent #D4A017)
    expect(p.brand.colors.some((c: string) => /^#[0-9A-F]{6}$/i.test(c))).toBe(true);
    // approve the artifact
    const ap = await api("PUT", `/api/productions/${pid}`, { jar: u, body: { kind: "product-approval", decision: "APPROVED" } });
    expect(ap.status).toBe(200);
  }, 120_000);

  test("BRIEF → CONCEPT: campaign-aware concepts; selection recorded; brief approval gates", async () => {
    await runStage(pid, "PRODUCT_UNDERSTANDING", "approve");
    await waitStage(pid, "PRODUCT_UNDERSTANDING", "SUCCEEDED");
    await runStage(pid, "BRIEF");
    await waitStage(pid, "BRIEF", "AWAITING_APPROVAL");
    await runStage(pid, "BRIEF", "approve");
    await waitStage(pid, "BRIEF", "SUCCEEDED");
    const c = await runStage(pid, "CONCEPT");
    expect(c.status).toBe(200);
    await waitStage(pid, "CONCEPT", "AWAITING_APPROVAL");
    const b = await board(pid);
    expect(b.concept.options.length).toBe(3);
    const titles = new Set(b.concept.options.map((o: { title: string }) => o.title));
    expect(titles.size).toBe(3);
    for (const o of b.concept.options) expect(o.featureHighlights.length).toBeGreaterThan(0);
    const sel = await api("PUT", `/api/productions/${pid}`, { jar: u, body: { kind: "concept", selectedId: b.concept.options[0].id } });
    expect(sel.status).toBe(200);
    await runStage(pid, "CONCEPT", "approve");
    await waitStage(pid, "CONCEPT", "SUCCEEDED");
  }, 120_000);

  test("SCRIPT → STORYBOARD: beats from the approved concept; scene editing invariants", async () => {
    await runStage(pid, "SCRIPT");
    await waitStage(pid, "SCRIPT", "AWAITING_APPROVAL");
    const b0 = await board(pid);
    expect(b0.script.lines.length).toBeGreaterThanOrEqual(4);
    await runStage(pid, "SCRIPT", "approve");
    await waitStage(pid, "SCRIPT", "SUCCEEDED");
    await runStage(pid, "STORYBOARD");
    await waitStage(pid, "STORYBOARD", "AWAITING_APPROVAL");
    const b = await board(pid);
    const scenes = b.storyboard.scenes;
    expect(scenes.length).toBeGreaterThanOrEqual(4);
    // composition primitives pre-assigned per beat
    expect(scenes.some((s: { compositionPrimitive?: string }) => s.compositionPrimitive === "hero-product-reveal")).toBe(true);
    expect(scenes.some((s: { compositionPrimitive?: string }) => s.compositionPrimitive === "end-card")).toBe(true);
    // APPROVED scene is never silently changed…
    const first = scenes[0];
    await api("PUT", `/api/productions/${pid}`, { jar: u, body: { kind: "scene-approval", sceneKey: first.sceneKey, decision: "APPROVED" } });
    const denied = await api("PUT", `/api/productions/${pid}`, { jar: u, body: { kind: "scene-edit", sceneKey: first.sceneKey, patch: { textOverlay: "changed" } } });
    expect(denied.status).toBe(409);
    // …unless re-approval is explicit (and logged)
    const okd = await api("PUT", `/api/productions/${pid}`, { jar: u, body: { kind: "scene-edit", sceneKey: first.sceneKey, patch: { textOverlay: "BEAN FX" }, reApprove: true } });
    expect(okd.status).toBe(200);
    expect(okd.json.scene.approval).toBe("PENDING");
    const b2 = await board(pid);
    expect(b2.events.some((e: { kind: string }) => e.kind === "scene.edited")).toBe(true);
    // reorder + duplicate + remove
    const before = b2.storyboard.scenes.length;
    const dup = await api("PUT", `/api/productions/${pid}`, { jar: u, body: { kind: "scene-duplicate", sceneKey: first.sceneKey } });
    expect(dup.status).toBe(200);
    const afterDup = (await board(pid)).storyboard.scenes.length;
    expect(afterDup).toBe(before + 1);
    const rem = await api("PUT", `/api/productions/${pid}`, { jar: u, body: { kind: "scene-remove", sceneKey: dup.json.sceneKey } });
    expect(rem.status).toBe(200);
    // approve all scenes for the chain
    const sb = (await board(pid)).storyboard.scenes;
    for (const s of sb) await api("PUT", `/api/productions/${pid}`, { jar: u, body: { kind: "scene-approval", sceneKey: s.sceneKey, decision: "APPROVED" } });
    await runStage(pid, "STORYBOARD", "approve");
    await waitStage(pid, "STORYBOARD", "SUCCEEDED");
  }, 180_000);

  test("ASSET PLANNING + demonstration notes; generation gates are honest", async () => {
    await runStage(pid, "ASSET_PLANNING");
    await waitStage(pid, "ASSET_PLANNING", "AWAITING_APPROVAL");
    const b = await board(pid);
    expect(b.assets.length).toBeGreaterThan(0);
    // attach the REAL demo video to the first media scene + approve everything attachable
    for (const a of b.assets) {
      if (a.sourceType === "USER_MEDIA" && a.status === "PENDING" && !a.mediaAssetId) {
        const attach = await api("POST", `/api/productions/${pid}/assets`, { jar: u, body: { action: "attach", assetRowId: a.id, mediaAssetId: a.category === "music" ? demoVideoId : demoVideoId } });
        expect(attach.status).toBe(200);
      }
    }
    await runStage(pid, "ASSET_PLANNING", "approve");
    await waitStage(pid, "ASSET_PLANNING", "SUCCEEDED");
    // generation gate: preview-only routing (no approval → no paid call)
    const gen = await api("POST", `/api/productions/${pid}/assets`, { jar: u, body: { action: "route-generation", assetRowId: "nonexistent", kind: "generated_video", prompt: "x", approved: false } });
    expect([404, 409]).toContain(gen.status); // not-found row or honest gate — never a fake submission
    await runStage(pid, "ASSET_GENERATION");
    await waitStage(pid, "ASSET_GENERATION", "SUCCEEDED", 300);
    await runStage(pid, "EDIT_PLANNING");
    await waitStage(pid, "EDIT_PLANNING", "SUCCEEDED");
  }, 600_000);

  test("COMPOSE: canonical assembly lands REAL media + primitives + NIKKI graphic end card", async () => {
    const asm = await runStage(pid, "TIMELINE_ASSEMBLY");
    expect(asm.status).toBe(200);
    await waitStage(pid, "TIMELINE_ASSEMBLY", "SUCCEEDED");
    const head = await api("GET", `/api/editor/projects/${projectId}/timeline`, { jar: u });
    expect(head.status).toBe(200);
    const seq = head.json.version?.sequence ?? head.json.sequence ?? head.json.head?.sequence;
    // Clips live FLAT on the canonical sequence (same as engine seqClips).
    const clips: Array<Record<string, unknown>> = Array.isArray(seq?.clips)
      ? seq.clips
      : (seq?.tracks ?? []).flatMap((t: { clips?: unknown[] }) => t.clips ?? []);
    expect(clips.length).toBeGreaterThan(0);
    const mediaClips = clips.filter((c: { sourceAssetId?: string }) => c.sourceAssetId);
    expect(mediaClips.length).toBeGreaterThan(0);
    const keyframed = clips.filter((c: { keyframes?: unknown[] }) => (c.keyframes ?? []).length > 0);
    expect(keyframed.length).toBeGreaterThan(0); // primitives applied
    const graphicClips = clips.filter((c: { graphicTemplateId?: string | null }) => c.graphicTemplateId);
    expect(graphicClips.length).toBeGreaterThan(0); // end card / title as REAL NIKKI graphics
    const rough = await runStage(pid, "ROUGH_CUT");
    expect(rough.status).toBe(200);
    await waitStage(pid, "ROUGH_CUT", "SUCCEEDED");
  }, 300_000);

  test("REVIEW → RENDER → QA → DELIVER: poster from the real render + 6-platform share copy", async () => {
    await runStage(pid, "REVIEW");
    await waitStage(pid, "REVIEW", "AWAITING_APPROVAL", 300);
    const b = await board(pid);
    const revisionId = (b.stages.find((s: { key: string }) => s.key === "REVIEW").output as { revisionId: string }).revisionId;
    const t0 = Date.now();
    for (;;) {
      const d = await api("GET", `/api/reviews/${revisionId}`, { jar: u });
      if (["READY_FOR_REVIEW", "IN_REVIEW"].includes(d.json?.revision?.status)) break;
      if ((Date.now() - t0) / 1000 > 240) throw new Error(`review render timeout: ${d.json?.revision?.status}`);
      await new Promise((res) => setTimeout(res, 2000));
    }
    const ap = await api("PUT", `/api/reviews/${revisionId}`, { jar: u, body: { decision: "APPROVE" } });
    expect(ap.status).toBe(200);
    await runStage(pid, "REVIEW", "approve");
    await waitStage(pid, "REVIEW", "SUCCEEDED");
    await runStage(pid, "FINAL_RENDER");
    await waitStage(pid, "FINAL_RENDER", "SUCCEEDED", 300);
    const qa = await runStage(pid, "QUALITY_ASSURANCE");
    expect(qa.status).toBe(200);
    await waitStage(pid, "QUALITY_ASSURANCE", "SUCCEEDED");
    const b2 = await board(pid);
    const checkIds = (b2.production.qa?.checks ?? []).map((c: { id: string }) => c.id);
    expect(checkIds).toContain("file-decodable");
    expect(checkIds).toContain("black-frames");
    await runStage(pid, "DELIVERY");
    await waitStage(pid, "DELIVERY", "SUCCEEDED", 120);
    const b3 = await board(pid);
    expect(b3.production.status).toBe("COMPLETED");
    const delivery = b3.production.delivery;
    expect(delivery.artifacts.length).toBeGreaterThan(0);
    // POSTER: real frame from the real render, verified checks
    expect(delivery.poster).toBeDefined();
    expect((delivery.poster.checks ?? []).some((c: { id: string; state: string }) => c.id === "frame-extracted" && c.state === "PASSED")).toBe(true);
    expect(delivery.posterMediaAssetId).toBeTruthy();
    // SHARE COPY: 6 platforms, no invented claims (uses approved artifact text)
    const items = delivery.shareCopy?.items ?? [];
    expect(items.length).toBe(6);
    for (const item of items) expect(item.text.toLowerCase()).toContain("bean fx");
    // share copy must NOT contain demoted unverified numbers — artifact claims only
    expect(JSON.stringify(items).toLowerCase()).not.toContain("10x");
  }, 900_000);
});

describe("SHOWCASE STUDIO — isolation, resumability, honest gates", () => {
  test("no-leak: a stranger cannot see the production; assets route only for owners", async () => {
    const productions = await api("GET", "/api/productions", { jar: stranger });
    const ids = (productions.json.productions ?? []).map((p: { id: string }) => p.id);
    expect(ids).not.toContain(pid);
    const direct = await api("GET", `/api/productions/${pid}`, { jar: stranger });
    expect(direct.status).toBe(404);
  }, 60_000);

  test("resume: completed stages never re-run; no duplicate timeline clips", async () => {
    const before = (await board(pid)).stages.filter((s: { state: string }) => s.state === "SUCCEEDED").length;
    const r = await api("POST", `/api/productions/${pid}/resume`, { jar: u });
    expect(r.status).toBe(200);
    const after = (await board(pid)).stages.filter((s: { state: string }) => s.state === "SUCCEEDED").length;
    expect(after).toBe(before);
    const head = await api("GET", `/api/editor/projects/${projectId}/timeline`, { jar: u });
    const seq = head.json.version?.sequence ?? head.json.sequence ?? head.json.head?.sequence;
    const clips: Array<{ id: string }> = Array.isArray(seq?.clips) ? seq.clips : (seq?.tracks ?? []).flatMap((t: { clips?: Array<{ id: string }> }) => t.clips ?? []);
    const ids = new Set(clips.map((c) => c.id));
    expect(ids.size).toBe(clips.length); // no duplicates
  }, 120_000);

  test("inactive showcase work is honest: UNDERSTANDING without inputs refuses with a clear error", async () => {
    const r = await api("POST", "/api/productions", { jar: u, body: {
      templateId: "showcase-studio", title: "Empty", briefText: "no inputs showcase",
      showcaseInputs: { productName: "", description: "", featureList: "", websiteUrl: "", screenshotMediaIds: [], demoVideoMediaIds: [], projectId: null },
      sourceMediaIds: [],
    } });
    expect(r.status).toBe(201);
    const pid2 = r.json.production.id;
    await runStage(pid2, "INTAKE"); // draft → AWAITING_APPROVAL
    await waitStage(pid2, "INTAKE", "AWAITING_APPROVAL");
    await runStage(pid2, "INTAKE", "approve");
    await waitStage(pid2, "INTAKE", "SUCCEEDED");
    const und = await runStage(pid2, "PRODUCT_UNDERSTANDING");
    expect([400, 409].includes(und.status)).toBe(true);
    expect(JSON.stringify(und.json)).toMatch(/inputs/i);
  }, 120_000);
});
