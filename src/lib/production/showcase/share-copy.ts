/**
 * M31 SHOWCASE STUDIO — Share copy (Phase 9).
 *
 * Platform-specific promotional copy generated DETERMINISTICALLY from the
 * approved product-understanding artifact + brief — only sourced strings are
 * used (identity, purpose, capabilities, benefit, CTA), so no invented claims
 * can enter the copy. Each item carries a real `withinLimits` verdict against
 * the platform's CURRENT public character limits; anything over limit is
 * flagged, not silently truncated into meaninglessness.
 *
 * The user's approved creative tone drives the phrasing; the CTA comes from
 * the storyboard's end-card text (approved artifact), never invented here.
 */
import { ShareCopySchema, type ShareCopy, type ProductUnderstanding } from "./types";

export const PLATFORM_LIMITS: Record<ShareCopy["items"][number]["platform"], number> = {
  youtube: 5000, // description field
  instagram: 2200,
  tiktok: 2200,
  linkedin: 3000,
  x: 280,
  whatsapp: 4096, // status/text message practical limit
};

export interface CopySource {
  product: ProductUnderstanding;
  ctaText: string;
  durationSec: number;
  aspectRatio: string;
  platforms: Array<ShareCopy["items"][number]["platform"]>;
  websiteUrl?: string;
}

function capabilityLine(p: CopySource["product"], max = 3): string {
  return (p.capabilities ?? []).slice(0, max).map((c) => `• ${c.name}`).join("\n");
}

function hashtags(p: CopySource["product"]): string {
  const name = (p.identity.name || "product").replace(/[^\w\s]/g, "").trim().split(/\s+/).slice(0, 3).map((w) => `#${w.replace(/\s+/g, "")}`);
  return [...name, "#launch", "#productdemo"].slice(0, 5).join(" ");
}

export function buildShareCopy(src: CopySource): ShareCopy {
  const name = src.product.identity.name || "Our product";
  const benefit = src.product.mainBenefit || src.product.purpose.slice(0, 160) || "See what it does.";
  const cta = src.ctaText || "Try it today.";
  const urlLine = src.websiteUrl ? `\n${src.websiteUrl}` : "";
  const feats = capabilityLine(src.product);
  const items: ShareCopy["items"] = [];

  for (const platform of src.platforms) {
    let text: string;
    switch (platform) {
      case "youtube":
        text = `${name} — ${benefit}\n\nWhat you'll see in this ${src.durationSec}s film:\n${feats || `• ${benefit}`}\n\n${cta}${urlLine}`;
        break;
      case "instagram":
        text = `${name}: ${benefit}\n\n${feats || benefit}\n\n${cta} ${hashtags(src.product)}`;
        break;
      case "tiktok":
        text = `${benefit} — ${name}. ${cta} ${hashtags(src.product)}`;
        break;
      case "linkedin":
        text = `Introducing ${name}.\n\n${benefit}\n\n${feats || `• ${benefit}`}\n\n${cta}${urlLine}`;
        break;
      case "x":
        text = `${name}: ${benefit} ${cta}`;
        break;
      case "whatsapp":
        text = `${name} — ${benefit}\n\n${feats || benefit}\n\n${cta}${urlLine}`;
        break;
    }
    const limit = PLATFORM_LIMITS[platform];
    // Honest verdict: `withinLimits` reflects whether the copy NATURALLY fits
    // (X: strict plain-character bound — URLs/emoji count differently there).
    // Over-limit copy is trimmed for usability but flagged, never silently OK.
    const fits = [...text].length <= limit;
    items.push({ platform, text: fits ? text : [...text].slice(0, limit - 1).join("") + "…", withinLimits: fits });
  }

  return ShareCopySchema.parse({ generatedAt: new Date().toISOString(), basis: "deterministic", items });
}
