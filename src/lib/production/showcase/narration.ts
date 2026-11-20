/**
 * M31 SHOWCASE STUDIO — Narration (Phase 7, GANGZII seam).
 *
 * Optional narration for showcase scenes through the SAME verified TTS seam as
 * the studio (z-ai tts, voice tongtong — 2026-11 live probe). The generated
 * WAV becomes a REAL audio MediaAsset (provenance preserved) and attaches to
 * the scene's narration ProductionAsset row, so assembly can place it on the
 * timeline like any other asset.
 *
 * Honesty: Tamil is NOT verified on the current provider — the request is
 * refused with an actionable note, never faked. Narration text comes from the
 * storyboard's narrationSegment (user-authored/edited) — the system never
 * reads visible labels aloud on its own.
 */
import { execFile } from "child_process";
import { mkdir, stat } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { ffprobe, pathInsideMediaRoot } from "@/lib/media-storage";
import { voiceSupport } from "@/lib/studio/narration";

const TTS_DIR = pathInsideMediaRoot("media-store", "showcase-narration");
const zaiBin = (): string => process.env.BEANFX_ZAI_BIN ?? "z-ai";

export interface ShowcaseNarrationResult {
  assetRowId: string;
  mediaAssetId: string;
  sceneKey: string;
  durationSec: number;
  voice: string;
  note: string;
}

export async function generateShowcaseNarration(userId: string, productionId: string, sceneKey: string, voice = "tongtong", speed = 1.0): Promise<ShowcaseNarrationResult> {
  const production = await db.production.findUnique({ where: { id: productionId } });
  if (!production || production.userId !== userId) throw new Error("Production not found or not owned by the caller.");
  const brief = production.briefJson ? JSON.parse(production.briefJson) as { language?: "en" | "ta"; narrationPreference?: string } : {};
  if (brief.narrationPreference === "none") throw new Error("Narration is OFF for this production (brief.narrationPreference=none). Enable it in the brief first.");
  if (brief.language === "ta") throw new Error("Narration unavailable: Tamil is NOT verified for the current TTS provider — supply your own Tamil voice recording instead. We do not fake Tamil speech.");

  const sb = production.storyboardJson ? JSON.parse(production.storyboardJson) as { scenes: Array<{ sceneKey: string; narrationSegment: string; sceneNumber: number }> } : null;
  const scene = sb?.scenes.find((s) => s.sceneKey === sceneKey);
  if (!scene) throw new Error("Scene not found in the storyboard.");
  const text = (scene.narrationSegment ?? "").trim();
  if (!text) throw new Error(`Scene ${sceneKey} has no narration text — write narrationSegment first (the system never reads visible labels aloud on its own).`);

  const support = voiceSupport("en", voice);
  if (!support.ok) throw new Error(`Narration unavailable: ${support.note}`);

  // One narration asset row per scene (dedup on retry).
  let row = await db.productionAsset.findFirst({ where: { productionId, sceneKey, category: "narration", status: { not: "REJECTED" } } });
  if (!row) {
    row = await db.productionAsset.create({
      data: {
        productionId, sceneKey, category: "narration",
        description: `Narration for ${sceneKey} (voice ${voice})`,
        sourceType: "GENERATION", provider: "zai-tts", model: voice,
        licenseState: "UNKNOWN", costUnknown: true, status: "PENDING",
        provenanceJson: JSON.stringify({ plannedAt: new Date().toISOString(), kind: "showcase-narration" }),
      },
    });
  }
  if (row.mediaAssetId && row.status === "READY") {
    return { assetRowId: row.id, mediaAssetId: row.mediaAssetId, sceneKey, durationSec: 0, voice, note: "Narration already generated for this scene — no duplicate provider call." };
  }

  await mkdir(TTS_DIR, { recursive: true });
  const outPath = path.join(TTS_DIR, `show-nar_${productionId.slice(-6)}_${sceneKey}_${Date.now().toString(36)}.wav`);
  await new Promise<void>((resolve, reject) => {
    execFile(zaiBin(), ["tts", "-i", text.slice(0, 4000), "-o", outPath, "-v", voice, "-s", String(speed)], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
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
      originalName: `showcase-narration-${sceneKey}.wav`,
      storagePath: outPath,
      kind: "AUDIO",
      mimeType: "audio/wav",
      sizeBytes: info.size,
      durationSec: Number(durationSec.toFixed(3)),
      sampleRate: probe.sampleRate ?? 24000,
      audioCodec: probe.audioCodec ?? "pcm_s16le",
      probeStatus: "READY",
      createdBy: "SHOWCASE_TTS",
      provider: "zai-tts",
      model: voice,
      prompt: text.slice(0, 2000),
      license: "generated — provider terms apply",
      projectId: production.projectId ?? null,
    },
  });
  await db.productionAsset.update({
    where: { id: row.id },
    // licenseState stays UNKNOWN: provider-generated audio is subject to the
    // provider's own terms, which are NOT independently verified here.
    data: { status: "READY", mediaAssetId: asset.id, costUnknown: false, costCents: 0, provenanceJson: JSON.stringify({ generatedAt: new Date().toISOString(), voice, durationSec: Number(durationSec.toFixed(2)), license: "generated — provider terms apply", text: text.slice(0, 300) }) },
  });
  await db.productionEvent.create({ data: { productionId, kind: "narration.generated", stageKey: "ASSET_GENERATION", detailJson: JSON.stringify({ sceneKey, durationSec: Number(durationSec.toFixed(2)), voice }) } });
  return { assetRowId: row.id, mediaAssetId: asset.id, sceneKey, durationSec: Number(durationSec.toFixed(2)), voice, note: support.note };
}
