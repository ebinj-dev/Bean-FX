/**
 * M43-B — commands service + MCP surface on a REAL database (scratch fixture,
 * same recipe as the M21/M22 suites). Covers: list/describe/validate/preview
 * against the live head, revision-conflict refusal, provenance audit rows,
 * destructive-command approval policy, atomic batches (nothing persisted on
 * abort), and the MCP tools (read scope, write scope + hash-bound approval).
 * Run: bun test scripts/test-m43-commands.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { scratchLegacyDb } from "./legacy-fixture";

process.env.NODE_ENV = "production";
process.env.DATABASE_URL = scratchLegacyDb("m43-commands");

import { db } from "../src/lib/db";
import { getTimelineHead } from "../src/lib/editor/persistence";
import { commandsBatch, commandsDescribe, commandsList, commandsPreview, commandsRun, commandsValidate } from "../src/lib/my-ai/commands-service";
import { argsHash, callTool, type McpCallContext } from "../src/lib/mcp/tools";
import "../src/lib/mcp/bootstrap"; // registers MYAI + M43-B commands tools

const USER = "m43-commands-owner";
const OTHER = "m43-commands-stranger";
const PROJECT = "m43cmds-project";
let projectId = "";
/** Tracked head version — every successful mutation below bumps this. */
let ver = 1;

const ADD_CLIP = {
  commandId: "timeline.addClip",
  params: {
    type: "AddClip",
    clip: {
      id: "m43-clip1",
      trackId: "m43cmds-project-v1",
      sourceAssetId: "",
      sourceInFrame: 0,
      sourceOutFrame: 300,
      sourceFps: { num: 30, den: 1 },
      timelineStartFrame: 0,
      playbackSpeed: 1,
      volume: 1,
      muted: false,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      captionText: null,
      captionStyle: null,
      graphicTemplateId: null,
      graphicStyle: null,
      label: "fixture clip",
      missingMedia: true,
      pan: 0,
      groupId: null,
      effects: [],
      keyframes: [],
    },
  },
};
const ADD_MARKER = { commandId: "timeline.addMarker", params: { type: "AddMarker", marker: { id: "m43-mk1", frame: 90, label: "M43 scene" } } };

async function seed(): Promise<void> {
  await db.user.upsert({ where: { id: USER }, update: {}, create: { id: USER, email: "m43cmds@test.local", passwordHash: "x", emailVerified: true } });
  await db.user.upsert({ where: { id: OTHER }, update: {}, create: { id: OTHER, email: "m43other@test.local", passwordHash: "x", emailVerified: true } });
  // The scratch DB is deterministic (persists between runs): reset everything
  // the suite mutates so version counts and fixtures start fresh.
  await db.timelineVersion.deleteMany({ where: { projectId: PROJECT } });
  await db.automationAudit.deleteMany({ where: { userId: USER } });
  await db.mcpApproval.deleteMany({ where: { userId: USER } });
  await db.auditEvent.deleteMany({ where: { userId: USER } });
  await db.project.upsert({ where: { id: PROJECT }, update: {}, create: { id: PROJECT, userId: USER, name: "M43 Commands Fixture" } });
  projectId = PROJECT;
}

const auth = (scopes: string[]): McpCallContext["auth"] => ({ tokenId: "m43-test-token", userId: USER, scopes: scopes as McpCallContext["auth"]["scopes"] });

async function createApproval(action: string, args: Record<string, unknown>): Promise<string> {
  const row = await db.mcpApproval.create({
    data: { userId: USER, action, payloadHash: argsHash(action, args), expiresAt: new Date(Date.now() + 60_000) },
  });
  return row.id;
}

async function headVersion(): Promise<number> {
  return (await getTimelineHead(projectId, USER)).version;
}

beforeAll(async () => {
  await seed();
  ver = await headVersion(); // first-touch creates v1
  expect(ver).toBe(1);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("M43-B commands.list / describe", () => {
  test("list returns all 36 registry commands with live availability", async () => {
    const res = await commandsList(projectId, USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.headVersion).toBe(ver);
    expect(res.commands.length).toBe(36);
    const addMarker = res.commands.find((c) => c.id === "timeline.addMarker")!;
    expect(addMarker.available.ok).toBe(true);
    expect(addMarker.risk).toBe("low");
    expect(res.commands.find((c) => c.id === "timeline.trimClip")!.available.ok).toBe(false); // no clips yet
  });

  test("describe returns typed params doc; unknown id refused", () => {
    const d = commandsDescribe("timeline.addMarker");
    expect(d.ok).toBe(true);
    expect(commandsDescribe("timeline.nope").ok).toBe(false);
  });

  test("project scoping: another user cannot list", async () => {
    const res = await commandsList(projectId, OTHER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("M43-B commands.validate (non-mutating)", () => {
  test("valid command validates at the current revision", async () => {
    const res = await commandsValidate(projectId, USER, ADD_MARKER.commandId, ADD_MARKER.params, ver);
    expect(res.ok).toBe(true);
  });

  test("schema-invalid command → VALIDATION_FAILED with structured error", async () => {
    const res = await commandsValidate(projectId, USER, "timeline.addMarker", { type: "AddMarker", marker: { id: "bad", frame: -5 } }, ver);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("VALIDATION_FAILED");
  });

  test("unknown command id → UNKNOWN_COMMAND", async () => {
    const res = await commandsValidate(projectId, USER, "timeline.nope", {}, ver);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("UNKNOWN_COMMAND");
  });

  test("unavailable command (no clips yet) → UNAVAILABLE", async () => {
    const res = await commandsValidate(projectId, USER, "timeline.trimClip", { type: "TrimClip", clipId: "ghost", newSourceInFrame: 5 }, ver);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("UNAVAILABLE");
  });

  test("stale revision → REVISION_CONFLICT carrying the current version", async () => {
    const res = await commandsValidate(projectId, USER, ADD_MARKER.commandId, ADD_MARKER.params, 99);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("REVISION_CONFLICT");
      expect(res.currentVersion).toBe(ver);
    }
  });

  test("unknown clip after a clip exists → executor-level VALIDATION_FAILED", async () => {
    const add = await commandsRun(projectId, USER, ADD_CLIP.commandId, ADD_CLIP.params, ver, { kind: "AUTOMATION", id: "m43-setup" });
    expect(add.ok).toBe(true);
    if (add.ok) ver = add.version;
    const res = await commandsValidate(projectId, USER, "timeline.trimClip", { type: "TrimClip", clipId: "ghost", newSourceInFrame: 5 }, ver);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("VALIDATION_FAILED");
  });
});

describe("M43-B commands.preview (non-mutating)", () => {
  test("preview reports the diff and NEVER mutates the head", async () => {
    const before = await headVersion();
    const res = await commandsPreview(projectId, USER, ADD_MARKER.commandId, ADD_MARKER.params, ver);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.headVersion).toBe(before);
    expect(res.preview.ok).toBe(true);
    if (res.preview.ok) {
      expect(res.preview.diff.markersAdded).toEqual(["m43-mk1"]);
      expect(res.preview.sequenceAfter.markerCount).toBe(1);
    }
    expect(await headVersion()).toBe(before); // nothing persisted
  });

  test("preview of an invalid command is ok:false with the executor error", async () => {
    const res = await commandsPreview(projectId, USER, "timeline.trimClip", { type: "TrimClip", clipId: "ghost", newSourceInFrame: 5 }, ver);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.preview.ok).toBe(false);
  });
});

describe("M43-B commands.run (revision-aware, provenance)", () => {
  test("wrong revision refused; correct revision applies and audits", async () => {
    const bad = await commandsRun(projectId, USER, ADD_MARKER.commandId, ADD_MARKER.params, 42, { kind: "AGENT", id: "riishe" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("REVISION_CONFLICT");
      expect(bad.currentVersion).toBe(ver);
    }
    const good = await commandsRun(projectId, USER, ADD_MARKER.commandId, ADD_MARKER.params, ver, { kind: "AGENT", id: "riishe" });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    ver = good.version;
    expect(good.commandType).toBe("AddMarker");
    expect(good.inverse.length).toBeGreaterThan(0);
    const audit = await db.automationAudit.findFirst({ where: { userId: USER, action: "COMMANDS_RUN" }, orderBy: { createdAt: "desc" } });
    expect(audit).not.toBeNull();
    const detail = JSON.parse(audit!.detailJson ?? "{}");
    expect(detail.proposedBy).toEqual({ kind: "AGENT", id: "riishe" });
    expect(detail.revisionTo).toBe(ver);
  });

  test("destructive command: APPROVAL_REQUIRED without context, applies with it", async () => {
    const remove = { commandId: "timeline.removeMarker", params: { type: "RemoveMarker", markerId: "m43-mk1" } };
    const refused = await commandsRun(projectId, USER, remove.commandId, remove.params, ver, { kind: "AGENT", id: "story-architect" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("APPROVAL_REQUIRED");
    const ok = await commandsRun(projectId, USER, remove.commandId, remove.params, ver, { kind: "AGENT", id: "riishe" }, { source: "APPROVED_PLAN", reference: "plan-1" });
    expect(ok.ok).toBe(true);
    if (ok.ok) ver = ok.version;
  });
});

describe("M43-B commands.batch (atomic, all-or-nothing)", () => {
  test("bad schema entry fails at its index with nothing persisted", async () => {
    const res = await commandsBatch(projectId, USER, [{ commandId: "timeline.addMarker", params: { type: "Bogus" } }], ver, { kind: "AGENT", id: "assistant-editor" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("VALIDATION_FAILED");
      expect(res.failedIndex).toBe(0);
    }
    expect(await headVersion()).toBe(ver);
  });

  test("mid-batch failure aborts atomically — no partial write", async () => {
    const entries = [
      ADD_MARKER,
      { commandId: "timeline.trimClip", params: { type: "TrimClip", clipId: "ghost", newSourceInFrame: 5 } },
    ];
    const res = await commandsBatch(projectId, USER, entries, ver, { kind: "AGENT", id: "assistant-editor" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("BATCH_ABORTED");
      expect(res.failedIndex).toBe(1);
    }
    expect(await headVersion()).toBe(ver); // nothing persisted
    const head = await getTimelineHead(projectId, USER);
    expect(head.sequence.markers.find((m) => m.id === "m43-mk1")).toBeUndefined();
  });

  test("valid batch applies atomically as ONE version", async () => {
    const entries = [
      ADD_MARKER,
      { commandId: "timeline.updateMarker", params: { type: "UpdateMarker", markerId: "m43-mk1", newLabel: "renamed-in-batch" } },
    ];
    const res = await commandsBatch(projectId, USER, entries, ver, { kind: "AUTOMATION", id: "workflow-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    ver = res.version;
    expect(res.applied).toBe(2);
    const head = await getTimelineHead(projectId, USER);
    expect(head.sequence.markers.find((m) => m.id === "m43-mk1")?.label).toBe("renamed-in-batch");
  });

  test("stale revision on a batch → REVISION_CONFLICT, nothing applied", async () => {
    const res = await commandsBatch(projectId, USER, [ADD_MARKER], ver - 1, { kind: "AGENT", id: "riishe" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("REVISION_CONFLICT");
    expect(await headVersion()).toBe(ver);
  });
});

describe("M43-B MCP tools surface", () => {
  test("commands.list works with read scope only", async () => {
    const out = await callTool({ auth: auth(["projects:read"]) }, "commands.list", { projectId });
    expect(out.ok).toBe(true);
    expect((out as { commands: unknown[] }).commands.length).toBe(36);
  });

  test("mutating tool refused without projects:write scope", async () => {
    await expect(callTool({ auth: auth(["projects:read"]) }, "commands.run", { projectId, commandId: ADD_MARKER.commandId, params: ADD_MARKER.params, expectedRevision: ver, approvalId: "x" })).rejects.toThrow(/scope/);
  });

  test("commands.run with write scope but no approval → approval gate error", async () => {
    const args = { projectId, commandId: ADD_MARKER.commandId, params: { type: "AddMarker", marker: { id: "m43-mcp", frame: 10, label: "mcp" } }, expectedRevision: ver };
    const out = await callTool({ auth: auth(["projects:read", "projects:write"]) }, "commands.run", { ...args, approvalId: "nonexistent" });
    expect(out.ok).toBe(false);
    expect((out as { code: string }).code).toBe("APPROVAL_GATE");
  });

  test("commands.run with hash-bound one-time approval mutates exactly once", async () => {
    const args = { projectId, commandId: ADD_MARKER.commandId, params: { type: "AddMarker", marker: { id: "m43-mcp", frame: 10, label: "mcp" } }, expectedRevision: ver };
    const approvalId = await createApproval("commands.run", args);
    const out = await callTool({ auth: auth(["projects:read", "projects:write"]) }, "commands.run", { ...args, approvalId });
    expect(out.ok).toBe(true);
    if ((out as { ok: boolean }).ok) {
      ver = (out as { version: number }).version;
      expect(ver).toBeGreaterThanOrEqual(2);
    }
    // One-time: a replay with the SAME approval id is refused (consumed).
    const replay = await callTool({ auth: auth(["projects:read", "projects:write"]) }, "commands.run", { ...args, approvalId });
    expect(replay.ok).toBe(false);
    expect((replay as { code: string }).code).toBe("APPROVAL_GATE");
    // The mutated timeline really carries the MCP-proposed marker + provenance.
    const head = await getTimelineHead(projectId, USER);
    expect(head.sequence.markers.find((m) => m.id === "m43-mcp")).toBeDefined();
    const audit = await db.automationAudit.findFirst({ where: { userId: USER, action: "COMMANDS_RUN", projectId }, orderBy: { createdAt: "desc" } });
    expect(audit && JSON.parse(audit.detailJson ?? "{}").proposedBy.kind).toBe("MCP");
  });

  test("commands.preview via MCP is read-only (no approval needed)", async () => {
    const out = await callTool({ auth: auth(["projects:read"]) }, "commands.preview", { projectId, commandId: ADD_MARKER.commandId, params: ADD_MARKER.params });
    expect(out.ok).toBe(true);
    expect(await headVersion()).toBe(ver);
  });

  test("commands.describe via MCP", async () => {
    const out = await callTool({ auth: auth(["projects:read"]) }, "commands.describe", { commandId: "timeline.rollEdit" });
    expect(out.ok).toBe(true);
    expect((out as { descriptor: { commandType: string } }).descriptor.commandType).toBe("RollEdit");
  });

  test("commands.validate via MCP reports VALIDATION_FAILED for a bad entry", async () => {
    const out = await callTool({ auth: auth(["projects:read"]) }, "commands.validate", { projectId, commandId: "timeline.addMarker", params: { type: "AddMarker", marker: { id: "bad", frame: -1 } } });
    expect(out.ok).toBe(false);
    expect((out as { code: string }).code).toBe("VALIDATION_FAILED");
  });
});
