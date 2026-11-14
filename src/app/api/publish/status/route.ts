/**
 * M9 API — GET /api/publish/status
 * Honest capability status (§9/§4/§3): which providers are REALLY configured
 * (verified by real health attempts), and which publishing integrations exist.
 * Never claims an integration that is not operational.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { llmHealth } from "@/lib/my-ai/gateway/provider";
import { laxiiProviderIds } from "@/lib/laxii/providers";
import { exportProfileRegistry } from "@/lib/publish/profiles";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const llm = await llmHealth();
  const registry = exportProfileRegistry();

  return NextResponse.json({
    engines: {
      metadataGeneration: {
        available: llm.ok,
        provider: llm.ok ? "configured" : "unavailable",
        detail: llm.detail,
        cached: llm.cached,
      },
      thumbnailGeneration: {
        available: laxiiProviderIds().length > 0,
        providers: laxiiProviderIds(),
        note: "LAXII generates thumbnail base images via the configured image provider; title overlays are composited server-side.",
      },
    },
    publishingIntegrations: [
      {
        platform: "youtube",
        operational: false,
        status: "not-configured",
        note: "Publication-ready exports are provided instead. A real integration requires an OAuth 2.0 client with the YouTube Data API enabled (videos.insert; quota-costed) and user consent — none is configured in this deployment. No upload button is offered.",
        docs: "https://support.google.com/youtube/answer/1722171",
      },
      {
        platform: "instagram",
        operational: false,
        status: "not-configured",
        note: "Meta's Content Publishing API requires a Business/Creator account, an app with Advanced Access (app review) and the instagram_business_content_publish permission — none is configured. Publication-ready exports are provided instead; no simulated publishing exists.",
        docs: "https://developers.facebook.com/documentation/instagram-platform/content-publishing",
      },
      {
        platform: "tiktok",
        operational: false,
        status: "not-configured",
        note: "The Content Posting API requires video.publish grants and (for public posts) a TikTok-audited client — unaudited clients are restricted to private viewing. Not configured here; publication-ready exports are provided instead.",
        docs: "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post",
      },
    ],
    exportProfiles: { version: registry.version, source: registry.source, count: Object.keys(registry.profiles).length },
  });
}
