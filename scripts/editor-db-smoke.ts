/**
 * BEAN FX — live persistence smoke test for the editor timeline core.
 *
 * Runs against a THROWAWAY SQLite database (DATABASE_URL is overridden to a
 * temp file, never the developer's live DB) and exercises the real Prisma
 * persistence path: versioned snapshots, optimistic-conflict detection,
 * autosave flag, append-only restore, and atomic audit rows.
 *
 * Usage: DATABASE_URL="file:/tmp/editor-smoke.db" bun scripts/editor-db-smoke.ts
 */
import { execSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import path from "node:path";

const DB_PATH = process.env.SMOKE_DB_PATH ?? "/tmp/beanfx-editor-smoke.db";
process.env.DATABASE_URL = `file:${DB_PATH}`;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail.slice(0, 140)}` : ""}`);
}

try {
  unlinkSync(DB_PATH);
} catch {
  /* first run */
}

// Generate the client and push the schema to the throwaway DB (real tooling,
// no mocks).
execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  cwd: path.resolve(import.meta.dir, ".."),
  env: { ...process.env, DATABASE_URL: `file:${DB_PATH}` },
  stdio: "pipe",
});
execSync("bunx prisma generate", { cwd: path.resolve(import.meta.dir, ".."), stdio: "pipe" });

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
const { applyTimelineEdits, getTimelineHead, listTimelineVersions, restoreTimelineVersion, VersionConflictError } = await import(
  "../src/lib/editor/persistence"
);

const clip = (id: string, start: number, out = 150, trackId?: string) => ({
  type: "AddClip",
  clip: {
    id,
    trackId: trackId ?? "t-video",
    sourceAssetId: "asset-1",
    sourceInFrame: 0,
    sourceOutFrame: out,
    sourceFps: { num: 30, den: 1 },
    timelineStartFrame: start,
    playbackSpeed: 1,
    volume: 1,
    muted: false,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null,
    captionStyle: null,
    graphicTemplateId: null,
    label: null,
    missingMedia: false,
    effects: [],
    keyframes: [],
  },
});

async function main() {
  const user = await db.user.create({ data: { email: `smoke-${Date.now()}@beanfx.test`, name: "smoke", passwordHash: "x" } });
  const project = await db.project.create({ data: { userId: user.id, name: "Smoke Project" } });

  const head1 = await getTimelineHead(project.id, user.id);
  check("first touch creates version 1 with default tracks", head1.version === 1 && head1.sequence.tracks.length === 6, `v${head1.version}`);
  const videoTrackId = head1.sequence.tracks.find((t) => t.kind === "VIDEO")!.id;

  const r1 = await applyTimelineEdits(project.id, user.id, 1, [clip("a", 0, 150, videoTrackId), clip("b", 150, 150, videoTrackId)]);
  check("edit batch creates version 2 with 2 clips", r1.version === 2 && r1.sequence.clips.length === 2, `v${r1.version}`);

  const auditRows = await db.timelineEdit.count({ where: { version: { versionNumber: 2, projectId: project.id } } });
  check("audit rows persisted per command (2)", auditRows === 2, `rows=${auditRows}`);

  const r2 = await applyTimelineEdits(project.id, user.id, 2, [{ type: "ChangeVolume", clipId: "a", volume: 0.5 }]);
  check("second batch → version 3", r2.version === 3, `v${r2.version}`);

  // Optimistic concurrency: stale base version must conflict and carry the head.
  let conflicted = false;
  try {
    await applyTimelineEdits(project.id, user.id, 2, [clip("stale", 0)]);
  } catch (e) {
    conflicted = e instanceof VersionConflictError && e.headVersion === 3;
  }
  check("stale baseVersion rejected with VersionConflictError carrying head", conflicted);

  // Ownership: another user cannot read or write this project's timeline.
  const stranger = await db.user.create({ data: { email: `smoke-stranger-${Date.now()}@beanfx.test`, name: "s", passwordHash: "x" } });
  let forbidden = false;
  try {
    await getTimelineHead(project.id, stranger.id);
  } catch {
    forbidden = true;
  }
  check("cross-user access refused (ProjectNotFoundError)", forbidden);

  // Autosave flag is persisted and visible in history.
  await applyTimelineEdits(project.id, user.id, 3, [{ type: "ChangeVolume", clipId: "a", volume: 0.75 }], true);
  const versions = await listTimelineVersions(project.id, user.id);
  check("version history lists 4 versions", versions.length === 4, JSON.stringify(versions.map((v) => v.version)));
  check("autosave version flagged", versions.find((v) => v.version === 4)?.isAutosave === true);

  // Restore is append-only: restoring v2 creates v5 with v2's content.
  const restored = await restoreTimelineVersion(project.id, user.id, 2, 4);
  check("restore creates version 5 from version 2", restored.version === 5 && restored.restoredFrom === 2, `v${restored.version}`);
  check("restored sequence has the v2 clip volumes", restored.sequence.clips.every((c) => c.volume === 1), `vols=${restored.sequence.clips.map((c) => c.volume)}`);
  const history = await listTimelineVersions(project.id, user.id);
  check("history is append-only (5 versions, none deleted)", history.length === 5, `n=${history.length}`);

  // Server-side validation: a command that would corrupt the timeline is refused before any write.
  let refused = false;
  try {
    await applyTimelineEdits(project.id, user.id, 5, [clip("bad", 0, 0)]); // empty source range
  } catch (e) {
    refused = e instanceof Error && /aborted|rejected|invalid/i.test(e.message);
  }
  check("invalid command refused before persistence", refused);
  const after = await getTimelineHead(project.id, user.id);
  check("head unchanged after refused batch", after.version === 5, `v${after.version}`);

  await db.user.delete({ where: { id: user.id } });
  await db.user.delete({ where: { id: stranger.id } });
  await db.$disconnect();
  console.log(failures === 0 ? "\nRESULT: persistence smoke PASSED" : `\nRESULT: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
