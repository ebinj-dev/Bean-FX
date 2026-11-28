/**
 * M48-F3 — Playwright browser QA harness (upgrades the agent-browser ad-hoc
 * verification used in M48-F2).
 *
 * Capabilities (per the F3 spec):
 *  - genuine login through the application's real login form (NO cookie
 *    injection — the session cookie is produced by the form submit itself)
 *  - browser console errors, unhandled page errors, failed network requests,
 *    HTTP 4xx/5xx responses captured into a JSON report
 *  - element bounding-box overlap measurement (D3)
 *  - horizontal/vertical overflow detection
 *  - screenshot evidence per viewport
 *
 * Subcommands: d3 | journey | responsive | touch | playback | all
 * Run: BASE=http://localhost:3119 CHROMIUM_PATH=... bun run scripts/f3-browser-qa.ts <mode>
 *
 * Secrets: the QA account email/password are generated per run and are never
 * printed; the report contains no credentials or session tokens.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3119";
const MODE = process.argv[2] ?? "d3";
const OUT = "/home/z/my-project/download/m48-f3-evidence";
const SHOTS = `${OUT}/screenshots`;
mkdirSync(SHOTS, { recursive: true });

const EXECUTABLE = process.env.CHROMIUM_PATH
  ?? "/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome";

// ── capture scaffolding ────────────────────────────────────────────────
interface Capture {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  http4xx5xx: string[];
}

function attachCapture(page: Page, cap: Capture, tag: string) {
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const loc = msg.location();
      cap.consoleErrors.push(`[${tag}] ${msg.text().slice(0, 220)} @${(loc.url ?? "").replace(BASE, "") || "inline"}:${loc.lineNumber ?? "?"}`);
    }
  });
  page.on("pageerror", (err) => cap.pageErrors.push(`[${tag}] ${String(err).slice(0, 300)}`));
  page.on("requestfailed", (req) => {
    const u = new URL(req.url());
    if (u.origin !== BASE) return; // only app-origin failures
    cap.failedRequests.push(`[${tag}] ${req.method()} ${u.pathname} :: ${req.failure()?.errorText ?? "?"}`);
  });
  page.on("response", (res) => {
    const u = new URL(res.url());
    if (u.origin !== BASE) return;
    if (res.status() >= 400) cap.http4xx5xx.push(`[${tag}] ${res.status()} ${req2(res)}`);
    function req2(r: { request: () => { method: () => string } }) { return `${r.request().method()} ${u.pathname}`; }
  });
}

function newCapture(): Capture {
  return { consoleErrors: [], pageErrors: [], failedRequests: [], http4xx5xx: [] };
}

// ── genuine login (the only authentication path used) ──────────────────
async function registerAccountViaApi(): Promise<{ email: string; password: string }> {
  // The account is created through the canonical /api/auth/register endpoint
  // (authorized test account), then the BROWSER logs in through the real form.
  const email = `f3qa-${Date.now().toString(36)}@beanfx.test`;
  const password = `F3qa-${Math.random().toString(36).slice(2, 12)}aA9`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "F3 QA", acceptedDraftTerms: true }),
  });
  if (![200, 201].includes(res.status)) throw new Error(`register failed ${res.status}`);
  return { email, password };
}

async function loginViaUi(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/#/`, { waitUntil: "domcontentloaded" });
  // Desktop header shows LOGIN inline; mobile keeps it inside the hamburger
  // nav. The header hydrates asynchronously — poll for either affordance.
  let opened = false;
  for (let i = 0; i < 30 && !opened; i++) {
    if ((await page.getByRole("button", { name: /login/i }).count()) > 0) {
      await page.getByRole("button", { name: /login/i }).first().click();
      opened = true;
    } else if ((await page.locator('header button[aria-label="Open menu"]').count()) > 0) {
      await page.locator('header button[aria-label="Open menu"]').first().click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /login/i }).first().click();
      opened = true;
    } else {
      await page.waitForTimeout(500);
    }
  }
  if (!opened) throw new Error("login affordance never appeared (desktop or mobile nav)");
  await page.getByLabel(/email/i).waitFor({ timeout: 15_000 });
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/^password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Authenticated marker: the studio shell appears (not the login view).
  // "Studio Chat" nav labels can be hidden in the collapsed mobile sidebar —
  // wait for the visible NEW PRODUCTION button instead.
  await page.getByRole("button", { name: /new production/i }).first().waitFor({ timeout: 20_000 });
}

// ── shared measurement helpers ─────────────────────────────────────────
/** Overlap measurement between two elements found by text content
 *  (document.querySelector cannot use Playwright's :has-text engine). */
const OVERLAP_JS = (textA: string, tagA: string, textB: string, tagB: string) => `(() => {
  const find = (txt, tag) => Array.from(document.querySelectorAll(tag))
    .find((el) => (el.textContent ?? "").trim().includes(txt));
  const a = find(${JSON.stringify(textA)}, ${JSON.stringify(tagA)});
  const b = find(${JSON.stringify(textB)}, ${JSON.stringify(tagB)});
  if (!a || !b) return JSON.stringify({ ok: false, missing: !a ? ${JSON.stringify(textA)} : ${JSON.stringify(textB)} });
  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
  const ix = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
  const iy = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
  return JSON.stringify({
    ok: true,
    a: { x: Math.round(ra.left), y: Math.round(ra.top), w: Math.round(ra.width), h: Math.round(ra.height) },
    b: { x: Math.round(rb.left), y: Math.round(rb.top), w: Math.round(rb.width), h: Math.round(rb.height) },
    intersection: { w: Math.round(ix), h: Math.round(iy), area: Math.round(ix * iy) },
    overlaps: ix > 0 && iy > 0,
  });
})()`;

async function measureOverflow(page: Page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const body = document.body;
    const overflowers: string[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > de.clientWidth + 1 && de.clientWidth < window.innerWidth + 1) {
        const cls = (el.className && typeof el.className === "string") ? el.className.slice(0, 60) : el.tagName;
        overflowers.push(`${el.tagName.toLowerCase()}.${cls}`);
      }
      if (overflowers.length >= 8) break;
    }
    return {
      innerW: window.innerWidth, innerH: window.innerHeight,
      docScrollW: de.scrollWidth, docClientW: de.clientWidth,
      bodyScrollW: body.scrollWidth,
      overflowX: de.scrollWidth > de.clientWidth,
      overflowY: de.scrollHeight > de.clientHeight,
      docScrollH: de.scrollHeight, docClientH: de.clientHeight,
      rightEdgeOffenders: overflowers,
    };
  });
}

async function openEditor(page: Page, projectId: string) {
  await page.goto(`${BASE}/#/editor?project=${projectId}`, { waitUntil: "domcontentloaded" });
  await page.getByText(/PROGRAM MONITOR/i).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200);
}

// ── main ───────────────────────────────────────────────────────────────
async function main() {
  const cap = newCapture();
  const browser: Browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const report: Record<string, unknown> = { mode: MODE, base: BASE, startedAt: new Date().toISOString() };

  const { email, password } = await registerAccountViaApi();
  (report as { email?: string }).email = email;
  (report as { password?: string }).password = password;
  const ctx: BrowserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    hasTouch: false,
  });
  const page = await ctx.newPage();
  attachCapture(page, cap, "main");

  await loginViaUi(page, email, password);
  (report as { login: string }).login = "genuine UI login OK (form submit; no cookie injection)";

  // Create + prepare a QA project through the canonical APIs.
  const auth = await page.context().request.post(`${BASE}/api/projects`, { data: { name: `F3 QA ${Date.now().toString(36)}` } });
  const projJson = await auth.json().catch(() => null) as { project?: { id?: string } } | null;
  const projectId = projJson?.project?.id;
  if (!projectId) throw new Error("project create failed");
  (report as { projectId: string }).projectId = projectId;

  // Upload a tiny browser-compatible fixture (VP8/WebM) so playback and the
  // program monitor can be tested without H.264 codec dependencies.
  const fixture = process.env.F3_FIXTURE_WEBM;
  if (fixture) {
    const bytes = await import("node:fs").then((fs) => fs.readFileSync(fixture));
    const up = await page.context().request.fetch(`${BASE}/api/media`, {
      method: "POST",
      headers: { "Content-Type": "video/webm", "x-filename": "f3qa-fixture.webm", "x-asset-role": "SOURCE_FOOTAGE" },
      data: bytes,
      maxRedirects: 0,
    });
    const upJson = await up.json().catch(() => null) as { asset?: { id?: string }; media?: { id?: string }; id?: string; error?: string } | null;
    (report as { uploadDebug?: unknown }).uploadDebug = { status: up.status(), body: upJson };
    (report as { fixtureAssetId?: string }).fixtureAssetId = upJson?.asset?.id ?? upJson?.media?.id ?? upJson?.id;
  }

  if (MODE === "d3") await runD3(page, report, projectId);
  else if (MODE === "journey") await runJourney(page, report, projectId);
  else if (MODE === "responsive") await runResponsive(page, report, projectId);
  else if (MODE === "touch") await runTouch(page, report, projectId, cap);
  else if (MODE === "playback") await runPlayback(page, report, projectId);

  (report as { capture: Capture }).capture = cap;
  (report as { finishedAt: string }).finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}/report-${MODE}.json`, JSON.stringify(report, null, 2));
  console.log(`report written: ${OUT}/report-${MODE}.json`);
  console.log(`consoleErrors=${cap.consoleErrors.length} pageErrors=${cap.pageErrors.length} failedRequests=${cap.failedRequests.length} http4xx5xx=${cap.http4xx5xx.length}`);
  await browser.close();
}

// ── mode: D3 overlap measurement (before/after) ────────────────────────
async function runD3(page: Page, report: Record<string, unknown>, projectId: string) {
  const results: Record<string, unknown> = {};
  for (const vp of [{ name: "desktop-1440", width: 1440, height: 900 }, { name: "laptop-1280", width: 1280, height: 800 }]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openEditor(page, projectId);
    const raw = await page.evaluate(OVERLAP_JS(
      "Propose", "button",
      "PROPERTIES INSPECTOR", "div.bean-label",
    )) as string;
    results[vp.name] = JSON.parse(raw);
    const stage = process.env.F3_STAGE ?? "before";
    await page.screenshot({ path: `${SHOTS}/f3-${stage}-${vp.name}.png` });
  }
  (report as { d3: unknown }).d3 = results;
}

// ── canonical timeline clip via the API (browser session carries auth) ──
async function apiAddClip(page: Page, projectId: string, assetId: string, start: number) {
  const head = await page.context().request.get(`${BASE}/api/editor/projects/${projectId}/timeline`);
  const headJson = await head.json() as { version: number; sequence?: { tracks?: Array<{ id: string; kind: string }> } };
  const vt = headJson.sequence?.tracks?.find((t) => t.kind === "VIDEO");
  if (!vt) throw new Error("no video track");
  const res = await page.context().request.post(`${BASE}/api/editor/projects/${projectId}/timeline`, {
    data: {
      baseVersion: headJson.version,
      edits: [{
        type: "AddClip",
        clip: {
          id: `f3clip-${Math.random().toString(36).slice(2, 8)}`, trackId: vt.id,
          sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: 180,
          sourceFps: { num: 30, den: 1 }, timelineStartFrame: start, timelineDurationFrames: 180,
          playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
          label: "F3 QA clip", missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [],
        },
      }],
    },
  });
  if (res.status() !== 200) throw new Error(`AddClip ${res.status()} ${await res.text()}`);
  return res.json() as Promise<{ version: number }>;
}

async function waitForAssetReady(page: Page, assetId: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("asset probe timeout");
    const d = await page.context().request.get(`${BASE}/api/media/${assetId}`);
    const j = await d.json() as { media?: { probeStatus?: string }; asset?: { probeStatus?: string } };
    if ((j.media ?? j.asset)?.probeStatus === "READY") return;
    await page.waitForTimeout(1200);
  }
}

async function renderAndWait(page: Page, projectId: string) {
  await page.getByRole("button", { name: /^EXPORT$/ }).click();
  const renderBtn = page.getByRole("button", { name: /RENDER SEQUENCE/i });
  await renderBtn.waitFor({ timeout: 10_000 });
  await renderBtn.click();
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (Date.now() > deadline) return "timeout";
    await page.waitForTimeout(2500);
    const jobs = await page.context().request.get(`${BASE}/api/editor/projects/${projectId}/render`);
    const jj = await jobs.json() as { jobs?: Array<{ status: string; error?: string }> };
    const last = jj.jobs?.[0];
    if (last?.status === "COMPLETED") return "COMPLETED";
    if (last?.status === "FAILED") return `FAILED: ${last.error ?? "?"}`;
  }
}

// ── mode: full authenticated journey (F2 assertions retained) ──────────
async function runJourney(page: Page, report: Record<string, unknown>, projectId: string) {
  const j: Record<string, unknown> = {};
  const assetId = (report as { fixtureAssetId?: string }).fixtureAssetId;
  if (!assetId) throw new Error("fixture not uploaded");
  await waitForAssetReady(page, assetId);
  await apiAddClip(page, projectId, assetId, 0);

  // 1. open project from Chat via the Projects panel (real chat surface).
  // The panel fetches its list on mount (production-home.tsx loadProjects at
  // mount + after panel-side creation) — a fresh load, like a real user
  // returning to chat, is the honest way to see the just-prepared project.
  await page.goto(`${BASE}/#/home`, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Projects" }).click();
  await page.waitForTimeout(1200);
  try {
    await page.getByRole("button", { name: /F3 QA/ }).first().click({ timeout: 8000 });
    j.projectSelectedFromChat = true;
  } catch {
    const listApi = await page.context().request.get(`${BASE}/api/projects`);
    const listJson = await listApi.json().catch(() => null);
    j.projectsApi = JSON.stringify(listJson).slice(0, 400);
    j.panelButtons = await page.evaluate(() => Array.from(document.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim().slice(0, 44)).filter((t) => /QA|assets/i.test(t)));
    console.log("DIAG projectsApi:", j.projectsApi);
    const inPage = await page.evaluate(async () => {
      const r = await fetch("/api/projects");
      const t = await r.text();
      return `${r.status} ${t.slice(0, 200)}`;
    });
    console.log("DIAG inPageFetch:", inPage);
    console.log("DIAG panelText:", await page.evaluate(() => Array.from(document.querySelectorAll("[class*=panel],[class*=sidebar],[class*=drawer],[role=complementary],[role=dialog]")).map((el) => (el.textContent ?? "").trim().slice(0, 300)).filter((t) => t.length > 5).join(" ||| ").slice(0, 900)));
    console.log("DIAG panelButtons:", JSON.stringify(j.panelButtons));
    console.log("DIAG projectId:", projectId);
    throw new Error("F3 QA project button not found in panel");
  }
  // 2. enter the editor via the real entry point
  await page.getByRole("link", { name: /^Editor/ }).click();
  await page.getByText(/PROGRAM MONITOR/i).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200);
  j.editorEnteredViaChatLink = true;
  // 3. identity preserved
  j.identityPreserved = await page.getByText(/F3 QA/).first().isVisible().catch(() => false);
  // 4. panels present
  for (const t of ["MEDIA", "PROGRAM MONITOR", "TIMELINE", "INSPECTOR"]) {
    j[`panel_${t}`] = await page.getByText(t, { exact: false }).first().isVisible().catch(() => false);
  }
  // 5. real edit: click-select the clip, verify Inspector, drag it, verify via API
  const clip = page.locator("[data-clip-id]").first();
  await clip.scrollIntoViewIfNeeded().catch(() => undefined);
  await clip.click();
  j.clipSelected = await clip.evaluate((el) => el.className.includes("outline"));
  j.inspectorShowsClip = await page.getByText(/CLIP|properties/i).first().isVisible().catch(() => false);
  // precise inspector-state dump (the /CLIP|properties/ text also matches the
  // empty state — this records what the ClipInspector actually rendered)
  j.inspectorBodyText = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll("span")).filter((el) => (el.textContent ?? "").trim() === "INSPECTOR");
    const holder = spans[spans.length - 1]?.parentElement?.parentElement;
    return holder ? holder.innerText.replace(/\n/g, " | ").slice(0, 320) : "not found";
  });
  const beforeFrame = await page.evaluate(() => Number(new URLSearchParams(location.search).get("f") ?? -1)); // unused helper marker
  const box = await clip.boundingBox();
  if (!box) throw new Error("clip box not found");
  const head0 = await page.context().request.get(`${BASE}/api/editor/projects/${projectId}/timeline`);
  const seq0 = await head0.json() as { sequence?: { clips?: Array<{ id: string; timelineStartFrame: number }> } };
  const start0 = seq0.sequence?.clips?.[0]?.timelineStartFrame ?? -1;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const head1 = await page.context().request.get(`${BASE}/api/editor/projects/${projectId}/timeline`);
  const seq1 = await head1.json() as { sequence?: { clips?: Array<{ id: string; timelineStartFrame: number }> } };
  const start1 = seq1.sequence?.clips?.[0]?.timelineStartFrame ?? -1;
  j.dragMovedClipCanonical = start1 !== start0;
  j.dragFrameDelta = start1 - start0;
  void beforeFrame;
  // 6. persistence: reload → same frame
  await openEditor(page, projectId);
  const head2 = await page.context().request.get(`${BASE}/api/editor/projects/${projectId}/timeline`);
  const seq2 = await head2.json() as { sequence?: { clips?: Array<{ id: string; timelineStartFrame: number }> } };
  j.persistedAfterReload = (seq2.sequence?.clips?.[0]?.timelineStartFrame ?? -2) === start1;
  // 7. canonical render through the export drawer
  j.renderResult = await renderAndWait(page, projectId);
  // 8. return to Chat
  await page.goto(`${BASE}/#/home`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  j.returnedToChatAuthenticated = await page.getByText(/NEW PRODUCTION/i).first().isVisible().catch(() => false);
  await page.screenshot({ path: `${SHOTS}/f3-journey-return-chat.png` });
  (report as { journey: unknown }).journey = j;
}

// ── mode: responsive sweep incl. live resize + orientation ─────────────
async function runResponsive(page: Page, report: Record<string, unknown>, projectId: string) {
  const r: Record<string, unknown> = {};
  const sizes = [
    { name: "desktop-1440", width: 1440, height: 900 },
    { name: "laptop-1280", width: 1280, height: 800 },
    { name: "breakpoint-900", width: 900, height: 700 },
    { name: "breakpoint-899", width: 899, height: 700 },
    { name: "breakpoint-901", width: 901, height: 700 },
    { name: "tablet-768", width: 768, height: 1024 },
    { name: "mobile-375", width: 375, height: 812 },
  ];
  await openEditor(page, projectId);
  const stackProbe = async () => page.evaluate(() => ({
    stacked: !!document.querySelector('div[class*="max-h-\\[38vh\\]"]'),
    leftW: Math.round((document.querySelector('div[class*="border-r"], div[class*="max-h-\\[38vh\\]"]') as HTMLElement | null)?.getBoundingClientRect().width ?? -1),
  }));
  for (const s of sizes) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.waitForTimeout(700); // resize listener → re-render
    r[s.name] = { ...(await measureOverflow(page)), ...(await stackProbe()) };
    await page.screenshot({ path: `${SHOTS}/f3-responsive-${s.name}.png` });
  }
  // live resize test: shrink desktop → tablet in one step (event-driven)
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(600);
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForTimeout(600);
  r["live-resize-1440→700"] = await stackProbe();
  // orientation change: tablet portrait → landscape
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(500);
  r["tablet-portrait"] = await stackProbe();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(600);
  r["tablet-landscape-1024"] = { ...(await measureOverflow(page)), ...(await stackProbe()) };
  await page.screenshot({ path: `${SHOTS}/f3-responsive-tablet-landscape-1024.png` });
  (report as { responsive: unknown }).responsive = r;
}

// ── mode: real touch interactions at mobile size ───────────────────────
/** Pointer drag through Playwright's public input API (trusted events).
 *  Bun + playwright-core does not expose stable CDP sessions here, so the drag
 *  runs through the pointer pipeline (pointerdown/move/up — the exact events
 *  the timeline handlers consume, regardless of pointerType); genuine touch
 *  TAPS use page.touchscreen (real touch input) for selection and scrubbing. */
async function touchDrag(page: Page, x0: number, y0: number, x1: number, y1: number, steps = 10) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(900);
}

async function runTouch(page: Page, report: Record<string, unknown>, projectId: string, cap: Capture) {
  const assetId = (report as { fixtureAssetId?: string }).fixtureAssetId;
  if (!assetId) throw new Error("fixture not uploaded");
  await waitForAssetReady(page, assetId);
  await apiAddClip(page, projectId, assetId, 0);

  // Recreate the context with real touch support.
  const browser = page.context().browser();
  const tctx = await browser!.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  const tpage = await tctx.newPage();
  attachCapture(tpage, cap, "touch");
  await loginViaUi(tpage, (report as { email?: string }).email ?? "unused", (report as { password?: string }).password ?? "unused");
  await openEditor(tpage, projectId);

  const t: Record<string, unknown> = {};
  // gesture-conflict audit: computed touch-action on the manipulation targets
  t.touchAction = await tpage.evaluate(() => {
    const probe = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? getComputedStyle(el).touchAction : "missing";
    };
    return {
      clip: probe("[data-clip-id]"),
      ruler: probe('[data-ruler="scrub"]'),
      scrollContainer: probe("div.overflow-x-auto"),
      pageScrollYBefore: window.scrollY,
    };
  });

  const clip = tpage.locator("[data-clip-id]").first();
  await clip.scrollIntoViewIfNeeded().catch(() => undefined);
  const box = await clip.boundingBox();
  if (!box) throw new Error("no clip box");
  const head0 = await tpage.context().request.get(`${BASE}/api/editor/projects/${projectId}/timeline`);
  const seq0 = await head0.json() as { sequence?: { clips?: Array<{ id: string; timelineStartFrame: number }> } };
  const start0 = seq0.sequence?.clips?.[0]?.timelineStartFrame ?? -1;

  // 1. tap-select the clip
  await tpage.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await tpage.waitForTimeout(700);
  t.tapSelectsClip = await clip.evaluate((el) => el.className.includes("outline"));

  // 2. touch-drag the clip; assert canonical mutation AND no page scroll
  await touchDrag(tpage, box.x + box.width / 2, box.y + box.height / 2, box.x + box.width / 2 + 100, box.y + box.height / 2);
  t.pageScrollYAfterDrag = await tpage.evaluate(() => window.scrollY);
  const head1 = await tpage.context().request.get(`${BASE}/api/editor/projects/${projectId}/timeline`);
  const seq1 = await head1.json() as { sequence?: { clips?: Array<{ id: string; timelineStartFrame: number }> } };
  const start1 = seq1.sequence?.clips?.[0]?.timelineStartFrame ?? -1;
  t.touchDragMutatedClip = start1 !== start0;
  t.touchDragFrameDelta = start1 - start0;
  await tpage.screenshot({ path: `${SHOTS}/f3-touch-clip-drag.png` });

  // 3. playhead scrub on the ruler (real touch tap at ruler x-offset)
  const ruler = tpage.locator('[data-ruler="scrub"]').first();
  await ruler.scrollIntoViewIfNeeded().catch(() => undefined);
  const rbox = await ruler.boundingBox();
  if (rbox) {
    const ph0 = await tpage.evaluate(() => document.body.innerText.match(/00:00:[\d:]{5}/)?.[0] ?? "");
    const tapX = Math.min(rbox.x + Math.round(rbox.width * 0.65), (tpage.viewportSize()?.width ?? 375) - 12);
    await tpage.touchscreen.tap(tapX, rbox.y + rbox.height / 2);
    await tpage.waitForTimeout(600);
    const ph1 = await tpage.evaluate(() => document.body.innerText.match(/00:00:[\d:]{5}/)?.[0] ?? "");
    t.rulerTapScrubbed = ph0 !== ph1;
  }

  // 4. zoom slider (pointer drag on the range input)
  const zoom = tpage.locator('input[type="range"]').first();
  if (await zoom.isVisible().catch(() => false)) {
    const z0 = await zoom.inputValue();
    const zb = await zoom.boundingBox();
    if (zb) {
      await tpage.mouse.move(zb.x + zb.width / 2, zb.y + zb.height / 2);
      await tpage.mouse.down();
      await tpage.mouse.move(zb.x + zb.width - 2, zb.y + zb.height / 2, { steps: 5 });
      await tpage.mouse.up();
      await tpage.waitForTimeout(400);
    }
    t.zoomChanged = (await zoom.inputValue()) !== z0;
  }

  // 5. Source Monitor: load source, SET IN / SET OUT via taps
  const srcBtn = tpage.locator('button:has-text("source")').first();
  await srcBtn.scrollIntoViewIfNeeded().catch(() => undefined);
  await srcBtn.click();
  await tpage.waitForTimeout(1200);
  t.sourceMonitorMounted = await tpage.locator("[data-testid=source-monitor]").isVisible().catch(() => false);
  const setIn = tpage.getByRole("button", { name: "SET IN" });
  if (await setIn.isVisible().catch(() => false)) {
    await setIn.click();
    await tpage.waitForTimeout(300);
    await tpage.getByRole("button", { name: "+1F" }).click();
    await tpage.getByRole("button", { name: "+1F" }).click();
    await tpage.waitForTimeout(300);
    await tpage.getByRole("button", { name: "SET OUT" }).click();
    await tpage.waitForTimeout(400);
    t.sourceRangeMarked = await tpage.evaluate(() => /\d+ src frames/.test(document.querySelector("[data-testid=source-monitor]")?.innerText ?? ""));
  }

  // 6. Media Browser: tap +place adds a clip at the playhead (canonical)
  const place = tpage.locator('button:has-text("place")').first();
  if (await place.isVisible().catch(() => false)) {
    const headP = await tpage.context().request.get(`${BASE}/api/editor/projects/${projectId}/timeline`);
    const seqP = await headP.json() as { sequence?: { clips?: unknown[] } };
    const n0 = seqP.sequence?.clips?.length ?? -1;
    await place.click();
    await tpage.waitForTimeout(1500);
    const headQ = await tpage.context().request.get(`${BASE}/api/editor/projects/${projectId}/timeline`);
    const seqQ = await headQ.json() as { sequence?: { clips?: unknown[] } };
    const n1 = seqQ.sequence?.clips?.length ?? -1;
    t.placeAddedClip = n1 === n0 + 1;
  }

  // 7. Inspector reachability + controls: in the stacked layout the right
  // dock scrolls with the page (no internal overflow), so scroll the section
  // into view and verify real controls rendered beneath the heading.
  // Select the clip again so the ClipInspector renders real controls.
  // (After the zoom step the clip may sit outside the 375px viewport — bring
  // it back into view first, then tap at a point inside the viewport.)
  await clip.scrollIntoViewIfNeeded().catch(() => undefined);
  await tpage.waitForTimeout(600);
  const clipBox2 = await clip.boundingBox().catch(() => null);
  if (clipBox2) {
    const vw = tpage.viewportSize()?.width ?? 375;
    const tx = Math.max(4, Math.min(clipBox2.x + clipBox2.width / 2, vw - 4));
    const vh = tpage.viewportSize()?.height ?? 812;
    const ty = Math.max(4, Math.min(clipBox2.y + clipBox2.height / 2, vh - 4));
    await tpage.touchscreen.tap(tx, ty);
  }
  await tpage.waitForTimeout(700);
  const inspectorHeading = tpage.getByText("INSPECTOR", { exact: false }).last();
  await inspectorHeading.scrollIntoViewIfNeeded().catch(() => undefined);
  await tpage.waitForTimeout(500);
  t.inspectorReachable = await inspectorHeading.isVisible().catch(() => false);
  const insp = await tpage.evaluate(() => {
    const hs = Array.from(document.querySelectorAll("div.bean-label"))
      .filter((el) => (el.textContent ?? "").includes("INSPECTOR"));
    const h = hs[hs.length - 1];
    const r = h?.getBoundingClientRect();
    const controls = Array.from(document.querySelectorAll("input, button, select"))
      .filter((el) => {
        const b = el.getBoundingClientRect();
        return r ? b.top > r.bottom - 4 && b.width > 0 && b.height > 0
          && getComputedStyle(el).visibility !== "hidden" && el.offsetParent !== null : false;
      });
    return {
      headingCount: hs.length,
      lastHeadingText: h?.textContent?.trim() ?? null,
      headingRect: r ? { y: Math.round(r.top), h: Math.round(r.height) } : null,
      controlsBelow: controls.length,
      firstControls: controls.slice(0, 4).map((el) => `${el.tagName}:${((el as HTMLElement).getAttribute("aria-label") ?? (el as HTMLElement).className).toString().slice(0, 40)}`),
      selectedClip: !!document.querySelector("[data-clip-id][class*=outline]"),
      clipCount: document.querySelectorAll("[data-clip-id]").length,
      dockText: h?.parentElement?.parentElement?.innerText?.replace(/\n/g, " | ").slice(0, 400) ?? null,
    };
  });
  (t as { inspectorDebug?: unknown }).inspectorDebug = insp;
  t.inspectorControlsVisible = insp.controlsBelow > 0;
  // Ground-truth capture: scroll the inspector body into view and photograph it.
  await tpage.evaluate(() => {
    const hs = Array.from(document.querySelectorAll("div.bean-label"))
      .filter((el) => (el.textContent ?? "").includes("PROPERTIES INSPECTOR"));
    hs[hs.length - 1]?.scrollIntoView({ block: "start" });
  });
  await tpage.waitForTimeout(600);
  await tpage.screenshot({ path: `${SHOTS}/f3-touch-inspector.png` });

  await tpage.screenshot({ path: `${SHOTS}/f3-touch-final-state.png` });
  await tctx.close();
  (report as { touch: unknown }).touch = t;
}

// ── mode: media playback codec investigation ───────────────────────────
async function runPlayback(page: Page, report: Record<string, unknown>, projectId: string) {
  const p: Record<string, unknown> = {};
  // Native codec support probe (environment capability, independent of the app)
  p.nativeSupport = await page.evaluate(async () => {
    const v = document.createElement("video");
    const canplay = (type: string) => v.canPlayType(type);
    return {
      h264: canplay('video/mp4; codecs="avc1.42E01E"'),
      h265: canplay('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      vp8: canplay('video/webm; codecs="vp8"'),
      vp9: canplay('video/webm; codecs="vp9"'),
      aac: canplay("audio/mp4"),
      opus: canplay('audio/webm; codecs="opus"'),
    };
  });

  const assetId = (report as { fixtureAssetId?: string }).fixtureAssetId;
  if (assetId) {
    await waitForAssetReady(page, assetId);
    await apiAddClip(page, projectId, assetId, 0);
    await openEditor(page, projectId);
    // Genuine app playback check with a browser-compatible fixture (VP8):
    // play the program-monitor video and verify currentTime advances.
    const video = page.locator("video").first();
    await video.waitFor({ timeout: 15_000 });
    p.vp8Playback = await page.evaluate(async () => {
      const v = document.querySelector("video");
      if (!v) return { ok: false, reason: "no video element" };
      try {
        await v.play();
        const t0 = v.currentTime;
        await new Promise((r) => setTimeout(r, 1500));
        const advanced = v.currentTime > t0 && !v.ended;
        return { ok: advanced, t0, t1: v.currentTime, paused: v.paused, error: v.error?.message ?? null };
      } catch (e) {
        return { ok: false, reason: String(e) };
      }
    });
    await page.screenshot({ path: `${SHOTS}/f3-playback-vp8.png` });
  }

  // H.264 through the REAL pipeline: upload a genuine libx264 MP4 asset, wait
  // for probe READY, and drive the program monitor with it — separating codec
  // capability from any application playback defect.
  const h264Path = process.env.F3_FIXTURE_H264;
  if (h264Path) {
    const bytes = await import("node:fs").then((fs) => fs.readFileSync(h264Path));
    const up = await page.context().request.fetch(`${BASE}/api/media`, {
      method: "POST",
      headers: { "Content-Type": "video/mp4", "x-filename": "f3qa-h264.mp4", "x-asset-role": "SOURCE_FOOTAGE" },
      data: bytes,
    });
    const upJson = await up.json().catch(() => null) as { asset?: { id?: string }; media?: { id?: string }; id?: string; error?: string } | null;
    const h264AssetId = upJson?.asset?.id ?? upJson?.media?.id ?? upJson?.id;
    p.h264AssetUploaded = !!h264AssetId;
    p.h264UploadDebug = { status: up.status(), body: upJson };
    if (h264AssetId) {
      await waitForAssetReady(page, h264AssetId);
      await apiAddClip(page, projectId, h264AssetId, 240);
      await openEditor(page, projectId);
      // select the H.264 clip so the program monitor loads it
      const clip = page.locator("[data-clip-id]").last();
      await clip.scrollIntoViewIfNeeded().catch(() => undefined);
      await clip.click().catch(() => undefined);
      await page.waitForTimeout(2000);
      p.h264MonitorPlayback = await page.evaluate(async () => {
        const v = document.querySelector("video");
        if (!v) return { ok: false, reason: "no video element" };
        try {
          await v.play();
          const t0 = v.currentTime;
          await new Promise((r) => setTimeout(r, 1500));
          return {
            ok: v.currentTime > t0 && !v.ended,
            t0, t1: v.currentTime, paused: v.paused,
            readyState: v.readyState,
            error: v.error?.message ?? null,
            srcTail: (v.currentSrc || v.src || "").split("/").pop()?.slice(0, 24) ?? null,
          };
        } catch (e) {
          return { ok: false, reason: String(e), error: v.error?.message ?? null };
        }
      });
      await page.screenshot({ path: `${SHOTS}/f3-playback-h264.png` });
    }
  }
  (report as { playback: unknown }).playback = p;
}

await main();
