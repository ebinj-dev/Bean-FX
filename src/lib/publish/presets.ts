/**
 * M9 — Creator brand presets (§5).
 *
 * Presets are reusable, user-owned styling profiles. Application to a project
 * is ADDITIVE-MERGE ONLY: the preset writes the keys it owns into the
 * project's settingsJson and NEVER destroys unrelated existing styling. The
 * API returns a preview (proposed merged settings) BEFORE anything is applied
 * and requires an explicit confirm flag — previously approved project content
 * is never silently modified. Every apply/revert is recorded in the
 * AutomationAudit trail (§10 audit history).
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { PermanentJobError } from "@/lib/job-helpers";
import { getExportProfile } from "./profiles";

export const BrandPresetSchema = z
  .object({
    name: z.string().min(1).max(80),
    brandName: z.string().max(80).default(""),
    logoAssetId: z.string().max(64).nullable().default(null),
    watermarkAssetId: z.string().max(64).nullable().default(null),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#d4a017"),
    secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#111111"),
    fontFamily: z.enum(["inter", "nikki-sans", "nikki-tamil"]).default("inter"),
    captionStyle: z
      .object({
        fontSize: z.number().min(10).max(120).default(42),
        textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ffffff"),
        outlineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#000000"),
        position: z.enum(["top", "center", "bottom"]).default("bottom"),
      })
      .strict()
      .nullable()
      .default(null),
    introAssetId: z.string().max(64).nullable().default(null),
    outroAssetId: z.string().max(64).nullable().default(null),
    thumbnailStyle: z
      .object({
        position: z.enum(["top", "center", "bottom"]).default("bottom"),
        align: z.enum(["left", "center", "right"]).default("left"),
        backdrop: z.enum(["none", "band", "box"]).default("band"),
        accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#d4a017"),
      })
      .strict()
      .nullable()
      .default(null),
    defaultExportProfile: z.string().max(40).nullable().default(null),
  })
  .strict();
export type BrandPresetData = z.infer<typeof BrandPresetSchema>;

export async function assertOwnedPreset(userId: string, presetId: string) {
  const preset = await db.brandPreset.findUnique({ where: { id: presetId } });
  if (!preset || preset.userId !== userId) throw new PermanentJobError("Brand preset not found or not owned by the caller.");
  return preset;
}

async function assertOwnedAsset(userId: string, assetId: string | null | undefined) {
  if (!assetId) return;
  const asset = await db.mediaAsset.findUnique({ where: { id: assetId } });
  if (!asset || asset.userId !== userId) throw new PermanentJobError(`Referenced asset ${assetId} not found or not owned by the caller.`);
}

/** Validate + ownership-check a preset payload (asset references must be owned). */
export async function validatePresetData(userId: string, data: BrandPresetData): Promise<void> {
  if (data.defaultExportProfile && !getExportProfile(data.defaultExportProfile)) {
    throw new PermanentJobError(`Unknown export profile "${data.defaultExportProfile}".`);
  }
  await assertOwnedAsset(userId, data.logoAssetId);
  await assertOwnedAsset(userId, data.watermarkAssetId);
  await assertOwnedAsset(userId, data.introAssetId);
  await assertOwnedAsset(userId, data.outroAssetId);
}

/**
 * The keys a preset OWNS inside project.settingsJson. Applying merges ONLY
 * these keys — everything else already in the project settings survives
 * untouched (additive, non-destructive).
 */
const PRESET_OWNED_KEYS = [
  "brand",
  "captionStyle",
  "thumbnailStyle",
  "defaultExportProfile",
  "watermarkAssetId",
] as const;

function presetSettingsPayload(preset: BrandPresetData): Record<string, unknown> {
  return {
    brand: {
      name: preset.brandName || preset.name,
      primaryColor: preset.primaryColor,
      secondaryColor: preset.secondaryColor,
      fontFamily: preset.fontFamily,
      logoAssetId: preset.logoAssetId,
      introAssetId: preset.introAssetId,
      outroAssetId: preset.outroAssetId,
    },
    captionStyle: preset.captionStyle,
    thumbnailStyle: preset.thumbnailStyle,
    defaultExportProfile: preset.defaultExportProfile,
    watermarkAssetId: preset.watermarkAssetId,
  };
}

export interface ApplyPreview {
  projectId: string;
  presetId: string;
  presetName: string;
  currentSettings: Record<string, unknown>;
  mergedSettings: Record<string, unknown>;
  /** Keys the preset will write (the only ones it touches). */
  keysWritten: string[];
  keysPreserved: string[];
}

function parseSettings(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Rebuild the typed preset payload from a DB row (JSON columns → objects). */
function rowToPresetData(row: {
  name: string; brandName: string; logoAssetId: string | null; watermarkAssetId: string | null; primaryColor: string; secondaryColor: string; fontFamily: string; captionStyleJson: string | null; introAssetId: string | null; outroAssetId: string | null; thumbnailStyleJson: string | null; defaultExportProfile: string | null;
}): BrandPresetData {
  return {
    name: row.name,
    brandName: row.brandName,
    logoAssetId: row.logoAssetId,
    watermarkAssetId: row.watermarkAssetId,
    primaryColor: row.primaryColor,
    secondaryColor: row.secondaryColor,
    fontFamily: row.fontFamily as BrandPresetData["fontFamily"],
    captionStyle: row.captionStyleJson ? (JSON.parse(row.captionStyleJson) as BrandPresetData["captionStyle"]) : null,
    introAssetId: row.introAssetId,
    outroAssetId: row.outroAssetId,
    thumbnailStyle: row.thumbnailStyleJson ? (JSON.parse(row.thumbnailStyleJson) as BrandPresetData["thumbnailStyle"]) : null,
    defaultExportProfile: row.defaultExportProfile,
  };
}

/** Preview the additive merge — no writes (§5 "preview before applying"). */
export async function previewPresetApply(userId: string, presetId: string, projectId: string): Promise<ApplyPreview> {
  const row = await assertOwnedPreset(userId, presetId);
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== userId) throw new PermanentJobError("Project not found or not owned by the caller.");
  const preset = rowToPresetData(row);
  await validatePresetData(userId, preset);

  const currentSettings = parseSettings(project.settingsJson);
  const payload = presetSettingsPayload(preset);
  const merged = { ...currentSettings };
  for (const key of PRESET_OWNED_KEYS) {
    if (payload[key] !== null && payload[key] !== undefined) merged[key] = payload[key];
  }
  const keysPreserved = Object.keys(currentSettings).filter((k) => !(PRESET_OWNED_KEYS as readonly string[]).includes(k));
  return {
    projectId,
    presetId,
    presetName: preset.name,
    currentSettings,
    mergedSettings: merged,
    keysWritten: PRESET_OWNED_KEYS.filter((k) => payload[k] !== null && payload[k] !== undefined),
    keysPreserved,
  };
}

/**
 * Apply a preset (requires confirm:{"confirm":"apply"} style gate from the
 * caller — the route enforces it). Non-destructive: previously approved
 * project content is preserved; the audit trail records the previous
 * settings so the apply is revertable where the architecture permits.
 */
export async function applyPreset(userId: string, presetId: string, projectId: string): Promise<ApplyPreview & { revertedFromJson: string }> {
  const preview = await previewPresetApply(userId, presetId, projectId);
  const before = JSON.stringify(preview.currentSettings);
  await db.project.update({
    where: { id: projectId },
    data: { settingsJson: JSON.stringify(preview.mergedSettings) },
  });
  await db.automationAudit
    .create({
      data: {
        userId,
        projectId,
        action: "publish.brand-preset.apply",
        detailJson: JSON.stringify({ presetId, presetName: preview.presetName, keysWritten: preview.keysWritten, previousSettingsJson: before }),
      },
    })
    .catch(() => undefined);
  return { ...preview, revertedFromJson: before };
}

/** Revert to the settings snapshot recorded by the last apply (audit-backed). */
export async function revertLastPresetApply(userId: string, projectId: string): Promise<{ reverted: boolean }> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== userId) throw new PermanentJobError("Project not found or not owned by the caller.");
  const audit = await db.automationAudit.findFirst({
    where: { userId, projectId, action: "publish.brand-preset.apply" },
    orderBy: { createdAt: "desc" },
  });
  if (!audit?.detailJson) return { reverted: false };
  const detail = JSON.parse(audit.detailJson) as { previousSettingsJson?: string };
  if (typeof detail.previousSettingsJson !== "string") return { reverted: false };
  await db.project.update({ where: { id: projectId }, data: { settingsJson: detail.previousSettingsJson } });
  await db.automationAudit
    .create({ data: { userId, projectId, action: "publish.brand-preset.revert", detailJson: JSON.stringify({ undoneAuditId: audit.id }) } })
    .catch(() => undefined);
  return { reverted: true };
}
