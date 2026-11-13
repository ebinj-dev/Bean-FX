/**
 * Social Video Studio — narration (M8.1 §5).
 *
 * Real TTS through the environment's configured z-ai CLI (`z-ai tts`,
 * verified live: WAV 24 kHz, voice "tongtong"). The generated WAV is
 * registered as a REAL MediaAsset through the same path engine jobs use
 * (ffprobe + provenance), so RIISHE transcription, GANGZII processing and
 * the render pipeline all see a normal asset. The original narration TEXT
 * stays on the scene; the transcript produced by RIISHE is stored as the
 * editable caption source (§5: retain original + editable transcript).
 * Honest limits: this provider speaks Chinese/English voices; Tamil support
 * is marked unavailable rather than faked (see voiceSupport()).
 */
import { execFile } from "child_process";
import { mkdir, stat } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { MEDIA_ROOT, pathInsideMediaRoot, ffprobe } from "@/lib/media-storage";
import type { StudioLanguageId } from "./brief";

const TTS_DIR = pathInsideMediaRoot("media-store", "studio-narration");

export interface NarrationResult {
  sceneId: string;
  assetId: string;
  durationSec: number;
  voice: string;
  language: StudioLanguageId;
  note: string;
}

/** Voices verified against the live provider (2026-11 probe). */
const VERIFIED_VOICES: Record<string, boolean> = { tongtong: true };
const LANGUAGE_SUPPORT: Record<StudioLanguageId, string> = {
  en: "supported (English-capable voice)",
  ta: "NOT verified for Tamil on the current provider — generate the narration in English or supply your own Tamil voice recording (upload). We do not fake Tamil speech.",
};

export function voiceSupport(language: StudioLanguageId, voice: string): { ok: boolean; note: string } {
  if (language === "ta") return { ok: false, note: LANGUAGE_SUPPORT.ta };
  if (!VERIFIED_VOICES[voice]) return { ok: false, note: `Voice "${voice}" is not in the verified list (${Object.keys(VERIFIED_VOICES).join(", ")}); use tongtong.` };
  return { ok: true, note: LANGUAGE_SUPPORT.en };
}

/**
 * Generate narration audio for one scene and register it as a MediaAsset.
 * Deterministic, provider-backed; failures are typed honestly.
 */
export async function generateSceneNarration(userId: string, planId: string, sceneId: string, voice = "tongtong", speed = 1.0): Promise<NarrationResult> {
  const scene = await db.studioScene.findFirst({ where: { id: sceneId, userId, planId } });
  if (!scene) throw new Error("Scene not found or not owned.");
  const plan = await db.studioPlan.findFirst({ where: { id: planId, userId } });
  if (!plan) throw new Error("Plan not found or not owned.");
  const brief = JSON.parse(plan.briefJson) as { language: StudioLanguageId };
  const text = scene.narration.trim();
  if (!text) throw new Error("Scene narration is empty — write narration first.");
  const support = voiceSupport(brief.language, voice);
  if (!support.ok) throw new Error(`Narration unavailable: ${support.note}`);

  await mkdir(TTS_DIR, { recursive: true });
  const outPath = path.join(TTS_DIR, `nar_${sceneId}_${Date.now().toString(36)}.wav`);
  const args = ["tts", "-i", text.slice(0, 4000), "-o", outPath, "-v", voice, "-s", String(speed)];
  await new Promise<void>((resolve, reject) => {
    execFile("z-ai", args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`TTS provider failed: ${String(stderr || err.message).slice(0, 200)}`));
      resolve();
    });
  });
  const info = await stat(outPath);
  if (info.size < 1000) throw new Error("TTS provider returned an empty audio file.");
  const probe = await ffprobe(outPath);
  const durationSec = probe.durationSec ?? 0;
  if (durationSec <= 0.2) throw new Error("TTS audio has no measurable duration.");

  const asset = await db.mediaAsset.create({
    data: {
      userId,
      originalName: `narration-scene-${scene.sceneNumber}.wav`,
      storagePath: outPath,
      kind: "AUDIO",
      mimeType: "audio/wav",
      sizeBytes: info.size,
      durationSec: Number(durationSec.toFixed(3)),
      sampleRate: probe.sampleRate ?? 24000,
      audioCodec: probe.audioCodec ?? "pcm_s16le",
      probeStatus: "READY",
      createdBy: "STUDIO_TTS",
      provider: "zai-tts",
      model: voice,
      prompt: text.slice(0, 2000),
      license: "generated — provider terms apply",
    },
  });
  // Scene-level duration follows the REAL audio (assembly uses integer frames).
  await db.studioScene.update({
    where: { id: sceneId },
    data: { narrationAssetId: asset.id, durationSec: Math.max(scene.durationSec, Math.ceil(durationSec)), status: scene.assetId ? "READY" : "NARRATION_READY" },
  });
  void MEDIA_ROOT;
  return { sceneId, assetId: asset.id, durationSec: Number(durationSec.toFixed(2)), voice, language: brief.language, note: `Narration generated (${durationSec.toFixed(1)}s); RIISHE can now transcribe it for caption timing.` };
}

/** Remove the narration asset reference (user may re-record/regenerate). */
export async function clearSceneNarration(userId: string, sceneId: string): Promise<boolean> {
  const scene = await db.studioScene.findFirst({ where: { id: sceneId, userId } });
  if (!scene?.narrationAssetId) return false;
  await db.studioScene.update({ where: { id: sceneId }, data: { narrationAssetId: null, status: scene.assetId ? "ASSET_READY" : "EMPTY" } });
  return true;
}
