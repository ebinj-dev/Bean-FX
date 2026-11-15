/**
 * M14.8 — Real layered compositing foundation + M13 tracking-aware bindings.
 *
 * ONE canonical representation (CompositionDoc) evaluated by ONE deterministic
 * evaluator (`evaluateCompositionAt`). BOTH the browser preview and the export
 * compositor consume this evaluator's per-frame state — preview/export parity
 * is by construction (the export renders the SAME state through PIL; parity is
 * pixel-tested). Layer compositing = source-over alpha; advertised blend modes
 * are limited to normal/multiply/screen (each pixel-tested on both paths).
 * Track bindings follow the M13 gap policy: HOLD at the last MEASURED
 * position, never extrapolate, gaps flagged honestly in the frame state.
 * Edits go through optimistic-concurrency version commits (undo/redo =
 * version switch), reusing the M1 timeline versioning pattern.
 */
import { db } from "@/lib/db";
import { COMPOSITION_LIMITS, CompositionDocSchema, type CompositionDoc, type CompositionFrameState, type Layer, type LayerFrameState } from "./contracts";
import { evalKeyframes } from "./presets";

export interface TrackSample { sourceSec: number; nx: number; ny: number; visibility: string }

/** Resolve an M13 track binding at a composition frame → composition px. */
export function resolveTrackBinding(layer: Layer, frame: number, binding: { samples: TrackSample[]; fps: number; width: number; height: number; sourceOffsetSec: number }): { x: number; y: number; gap: boolean } | null {
  const b = layer.trackBinding;
  if (!b || frame < b.attachedFrameRange.startFrame || frame >= b.attachedFrameRange.endFrame) return null;
  const sec = frame / binding.fps + binding.sourceOffsetSec;
  // Samples are ordered; find bracket. HOLD through gaps (M13 policy).
  let lastVisible: TrackSample | null = null;
  let gap = false;
  for (const s of binding.samples) {
    if (s.sourceSec <= sec) {
      if (s.visibility === "visible") {
        lastVisible = s;
        gap = false;
      } else {
        gap = true; // occluded/lost AFTER a visible sample → hold + flag
      }
    } else break;
  }
  if (!lastVisible) return { x: b.offsetX, y: b.offsetY, gap: true }; // no measurement before frame → honest hold at offset, flagged
  return { x: lastVisible.nx * binding.width + b.offsetX, y: lastVisible.ny * binding.height + b.offsetY, gap };
}

/** THE canonical per-frame evaluation. Deterministic; no side effects. */
export function evaluateCompositionAt(doc: CompositionDoc, frame: number, bindings: { layerId: string; samples: TrackSample[]; sourceOffsetSec: number }[] = []): CompositionFrameState {
  const states: LayerFrameState[] = [];
  for (const layer of doc.layers) {
    const active = frame >= layer.startFrame && frame < layer.endFrame;
    if (!active || !layer.visible) continue;
    const kf = (property: "x" | "y" | "scale" | "rotation" | "opacity", fallback: number) => evalKeyframes(layer.keyframes, property, frame, fallback);
    const bindingSpec = bindings.find((b) => b.layerId === layer.id);
    let trackX: number | null = null;
    let trackY: number | null = null;
    let trackGap = false;
    if (layer.trackBinding && bindingSpec) {
      const resolved = resolveTrackBinding(layer, frame, { samples: bindingSpec.samples, fps: doc.fps, width: doc.width, height: doc.height, sourceOffsetSec: bindingSpec.sourceOffsetSec });
      if (resolved) {
        trackX = resolved.x;
        trackY = resolved.y;
        trackGap = resolved.gap;
      }
    }
    const xBase = trackX ?? layer.transform.x;
    const yBase = trackY ?? layer.transform.y;
    states.push({
      layerId: layer.id,
      kind: layer.kind,
      visible: true,
      opacity: Math.max(0, Math.min(1, kf("opacity", layer.transform.opacity))),
      x: kf("x", xBase),
      y: kf("y", yBase),
      scale: kf("scale", layer.transform.scale),
      rotation: kf("rotation", layer.transform.rotation),
      blend: layer.blend,
      trackX,
      trackY,
      trackGap,
      color: layer.color,
      text: layer.text,
      fontSize: layer.fontSize,
      sourceAssetId: layer.sourceAssetId,
    });
  }
  return { frame: Math.max(0, Math.floor(frame)), width: doc.width, height: doc.height, fps: doc.fps, layers: states };
}

/** Deterministic validation — the M14 quality gate (bounds, limits, NaNs). */
export function validateComposition(input: unknown): { doc: CompositionDoc; issues: string[] } {
  const parsed = CompositionDocSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Composition invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const doc = parsed.data;
  const issues: string[] = [];
  if (doc.layers.length > COMPOSITION_LIMITS.maxLayers) issues.push(`${doc.layers.length} layers exceeds the ${COMPOSITION_LIMITS.maxLayers}-layer limit.`);
  if (doc.width > COMPOSITION_LIMITS.maxDimension || doc.height > COMPOSITION_LIMITS.maxDimension) issues.push("Canvas exceeds the 1920px limit.");
  if (doc.durationFrames > COMPOSITION_LIMITS.maxDurationFrames) issues.push("Duration exceeds 3600 frames.");
  const ids = new Set<string>();
  for (const layer of doc.layers) {
    if (ids.has(layer.id)) issues.push(`Duplicate layer id ${layer.id}.`);
    ids.add(layer.id);
    if (!Number.isFinite(layer.transform.x) || !Number.isFinite(layer.transform.y) || !Number.isFinite(layer.transform.scale) || !Number.isFinite(layer.transform.rotation)) issues.push(`Layer ${layer.id} has non-finite transform values.`);
    if (layer.endFrame <= layer.startFrame) issues.push(`Layer ${layer.id} has empty frame range.`);
    if (layer.mask) {
      if (!ids.has(layer.mask.sourceLayerId) && layer.mask.sourceLayerId !== layer.id) issues.push(`Layer ${layer.id} masks from unknown layer ${layer.mask.sourceLayerId}.`);
    }
    for (const k of layer.keyframes) {
      if (!Number.isFinite(k.value) || !Number.isFinite(k.frame)) issues.push(`Layer ${layer.id} keyframe has non-finite values.`);
    }
    if (layer.trackBinding && !layer.trackBinding.temporalTrackId) issues.push(`Layer ${layer.id} has an empty track binding.`);
  }
  const motionRatios = doc.layers.filter((l) => l.kind !== "background" && l.keyframes.length === 0 && !l.trackBinding).length;
  if (motionRatios === doc.layers.filter((l) => l.kind !== "background").length && doc.layers.length > 1) {
    issues.push("Anti-PowerPoint gate: NO layer has motion and no track binding is attached — add motion presets or accept the static composition explicitly.");
  }
  return { doc, issues };
}

// ── persistence with optimistic concurrency + version history ──────────────
export async function createComposition(userId: string, projectId: string, name: string, docInput: unknown): Promise<{ id: string; version: number; issues: string[] }> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== userId) throw new Error("Project not found or not owned by the caller.");
  const { doc, issues } = validateComposition(docInput);
  const created = await db.composition.create({ data: { userId, projectId, name: name.slice(0, 80), width: doc.width, height: doc.height, fps: doc.fps, docJson: JSON.stringify(doc), version: 1, status: "DRAFT" } });
  await db.compositionVersion.create({ data: { compositionId: created.id, version: 1, docJson: JSON.stringify(doc), note: "created" } });
  return { id: created.id, version: 1, issues };
}

/** Commit a new version with optimistic concurrency (expectedVersion). */
export async function commitComposition(userId: string, projectId: string, compositionId: string, expectedVersion: number, docInput: unknown, note: string): Promise<{ version: number; issues: string[] }> {
  const row = await db.composition.findUnique({ where: { id: compositionId } });
  if (!row || row.userId !== userId || row.projectId !== projectId) throw new Error("Composition not found or not owned by the caller.");
  if (row.version !== expectedVersion) throw new Error(`Concurrent edit: stored version ${row.version}, expected ${expectedVersion} — reload and re-apply.`);
  const { doc, issues } = validateComposition(docInput);
  const nextVersion = row.version + 1;
  await db.$transaction([
    db.composition.update({ where: { id: compositionId }, data: { docJson: JSON.stringify(doc), version: nextVersion, width: doc.width, height: doc.height, fps: doc.fps, status: "DRAFT" } }),
    db.compositionVersion.create({ data: { compositionId, version: nextVersion, docJson: JSON.stringify(doc), note: note.slice(0, 200) } }),
  ]);
  return { version: nextVersion, issues };
}

/** Undo/redo = switch to an existing version (history rows are immutable). */
export async function switchCompositionVersion(userId: string, projectId: string, compositionId: string, targetVersion: number): Promise<{ version: number; doc: CompositionDoc }> {
  const row = await db.composition.findUnique({ where: { id: compositionId } });
  if (!row || row.userId !== userId || row.projectId !== projectId) throw new Error("Composition not found or not owned by the caller.");
  const target = await db.compositionVersion.findUnique({ where: { compositionId_version: { compositionId, version: targetVersion } } });
  if (!target) throw new Error(`Version ${targetVersion} does not exist.`);
  await db.composition.update({ where: { id: compositionId }, data: { docJson: target.docJson, version: row.version + 1, width: target.docJson ? JSON.parse(target.docJson).width : row.width, height: target.docJson ? JSON.parse(target.docJson).height : row.height, fps: target.docJson ? JSON.parse(target.docJson).fps : row.fps, status: "DRAFT" } });
  const head = await db.composition.findUnique({ where: { id: compositionId } });
  await db.compositionVersion.create({ data: { compositionId, version: row.version + 1, docJson: target.docJson, note: `switched to v${targetVersion} (undo/redo)` } });
  return { version: head!.version, doc: JSON.parse(target.docJson) as CompositionDoc };
}

export async function getComposition(userId: string, projectId: string, compositionId: string): Promise<{ id: string; name: string; version: number; doc: CompositionDoc; versions: { version: number; note: string | null; createdAt: Date }[] }> {
  const row = await db.composition.findUnique({ where: { id: compositionId } });
  if (!row || row.userId !== userId || row.projectId !== projectId) throw new Error("Composition not found or not owned by the caller.");
  const versions = await db.compositionVersion.findMany({ where: { compositionId }, orderBy: { version: "desc" }, take: 30 });
  return { id: row.id, name: row.name, version: row.version, doc: JSON.parse(row.docJson) as CompositionDoc, versions: versions.map((v) => ({ version: v.version, note: v.note, createdAt: v.createdAt })) };
}

export async function listCompositions(userId: string, projectId: string): Promise<{ id: string; name: string; version: number; status: string; width: number; height: number; fps: number }[]> {
  const rows = await db.composition.findMany({ where: { userId, projectId }, orderBy: { updatedAt: "desc" }, take: 20 });
  return rows.map((r) => ({ id: r.id, name: r.name, version: r.version, status: r.status, width: r.width, height: r.height, fps: r.fps }));
}

// ── M13 tracking-aware attachment (§9) ──────────────────────────────────────
/** Read the M13 temporal index and produce REAL samples for a track. */
export async function loadTrackSamples(userId: string, projectId: string, temporalTrackId: string, sourceAssetId: string): Promise<{ samples: TrackSample[]; warnings: string[] }> {
  const artifact = await db.creativeAnalysisArtifact.findFirst({ where: { userId, projectId, kind: "temporal-index", status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
  if (!artifact?.resultJson) throw new Error("No completed M13 temporal index — run Motion Analysis first; tracking bindings require REAL tracked samples.");
  const index = JSON.parse(artifact.resultJson) as { assetId: string; tracks: { trackId: string; samples: { sourceSec: number; nx: number; ny: number; visibility: string }[] }[] };
  const track = index.tracks.find((t) => t.trackId === temporalTrackId);
  if (!track) throw new Error(`Track ${temporalTrackId} not found in the M13 temporal index.`);
  if (index.assetId !== sourceAssetId) throw new Error(`Track ${temporalTrackId} belongs to asset ${index.assetId}, not ${sourceAssetId}.`);
  const warnings: string[] = [];
  const occluded = track.samples.filter((s) => s.visibility !== "visible").length;
  if (occluded > 0) warnings.push(`${occluded} sample(s) are occluded/lost — the binding HOLDS the last measured position through those intervals (M13 policy, no extrapolation).`);
  return { samples: track.samples, warnings };
}

/** Attach a layer to a validated M13 track (undoable via version commit). */
export async function attachLayerToTrack(userId: string, projectId: string, compositionId: string, expectedVersion: number, layerId: string, temporalTrackId: string, sourceAssetId: string, attachedFrameRange: { startFrame: number; endFrame: number }, offset: { x?: number; y?: number } = {}): Promise<{ version: number; warnings: string[] }> {
  const { samples, warnings } = await loadTrackSamples(userId, projectId, temporalTrackId, sourceAssetId);
  const row = await db.composition.findUnique({ where: { id: compositionId } });
  if (!row || row.userId !== userId || row.projectId !== projectId) throw new Error("Composition not found or not owned by the caller.");
  const doc = JSON.parse(row.docJson) as CompositionDoc;
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer) throw new Error(`Layer ${layerId} not found.`);
  if (samples.length < 2) throw new Error("Track has fewer than 2 valid samples — cannot attach honestly.");
  layer.trackBinding = {
    temporalTrackId,
    sourceAssetId,
    gapPolicy: "hold",
    offsetX: offset.x ?? 0,
    offsetY: offset.y ?? 0,
    attachedFrameRange,
  };
  const committed = await commitComposition(userId, projectId, compositionId, expectedVersion, doc, `attach ${layerId} → M13 ${temporalTrackId}`);
  return { version: committed.version, warnings: [...warnings, "Attachment is a composition VERSION — undo restores the previous binding state."].slice(0, 4) };
}

export async function detachLayerFromTrack(userId: string, projectId: string, compositionId: string, expectedVersion: number, layerId: string): Promise<{ version: number }> {
  const row = await db.composition.findUnique({ where: { id: compositionId } });
  if (!row || row.userId !== userId || row.projectId !== projectId) throw new Error("Composition not found or not owned by the caller.");
  const doc = JSON.parse(row.docJson) as CompositionDoc;
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer) throw new Error(`Layer ${layerId} not found.`);
  layer.trackBinding = null;
  const committed = await commitComposition(userId, projectId, compositionId, expectedVersion, doc, `detach ${layerId} from track`);
  return { version: committed.version };
}
