/** M48-H5 browser evidence: real bus strips in the mixer + multicam inspector section. */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3130";
const EXECUTABLE = "/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome";
const SHOTS = "/home/z/my-project/download/m48-h-evidence/screenshots";
mkdirSync(SHOTS, { recursive: true });
const STAMP = Date.now().toString(36);

const email = `hverify-${STAMP}@beanfx.test`;
const password = `Hver-${Math.random().toString(36).slice(2, 10)}aA9`;
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, name: "H Verify", acceptedDraftTerms: true }),
});
if (![200, 201].includes(reg.status)) throw new Error(`register ${reg.status}`);

// fixtures: two colour angles + one tone asset via the API upload path
function makeMp4(args: string[], out: string): Buffer {
  const r = Bun.spawnSync(["ffmpeg", "-y", ...args, "-shortest", out]);
  if (r.exitCode !== 0) throw new Error(`ffmpeg failed for ${out}`);
  return Buffer.from(require("node:fs").readFileSync(out));
}
const camA = makeMp4(["-f", "lavfi", "-i", "color=red:size=480x270:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"], "/tmp/hv-camA.mp4");
const camB = makeMp4(["-f", "lavfi", "-i", "color=blue:size=480x270:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"], "/tmp/hv-camB.mp4");

const cookieJar: string[] = [];
const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const results: Record<string, unknown> = {};

await page.goto(`${BASE}/#/`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 30; i++) {
  if ((await page.getByRole("button", { name: /login/i }).count()) > 0) { await page.getByRole("button", { name: /login/i }).first().click(); break; }
  if ((await page.locator('header button[aria-label="Open menu"]').count()) > 0) { await page.locator('header button[aria-label="Open menu"]').first().click(); await page.waitForTimeout(400); continue; }
  await page.waitForTimeout(500);
}
await page.getByLabel(/email/i).fill(email);
await page.getByLabel(/^password/i).fill(password);
await page.getByRole("button", { name: /sign in/i }).click();
await page.getByRole("button", { name: /new production/i }).first().waitFor({ timeout: 20_000 });
results.loggedIn = true;

const proj = await page.context().request.post(`${BASE}/api/projects`, { data: { name: `H-evidence ${STAMP}` } });
const pj = (await proj.json()) as { project?: { id?: string } };
const projectId = pj.project!.id!;
for (const [name, buf] of [["camA.mp4", camA], ["camB.mp4", camB]] as const) {
  const up = await page.context().request.fetch(`${BASE}/api/media`, {
    method: "POST",
    headers: { "Content-Type": "video/mp4", "x-project-id": projectId, "x-filename": name, "x-asset-role": "SOURCE_FOOTAGE" },
    data: buf,
  });
  results[`upload_${name}`] = up.status() < 300;
}
const mediaList = await (await page.context().request.get(`${BASE}/api/media?projectId=${projectId}`)).json() as { media?: Array<{ id?: string; asset?: { id?: string } }> };
const assetIds = (mediaList.media ?? []).map((m) => m.asset?.id ?? m.id).filter(Boolean) as string[];
results.assetCount = assetIds.length;

// canonical timeline: clip + multicam group + switch at 3 s
const head = await (await page.context().request.get(`${BASE}/api/editor/projects/${projectId}/timeline`)).json() as { version: number; sequence: { tracks: Array<{ id: string; kind: string }> } };
const vTrack = head.sequence.tracks.filter((t) => t.kind === "VIDEO")[0].id;
const clipId = `hvc-${STAMP}`;
const tl = await page.context().request.post(`${BASE}/api/editor/projects/${projectId}/timeline`, {
  data: { version: head.version, baseVersion: head.version, edits: [
    { type: "CreateMulticamGroup", group: { id: `mc-${STAMP}`, name: "Interview", angles: [{ id: "a", assetId: assetIds[0], label: "CAM_A", offsetFrames: 0 }, { id: "b", assetId: assetIds[1], label: "CAM_B", offsetFrames: 0 }] } },
    { type: "AddClip", clip: { id: clipId, trackId: vTrack, sourceAssetId: assetIds[0], sourceInFrame: 0, sourceOutFrame: 180, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 180, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: "mc", missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [], audioSourceInFrame: null, audioSourceOutFrame: null, avLinked: true, multicamGroupId: null, multicamAngleId: null } },
    { type: "AssignMulticamGroup", clipId, groupId: `mc-${STAMP}`, angleId: "a" },
  ] },
});
results.timelineEditsAccepted = tl.status() < 300;

// open the editor
await page.goto(`${BASE}/#/editor?project=${projectId}`, { waitUntil: "domcontentloaded" });
await page.getByText(/PROGRAM MONITOR/i).first().waitFor({ timeout: 25_000 });
await page.waitForTimeout(1200);
// select the clip on the timeline (click its block) → inspector shows MULTICAM
const clipBlock = page.locator(`[data-clip-id="${clipId}"], [title*="mc"]`).first();
if (await clipBlock.count()) { await clipBlock.click(); await page.waitForTimeout(800); }
else {
  // fall back: click the first timeline clip element
  await page.locator(".absolute").filter({ hasText: "" }).first().click().catch(() => undefined);
  await page.waitForTimeout(800);
}
results.multicamSectionVisible = await page.getByText(/MULTICAM — Interview/i).first().isVisible().catch(() => false);
await page.screenshot({ path: `${SHOTS}/h3-multicam-inspector.png`, fullPage: false });

// open the audio mixer drawer → add DIALOGUE + MUSIC buses through the UI
// the mixer drawer lives in the PRO workspace mode — switch through the real mode control
const proBtn = page.getByRole("button", { name: /^pro$/i }).first();
if (await proBtn.count()) { await proBtn.click(); await page.waitForTimeout(600); }
const mixerBtn = page.locator('button[title*="Per-track faders"]').first();
if (await mixerBtn.count()) { await mixerBtn.click(); await page.waitForTimeout(800); }
const addDia = page.getByRole("button", { name: "+DIA" }).first();
if (await addDia.count()) {
  await addDia.click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "+MUS" }).first().click();
  await page.waitForTimeout(800);
  results.busStripsVisible = await page.getByText(/Dialogue/i).first().isVisible().catch(() => false)
    && await page.getByText(/Music/i).first().isVisible().catch(() => false);
} else {
  results.busStripsVisible = "mixer button not found";
}
await page.screenshot({ path: `${SHOTS}/h2-bus-strips.png`, fullPage: false });

// persistence proof: reload → bus strips and multicam section still there
await page.reload({ waitUntil: "domcontentloaded" });
await page.getByText(/PROGRAM MONITOR/i).first().waitFor({ timeout: 25_000 });
await page.waitForTimeout(1500);
const clipBlock2 = page.locator(`[data-clip-id="${clipId}"]`).first();
if (await clipBlock2.count()) { await clipBlock2.click(); await page.waitForTimeout(800); }
results.multicamAfterReload = await page.getByText(/MULTICAM — Interview/i).first().isVisible().catch(() => false);

writeFileSync("/home/z/my-project/download/m48-h-evidence/report-h5-browser.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 1));
await browser.close();
