/**
 * M25 P2 tests — billing & subscription foundation (payments disabled).
 * Covers: catalog, default FREE subscription, payments-disabled blocks, admin
 * manual assignment, server-side entitlement enforcement (projects, AI calls),
 * cancel/resume state machine, period renewal, cancel-then-downgrade, and
 * admin-only authorization.
 * Runs against the dev server on :3117 (custom.db).
 */
import { describe, test, expect } from "bun:test";
import { scratchLegacyDb } from "./legacy-fixture";

const BASE = "http://localhost:3117";
const STAMP = Date.now().toString(36);
/** Per-actor cookie jars: jar objects are mutated by the helper. */
function makeApi() {
  let jar = "";
  return async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}${p}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(jar ? { Cookie: jar } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [k, v] = c.split(";")[0].split("=");
      if (k === "beanfx_session" && v) jar = `${k}=${v}`;
    }
    let json: any = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
  };
}
const userApi = makeApi();
const adminApi = makeApi();

/** Direct DB helpers for bulk usage rows + period manipulation. */
async function withDb(fn: (db: any) => Promise<void>): Promise<void> {
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = scratchLegacyDb("m25-billing"); // M34 Track B: isolated fixture, never db/custom.db
  const mod = await import("../src/lib/db");
  await fn(mod.db);
  await mod.db.$disconnect();
}

describe("M25 P2 — billing foundation", () => {
  const EMAIL = `m25bill-${STAMP}@test.local`;
  const ADMIN_EMAIL = `m25admin-${STAMP}@test.local`;
  const PW = "m25-Billing-Pass1!";

  test("setup: user + admin accounts", async () => {
    const reg = await userApi("POST", "/api/auth/register", { email: EMAIL, password: PW, name: "M25 Billing" });
    expect(reg.status).toBe(200);
    const login = await userApi("POST", "/api/auth/login", { email: EMAIL, password: PW });
    expect(login.status).toBe(200);
    const regA = await adminApi("POST", "/api/auth/register", { email: ADMIN_EMAIL, password: PW, name: "M25 Admin" });
    expect(regA.status).toBe(200);
    const loginA = await adminApi("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: PW });
    expect(loginA.status).toBe(200);
    await withDb(async (db) => { await db.user.update({ where: { email: ADMIN_EMAIL }, data: { role: "admin" } }); });
  });

  test("catalog: three plans, payments disabled, no prices exposed", async () => {
    const r = await userApi("GET", "/api/billing/plans");
    expect(r.status).toBe(200);
    expect(r.json.plans.map((p: any) => p.id)).toEqual(["free", "creator", "studio"]);
    expect(r.json.paymentsEnabled).toBe(false);
    for (const p of r.json.plans) {
      const j = JSON.stringify(p).toLowerCase();
      expect(j.includes("price") || j.includes("$") || j.includes("usd")).toBe(false);
    }
  });

  test("default subscription: FREE with usage snapshot", async () => {
    const r = await userApi("GET", "/api/billing/subscription");
    expect(r.status).toBe(200);
    expect(r.json.subscription.planId).toBe("free");
    expect(r.json.subscription.provider).toBe("none");
    expect(r.json.usage).toHaveProperty("projects");
    expect(r.json.usage).toHaveProperty("aiCalls");
    expect(r.json.entitlements.maxProjects).toBeNull();
  });

  test("self-serve switch to paid plan is blocked honestly (PAYMENTS_DISABLED)", async () => {
    const r = await userApi("POST", "/api/billing/subscription", { planId: "creator" });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("PAYMENTS_DISABLED");
    const h = await userApi("GET", "/api/billing/history");
    expect(h.json.events.some((e: any) => e.type === "PAYMENTS_DISABLED_BLOCK")).toBe(true);
    const s = await userApi("GET", "/api/billing/subscription");
    expect(s.json.subscription.planId).toBe("free");
  });

  test("FREE user can still create projects (no enforcement on unlimited)", async () => {
    const r = await userApi("POST", "/api/projects", { name: "M25 free check" });
    expect(r.status).toBe(200);
    await withDb(async (db) => { await db.project.deleteMany({ where: { userId: { not: undefined }, name: "M25 free check" } }); });
  });

  test("admin-only: ordinary user cannot assign plans", async () => {
    const r = await userApi("POST", "/api/admin/billing", { email: EMAIL, planId: "creator" });
    expect([400, 401, 403]).toContain(r.status);
  });

  test("admin manual assignment works and is audited", async () => {
    const r = await adminApi("POST", "/api/admin/billing", { email: EMAIL, planId: "creator" });
    expect(r.status).toBe(200);
    expect(r.json.assigned.planId).toBe("creator");
    const h = await userApi("GET", "/api/billing/history");
    expect(h.json.events.some((e: any) => e.type === "ADMIN_OVERRIDE")).toBe(true);
    const s = await userApi("GET", "/api/billing/subscription");
    expect(s.json.subscription.planId).toBe("creator");
    expect(s.json.entitlements.maxProjects).toBe(25);
  });

  test("enforcement: maxProjects (25) — 26th project rejected 402 PLAN_LIMIT", async () => {
    // Ensure exactly 25 exist first.
    const list = await userApi("GET", "/api/projects");
    const have = list.json.projects.length;
    for (let i = have; i < 25; i++) {
      const r = await userApi("POST", "/api/projects", { name: `M25 filler ${i}` });
      expect(r.status).toBe(200);
    }
    const over = await userApi("POST", "/api/projects", { name: "M25 overflow" });
    expect(over.status).toBe(402);
    expect(over.json.code).toBe("PLAN_LIMIT");
    expect(over.json.limit).toBe("maxProjects");
    expect(over.json.max).toBe(25);
  });

  test("enforcement: monthlyAiCalls (2000) — chat rejected after bulk usage rows", async () => {
    await withDb(async (db) => {
      const user = await db.user.findUnique({ where: { email: EMAIL } });
      const rows = Array.from({ length: 2000 }, () => ({
        userId: user.id, provider: "test", model: "test-model", purpose: "test",
        promptTokens: 0, completionTokens: 0, totalTokens: 0,
      }));
      await db.aIUsage.createMany({ data: rows });
    });
    const r = await userApi("POST", "/api/my-ai/chat", { message: "hi" });
    expect(r.status).toBe(402);
    expect(r.json.code).toBe("PLAN_LIMIT");
    expect(r.json.limit).toBe("monthlyAiCalls");
    expect(r.json.used).toBe(2000);
  });

  test("cancel/resume state machine (creator plan)", async () => {
    const c = await userApi("POST", "/api/billing/cancel");
    expect(c.status).toBe(200);
    expect(c.json.cancelAtPeriodEnd).toBe(true);
    const dup = await userApi("POST", "/api/billing/cancel");
    expect(dup.json.unchanged).toBe(true);
    const s = await userApi("GET", "/api/billing/subscription");
    expect(s.json.subscription.cancelAtPeriodEnd).toBe(true);
    const r = await userApi("POST", "/api/billing/resume");
    expect(r.status).toBe(200);
    expect(r.json.cancelAtPeriodEnd).toBe(false);
    const h = await userApi("GET", "/api/billing/history");
    const types = h.json.events.map((e: any) => e.type);
    expect(types).toContain("CANCEL_SCHEDULED");
    expect(types).toContain("CANCEL_RESUMED");
  });

  test("free plan has nothing to cancel (honest 400)", async () => {
    // Move user to free first.
    await adminApi("POST", "/api/admin/billing", { email: EMAIL, planId: "free" });
    const c = await userApi("POST", "/api/billing/cancel");
    expect(c.status).toBe(400);
    const s = await userApi("GET", "/api/billing/subscription");
    expect(s.json.subscription.planId).toBe("free");
  });

  test("period renewal without charge + cancelled period ends → downgrade to FREE", async () => {
    // Assign creator again, schedule cancel, force the period into the past.
    await adminApi("POST", "/api/admin/billing", { email: EMAIL, planId: "creator" });
    await userApi("POST", "/api/billing/cancel");
    await withDb(async (db) => {
      const user = await db.user.findUnique({ where: { email: EMAIL } });
      await db.subscription.update({ where: { userId: user.id }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } });
    });
    const s = await userApi("GET", "/api/billing/subscription");
    expect(s.json.subscription.planId).toBe("free");
    expect(s.json.subscription.status).toBe("ACTIVE");
    expect(s.json.subscription.cancelAtPeriodEnd).toBe(false);
    const h = await userApi("GET", "/api/billing/history");
    const types = h.json.events.map((e: any) => e.type);
    expect(types).toContain("SUBSCRIPTION_ENDED");
    // Renewal path (no cancel): PERIOD_RENEWED.
    await adminApi("POST", "/api/admin/billing", { email: EMAIL, planId: "creator" });
    await withDb(async (db) => {
      const user = await db.user.findUnique({ where: { email: EMAIL } });
      await db.subscription.update({ where: { userId: user.id }, data: { currentPeriodEnd: new Date(Date.now() - 1000), cancelAtPeriodEnd: false } });
    });
    const s2 = await userApi("GET", "/api/billing/subscription");
    expect(s2.json.subscription.planId).toBe("creator");
    const h2 = await userApi("GET", "/api/billing/history");
    expect(h2.json.events.map((e: any) => e.type)).toContain("PERIOD_RENEWED");
  });

  test("cleanup: remove test user data", async () => {
    await withDb(async (db) => {
      await db.user.deleteMany({ where: { email: { in: [EMAIL, ADMIN_EMAIL] } } });
    });
  });
});
