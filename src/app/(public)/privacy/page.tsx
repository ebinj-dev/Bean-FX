import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — BEAN FX",
  description: "What BEAN FX collects, what runs locally, what the server processes, what external AI providers receive, and how you can export or delete your data.",
  alternates: { canonical: "/privacy" },
};

const EFFECTIVE = "2026-11-15";

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d4a017]">Privacy</p>
      <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">Privacy Policy</h1>
      <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-[13.5px] leading-relaxed text-[#c9c9c2]">
        <strong className="text-red-400">REQUIRES LEGAL REVIEW:</strong> this document describes
        verified application behavior and is not legal advice. It must be reviewed and approved by a
        qualified legal professional before public commercial launch, together with the owner fields
        marked <em>[OWNER TO CONFIRM]</em> in the launch checklist.
      </p>
      <p className="mt-3 text-[12.5px] text-[#8f8f8a]">Effective date: {EFFECTIVE}. This policy describes the implementation as it exists; it is a living document and any change will be dated here.</p>

      <h2 className="mt-9 text-xl font-bold text-white">1. Account data</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Registration collects your email address, an optional display name, and a password. The password is stored
        only as a scrypt hash with a per-user salt — never in plain text, never exportable. Authentication sessions
        (random tokens, hashed fingerprints for diagnostics) and audit records of security-relevant actions (logins,
        password changes, deletions) are also kept.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">2. Project and editing data</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Projects, sequences and every timeline edit are stored as versioned JSON on the server, tied to your
        account: project metadata, timeline versions, captions, effects settings, automation keyframes and editing
        history. This is what makes reload-safe autosave and undo/redo work.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">3. Media</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Uploaded videos, images and audio files are stored under per-user paths with randomized identifiers.
        Background workers probe them (duration, streams, codecs) to power placement and export. Files you generate
        (AI assets, rendered exports) are stored the same way and counted against your storage usage.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">4. AI processing — what runs where</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Three layers are involved, and they are different:
      </p>
      <ul className="mt-3 space-y-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        <li><strong className="text-white">Local deterministic processing</strong> — timeline math, playback, effect application, mixer scheduling and the export encoder run on the BEAN FX server itself. No third party is involved.</li>
        <li><strong className="text-white">Server-side processing</strong> — media probing, tracking and indexing also run server-side on your own files.</li>
        <li><strong className="text-white">External AI provider processing</strong> — only for the AI engines, and only when a provider is configured. Text-only requests (scripts, plans, captions assistance) send prompt text. Specific visual features send small subject crops (a few frames) for provider-assisted labeling. Generative features (image/video/TTS/ASR) send the prompt or audio you submit. Every provider call is consent-gated, metered and recorded; if no provider is configured, these features are unavailable rather than simulated.</li>
      </ul>
      <p className="mt-3 text-[14px] leading-relaxed text-[#b8b8b0]">
        Your media is not sent to external providers as a bulk background job; provider submissions are explicit,
        per-feature, and visible in the usage metering. Provider retention is governed by that provider&apos;s terms —
        BEAN FX cannot delete data a provider has already processed under its own policy.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">5. Cookies and tracking</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        One essential cookie (httpOnly, Secure, SameSite=None;Partitioned) carries your session token. There are no
        analytics, advertising or third-party tracking cookies, and no fingerprinting. The Cookie Policy has details.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">6. Logs and diagnostics</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        The server keeps operational logs (job status, provider failures) and audit events (security actions).
        Error pages shown to users carry stable codes and request IDs — stack traces and infrastructure details are
        not exposed publicly.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">7. Your rights</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        You can access and correct your profile in Account settings, export a machine-readable copy of your account
        data (profile, projects, media metadata, job and AI-usage history) at any time, and delete your account —
        deletion re-authenticates you, revokes all sessions immediately, and marks the account deleted at once;
        physical cleanup of stored files runs on a deferred schedule with reference checks. Contact the support
        address on the Contact page for anything else.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">8. Legal review status</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        This policy is written from the actual implementation, but it is not legal advice and has not been reviewed
        by a qualified legal professional. Treat it as a draft for review — see the Legal Review Checklist for the
        open items (data-protection regimes, jurisdiction, grievance-officer requirements) that the product owner
        must confirm.
      </p>
    
      <p className="mt-8 text-[12.5px] leading-relaxed text-[#8f8f8a]">
        Part of the <a href="/legal" className="text-[#d4a017] hover:underline">Legal &amp; Trust Center</a> — see also the <a href="/legal/ai-processing" className="text-[#d4a017] hover:underline">AI Processing &amp; Data Usage Policy</a> and the <a href="/legal/voice-data" className="text-[#d4a017] hover:underline">Voice &amp; Audio Data Policy</a>.
      </p>
    </div>
  );
}
