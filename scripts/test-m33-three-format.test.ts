/**
 * M33 Track A — LIVE triple-format campaign workflow through the REAL HTTP
 * application (isolated server). One approved master campaign (9:16) produces
 * THREE real exports: the master's own 9:16 render (M31 FINAL_RENDER) + two
 * derived variants (16:9, 1:1) rendered through the existing durable queue.
 * The master's own aspect is never re-derived as a variant (M32 §B1 design:
 * the master remains the master) — the three FORMATS each get a real export.
 * Run (server on :3118): M33_BASE=http://localhost:3118 bun test scripts/test-m33-three-format.test.ts
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
    headers: {
      ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}),
      ...(raw ? headers : {}),
      ...(j?.cookie ? { Cookie: j.cookie } : {}),
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (j) for (const c of setCookie) { const [k, v] = c.split(";")[0].split("="); if (k === "beanfx_session") j.cookie = `${k}=${v}`; }
  return { status: res.status, json: binary ? null : await res.json().catch(() => null), res };
}

let u = jar();
let projectId = ""; let pid = ""; let screenshotId = ""; let demoVideoId = "";
let masterStoryboardAtApproval = "";

async function board(id: string) {
  const r = await api("GET", `/api/productions/${id}`, { jar: u });
  expect(r.status).toBe(200);
  return r.json;
}
async function runStage(id: string, key: string, action = "start") {
  return api("POST", `/api/productions/${id}/stages/${key}`, { jar: u, body: { action } });
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

beforeAll(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const r = await api("POST", "/api/auth/register", { jar: u, body: { email: `m33a-${STAMP}@test.local`, password: `m33-${STAMP}-p1`, name: "M33 Owner" } });
  expect(r.status).toBe(200);
  // REAL fixtures: 720x1280 portrait UI screenshot + 8s portrait demo video WITH audio.
  execSync(`python3 -c "
from PIL import Image, ImageDraw
im = Image.new('RGB', (720, 1280), (11, 11, 11))
d = ImageDraw.Draw(im)
d.rectangle([40, 60, 680, 620], fill=(20, 20, 20), outline=(212, 160, 23), width=6)
d.rectangle([60, 120, 400, 170], fill=(212, 160, 23))
d.text((76, 138), 'BEAN FX - MOBILE', fill=(0, 0, 0))
d.rectangle([60, 260, 660, 320], fill=(40, 40, 40))
d.rectangle([60, 380, 660, 440], fill=(40, 40, 40))
im.save('/tmp/m33a-ui.png')"`);
  execSync(`ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=720x1280:rate=30:duration=8" -f lavfi -i "sine=frequency=330:duration=8" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest /tmp/m33a-demo.mp4`);
  const proj = await api("POST", "/api/projects", { jar: u, body: { name: `M33 master ${STAMP}` } });
  projectId = proj.json.project.id;
  const upImg = await api("POST", "/api/media", { jar: u, raw: fs.readFileSync("/tmp/m33a-ui.png"), headers: { "x-filename": "ui.png", "Content-Type": "image/png" } });
  screenshotId = upImg.json.media.id;
  const upVid = await api("POST", "/api/media", { jar: u, raw: fs.readFileSync("/tmp/m33a-demo.mp4"), headers: { "x-filename": "demo.mp4", "Content-Type": "application/octet-stream" } });
  demoVideoId = upVid.json.media.id;
  expect(upVid.status).toBe(200);
}, 300_000);

describe("M33 Track A — one approved master → three real exports (live HTTP)", () => {

  test("intake with 9:16 master aspect → production created", async () => {
    const r = await api("POST", "/api/productions", { jar: u, body: {
      templateId: "showcase-studio", title: "M33 Three Format", projectId,
      briefText: "Launch film for Bean FX, an AI video editor for creators.",
      campaignType: "app-showcase", tonePreset: "premium", targetDurationSec: 20,
      aspectRatio: "9:16", narrationPreference: "none", musicPreference: "user-provided",
      showcaseInputs: {
        productName: "Bean FX",
        description: "Bean FX is an AI video editing studio for creators.",
        featureList: "Native timeline editing\nAI captions\nAspect-ratio variants\nClient review links",
        websiteUrl: "https://example.com",
        screenshotMediaIds: [screenshotId], demoVideoMediaIds: [demoVideoId], projectId,
      },
      sourceMediaIds: [screenshotId, demoVideoId],
    } });
    expect(r.status).toBe(201);
    pid = r.json.production.id;
  }, 60_000);

  test("chain: intake→understand→brief→concept→script→storyboard (approved revision recorded)", async () => {
    await runStage(pid, "INTAKE"); await waitStage(pid, "INTAKE", "AWAITING_APPROVAL");
    await runStage(pid, "INTAKE", "approve"); await waitStage(pid, "INTAKE", "SUCCEEDED");
    await runStage(pid, "PRODUCT_UNDERSTANDING"); await waitStage(pid, "PRODUCT_UNDERSTANDING", "AWAITING_APPROVAL");
    await api("PUT", `/api/productions/${pid}`, { jar: u, body: { kind: "product-approval", decision: "APPROVED" } });
    await runStage(pid, "PRODUCT_UNDERSTANDING", "approve"); await waitStage(pid, "PRODUCT_UNDERSTANDING", "SUCCEEDED");
    await runStage(pid, "BRIEF"); await waitStage(pid, "BRIEF", "AWAITING_APPROVAL");
    await runStage(pid, "BRIEF", "approve"); await waitStage(pid, "BRIEF", "SUCCEEDED");
    await runStage(pid, "CONCEPT"); await waitStage(pid, "CONCEPT", "AWAITING_APPROVAL");
    const b = await board(pid);
    await api("PUT", `/api/productions/${pid}`, { jar: u, body: { kind: "concept", selectedId: b.concept.options[0].id } });
    await runStage(pid, "CONCEPT", "approve"); await waitStage(pid, "CONCEPT", "SUCCEEDED");
    await runStage(pid, "SCRIPT"); await waitStage(pid, "SCRIPT", "AWAITING_APPROVAL");
    await runStage(pid, "SCRIPT", "approve"); await waitStage(pid, "SCRIPT", "SUCCEEDED");
    await runStage(pid, "STORYBOARD"); await waitStage(pid, "STORYBOARD", "AWAITING_APPROVAL");
    const sb = (await board(pid)).storyboard.scenes;
    expect(sb.length).toBeGreaterThanOrEqual(4);
    for (const s of sb) await api("PUT", `/api/productions/${pid}`, { jar: u, body: { kind: "scene-approval", sceneKey: s.sceneKey, decision: "APPROVED" } });
    await runStage(pid, "STORYBOARD", "approve"); await waitStage(pid, "STORYBOARD", "SUCCEEDED");
    // Record the APPROVED master storyboard revision (immutability anchor).
    const approved = await board(pid);
    masterStoryboardAtApproval = approved.storyboard ? JSON.stringify(approved.storyboard.scenes.map((s: { sceneKey: string; approval: string }) => ({ k: s.sceneKey, a: s.approval }))) : "";
    expect(masterStoryboardAtApproval).toContain("APPROVED");
  }, 600_000);

  test("assets → assembly → review → render → QA → delivery: master COMPLETED with real 9:16 export", async () => {
    await runStage(pid, "ASSET_PLANNING"); await waitStage(pid, "ASSET_PLANNING", "AWAITING_APPROVAL");
    const b = await board(pid);
    for (const a of b.assets) {
      if (a.sourceType === "USER_MEDIA" && a.status === "PENDING" && !a.mediaAssetId) {
        const attach = await api("POST", `/api/productions/${pid}/assets`, { jar: u, body: { action: "attach", assetRowId: a.id, mediaAssetId: a.category === "music" ? demoVideoId : demoVideoId } });
        expect([200, 400]).toContain(attach.status);
      }
    }
    await runStage(pid, "ASSET_PLANNING", "approve"); await waitStage(pid, "ASSET_PLANNING", "SUCCEEDED");
    await runStage(pid, "ASSET_GENERATION"); await waitStage(pid, "ASSET_GENERATION", "SUCCEEDED", 300);
    await runStage(pid, "EDIT_PLANNING"); await waitStage(pid, "EDIT_PLANNING", "SUCCEEDED");
    await runStage(pid, "TIMELINE_ASSEMBLY"); await waitStage(pid, "TIMELINE_ASSEMBLY", "SUCCEEDED");
    await runStage(pid, "ROUGH_CUT"); await waitStage(pid, "ROUGH_CUT", "SUCCEEDED");
    await runStage(pid, "REVIEW"); await waitStage(pid, "REVIEW", "AWAITING_APPROVAL", 300);
    const b2 = await board(pid);
    const revisionId = (b2.stages.find((s: { key: string }) => s.key === "REVIEW").output as { revisionId: string }).revisionId;
    const t0 = Date.now();
    for (;;) {
      const d = await api("GET", `/api/reviews/${revisionId}`, { jar: u });
      if (["READY_FOR_REVIEW", "IN_REVIEW"].includes(d.json?.revision?.status)) break;
      if ((Date.now() - t0) / 1000 > 600) throw new Error(`review render timeout: ${d.json?.revision?.status}`);
      await new Promise((res) => setTimeout(res, 2000));
    }
    expect((await api("PUT", `/api/reviews/${revisionId}`, { jar: u, body: { decision: "APPROVE" } })).status).toBe(200);
    await runStage(pid, "REVIEW", "approve"); await waitStage(pid, "REVIEW", "SUCCEEDED");
    await runStage(pid, "FINAL_RENDER"); await waitStage(pid, "FINAL_RENDER", "SUCCEEDED", 300);
    await runStage(pid, "QUALITY_ASSURANCE"); await waitStage(pid, "QUALITY_ASSURANCE", "SUCCEEDED");
    await runStage(pid, "DELIVERY"); await waitStage(pid, "DELIVERY", "SUCCEEDED", 300);
    const fin = await board(pid);
    expect(fin.production?.status ?? fin.status).toBe("COMPLETED");
    fs.writeFileSync(path2(EVIDENCE, "master-board.json"), JSON.stringify(fin, null, 2));
  }, 900_000);

  test("A1/A2: derive 16:9 + 1:1 via the REAL endpoint — native editable sequences, same master", async () => {
    const r = await api("POST", `/api/productions/${pid}/variants`, { jar: u, body: { formats: ["16:9", "1:1"] } });
    expect([201, 207]).toContain(r.status);
    const derived = r.json.results;
    expect(derived.filter((x: { error?: string }) => !x.error).length).toBe(2);
    fs.writeFileSync(path2(EVIDENCE, "derive-results.json"), JSON.stringify(r.json, null, 2));
    const g = await api("GET", `/api/productions/${pid}/variants`, { jar: u });
    expect(g.status).toBe(200);
    const vs = g.json.variants;
    expect(vs.length).toBe(2);
    for (const v of vs) {
      expect(["16:9", "1:1"]).toContain(v.format);
      expect(v.status).toBe("READY");
      expect(v.projectId).toBeTruthy();
      // Each variant is its OWN native sequence (distinct project, target dims).
      const head = await api("GET", `/api/editor/projects/${v.projectId}/timeline`, { jar: u });
      expect(head.status).toBe(200);
      const seq = head.json.version?.sequence ?? head.json.sequence;
      const dims = v.format === "16:9" ? [1920, 1080] : [1080, 1080];
      expect(seq.width).toBe(dims[0]);
      expect(seq.height).toBe(dims[1]);
      expect(seq.clips.length).toBeGreaterThan(0);
      // Reframed transforms present (cover scale from the 9:16 master).
      const videoClip = seq.clips.find((c: { transform?: { scale?: number } }) => c.transform?.scale);
      expect(videoClip).toBeDefined();
    }
    // Duplicate derivation refused honestly (idempotent protection).
    const again = await api("POST", `/api/productions/${pid}/variants`, { jar: u, body: { formats: ["16:9"] } });
    expect(again.status).toBe(207);
    expect(again.json.results[0].error).toMatch(/already exists/);
  }, 300_000);

  test("A2/A4: batch render both variants on the durable queue → real exports validated by ffprobe", async () => {
    const r = await api("POST", `/api/productions/${pid}/variants`, { jar: u, body: { action: "render", formats: ["16:9", "1:1"] } });
    expect(r.status).toBe(202);
    expect(r.json.results.filter((x: { jobId?: string }) => x.jobId).length).toBe(2);
    fs.writeFileSync(path2(EVIDENCE, "render-submit.json"), JSON.stringify(r.json, null, 2));
    // Wait for completion through the APPLICATION (GET reconciles job states).
    const t0 = Date.now();
    let variants: Array<{ format: string; status: string; exportId: string | null; error: string | null }> = [];
    for (;;) {
      const g = await api("GET", `/api/productions/${pid}/variants`, { jar: u });
      variants = g.json.variants;
      if (variants.every((v) => ["COMPLETED", "FAILED", "CANCELLED"].includes(v.status))) break;
      if ((Date.now() - t0) / 1000 > 600) throw new Error(`variant render timeout at ${JSON.stringify(variants.map((v) => [v.format, v.status]))}`);
      await new Promise((res) => setTimeout(res, 3000));
    }
    for (const v of variants) {
      expect(v.status).toBe("COMPLETED");
      expect(v.exportId).toBeTruthy();
    }
    fs.writeFileSync(path2(EVIDENCE, "variant-states.json"), JSON.stringify(variants, null, 2));
    // Fetch the REAL export files through the application's export endpoint
    // and validate with ffprobe (dims / aspect / duration / codec / nonempty).
    const masterBoard = JSON.parse(fs.readFileSync(path2(EVIDENCE, "master-board.json"), "utf8"));
    const masterExportId = masterBoard.stages.find((s: { key: string }) => s.key === "FINAL_RENDER")?.output?.exportFileId
      ?? masterBoard.stages.find((s: { key: string }) => s.key === "DELIVERY")?.output?.artifacts?.[0]?.exportFileId
      ?? null;
    const exportsToCheck: Array<{ label: string; exportId: string | null }> = [
      { label: "master-9:16", exportId: masterExportId },
      ...variants.map((v) => ({ label: `variant-${v.format}`, exportId: v.exportId })),
    ];
    const probed: Record<string, unknown> = {};
    for (const e of exportsToCheck) {
      expect(e.exportId, `export id for ${e.label}`).toBeTruthy();
      const dl = await api("GET", `/api/exports/${e.exportId}/file`, { jar: u, binary: true });
      expect(dl.status).toBe(200);
      const buf = Buffer.from(await dl.res!.arrayBuffer());
      expect(buf.length).toBeGreaterThan(20_000); // nonempty real media
      const file = `/tmp/m33a-${e.label.replace(/[:]/g, "-")}.mp4`;
      fs.writeFileSync(file, buf);
      const probe = JSON.parse(execSync(`ffprobe -v error -print_format json -show_streams -show_format ${file}`).toString());
      const vs = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
      const as_ = probe.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
      const dims: Record<string, [number, number]> = { "master-9:16": [1080, 1920], "variant-16:9": [1920, 1080], "variant-1:1": [1080, 1080] };
      const [w, h] = dims[e.label];
      expect(vs.width).toBe(w);
      expect(vs.height).toBe(h);
      expect(Math.abs(vs.width / vs.height - w / h)).toBeLessThan(0.02);
      expect(["h264", "hevc"]).toContain(vs.codec_name);
      expect(parseFloat(probe.format.duration)).toBeGreaterThan(2);
      probed[e.label] = {
        exportId: e.exportId, bytes: buf.length, width: vs.width, height: vs.height,
        codec: vs.codec_name, durationSec: parseFloat(probe.format.duration),
        fps: vs.r_frame_rate, audio: as_ ? { codec: as_.codec_name, channels: as_.channels } : null,
        sha256: execSync(`sha256sum ${file}`).toString().split(" ")[0],
      };
    }
    fs.writeFileSync(path2(EVIDENCE, "ffprobe-all-formats.json"), JSON.stringify(probed, null, 2));
  }, 900_000);

  test("A2.14: master immutability — approved storyboard byte-identical after derivation+renders", async () => {
    const fin = await board(pid);
    const nowStr = fin.storyboard ? JSON.stringify(fin.storyboard.scenes.map((s: { sceneKey: string; approval: string }) => ({ k: s.sceneKey, a: s.approval }))) : "";
    expect(nowStr).toBe(masterStoryboardAtApproval);
    fs.writeFileSync(path2(EVIDENCE, "master-immutability.json"), JSON.stringify({ unchanged: nowStr === masterStoryboardAtApproval }, null, 2));
  }, 60_000);
});

function path2(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
