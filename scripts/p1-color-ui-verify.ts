/**
 * M48-I P1/P2 — authenticated Color panel verification through the real UI.
 * Genuine UI login (f3 pattern), real project, real footage, real LUT upload
 * via the file input, canonical persistence checks, screenshots + layout
 * diagnostics. Run: BASE=http://localhost:3131 bun run scripts/p1-color-ui-verify.ts
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, readFileSync, statSync } from "fs";
import { spawnSync } from "child_process";

const BASE = process.env.BASE ?? "http://localhost:3131";
const OUT = "/home/z/my-project/download/m48-i-followup";
const SHOTS = `${OUT}/screenshots`;
mkdirSync(SHOTS, { recursive: true });
const results: Record<string, unknown> = {};
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const failedRequests: string[] = [];
const http4xx5xx: string[] = [];
const layoutIssues: string[] = [];
const STAMP = Date.now().toString(36);

// fixture: static SMPTE bars (SDR, supported metadata)
const fx = `/tmp/p1-color-${STAMP}.mp4`;
spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "smptebars=size=480x270:rate=30:duration=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", fx], { encoding: "utf8" });
const lutText = (() => {
  const lines = ['TITLE "p1-warm"', "LUT_3D_SIZE 17"];
  for (let b = 0; b < 17; b++) for (let g = 0; g < 17; g++) for (let r = 0; r < 17; r++) {
    const [or, og, ob] = [Math.min(1, r / 16 * 1.12 + 0.04), g / 16, Math.max(0, b / 16 * 0.9 - 0.02)];
    lines.push(`${or.toFixed(6)} ${og.toFixed(6)} ${ob.toFixed(6)}`);
  }
  return lines.join("\n") + "\n";
})();
writeFileSync("/tmp/p1-warm.cube", lutText);

let cookie = "";
const api = async (m: string, p: string, body?: unknown) => {
  const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const raw of r.headers.getSetCookie?.() ?? []) if (raw.startsWith("beanfx_session=")) cookie = raw.split(";")[0];
  return { status: r.status, json: await r.json().catch(() => null) };
};

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 160)); });
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 160)));
page.on("requestfailed", (r) => failedRequests.push(`${r.url().slice(0, 90)} ${r.failure()?.errorText ?? ""}`));
page.on("response", (r) => { if (r.status() >= 400) http4xx5xx.push(`${r.status()} ${r.url().slice(0, 90)}`); });

async function shot(name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

try {
  // ── setup: account, project, fixture, graded clip via canonical API ──
  const email = `p1-${STAMP}@beanfx.test`;
  const password = `P1color-${STAMP}aA9`;
  const reg = await api("POST", "/api/auth/register", { email, password, name: "P1 Color", acceptedDraftTerms: true });
  if (reg.status >= 300) throw new Error(`register failed ${reg.status}`);
  const pr = await api("POST", "/api/projects", { name: `P1 color ${STAMP}` });
  const projectId = (pr.json as { project: { id: string } }).project.id;
  const up = await fetch(`${BASE}/api/media`, { method: "POST", headers: { "Content-Type": "video/mp4", "x-project-id": projectId, "x-filename": "bars.mp4", "x-asset-role": "SOURCE_FOOTAGE", Cookie: cookie }, body: readFileSync(fx) });
  const upBody = await up.text();
  let assetId = "";
  try { const j = JSON.parse(upBody) as { asset?: { id?: string }; media?: { id?: string }; id?: string }; assetId = j.asset?.id ?? j.media?.id ?? j.id ?? ""; } catch { /* noop */ }
  if (!assetId) throw new Error(`asset upload failed status=${up.status} body=${upBody.slice(0, 140)} cookieSet=${cookie ? "yes" : "no"}`);
  const head = await api("GET", `/api/editor/projects/${projectId}/timeline`);
  const hj = head.json as { version: number; sequence: { tracks: Array<{ id: string; kind: string }> } };
  const v1 = hj.sequence.tracks.find((t) => t.kind === "VIDEO")!.id;
  const clipId = `p1c-${STAMP}`;
  const tl = await api("POST", `/api/editor/projects/${projectId}/timeline`, { baseVersion: hj.version, edits: [{ type: "AddClip", clip: { id: clipId, trackId: v1, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: 120, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 120, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: null, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [], audioSourceInFrame: null, audioSourceOutFrame: null, avLinked: true } }] });
  if (tl.status >= 300) throw new Error(`timeline rejected ${tl.status}`);

  // ── genuine UI login ──
  await page.goto(`${BASE}/#/`, { waitUntil: "domcontentloaded" });
  let opened = false;
  for (let i = 0; i < 30 && !opened; i++) {
    if ((await page.getByRole("button", { name: /login/i }).count()) > 0) { await page.getByRole("button", { name: /login/i }).first().click(); opened = true; }
    else if ((await page.locator('header button[aria-label="Open menu"]').count()) > 0) { await page.locator('header button[aria-label="Open menu"]').first().click(); await page.waitForTimeout(400); await page.getByRole("button", { name: /login/i }).first().click(); opened = true; }
    else await page.waitForTimeout(500);
  }
  if (!opened) throw new Error("login affordance never appeared");
  await page.getByLabel(/email/i).waitFor({ timeout: 15_000 });
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/^password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.getByRole("button", { name: /new production/i }).first().waitFor({ timeout: 20_000 });
  results.uiLogin = true;
  await shot("p1-01-authenticated-home");

  // ── navigate to the editor (Open Chat/home → project → canonical editor URL) ──
  await page.goto(`${BASE}/#/editor?project=${projectId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // cold-load settle: reload once so the editor hash parse runs fully hydrated
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  results.editorLoaded = await page.getByText(/PROGRAM MONITOR/i).first().isVisible().catch(() => false);
  await shot("p1-02-editor");

  // ── select the clip in the timeline UI (wait for the block to render) ──
  let selectedViaTimeline = false;
  for (let i = 0; i < 20 && !selectedViaTimeline; i++) {
    const block = page.locator(`[data-clip-id="${clipId}"]`).first();
    if (await block.count()) {
      // click at 30% of the block width — the playhead marker sits at the
      // left edge and would swallow a center click (stopPropagation).
      const bb = await block.boundingBox();
      if (bb && bb.width > 6) {
        await page.mouse.click(bb.x + Math.max(8, bb.width * 0.3), bb.y + bb.height / 2);
        selectedViaTimeline = true;
        break;
      }
    }
    const any = page.locator("[data-clip-id]").first();
    if (await any.count()) {
      const bb2 = await any.boundingBox();
      if (bb2 && bb2.width > 6) {
        await page.mouse.click(bb2.x + Math.max(8, bb2.width * 0.3), bb2.y + bb2.height / 2);
        selectedViaTimeline = true;
        break;
      }
    }
    await page.waitForTimeout(1000);
  }
  results.clipBlockFound = selectedViaTimeline;
  // poll for the panel to mount after selection (render lag on cold loads)
  let panelMounted = false;
  for (let i = 0; i < 12 && !panelMounted; i++) {
    panelMounted = await page.getByTestId("color-grade-panel").isVisible().catch(() => false);
    if (!panelMounted) {
      // re-click at 30% (selection may have been swallowed by an overlay)
      const blk = page.locator(`[data-clip-id="${clipId}"]`).first();
      if (await blk.count()) {
        const bb = await blk.boundingBox().catch(() => null);
        if (bb && bb.width > 6) await page.mouse.click(bb.x + Math.max(8, bb.width * 0.45), bb.y + bb.height / 2);
      }
      await page.waitForTimeout(1500);
    }
  }
  results.colorPanelMounted = panelMounted;
  const panel = page.getByTestId("color-grade-panel");
  if (!panelMounted) await page.screenshot({ path: `${SHOTS}/p1-debug-no-panel.png` });
  await shot("p1-03-color-panel-open");

  // ── adjust every primary control (real slider dispatch → canonical commands) ──
  /** Genuine user adjustment: click the slider (focus), then arrow-key presses. */
  const setSlider = async (label: string, presses: number) => {
    const row = panel.locator(`label:has-text("${label}")`).first();
    const input = row.locator('input[type="range"]');
    await input.waitFor({ timeout: 5000 });
    await input.click();
    const key = presses > 0 ? "ArrowRight" : "ArrowLeft";
    for (let i = 0; i < Math.abs(presses); i++) { await page.keyboard.press(key); await page.waitForTimeout(12); }
    await input.evaluate((el) => (el as HTMLInputElement).blur());
  };
  // press counts: step 0.05 → 16 presses = 0.8; signed relative to each default
  const plan: [string, number][] = [
    ["Exposure", 16], ["Temperature", 8], ["Tint", -4], ["Contrast", 6], ["Pivot", 2],
    ["Highlights", 5], ["Shadows", -6], ["Whites", 3], ["Blacks", -3],
    ["Saturation", 7], ["Vibrance", 7],
  ];
  results.sliderAdjustments = {};
  for (const [label, n] of plan) {
    try { await setSlider(label, n); results.sliderAdjustments[label] = n; } catch (e) { results.sliderAdjustments[label] = `FAILED ${String(e).slice(0, 80)}`; }
  }
  await shot("p1-04-primary-adjusted");
  // LGG + RGB channel rows — ONLY the 12 wheel sliders that FOLLOW the 11
  // primary sliders in the panel DOM (nth(11..22)); nth(0..10) are primaries.
  const wheels = panel.locator("label input[type=range]");
  const wheelCount = await wheels.count();
  results.wheelSliderCount = wheelCount;
  for (let i = 11; i < Math.min(wheelCount, 23); i++) {
    await wheels.nth(i).evaluate((el) => {
      const inp = el as HTMLInputElement;
      const min = Number(inp.min), max = Number(inp.max);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(inp, String(min === 0 && max > 1 ? max * 0.75 : (min + max) / 2));
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(80);
  }
  await shot("p1-05-lgb-rgb-adjusted");

  // persistence through the API — POLL for the autosave (up to 12 s)
  const pollGrade = async (pred: (g: Record<string, number>) => boolean, timeoutMs = 12_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const h = await api("GET", `/api/editor/projects/${projectId}/timeline`);
      const g = ((h.json as { sequence: { clips: Array<{ grade?: Record<string, number> }> } }).sequence.clips[0].grade ?? {});
      if (pred(g)) return g;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
  };
  const g1 = await pollGrade((g) => Math.abs((g.exposure ?? -9) - 0.8) < 0.026 && Math.abs((g.saturation ?? -9) - 1.07) < 0.011 && Math.abs((g.temperature ?? -9) - 0.4) < 0.011);
  results.primaryPersisted = g1 !== null;
  results.wheelsPersisted = g1 !== null && g1.gainR !== undefined && g1.gainR !== 1;
  // grade canvas (WebGL preview pass) while a live grade exists
  results.gradeCanvasActive = await page.getByTestId("grade-canvas").isVisible().catch(() => false);
  await shot("p1-06-before-after-baseline");

  // ── RESET / BYPASS / hold-BEFORE ──
  const resetBtn = panel.getByRole("button", { name: /reset/i });
  await resetBtn.click();
  await page.waitForTimeout(500);
  results.resetNeutralized = (await pollGrade((g) => g.exposure === 0 && (g.bypass ?? false) === false)) !== null;
  const bypassBtn = panel.getByRole("button", { name: /bypass/i }).first();
  await bypassBtn.click();
  await page.waitForTimeout(400);
  results.bypassToggled = (await pollGrade((g) => (g.bypass ?? false) === true)) !== null;
  await bypassBtn.click(); // restore
  // hold-BEFORE: mousedown/up
  const beforeBtn = panel.getByRole("button", { name: /before/i }).first();
  await beforeBtn.dispatchEvent("mousedown");
  await page.waitForTimeout(350);
  results.holdBeforeBypasses = (await pollGrade((g) => (g.bypass ?? false) === true)) !== null;
  await beforeBtn.dispatchEvent("mouseup");
  await page.waitForTimeout(300);
  await shot("p1-07-reset-bypass-before");

  // ── LUT import through the real file input ──
  const fileInput = panel.locator('input[type="file"][accept=".cube"]');
  await fileInput.setInputFiles("/tmp/p1-warm.cube");
  await page.waitForTimeout(1500);
  let seq6: { luts?: Array<{ id: string; name: string; size: number }>; clips: Array<{ lutId?: string | null }>; version?: number } | null = null;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 12_000) {
      const h = await api("GET", `/api/editor/projects/${projectId}/timeline`);
      const sq = (h.json as { sequence: { luts?: Array<{ id: string; name: string; size: number }>; clips: Array<{ lutId?: string | null }> } }).sequence;
      if ((sq.luts?.length ?? 0) === 1 && sq.clips[0]?.lutId) { seq6 = sq; break; }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  results.lutImported = (seq6?.luts?.length ?? 0) === 1;
  results.lutAppliedToClip = !!seq6 && seq6.clips[0]?.lutId === seq6.luts?.[0]?.id;
  await shot("p1-08-lut-applied");

  // undo (ctrl+z) removes the LUT assignment; redo restores it.
  // Focus a neutral element first so the shortcut reaches the app handler.
  await page.locator("body").click({ position: { x: 8, y: 8 } }).catch(() => undefined);
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(500);
  const pollLut = async (pred: (lutId: string | null | undefined) => boolean, timeoutMs = 12_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const h = await api("GET", `/api/editor/projects/${projectId}/timeline`);
      const lut = (h.json as { sequence: { clips: Array<{ lutId?: string | null }> } }).sequence.clips[0]?.lutId;
      if (pred(lut)) return true;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  };
  results.undoRestoredPreviousState = await pollLut((lut) => lut === null || lut === undefined);
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(500);
  let redoOk = false;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 12_000) {
      const h = await api("GET", `/api/editor/projects/${projectId}/timeline`);
      const sq = (h.json as { sequence: { luts?: Array<{ id: string }>; clips: Array<{ lutId?: string | null }> } }).sequence;
      if (sq.luts?.length && sq.clips[0]?.lutId === sq.luts[0].id) { redoOk = true; break; }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  results.redoReappliedLut = redoOk;
  const seq8 = (await api("GET", `/api/editor/projects/${projectId}/timeline`)).json as { sequence: { luts?: Array<{ id: string }> } };

  // LUT removal via the panel remove button
  const removeBtn = panel.getByRole("button", { name: /remove/i }).first();
  if (await removeBtn.count()) { await removeBtn.click(); await page.waitForTimeout(500); }
  results.lutRemovedViaUi = await pollLut((lut) => lut === null || lut === undefined);
  // re-apply for the render parity check (via the canonical timeline API)
  const head9 = await api("GET", `/api/editor/projects/${projectId}/timeline`);
  if (seq8?.luts?.[0]?.id) await api("POST", `/api/editor/projects/${projectId}/timeline`, { baseVersion: (head9.json as { version: number }).version, edits: [{ type: "SetClipLut", clipId, lutId: seq8.luts[0].id }] });

  // ── reload: persistence through a fresh page load ──
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  let reselected = false;
  for (let i = 0; i < 20 && !reselected; i++) {
    const b = page.locator(`[data-clip-id="${clipId}"]`).first();
    if (await b.count()) {
      const bb = await b.boundingBox();
      if (bb && bb.width > 6) {
        await page.mouse.click(bb.x + Math.max(8, bb.width * 0.3), bb.y + bb.height / 2);
        reselected = true;
        break;
      }
    }
    const any2 = page.locator("[data-clip-id]").first();
    if (await any2.count()) {
      const bb2 = await any2.boundingBox();
      if (bb2 && bb2.width > 6) {
        await page.mouse.click(bb2.x + Math.max(8, bb2.width * 0.3), bb2.y + bb2.height / 2);
        reselected = true;
        break;
      }
    }
    await page.waitForTimeout(1000);
  }
  results.clipReSelectedAfterReload = reselected;
  await page.waitForTimeout(1200);
  const panel2 = page.getByTestId("color-grade-panel");
  results.panelAfterReload = await panel2.isVisible().catch(() => false);
  const lutSelect = panel2.locator("select");
  let lutSelected = false;
  for (let i = 0; i < 6 && !lutSelected; i++) {
    lutSelected = (await lutSelect.inputValue().catch(() => "")) !== "";
    if (!lutSelected) await page.waitForTimeout(1000);
  }
  results.lutSelectedAfterReload = lutSelected;
  await shot("p1-09-after-reload");

  // ── layout diagnostics: overlap/clipping of panel controls ──
  const boxes = await panel2.evaluate((root) => {
    const out: Array<{ k: string; x: number; y: number; w: number; h: number; clipped: boolean }> = [];
    root.querySelectorAll("input[type=range], select, button").forEach((el, i) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      out.push({ k: `${el.tagName}${i}`, x: r.x, y: r.y, w: r.width, h: r.height, clipped: r.width === 0 || r.height === 0 });
    });
    return out;
  });
  const overlaps = boxes.filter((a, i) => boxes.some((b, j) => j > i && Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2 && !a.clipped && !b.clipped));
  results.layoutControlsMeasured = boxes.length;
  results.layoutClippedControls = boxes.filter((b) => b.clipped).length;
  results.layoutCoincidentOverlaps = overlaps.length;
  if (boxes.some((b) => b.clipped)) layoutIssues.push("clipped controls present");
  const panelBox = await panel2.boundingBox();
  if (panelBox && (panelBox.height < 300 || panelBox.width < 200)) layoutIssues.push(`panel box suspiciously small ${JSON.stringify(panelBox)}`);

  // ── capture final diagnostics ──
  results.consoleErrors = consoleErrors.slice(0, 6);
  results.pageErrors = pageErrors.slice(0, 6);
  results.failedRequests = failedRequests.slice(0, 6);
  results.http4xx5xx = http4xx5xx.slice(0, 8);
  results.layoutIssues = layoutIssues;
} catch (e) {
  results.fatal = String(e).slice(0, 400);
  await shot("p1-99-fatal").catch(() => undefined);
}
writeFileSync(`${OUT}/p1-ui-verification.json`, JSON.stringify(results, null, 1));
await browser.close();
console.log(JSON.stringify(results, null, 1));
