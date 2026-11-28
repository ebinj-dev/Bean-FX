/** M48-I browser evidence: grading panel live, grade canvas active, slider dispatch. */
import { chromium } from "playwright";
import { writeFileSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
const BASE = process.env.BASE ?? "http://localhost:3130";
const SHOTS = "/home/z/my-project/download/m48-i-evidence/screenshots";
const STAMP = Date.now().toString(36);
const results: Record<string, unknown> = {};
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
try {
  // fixture: static bars (same generator as the parity suite)
  const fx = `/tmp/i-verify-${STAMP}.mp4`;
  spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "smptebars=size=480x270:rate=30:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", fx], { encoding: "utf8" });
  let cookie = "";
  const api = async (m: string, p: string, body?: unknown) => {
    const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const raw of r.headers.getSetCookie?.() ?? []) if (raw.startsWith("beanfx_session=")) cookie = raw.split(";")[0];
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  await api("POST", "/api/auth/register", { email: `i-verify-${STAMP}@test.local`, password: "i-verify-pass-1", name: "IV", acceptedDraftTerms: true });
  const pr = await api("POST", "/api/projects", { name: `I verify ${STAMP}` });
  const projectId = (pr.json as { project: { id: string } }).project.id;
  const up = await fetch(`${BASE}/api/media`, { method: "POST", headers: { "Content-Type": "video/mp4", "x-project-id": projectId, "x-filename": "bars.mp4", "x-asset-role": "SOURCE_FOOTAGE", Cookie: cookie }, body: readFileSync(fx) });
  const upText = await up.text();
  let assetId = "";
  try { const j = JSON.parse(upText) as { asset?: { id?: string }; media?: { id?: string }; id?: string }; assetId = j.asset?.id ?? j.media?.id ?? j.id ?? ""; } catch { /* non-JSON */ }
  results.assetUploaded = Boolean(assetId);
  results.assetUploadStatus = up.status;
  const head = await api("GET", `/api/editor/projects/${projectId}/timeline`);
  const hj = head.json as { version: number; sequence: { tracks: Array<{ id: string; kind: string }> } };
  const v1 = hj.sequence.tracks.find((t) => t.kind === "VIDEO")!.id;
  const tl = await api("POST", `/api/editor/projects/${projectId}/timeline`, { baseVersion: hj.version, edits: [
    { type: "AddClip", clip: { id: `iv-${STAMP}`, trackId: v1, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: 90, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 90, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: null, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [], audioSourceInFrame: null, audioSourceOutFrame: null, avLinked: true } },
    { type: "SetClipGrade", clipId: `iv-${STAMP}`, grade: { bypass: false, exposure: 0.4, temperature: 0.3, tint: 0, contrast: 1.2, pivot: 0.5, highlights: 0.15, shadows: -0.2, whites: 0.1, blacks: -0.1, liftR: 0, liftG: 0, liftB: 0.03, gammaR: 1.05, gammaG: 1, gammaB: 1, gainR: 1.05, gainG: 1, gainB: 0.98, red: 1.02, green: 1, blue: 0.99, saturation: 1.25, vibrance: 0.25 } },
  ] });
  results.timelineAccepted = tl.status < 300;

  await page.goto(`${BASE}/editor?project=${projectId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  results.editorLoaded = await page.getByText(/PROGRAM MONITOR/i).first().isVisible().catch(() => false);
  // select the clip in the timeline (click its block) → inspector COLOR panel
  const clipBlock = page.locator(`[data-clip-id="iv-${STAMP}"], [data-id="iv-${STAMP}"]`).first();
  if (await clipBlock.count()) await clipBlock.click();
  else await page.locator(".timeline [data-clip-id]").first().click().catch(() => undefined);
  await page.waitForTimeout(1200);
  results.colorPanelVisible = await page.getByTestId("color-grade-panel").isVisible().catch(() => false);
  results.gradeCanvasActive = await page.getByTestId("grade-canvas").isVisible().catch(() => false);
  // move the exposure slider (dispatches SetClipGrade through the canonical path)
  const exposure = page.getByTestId("color-grade-panel").locator('input[type="range"]').first();
  if (await exposure.count()) {
    await exposure.evaluate((el) => { const input = el as HTMLInputElement; input.value = "1"; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.waitForTimeout(600);
    const head2 = await api("GET", `/api/editor/projects/${projectId}/timeline`);
    const seq2 = (head2.json as { sequence: { clips: Array<{ grade?: { exposure?: number } }> } }).sequence;
    results.sliderDispatchPersisted = seq2.clips[0]?.grade?.exposure === 1;
  }
  await page.screenshot({ path: `${SHOTS}/i-grading-panel.png` });
  // scopes panel
  const scopesBtn = page.getByRole("button", { name: /scopes/i }).first();
  if (await scopesBtn.count()) { await scopesBtn.click(); await page.waitForTimeout(800); }
  results.scopesVisible = await page.getByText(/WAVEFORM|HISTOGRAM/i).first().isVisible().catch(() => false);
  await page.screenshot({ path: `${SHOTS}/i-scopes.png` });
  results.consoleErrors = errors.slice(0, 3);
} catch (e) {
  results.fatal = String(e).slice(0, 300);
}
writeFileSync("/home/z/my-project/download/m48-i-evidence/report-i-browser.json", JSON.stringify(results, null, 1));
await browser.close();
console.log(JSON.stringify(results));
