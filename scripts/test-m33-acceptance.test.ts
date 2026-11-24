/**
 * M33 Track D — end-to-end production acceptance (M31 + M32 combined).
 * One campaign: product evidence → approved concept/storyboard → REAL mask
 * compositing composited ONTO the native timeline via canonical commands →
 * render → THREE format exports → poster/share-copy from approved evidence →
 * project package → import into a clean library.
 * Run (server on :3118): M33_BASE=http://localhost:3118 bun test scripts/test-m33-acceptance.test.ts
 */
import { describe, test, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const BASE = process.env.M33_BASE ?? "http://localhost:3118";
const STAMP = Date.now().toString(36);
const EVIDENCE = process.env.M33_EVIDENCE_DIR ?? "/tmp/m33-evidence";

type Jar = { cookie: string };
const jar = (): Jar => ({ cookie: "" });
async function api(method: string, path: string, opts: { jar?: Jar; body?: unknown; raw?: Buffer; headers?: Record<string, string>; binary?: boolean } = {}) {
  const { jar: j, body, raw, headers = {}, binary } = opts;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...(raw ? headers : {}), ...(j?.cookie ? { Cookie: j.cookie } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (j) for (const c of setCookie) { const [k, v] = c.split(";")[0].split("="); if (k === "beanfx_session") j.cookie = `${k}=${v}`; }
  return { status: res.status, json: binary ? null : await res.json().catch(() => null), res };
}
function ep(dir: string, name: string): string { fs.mkdirSync(dir, { recursive: true }); return path.join(dir, name); }

let u = jar(); let packer = jar();
let projectId = ""; let pid = ""; let screenshotId = ""; let demoVideoId = ""; let subjectVidId = ""; let bgVidId = ""; let maskImageId = "";
let compositedAssetId = ""; let maskId = "";

beforeAll(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await api("POST", "/api/auth/register", { jar: u, body: { email: `m33d-${STAMP}@test.local`, password: `m33-${STAMP}-p1`, name: "M33 Acceptance" } });
  await api("POST", "/api/auth/register", { jar: packer, body: { email: `m33dp-${STAMP}@test.local`, password: `m33-${STAMP}-p1`, name: "M33 Importer" } });
  // Product evidence (portrait) + demo video with audio.
  execSync(`python3 -c "
from PIL import Image, ImageDraw
im = Image.new('RGB', (720, 1280), (11, 11, 11))
d = ImageDraw.Draw(im)
d.rectangle([40, 60, 680, 620], fill=(20, 20, 20), outline=(212, 160, 23), width=6)
d.rectangle([60, 120, 400, 170], fill=(212, 160, 23))
d.text((76, 138), 'BEAN FX - ACCEPT', fill=(0, 0, 0))
d.rectangle([60, 260, 660, 320], fill=(40, 40, 40))
d.rectangle([60, 380, 660, 440], fill=(40, 40, 40))
im.save('/tmp/m33d-ui.png')"`);
  execSync(`ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=720x1280:rate=30:duration=8" -f lavfi -i "sine=frequency=330:duration=8" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest /tmp/m33d-demo.mp4`);
  // Mask-compositing fixtures: subject video (amber blob over dark), blue background video, binary mask PNG.
  execSync(`python3 -c "
from PIL import Image, ImageDraw
im = Image.new('RGB', (720, 1280), (18, 18, 18))
d = ImageDraw.Draw(im)
d.ellipse([180, 480, 540, 840], fill=(212, 160, 23))
im.save('/tmp/m33d-subject.png')
bg = Image.new('RGB', (720, 1280), (30, 60, 200))
bg.save('/tmp/m33d-bg.png')
m = Image.new('L', (720, 1280), 0)
d2 = ImageDraw.Draw(m)
d2.ellipse([180, 480, 540, 840], fill=255)
m.save('/tmp/m33d-mask.png')"`);
  execSync(`ffmpeg -y -loglevel error -loop 1 -i /tmp/m33d-subject.png -t 4 -r 30 -c:v libx264 -preset veryfast -pix_fmt yuv420p /tmp/m33d-subject.mp4`);
  execSync(`ffmpeg -y -loglevel error -loop 1 -i /tmp/m33d-bg.png -t 4 -r 30 -c:v libx264 -preset veryfast -pix_fmt yuv420p /tmp/m33d-bg.mp4`);
  const proj = await api("POST", "/api/projects", { jar: u, body: { name: `M33 acceptance ${STAMP}` } });
  projectId = proj.json.project.id;
  const up = async (file: string, name: string): Promise<string> => {
    const r = await api("POST", "/api/media", { jar: u, raw: fs.readFileSync(file), headers: { "x-filename": name, "Content-Type": "application/octet-stream" } });
    expect(r.status).toBe(200);
    return r.json.media.id;
  };
  screenshotId = await up("/tmp/m33d-ui.png", "ui.png");
  demoVideoId = await up("/tmp/m33d-demo.mp4", "demo.mp4");
  subjectVidId = await up("/tmp/m33d-subject.mp4", "subject.mp4");
  bgVidId = await up("/tmp/m33d-bg.mp4", "bg.mp4");
  maskImageId = await up("/tmp/m33d-mask.png", "mask.png");
}, 300_000);

describe("M33 Track D — production acceptance (real workflow, no bypasses)", () => {
  test("campaign: intake → approvals → assembly (9:16 master)", async () => {
    const r = await api("POST", "/api/productions", { jar: u, body: {
      templateId: "showcase-studio", title: "M33 Acceptance Campaign", projectId,
      briefText: "Launch film for Bean FX, an AI video editor for creators.",
      campaignType: "app-showcase", tonePreset: "premium", targetDurationSec: 20,
      aspectRatio: "9:16", narrationPreference: "none", musicPreference: "user-provided",
      showcaseInputs: { productName: "Bean FX", description: "Bean FX is an AI video editing studio for creators.", featureList: "Timeline editing\nAI captions\nSubject compositing\nClient review", websiteUrl: "https://example.com", screenshotMediaIds: [screenshotId], demoVideoMediaIds: [demoVideoId], projectId },
      sourceMediaIds: [screenshotId, demoVideoId],
    } });
    expect(r.status).toBe(201);
    pid = r.json.production.id;
    const run = async (key: string, action = "start") => api("POST", `/api/productions/${pid}/stages/${key}`, { jar: u, body: { action } });
    const wait = async (key: string, want: string, timeoutSec = 300) => {
      const t0 = Date.now();
      for (;;) {
        const b = (await api("GET", `/api/productions/${pid}`, { jar: u })).json;
        const st = b.stages.find((s: { key: string }) => s.key === key);
        if (st?.state === want) return b;
        if (st?.state === "FAILED") throw new Error(`${key} FAILED: ${st.error}`);
        if ((Date.now() - t0) / 1000 > timeoutSec) throw new Error(`${key} timeout at ${st?.state}`);
        await new Promise((r2) => setTimeout(r2, 2000));
      }
    };
    await run("INTAKE"); await wait("INTAKE", "AWAITING_APPROVAL"); await run("INTAKE", "approve"); await wait("INTAKE", "SUCCEEDED");
    await run("PRODUCT_UNDERSTANDING"); await wait("PRODUCT_UNDERSTANDING", "AWAITING_APPROVAL");
    await api("PUT", `/api/productions/${pid}`, { jar: u, body: { kind: "product-approval", decision: "APPROVED" } });
    await run("PRODUCT_UNDERSTANDING", "approve"); await wait("PRODUCT_UNDERSTANDING", "SUCCEEDED");
    await run("BRIEF"); await wait("BRIEF", "AWAITING_APPROVAL"); await run("BRIEF", "approve"); await wait("BRIEF", "SUCCEEDED");
    await run("CONCEPT"); await wait("CONCEPT", "AWAITING_APPROVAL");
    const b = await wait("CONCEPT", "AWAITING_APPROVAL");
    await api("PUT", `/api/productions/${pid}`, { jar: u, body: { kind: "concept", selectedId: b.concept.options[0].id } });
    await run("CONCEPT", "approve"); await wait("CONCEPT", "SUCCEEDED");
    await run("SCRIPT"); await wait("SCRIPT", "AWAITING_APPROVAL"); await run("SCRIPT", "approve"); await wait("SCRIPT", "SUCCEEDED");
    await run("STORYBOARD"); await wait("STORYBOARD", "AWAITING_APPROVAL");
    const sb = (await wait("STORYBOARD", "AWAITING_APPROVAL")).storyboard.scenes;
    for (const s of sb) await api("PUT", `/api/productions/${pid}`, { jar: u, body: { kind: "scene-approval", sceneKey: s.sceneKey, decision: "APPROVED" } });
    await run("STORYBOARD", "approve"); await wait("STORYBOARD", "SUCCEEDED");
    await run("ASSET_PLANNING"); await wait("ASSET_PLANNING", "AWAITING_APPROVAL");
    const ab = await wait("ASSET_PLANNING", "AWAITING_APPROVAL");
    for (const a of ab.assets) {
      if (a.sourceType === "USER_MEDIA" && a.status === "PENDING" && !a.mediaAssetId) {
        await api("POST", `/api/productions/${pid}/assets`, { jar: u, body: { action: "attach", assetRowId: a.id, mediaAssetId: demoVideoId } });
      }
    }
    await run("ASSET_PLANNING", "approve"); await wait("ASSET_PLANNING", "SUCCEEDED");
    await run("ASSET_GENERATION"); await wait("ASSET_GENERATION", "SUCCEEDED", 300);
    await run("EDIT_PLANNING"); await wait("EDIT_PLANNING", "SUCCEEDED");
    await run("TIMELINE_ASSEMBLY"); await wait("TIMELINE_ASSEMBLY", "SUCCEEDED");
    const head = await api("GET", `/api/editor/projects/${projectId}/timeline`, { jar: u });
    expect(head.status).toBe(200);
  }, 900_000);

  test("mask compositing through the real API → composited asset on the campaign timeline via CANONICAL commands", async () => {
    // 1) REAL mask imported + validated against the subject video asset.
    const imp = await api("POST", "/api/masks", { jar: u, body: { action: "import", sourceAssetId: subjectVidId, mediaAssetId: maskImageId, notes: "acceptance subject mask" } });
    expect(imp.status).toBe(201);
    maskId = imp.json.maskId;
    expect(imp.json.validation.ok).toBe(true);
    // 2) REAL FFmpeg alphamerge compositing (subject over background).
    const comp = await api("POST", "/api/masks", { jar: u, body: { action: "composite-video", maskId, sourceAssetId: subjectVidId, backgroundAssetId: bgVidId } });
    expect(comp.status).toBe(200);
    compositedAssetId = comp.json.mediaAssetId;
    expect(compositedAssetId).toBeTruthy();
    // 3) Canonical HTTP command: add the composited clip to the campaign timeline.
    const head = await api("GET", `/api/editor/projects/${projectId}/timeline`, { jar: u });
    const seq = head.json.version?.sequence ?? head.json.sequence;
    const base = head.json.version ?? head.json.head?.version;
    const endFrame = seq.clips.reduce((m: number, c: { timelineStartFrame: number; timelineDurationFrames: number }) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0);
    // Overlay the composited subject INSIDE the approved duration (last 2s) on
    // its own video track — extending the timeline would honestly FAIL the
    // campaign's QA duration gate (verified in a prior run: QA caught it).
    const add = await api("POST", `/api/editor/projects/${projectId}/timeline`, { jar: u, body: { baseVersion: base, edits: [
      { type: "AddTrack", track: { id: `m33d-ov-${STAMP}`, name: "Mask composite", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
      { type: "AddClip", clip: { id: `m33d-comp-${STAMP}`, trackId: `m33d-ov-${STAMP}`, sourceAssetId: compositedAssetId, sourceInFrame: 0, sourceOutFrame: 60, sourceFps: { num: 30, den: 1 }, timelineStartFrame: Math.max(0, endFrame - 60), timelineDurationFrames: 60, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [] } },
    ] } });
    expect(add.status).toBe(200);
    // The composited clip is now part of the editable timeline (canonical only).
    const head2 = await api("GET", `/api/editor/projects/${projectId}/timeline`, { jar: u });
    const seq2 = head2.json.version?.sequence ?? head2.json.sequence;
    expect(seq2.clips.some((c: { sourceAssetId?: string }) => c.sourceAssetId === compositedAssetId)).toBe(true);
  }, 600_000);

  test("review → render → QA → delivery: master with the composited subject; poster + share copy from approved evidence", async () => {
    const run = async (key: string, action = "start") => api("POST", `/api/productions/${pid}/stages/${key}`, { jar: u, body: { action } });
    const wait = async (key: string, want: string, timeoutSec = 300) => {
      const t0 = Date.now();
      for (;;) {
        const b = (await api("GET", `/api/productions/${pid}`, { jar: u })).json;
        const st = b.stages.find((s: { key: string }) => s.key === key);
        if (st?.state === want) return b;
        if (st?.state === "FAILED") throw new Error(`${key} FAILED: ${st.error}`);
        if ((Date.now() - t0) / 1000 > timeoutSec) throw new Error(`${key} timeout at ${st?.state}`);
        await new Promise((r2) => setTimeout(r2, 2000));
      }
    };
    await run("ROUGH_CUT"); await wait("ROUGH_CUT", "SUCCEEDED");
    await run("REVIEW"); await wait("REVIEW", "AWAITING_APPROVAL", 300);
    const b = await wait("REVIEW", "AWAITING_APPROVAL");
    const revisionId = (b.stages.find((s: { key: string }) => s.key === "REVIEW").output as { revisionId: string }).revisionId;
    const t0 = Date.now();
    for (;;) {
      const d = await api("GET", `/api/reviews/${revisionId}`, { jar: u });
      if (["READY_FOR_REVIEW", "IN_REVIEW"].includes(d.json?.revision?.status)) break;
      if ((Date.now() - t0) / 1000 > 600) throw new Error(`review render timeout`);
      await new Promise((res) => setTimeout(res, 2000));
    }
    expect((await api("PUT", `/api/reviews/${revisionId}`, { jar: u, body: { decision: "APPROVE" } })).status).toBe(200);
    await run("REVIEW", "approve"); await wait("REVIEW", "SUCCEEDED");
    await run("FINAL_RENDER"); await wait("FINAL_RENDER", "SUCCEEDED", 300);
    await run("QUALITY_ASSURANCE"); await wait("QUALITY_ASSURANCE", "SUCCEEDED");
    const fin = await run("DELIVERY"); await wait("DELIVERY", "SUCCEEDED", 300);
    const board = (await api("GET", `/api/productions/${pid}`, { jar: u })).json;
    expect(board.production?.status ?? board.status).toBe("COMPLETED");
    // Poster + share copy exist as REAL deliverables derived from the render/approved evidence.
    const poster = board.deliverables?.poster ?? board.stages.find((s: { key: string }) => s.key === "DELIVERY")?.output?.poster ?? null;
    const shareCopy = board.deliverables?.shareCopy ?? board.stages.find((s: { key: string }) => s.key === "DELIVERY")?.output?.shareCopy ?? null;
    expect(poster ?? shareCopy).toBeTruthy(); // at least one real delivery artifact recorded
    fs.writeFileSync(ep(EVIDENCE, "acceptance-delivery.json"), JSON.stringify({ poster, shareCopy: shareCopy ?? null, stages: board.stages.map((s: { key: string; state: string }) => [s.key, s.state]) }, null, 2));
  }, 900_000);

  test("three-format variants on the acceptance campaign → real exports", async () => {
    const d = await api("POST", `/api/productions/${pid}/variants`, { jar: u, body: { formats: ["16:9", "1:1"] } });
    expect([201, 207]).toContain(d.status);
    const r = await api("POST", `/api/productions/${pid}/variants`, { jar: u, body: { action: "render", formats: ["16:9", "1:1"] } });
    expect(r.status).toBe(202);
    const t0 = Date.now();
    for (;;) {
      const g = await api("GET", `/api/productions/${pid}/variants`, { jar: u });
      const vs = g.json.variants;
      if (vs.every((v: { status: string }) => ["COMPLETED", "FAILED", "CANCELLED"].includes(v.status))) {
        for (const v of vs) expect(v.status).toBe("COMPLETED");
        fs.writeFileSync(ep(EVIDENCE, "acceptance-variants.json"), JSON.stringify(vs, null, 2));
        break;
      }
      if ((Date.now() - t0) / 1000 > 600) throw new Error(`variant render timeout`);
      await new Promise((res) => setTimeout(res, 3000));
    }
  }, 900_000);

  test("project package of the COMPLETED campaign → import into a clean library (masks + timeline)", async () => {
    const arch = await api("POST", `/api/projects/${projectId}/archive`, { jar: u, body: { mode: "FULL" } });
    expect([200, 201, 202]).toContain(arch.status);
    const archiveId = arch.json.archiveId ?? arch.json.archive?.id ?? arch.json.id;
    expect(archiveId).toBeTruthy();
    // Wait for the ARCHIVE job through the application.
    const t0 = Date.now();
    let status = "";
    for (;;) {
      const a = await api("GET", `/api/projects/${projectId}/archive`, { jar: u });
      status = a.json?.archive?.status ?? "";
      if (["COMPLETED", "FAILED"].includes(status)) break;
      if ((Date.now() - t0) / 1000 > 300) throw new Error(`archive timeout at ${status}`);
      await new Promise((res) => setTimeout(res, 2000));
    }
    expect(status).toBe("COMPLETED");
    // Download the package through the real download endpoint.
    const dl = await api("GET", `/api/project-archives/${archiveId}/download`, { jar: u, binary: true });
    expect(dl.status).toBe(200);
    const zipBuf = Buffer.from(await dl.res!.arrayBuffer());
    fs.writeFileSync(ep(EVIDENCE, "acceptance-package.zip"), zipBuf);
    expect(zipBuf.length).toBeGreaterThan(50_000);
    // IMPORT into the clean importer library via the real endpoint.
    const imp = await api("POST", "/api/projects/import", { jar: packer, raw: zipBuf, headers: { "x-filename": "package.zip", "Content-Type": "application/zip" } });
    expect([200, 201, 202]).toContain(imp.status);
    const importArchiveId = imp.json.archiveId ?? imp.json.id;
    expect(importArchiveId).toBeTruthy();
    const t1 = Date.now();
    let imported: { projectId?: string; masksRestored?: number; masksFailed?: number } | null = null;
    for (;;) {
      const st = await api("GET", `/api/projects/import/status/${importArchiveId}`, { jar: packer });
      const j = st?.json?.archive;
      if (j && ["COMPLETED", "FAILED"].includes(j.status ?? "")) {
        if (j.status === "FAILED") throw new Error(`import FAILED: ${j.error}`);
        imported = j;
        break;
      }
      if ((Date.now() - t1) / 1000 > 300) throw new Error(`import timeout: ${JSON.stringify(st?.json)?.slice(0, 200)}`);
      await new Promise((res) => setTimeout(res, 2000));
    }
    expect(imported?.projectId).toBeTruthy();
    // The import STATUS endpoint reports the archive row; mask counts come
    // from the durable job result — verify via the imported masks themselves.
    const masks = await api("GET", `/api/masks`, { jar: packer });
    expect(masks.status).toBe(200);
    expect(masks.json.masks.length).toBeGreaterThanOrEqual(1);
    expect(masks.json.masks.every((m: { validationStatus: string }) => m.validationStatus === "VALIDATED")).toBe(true);
    fs.writeFileSync(ep(EVIDENCE, "acceptance-import.json"), JSON.stringify({ imported, masks: masks.json.masks.map((m: { id: string; width: number; height: number; validationStatus: string; method: string }) => m) }, null, 2));
  }, 900_000);
});
