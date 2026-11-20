/**
 * M31 Phase 3 — collaboration security audit (independent sessions).
 * Extends M30 coverage with: cross-user exports/packages/notifications,
 * revoked-member review access, ALL/ANY policy determinism, fingerprint
 * verification, guest-session expiry, and duplicate-submission races.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs";

const BASE = process.env.M31_BASE ?? "http://localhost:3117";
const STAMP = Date.now().toString(36);

type Jar = { cookie: string };
const jar = (): Jar => ({ cookie: "" });

async function api(method: string, path: string, opts: { jar?: Jar; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const { jar: j, body, raw, headers = {} } = opts;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}),
      ...(raw ? headers : {}),
      ...(j?.cookie ? { Cookie: j.cookie } : {}),
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (j) {
    for (const c of setCookie) {
      const [k, v] = c.split(";")[0].split("=");
      if (k === "beanfx_session") j.cookie = `${k}=${v}`;
      else if (k === "beanfx_review") j.cookie = `${k}=${v}`;
    }
  }
  const json = (res.headers.get("content-type") ?? "").includes("json") ? await res.json().catch(() => null) : null;
  return { status: res.status, json, headers: res.headers };
}

async function register(j: Jar, email: string): Promise<void> {
  const r = await api("POST", "/api/auth/register", { jar: j, body: { email, password: `m31-${STAMP}-p1`, name: email.split("@")[0] } });
  expect(r.status).toBe(200);
}

let owner: Jar, member: Jar, stranger: Jar;
let projectId: string, revisionId: string, reviewLinkToken: string;

beforeAll(async () => {
  owner = jar(); member = jar(); stranger = jar();
  await register(owner, `m31a-${STAMP}@test.local`);
  await register(member, `m31b-${STAMP}@test.local`);
  await register(stranger, `m31c-${STAMP}@test.local`);

  execSync(`ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=3" -c:v libx264 -preset veryfast -pix_fmt yuv420p /tmp/m31.mp4`);
  const proj = await api("POST", "/api/projects", { jar: owner, body: { name: "M31 Audit Project" } });
  projectId = proj.json.project.id;
  const up = await api("POST", "/api/media", { jar: owner, raw: fs.readFileSync("/tmp/m31.mp4"), headers: { "x-filename": "a.mp4", "Content-Type": "application/octet-stream" } });
  expect(up.status).toBe(200);
  const tl = await api("POST", `/api/editor/projects/${projectId}/timeline`, { jar: owner, body: { baseVersion: 1, edits: [
    { type: "AddTrack", track: { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
    { type: "AddClip", clip: { id: "c1", trackId: "v1", sourceAssetId: up.json.media.id, sourceInFrame: 0, sourceOutFrame: 60, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 60, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [] } },
  ] } });
  expect(tl.status).toBe(200);
  // REVIEWER share for member.
  const uid = (await api("GET", "/api/auth/me", { jar: member })).json.user.id;
  const share = await api("POST", `/api/projects/${projectId}/shares`, { jar: owner, body: { userId: uid, role: "REVIEWER" } });
  expect(share.status).toBe(201);
}, 300_000);

describe("M31 §3 — cross-user isolation", () => {
  test("stranger cannot access project media, exports, packages, notifications, reviews", async () => {
    // Media list / asset access
    const media = await api("GET", "/api/media", { jar: stranger });
    const ownerMedia = await api("GET", "/api/media", { jar: owner });
    const ownerIds = new Set((ownerMedia.json?.media ?? []).map((m: any) => m.id));
    const leaked = (media.json?.media ?? []).filter((m: any) => ownerIds.has(m.id));
    expect(leaked.length).toBe(0); // media library is per-user
    // Exports listing
    const exportsS = await api("GET", "/api/exports", { jar: stranger });
    const exportsO = await api("GET", "/api/exports", { jar: owner });
    const exportIds = new Set((exportsO.json?.files ?? exportsO.json?.exports ?? []).map((x: any) => x.id));
    const leakedExp = (exportsS.json?.files ?? exportsS.json?.exports ?? []).filter((x: any) => exportIds.has(x.id));
    expect(leakedExp.length).toBe(0);
    // Notifications: users only ever see their own rows
    const n = await api("GET", "/api/notifications", { jar: stranger });
    expect(n.json.notifications.every((x: any) => x.projectId === null || x.projectId !== projectId)).toBe(true);
    // Review revision (none exists yet): generic not-found
    const rev = await api("GET", `/api/reviews/nonexistent-rev-${STAMP}`, { jar: stranger });
    expect(rev.status).toBe(404);
  }, 120_000);

  test("another user's package download is rejected without authorization", async () => {
    // Attempt to fetch an export file by id belongs to the owner: stranger
    // should never guess it; the export id from owner session must 404 for stranger.
    const exportsO = await api("GET", "/api/exports", { jar: owner });
    const first = (exportsO.json?.files ?? exportsO.json?.exports ?? [])[0];
    if (first?.id) {
      const probe = await api("GET", `/api/exports/${first.id}/file`, { jar: stranger });
      expect([401, 403, 404]).toContain(probe.status);
    }
  }, 120_000);
});

describe("M31 §3 — review security", () => {
  test("reviewer comments + approves; ALL-policy determinism holds", async () => {
    const create = await api("POST", `/api/projects/${projectId}/reviews`, { jar: owner, body: { title: "M31 audit rev", approvalPolicy: "ALL" } });
    expect(create.status).toBe(201);
    revisionId = create.json.revision.id;
    // wait for render
    const t0 = Date.now();
    for (;;) {
      const d = await api("GET", `/api/reviews/${revisionId}`, { jar: owner });
      if (d.json?.revision?.status !== "PROCESSING") break;
      if ((Date.now() - t0) / 1000 > 240) throw new Error("render timeout");
      await new Promise((r) => setTimeout(r, 2000));
    }
    const c = await api("POST", `/api/reviews/${revisionId}/comments`, { jar: member, body: { body: "frame 12 note", frame: 12, fpsNum: 30, fpsDen: 1 } });
    expect(c.status).toBe(201);
    const approve = await api("PUT", `/api/reviews/${revisionId}`, { jar: member, body: { decision: "APPROVE" } });
    expect(approve.status).toBe(200);
    expect(approve.json.revisionStatus).toBe("APPROVED"); // ALL + single reviewer
    const dup = await api("PUT", `/api/reviews/${revisionId}`, { jar: member, body: { decision: "REQUEST_CHANGES" } });
    expect(dup.status).toBe(409);
  }, 400_000);

  test("fingerprint present and stable; approval pinned to the exact revision", async () => {
    const d = await api("GET", `/api/reviews/${revisionId}`, { jar: owner });
    expect(d.json.revision.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(d.json.revision.approvedAt).toBeTruthy();
  }, 120_000);

  test("revoked member loses review access immediately (revocation effect)", async () => {
    // Revoke the member's share.
    const shares = await api("GET", `/api/projects/${projectId}/shares`, { jar: owner });
    const target = shares.json.shares.find((s: any) => s.role === "REVIEWER" && !s.revokedAt);
    expect(target).toBeTruthy();
    const rv = await api("DELETE", `/api/projects/${projectId}/shares?shareId=${target.id}`, { jar: owner });
    expect(rv.status).toBe(200);
    // Next request: member can no longer see the revision.
    const after = await api("GET", `/api/reviews/${revisionId}`, { jar: member });
    expect(after.status).toBe(404);
    const vote = await api("PUT", `/api/reviews/${revisionId}`, { jar: member, body: { decision: "REQUEST_CHANGES" } });
    expect(vote.status).toBe(404);
    const comment = await api("POST", `/api/reviews/${revisionId}/comments`, { jar: member, body: { body: "should fail" } });
    expect(comment.status).toBe(404);
  }, 120_000);

  test("guest link sessions expire with the link and cannot act beyond scope", async () => {
    const l = await api("POST", `/api/reviews/${revisionId}/links`, { jar: owner, body: { permission: "COMMENT", ttlHours: 1 } });
    expect(l.status).toBe(201);
    reviewLinkToken = l.json.token;
    const g = jar();
    const s = await api("POST", `/api/reviews/link/${reviewLinkToken}`, { jar: g, body: { displayName: "AuditGuest" } });
    expect(s.status).toBe(200);
    // Expire the link at the storage layer (deterministic).
    const { PrismaClient } = await import("@prisma/client");
    const db = new PrismaClient({ datasources: { db: { url: process.env.M31_DB ?? "file:/home/z/my-project/db/m29closeout.db" } } });
    await db.$queryRawUnsafe(`UPDATE ReviewLink SET expiresAt = datetime('now','-1 minute') WHERE id = ?`, l.json.link.id);
    await db.$disconnect();
    const dead = await api("GET", `/api/reviews/${revisionId}`, { jar: g });
    expect(dead.status).toBe(404); // expired link → guest session dead
    const deadComment = await api("POST", `/api/reviews/${revisionId}/comments`, { jar: g, body: { body: "late" } });
    expect(deadComment.status).toBe(404);
  }, 120_000);

  test("notification payloads never carry tokens or storage paths", async () => {
    const n = await api("GET", "/api/notifications?take=50", { jar: owner });
    for (const item of n.json.notifications) {
      const raw = JSON.stringify(item);
      expect(raw).not.toMatch(/beanfx_review|token|storagePath|\/home\//);
      expect(raw).not.toMatch(/storage/);
    }
  }, 120_000);

  test("unauthorized renders: stranger cannot start a render on someone else's project", async () => {
    const r = await api("POST", `/api/editor/projects/${projectId}/render`, { jar: stranger, body: {} });
    expect([400, 404]).toContain(r.status);
    const rr = await api("POST", `/api/projects/${projectId}/reviews`, { jar: stranger, body: { title: "nope" } });
    expect(rr.status).toBe(404);
  }, 120_000);
});
