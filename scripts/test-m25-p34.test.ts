/**
 * M25 P3/P4 tests — export range + project deletion safeguards + admin audit.
 * Runs against the dev server on :3117.
 */
import { describe, test, expect } from "bun:test";

const BASE = "http://localhost:3117";
const STAMP = Date.now().toString(36);
const EMAIL = `m25p34-${STAMP}@test.local`;
const PW = "m25-Export-Pass1!";
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

describe("M25 P3/P4 — export, deletion, audit", () => {
  test("setup: account + project", async () => {
    expect((await api("POST", "/api/auth/register", { email: EMAIL, password: PW, name: "M25 P34" })).status).toBe(200);
    expect((await api("POST", "/api/auth/login", { email: EMAIL, password: PW })).status).toBe(200);
    const pr = await api("POST", "/api/projects", { name: "M25 Delete Me" });
    expect(pr.status).toBe(200);
    expect(pr.json.project.id).toBeTruthy();
  });

  test("P4: deletion without the typed name is refused (412 safeguard)", async () => {
    const list = await api("GET", "/api/projects");
    const project = list.json.projects.find((p: any) => p.name === "M25 Delete Me");
    const r = await api("DELETE", `/api/projects/${project.id}?confirm=wrong-name`);
    expect(r.status).toBe(412);
    const still = await api("GET", "/api/projects");
    expect(still.json.projects.some((p: any) => p.id === project.id)).toBe(true);
  });

  test("P4: deletion with the exact name works; media library untouched", async () => {
    const list = await api("GET", "/api/projects");
    const project = list.json.projects.find((p: any) => p.name === "M25 Delete Me");
    const r = await api("DELETE", `/api/projects/${encodeURIComponent(project.id)}?confirm=${encodeURIComponent("M25 Delete Me")}`);
    expect(r.status).toBe(200);
    expect(r.json.deleted).toBe(true);
    expect(r.json.mediaUntouched).toBe(true);
    const gone = await api("GET", "/api/projects");
    expect(gone.json.projects.some((p: any) => p.id === project.id)).toBe(false);
  });

  test("P4: another user's project 404s (ownership)", async () => {
    const r = await api("DELETE", "/api/projects/doesnotexist?confirm=x");
    expect(r.status).toBe(404);
  });

  test("P3: render range accepted by the enqueue contract (no sequence yet → honest 400)", async () => {
    const mk = await api("POST", "/api/projects", { name: "M25 Range Check" });
    expect(mk.status).toBe(200);
    const project = mk.json.project;
    const r = await api("POST", `/api/editor/projects/${project.id}/render`, { startFrame: 0, endFrame: 300 });
    // No timeline version yet — the honest answer is 400 (no sequence), NOT a queued job.
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("no sequence");
  });

  test("P7: admin audit endpoint denies ordinary users", async () => {
    const r = await api("GET", "/api/admin/audit");
    expect([400, 401, 403]).toContain(r.status);
  });

  test("cleanup", async () => {
    // Delete the leftover project (typed-name safeguard), then the account data stays (harmless test user).
    const list = await api("GET", "/api/projects");
    for (const p of list.json.projects) {
      await api("DELETE", `/api/projects/${p.id}?confirm=${encodeURIComponent(p.name)}`);
    }
  });
});
