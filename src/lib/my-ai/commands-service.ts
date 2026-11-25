/**
 * BEAN FX — M43-B commands service (FilmCraft pattern: one authoritative
 * dispatcher for UI, RIISHE, specialist agents, MCP tools and automation).
 *
 * This is the ONLY DB-facing entry point built on top of the canonical
 * executor chain: parseCommand → applyCommand/applyTransaction →
 * applyTimelineEdits (versioned snapshots + audit). It adds:
 *   - commands.list / describe / validate / preview (read-only discovery)
 *   - commands.run / batch (revision-aware mutations with provenance)
 *   - approval policy for destructive commands (approved plan, hash-bound
 *     MCP approval, or an authenticated UI session)
 *   - registry-driven availability gating (advisory pre-check; the executor
 *     stays the fail-closed authority)
 *
 * LLMs never touch timeline JSON or DB rows directly — they submit
 * (commandId, params) pairs here and get structured results back.
 */
import { db } from "@/lib/db";
import { getTimelineHead, applyTimelineEdits, ProjectNotFoundError, VersionConflictError, type TimelineHead } from "@/lib/editor/persistence";
import { parseCommand, validateCommand, applyCommand, EditorError, type Command } from "@/lib/editor/commands";
import { COMMAND_DESCRIPTORS, descriptorById, previewCommand, type CommandDescriptor, type CommandPreview } from "@/lib/editor/command-registry";

/** Who is dispatching — recorded on every mutation (provenance, §7). */
export interface CommandCaller {
  kind: "UI" | "AGENT" | "MCP" | "AUTOMATION" | "CLI";
  /** Agent/tool/session identifier (e.g. "riishe", "mcp:token:<id>"). */
  id?: string;
}

/** Present for destructive commands; agents get APPROVED_PLAN (M8 §8) or
 *  MCP_APPROVAL (hash-bound one-time), the UI presents its session. */
export interface ApprovalContext {
  source: "APPROVED_PLAN" | "MCP_APPROVAL" | "UI_SESSION";
  reference: string;
}

export type ServiceErrorCode =
  | "UNKNOWN_COMMAND"
  | "REVISION_CONFLICT"
  | "PROJECT_NOT_FOUND"
  | "UNAVAILABLE"
  | "VALIDATION_FAILED"
  | "APPROVAL_REQUIRED"
  | "EMPTY_BATCH"
  | "BATCH_ABORTED"
  | "INTERNAL_ERROR";

export type CommandServiceFailure = {
  ok: false;
  code: ServiceErrorCode;
  error: string;
  currentVersion?: number;
  failedIndex?: number;
};

export type CommandServiceResult<T> = ({ ok: true } & T) | CommandServiceFailure;

function revisionConflict(head: TimelineHead): CommandServiceFailure {
  return {
    ok: false,
    code: "REVISION_CONFLICT",
    error: `timeline is at revision ${head.version} — resubmit with the current revision`,
    currentVersion: head.version,
  };
}

function mapPersistenceError(e: unknown, fallbackCode: ServiceErrorCode = "INTERNAL_ERROR"): CommandServiceFailure {
  if (e instanceof VersionConflictError) {
    return { ok: false, code: "REVISION_CONFLICT", error: `a concurrent edit moved the timeline (now at revision ${e.headVersion}) — resubmit with the current revision`, currentVersion: e.headVersion };
  }
  if (e instanceof ProjectNotFoundError) {
    return { ok: false, code: "PROJECT_NOT_FOUND", error: e.message };
  }
  return { ok: false, code: fallbackCode, error: e instanceof Error ? e.message : String(e) };
}

type LoadedHead = { ok: true; head: TimelineHead } | CommandServiceFailure;

async function loadHead(projectId: string, userId: string): Promise<LoadedHead> {
  try {
    return { ok: true, head: await getTimelineHead(projectId, userId) };
  } catch (e) {
    return mapPersistenceError(e, "PROJECT_NOT_FOUND");
  }
}

function gate(descriptor: CommandDescriptor, head: TimelineHead, expectedRevision: number | undefined): CommandServiceFailure | null {
  if (expectedRevision !== undefined && expectedRevision !== head.version) return revisionConflict(head);
  const availability = descriptor.available(head.sequence);
  if (!availability.ok) return { ok: false, code: "UNAVAILABLE", error: `command ${descriptor.id} is not available: ${availability.reason}` };
  return null;
}

function gateApproval(descriptor: CommandDescriptor, approval: ApprovalContext | undefined): CommandServiceFailure | null {
  if (!descriptor.requiresApproval) return null;
  if (approval) return null;
  return {
    ok: false,
    code: "APPROVAL_REQUIRED",
    error: `command ${descriptor.id} is destructive (${descriptor.commandType}) — present an approval context (approved plan, hash-bound MCP approval, or UI session)`,
  };
}

async function auditMutation(userId: string, projectId: string, action: string, detail: Record<string, unknown>): Promise<void> {
  await db.automationAudit
    .create({ data: { userId, projectId, action, detailJson: JSON.stringify(detail) } })
    .catch(() => undefined); // audit is best-effort; the mutation itself is already durable
}

// ── read-only discovery ─────────────────────────────────────────────────────

export async function commandsList(
  projectId: string,
  userId: string,
): Promise<CommandServiceResult<{ headVersion: number; commands: Array<{ id: string; commandType: string; description: string; category: string; risk: string; requiresApproval: boolean; available: { ok: boolean; reason?: string } }>; }>> {
  const loaded = await loadHead(projectId, userId);
  if (!loaded.ok) return loaded;
  const head = loaded.head;
  return {
    ok: true,
    headVersion: head.version,
    commands: COMMAND_DESCRIPTORS.map((c) => ({
      id: c.id,
      commandType: c.commandType,
      description: c.description,
      category: c.category,
      risk: c.risk,
      requiresApproval: c.requiresApproval,
      available: c.available(head.sequence),
    })),
  };
}

export function commandsDescribe(commandId: string): CommandServiceResult<{ descriptor: Omit<CommandDescriptor, "available"> }> {
  const c = descriptorById(commandId);
  if (!c) return { ok: false, code: "UNKNOWN_COMMAND", error: `unknown command id: ${commandId}` };
  const { available: _avail, ...rest } = c;
  return { ok: true, descriptor: rest };
}

// ── validation + preview (never mutate, never persist) ──────────────────────

export async function commandsValidate(
  projectId: string,
  userId: string,
  commandId: string,
  params: unknown,
  expectedRevision?: number,
): Promise<CommandServiceResult<{ warnings: string[]; headVersion: number }>> {
  const c = descriptorById(commandId);
  if (!c) return { ok: false, code: "UNKNOWN_COMMAND", error: `unknown command id: ${commandId}` };
  const loaded = await loadHead(projectId, userId);
  if (!loaded.ok) return loaded;
  const head = loaded.head;
  const gated = gate(c, head, expectedRevision);
  if (gated) return gated;
  let cmd: Command;
  try {
    cmd = parseCommand(params);
  } catch (e) {
    return { ok: false, code: "VALIDATION_FAILED", error: e instanceof EditorError ? e.message : String(e) };
  }
  const verdict = validateCommand(head.sequence, cmd);
  if (!verdict.ok) return { ok: false, code: "VALIDATION_FAILED", error: verdict.error, currentVersion: head.version };
  return { ok: true, warnings: verdict.warnings, headVersion: head.version };
}

export async function commandsPreview(
  projectId: string,
  userId: string,
  commandId: string,
  params: unknown,
  expectedRevision?: number,
): Promise<CommandServiceResult<{ preview: CommandPreview; headVersion: number }>> {
  const c = descriptorById(commandId);
  if (!c) return { ok: false, code: "UNKNOWN_COMMAND", error: `unknown command id: ${commandId}` };
  const loaded = await loadHead(projectId, userId);
  if (!loaded.ok) return loaded;
  const head = loaded.head;
  const gated = gate(c, head, expectedRevision);
  if (gated) return gated;
  // previewCommand parses via the canonical executor — schema/validation
  // failures surface as preview.ok:false (preview == apply, by construction).
  return { ok: true, preview: previewCommand(head.sequence, params), headVersion: head.version };
}

// ── mutations (revision-aware, provenance-recorded) ─────────────────────────

async function resolveCommand(commandId: string, params: unknown): Promise<{ cmd?: Command; err?: CommandServiceFailure }> {
  const c = descriptorById(commandId);
  if (!c) return { err: { ok: false, code: "UNKNOWN_COMMAND", error: `unknown command id: ${commandId}` } };
  try {
    return { cmd: parseCommand(params) };
  } catch (e) {
    return { err: { ok: false, code: "VALIDATION_FAILED", error: `${commandId}: ${e instanceof EditorError ? e.message : String(e)}` } };
  }
}

export async function commandsRun(
  projectId: string,
  userId: string,
  commandId: string,
  params: unknown,
  expectedRevision: number,
  caller: CommandCaller,
  approval?: ApprovalContext,
): Promise<CommandServiceResult<{ version: number; inverse: Command[]; commandType: string }>> {
  const c = descriptorById(commandId);
  if (!c) return { ok: false, code: "UNKNOWN_COMMAND", error: `unknown command id: ${commandId}` };
  const resolved = await resolveCommand(commandId, params);
  if (resolved.err) return resolved.err;
  const loaded = await loadHead(projectId, userId);
  if (!loaded.ok) return loaded;
  const head = loaded.head;
  const gated = gate(c, head, expectedRevision);
  if (gated) return gated;
  const approvalGate = gateApproval(c, approval);
  if (approvalGate) return approvalGate;
  // Dry-run on clones: identical math to the persisted apply (deterministic
  // executor), yielding the exact inverse stack for undo.
  let inverse: Command[];
  try {
    inverse = applyCommand(head.sequence, resolved.cmd as Command).inverse;
  } catch (e) {
    return { ok: false, code: "VALIDATION_FAILED", error: e instanceof EditorError ? e.message : String(e), currentVersion: head.version };
  }
  try {
    const result = await applyTimelineEdits(projectId, userId, head.version, [resolved.cmd as Command], false);
    await auditMutation(userId, projectId, "COMMANDS_RUN", {
      commandId,
      commandType: c.commandType,
      proposedBy: caller,
      approval: approval ?? null,
      revisionFrom: head.version,
      revisionTo: result.version,
    });
    return { ok: true, version: result.version, inverse, commandType: c.commandType };
  } catch (e) {
    return mapPersistenceError(e);
  }
}

export interface BatchEntry {
  commandId: string;
  params: unknown;
}

export async function commandsBatch(
  projectId: string,
  userId: string,
  entries: BatchEntry[],
  expectedRevision: number,
  caller: CommandCaller,
  approval?: ApprovalContext,
): Promise<CommandServiceResult<{ version: number; applied: number; commandTypes: string[] }>> {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, code: "EMPTY_BATCH", error: "batch needs at least one command entry" };
  }
  // Pre-resolve every entry (fail fast, precise failedIndex, zero DB writes).
  const commands: Command[] = [];
  const types: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const resolved = await resolveCommand(entries[i].commandId, entries[i].params);
    if (resolved.err) return { ...resolved.err, failedIndex: i };
    commands.push(resolved.cmd as Command);
    types.push(entries[i].commandId);
  }
  const loaded = await loadHead(projectId, userId);
  if (!loaded.ok) return loaded;
  const head = loaded.head;
  if (expectedRevision !== head.version) return revisionConflict(head);
  // Dry-run the whole batch on clones (canonical applyCommand): collects the
  // exact inverse stack for undo, evaluates registry availability against the
  // EVOLVING sequence (a later command may become valid after an earlier one),
  // and locates the first failure precisely — all with zero DB writes. The
  // persisted apply below re-runs the identical deterministic math.
  let seq = head.sequence;
  const inverses: Command[][] = [];
  for (let i = 0; i < commands.length; i++) {
    const descriptor = COMMAND_DESCRIPTORS.find((x) => x.commandType === commands[i].type);
    if (!descriptor) return { ok: false, code: "UNKNOWN_COMMAND", error: `no descriptor for command type ${commands[i].type}`, failedIndex: i };
    const availability = descriptor.available(seq);
    if (!availability.ok) return { ok: false, code: "UNAVAILABLE", error: `command ${entries[i].commandId} is not available: ${availability.reason}`, failedIndex: i };
    try {
      const r = applyCommand(seq, commands[i]);
      seq = r.sequence;
      inverses.push(r.inverse);
    } catch (e) {
      return {
        ok: false,
        code: "BATCH_ABORTED",
        failedIndex: i,
        error: `transaction aborted at command ${i + 1}/${commands.length}: ${e instanceof Error ? e.message : String(e)}`,
        currentVersion: head.version,
      };
    }
  }
  const anyDestructive = commands.some((cmd) => COMMAND_DESCRIPTORS.find((x) => x.commandType === cmd.type)?.requiresApproval);
  if (anyDestructive) {
    const approvalGate = gateApproval({ ...(COMMAND_DESCRIPTORS.find((x) => x.requiresApproval) as CommandDescriptor) }, approval);
    if (approvalGate) return approvalGate;
  }
  try {
    const result = await applyTimelineEdits(projectId, userId, head.version, commands, false);
    await auditMutation(userId, projectId, "COMMANDS_BATCH", {
      commandIds: types,
      proposedBy: caller,
      approval: approval ?? null,
      revisionFrom: head.version,
      revisionTo: result.version,
      inverses: inverses.flat().length,
    });
    return { ok: true, version: result.version, applied: commands.length, commandTypes: types };
  } catch (e) {
    return mapPersistenceError(e);
  }
}
