/**
 * M48-I stabilization — Exposure 0.8 genuine-UI → persisted-state → export
 * round trip (live, browser).
 *
 * The adjustment happens ONLY through the real ColorGradePanel slider (click
 * to focus + 16 ArrowRight presses at step 0.05 = exactly 0.8 stops). No API
 * or DB write impersonates a UI interaction. Persisted state is checked via
 * read-only GET timeline. The export runs through the canonical renderer and
 * the decoded frame is compared against the CPU grade model (gradePixel from
 * src/lib/color/grade-model.ts — the same reference the I5 parity suite uses)
 * with the documented chroma-roundtrip method.
 *
 * Run: BASE=http://localhost:3130 bun test scripts/test-m48-i-exposure-roundtrip.test.ts
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { chromium } from "playwright";
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";
import { gradePixel, DEFAULT_GRADE } from "@/lib/color/grade-model";

const BASE = process.env.BASE ?? "http://localhost:3130";
const OUT = "/home/z/my-project/download/m48-j/preview";
mkdirSync(OUT, { recursive: true });

let cookie = "";
let email = "";
let projectId = "";
let clipId = "";
let fixturePath = "";
let browser: import("playwright").Browser | null = null;
let page: import("playwright").Page | null = null;
let serverUp = false;

const api = async (m: string, p: string, body?: unknown) => {
  const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  for (const raw of r.headers.getSetCookie?.() ?? []) if (raw.startsWith("beanfx_session=")) cookie = raw.split(";")[0];
  return { status: r.status, json: await r.json().catch(() => null) as never };
};

const FW = 1920, FH = 1080;
function rawFrame(file: string, tSec: number): Uint8Array {
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(tSec), "-i", file, "-vf", "scale=1920:1080", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  const buf = r.stdout as Buffer;
  if (buf.length < FW * FH * 3) throw new Error(`frame decode failed (${buf.length} bytes) file=${file} stderr=${String(r.stderr).slice(0, 150)}`);
  return new Uint8Array(buf.subarray(0, FW * FH * 3));
}
function chromaRoundtrip(frame: Uint8Array): Uint8Array {
  const r = spawnSync("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${FW}x${FH}`, "-i", "-", "-vf", "format=yuv420p", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, input: Buffer.from(frame.buffer, frame.byteOffset, frame.length) });
  const buf = r.stdout as Buffer;
  if (buf.length < frame.length) throw new Error(`chroma roundtrip failed: ${String(r.stderr).slice(0, 150)}`);
  return new Uint8Array(buf.subarray(0, frame.length));
}
function diffFrames(a: Uint8Array, b: Uint8Array) {
  let sum = 0, max = 0;
  const diffs: number[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i += 3) {
    let px = 0;
    for (let k = 0; k < 3; k++) { const d = Math.abs(a[i + k] - b[i + k]); sum += d; px = Math.max(px, d); }
    diffs.push(px); if (px > max) max = px;
  }
  diffs.sort((x, y) => x - y);
  return { mean: sum / (a.length / 3), max, p999: diffs[Math.floor(diffs.length * 0.999)] };
}

beforeAll(async () => {
  try { serverUp = (await fetch(`${BASE}/api/health`)).ok; } catch { serverUp = false; }
  if (!serverUp) return;
  email = `expo-${Date.now().toString(36)}@beanfx.test`;
  const password = `Expo-${Date.now().toString(36)}aA9`;
  const reg = await api("POST", "/api/auth/register", { email, password, name: "Expo", acceptedDraftTerms: true });
  if (reg.status >= 300 || !cookie) throw new Error(`register failed ${reg.status}`);
  const pr = await api("POST", "/api/projects", { name: `expo rt ${Date.now().toString(36)}` });
  projectId = (pr.json as { project: { id: string } }).project.id;
  fixturePath = `/tmp/expo-rt-${Date.now().toString(36)}.mp4`;
  spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "smptebars=size=1920x1080:rate=30:duration=12", "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-pix_fmt", "yuv420p", fixturePath], { encoding: "utf8" });
  const up = await fetch(`${BASE}/api/media`, { method: "POST", headers: { "Content-Type": "video/mp4", "x-project-id": projectId, "x-filename": "bars1080.mp4", "x-asset-role": "SOURCE_FOOTAGE", Cookie: cookie }, body: readFileSync(fixturePath) });
  const upBody = await up.json().catch(() => null) as { media?: { id?: string } } | null;
  const assetId = upBody?.media?.id ?? "";
  if (!assetId) throw new Error(`upload failed ${up.status}`);
  const head = await api("GET", `/api/editor/projects/${projectId}/timeline`) as { json: { version: number; sequence: { tracks: Array<{ id: string; kind: string }> } } };
  const v1 = (head.json as { sequence: { tracks: Array<{ id: string; kind: string }> } }).sequence.tracks.find((t) => t.kind === "VIDEO")!.id;
  clipId = `expo-${Date.now().toString(36)}`;
  await api("POST", `/api/editor/projects/${projectId}/timeline`, { baseVersion: (head.json as unknown as { version: number }).version, edits: [{ type: "AddClip", clip: { id: clipId, trackId: v1, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: 240, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 240, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: null, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [], audioSourceInFrame: null, audioSourceOutFrame: null, avLinked: true } }] });

  browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome", args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE}/#/`, { waitUntil: "domcontentloaded" });
  let opened = false;
  for (let i = 0; i < 30 && !opened; i++) {
    if ((await page.getByRole("button", { name: /login/i }).count()) > 0) { await page.getByRole("button", { name: /login/i }).first().click(); opened = true; }
    else if ((await page.locator('header button[aria-label="Open menu"]').count()) > 0) { await page.locator('header button[aria-label="Open menu"]').first().click(); await page.waitForTimeout(400); await page.getByRole("button", { name: /login/i }).first().click(); opened = true; }
    else await page.waitForTimeout(500);
  }
  expect(opened).toBe(true);
  await page.getByLabel(/email/i).waitFor({ timeout: 15_000 });
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/^password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.getByRole("button", { name: /new production/i }).first().waitFor({ timeout: 20_000 });
}, 180_000);

async function openAndSelect() {
  await page!.goto(`${BASE}/#/editor?project=${projectId}`, { waitUntil: "domcontentloaded" });
  await page!.waitForTimeout(2500);
  let selected = false;
  for (let i = 0; i < 15 && !selected; i++) {
    const b = page!.locator(`[data-clip-id="${clipId}"]`).first();
    if (await b.count()) {
      const bb = await b.boundingBox().catch(() => null);
      if (bb && bb.width > 6) { await page!.mouse.click(bb.x + Math.max(8, bb.width * 0.35), bb.y + bb.height / 2); selected = true; break; }
    }
    await page!.waitForTimeout(1000);
  }
  expect(selected).toBe(true);
  let mounted = false;
  for (let i = 0; i < 20 && !mounted; i++) {
    mounted = await page!.getByTestId("color-grade-panel").isVisible().catch(() => false);
    if (!mounted) await page!.waitForTimeout(1000);
  }
  expect(mounted).toBe(true);
}

describe("M48-I — Exposure 0.8 genuine UI → persisted state → decoded export", () => {
  test("adjust through the real slider, verify display + persisted 0.8, reload, export parity", async () => {
    if (!serverUp || !page) { console.log("SKIP: live server not reachable — run with BASE=http://localhost:3130"); return; }

    await openAndSelect();
    const panel = page.getByTestId("color-grade-panel");
    const exposureInput = panel.locator('label:has-text("Exposure") input[type="range"]');
    await exposureInput.waitFor({ timeout: 8000 });

    // BEFORE state: screenshot + span text (React-controlled value)
    const spanBefore = await panel.locator('label:has-text("Exposure")').locator("..").innerText().catch(() => "");
    await page.screenshot({ path: `${OUT}/expo-before.png` });

    // genuine user adjustment: click to focus, 16 × ArrowRight (step 0.05 → 0.8)
    await exposureInput.click();
    for (let i = 0; i < 16; i++) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(15); }
    await exposureInput.evaluate((el) => (el as HTMLInputElement).blur());
    await page.waitForTimeout(1200);

    // 3. displayed React-controlled value shows 0.80
    const label = panel.locator('label:has-text("Exposure")');
    await label.getByText(/0\.80/).first().waitFor({ timeout: 8000 });

    // persisted canonical state via READ-ONLY GET (poll autosave, 15 s)
    let persisted = Number.NaN;
    const t0 = Date.now();
    while (Date.now() - t0 < 15_000) {
      const h = await api("GET", `/api/editor/projects/${projectId}/timeline`);
      const g = ((h.json as { sequence: { clips: Array<{ grade?: Record<string, number> }> } }).sequence.clips.find((c) => c.id === clipId)?.grade) ?? {};
      if (g.exposure !== undefined) { persisted = g.exposure; if (Math.abs(persisted - 0.8) < 1e-6) break; }
      await new Promise((r) => setTimeout(r, 1500));
    }
    expect(Math.abs(persisted - 0.8)).toBeLessThan(1e-6);

    // 5. reload the editor and confirm 0.8 remains (UI + persisted)
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await openAndSelect();
    await panel.locator('label:has-text("Exposure")').getByText(/0\.80/).first().waitFor({ timeout: 8000 });
    await page.screenshot({ path: `${OUT}/expo-after-reload.png` });

    // 6. canonical export pipeline
    const rr = await api("POST", `/api/editor/projects/${projectId}/render`, {});
    expect(rr.status).toBe(202);
    const jobId = (rr.json as { jobId: string }).jobId;
    let exportId = "";
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const g = await api("GET", `/api/jobs/${jobId}`);
      const job = (g.json as { job?: { status?: string; exportId?: string; message?: string } }).job ?? (g.json as { status?: string; exportId?: string; message?: string });
      if (job?.status === "COMPLETED" && job.exportId) { exportId = job.exportId; break; }
      if (job?.status === "FAILED") throw new Error(`render FAILED: ${JSON.stringify(job).slice(0, 250)}`);
    }
    expect(exportId).toBeTruthy();
    const dl = await fetch(`${BASE}/api/exports/${exportId}/file`, { headers: { Cookie: cookie } });
    expect(dl.status).toBe(200);
    const exportPath = path.join(OUT, "expo-roundtrip-export.mp4");
    writeFileSync(exportPath, Buffer.from(await dl.arrayBuffer()));

    // 7. decode + compare against the CPU grade model (documented reference)
    const SOURCE_FRAME_SEC = 2.0;   // source frame 60 of 240 (30 fps)
    const OUTPUT_FRAME_SEC = 2.0;   // same timeline position in the export
    const src = rawFrame(fixturePath, SOURCE_FRAME_SEC);
    const gp = { ...DEFAULT_GRADE, exposure: persisted };
    const model = new Uint8Array(FW * FH * 3);
    for (let i = 0; i < src.length; i += 3) {
      const [r, gg, b] = gradePixel(src[i] / 255, src[i + 1] / 255, src[i + 2] / 255, gp);
      model[i] = r * 255; model[i + 1] = gg * 255; model[i + 2] = b * 255;
    }
    const modelRef = chromaRoundtrip(model);
    const got = rawFrame(exportPath, OUTPUT_FRAME_SEC);
    const d = diffFrames(got, modelRef);
    writeFileSync(`${OUT}/expo-roundtrip-result.json`, JSON.stringify({
      sourceFrame: { sec: SOURCE_FRAME_SEC, frame: Math.round(SOURCE_FRAME_SEC * 30), of: 240 },
      outputFrame: { sec: OUTPUT_FRAME_SEC, file: "expo-roundtrip-export.mp4", exportId },
      persistedExposure: persisted, displayedValue: "0.80", reloadVerified: true,
      decodedPixelComparison: d, tolerance: { meanPerChannel: "< 2.0/255", p999: "< 24/255 (x264 quantization at hard bar edges, documented in the M48-I parity report)" },
      method: "decoded export frame vs CPU grade model (gradePixel) with symmetric 4:2:0 chroma round-trip",
    }, null, 1));
    expect(d.mean).toBeLessThan(2.0);
    expect(d.p999).toBeLessThan(24);
  }, 560_000);
});
