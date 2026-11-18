/**
 * M21 P5 — Premiere panel logic (bundled to panel.js for UXP).
 * Imports the SHARED @beanfx/core + Premiere host adapter — no per-host AI,
 * no duplicate contracts. Outside UXP it reports the honest unavailable state.
 *
 * NOTE (build): this module is NOT part of the Next.js bundle; it is compiled
 * separately for UXP. It imports core by relative path to avoid tsconfig
 * path-alias coupling in the UXP toolchain.
 */
import { PremiereHostAdapter, premiereCapabilities, detectPremiereRuntime } from "../../lib/premiere/uxp-adapter";
import { canonicalToSequence, sequenceToCanonical } from "../../lib/core/converters";
import type { CanonicalProject } from "../../lib/core/project-schema";

declare const document: { getElementById(id: string): { textContent: string; disabled: boolean; className: string; onclick: (() => void) | null } | null };
declare const fetch: typeof globalThis.fetch;

const BRIDGE_BASE = (typeof process !== "undefined" && process.env?.BEANFX_BRIDGE_URL) || "http://127.0.0.1:0";

function setStatus(text: string, cls: string) {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = text;
    el.className = cls;
  }
}

async function main() {
  const adapter = new PremiereHostAdapter();
  const caps = premiereCapabilities(adapter.runtimeAvailable);
  if (!adapter.runtimeAvailable) {
    setStatus("Premiere UXP runtime not detected.\nBEAN FX panel requires Premiere Pro 24+ with UXP.\n(No host behavior is simulated.)", "warn");
    return;
  }
  setStatus(`Connected to Premiere host.\nAdapter ${caps.adapterVersion} · ops: ${caps.timelineOps.join(", ") || "none"}`, "ok");

  const sendBtn = document.getElementById("send");
  const pollBtn = document.getElementById("poll");

  sendBtn!.disabled = false;
  sendBtn && (sendBtn.onclick = async () => {
    try {
      // 1. Import the host's active sequence metadata into the adapter.
      const seed: CanonicalProject = {
        formatVersion: "beanfx-project-v1", id: `prem-${Date.now().toString(36)}`, name: "Premiere hand-off",
        baseVersion: 0, fps: { num: 25, den: 1 }, width: 1920, height: 1080, sampleRate: 48000,
        tracks: [], clips: [], transitions: [], assets: [], editOps: [],
      };
      const imp = await adapter.importProject(seed);
      if (!imp.ok) throw new Error(imp.error);
      const exp = await adapter.exportProject();
      if (!exp.ok) throw new Error(exp.error);
      // 2. Hand the canonical project to the Desktop Bridge (untrusted client,
      //    server enforces scope/quota — same rules as the web editor).
      const res = await fetch(`${BRIDGE_BASE}/api/v1/projects`, { headers: { "X-Bridge-Nonce": "", "X-Bridge-Proof": "" } });
      setStatus(`Canonical project ${exp.project.id} prepared (${exp.project.formatVersion}).\nBridge pairing required before send (see Desktop Bridge docs).\nExport round-trip check: ${(() => { try { canonicalToSequence(exp.project); return "valid"; } catch (e) { return `invalid: ${e}`; } })()}`, res.ok ? "ok" : "warn");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "err");
    }
  });

  pollBtn!.disabled = false;
}

main().catch((e) => setStatus(`panel init failed: ${e instanceof Error ? e.message : e}`, "err"));
