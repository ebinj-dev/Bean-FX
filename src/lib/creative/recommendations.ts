/**
 * M10 — Smart Editing Recommendations (§5).
 *
 * Findings → typed, engine-routed proposals. ONLY `timeline-commands`
 * payloads touch the timeline, and they execute EXCLUSIVELY through the M1
 * command engine (`parseCommand` → `validateCommand` on the live head) and
 * the M2 versioned persistence (`applyTimelineEdits`) — the same path the
 * editor and MY AI use, so undo/redo, autosave and version history are
 * untouched by construction. MY AI never executes shell commands or builds
 * raw FFmpeg; there is no other execution path in this module.
 *
 * Safety rules enforced here:
 *  - every executable proposal requires explicit approval (status PROPOSED →
 *    APPROVED → EXECUTED), individually, one at a time;
 *  - stale proposals are rejected: the recommendation records the timeline
 *    version at proposal time and refuses to run if the head moved;
 *  - locked tracks / invalid commands are refused by validateCommand and the
 *    failure is recorded honestly on the row;
 *  - informational recommendations never execute.
 */
import { db } from "@/lib/db";
import { getTimelineHead, applyTimelineEdits, VersionConflictError } from "@/lib/editor/persistence";
import { applyCommand, parseCommand, validateCommand, EditorError, type Command } from "@/lib/editor/commands";
import { jobManager } from "@/lib/job-runner";
import { JOB_TYPE_GANGZII_PROCESS, JOB_TYPE_JAZMII_GENERATE, JOB_TYPE_LAXII_GENERATE, PermanentJobError } from "@/lib/job-helpers";
import { GangziiParamsSchema } from "@/lib/gangzii/types";
import { JazmiiGenerateParamsSchema } from "@/lib/jazmii/types";
import { LaxiiGenerateParamsSchema } from "@/lib/laxii/types";
import type { MeasuredContext } from "./context";
import type { Finding, Recommendation, ProposalPayload } from "./contracts";
import { RETENTION_THRESHOLDS } from "./retention";

function recFromFinding(f: Finding, engine: Recommendation["engine"], partial: Omit<Recommendation, "recNo" | "engine" | "rationale">): Recommendation {
  return {
    recNo: f.findingNo,
    engine,
    kind: partial.kind,
    title: partial.title,
    detail: partial.detail,
    target: partial.target,
    payload: partial.payload,
    preview: partial.preview,
    requiresApproval: partial.requiresApproval,
    rationale: `Finding #${f.findingNo} (${f.category}, ${f.evidenceLabel}${f.startSec !== null ? `, ${f.startSec.toFixed(1)}s` : ""}): ${f.explanation.slice(0, 300)}`,
  };
}

/**
 * Build M1 commands that remove [startSec,endSec) from ONE audio clip:
 * SplitClip at both boundaries, then RippleDelete the middle. Returns null
 * when the range does not sit inside a single clip (honest refusal instead of
 * a risky multi-clip edit).
 */
export function buildPauseRemovalCommands(ctx: MeasuredContext, startSec: number, endSec: number): { commands: Command[]; clipId: string; preview: Record<string, unknown> } | null {
  const spans = ctx.audioClipSpans;
  const host = spans.find((c) => startSec >= c.startSec + 0.05 && endSec <= c.endSec - 0.05);
  if (!host) return null;
  const fps = ctx.fps;
  const aF = Math.round(startSec * fps);
  const bF = Math.round(endSec * fps);
  const leftId = `cr-${host.id}-a`.slice(0, 60);
  const midId = `cr-${host.id}-m`.slice(0, 60);
  const rightId = `cr-${host.id}-b`.slice(0, 60);
  const commands: Command[] = [
    parseCommand({ type: "SplitClip", clipId: host.id, atTimelineFrame: aF, newLeftId: leftId, newRightId: midId }),
    parseCommand({ type: "SplitClip", clipId: midId, atTimelineFrame: bF, newLeftId: midId, newRightId: rightId }),
    parseCommand({ type: "RippleDelete", clipId: midId }),
  ];
  return {
    commands,
    clipId: host.id,
    preview: { action: "split+ripple-delete", clipId: host.id, removeStartSec: startSec, removeEndSec: endSec, note: "Runs on the AUDIO clip only; validated against the live timeline at execution; a new version is created (undo/redo preserved)." },
  };
}

/**
 * Map findings → typed recommendations (deterministic routing; no LLM).
 */
export function buildRecommendations(ctx: MeasuredContext, findings: Finding[]): Recommendation[] {
  const recs: Recommendation[] = [];
  const usedNos = new Set<number>();
  const add = (r: Recommendation) => {
    if (usedNos.has(r.recNo)) return;
    usedNos.add(r.recNo);
    recs.push(r);
  };

  for (const f of findings) {
    if (f.category === "long-pause" && f.startSec !== null && f.endSec !== null && (f.severity === "major" || f.severity === "moderate")) {
      const built = buildPauseRemovalCommands(ctx, f.startSec, f.endSec);
      if (built) {
        add(
          recFromFinding(f, "RIISHE", {
            kind: "executable",
            title: `Trim measured pause at ${f.startSec.toFixed(1)}s`,
            detail: `Split the audio clip at ${f.startSec.toFixed(2)}s and ${f.endSec.toFixed(2)}s and ripple-delete the ${ (f.endSec - f.startSec).toFixed(1) }s gap. Runs as three validated M1 commands on one audio clip.`,
            target: { clipId: built.clipId, trackId: null, startSec: f.startSec, endSec: f.endSec },
            payload: { kind: "timeline-commands", commands: built.commands as unknown as Record<string, unknown>[] },
            preview: built.preview,
            requiresApproval: true,
          }),
        );
      } else {
        add(
          recFromFinding(f, "RIISHE", {
            kind: "informational",
            title: `Review pause at ${f.startSec.toFixed(1)}s`,
            detail: "The measured pause spans a clip boundary or sits at a clip edge — an automatic split would be unsafe. Review it on the timeline (RIISHE review flow) and trim manually if it reads as dead air.",
            target: { clipId: null, trackId: null, startSec: f.startSec, endSec: f.endSec },
            payload: { kind: "informational", note: "pause spans clip boundary — manual review suggested" },
            preview: null,
            requiresApproval: false,
          }),
        );
      }
    }

    if (f.category === "audio-quality" && f.evidenceLabel === "measured") {
      const ev = f.evidence as { integratedLufs?: number; channelImbalanceDb?: number; clippingSuspected?: boolean };
      if (ev.clippingSuspected) {
        add(
          recFromFinding(f, "GANGZII", {
            kind: "executable",
            title: "Repair clipping (GANGZII repair-clip preset)",
            detail: "Queue a non-destructive GANGZII processing pass with the repair-clip preset on the narration source; preview before committing anything.",
            target: { clipId: null, trackId: null, startSec: null, endSec: null },
            payload: { kind: "engine-action", engine: "GANGZII", action: "gangzii-loudness", params: { assetId: ctx.audio?.sourceAssetId ?? null, preset: "repair-clip" } },
            preview: { engine: "GANGZII", preset: "repair-clip", note: "Creates a GANGZII PROCESS row + durable job; output preview is part of the M5 flow." },
            requiresApproval: true,
          }),
        );
      } else if (ev.channelImbalanceDb !== undefined && Math.abs(ev.channelImbalanceDb) > RETENTION_THRESHOLDS.channelImbalanceDb) {
        add(
          recFromFinding(f, "GANGZII", {
            kind: "executable",
            title: "Fix channel balance (GANGZII fix-channel-balance)",
            detail: "Queue a GANGZII balance pass with the fix-channel-balance preset on the narration source.",
            target: { clipId: null, trackId: null, startSec: null, endSec: null },
            payload: { kind: "engine-action", engine: "GANGZII", action: "gangzii-loudness", params: { assetId: ctx.audio?.sourceAssetId ?? null, preset: "fix-channel-balance" } },
            preview: { engine: "GANGZII", preset: "fix-channel-balance" },
            requiresApproval: true,
          }),
        );
      } else if (ev.integratedLufs !== undefined) {
        add(
          recFromFinding(f, "GANGZII", {
            kind: "executable",
            title: "Loudness pass toward −14 LUFS (GANGZII streaming-loudness)",
            detail: "Queue a GANGZII processing pass with the streaming-loudness preset on the narration source.",
            target: { clipId: null, trackId: null, startSec: null, endSec: null },
            payload: { kind: "engine-action", engine: "GANGZII", action: "gangzii-loudness", params: { assetId: ctx.audio?.sourceAssetId ?? null, preset: "streaming-loudness" } },
            preview: { engine: "GANGZII", preset: "streaming-loudness", referenceLufs: -14 },
            requiresApproval: true,
          }),
        );
      }
    }

    if (f.category === "caption-timing" && f.evidenceLabel === "measured") {
      add(
        recFromFinding(f, "NIIKI", {
          kind: "informational",
          title: "Improve caption readability",
          detail: "Fast cues were measured. Options: re-export captions with adjusted cue timing (RIISHE), or apply a legible caption style (larger font, outline) via the timeline caption properties. A/B test the wording in the A/B Studio if the captions double as on-screen text.",
          target: null,
          payload: { kind: "informational", note: "caption timing adjusted via RIISHE export or NIIKI caption styling" },
          preview: null,
          requiresApproval: false,
        }),
      );
    }

    if (f.category === "visual-repetition") {
      add(
        recFromFinding(f, "JAZMII", {
          kind: "executable",
          title: "Generate an alternative visual (JAZMII)",
          detail: "Queue a JAZMII text-to-video generation as a candidate replacement for the most reused shot. The output is a NEW asset — nothing on the timeline changes until you insert it yourself.",
          target: { clipId: null, trackId: null, startSec: null, endSec: null },
          payload: { kind: "engine-action", engine: "JAZMII", action: "jazmii-broll", params: { prompt: `fresh establishing shot matching the video's subject (derived from the review)`, size: "1920x1080", durationSec: "5" } },
          preview: { engine: "JAZMII", note: "metered external provider; result lands in the media library" },
          requiresApproval: true,
        }),
      );
    }

    if (f.category === "opening-hook" || (f.category === "dead-air" && f.startSec === 0)) {
      add(
        recFromFinding(f, "LAXII", {
          kind: "executable",
          title: "Generate thumbnail alternatives for the opening",
          detail: "Queue LAXII thumbnail base-image alternatives for the platform thumbnail (A/B Studio ▸ compare). The timeline is not touched; outputs are new image assets with provenance.",
          target: { clipId: null, trackId: null, startSec: 0, endSec: null },
          payload: { kind: "engine-action", engine: "LAXII", action: "laxii-thumbnail-variants", params: { projectId: ctx.projectId, platform: "youtube_landscape", count: 2 } },
          preview: { engine: "LAXII", note: "registered via the M9 Thumbnail Studio; previous selections preserved" },
          requiresApproval: true,
        }),
      );
    }
  }

  // Standing improvement: prepare-for-export checklist pointer.
  if (!recs.some((r) => r.engine === "MYAI")) {
    recs.push({
      recNo: findings.length + 1,
      engine: "MYAI",
      kind: "informational",
      title: "Prepare this project for export",
      detail: "Run the Publishing workspace export variants to validate conformance (resolution, codecs, duration caps) before uploading anywhere. The scorecard's technical-export-readiness dimension stays unscored until a variant validates.",
      target: null,
      payload: { kind: "informational", note: "publishing export validation recommended" },
      preview: null,
      requiresApproval: false,
      rationale: "Standing recommendation — no conformance-validated export exists yet.",
    });
  }
  return recs;
}

// ── persistence + execution ─────────────────────────────────────────────────

export async function persistRecommendations(
  userId: string,
  projectId: string,
  reviewId: string,
  headVersion: number,
  recs: Recommendation[],
): Promise<number> {
  let i = 0;
  for (const r of recs) {
    i += 1;
    await db.creativeRecommendation.create({
      data: {
        reviewId,
        userId,
        projectId,
        recNo: i,
        kind: r.kind,
        engine: r.engine,
        title: r.title.slice(0, 160),
        detail: r.detail.slice(0, 1200),
        targetJson: r.target ? JSON.stringify(r.target) : null,
        proposalJson: JSON.stringify(r.payload),
        previewJson: r.preview ? JSON.stringify(r.preview) : null,
        requiresApproval: r.requiresApproval,
        status: "PROPOSED",
        timelineVersionAtProposal: headVersion,
      },
    });
  }
  return recs.length;
}

async function ownedRecommendation(userId: string, recId: string) {
  const row = await db.creativeRecommendation.findUnique({ where: { id: recId } });
  if (!row || row.userId !== userId) throw new PermanentJobError("Recommendation not found or not owned by the caller.");
  return row;
}

/**
 * Approve + execute ONE recommendation. `dryRun` validates against the live
 * head WITHOUT writing (the API's preview path).
 */
export async function approveAndExecuteRecommendation(userId: string, recId: string, dryRun = false): Promise<{ status: string; detail: string; version?: number; commands?: string[] }> {
  const rec = await ownedRecommendation(userId, recId);
  if (rec.status === "EXECUTED") return { status: "EXECUTED", detail: "Already executed — use the timeline's own undo to revert." };
  if (rec.status === "REJECTED") return { status: "REJECTED", detail: "Recommendation was rejected; create a fresh review to re-propose." };
  if (rec.status === "STALE") return { status: "STALE", detail: "Recommendation is stale — create a fresh review." };

  const payload = JSON.parse(rec.proposalJson) as ProposalPayload;

  // ── informational: nothing to execute ──
  if (payload.kind === "informational") {
    return { status: rec.status, detail: "Informational recommendation — nothing to execute." };
  }

  // ── stale protection: the timeline must not have moved since proposal ──
  const head = await getTimelineHead(rec.projectId, userId);
  if (head.version !== rec.timelineVersionAtProposal) {
    await db.creativeRecommendation.update({ where: { id: rec.id }, data: { status: "STALE", resultJson: JSON.stringify({ reason: "timeline moved", proposedAtVersion: rec.timelineVersionAtProposal, currentVersion: head.version }) } });
    return { status: "STALE", detail: `Timeline moved since proposal (v${rec.timelineVersionAtProposal} → v${head.version}). Create a fresh review — the proposal is refused, never force-applied.` };
  }

  // ── timeline-commands: M1 validation, then versioned apply ──
  if (payload.kind === "timeline-commands") {
    const commands = payload.commands.map((c) => parseCommand(c));
    const names = commands.map((c) => c.type);
    let seq = head.sequence;
    try {
      for (const command of commands) {
        const validity = validateCommand(seq, command);
        if (!validity.ok) {
          await db.creativeRecommendation.update({ where: { id: rec.id }, data: { status: "FAILED", resultJson: JSON.stringify({ error: validity.error }) } });
          return { status: "FAILED", detail: `Command validation failed: ${validity.error}` };
        }
        // Dry-apply the full chain on the in-memory sequence (locked tracks,
        // range errors and other engine refusals surface here, BEFORE any write).
        seq = applyCommand(seq, command).sequence;
      }
    } catch (err) {
      const message = err instanceof EditorError ? err.message : err instanceof Error ? err.message : "command refused";
      await db.creativeRecommendation.update({ where: { id: rec.id }, data: { status: "FAILED", resultJson: JSON.stringify({ error: message.slice(0, 400) }) } });
      return { status: "FAILED", detail: message };
    }
    if (dryRun) {
      return { status: "PROPOSED", detail: `Validation OK against timeline v${head.version}: ${names.join(" → ")}. Nothing was written.`, commands: names };
    }
    try {
      const result = await applyTimelineEdits(rec.projectId, userId, head.version, commands as unknown[], false);
      await db.creativeRecommendation.update({ where: { id: rec.id }, data: { status: "EXECUTED", executedVersion: result.version, resultJson: JSON.stringify({ version: result.version, warnings: result.warnings, commands: names }) } });
      await db.automationAudit.create({ data: { userId, projectId: rec.projectId, action: "CREATIVE_REC_EXECUTED", detailJson: JSON.stringify({ recId: rec.id, version: result.version, commands: names }) } }).catch(() => undefined);
      return { status: "EXECUTED", detail: `Applied through the M1 engine — timeline is now version ${result.version} (undo/redo and autosave intact).`, version: result.version, commands: names };
    } catch (err) {
      const message = err instanceof VersionConflictError ? "timeline moved during execution — nothing written" : err instanceof EditorError ? err.message : err instanceof Error ? err.message : "execution failed";
      await db.creativeRecommendation.update({ where: { id: rec.id }, data: { status: err instanceof VersionConflictError ? "STALE" : "FAILED", resultJson: JSON.stringify({ error: message.slice(0, 400) }) } });
      return { status: err instanceof VersionConflictError ? "STALE" : "FAILED", detail: message };
    }
  }

  // ── engine-action: dispatch through the EXISTING durable jobs ──
  if (dryRun) return { status: "PROPOSED", detail: `Engine action (${payload.engine}/${payload.action}) validated for dispatch. Nothing was queued in dry-run.`, commands: [] };
  let detail = "";
  const params = payload.params as Record<string, unknown>;
  if (payload.action === "gangzii-loudness") {
    const assetId = String(params.assetId ?? "");
    const asset = await db.mediaAsset.findFirst({ where: { id: assetId, userId } });
    if (!asset) throw new PermanentJobError("GANGZII target asset not found or not owned.");
    const parsed = GangziiParamsSchema.safeParse({ preset: String(params.preset ?? "streaming-loudness"), params: {} });
    if (!parsed.success) throw new PermanentJobError(`GANGZII params invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const row = await db.gangziiProcess.create({ data: { userId, sourceAssetId: asset.id, kind: "PROCESS", status: "QUEUED", name: `Creative Director: ${String(params.preset)}`, paramsJson: JSON.stringify(parsed.data) } });
    const jobId = await jobManager.createJob(userId, JOB_TYPE_GANGZII_PROCESS, { processId: row.id });
    detail = `GANGZII pass queued (process ${row.id}, job ${jobId}).`;
  } else if (payload.action === "jazmii-broll") {
    const parsed = JazmiiGenerateParamsSchema.safeParse({ prompt: String(params.prompt ?? ""), operation: "textToVideo", referenceAssetId: null, quality: "speed", size: String(params.size ?? "1920x1080"), fps: "30", durationSec: String(params.durationSec ?? "5"), withAudio: false, projectId: rec.projectId });
    if (!parsed.success) throw new PermanentJobError(`JAZMII params invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const jobId = await jobManager.createJob(userId, JOB_TYPE_JAZMII_GENERATE, parsed.data);
    detail = `JAZMII generation queued (job ${jobId}, metered provider).`;
  } else if (payload.action === "laxii-broll-image") {
    const parsed = LaxiiGenerateParamsSchema.safeParse({ prompt: String(params.prompt ?? ""), mode: "generate", referenceAssetId: null, size: String(params.size ?? "1920x1080"), count: Math.min(2, Number(params.count ?? 1)), aspect: "original", projectId: rec.projectId });
    if (!parsed.success) throw new PermanentJobError(`LAXII params invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const jobId = await jobManager.createJob(userId, JOB_TYPE_LAXII_GENERATE, parsed.data);
    detail = `LAXII b-roll still generation queued (job ${jobId}) — insert into the timeline via your explicit insert action after inspection.`;
  } else if (payload.action === "laxii-thumbnail-variants") {
    const parsed = LaxiiGenerateParamsSchema.safeParse({ prompt: String(params.prompt ?? "bold thumbnail background matching the video subject, no text"), mode: "generate", referenceAssetId: null, size: String(params.size ?? "1344x768"), count: Math.min(4, Number(params.count ?? 2)), aspect: "original", projectId: rec.projectId });
    if (!parsed.success) throw new PermanentJobError(`LAXII params invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const jobId = await jobManager.createJob(userId, JOB_TYPE_LAXII_GENERATE, parsed.data);
    detail = `LAXII thumbnail alternatives queued (job ${jobId}).`;
  } else if (payload.action === "riishe-autocut-analysis") {
    detail = "Routed to the RIISHE review flow (Auto Cut panel) — that pipeline runs in its own API route and is not re-implemented here.";
  }
  await db.creativeRecommendation.update({ where: { id: rec.id }, data: { status: "EXECUTED", resultJson: JSON.stringify({ dispatched: detail }) } });
  await db.automationAudit.create({ data: { userId, projectId: rec.projectId, action: "CREATIVE_REC_DISPATCHED", detailJson: JSON.stringify({ recId: rec.id, engine: payload.engine, action: payload.action }) } }).catch(() => undefined);
  return { status: "EXECUTED", detail };
}

/** Reject ONE recommendation (explicit, individual). */
export async function rejectRecommendation(userId: string, recId: string, note: string | null): Promise<void> {
  const rec = await ownedRecommendation(userId, recId);
  if (rec.status !== "PROPOSED") throw new PermanentJobError(`Only PROPOSED recommendations can be rejected (current: ${rec.status}).`);
  await db.creativeRecommendation.update({ where: { id: rec.id }, data: { status: "REJECTED", resultJson: JSON.stringify({ rejectedAt: new Date().toISOString(), note: note?.slice(0, 300) ?? null }) } });
}
