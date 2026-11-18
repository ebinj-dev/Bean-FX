/**
 * BEAN FX — Timeline persistence (Milestone 1, shared editing core).
 *
 * Every successful edit batch creates a NEW immutable version (full snapshot
 * + per-command audit rows). Nothing is ever updated or deleted in place:
 *   - optimistic concurrency via the client's baseVersion → 409 on conflict,
 *     so an AI proposal can never overwrite edits made after it was generated
 *     (directive §8);
 *   - atomic persistence inside one Prisma transaction (directive §12-G);
 *   - history is append-only; restore creates a new version from an old
 *     snapshot — history itself is never rewritten.
 */
import { db } from "@/lib/db";
import { applyTransaction } from "./engine";
import { parseSequence, type Sequence, type Track } from "./model";
import { makeRational } from "./time";

export class VersionConflictError extends Error {
  constructor(
    public headVersion: number,
    public headSequence: Sequence,
  ) {
    super(`timeline version conflict: your batch is based on a stale version (server head is version ${headVersion}) — reload before editing`);
    this.name = "VersionConflictError";
  }
}

export class ProjectNotFoundError extends Error {
  constructor() {
    super("project not found for this user");
    this.name = "ProjectNotFoundError";
  }
}

const MAX_EDITS_PER_BATCH = 500;
const MAX_SEQUENCE_BYTES = 8 * 1024 * 1024; // 8 MB snapshot cap — corrupt/absurd states rejected

function defaultSequence(projectId: string, projectName: string, settings: ProjectSettings): Sequence {
  const tracks: Track[] = [
    { id: `${projectId}-v1`, kind: "VIDEO", name: "Video 1", visible: true, muted: false, solo: false, locked: false, volume: 1 },
    { id: `${projectId}-v2`, kind: "VIDEO", name: "Video 2", visible: true, muted: false, solo: false, locked: false, volume: 1 },
    { id: `${projectId}-g1`, kind: "GRAPHIC", name: "Graphics", visible: true, muted: false, solo: false, locked: false, volume: 1 },
    { id: `${projectId}-cap1`, kind: "CAPTION", name: "Captions", visible: true, muted: false, solo: false, locked: false, volume: 1 },
    { id: `${projectId}-a1`, kind: "AUDIO", name: "Audio 1", visible: true, muted: false, solo: false, locked: false, volume: 1 },
    { id: `${projectId}-a2`, kind: "AUDIO", name: "Audio 2", visible: true, muted: false, solo: false, locked: false, volume: 1 },
  ];
  return {
    id: `${projectId}-seq`,
    name: projectName,
    fps: makeRational(settings.fpsNum, settings.fpsDen),
    width: settings.width,
    height: settings.height,
    sampleRate: settings.sampleRate,
    tracks,
    clips: [],
    transitions: [],
		markers: [],
  };
}

export interface ProjectSettings {
  fpsNum: number;
  fpsDen: number;
  width: number;
  height: number;
  sampleRate: number;
}

const DEFAULT_SETTINGS: ProjectSettings = { fpsNum: 30, fpsDen: 1, width: 1920, height: 1080, sampleRate: 48000 };

function settingsFromProject(settingsJson: string | null): ProjectSettings {
  if (!settingsJson) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(settingsJson) as Partial<ProjectSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    if (
      !Number.isInteger(merged.fpsNum) ||
      !Number.isInteger(merged.fpsDen) ||
      merged.fpsNum <= 0 ||
      merged.fpsDen <= 0 ||
      !Number.isInteger(merged.width) ||
      !Number.isInteger(merged.height) ||
      !Number.isInteger(merged.sampleRate)
    ) {
      return DEFAULT_SETTINGS;
    }
    return merged as ProjectSettings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function requireOwnedProject(projectId: string, userId: string) {
  const project = await db.project.findFirst({ where: { id: projectId, userId } });
  if (!project) throw new ProjectNotFoundError();
  return project;
}

export interface TimelineHead {
  version: number;
  sequence: Sequence;
  isAutosave: boolean;
  updatedAt: Date;
}

/** The latest version for a project; creates version 1 (empty default
 *  sequence) on first access so an editor session always has a head. */
export async function getTimelineHead(projectId: string, userId: string): Promise<TimelineHead> {
  const project = await requireOwnedProject(projectId, userId);
  const head = await db.timelineVersion.findFirst({
    where: { projectId },
    orderBy: { versionNumber: "desc" },
    include: { edits: { orderBy: { opIndex: "asc" } } },
  });
  if (!head) {
    const settings = settingsFromProject(project.settingsJson ?? null);
    const sequence = defaultSequence(projectId, project.name, settings);
    const created = await db.timelineVersion.create({
      data: {
        projectId,
        versionNumber: 1,
        sequenceJson: JSON.stringify(sequence),
        isAutosave: false,
        createdById: userId,
      },
    });
    return { version: 1, sequence, isAutosave: false, updatedAt: created.createdAt };
  }
  return {
    version: head.versionNumber,
    sequence: parseSequence(JSON.parse(head.sequenceJson)),
    isAutosave: head.isAutosave,
    updatedAt: head.createdAt,
  };
}

export interface ApplyEditsResult {
  version: number;
  sequence: Sequence;
  warnings: string[];
  isAutosave: boolean;
}

/** Apply a validated batch of editing commands as the next version.
 *  Conflict detection: the caller must base the batch on the version it read
 *  (baseVersion). If the head moved, nothing is written and the conflict
 *  carries the authoritative head so the client can rebase. */
export async function applyTimelineEdits(
  projectId: string,
  userId: string,
  baseVersion: number,
  edits: unknown[],
  isAutosave = false,
): Promise<ApplyEditsResult> {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("edits must be a non-empty array of commands");
  }
  if (edits.length > MAX_EDITS_PER_BATCH) {
    throw new Error(`too many edits in one batch (max ${MAX_EDITS_PER_BATCH}) — split the transaction`);
  }
  await requireOwnedProject(projectId, userId);

  const head = await db.timelineVersion.findFirst({
    where: { projectId },
    orderBy: { versionNumber: "desc" },
  });
  if (!head) {
    // First-touch: ensure version 1 exists, then re-read for the conflict check.
    await getTimelineHead(projectId, userId);
    return applyTimelineEdits(projectId, userId, baseVersion, edits, isAutosave);
  }
  if (head.versionNumber !== baseVersion) {
    throw new VersionConflictError(head.versionNumber, parseSequence(JSON.parse(head.sequenceJson)));
  }

  const current = parseSequence(JSON.parse(head.sequenceJson));
  const result = applyTransaction(current, edits);
  const sequenceJson = JSON.stringify(result.sequence);
  if (sequenceJson.length > MAX_SEQUENCE_BYTES) {
    throw new Error(`sequence snapshot exceeds ${MAX_SEQUENCE_BYTES} bytes — reduce clips or keyframes`);
  }

  const nextVersion = head.versionNumber + 1;
  // Atomic: snapshot + audit rows commit together or not at all. Two writers
  // that pass the head check simultaneously are separated by the DB-level
  // unique constraint — the loser surfaces as a REAL 409 (with the fresh head)
  // instead of a raw P2002 400 the client would treat as generic failure.
  try {
    // M20: the default interactive-transaction timeout is 5s. A cold standalone
    // server's first timeline write (route JIT + SQLite WAL contention during
    // suite fan-in) can exceed it and 400 the whole edit batch. 15s keeps the
    // atomicity guarantee while tolerating cold-start latency.
    await db.$transaction(async (tx) => {
      const created = await tx.timelineVersion.create({
        data: {
          projectId,
          versionNumber: nextVersion,
          sequenceJson,
          isAutosave,
          createdById: userId,
        },
      });
      for (let i = 0; i < edits.length; i++) {
        const cmd = edits[i] as { type?: string };
        await tx.timelineEdit.create({
          data: {
            versionId: created.id,
            opIndex: i,
            type: typeof cmd?.type === "string" ? cmd.type.slice(0, 64) : "UNKNOWN",
            payloadJson: JSON.stringify(edits[i]).slice(0, 200_000),
            inverseJson: JSON.stringify(result.inverses[i] ?? []).slice(0, 400_000),
          },
        });
      }
    }, { timeout: 15_000, maxWait: 10_000 });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      const winner = await db.timelineVersion.findFirst({
        where: { projectId },
        orderBy: { versionNumber: "desc" },
      });
      if (winner) {
        throw new VersionConflictError(winner.versionNumber, parseSequence(JSON.parse(winner.sequenceJson)));
      }
    }
    throw err;
  }

  return { version: nextVersion, sequence: result.sequence, warnings: result.warnings, isAutosave };
}

export interface VersionSummary {
  version: number;
  isAutosave: boolean;
  editCount: number;
  createdAt: string;
}

export async function listTimelineVersions(projectId: string, userId: string, take = 50, skip = 0): Promise<VersionSummary[]> {
  await requireOwnedProject(projectId, userId);
  const versions = await db.timelineVersion.findMany({
    where: { projectId },
    orderBy: { versionNumber: "desc" },
    take: Math.min(Math.max(take, 1), 200),
    skip: Math.max(skip, 0),
    include: { _count: { select: { edits: true } } },
  });
  return versions.map((v) => ({
    version: v.versionNumber,
    isAutosave: v.isAutosave,
    editCount: v._count.edits,
    createdAt: v.createdAt.toISOString(),
  }));
}

export interface RestoreResult {
  version: number;
  sequence: Sequence;
  restoredFrom: number;
}

/** Rollback = new version whose snapshot is an old version's snapshot. The
 *  history stays append-only; nothing old is deleted or modified. */
export async function restoreTimelineVersion(projectId: string, userId: string, versionNumber: number, baseVersion: number): Promise<RestoreResult> {
  await requireOwnedProject(projectId, userId);
  const source = await db.timelineVersion.findFirst({
    where: { projectId, versionNumber },
  });
  if (!source) throw new Error(`version ${versionNumber} does not exist`);
  const head = await db.timelineVersion.findFirst({ where: { projectId }, orderBy: { versionNumber: "desc" } });
  if (!head || head.versionNumber !== baseVersion) {
    throw new VersionConflictError(head?.versionNumber ?? 0, head ? parseSequence(JSON.parse(head.sequenceJson)) : (await getTimelineHead(projectId, userId)).sequence);
  }
  const sequence = parseSequence(JSON.parse(source.sequenceJson));
  const nextVersion = head.versionNumber + 1;
  await db.timelineVersion.create({
    data: {
      projectId,
      versionNumber: nextVersion,
      sequenceJson: source.sequenceJson,
      isAutosave: false,
      createdById: userId,
    },
  });
  return { version: nextVersion, sequence, restoredFrom: versionNumber };
}
