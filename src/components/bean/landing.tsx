"use client";

/**
 * M47.1 §C — PUBLIC PREMIUM HOMEPAGE (pre-login).
 *
 * Honesty rules encoded here:
 *  - no testimonials, no performance claims, no fabricated agent results,
 *    no fake rendered videos, no invented provider capabilities;
 *  - voice section states English verified / Tamil & Tanglish unverified;
 *  - tool maturity is NOT uniform — the hub shows evidence-based status;
 *  - every screenshot slot uses a REAL product capture (public/brand/*, made
 *    during the M47.1 browser battery) and falls back to a styled panel when
 *    the capture is not present, never a stock image.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BeanLogo } from "@/components/bean/logo";

/* ── shared pieces ─────────────────────────────────────────────────────────── */

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            (e.target as HTMLElement).dataset.shown = "true";
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

function Reveal({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={`pub-reveal ${className}`}>
      {children}
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-4 flex items-center gap-3">
      <span className="pub-eyebrow-line" aria-hidden="true" />
      <span className="pub-label">{children}</span>
    </span>
  );
}

/** Real product capture with graceful fallback to a styled panel. */
function PubShot({ src, alt, fallback }: { src: string; alt: string; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="pub-shot">{fallback}</div>;
  return (
    <figure className="pub-shot">
      <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
    </figure>
  );
}

const SectionHead = ({ eyebrow, title, lede }: { eyebrow: string; title: React.ReactNode; lede?: string }) => (
  <Reveal className="max-w-2xl">
    <Eyebrow>{eyebrow}</Eyebrow>
    <h2 className="pub-serif text-[26px] font-bold leading-[1.15] tracking-[-0.01em] text-[var(--pub-ink)] sm:text-[34px]">{title}</h2>
    {lede && <p className="mt-4 text-[14px] leading-relaxed text-[var(--pub-ink-mid)]">{lede}</p>}
  </Reveal>
);

const CREW = [
  {
    name: "RIISHE",
    role: "Executive director",
    body: "Holds the brief, directs the plan and reviews real task output — not stage labels. Every consequential edit RIISHE proposes passes an explicit approval gate before it touches your timeline.",
    tone: "RIISHE",
  },
  {
    name: "NIIKI",
    role: "VFX & motion graphics",
    body: "Chroma key, masks, motion blur, stabilization and titles — executed as real FFmpeg/canvas effects on the canonical timeline, with provenance on every generated asset.",
    tone: "NIIKI",
  },
  {
    name: "GANGZII",
    role: "Sound",
    body: "Stream-decodes your audio, inspects loudness and character, plans silence removal and level shaping — every proposal is reviewable before it is applied.",
    tone: "GANGZII",
  },
  {
    name: "JAZMII",
    role: "Footage intelligence",
    body: "Scene detection, shot coverage, transcript-linked search and source-to-timeline tracing, built on real FFprobe data — never on guesswork about your media.",
    tone: "JAZMII",
  },
  {
    name: "LAXII",
    role: "Visual assets",
    body: "Generates and composes images through the configured provider with ownership checks and rate limits — reference assets come from your own library.",
    tone: "LAXII",
  },
];

const WORKFLOW = [
  { step: "01", title: "Brief", body: "Describe the video in Studio Chat — by typing or by voice. Attach real media assets from your project." },
  { step: "02", title: "Plan", body: "RIISHE returns a structured production plan with scenes, assets and stages. Deterministic steps are labeled as automation; LLM steps disclose the provider." },
  { step: "03", title: "Approve", body: "Consequential actions wait for you. Asset binding, stage execution and edits all pass explicit approval gates." },
  { step: "04", title: "Assemble", body: "Approved plans assemble on the canonical timeline with your real media — the same editor you can drive by hand." },
  { step: "05", title: "Render & QA", body: "Exports run through the durable job system; QA inspects the real rendered file with FFprobe before anything is called done." },
];

const EDITOR_POINTS = [
  { title: "A real command registry", body: "33 editing commands — trim, split, ripple delete, roll edits, keyframes, transitions, markers — one executor shared by the UI, agents and automation." },
  { title: "FFmpeg-grade VFX", body: "Chroma key, masks, motion blur, color/tone compositing with animated parameters; previews are honest about approximation." },
  { title: "Versions, never overwrites", body: "Every render is a new version. Compare outputs, restore timeline versions, keep the earlier success intact." },
];

export function LandingPage({ onOpenStudio, onLogin }: { onOpenStudio: () => void; onLogin?: () => void }) {
  return (
    <div className="min-h-screen bg-[var(--pub-bg)] text-[var(--pub-ink)]">
      {/* ── 1. HERO ─────────────────────────────────────────────────────────── */}
      <section className="pub-hero-gradient relative overflow-hidden" id="product">
        <div className="mx-auto max-w-6xl px-4 pb-16 pt-20 text-center sm:px-6 sm:pt-28">
          <Reveal>
            <p className="pub-label">BEAN FX — Creative Intelligence Studio</p>
            <h1 className="pub-serif mx-auto mt-6 max-w-3xl text-[40px] font-bold leading-[1.06] tracking-[-0.015em] text-white sm:text-6xl md:text-[72px]">
              Direct your footage like a <span className="italic text-[var(--pub-gold-soft)]">studio</span>, not a dashboard.
            </h1>
            <p className="mx-auto mt-7 max-w-2xl text-[15px] leading-relaxed text-[var(--pub-ink-mid)] sm:text-[16px]">
              BEAN FX is a browser-based professional video workspace: a chat-first production flow, a canonical timeline
              editor, a real crew pipeline with approval gates, and exports validated against the actual rendered file.
            </p>
          </Reveal>
          <Reveal className="mt-10 flex flex-wrap items-center justify-center gap-3.5">
            <button onClick={onOpenStudio} className="pub-gold-btn">Launch Studio →</button>
            {onLogin && (
              <button onClick={onLogin} className="pub-ghost-btn">Sign in</button>
            )}
            <Link href="#workflow" className="pub-ghost-btn">See the workflow</Link>
          </Reveal>
          <Reveal className="mt-14">
            <PubShot
              src="/brand/studio-chat.png"
              alt="BEAN FX Studio Chat — RIISHE conversation with production plan and stage board"
              fallback={
                <div className="flex aspect-[16/8] flex-col items-center justify-center gap-2 p-6 text-center">
                  <span className="pub-label">Studio Chat</span>
                  <p className="pub-serif text-[19px] text-[var(--pub-silver)]">Brief → plan → approve → assemble → render</p>
                  <p className="max-w-md text-[11.5px] leading-relaxed text-[var(--pub-ink-dim)]">
                    One conversation carries your project: attachments, asset planning, stage controls and rendered versions.
                  </p>
                </div>
              }
            />
          </Reveal>
        </div>
      </section>

      {/* ── 2. AI-FIRST PRODUCTION WORKFLOW ────────────────────────────────── */}
      <section className="pub-section" id="workflow">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <SectionHead
            eyebrow="AI-first production workflow"
            title={<>From one sentence to a finished cut — through gates you control.</>}
            lede="Studio Chat turns a brief into a structured production plan. Automation is labeled as automation; model involvement is disclosed per step. Nothing consequential runs without your approval."
          />
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {WORKFLOW.map((w) => (
              <Reveal key={w.step} className="pub-card p-5">
                <span className="pub-serif text-[26px] font-bold text-[var(--pub-gold)]">{w.step}</span>
                <h3 className="mt-2 text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--pub-ink)]">{w.title}</h3>
                <p className="mt-2 text-[12px] leading-relaxed text-[var(--pub-ink-mid)]">{w.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── 3. RIISHE ───────────────────────────────────────────────────────── */}
      <section className="pub-section">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:items-center">
          <SectionHead
            eyebrow="RIISHE — executive director"
            title={<>A director that reads the real timeline, not a stage label.</>}
            lede="RIISHE plans productions, reviews genuine task output, and keeps every destructive operation behind a confirmation. When a provider is configured, the model behind each step is disclosed; when it is not, RIISHE says so instead of pretending."
          />
          <Reveal className="pub-glass p-6">
            <ul className="space-y-4 text-[13px] leading-relaxed text-[var(--pub-ink-mid)]">
              <li className="flex gap-3"><span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--pub-gold)]" aria-hidden />Plans structured productions with scenes, assets and stage dependencies.</li>
              <li className="flex gap-3"><span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--pub-gold)]" aria-hidden />Executes through the one production runner — durable stages, retries, provenance — no second engine.</li>
              <li className="flex gap-3"><span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--pub-gold)]" aria-hidden />Accepts voice instructions that always pass through the same plan-and-approve flow as typed ones.</li>
              <li className="flex gap-3"><span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--pub-gold)]" aria-hidden />Never claims autonomous AI execution where deterministic automation ran — the label is on the stage.</li>
            </ul>
          </Reveal>
        </div>
      </section>

      {/* ── 4. SPECIALIST CREW ──────────────────────────────────────────────── */}
      <section className="pub-section">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <SectionHead
            eyebrow="The specialist crew"
            title={<>Five specialists. One shared engine. Zero fake activity.</>}
            lede="Each specialist produces artifacts the next stage actually consumes — verified media, real plans, inspected audio. Progress you see corresponds to jobs that ran."
          />
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {CREW.map((c) => (
              <Reveal key={c.name} className="pub-card p-5">
                <span className={`m47-agent-dot m47-agent-${c.tone} !h-2.5 !w-2.5`} aria-hidden />
                <h3 className="mt-3 text-[14px] font-extrabold tracking-[0.12em] text-white">{c.name}</h3>
                <p className="mt-0.5 text-[10.5px] font-bold uppercase tracking-[0.14em] text-[var(--pub-gold-soft)]">{c.role}</p>
                <p className="mt-2.5 text-[12px] leading-relaxed text-[var(--pub-ink-mid)]">{c.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── 5. STUDIO CHAT ──────────────────────────────────────────────────── */}
      <section className="pub-section">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:items-center">
          <div>
            <SectionHead
              eyebrow="Studio Chat"
              title={<>The conversation is the studio.</>}
              lede="Projects, conversations, attachments, asset planning, stage controls and rendered versions live in one chat-first surface. Reopen any conversation and its production context is exactly where you left it."
            />
            <Reveal className="mt-6 flex flex-wrap gap-3">
              <button onClick={onOpenStudio} className="pub-gold-btn">Open Studio Chat</button>
              {onLogin && <button onClick={onLogin} className="pub-ghost-btn">Sign in first</button>}
            </Reveal>
          </div>
          <Reveal>
            <PubShot
              src="/brand/voice-transcript.png"
              alt="Voice capture with editable transcript, language register and confidence chips"
              fallback={
                <div className="flex aspect-[16/9] flex-col justify-center gap-3 p-7">
                  <span className="pub-label">Voice → editable transcript</span>
                  <p className="pub-serif text-[18px] leading-snug text-[var(--pub-silver)]">“Cut the first three seconds and warm the grade.”</p>
                  <p className="text-[11.5px] leading-relaxed text-[var(--pub-ink-dim)]">
                    Original preserved · confidence shown · you edit before anything runs.
                  </p>
                </div>
              }
            />
          </Reveal>
        </div>
      </section>

      {/* ── 6. PROFESSIONAL VIDEO EDITOR ───────────────────────────────────── */}
      <section className="pub-section">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <SectionHead
            eyebrow="Professional video editor"
            title={<>A canonical timeline you can drive by hand.</>}
            lede="The same editor RIISHE assembles with is yours directly: real commands, real keyframes, real renders — one shared engine, no second timeline."
          />
          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {EDITOR_POINTS.map((p) => (
              <Reveal key={p.title} className="pub-card p-5">
                <h3 className="text-[13.5px] font-bold text-white">{p.title}</h3>
                <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--pub-ink-mid)]">{p.body}</p>
              </Reveal>
            ))}
          </div>
          <Reveal className="mt-8">
            <PubShot
              src="/brand/editor-riishe.png"
              alt="BEAN FX editor — timeline, inspector and the RIISHE dock"
              fallback={
                <div className="flex aspect-[16/8] flex-col items-center justify-center gap-2 p-6 text-center">
                  <span className="pub-label">Timeline · Inspector · RIISHE dock</span>
                  <p className="pub-serif text-[19px] text-[var(--pub-silver)]">33 real editing commands, one executor</p>
                </div>
              }
            />
          </Reveal>
        </div>
      </section>

      {/* ── 7. CREATIVE TOOLS HUB ───────────────────────────────────────────── */}
      <section className="pub-section">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:items-center">
          <div>
            <SectionHead
              eyebrow="Creative Tools Hub"
              title={<>Every tool, its real status, one hub.</>}
              lede="An inventoried catalog of the studio's actual tools — editing, audio, VFX, captions and voice, footage intelligence, image work, delivery. Each card shows an evidence-based status (READY / BETA / CONFIGURATION REQUIRED) and opens the real route. Not every tool is at the same maturity — the hub says which is which."
            />
            <Reveal className="mt-6">
              <Link href="/studio/tools" className="pub-gold-btn">Explore Creative Tools</Link>
              <p className="mt-3 text-[11px] text-[var(--pub-ink-dim)]">The hub is part of the authenticated studio — you'll sign in to launch tools.</p>
            </Reveal>
          </div>
          <Reveal>
            <PubShot
              src="/brand/tools-hub.png"
              alt="Creative Tools Hub with evidence-based tool statuses"
              fallback={
                <div className="grid aspect-[16/9] gap-2 p-6 sm:grid-cols-2">
                  {["Video Editing · READY", "Audio Studio · READY", "VFX & Motion · READY/BETA", "Captions & Voice · BETA", "Footage Intelligence · READY", "Quality & Delivery · READY"].map((s) => (
                    <div key={s} className="pub-glass flex items-center px-3 py-2.5 text-[11px] text-[var(--pub-ink-mid)]">{s}</div>
                  ))}
                </div>
              }
            />
          </Reveal>
        </div>
      </section>

      {/* ── 8. MEDIA LIBRARY ────────────────────────────────────────────────── */}
      <section className="pub-section">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <SectionHead
            eyebrow="Media Library"
            title={<>Your originals, intact and inspectable.</>}
            lede="Uploads keep their source files untouched. Every asset is probed (FFprobe), thumbnailed, waveformed and proxied; derivatives are registered with provenance — what ran, on what, when."
          />
          <Reveal className="mt-8">
            <PubShot
              src="/brand/library.png"
              alt="Media Library with probe data and asset provenance"
              fallback={
                <div className="flex aspect-[16/8] flex-col items-center justify-center gap-2 p-6 text-center">
                  <span className="pub-label">Probe · waveform · thumbnail · proxy</span>
                  <p className="pub-serif text-[19px] text-[var(--pub-silver)]">Source files stay original — exports are new, validated files.</p>
                </div>
              }
            />
          </Reveal>
        </div>
      </section>

      {/* ── 9. CREATIVE INTELLIGENCE ────────────────────────────────────────── */}
      <section className="pub-section">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <SectionHead
            eyebrow="Creative Intelligence"
            title={<>Computed from your real project, not generated for show.</>}
            lede="Shot-coverage maps, source-to-final traceability, timeline change maps and crew execution traces — every number on the Intelligence surface is derived from your database and renders."
          />
        </div>
      </section>

      {/* ── 10. MULTILINGUAL VOICE DIRECTION ───────────────────────────────── */}
      <section className="pub-section">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <SectionHead
            eyebrow="Multilingual voice direction"
            title={<>Speak to the studio — with honest language status.</>}
            lede="Push-to-talk or hands-free capture, an editable transcript you confirm before sending, and spoken replies validated by real audio containers. Language support is stated as it is — never promised where it is not proven."
          />
          <Reveal className="mt-8 grid gap-3 sm:grid-cols-3">
            <div className="pub-card p-5">
              <p className="text-[13px] font-bold text-[var(--pub-ok,#4cc47f)]">English — verified</p>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--pub-ink-mid)]">Validated live against the configured gateway with real transcription evidence.</p>
            </div>
            <div className="pub-card p-5">
              <p className="text-[13px] font-bold text-[var(--pub-gold-soft)]">Tamil — unverified</p>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--pub-ink-mid)]">The provider documents no Tamil support. Attempts are real; the transcript is returned as recognised. Native-speaker validation is required before production reliance.</p>
            </div>
            <div className="pub-card p-5">
              <p className="text-[13px] font-bold text-[var(--pub-gold-soft)]">Tanglish — unverified</p>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--pub-ink-mid)]">Treated as Tamil–English code-switching — its own input style, not relabelled English. Same validation requirement applies.</p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── 11. REAL PRODUCTION WORKFLOW ────────────────────────────────────── */}
      <section className="pub-section">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <SectionHead
            eyebrow="Real production workflow"
            title={<>Durable stages, honest failures, verified output.</>}
            lede="Productions run as durable stage pipelines with approval gates, retries and QA. A render is not “done” because a bar filled — QA probes the actual file. Failed stages look failed; nothing pretends."
          />
          <Reveal className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { t: "Approval gates", b: "Stages that need a human wait for one — start, approve, reject, skip, retry and cancel are all real, tested controls." },
              { t: "Durable jobs", b: "Renders, analyses and generations survive restarts through the existing job system." },
              { t: "FFprobe-verified QA", b: "The QUALITY_ASSURANCE stage inspects the rendered file's real streams, not its own status." },
              { t: "Provenance", b: "Every derivative records what produced it — model, job and source asset." },
            ].map((x) => (
              <div key={x.t} className="pub-card p-5">
                <h3 className="text-[12.5px] font-bold uppercase tracking-[0.12em] text-[var(--pub-gold-soft)]">{x.t}</h3>
                <p className="mt-2 text-[12px] leading-relaxed text-[var(--pub-ink-mid)]">{x.b}</p>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      {/* ── 12. OPEN-SOURCE ACKNOWLEDGMENT ─────────────────────────────────── */}
      <section className="pub-section">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <SectionHead
            eyebrow="Open source"
            title={<>Built on open source — credited properly.</>}
            lede="BEAN FX stands on FFmpeg, Next.js, Prisma, Radix UI and many more projects. The Open Source & Credits Center documents integrated dependencies, adapted code, reference-only projects and license notices — with an SBOM and a license-risk report."
          />
          <Reveal className="mt-6 flex flex-wrap gap-3">
            <Link href="/open-source" className="pub-gold-btn">Open Source & Credits Center</Link>
            <Link href="/legal" className="pub-ghost-btn">Legal Center</Link>
          </Reveal>
        </div>
      </section>

      {/* ── 13. PRIVACY AND USER CONTROL ───────────────────────────────────── */}
      <section className="pub-section">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <SectionHead
            eyebrow="Privacy and user control"
            title={<>Your media stays yours.</>}
            lede="Original recordings are never modified — exports are new files. Processing runs on the configured server stack; private footage is never silently sent to external providers. Voice audio is uploaded only after you activate recording and is not retained beyond transcription. Account data controls, export and deletion are built in."
          />
          <Reveal className="mt-6 flex flex-wrap gap-3">
            <Link href="/privacy" className="pub-ghost-btn">Privacy Policy (draft)</Link>
            <Link href="/legal/ai-processing" className="pub-ghost-btn">AI Processing Policy (draft)</Link>
            <Link href="/legal/voice-data" className="pub-ghost-btn">Voice & Audio Data (draft)</Link>
          </Reveal>
        </div>
      </section>

      {/* ── 14. SIGNUP CTA ──────────────────────────────────────────────────── */}
      <section className="pub-section">
        <div className="mx-auto max-w-4xl px-4 py-20 text-center sm:px-6">
          <Reveal>
            <p className="pub-serif text-[30px] font-bold leading-tight text-white sm:text-[40px]">
              Bring the footage. <span className="italic text-[var(--pub-gold-soft)]">Direct the rest.</span>
            </p>
            <p className="mx-auto mt-4 max-w-xl text-[13.5px] leading-relaxed text-[var(--pub-ink-mid)]">
              Create an account, connect a project, and run your first production — from source file to FFprobe-verified render.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3.5">
              <button onClick={onLogin} className="pub-gold-btn">Create your studio account</button>
              <button onClick={onOpenStudio} className="pub-ghost-btn">Launch Studio</button>
            </div>
            <p className="mt-4 text-[11px] text-[var(--pub-ink-dim)]">
              Account signup accepts the BEAN FX terms and the AI processing policy in their current draft status — final,
              owner-approved policies will be published separately before they bind.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── 15. FOOTER ──────────────────────────────────────────────────────── */}
      <footer className="border-t border-[var(--pub-line)] bg-[#050506]">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-4">
          <div>
            <BeanLogo />
            <p className="mt-3 max-w-xs text-[11.5px] leading-relaxed text-[var(--pub-ink-dim)]">
              BEAN FX — Creative Intelligence Studio. A browser-based professional video workspace. Process your own media.
            </p>
          </div>
          <nav aria-label="Product" className="text-[12px]">
            <p className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--pub-ink-dim)]">Product</p>
            <ul className="space-y-1.5">
              <li><Link href="#product" className="text-[var(--pub-ink-mid)] hover:text-[var(--pub-gold-soft)]">Product</Link></li>
              <li><Link href="#workflow" className="text-[var(--pub-ink-mid)] hover:text-[var(--pub-gold-soft)]">Features</Link></li>
              <li><Link href="/studio/tools" className="text-[var(--pub-ink-mid)] hover:text-[var(--pub-gold-soft)]">Creative Tools</Link></li>
              <li><Link href="/open-source" className="text-[var(--pub-ink-mid)] hover:text-[var(--pub-gold-soft)]">Open Source</Link></li>
              <li><Link href="/help" className="text-[var(--pub-ink-mid)] hover:text-[var(--pub-gold-soft)]">Documentation</Link></li>
            </ul>
          </nav>
          <nav aria-label="Legal" className="text-[12px]">
            <p className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--pub-ink-dim)]">Legal Center (drafts)</p>
            <ul className="space-y-1.5">
              <li><Link href="/terms" className="text-[var(--pub-ink-mid)] hover:text-[var(--pub-gold-soft)]">Terms of Service</Link></li>
              <li><Link href="/privacy" className="text-[var(--pub-ink-mid)] hover:text-[var(--pub-gold-soft)]">Privacy Policy</Link></li>
              <li><Link href="/legal" className="text-[var(--pub-ink-mid)] hover:text-[var(--pub-gold-soft)]">All policies</Link></li>
              <li><Link href="/legal/acceptable-use" className="text-[var(--pub-ink-mid)] hover:text-[var(--pub-gold-soft)]">Acceptable Use</Link></li>
              <li><Link href="/legal/copyright" className="text-[var(--pub-ink-mid)] hover:text-[var(--pub-gold-soft)]">Copyright & IP</Link></li>
            </ul>
          </nav>
          <nav aria-label="Credits" className="text-[12px]">
            <p className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--pub-ink-dim)]">Credits</p>
            <ul className="space-y-1.5">
              <li><Link href="/open-source" className="text-[var(--pub-ink-mid)] hover:text-[var(--pub-gold-soft)]">Open Source & Credits Center</Link></li>
              <li><Link href="/open-source#notices" className="text-[var(--pub-ink-mid)] hover:text-[var(--pub-gold-soft)]">Third-party notices</Link></li>
              <li><Link href="/open-source#sbom" className="text-[var(--pub-ink-mid)] hover:text-[var(--pub-gold-soft)]">SBOM & license risk</Link></li>
            </ul>
          </nav>
        </div>
        <div className="border-t border-[#141416] py-4 text-center text-[11px] text-[#5c5c58]">
          © {new Date().getFullYear()} BEAN FX. Process your own media. Product screenshots are real captures of the studio.
        </div>
      </footer>
    </div>
  );
}
