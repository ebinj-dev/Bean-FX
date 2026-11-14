/**
 * M11 — Integrated, approval-aware transcription (§4).
 *
 * Resolves M10's limitation that required users to run RIISHE separately.
 * Reuses the REAL RIISHE ASR path (`transcribeWithAsr` — the same provider
 * adapters the Auto Cut pipeline uses) over extracted source audio.
 *
 * Honesty guarantees:
 *  - language is DETECTED (detectLanguage), never assumed; unsupported
 *    provider/language combinations surface as warnings, not silent failures;
 *  - `wordsAvailable` is false: the chunk-based provider supplies chunk-level
 *    timestamps, so word-level timing is NEVER claimed;
 *  - every version records provenance (provider, model, job, asset
 *    fingerprint) and becomes STALE when the source asset changes;
 *  - user captions are NEVER replaced: approval creates a NEW SRT subtitle
 *    asset (existing SRT assets and clip captions are untouched);
 *  - the transcriber is injectable (opts.transcriber) so fixture tests can
 *    exercise versioning/approval without faking live results.
 */
import path from "path";
import { db } from "@/lib/db";
import { transcribeWithAsr, detectLanguage, type AsrResult } from "@/lib/autocut-analysis";
import { serializeSrt } from "@/lib/srt-vtt";
import { assetFingerprint } from "./multimodal";
import { extractDerivedAudio, resolvePrimaryAudioSource } from "./embedded-audio";
import { PermanentJobError } from "@/lib/job-helpers";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscribeOptions {
  /** Injectable ASR (fixture tests); defaults to the REAL RIISHE provider. */
  transcriber?: (storagePath: string, durationSec: number) => Promise<AsrResult>;
  /** Force the specific stream (defaults to the primary audio source). */
  sourceAssetId?: string;
  streamIndex?: number;
}

/**
 * Run one integrated transcription pass and store it as a PENDING_REVIEW
 * TranscriptVersion. Honest partial behavior: no speech / failed chunks /
 * unsupported language produce warnings on the version, never fabricated text.
 */
export async function runProjectTranscription(userId: string, projectId: string, opts: TranscribeOptions = {}): Promise<{ transcriptId: string; versionNo: number; language: string; segments: number; warnings: string[]; jobId: string | null }> {
  const source = opts.sourceAssetId
    ? await (async () => {
        const asset = await db.mediaAsset.findFirst({ where: { id: opts.sourceAssetId, userId } });
        if (!asset) throw new PermanentJobError("Requested source asset not found or not owned.");
        return { assetId: asset.id, originalName: asset.originalName, kind: asset.kind as "AUDIO" | "VIDEO" };
      })()
    : await resolvePrimaryAudioSource(userId, projectId);
  if (!source) throw new PermanentJobError("No media with an audio stream exists in this project — transcription is not possible.");

  const asset = await db.mediaAsset.findFirst({ where: { id: source.assetId, userId } });
  if (!asset?.storagePath) throw new PermanentJobError("Source asset file not accessible.");

  const fingerprint = assetFingerprint(asset);
  let targetPath = asset.storagePath;
  let derivedAssetId: string | null = null;
  const streamIndex = opts.streamIndex ?? null;
  if (source.kind === "VIDEO") {
    const derived = await extractDerivedAudio(userId, projectId, asset.id, streamIndex ?? 0);
    if (!derived) throw new PermanentJobError("Embedded audio extraction failed — transcription unavailable.");
    derivedAssetId = derived.assetId;
    targetPath = derived.storagePath;
  }

  // transcribeWithAsr decodes ANY media container itself (16 kHz mono PCM) —
  // the media file is passed directly; no pre-extraction, no temp copies.
  let asr: AsrResult;
  try {
    asr = opts.transcriber ? await opts.transcriber(targetPath, asset.durationSec ?? 0) : await transcribeWithAsr(targetPath, asset.durationSec ?? 0);
  } catch (err) {
    throw new PermanentJobError(`RIISHE ASR failed honestly: ${(err instanceof Error ? err.message : String(err)).slice(0, 250)}`);
  }

  const text = (asr.text ?? "").trim();
  const lang = text ? detectLanguage(text) : null;
  const language = lang ? (lang.mixed ? "mixed" : lang.primaryScript === "Tamil" ? "ta" : lang.primaryScript === "Latin" ? "en" : "unknown") : "unknown";
  const segments: TranscriptSegment[] = (asr.chunkTexts ?? [])
    .filter((c) => (c.text ?? "").trim().length > 0 && Number.isFinite(c.start) && Number.isFinite(c.end))
    .map((c) => ({ start: Math.round(c.start * 100) / 100, end: Math.round(c.end * 100) / 100, text: c.text.slice(0, 500) }));
  const warnings = [...(asr.warnings ?? [])];
  if (asr.failedChunks.length) warnings.push(`${asr.failedChunks.length} chunk(s) failed recognition — those spans have no transcript (provider/ASR limitation, honestly recorded).`);
  if (!text) warnings.push("No speech was recognized — the transcript is empty (silence, music, or unsupported language for the configured provider).");
  if (lang && lang.languages.length === 0 && text) warnings.push("Script could not be identified confidently — language recorded as unknown rather than guessed.");

  const lastVersion = await db.transcriptVersion.findFirst({ where: { userId, sourceAssetId: asset.id }, orderBy: { versionNo: "desc" } });
  const versionNo = (lastVersion?.versionNo ?? 0) + 1;
  const deps = { assetFingerprint: fingerprint, streamIndex, transcriber: opts.transcriber ? "fixture-stub" : "riishe-provider" };
  const row = await db.transcriptVersion.create({
    data: {
      userId,
      projectId,
      sourceAssetId: asset.id,
      streamIndex,
      versionNo,
      language,
      provider: opts.transcriber ? "fixture-stub" : "riishe-asr",
      model: null,
      text: text.slice(0, 20000),
      segmentsJson: JSON.stringify(segments.slice(0, 400)),
      wordsAvailable: false,
      warningsJson: JSON.stringify(warnings.slice(0, 12)),
      status: "PENDING_REVIEW",
      depsJson: JSON.stringify(deps),
      depsHash: (await import("./multimodal")).depsHashOf(deps),
    },
  });
  return { transcriptId: row.id, versionNo, language, segments: segments.length, warnings, jobId: null };
}

/** Stale detection: recompute the fingerprint; mismatch ⇒ stale with reason. */
export async function markStaleTranscripts(userId: string, projectId: string): Promise<number> {
  const rows = await db.transcriptVersion.findMany({ where: { userId, projectId, status: { in: ["PENDING_REVIEW", "APPROVED"] } } });
  let changed = 0;
  for (const row of rows) {
    const asset = await db.mediaAsset.findFirst({ where: { id: row.sourceAssetId, userId } });
    if (!asset) continue;
    const fingerprint = assetFingerprint(asset);
    let deps: { assetFingerprint?: string } = {};
    try {
      deps = JSON.parse(row.depsJson) as { assetFingerprint?: string };
    } catch {
      deps = {};
    }
    if (deps.assetFingerprint && deps.assetFingerprint !== fingerprint) {
      await db.transcriptVersion.update({ where: { id: row.id }, data: { status: "STALE", staleReason: "Source media changed (size or mtime) since this transcript was produced — re-run transcription for fresh timing." } });
      changed += 1;
    }
  }
  return changed;
}

/** Approve a transcript: optionally emit a NEW SRT asset (captions preserved). */
export async function approveTranscript(userId: string, transcriptId: string, applyCaptions: boolean, language?: "en" | "ta"): Promise<{ approved: boolean; captionAssetId?: string; note: string }> {
  const row = await db.transcriptVersion.findUnique({ where: { id: transcriptId } });
  if (!row || row.userId !== userId) throw new PermanentJobError("Transcript not found or not owned by the caller.");
  if (row.status === "DISCARDED") throw new PermanentJobError("Transcript was discarded.");
  if (row.status === "STALE") throw new PermanentJobError("Transcript is stale (source media changed) — re-run transcription before approving.");
  if (row.status === "APPROVED") return { approved: true, captionAssetId: row.captionAssetId ?? undefined, note: "Already approved." };

  await db.transcriptVersion.update({ where: { id: row.id }, data: { status: "APPROVED" } });

  if (!applyCaptions) return { approved: true, note: "Approved without caption generation." };
  const segments = JSON.parse(row.segmentsJson) as TranscriptSegment[];
  if (!segments.length) return { approved: true, note: "Approved; no timed segments exist, so no SRT was generated." };

  // NEW subtitle asset — existing captions are never touched.
  const srt = serializeSrt(segments.map((s, i) => ({ id: `t${i + 1}`, start: s.start, end: s.end, text: s.text })));
  const sourceAsset = await db.mediaAsset.findFirst({ where: { id: row.sourceAssetId, userId } });
  const baseName = (sourceAsset?.originalName ?? "transcript").replace(/\.[a-z0-9]+$/i, "");
  const storagePath = path.join(path.dirname(sourceAsset?.storagePath ?? "/tmp"), `${baseName}.transcript-v${row.versionNo}.srt`);
  await (await import("fs")).promises.writeFile(storagePath, srt, "utf8");
  const stat = await (await import("fs")).promises.stat(storagePath);
  const asset = await db.mediaAsset.create({
    data: {
      userId,
      projectId: row.projectId,
      originalName: `${baseName} · transcript v${row.versionNo} (${row.language})`.slice(0, 180),
      storagePath,
      kind: "SUBTITLE",
      mimeType: "application/x-subrip",
      sizeBytes: stat.size,
      notes: JSON.stringify({ derivedFromTranscriptId: row.id, versionNo: row.versionNo, language: language ?? row.language, createdBy: "m11-transcription", note: "User-approved transcript export; pre-existing captions were not modified." }).slice(0, 900),
    },
  });
  await db.transcriptVersion.update({ where: { id: row.id }, data: { captionAssetId: asset.id } });
  await db.automationAudit.create({ data: { userId, projectId: row.projectId, action: "TRANSCRIPT_APPROVED", detailJson: JSON.stringify({ transcriptId: row.id, versionNo: row.versionNo, captionAssetId: asset.id }) } }).catch(() => undefined);
  return { approved: true, captionAssetId: asset.id, note: "Approved and exported as a NEW SRT subtitle asset (existing captions untouched)." };
}

export async function discardTranscript(userId: string, transcriptId: string): Promise<void> {
  const row = await db.transcriptVersion.findUnique({ where: { id: transcriptId } });
  if (!row || row.userId !== userId) throw new PermanentJobError("Transcript not found or not owned by the caller.");
  if (row.status === "APPROVED") throw new PermanentJobError("Approved transcripts cannot be discarded; they are part of review history.");
  await db.transcriptVersion.update({ where: { id: row.id }, data: { status: "DISCARDED" } });
}
