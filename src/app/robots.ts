import type { MetadataRoute } from "next";

/** M19 §15 — index marketing pages; keep private surfaces out. */
const BASE_URL = process.env.PUBLIC_APP_URL ?? "https://beanfx.example.invalid";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/features", "/pricing", "/about", "/contact", "/faq", "/help", "/privacy", "/terms", "/cookies"],
        disallow: ["/api/", "/settings", "/verify-email", "/reset-password", "/forgot-password"],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
