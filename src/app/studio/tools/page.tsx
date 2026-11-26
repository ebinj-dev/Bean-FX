/**
 * M47.1 §B — the dedicated authenticated Creative Tools Hub route.
 * The hub itself checks the session client-side (same pattern as the studio
 * shell) and gates every launch behind the authenticated SPA; all real
 * execution paths are guarded server-side by their own APIs.
 */
import type { Metadata } from "next";
import { ToolsHub } from "@/components/bean/tools-hub";

export const metadata: Metadata = {
  title: "Creative Tools — BEAN FX Studio",
  description: "The real, inventoried tool catalog of the BEAN FX studio. Every card opens a working route; statuses reflect verified evidence.",
  robots: { index: false, follow: false },
};

export default function StudioToolsPage() {
  return <ToolsHub />;
}
