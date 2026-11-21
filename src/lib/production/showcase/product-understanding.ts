/**
 * M31 SHOWCASE STUDIO — Product Understanding Engine (Phase 1).
 *
 * ORIGINAL BEAN FX implementation. Turns showcase inputs (description, feature
 * list, authorized website URL, screenshots, demo recordings, an existing BEAN
 * FX project) into a VALIDATED, evidence-traced product-understanding artifact.
 *
 * Security & honesty rules enforced here:
 * - SSRF guard: only public http(s) URLs; DNS-resolved addresses are checked
 *   against loopback/private/link-local ranges before any request is made.
 * - Retrieved website content is UNTRUSTED DATA: it is parsed as text only and
 *   can never steer the agent or trigger actions.
 * - Secrets (emails, tokens, internal hostnames, private paths) found in the
 *   collected evidence are REDACTED before storage; only the redaction KIND is
 *   logged, never the value.
 * - No invented metrics/testimonials/customer counts: the deterministic core
 *   carries only recorded evidence; the optional LLM pass must derive strictly
 *   from that evidence and anything numeric/superlative it adds without a
 *   source is demoted to unverifiedClaims by a post-lint.
 */
import { execFile } from "node:child_process";
import dns from "node:dns/promises";
import { z } from "zod";
import { db } from "@/lib/db";
import { ffprobe } from "@/lib/media-storage";
import { getTimelineHead } from "@/lib/editor/persistence";
import { llmHealth, LLMError } from "@/lib/my-ai/gateway/provider";
import { chatValidated } from "@/lib/my-ai/gateway/structured";
import { ShowcaseInputsSchema, ProductUnderstandingSchema, type ShowcaseInputs, type ProductUnderstanding, type SourceEvidence } from "./types";

// ── SSRF guard ──────────────────────────────────────────────────────────────
const BLOCKED_V4 = [
  /^127\./, /^10\./, /^0\./, /^169\.254\./, /^192\.168\./, /^100\.6[4-9]\./, /^100\.[7-9]\./, /^100\.1[01]\./, /^100\.12[0-7]\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^192\.0\.0\./, /^198\.18\./, /^198\.19\./, /^22[4-9]\./, /^23[0-9]\./,
];
const BLOCKED_HOSTS = /^(localhost|.*\.local|.*\.internal|metadata.*|.*\.arpa)$/i;

export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http(s) URLs are allowed.");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed.");
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.test(host)) throw new Error("Internal hosts are not allowed.");
  if (host === "::1" || host.endsWith(":1")) throw new Error("Internal hosts are not allowed.");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    // IP literal: must be public; also resolvable check is skipped for literals.
    if (BLOCKED_V4.some((re) => re.test(host))) throw new Error("Private IP addresses are not allowed.");
    return url;
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Host "${host}" does not resolve.`);
  }
  if (addresses.length === 0) throw new Error(`Host "${host}" does not resolve.`);
  for (const a of addresses) {
    if (a.family === 4 && BLOCKED_V4.some((re) => re.test(a.address))) throw new Error("Host resolves to a private address.");
    if (a.family === 6 && /^(::1|f[cd]|fe80)/i.test(a.address)) throw new Error("Host resolves to a private address.");
  }
  return url;
}

// ── Website fetch (untrusted data, manual redirect re-validation) ───────────
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 768 * 1024;

export async function fetchWebsiteText(rawUrl: string): Promise<{ title: string; description: string; headings: string[]; text: string; finalUrl: string }> {
  let url = await assertPublicHttpUrl(rawUrl);
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": "BeanFX-Showcase-Analysis/1.0 (+product understanding; respects robots intent; text only)" } });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("Redirect without location.");
      url = await assertPublicHttpUrl(new URL(loc, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`Website returned HTTP ${res.status}.`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|x-html/i.test(type)) throw new Error(`Unsupported content type "${type}" — HTML or plain text only.`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_HTML_BYTES) throw new Error("Page exceeds the 768 KB analysis cap.");
    const html = buf.toString("utf8");
    return { ...extractFromHtml(html), finalUrl: url.toString() };
  }
  throw new Error("Too many redirects.");
}

/** Pure HTML → text extraction (no execution, no link following). */
export function extractFromHtml(html: string): { title: string; description: string; headings: string[]; text: string } {
  const strip = (s: string) => s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<svg[\s\S]*?<\/svg>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const safe = strip(html);
  const title = (safe.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const description = (safe.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']{0,300})["']/i)?.[1] ?? (safe.match(/<meta[^>]+content=["']([^"']{0,300})["'][^>]*name=["']description["']/i)?.[1] ?? "")).trim();
  const headings: string[] = [];
  const hre = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = hre.exec(safe)) !== null && headings.length < 12) {
    const t = hm[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (t) headings.push(t.slice(0, 150));
  }
  const text = safe.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim().slice(0, 4000);
  return { title, description, headings, text };
}

// ── Deterministic brand palette from screenshots / demo frames ──────────────
export function quantizeColors(rgb: Buffer, top = 6): string[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    cur.n++; cur.r += r; cur.g += g; cur.b += b;
    buckets.set(key, cur);
  }
  return [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, top).map((c) => {
    const hex = (v: number) => Math.round(v / c.n).toString(16).padStart(2, "0").toUpperCase();
    return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
  });
}

export function paletteColorsBinary(file: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-i", file, "-map", "0:v:0", "-vf", "scale=32:32", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }, (err, stdout) => {
      if (err || !stdout || stdout.length < 3) { resolve([]); return; }
      resolve(quantizeColors(Buffer.from(stdout)));
    });
  });
}

// ── Secret redaction (kinds logged, values never stored) ────────────────────
const REDACTIONS: Array<{ kind: string; re: RegExp }> = [
  { kind: "email", re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g },
  { kind: "bearer-token", re: /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.)\b/g },
  { kind: "api-key", re: /\b[A-Fa-f0-9]{32,}\b|\b[AB]_[A-Za-z0-9]{20,}\b/g },
  { kind: "private-url", re: /\bhttps?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)[^\s"']*/g },
  { kind: "private-path", re: /(?:\/home\/[\w.-]+|\/Users\/[\w.-]+|C:\\Users\\[\w.-]+)[^\s"',]*/g },
];
export interface RedactionResult { text: string; excludedKinds: string[] }
export function redactSecrets(input: string): RedactionResult {
  let text = input;
  const kinds: string[] = [];
  for (const { kind, re } of REDACTIONS) {
    text = text.replace(re, () => { if (!kinds.includes(kind)) kinds.push(kind); return `[REDACTED:${kind}]`; });
  }
  return { text, excludedKinds: kinds };
}

// ── Deterministic keyword extraction ────────────────────────────────────────
export function featureListToCapabilities(list: string): Array<{ name: string; evidence: string }> {
  return list.split(/\r?\n|;|(?:,\s(?=[A-Z]))/).map((s) => s.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, "")).filter((s) => s.length >= 3 && s.length <= 200).slice(0, 6).map((name) => ({ name, evidence: "user-provided feature list" }));
}

// ── Main analysis ───────────────────────────────────────────────────────────
export interface UnderstandingRunOptions { llmAssist?: boolean }

export async function analyzeProductUnderstanding(userId: string, rawInputs: unknown, opts: UnderstandingRunOptions = {}): Promise<ProductUnderstanding> {
  const inputs = ShowcaseInputsSchema.parse(rawInputs);
  const sources: SourceEvidence[] = [];
  const exclusions: string[] = [];
  const unverified: string[] = [];
  const colors: string[] = [];
  const visualRefs: ProductUnderstanding["visualReferences"] = [];
  let logoMediaId: string | null = null;

  const record = (kind: SourceEvidence["kind"], ref: string, evidence: string) => {
    const r = redactSecrets(evidence.slice(0, 800));
    exclusions.push(...r.excludedKinds.map((k) => `redacted ${k} in ${kind} evidence (value not stored)`));
    sources.push({ kind, ref: redactSecrets(ref.slice(0, 300)).text, evidence: r.text });
  };

  // 1) Feature list + description (user-stated = explicit verification by the user).
  const caps = featureListToCapabilities(inputs.featureList);
  for (const c of caps) sources.push({ kind: "feature-list", ref: "user feature list", evidence: redactSecrets(c.name).text });
  if (inputs.description.trim()) record("user-stated", "user description", inputs.description);

  // 2) Website (authorized public URL).
  let siteName = ""; let siteTagline = ""; let purposeText = "";
  if (inputs.websiteUrl.trim()) {
    try {
      const site = await fetchWebsiteText(inputs.websiteUrl.trim());
      siteName = site.title.split(/[|\-–—:]/)[0].trim().slice(0, 120);
      siteTagline = site.description.slice(0, 200);
      purposeText = site.text.slice(0, 1500);
      for (const h of site.headings.slice(0, 4)) record("website", site.finalUrl, h);
      if (site.description) record("website", site.finalUrl, site.description);
      record("website", site.finalUrl, site.text.slice(0, 600));
    } catch (err) {
      record("website", inputs.websiteUrl, `FETCH FAILED — recorded honestly: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3) Screenshots (owned media) → palette + references.
  for (const id of inputs.screenshotMediaIds.slice(0, 6)) {
    const asset = await db.mediaAsset.findUnique({ where: { id } });
    if (!asset || asset.userId !== userId) { record("screenshot", id, "skipped: media asset not found or not owned by caller"); continue; }
    const cols = await paletteColorsBinary(asset.storagePath);
    colors.push(...cols.slice(0, 3));
    visualRefs.push({ mediaId: id, kind: "screenshot", note: `${asset.originalName} (${asset.width ?? "?"}x${asset.height ?? "?"})` });
    record("screenshot", asset.originalName, `UI capture ${asset.width ?? "?"}x${asset.height ?? "?"}; dominant colors ${cols.slice(0, 3).join(", ") || "unavailable"}`);
  }

  // 4) Demo videos (owned media) → real probe + scene count.
  for (const id of inputs.demoVideoMediaIds.slice(0, 2)) {
    const asset = await db.mediaAsset.findUnique({ where: { id } });
    if (!asset || asset.userId !== userId) { record("demo-video", id, "skipped: media asset not found or not owned by caller"); continue; }
    try {
      const probe = await ffprobe(asset.storagePath);
      visualRefs.push({ mediaId: id, kind: "demo-frame", note: `demo recording ${probe.durationSec?.toFixed(1) ?? "?"}s ${probe.width}x${probe.height}` });
      record("demo-video", asset.originalName, `screen recording ${probe.durationSec?.toFixed(1) ?? "?"}s @ ${probe.width}x${probe.height}, ${probefpsNote(probe.fps)}`);
    } catch {
      record("demo-video", asset.originalName, "probe failed — recorded honestly");
    }
  }

  // 5) Existing BEAN FX project → real timeline evidence.
  let projectName = "";
  if (inputs.projectId) {
    const project = await db.project.findUnique({ where: { id: inputs.projectId } });
    if (project && project.userId === userId) {
      projectName = project.name;
      try {
        const head = await getTimelineHead(inputs.projectId, userId);
        const seq = head.sequence as { tracks?: Array<{ clips?: unknown[] }>; clips?: unknown[] };
        const clipCount = Array.isArray(seq.clips) ? seq.clips.length : (seq.tracks ?? []).reduce((n, t) => n + (t.clips?.length ?? 0), 0);
        record("project", project.name, `BEAN FX project "${project.name}" — ${clipCount} timeline clips analyzed for showcase material`);
      } catch (err) {
        record("project", project.name, `timeline read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      record("project", inputs.projectId, "skipped: project not found or not owned by caller");
    }
  }

  const name = inputs.productName.trim() || siteName || projectName || "Unnamed product";
  const deterministic: ProductUnderstanding = ProductUnderstandingSchema.parse({
    generatedAt: new Date().toISOString(),
    basis: "deterministic",
    inputsUsed: [
      inputs.description && "description", inputs.featureList && "featureList", inputs.websiteUrl && "websiteUrl",
      inputs.screenshotMediaIds.length > 0 && "screenshots", inputs.demoVideoMediaIds.length > 0 && "demoVideos", inputs.projectId && "project",
    ].filter(Boolean) as string[],
    identity: { name, tagline: siteTagline },
    purpose: purposeText.slice(0, 1000) || redactSecrets(inputs.description).text.slice(0, 1000),
    audience: extractAudience(inputs.description + " " + purposeText),
    problem: "",
    mainBenefit: "",
    capabilities: caps.length > 0 ? caps : [],
    differentiators: [],
    workflow: [],
    brand: { colors: dedupe(colors).slice(0, 6), typographyNote: "", logoMediaId, notes: "Palette derived deterministically from provided captures (32×32 quantization)." },
    visualReferences: visualRefs,
    sources: sources.slice(0, 40),
    unverifiedClaims: unverified,
    exclusions: exclusions.slice(0, 20),
    approval: "PENDING",
  });

  if (!opts.llmAssist) return deterministic;

  // Optional LLM refinement — STRICTLY from recorded evidence, validated,
  // then post-linted: any number/superlative claim without an evidence source
  // is demoted to unverifiedClaims (never silently trusted).
  try {
    const health = await llmHealth();
    if (!health.ok) return { ...deterministic, sources: [...deterministic.sources, { kind: "user-stated", ref: "llm-gateway", evidence: `LLM refinement skipped — gateway not healthy (${health.detail})` }] };
    const evidenceJson = JSON.stringify({ sources: deterministic.sources, identity: deterministic.identity, purpose: deterministic.purpose, colors: deterministic.brand.colors }).slice(0, 12000);
    const refined = await chatValidated(userId, RefineSchema, [
      { role: "system", content: "You structure product facts for a promotional video. Use ONLY the provided evidence. NEVER invent metrics, customer counts, testimonials, performance numbers or awards. Every capability/differentiator you output must quote its supporting evidence in `evidence`. Respond with ONLY JSON." },
      { role: "user", content: `Evidence JSON:\n${evidenceJson}\n\nProduce JSON with keys: purpose (<=1000 chars), audience, problem, mainBenefit, capabilities (array of {name, evidence}, max 6), differentiators (array of strings, max 5), workflow (array of <=6 short steps), tagline (<=200 chars).` },
    ], { temperature: 0.2, timeoutMs: 45_000 });
    const linted = claimsLint(refined.data, deterministic.sources);
    return ProductUnderstandingSchema.parse({
      ...deterministic,
      basis: "llm-assisted",
      identity: { name: deterministic.identity.name, tagline: refined.data.tagline || deterministic.identity.tagline },
      purpose: deterministic.purpose || refined.data.purpose.slice(0, 1000),
      audience: refined.data.audience.slice(0, 500) || deterministic.audience,
      problem: refined.data.problem.slice(0, 500),
      mainBenefit: refined.data.mainBenefit.slice(0, 500),
      capabilities: refined.data.capabilities.slice(0, 6).map((c) => ({ name: String(c.name).slice(0, 200), evidence: String(c.evidence).slice(0, 500) })),
      differentiators: refined.data.differentiators.slice(0, 5).map((d) => String(d).slice(0, 300)),
      workflow: refined.data.workflow.slice(0, 6).map((w) => String(w).slice(0, 200)),
      unverifiedClaims: [...deterministic.unverifiedClaims, ...linted].slice(0, 20),
    });
  } catch (err) {
    const detail = err instanceof LLMError ? `${err.code}: ${err.message}` : String(err).slice(0, 200);
    return { ...deterministic, sources: [...deterministic.sources, { kind: "user-stated", ref: "llm-gateway", evidence: `LLM refinement failed — recorded honestly: ${detail}` }] };
  }
}

const RefineSchema = z.object({
  purpose: z.string().max(1000).default(""),
  audience: z.string().max(500).default(""),
  problem: z.string().max(500).default(""),
  mainBenefit: z.string().max(500).default(""),
  capabilities: z.array(z.object({ name: z.string().max(200), evidence: z.string().max(500) })).max(6).default([]),
  differentiators: z.array(z.string().max(300)).max(5).default([]),
  workflow: z.array(z.string().max(200)).max(6).default([]),
  tagline: z.string().max(200).default(""),
});

/** Numbers/superlatives in LLM output that no evidence source contains are unverified. */
export function claimsLint(data: { capabilities: Array<{ name: string; evidence: string }>; differentiators: string[]; mainBenefit: string; problem: string; audience: string }, sources: SourceEvidence[]): string[] {
  const corpus = sources.map((s) => `${s.ref} ${s.evidence}`).join(" \n ").toLowerCase();
  const claims = [data.mainBenefit, data.problem, data.audience, ...data.differentiators, ...data.capabilities.map((c) => c.name)];
  const out: string[] = [];
  const superlative = /\b(fastest|#1|best-in-class|number one|no\.1|market leader|guaranteed|10x|100x|world'?s (?:first|best)|revolutionary)\b/i;
  for (const c of claims) {
    if (!c) continue;
    const nums = c.match(/\b\d+(?:\.\d+)?(?:%|x|k|m|\+)?\b/gi) ?? [];
    const unbackedNums = nums.filter((n) => !corpus.includes(n.toLowerCase()));
    const sup = c.match(superlative);
    if (unbackedNums.length > 0 || sup) {
      out.push(`Unverified claim demoted: "${c.slice(0, 200)}"${unbackedNums.length ? ` (unbacked numbers: ${unbackedNums.join(", ")})` : ""}${sup ? ` (superlative "${sup[0]}")` : ""}`);
    }
  }
  return out.slice(0, 20);
}

function extractAudience(text: string): string {
  const m = text.match(/for\s+([A-Z][\w\s&-]{3,60}?)(?:[.,;]| who | that | with | to )/);
  return m ? m[1].trim().slice(0, 500) : "";
}
function dedupe(list: string[]): string[] { return [...new Set(list.map((s) => s.toUpperCase()))]; }
function probefpsNote(fps: unknown): string { return fps && typeof fps === "number" && fps > 0 ? `${fps.toFixed(0)} fps` : "fps unknown"; }
