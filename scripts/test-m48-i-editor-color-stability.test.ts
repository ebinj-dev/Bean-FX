/**
 * M48-I stabilization — ColorGradePanel cold-load regression (live, browser).
 *
 * Covers the M48-I follow-up defect report ("panel does not mount on some
 * cold loads despite a selected VIDEO clip"). 24 independent cold-load
 * trials across BOTH navigation paths (direct hash-route entry and in-app
 * hashchange navigation), each asserting the ColorGradePanel mounts with a
 * selected VIDEO clip. Also asserts the stale-project rule: after navigating
 * to an invalid project id the panel must NOT mount and no stale clip may
 * remain in the inspector (use-editor-session clears sequence/selection on
 * a failed timeline load).
 *
 * Run: BASE=http://localhost:3130 bun test scripts/test-m48-i-editor-color-stability.test.ts
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { chromium } from "playwright";
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";

const BASE = process.env.BASE ?? "http://localhost:3130";
const OUT = "/home/z/my-project/download/m48-j/preview";
mkdirSync(OUT, { recursive: true });

let cookie = "";
let email = "";
let password = "";
let projectId = "";
let clipId = "";
let browser: import("playwright").Browser | null = null;
let page: import("playwright").Page | null = null;

const api = async (m: string, p: string, body?: unknown) => {
  const r = await fetch(`${BASE}${p}`, { method: m, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  for (const raw of r.headers.getSetCookie?.() ?? []) if (raw.startsWith("beanfx_session=")) cookie = raw.split(";")[0];
  return { status: r.status, json: await r.json().catch(() => null) as never };
};

const instrument = async () => {
  await page!.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__console = [] as string[];
    const origErr = console.error.bind(console);
    console.error = (...a: unknown[]) => { (w.__console as string[]).push(`E:${a.map(String).join(" ").slice(0, 160)}`); origErr(...a); };
    window.addEventListener("error", (e) => (w.__console as string[]).push(`PAGEERR:${String(e.message).slice(0, 160)}`));
  });
};

const selectClipViaTimeline = async (clip: string) => {
  for (let i = 0; i < 15; i++) {
    const b = page!.locator(`[data-clip-id="${clip}"]`).first();
    if (await b.count()) {
      const bb = await b.boundingBox().catch(() => null);
      if (bb && bb.width > 6) { await page!.mouse.click(bb.x + Math.max(8, bb.width * 0.35), bb.y + bb.height / 2); return true; }
    }
    await page!.waitForTimeout(1000);
  }
  return false;
};

const openEditorAndMountPanel = async (path: "A" | "B", pid: string, clip: string) => {
  if (path === "A") {
    await page!.goto(`${BASE}/#/editor?project=${pid}`, { waitUntil: "domcontentloaded" });
  } else {
    await page!.goto(`${BASE}/#/home`, { waitUntil: "domcontentloaded" });
    await page!.waitForTimeout(1500);
    await page!.evaluate((p) => { window.location.hash = `#/editor?project=${p}`; }, pid);
  }
  await page!.waitForTimeout(2500);
  expect(await selectClipViaTimeline(clip)).toBe(true);
  let mounted = false;
  for (let i = 0; i < 20 && !mounted; i++) {
    mounted = await page!.getByTestId("color-grade-panel").isVisible().catch(() => false);
    if (!mounted) await page!.waitForTimeout(1000);
  }
  return mounted;
};

let serverUp = false;
beforeAll(async () => {
  try {
    const h = await fetch(`${BASE}/api/health`);
    serverUp = h.ok;
  } catch { serverUp = false; }
  if (!serverUp) return;

  email = `stab-${Date.now().toString(36)}@beanfx.test`;
  password = `Stab-${Date.now().toString(36)}aA9`;
  const reg = await api("POST", "/api/auth/register", { email, password, name: "Stab", acceptedDraftTerms: true });
  if (reg.status >= 300 || !cookie) throw new Error(`register failed ${reg.status}`);
  const pr = await api("POST", "/api/projects", { name: `stab ${Date.now().toString(36)}` });
  projectId = (pr.json as { project: { id: string } }).project.id;
  const fx = `/tmp/stab-test-${Date.now().toString(36)}.mp4`;
  spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "smptebars=size=480x270:rate=30:duration=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", fx], { encoding: "utf8" });
  const up = await fetch(`${BASE}/api/media`, { method: "POST", headers: { "Content-Type": "video/mp4", "x-project-id": projectId, "x-filename": "bars.mp4", "x-asset-role": "SOURCE_FOOTAGE", Cookie: cookie }, body: readFileSync(fx) });
  const upBody = await up.json().catch(() => null) as { media?: { id?: string }; asset?: { id?: string }; id?: string } | null;
  const assetId = upBody?.media?.id ?? upBody?.asset?.id ?? upBody?.id ?? "";
  if (!assetId) throw new Error(`upload failed status=${up.status}`);
  const head = await api("GET", `/api/editor/projects/${projectId}/timeline`) as { json: { version: number; sequence: { tracks: Array<{ id: string; kind: string }> } } };
  const v1 = (head.json as { sequence: { tracks: Array<{ id: string; kind: string }> } }).sequence.tracks.find((t) => t.kind === "VIDEO")!.id;
  clipId = `stabclip-${Date.now().toString(36)}`;
  await api("POST", `/api/editor/projects/${projectId}/timeline`, { baseVersion: (head.json as unknown as { version: number }).version, edits: [{ type: "AddClip", clip: { id: clipId, trackId: v1, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: 90, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 90, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: null, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [], audioSourceInFrame: null, audioSourceOutFrame: null, avLinked: true } }] });

  browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome", args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await instrument();
  // genuine UI login once
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
});

describe("M48-I stabilization — ColorGradePanel cold-load + stale-project regression", () => {
  test("24 cold-load trials across both navigation paths — panel mounts every time", async () => {
    if (!serverUp || !browser || !page) { console.log("SKIP: live server not reachable — run with BASE=http://localhost:3130"); return; }
    const results: Array<{ trial: number; path: string; mounted: boolean }> = [];
    for (let trial = 1; trial <= 24; trial++) {
      const path = trial % 2 === 1 ? "A:direct-hash" : "B:in-app-nav";
      const mounted = await openEditorAndMountPanel(trial % 2 === 1 ? "A" : "B", projectId, clipId);
      results.push({ trial, path, mounted });
      if (!mounted) await page.screenshot({ path: `${OUT}/stab-fail-trial${trial}.png` }).catch(() => undefined);
    }
    writeFileSync(`${OUT}/coldload-regression.json`, JSON.stringify({ results, total: results.length, mounted: results.filter((r) => r.mounted).length }, null, 1));
    expect(results.filter((r) => r.mounted).length).toBe(24);
    expect(results.filter((r) => r.path.startsWith("A")).length).toBe(12);
    expect(results.filter((r) => r.path.startsWith("B")).length).toBe(12);
  }, 600_000);

  test("stale project navigation: invalid project id clears sequence + panel does not mount", async () => {
    if (!serverUp || !browser || !page) { console.log("SKIP: live server not reachable — run with BASE=http://localhost:3130"); return; }
    // load the valid project, select the clip (panel mounts)
    expect(await openEditorAndMountPanel("A", projectId, clipId)).toBe(true);
    // navigate to a project id that does not exist
    await page.evaluate(() => { window.location.hash = "#/editor?project=nonexistent000000000000000"; });
    await page.waitForTimeout(4000);
    const stalePanel = await page.getByTestId("color-grade-panel").isVisible().catch(() => false);
    expect(stalePanel).toBe(false);
    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(/PROPERTIES INSPECTOR/.test(bodyText) && /Volume|Transform/.test(bodyText)).toBe(false);
  }, 120_000);
});
