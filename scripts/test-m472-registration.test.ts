/**
 * M47.2-C — registration acknowledgement consistency tests (bypass attempts).
 *
 * The UI requires an explicit unchecked-by-default acknowledgement of the
 * DRAFT Terms + AI Processing Policy. These tests prove the API enforces the
 * same contract against direct requests: missing → 400, false → 400, true →
 * account created. The acknowledgement is factual (draft documents only) — no
 * binding consent record, no policy version.
 *
 * Run (server on :3118): M472_BASE=http://localhost:3118 bun test scripts/test-m472-registration.test.ts
 */
import { describe, test, expect } from "bun:test";

const BASE = process.env.M472_BASE ?? "http://localhost:3118";
const STAMP = Date.now().toString(36);

async function register(payload: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe("registration acknowledgement — server-side enforcement", () => {
  test("missing acknowledgement → 400 with a clear validation error (bypass refused)", async () => {
    const r = await register({ email: `m472-reg-miss-${STAMP}@beanfx.test`, password: `Reg${STAMP}9k`, name: "M47.2 bypass probe" });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/acceptedDraftTerms/);
    expect(String(r.json.error)).toMatch(/draft/); // the error itself states the draft status
  });

  test("acknowledgement false → 400 (bypass refused)", async () => {
    const r = await register({ email: `m472-reg-false-${STAMP}@beanfx.test`, password: `Reg${STAMP}9k`, name: "M47.2 bypass probe", acceptedDraftTerms: false });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/acceptedDraftTerms/);
  });

  test("acknowledgement true → account created; no binding-consent claim in the response", async () => {
    const r = await register({ email: `m472-reg-true-${STAMP}@beanfx.test`, password: `Reg${STAMP}9k`, name: "M47.2 register", acceptedDraftTerms: true });
    expect(r.status).toBeLessThan(300);
    expect(r.json.user).toBeTruthy();
    // The response must NOT claim final-policy acceptance or a consent version.
    const s = JSON.stringify(r.json);
    expect(s).not.toMatch(/policyVersion|acceptedVersion|binding/i);
  });

  test("non-boolean acknowledgement (e.g. string \"true\") → 400 — no type coercion", async () => {
    const r = await register({ email: `m472-reg-str-${STAMP}@beanfx.test`, password: `Reg${STAMP}9k`, name: "M47.2 bypass probe", acceptedDraftTerms: "true" });
    expect(r.status).toBe(400);
  });
});
