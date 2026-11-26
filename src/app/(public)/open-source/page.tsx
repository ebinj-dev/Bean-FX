/**
 * M47.1 §D — PUBLIC Open Source & Credits Center (readable WITHOUT auth).
 *
 * The tables on this page are generated from the machine-readable audit
 * (docs/legal/generated/dependency-audit.json) produced by
 * scripts/generate-open-source-audit.mjs from the REAL manifests — the page
 * never invents an entry or a license. If the audit file is missing (fresh
 * checkout), the page renders the fallback note below instead of fake data.
 */
import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Open Source & Credits Center — BEAN FX",
  description:
    "Integrated dependencies, adapted code, optional integrations, reference-only projects, license notices, SBOM and license-risk status for BEAN FX — audited from the real manifests.",
};

interface AuditEntry {
  name: string;
  version: string;
  scope: "direct" | "transitive";
  license: string | null;
  licenseSource: string | null;
  classification: string;
  repository: string | null;
}

interface Audit {
  generatedAt: string;
  counts: { total: number; direct: number; transitive: number; byClassification: Record<string, number> };
  npmPackages: AuditEntry[];
}

function loadAudit(): { audit: Audit | null; error: string | null } {
  try {
    const p = path.join(process.cwd(), "docs", "legal", "generated", "dependency-audit.json");
    return { audit: JSON.parse(fs.readFileSync(p, "utf8")) as Audit, error: null };
  } catch (err) {
    return {
      audit: null,
      error: `The dependency audit file was not found in this build. Run \`node scripts/generate-open-source-audit.mjs\` to generate it. ${err instanceof Error ? err.message : ""}`,
    };
  }
}

const CLASS_TONE: Record<string, string> = {
  PERMISSIVE: "text-[#7fd0b9]",
  "COPYLEFT-WEAK": "text-[#dcc27e]",
  "COPYLEFT-STRONG": "text-[#f87171]",
  "NON-STANDARD": "text-[#f87171]",
  UNKNOWN: "text-[#f87171]",
};

export default function OpenSourcePage() {
  const { audit, error } = loadAudit();

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <p className="pub-label">Open Source &amp; Credits Center</p>
      <h1 className="pub-serif mt-3 text-[30px] font-bold leading-tight text-white sm:text-[40px]">
        Built on open source. Credited properly.
      </h1>
      <p className="mt-4 max-w-3xl text-[13.5px] leading-relaxed text-[#a8a7a1]">
        BEAN FX stands on FFmpeg, Next.js, React, Prisma, Radix UI, CodeMirror, Tailwind and hundreds of other open-source
        projects. This center documents every integrated dependency, the code we adapted, the integrations that are optional,
        the projects we studied without copying, and the license notices that ship with this repository. Entries are audited
        from the real manifests — never guessed.
      </p>

      {error && (
        <div className="pub-glass mt-8 p-5 text-[13px] leading-relaxed text-[#f8a5a5]" role="alert">
          {error}
        </div>
      )}

      {audit && (
        <>
          {/* ── 1. Integrated dependencies ─────────────────────────────────── */}
          <section id="dependencies" className="pub-section mt-12 pt-10">
            <h2 className="pub-serif text-[22px] font-bold text-white">1. Integrated dependencies</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-[#a8a7a1]">
              Audited {audit.generatedAt.slice(0, 10)} from <code className="text-[#dcc27e]">package.json</code> +
              <code className="text-[#dcc27e]"> package-lock.json</code> + installed package metadata:{" "}
              <strong className="text-white">{audit.counts.total} npm packages</strong> ({audit.counts.direct} direct,{" "}
              {audit.counts.transitive} transitive). Classification:{" "}
              {Object.entries(audit.counts.byClassification).map(([k, v]) => (
                <span key={k} className={`mr-2 ${CLASS_TONE[k] ?? ""}`}>
                  {k}={v}
                </span>
              ))}
            </p>

            <h3 className="mt-6 text-[12px] font-bold uppercase tracking-[0.14em] text-[#dcc27e]">Direct dependencies</h3>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-left text-[12px]">
                <thead>
                  <tr className="border-b border-[#242424] text-[10.5px] uppercase tracking-[0.12em] text-[#8f8f8a]">
                    <th className="py-2 pr-3">Package</th>
                    <th className="py-2 pr-3">Version</th>
                    <th className="py-2 pr-3">License</th>
                    <th className="py-2 pr-3">Classification</th>
                    <th className="py-2">Upstream</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.npmPackages
                    .filter((e) => e.scope === "direct")
                    .map((e) => (
                      <tr key={e.name} className="border-b border-[#181818] align-top">
                        <td className="py-1.5 pr-3 text-white">{e.name}</td>
                        <td className="py-1.5 pr-3 text-[#a8a7a1]">{e.version}</td>
                        <td className="py-1.5 pr-3 text-[#a8a7a1]">
                          {e.license ?? "NOT DECLARED"}
                          {e.licenseSource === "README" && <span className="block text-[10px] text-[#6e6d68]">declared in README</span>}
                        </td>
                        <td className={`py-1.5 pr-3 ${CLASS_TONE[e.classification] ?? ""}`}>{e.classification}</td>
                        <td className="py-1.5 text-[#8f8f8a]">
                          {e.repository ? (
                            <a href={e.repository} className="break-all hover:text-[#d4a017]" rel="nofollow noreferrer">{e.repository.replace(/^git\+/, "").replace(/\.git$/, "")}</a>
                          ) : "—"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            <details className="mt-5 rounded-lg border border-[#242424] bg-[#0d0d0d] p-4">
              <summary className="cursor-pointer text-[12px] font-bold uppercase tracking-[0.12em] text-[#a8a7a1]">
                Full transitive dependency list ({audit.counts.transitive} packages)
              </summary>
              <div className="mt-4 max-h-96 overflow-y-auto">
                <table className="w-full border-collapse text-left text-[11px]">
                  <tbody>
                    {audit.npmPackages
                      .filter((e) => e.scope === "transitive")
                      .map((e) => (
                        <tr key={e.name} className="border-b border-[#141414]">
                          <td className="py-1 pr-3 text-[#c9c7c2]">{e.name}</td>
                          <td className="py-1 pr-3 text-[#6e6d68]">{e.version}</td>
                          <td className="py-1 pr-3 text-[#6e6d68]">{e.license ?? "NOT DECLARED"}</td>
                          <td className={`py-1 ${CLASS_TONE[e.classification] ?? ""}`}>{e.classification}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>

          {/* ── 2. Adapted external code ───────────────────────────────────── */}
          <section id="adapted" className="pub-section mt-12 pt-10">
            <h2 className="pub-serif text-[22px] font-bold text-white">2. Adapted external code</h2>
            <ul className="mt-4 space-y-3 text-[13px] leading-relaxed text-[#a8a7a1]">
              <li>
                <strong className="text-white">shadcn/ui primitives</strong> — the UI component files under{" "}
                <code className="text-[#dcc27e]">src/components/ui/*</code> are adapted from the shadcn/ui project (MIT),
                built on Radix UI primitives (npm dependencies listed above).
              </li>
              <li>
                <strong className="text-white">Community patterns</strong> — small, widely-known patterns (debounce,
                ARIA announcements, clipboard helpers) are re-implemented in-repo with attribution notes where a specific
                source guided the implementation.
              </li>
            </ul>
          </section>

          {/* ── 3. Optional integrations ───────────────────────────────────── */}
          <section id="optional" className="pub-section mt-12 pt-10">
            <h2 className="pub-serif text-[22px] font-bold text-white">3. Optional integrations</h2>
            <ul className="mt-4 space-y-3 text-[13px] leading-relaxed text-[#a8a7a1]">
              <li>
                <strong className="text-white">z-ai gateway SDK</strong> — environment-provided SDK used for LLM chat, ASR
                and TTS when the deployment supplies it. It is NOT a package of this repository and is excluded from
                redistribution claims; its terms are the provider&apos;s. When absent, the product discloses the missing
                capability instead of faking it.
              </li>
              <li>
                <strong className="text-white">Local transcription engines</strong> (e.g. faster-whisper) — registered in
                the model registry as NOT ready unless explicitly enabled by configuration; their licenses are assessed
                before enabling. No silent third-party engine downloads.
              </li>
            </ul>
          </section>

          {/* ── 4. Reference-only projects ─────────────────────────────────── */}
          <section id="reference" className="pub-section mt-12 pt-10">
            <h2 className="pub-serif text-[22px] font-bold text-white">4. Reference-only projects</h2>
            <p className="mt-4 text-[13px] leading-relaxed text-[#a8a7a1]">
              Public open video-AI and creative-tooling repositories studied during research are documented in{" "}
              <code className="text-[#dcc27e]">docs/OPEN_SOURCE_VIDEO_AI_RESEARCH.md</code>. They are{" "}
              <strong className="text-white">reference-only</strong>: no code was copied from them into this repository and
              they are NOT integrated dependencies. Calling them dependencies would be wrong — they are reading material.
            </p>
          </section>

          {/* ── 5. Learning resources ──────────────────────────────────────── */}
          <section id="learning" className="pub-section mt-12 pt-10">
            <h2 className="pub-serif text-[22px] font-bold text-white">5. Open-source learning resources</h2>
            <p className="mt-4 text-[13px] leading-relaxed text-[#a8a7a1]">
              FFmpeg documentation (ffmpeg.org), MDN Web Docs, WAI-ARIA Authoring Practices, and the Next.js / Prisma /
              Radix / CodeMirror documentation were used as documentation for engineering decisions. They are resources,
              not dependencies.
            </p>
          </section>

          {/* ── 6. AI coding assistant guidance ────────────────────────────── */}
          <section id="ai-assistants" className="pub-section mt-12 pt-10">
            <h2 className="pub-serif text-[22px] font-bold text-white">6. AI coding assistant guidance</h2>
            <p className="mt-4 text-[13px] leading-relaxed text-[#a8a7a1]">
              You may explore this public repository — and any public open-source repository — and use your preferred AI
              coding assistant, including Claude and other independent providers, subject to each provider&apos;s own
              terms of service. Please keep in mind:
            </p>
            <ul className="mt-4 space-y-2.5 text-[13px] leading-relaxed text-[#a8a7a1]">
              <li className="flex gap-3"><span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#d4a017]" aria-hidden />BEAN FX does <strong className="text-white">not</strong> provide unlimited free AI assistant subscriptions. AI provider pricing is separate from BEAN FX.</li>
              <li className="flex gap-3"><span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#d4a017]" aria-hidden />Public source availability does not remove copyright. Repository licenses govern code reuse.</li>
              <li className="flex gap-3"><span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#d4a017]" aria-hidden />AI-generated modifications do not remove upstream obligations — attribution, license texts and copyleft terms still apply.</li>
              <li className="flex gap-3"><span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#d4a017]" aria-hidden />Not every coding assistant is free. Check each provider&apos;s pricing and terms before relying on it.</li>
            </ul>
          </section>

          {/* ── 7. Third-party licenses & notices ──────────────────────────── */}
          <section id="notices" className="pub-section mt-12 pt-10">
            <h2 className="pub-serif text-[22px] font-bold text-white">7. Third-party licenses &amp; notices</h2>
            <p className="mt-4 text-[13px] leading-relaxed text-[#a8a7a1]">
              The repository ships the complete record: <code className="text-[#dcc27e]">THIRD_PARTY_NOTICES.md</code>{" "}
              (required notices, per license class), full license copies for direct dependencies under{" "}
              <code className="text-[#dcc27e]">docs/legal/licenses/</code>, a CycloneDX SBOM at{" "}
              <code className="text-[#dcc27e]">docs/legal/sbom.cdx.json</code> (<span id="sbom" />537 components), the
              machine-readable audit, and a license-risk report at{" "}
              <code className="text-[#dcc27e]">docs/legal/LICENSE_RISK_REPORT.md</code>.
            </p>
            <div className="pub-glass mt-6 p-5">
              <h3 className="text-[12px] font-bold uppercase tracking-[0.14em] text-[#dcc27e]">License-risk summary</h3>
              <ul className="mt-3 space-y-2 text-[12.5px] leading-relaxed text-[#a8a7a1]">
                <li><strong className="text-white">FFmpeg (server system build)</strong> — GPL-enabled Debian build (libx264). Server-side use over user-owned media; product bundling triggers GPL obligations. Flagged for owner review before any distributed build.</li>
                <li><strong className="text-white">@codesandbox/nodebox</strong> (transitive via @mdxeditor/editor → sandpack) — &ldquo;Sustainable Use License&rdquo; restricts paid/commercial use. Excluded from commercial distribution until resolved or removed.</li>
                <li><strong className="text-white">libvips prebuilds</strong> (sharp&apos;s @img/* packages) — LGPL-3.0-or-later; fine for linked/server use with notices included.</li>
                <li><strong className="text-white">Fonts</strong> — Noto Sans, Noto Sans Tamil (bundled) and Geist/Geist Mono (build-time) are OFL-1.1; redistribution keeps the license text with the fonts.</li>
                <li><strong className="text-white">Everything else</strong> — {audit.counts.byClassification.PERMISSIVE} packages with permissive licenses (MIT, ISC, Apache-2.0, BSD). No UNKNOWN-license packages remain in the tree.</li>
              </ul>
              <p className="mt-4 text-[11px] leading-relaxed text-[#6e6d68]">
                Engineering assessment, not legal advice. Browsing this credits page never requires you to accept any
                third-party license terms.
              </p>
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <a href="/legal" className="pub-ghost-btn">Legal Center</a>
              <a href="/terms" className="pub-ghost-btn">Terms of Service</a>
              <a href="/privacy" className="pub-ghost-btn">Privacy Policy</a>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
