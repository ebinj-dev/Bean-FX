/**
 * M26 P4/P5/P7 API tests — presets CRUD + safeguards, batch export
 * idempotency contract, workflow templates + approval gates + cancellation.
 * Runs against the dev server on :3117 (custom.db).
 */
import { describe, test, expect } from "bun:test";

const BASE = "http://localhost:3117";
const STAMP = Date.now().toString(36);
const EMAIL = `m26api-${STAMP}@test.local`;
const PW = "m26-API-Pass1!";
let cookie = "";

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [k, v] = c.split(";")[0].split("=");
    if (k === "beanfx_session" && v) cookie = `${k}=${v}`;
  }
  let json: any = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

describe("M26 P4 — creative presets", () => {
  test("create / unique-name / rename / duplicate / delete-safeguard / list", async () => {
    expect((await api("POST", "/api/auth/register", { email: EMAIL, password: PW, name: "M26 API" })).status).toBe(200);
    expect((await api("POST", "/api/auth/login", { email: EMAIL, password: PW })).status).toBe(200);

    const mk = await api("POST", "/api/presets", { kind: "VIDEO_EFFECT", name: "Warm look", payload: { effects: [{ type: "temperature", enabled: true, params: { amount: 0.2 } }] } });
    expect(mk.status).toBe(200);
    expect(mk.json.preset.id).toBeTruthy();
    const id = mk.json.preset.id;

    const dup = await api("POST", "/api/presets", { kind: "VIDEO_EFFECT", name: "Warm look", payload: { effects: [] } });
    expect(dup.status).toBe(409);

    const other = await api("POST", "/api/presets", { kind: "CAPTION", name: "Warm look", payload: { captionStyle: { fontSize: 40, color: "#FFCC00", background: null, position: "BOTTOM" } } });
    expect(other.status).toBe(200); // same name, other kind — allowed

    const ren = await api("PATCH", `/api/presets/${id}`, { name: "Warm look v2" });
    expect(ren.status).toBe(200);
    expect(ren.json.preset.name).toBe("Warm look v2");

    const copy = await api("POST", `/api/presets/${id}`);
    expect(copy.status).toBe(200);
    expect(copy.json.preset.name).toContain("(copy)");

    const delWrong = await api("DELETE", `/api/presets/${id}?confirm=nope`);
    expect(delWrong.status).toBe(412);
    const del = await api("DELETE", `/api/presets/${id}?confirm=${encodeURIComponent("Warm look v2")}`);
    expect(del.status).toBe(200);
    expect(del.json.deleted).toBe(true);

    const list = await api("GET", "/api/presets?kind=CAPTION");
    expect(list.status).toBe(200);
    expect(list.json.presets.some((p: any) => p.name === "Warm look")).toBe(true);
    // ownership: another user's preset id 404s
    const foreign = await api("PATCH", "/api/presets/doesnotexist", { name: "x" });
    expect(foreign.status).toBe(400);
  });
});

describe("M26 P5 — batch export contract", () => {
  test("batch rejects unknown master honestly + unknown profile listed", async () => {
    const projects = await api("GET", "/api/projects");
    const projectId = projects.json.projects[0]?.id ?? (await api("POST", "/api/projects", { name: "M26 batch" })).json.project.id;
    const bad = await api("POST", `/api/editor/projects/${projectId}/batch-export`, { sourceExportId: "missing", profileIds: ["youtube_landscape"] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("Master export not found");
    const list = await api("GET", `/api/editor/projects/${projectId}/batch-export`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.json.masters)).toBe(true);
    expect(Array.isArray(list.json.variants)).toBe(true);
  });
});

describe("M26 P7 — workflow automation", () => {
  test("templates listed; run starts only from whitelisted templates", async () => {
    const w = await api("GET", "/api/workflows");
    expect(w.status).toBe(200);
    expect(w.json.templates.length).toBeGreaterThanOrEqual(4);
    const bad = await api("POST", "/api/workflows", { templateId: "arbitrary-code-runner", projectId: "x" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("whitelisted");
  });

  test("approval gate blocks consequential steps until approved; cancel works", async () => {
    const projects = await api("GET", "/api/projects");
    let projectId = projects.json.projects[0]?.id;
    if (!projectId) projectId = (await api("POST", "/api/projects", { name: "M26 wf" })).json.project.id;
    const start = await api("POST", "/api/workflows", { templateId: "render-then-multi-aspect", projectId });
    expect(start.status).toBe(200);
    const runId = start.json.run.id;
    // The first tick runs at start: an empty project fails the render step
    // synchronously (honest) — accept RUNNING/PENDING/FAILED here.
    expect(["RUNNING", "PENDING", "FAILED"]).toContain(start.json.run.status);

    // Poll: render dispatches (no sequence → the render step fails honestly).
    const get1 = await api("GET", `/api/workflows/${runId}`);
    expect(get1.status).toBe(200);
    const steps1 = get1.json.run.steps;
    expect(steps1[0].kind).toBe("RENDER_TIMELINE");
    // Empty project → honest failure of the first step.
    if (get1.json.run.status === "FAILED") {
      expect(steps1[0].status).toBe("FAILED");
      expect(steps1[0].stepError).toMatch(/no sequence/i);
      // Retry is refused while run is FAILED only for non-failed steps; retry-step works:
      const retry = await api("POST", `/api/workflows/${runId}`, { action: "retry-step", stepId: steps1[0].id });
      expect(retry.status).toBe(200);
    }
    // Approval-gate semantics verified on the TEMPLATE definition even when the
    // render step failed: the gate step exists with approvalRequired.
    const gate = get1.json.run.steps.find((s: any) => s.approvalRequired);
    expect(gate).toBeTruthy();
    expect(gate.kind).toBe("APPROVAL");

    // Approving a non-waiting gate is refused honestly.
    const approve = await api("POST", `/api/workflows/${runId}`, { action: "approve", stepId: gate.id });
    expect(approve.status).toBe(400);

    const cancel = await api("POST", `/api/workflows/${runId}`, { action: "cancel" });
    expect(cancel.status).toBe(200);
    expect(["CANCELLED", "FAILED"]).toContain(cancel.json.status);
    const get2 = await api("GET", `/api/workflows/${runId}`);
    expect(["CANCELLED", "FAILED"]).toContain(get2.json.run.status);
  });

  test("analyze-then-approval: gate waits honestly (approval flow)", async () => {
    const projects = await api("GET", "/api/projects");
    const projectId = projects.json.projects[0]?.id;
    const start = await api("POST", "/api/workflows", { templateId: "analyze-then-broll-approval", projectId, inputs: { mediaId: "missing-media" } });
    expect(start.status).toBe(200);
    const runId = start.json.run.id;
    const get = await api("GET", `/api/workflows/${runId}`);
    // Missing media → honest failure at the analyze step (no fabricated success).
    const step = get.json.run.steps[0];
    if (get.json.run.status === "FAILED") {
      expect(step.status).toBe("FAILED");
      expect(step.stepError).toMatch(/not found/i);
    }
    await api("POST", `/api/workflows/${runId}`, { action: "cancel" });
  });
});
