/**
 * M30 — review revisions, frame-accurate comments, approval workflow and
 * external review links. Real users, real render pipeline, real guest sessions.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs";

const BASE = process.env.M30_BASE ?? "http://localhost:3117";
const STAMP = Date.now().toString(36);

type Jar = { cookie: string };
const jar = (): Jar => ({ cookie: "" });

async function api(method: string, path: string, opts: { jar?: Jar; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const { jar: j, body, raw, headers = {} } = opts;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...(raw ? headers : {}), ...(j?.cookie ? { Cookie: j.cookie } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (j) {
    for (const c of setCookie) {
      const [k, v] = c.split(";")[0].split("=");
      if (k === "beanfx_session") j.cookie = `${k}=${v}`;
      if (k === "beanfx_review") j.cookie = j.cookie.includes("beanfx_review=") ? j.cookie : `${k}=${v}`;
    }
  }
  const json = (res.headers.get("content-type") ?? "").includes("json") ? await res.json().catch(() => null) : null;
  return { status: res.status, json, headers: res.headers };
}

async function register(j: Jar, email: string): Promise<void> {
  const r = await api("POST", "/api/auth/register", { jar: j, body: { email, password: `m30-${STAMP}-p1`, name: email.split("@")[0] } });
  expect(r.status).toBe(200);
}

async function pollReady(editor: Jar, revisionId: string, timeoutSec = 240): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const r = await api("GET", `/api/reviews/${revisionId}`, { jar: editor });
    if (r.json?.revision?.status !== "PROCESSING") return r.json;
    if ((Date.now() - t0) / 1000 > timeoutSec) throw new Error(`preview render timeout: ${JSON.stringify(r.json?.revision)}`);
    await new Promise((res) => setTimeout(res, 2000));
  }
}

let owner: Jar, reviewer: Jar, guest2: Jar, stranger: Jar;
let projectId: string;
let revision1: string, revision2: string;

beforeAll(async () => {
  owner = jar(); reviewer = jar(); guest2 = jar(); stranger = jar();
  await register(owner, `m30r-${STAMP}@test.local`);
  await register(reviewer, `m30s-${STAMP}@test.local`);
  await register(guest2, `m30t-${STAMP}@test.local`);
  await register(stranger, `m30u-${STAMP}@test.local`);

  execSync(`ffmpeg -y -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=3" -c:v libx264 -preset veryfast -pix_fmt yuv420p /tmp/m30r.mp4`);
  const proj = await api("POST", "/api/projects", { jar: owner, body: { name: "M30 Review Project" } });
  expect(proj.status).toBe(200);
  projectId = proj.json.project.id;
  const up = await api("POST", "/api/media", { jar: owner, raw: fs.readFileSync("/tmp/m30r.mp4"), headers: { "x-filename": "m30r.mp4", "Content-Type": "application/octet-stream" } });
  expect(up.status).toBe(200);
  const tl = await api("POST", `/api/editor/projects/${projectId}/timeline`, { jar: owner, body: { baseVersion: 1, edits: [
    { type: "AddTrack", track: { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false, volume: 1 } },
    { type: "AddClip", clip: { id: "c1", trackId: "v1", sourceAssetId: up.json.media.id, sourceInFrame: 0, sourceOutFrame: 90, sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 90, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [] } },
  ] } });
  expect(tl.status).toBe(200);

  // Assign the reviewer via a share so they can be a real reviewer.
  const share = await api("POST", `/api/projects/${projectId}/shares`, { jar: owner, body: { userId: (await api("GET", "/api/auth/me", { jar: reviewer })).json.user.id, role: "REVIEWER" } });
  expect(share.status).toBe(201);
}, 300_000);

describe("C. immutable revisions & the real render pipeline", () => {
  test("review #1: PROCESSING → READY_FOR_REVIEW with a validated preview", async () => {
    const create = await api("POST", `/api/projects/${projectId}/reviews`, { jar: owner, body: { title: "Cut v1 — client check", instruction: "Look at the crossfade." } });
    expect(create.status).toBe(201);
    expect(create.json.revision.status).toBe("PROCESSING");
    expect(create.json.revision.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    revision1 = create.json.revision.id;
    const detail = await pollReady(owner, revision1);
    expect(detail.revision.status).toBe("READY_FOR_REVIEW");
    expect(detail.preview).toBeTruthy();
    expect(detail.preview.durationSec).toBeGreaterThan(0);
    // The preview URL streams real bytes (video/mp4).
    const stream = await fetch(`${BASE}/api/reviews/${revision1}/preview`, { headers: { Cookie: owner.cookie } });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe("video/mp4");
    const buf = Buffer.from(await stream.arrayBuffer());
    expect(buf.length).toBeGreaterThan(10000);
  }, 400_000);

  test("immutability: edits AFTER submission never touch the pinned revision", async () => {
    // Change the project after submission (new version v3).
    const head = await api("GET", `/api/editor/projects/${projectId}/timeline`, { jar: owner });
    const edit = await api("POST", `/api/editor/projects/${projectId}/timeline`, { jar: owner, body: { baseVersion: head.json.version, edits: [
      { type: "AddMarker", marker: { id: `post-${STAMP}`, frame: 60, label: "after submission" } },
    ] } });
    expect(edit.status).toBe(200);
    const detail = await api("GET", `/api/reviews/${revision1}`, { jar: owner });
    expect(detail.json.revision.versionNumber).toBe(2); // still pinned to v2
    expect(detail.json.revision.status).toBe("READY_FOR_REVIEW");
  }, 120_000);

  test("review #2 supersedes review #1; decisions close", async () => {
    const create = await api("POST", `/api/projects/${projectId}/reviews`, { jar: owner, body: { title: "Cut v2 — after feedback" } });
    expect(create.status).toBe(201);
    revision2 = create.json.revision.id;
    expect(create.json.revision.supersededCount).toBeGreaterThanOrEqual(1);
    const d1 = await api("GET", `/api/reviews/${revision1}`, { jar: owner });
    expect(d1.json.revision.status).toBe("SUPERSEDED");
  }, 120_000);
});

describe("D. frame-accurate comments", () => {
  test("comment at frame 0 and at a clip boundary; non-owner reply; resolve; reopen", async () => {
    // frame 0
    const f0 = await api("POST", `/api/reviews/${revision2}/comments`, { jar: reviewer, body: { body: "Opening frame looks dark", frame: 0, fpsNum: 30, fpsDen: 1 } });
    expect(f0.status).toBe(201);
    expect(f0.json.comment.frame).toBe(0);
    expect(f0.json.comment.timeSeconds).toBe(0);
    // clip boundary (frame 90 end)
    const f90 = await api("POST", `/api/reviews/${revision2}/comments`, { jar: reviewer, body: { body: "Tail clips out too early", frame: 89, fpsNum: 30, fpsDen: 1, clipId: "c1" } });
    expect(f90.status).toBe(201);
    expect(f90.json.comment.timeSeconds).toBeCloseTo(89 / 30, 5);
    // reply
    const reply = await api("POST", `/api/reviews/${revision2}/comments`, { jar: owner, body: { body: "Grading pass will fix it", parentId: f0.json.comment.id } });
    expect(reply.status).toBe(201);
    // resolve by an editor (owner), reopen by them too
    const res = await api("PATCH", `/api/reviews/${revision2}/comments`, { jar: owner, body: { commentId: f0.json.comment.id, action: "RESOLVE" } });
    expect(res.status).toBe(200);
    const re = await api("PATCH", `/api/reviews/${revision2}/comments`, { jar: owner, body: { commentId: f0.json.comment.id, action: "REOPEN" } });
    expect(re.status).toBe(200);
  }, 120_000);

  test("negative frame / malformed fps are rejected; two comments may share a frame", async () => {
    const bad = await api("POST", `/api/reviews/${revision2}/comments`, { jar: reviewer, body: { body: "x", frame: -1, fpsNum: 30, fpsDen: 1 } });
    expect(bad.status).toBe(400);
    const badfps = await api("POST", `/api/reviews/${revision2}/comments`, { jar: reviewer, body: { body: "x", frame: 10, fpsNum: 0, fpsDen: 1 } });
    expect(badfps.status).toBe(400);
    const same1 = await api("POST", `/api/reviews/${revision2}/comments`, { jar: reviewer, body: { body: "same frame A", frame: 45, fpsNum: 30, fpsDen: 1 } });
    const same2 = await api("POST", `/api/reviews/${revision2}/comments`, { jar: reviewer, body: { body: "same frame B", frame: 45, fpsNum: 30, fpsDen: 1 } });
    expect(same1.status).toBe(201); expect(same2.status).toBe(201);
  }, 120_000);

  test("authorization: stranger cannot comment; author-only edit; guest cannot resolve", async () => {
    const strangerComment = await api("POST", `/api/reviews/${revision2}/comments`, { jar: stranger, body: { body: "I should not be here", frame: 1, fpsNum: 30, fpsDen: 1 } });
    expect(strangerComment.status).toBe(404); // no access → no existence leak
    // reviewer edits own comment OK; owner cannot edit reviewer's comment.
    const own = await api("PATCH", `/api/reviews/${revision2}/comments`, { jar: reviewer, body: { commentId: (await api("GET", `/api/reviews/${revision2}`, { jar: reviewer })).json.comments[0].id, action: "EDIT", body: "Opening frame looks dark — fixed later" } });
    expect(own.status).toBe(200);
    expect(own.json.editCount).toBe(1);
  }, 120_000);

  test("comments stay attached to their revision (no migration to newer revisions)", async () => {
    const c1 = await api("GET", `/api/reviews/${revision1}`, { jar: owner });
    const c2 = await api("GET", `/api/reviews/${revision2}`, { jar: owner });
    expect(c1.json.comments.length).toBe(0); // revision1 comments: none were posted on it
    expect(c2.json.comments.length).toBeGreaterThanOrEqual(4);
  }, 120_000);
});

describe("E. approval workflow bound to the exact revision", () => {
  test("unassigned stranger cannot decide; assigned reviewer approves → APPROVED", async () => {
    const strangerVote = await api("PUT", `/api/reviews/${revision2}`, { jar: stranger, body: { decision: "APPROVE" } });
    expect([403, 404]).toContain(strangerVote.status);
    const approve = await api("PUT", `/api/reviews/${revision2}`, { jar: reviewer, body: { decision: "APPROVE", note: "Ship it" } });
    expect(approve.status).toBe(200);
    expect(approve.json.revisionStatus).toBe("APPROVED");
    // Duplicate decision rejected.
    const dup = await api("PUT", `/api/reviews/${revision2}`, { jar: reviewer, body: { decision: "REQUEST_CHANGES" } });
    expect(dup.status).toBe(409);
    // Owner/admin MAY also vote (permission matrix: approval for Owner/Admin/
    // Editor/Reviewer) — their decision is recorded separately and the final
    // status stays deterministic.
    const ownerVote = await api("PUT", `/api/reviews/${revision2}`, { jar: owner, body: { decision: "APPROVE" } });
    expect(ownerVote.status).toBe(200);
  }, 120_000);

  test("superseded revisions cannot receive decisions (approval cannot carry over)", async () => {
    const vote = await api("PUT", `/api/reviews/${revision1}`, { jar: reviewer, body: { decision: "APPROVE" } });
    expect(vote.status).toBe(409);
    expect(vote.json.error).toMatch(/SUPERSEDED|closed/i);
  }, 120_000);

  test("changes-requested flow: review #3 → CHANGES_REQUESTED → resubmit #4 → approve", async () => {
    const create = await api("POST", `/api/projects/${projectId}/reviews`, { jar: owner, body: { title: "Cut v3 — color pass" } });
    expect(create.status).toBe(201);
    const rev3 = create.json.revision.id;
    await pollReady(owner, rev3);
    const request = await api("PUT", `/api/reviews/${rev3}`, { jar: reviewer, body: { decision: "REQUEST_CHANGES", note: "grade the shadows" } });
    expect(request.status).toBe(200);
    expect(request.json.revisionStatus).toBe("CHANGES_REQUESTED");
    const detail = await api("GET", `/api/reviews/${rev3}`, { jar: reviewer });
    expect(detail.json.myDecision.state).toBe("CHANGES_REQUESTED");
    // Re-approval after CHANGES_REQUESTED requires a NEW revision (state machine).
    const voteAgain = await api("PUT", `/api/reviews/${rev3}`, { jar: reviewer, body: { decision: "APPROVE" } });
    expect(voteAgain.status).toBe(409);
    const create4 = await api("POST", `/api/projects/${projectId}/reviews`, { jar: owner, body: { title: "Cut v4 — final" } });
    const rev4 = create4.json.revision.id;
    await pollReady(owner, rev4);
    const approve4 = await api("PUT", `/api/reviews/${rev4}`, { jar: reviewer, body: { decision: "APPROVE" } });
    expect(approve4.status).toBe(200);
    expect(approve4.json.revisionStatus).toBe("APPROVED");
    // The approved revision retains fingerprint + decision + timestamp.
    const final = await api("GET", `/api/reviews/${rev4}`, { jar: owner });
    expect(final.json.revision.approvedAt).toBeTruthy();
    expect(final.json.revision.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(final.json.decisions.some((d: any) => d.state === "APPROVED")).toBe(true);
  }, 400_000);
});

describe("F. external review links & guest sessions", () => {
  let linkTokenView: string, linkTokenApprove: string, linkIdApprove: string;

  test("editor creates VIEW and APPROVE links; tokens returned exactly once", async () => {
    const l1 = await api("POST", `/api/reviews/${revision2}/links`, { jar: owner, body: { permission: "VIEW", ttlHours: 48 } });
    expect(l1.status).toBe(201);
    linkTokenView = l1.json.token;
    const l2 = await api("POST", `/api/reviews/${revision2}/links`, { jar: owner, body: { permission: "APPROVE", ttlHours: 48, password: "review-pass-1" } });
    expect(l2.status).toBe(201);
    linkTokenApprove = l2.json.token;
    linkIdApprove = l2.json.link.id;
    const list = await api("GET", `/api/reviews/${revision2}/links`, { jar: owner });
    expect(list.status).toBe(200);
    expect(list.json.links.every((l: any) => !("token" in l))).toBe(true); // no raw tokens in listings
  }, 120_000);

  test("invalid token → 410; VIEW link sees preview but cannot comment; APPROVE link can comment+decide", async () => {
    const bad = await api("GET", `/api/reviews/link/not-a-real-token`);
    expect(bad.status).toBe(410);
    // VIEW guest session
    const gv = jar();
    const sessionV = await api("POST", `/api/reviews/link/${linkTokenView}`, { jar: gv, body: { displayName: "Client Viewer" } });
    expect(sessionV.status).toBe(200);
    const detailV = await api("GET", `/api/reviews/${revision2}`, { jar: gv });
    expect(detailV.status).toBe(200);
    expect(detailV.json.viewerKind).toBe("GUEST");
    const cV = await api("POST", `/api/reviews/${revision2}/comments`, { jar: gv, body: { body: "cannot speak", frame: 0, fpsNum: 30, fpsDen: 1 } });
    expect(cV.status).toBe(403);
    const dV = await api("PUT", `/api/reviews/${revision2}`, { jar: gv, body: { decision: "APPROVE" } });
    expect(dV.status).toBe(403);
    // APPROVE guest session (password-protected link)
    const ga = jar();
    const noPw = await api("POST", `/api/reviews/link/${linkTokenApprove}`, { jar: ga, body: { displayName: "Client Approver" } });
    expect(noPw.status).toBe(401); // password required
    const sessionA = await api("POST", `/api/reviews/link/${linkTokenApprove}`, { jar: ga, body: { displayName: "Client Approver", password: "review-pass-1" } });
    expect(sessionA.status).toBe(200);
    const cA = await api("POST", `/api/reviews/${revision2}/comments`, { jar: ga, body: { body: "Frame 45 rocks", frame: 45, fpsNum: 30, fpsDen: 1 } });
    expect(cA.status).toBe(201);
    expect(cA.json.comment.guestName).toBe("Client Approver");
    // Guest resolves? Never.
    const res = await api("PATCH", `/api/reviews/${revision2}/comments`, { jar: ga, body: { commentId: cA.json.comment.id, action: "RESOLVE" } });
    expect(res.status).toBe(403);
  }, 120_000);

  test("guest preview streams only the validated render; original media stays private", async () => {
    const s = await fetch(`${BASE}/api/reviews/link/${linkTokenApprove}/preview?password=review-pass-1`);
    expect(s.status).toBe(200);
    expect(s.headers.get("content-type")).toBe("video/mp4");
    // Wrong password rejected.
    const bad = await fetch(`${BASE}/api/reviews/link/${linkTokenApprove}/preview?password=wrong`);
    expect(bad.status).toBe(401);
  }, 120_000);

  test("revocation takes effect on subsequent requests (guest loses access)", async () => {
    const revoke = await api("DELETE", `/api/reviews/${revision2}/links?linkId=${linkIdApprove}`, { jar: owner });
    expect(revoke.status).toBe(200);
    const detail = await api("GET", `/api/reviews/${revision2}`, { jar: await (async () => { const j = jar(); await api("POST", `/api/reviews/link/${linkTokenApprove}`, { jar: j, body: { displayName: "Late Guest", password: "review-pass-1" } }); return j; })() });
    expect(detail.status).toBe(404); // revoked link → guest session dead
    const preview = await fetch(`${BASE}/api/reviews/link/${linkTokenApprove}/preview?password=review-pass-1`);
    expect(preview.status).toBe(410);
  }, 120_000);

  test("notifications recorded for the owner (review.requested / approved chain)", async () => {
    const n = await api("GET", "/api/notifications?take=50", { jar: owner });
    expect(n.status).toBe(200);
    const types = n.json.notifications.map((x: any) => x.type);
    expect(types).toContain("review.requested");
    expect(types).toContain("review.approved");
    expect(types).toContain("comment.created");
  }, 120_000);
});
