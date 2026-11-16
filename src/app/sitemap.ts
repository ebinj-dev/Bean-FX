import type { MetadataRoute } from "next";

/**
 * M19 §15 — public sitemap. Marketing/legal pages only; the editor, account
 * and API surfaces are excluded (robots.txt + authorization protect them).
 */
const BASE_URL = process.env.PUBLIC_APP_URL ?? "https://beanfx.example.invalid";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ["", "/features", "/pricing", "/about", "/contact", "/faq", "/help", "/privacy", "/terms", "/cookies"];
  return routes.map((r) => ({
    url: `${BASE_URL}${r}`,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: r === "" ? 1 : 0.7,
  }));
}
