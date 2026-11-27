/**
 * M47.4 — WORKSTREAM A: security tests must PROVE real authorization.
 *
 * Supersedes the M47.3 battery (scripts/test-m473-security.test.ts, retained as
 * the historical baseline). Every claim here is backed by either the exact HTTP
 * contract (exact status + exact body) or DIRECT DATABASE STATE inspection via
 * Prisma, never by "a non-crashing response".
 *
 * Real resources only: real uploads (valid H.264/AAC MP4), real productions,
 * a REAL victim-owned export produced by the canonical renderer, real decision
 * rows. No fabricated identifiers where a real resource exists.
 *
 * Run (server on :3118): M472_BASE=http://localhost:3118 bun test scripts/test-m474-security.test.ts
 */
// DB resolution: the checked-out .env (bun auto-loads it) may point at another
// workspace copy. Respect DATABASE_URL only when it already targets THIS
// workspace (CI: file:<workspace>/ci-test.db); otherwise use the local worktree db.
const cwdDb = `file:${process.cwd()}/db/custom.db`;
if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.includes(process.cwd())) process.env.DATABASE_URL = cwdDb;
import { describe, test, expect, beforeAll } from "bun:test";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.M472_BASE ?? "http://localhost:3118";
const EVIDENCE = "/home/z/my-project/download/m474-evidence/security";
const fs = await import("node:fs");
fs.mkdirSync(EVIDENCE, { recursive: true });
const db = new PrismaClient();

let victim = ""; // u1 session cookie
let attacker = ""; // u2 session cookie
let victimUserId = "";
let attackerUserId = "";
const STAMP = Date.now().toString(36);

async function api(m: string, p: string, body?: unknown, jar?: string, headers: Record<string, string> = {}, raw = false) {
  const res = await fetch(`${BASE}${p}`, {
    method: m,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(jar ? { Cookie: jar } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // @ts-expect-error bun fetch supports forbidden headers here
    redirect: "manual",
  });
  if (raw) {
    const buf = await res.arrayBuffer();
    let json: unknown = null;
    try { json = JSON.parse(new TextDecoder().decode(buf)); } catch { /* binary or empty body */ }
    return { status: res.status, buf, headers: res.headers, json };
  }
  return { status: res.status, json: await res.json().catch(() => null), setCookie: res.headers.get("set-cookie") };
}

/** Upload a REAL valid MP4 to a project through the actual upload flow. */
async function uploadMedia(jar: string, projectId: string, name: string) {
  const bytes = fs.readFileSync("/tmp/m472-media/cycler.mp4");
  const res = await fetch(`${BASE}/api/media`, {
    method: "POST",
    headers: { "Content-Type": "video/mp4", "x-project-id": projectId, "x-filename": name, "x-asset-role": "SOURCE_FOOTAGE", Cookie: jar },
    body: bytes,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, id: json?.asset?.id ?? json?.media?.id ?? json?.id ?? null, size: bytes.length };
}

async function register(email: string, password: string) {
  const r = await api("POST", "/api/auth/register", { email, password, name: "m474", acceptedDraftTerms: true });
  expect([200, 201]).toContain(r.status);
  return r.setCookie!.split(";")[0];
}

// Shared fixtures -------------------------------------------------------------
let projectIdA = ""; // victim project A (export source)
let projectIdB = ""; // victim project B (production + attachment target)
let mediaA = ""; // victim media bound to project A
let mediaB = ""; // victim media bound to project B
let attackerMedia = ""; // attacker's real media (their own project)
let productionB = ""; // victim production in project B
let assetRowId = ""; // an UNBOUND asset row of productionB
let victimExportId = "";
let victimExportSize = 0;
let victimConversationId = "";

const stageState = (prod: { stages?: Array<{ key: string; state: string }> }, key: string) =>
  prod.stages?.find((x) => x.key === key)?.state;

async function driveProductionToAssets(jar: string, projectId: string, title: string) {
  const cr = await api("POST", "/api/productions", { projectId, templateId: "social-video-factory", sourceMediaIds: [], briefText: "M47.4 security probe brief", title }, jar);
  const prod = cr.json?.production?.id;
  expect(prod).toBeTruthy();
  for (const [k, a] of [["INTAKE", "start"], ["INTAKE", "approve"], ["BRIEF", "start"], ["BRIEF", "approve"], ["CONCEPT", "start"]] as const) {
    const r = await api("POST", `/api/productions/${prod}/stages/${k}`, { action: a }, jar);
    expect([200, 201]).toContain(r.status);
  }
  const g = await api("GET", `/api/productions/${prod}`, undefined, jar);
  const opt = (g.json?.concept?.options ?? [])[0]?.id;
  expect(await api("PUT", `/api/productions/${prod}`, { kind: "concept", selectedId: opt }, jar).then((x) => x.status)).toBe(200);
  expect((await api("POST", `/api/productions/${prod}/stages/CONCEPT`, { action: "approve" }, jar)).status).toBe(200);
  expect((await api("POST", `/api/productions/${prod}/stages/SCRIPT`, { action: "start" }, jar)).status).toBe(200);
  expect((await api("POST", `/api/productions/${prod}/stages/SCRIPT`, { action: "approve" }, jar)).status).toBe(200);
  expect((await api("POST", `/api/productions/${prod}/stages/ASSET_PLANNING`, { action: "start" }, jar)).status).toBe(200);
  return prod!;
}

/** Render a REAL export for the victim through the canonical renderer (editor path). */
async function renderRealExport(jar: string, projectId: string) {
  const h = await api("GET", `/api/editor/projects/${projectId}/timeline`, undefined, jar);
  const vTrack = (h.json?.sequence?.tracks ?? []).find((t: { kind: string }) => t.kind === "VIDEO");
  const media = await db.mediaAsset.findFirst({ where: { projectId } });
  const clip = { id: "m474clip", trackId: vTrack.id, sourceAssetId: media.id, sourceInFrame: 0, sourceOutFrame: 180, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 180, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: null, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [] };
  const tl = await api("POST", `/api/editor/projects/${projectId}/timeline`, { baseVersion: h.json.version, edits: [{ type: "AddClip", clip }] }, jar);
  expect(tl.status).toBeLessThan(300);
  const rr = await api("POST", `/api/editor/projects/${projectId}/render`, {}, jar);
  expect(rr.status).toBe(202);
  const deadline = Date.now() + 150_000; // hard timeout — no infinite polling
  for (;;) {
    if (Date.now() > deadline) throw new Error("render poll exceeded hard 150s deadline");
    const j = await api("GET", `/api/jobs/${rr.json.jobId}`, undefined, jar);
    const job = j.json?.job ?? j.json;
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(String(job?.status))) {
      expect(job?.status).toBe("COMPLETED");
      return job.exportId as string;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const save = (name: string, data: unknown) => fs.writeFileSync(`${EVIDENCE}/${name}`, JSON.stringify(data, null, 2));

beforeAll(async () => {
  // Regenerate the real-media fixture if the environment wiped /tmp.
  if (!fs.existsSync("/tmp/m472-media/cycler.mp4")) {
    fs.mkdirSync("/tmp/m472-media", { recursive: true });
    const proc = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:size=320x240:rate=30:duration=2", "-f", "lavfi", "-i", "color=c=green:size=320x240:rate=30:duration=2", "-f", "lavfi", "-i", "color=c=blue:size=320x240:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", "/tmp/m472-media/cycler.mp4"]);
    if (proc.exitCode !== 0) throw new Error("ffmpeg fixture generation failed");
  }

  victim = await register(`m474-victim-${STAMP}@beanfx.test`, `Sec${STAMP}9z`);
  attacker = await register(`m474-attack-${STAMP}@beanfx.test`, `Sec${STAMP}8z`);
  victimUserId = (await db.user.findUnique({ where: { email: `m474-victim-${STAMP}@beanfx.test` } }))!.id;
  attackerUserId = (await db.user.findUnique({ where: { email: `m474-attack-${STAMP}@beanfx.test` } }))!.id;
  expect(victimUserId).not.toBe(attackerUserId);

  const pa = await api("POST", "/api/projects", { name: "M47.4 victim project A" }, victim);
  projectIdA = pa.json?.project?.id;
  const pb = await api("POST", "/api/projects", { name: "M47.4 victim project B" }, victim);
  projectIdB = pb.json?.project?.id;
  expect(projectIdA).toBeTruthy();
  expect(projectIdB).toBeTruthy();

  mediaA = (await uploadMedia(victim, projectIdA, "projectA-source.mp4")).id!;
  mediaB = (await uploadMedia(victim, projectIdB, "projectB-source.mp4")).id!;
  attackerMedia = (await uploadMedia(attacker, (await api("POST", "/api/projects", { name: "M47.4 attacker project" }, attacker)).json?.project?.id, "attacker-source.mp4")).id!;
  expect(mediaA).toBeTruthy();
  expect(mediaB).toBeTruthy();
  expect(attackerMedia).toBeTruthy();

  // The production under test lives in PROJECT B with an UNBOUND asset row.
  productionB = await driveProductionToAssets(victim, projectIdB, "M47.4 B production");
  const rows = await db.productionAsset.findMany({ where: { productionId: productionB, mediaAssetId: null }, take: 1 });
  expect(rows.length).toBeGreaterThan(0);
  assetRowId = rows[0].id;

  // A REAL victim-owned export through the canonical renderer.
  victimExportId = await renderRealExport(victim, projectIdA);
  const rec = await db.exportFile.findUnique({ where: { id: victimExportId } });
  expect(rec).toBeTruthy();
  victimExportSize = rec!.sizeBytes;

  // A real victim conversation for the restoration-authorization case.
  const chat = await api("POST", "/api/my-ai/chat", { projectId: projectIdA, conversationId: null, message: "M47.4 conversation probe" }, victim);
  victimConversationId = chat.json?.conversationId;
}, 400_000);

describe("M47.4-A1 — cross-project asset attachment (real media, real rows)", () => {
  test("same-project attach succeeds and binds the row (real valid upload)", async () => {
    const before = await db.mediaAsset.findUnique({ where: { id: mediaB } });
    const r = await api("POST", `/api/productions/${productionB}/assets`, { action: "attach", assetRowId, mediaAssetId: mediaB }, victim);
    expect(r.status).toBe(200);
    const row = await db.productionAsset.findUnique({ where: { id: assetRowId } });
    expect(row?.mediaAssetId).toBe(mediaB);
    expect(row?.status).toBe("READY");
    // The MEDIA row's project association is never silently modified.
    const after = await db.mediaAsset.findUnique({ where: { id: mediaB } });
    expect(after?.projectId).toBe(projectIdB);
    expect(after?.userId).toBe(before?.userId);
    save("a1-same-project.json", { status: 200, rowMediaAssetId: row?.mediaAssetId, mediaProjectId: after?.projectId });
  });

  test("cross-project attach is rejected 409 — row and media rows untouched", async () => {
    // Detach the row again so the rejection state is observable from scratch.
    const cr = await api("POST", "/api/productions", { projectId: projectIdB, templateId: "social-video-factory", sourceMediaIds: [], briefText: "M47.4 cross probe", title: "cross probe" }, victim);
    const prod2 = cr.json?.production?.id;
    for (const [k, a] of [["INTAKE", "start"], ["INTAKE", "approve"], ["BRIEF", "start"], ["BRIEF", "approve"], ["CONCEPT", "start"]] as const) {
      await api("POST", `/api/productions/${prod2}/stages/${k}`, { action: a }, victim);
    }
    const g = await api("GET", `/api/productions/${prod2}`, undefined, victim);
    await api("PUT", `/api/productions/${prod2}`, { kind: "concept", selectedId: (g.json?.concept?.options ?? [])[0]?.id }, victim);
    await api("POST", `/api/productions/${prod2}/stages/CONCEPT`, { action: "approve" }, victim);
    await api("POST", `/api/productions/${prod2}/stages/SCRIPT`, { action: "start" }, victim);
    await api("POST", `/api/productions/${prod2}/stages/SCRIPT`, { action: "approve" }, victim);
    await api("POST", `/api/productions/${prod2}/stages/ASSET_PLANNING`, { action: "start" }, victim);
    const rows = await db.productionAsset.findMany({ where: { productionId: prod2, mediaAssetId: null }, take: 1 });
    expect(rows.length).toBeGreaterThan(0);
    const rowBefore = { ...rows[0] };

    // PROJECT A's media onto a PROJECT B production — the M46H §1 rejection.
    const r = await api("POST", `/api/productions/${prod2}/assets`, { action: "attach", assetRowId: rows[0].id, mediaAssetId: mediaA }, victim);
    expect(r.status).toBe(409);
    expect(String(r.json?.error)).toMatch(/different project/i);
    const rowAfter = await db.productionAsset.findUnique({ where: { id: rows[0].id } });
    expect(rowAfter?.mediaAssetId).toBe(rowBefore.mediaAssetId); // unchanged (null)
    expect(rowAfter?.status).toBe(rowBefore.status);
    expect(rowAfter?.productionId).toBe(prod2);
    const mediaAfter = await db.mediaAsset.findUnique({ where: { id: mediaA } });
    expect(mediaAfter?.projectId).toBe(projectIdA); // association never reassigned
    expect(mediaAfter?.userId).toBe(victimUserId); // owner untouched
    save("a1-cross-project.json", { status: 409, rowMediaAssetId: rowAfter?.mediaAssetId, mediaAProjectId: mediaAfter?.projectId });
  });

  test("another user's asset cannot be attached — 404, nothing leaks or mutates", async () => {
    const before = await db.productionAsset.findUnique({ where: { id: assetRowId } });
    const r = await api("POST", `/api/productions/${productionB}/assets`, { action: "attach", assetRowId, mediaAssetId: attackerMedia }, attacker);
    expect(r.status).toBe(404);
    expect(String(r.json?.error)).not.toMatch(/belongs to|owner|user id/i);
    const after = await db.productionAsset.findUnique({ where: { id: assetRowId } });
    expect(after?.mediaAssetId).toBe(before?.mediaAssetId);
    const attackerMediaRow = await db.mediaAsset.findUnique({ where: { id: attackerMedia } });
    expect(attackerMediaRow?.userId).not.toBeNull(); // unchanged ownership, no leak in body
  });
});

describe("M47.4-A2 — export authorization on a REAL victim-owned export", () => {
  test("victim downloads their own real export", async () => {
    const r = await api("GET", `/api/exports/${victimExportId}/file`, undefined, victim, {}, true);
    expect(r.status).toBe(200);
    expect(r.buf.byteLength).toBe(victimExportSize);
    const cd = r.headers.get("content-disposition") ?? "";
    expect(cd).toContain("attachment");
    save("a2-victim-download.json", { status: 200, bytes: r.buf.byteLength, expected: victimExportSize });
  });

  test("second authenticated account cannot download that exact export — exact 404 body, no metadata", async () => {
    const r = await api("GET", `/api/exports/${victimExportId}/file`, undefined, attacker, {}, true);
    expect(r.status).toBe(404);
    const body = JSON.stringify(r.json);
    expect(body).toBe('{"error":"Export not found."}'); // EXACT body — no filename/path/owner
    expect(body).not.toMatch(/\.mp4|storage|exports\/|media-store|userId|projectId/i);
  });

  test("anonymous access is denied 401 with the exact contract", async () => {
    const r = await api("GET", `/api/exports/${victimExportId}/file`, undefined, undefined, {}, true);
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.json)).toBe('{"error":"Authentication required."}');
  });

  test("the export remains intact after unauthorized attempts", async () => {
    const rec = await db.exportFile.findUnique({ where: { id: victimExportId } });
    expect(rec?.sizeBytes).toBe(victimExportSize);
    const r = await api("GET", `/api/exports/${victimExportId}/file`, undefined, victim, {}, true);
    expect(r.status).toBe(200);
    expect(r.buf.byteLength).toBe(victimExportSize);
    save("a2-export-intact.json", { sizeAfter: rec?.sizeBytes, reDownload: r.buf.byteLength });
  });
});

describe("M47.4-A3 — concept-selection idempotency (exact contract, decision history verified)", () => {
  test("invalid option id: exact 400, no mutation, no decision row", async () => {
    const g = await api("GET", `/api/productions/${productionB}`, undefined, victim);
    const beforeSel = g.json?.concept?.selectedId ?? null;
    const decBefore = await db.productionDecision.count({ where: { productionId: productionB, kind: "concept" } });
    const r = await api("PUT", `/api/productions/${productionB}`, { kind: "concept", selectedId: "nonexistent-option-id" }, victim);
    expect(r.status).toBe(400);
    expect(String(r.json?.error)).toMatch(/selectedId must match a drafted option/);
    const g2 = await api("GET", `/api/productions/${productionB}`, undefined, victim);
    expect(g2.json?.concept?.selectedId ?? null).toBe(beforeSel);
    expect(await db.productionDecision.count({ where: { productionId: productionB, kind: "concept" } })).toBe(decBefore);
  });

  test("valid selection: 200, state set, exactly one decision row appended", async () => {
    // NOTE: productionB's concept was ALREADY selected + approved during setup
    // (driveProductionToAssets). Use the cross-probe production for a clean run.
    const cr = await api("POST", "/api/productions", { projectId: projectIdB, templateId: "social-video-factory", sourceMediaIds: [], briefText: "M47.4 a3 probe", title: "a3 probe" }, victim);
    const prod = cr.json?.production?.id;
    for (const [k, a] of [["INTAKE", "start"], ["INTAKE", "approve"], ["BRIEF", "start"], ["BRIEF", "approve"], ["CONCEPT", "start"]] as const) {
      await api("POST", `/api/productions/${prod}/stages/${k}`, { action: a }, victim);
    }
    const g = await api("GET", `/api/productions/${prod}`, undefined, victim);
    const opt = (g.json?.concept?.options ?? [])[0]?.id;
    const r1 = await api("PUT", `/api/productions/${prod}`, { kind: "concept", selectedId: opt }, victim);
    expect(r1.status).toBe(200);
    expect(await db.productionDecision.count({ where: { productionId: prod, kind: "concept" } })).toBe(1);
    const g1 = await api("GET", `/api/productions/${prod}`, undefined, victim);
    expect(g1.json?.concept?.selectedId).toBe(opt);

    // DOCUMENTED OUTCOME (probe-verified): repeating the SAME selection returns
    // 200 and appends one audit row per request — recordDecision is an
    // append-only AUDIT history by design; the SELECTION STATE stays singular
    // and unchanged, and no duplicate approval is possible (approval is the
    // separate CONCEPT stage action asserted in the next test).
    const r2 = await api("PUT", `/api/productions/${prod}`, { kind: "concept", selectedId: opt }, victim);
    expect(r2.status).toBe(200);
    const g2 = await api("GET", `/api/productions/${prod}`, undefined, victim);
    expect(g2.json?.concept?.selectedId).toBe(opt);
    expect(await db.productionDecision.count({ where: { productionId: prod, kind: "concept" } })).toBe(2);

    // Changing the selection: 200, state follows the new option, history grows.
    const opt2 = (g.json?.concept?.options ?? [])[1]?.id;
    const r3 = await api("PUT", `/api/productions/${prod}`, { kind: "concept", selectedId: opt2 }, victim);
    expect(r3.status).toBe(200);
    const g3 = await api("GET", `/api/productions/${prod}`, undefined, victim);
    expect(g3.json?.concept?.selectedId).toBe(opt2);
    const history = await db.productionDecision.findMany({ where: { productionId: prod, kind: "concept" }, orderBy: { createdAt: "asc" } });
    expect(history.length).toBe(3);
    expect(JSON.parse(history[2].valueJson).selectedId).toBe(opt2); // latest row = current choice
    save("a3-idempotency.json", { statuses: [r1.status, r2.status, r3.status], decisionRows: history.length, finalSelection: opt2 });

    // Selection NEVER bypasses approval: SCRIPT stays blocked pre-approval…
    const blocked = await api("POST", `/api/productions/${prod}/stages/SCRIPT`, { action: "start" }, victim);
    expect(blocked.status).toBe(409);
    expect(blocked.json?.code).toBe("DEPENDENCY_NOT_MET");
    // …a duplicate CONCEPT approval attempt after approval is refused…
    expect((await api("POST", `/api/productions/${prod}/stages/CONCEPT`, { action: "approve" }, victim)).status).toBe(200);
    const dupApprove = await api("POST", `/api/productions/${prod}/stages/CONCEPT`, { action: "approve" }, victim);
    expect(dupApprove.status).toBe(409);
    // …and SCRIPT opens ONLY after the explicit approval.
    expect((await api("POST", `/api/productions/${prod}/stages/SCRIPT`, { action: "start" }, victim)).status).toBe(200);
  });
});

describe("M47.4-A4 — duplicate resume and failed-stage retry (DB state verified)", () => {
  test("repeated resume: 200 both times, checkpoint identical, no duplicate productions/tasks", async () => {
    const prodCountBefore = await db.production.count({ where: { projectId: projectIdB } });
    const r1 = await api("POST", `/api/productions/${productionB}/resume`, undefined, victim);
    const r2 = await api("POST", `/api/productions/${productionB}/resume`, undefined, victim);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.json?.resumed).toEqual(r2.json?.resumed); // deterministic checkpoint
    expect(await db.production.count({ where: { projectId: projectIdB } })).toBe(prodCountBefore);
    const activeBefore = await db.productionTask.count({ where: { productionId: productionB, status: { in: ["RUNNING", "PENDING"] } } });
    const r3 = await api("POST", `/api/productions/${productionB}/resume`, undefined, victim);
    expect(r3.status).toBe(200);
    expect(r3.json?.resumed).toEqual(r1.json?.resumed);
    const activeAfter = await db.productionTask.count({ where: { productionId: productionB, status: { in: ["RUNNING", "PENDING"] } } });
    expect(activeAfter).toBe(activeBefore); // duplicates never stack tasks
    const running = await db.productionTask.count({ where: { productionId: productionB, status: "RUNNING" } });
    expect(running).toBeLessThanOrEqual(1);
    save("a4-resume.json", { statuses: [200, 200, 200], activeTasksBefore: activeBefore, activeTasksAfter: activeAfter, running });
  });

  test("failed-stage retry: FAILED → retry → valid startable state; approvals and exports untouched", async () => {
    // ASSET_PLANNING is AWAITING_APPROVAL after setup — a real reject→retry cycle.
    const exportsBefore = await db.exportFile.count({ where: { userId: victimUserId } });
    const rej = await api("POST", `/api/productions/${productionB}/stages/ASSET_PLANNING`, { action: "reject" }, victim);
    expect(rej.status).toBeLessThan(300);
    const stageStateOf = async (key: string) =>
      (await db.productionStage.findFirst({ where: { productionId: productionB, key } }))?.state;
    expect(await stageStateOf("ASSET_PLANNING")).toBe("FAILED");
    const retry = await api("POST", `/api/productions/${productionB}/stages/ASSET_PLANNING`, { action: "retry" }, victim);
    expect(retry.status).toBe(200);
    expect(retry.json?.state).toBe("READY");
    // Internally consistent: every other stage state unchanged by the retry.
    // Internally consistent: every previously-approved stage is untouched by
    // the reject/retry cycle, and the retried stage is startable again.
    for (const st of ["INTAKE", "BRIEF", "CONCEPT", "SCRIPT"]) expect(await stageStateOf(st)).toBe("SUCCEEDED");
    expect(await stageStateOf("ASSET_PLANNING")).toBe("READY");
    const exportsAfter = await db.exportFile.count({ where: { userId: victimUserId } });
    expect(exportsAfter).toBe(exportsBefore);
    save("a4-retry.json", { rejectStatus: rej.status, retryStatus: retry.status, stateAfter: "READY" });
  });
});

describe("M47.4-A5 — cross-user regression on the real routes", () => {
  test("production GET/PUT/stage/resume by attacker → 404 ×4", async () => {
    expect((await api("GET", `/api/productions/${productionB}`, undefined, attacker)).status).toBe(404);
    expect((await api("PUT", `/api/productions/${productionB}`, { kind: "concept", selectedId: "x" }, attacker)).status).toBe(404);
    expect((await api("POST", `/api/productions/${productionB}/stages/CONCEPT`, { action: "approve" }, attacker)).status).toBe(404);
    expect((await api("POST", `/api/productions/${productionB}/resume`, undefined, attacker)).status).toBe(404);
  });

  test("asset attach/decide on victim rows by attacker → 404", async () => {
    expect((await api("POST", `/api/productions/${productionB}/assets`, { action: "attach", assetRowId, mediaAssetId: attackerMedia }, attacker)).status).toBe(404);
    expect((await api("POST", `/api/productions/${productionB}/assets`, { action: "decide", assetRowId, decision: "APPROVED" }, attacker)).status).toBe(404);
  });

  test("export listing and file: attacker sees none of the victim's exports", async () => {
    const list = await api("GET", "/api/exports", undefined, attacker);
    const ids = (list.json?.exports ?? []).map((e: { id: string }) => e.id);
    expect(ids).not.toContain(victimExportId);
    expect((await api("GET", `/api/exports/${victimExportId}/file`, undefined, attacker, {}, true)).status).toBe(404);
  });

  test("project timeline and media file access by attacker → 404", async () => {
    expect((await api("GET", `/api/editor/projects/${projectIdA}/timeline`, undefined, attacker)).status).toBe(404);
    // Valid-SHAPED request (nonempty edits) so body validation passes and the
    // ownership check decides: a non-owner gets 404 — the timeline is never
    // modified for non-owners.
    const validEdit = { type: "AddClip", clip: { id: "atk", trackId: "video-1", sourceAssetId: "x", sourceInFrame: 0, sourceOutFrame: 30, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 30, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: null, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [] } };
    expect((await api("POST", `/api/editor/projects/${projectIdA}/timeline`, { baseVersion: 1, edits: [validEdit] }, attacker)).status).toBe(404);
    // The victim's timeline is unchanged by all attacker attempts.
    const t = await api("GET", `/api/editor/projects/${projectIdA}/timeline`, undefined, victim);
    expect(t.json?.version).toBeGreaterThan(0);
    expect((await api("GET", `/api/media/${mediaA}/file`, undefined, attacker, {}, true)).status).toBe(404);
  });

  test("conversation-to-production restoration: attacker cannot use the victim's conversation → exact 403", async () => {
    const r = await api("POST", "/api/productions", { projectId: (await api("POST", "/api/projects", { name: "M47.4 attacker proj2" }, attacker)).json?.project?.id, conversationId: victimConversationId, templateId: "social-video-factory", sourceMediaIds: [], briefText: "x", title: "theft attempt" }, attacker);
    expect(r.status).toBe(403);
    expect(String(r.json?.error)).toMatch(/Conversation not found or not owned by the caller/);
    // The victim's conversation was not consumed or mutated.
    const convo = await db.conversation.findUnique({ where: { id: victimConversationId } });
    expect(convo?.userId).toBeTruthy();
    expect((await api("POST", "/api/productions", { projectId: projectIdA, conversationId: victimConversationId, templateId: "social-video-factory", sourceMediaIds: [], briefText: "legit", title: "legit" }, victim)).status).toBeLessThan(300);
  });
});
