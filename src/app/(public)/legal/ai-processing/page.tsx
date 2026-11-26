import type { Metadata } from "next";
import { LegalDraftBanner } from "../draft-note";

export const metadata: Metadata = {
  title: "AI Processing & Data Usage Policy (draft) — BEAN FX",
  description: "How AI processing works in BEAN FX: the configured gateway, per-stage disclosure, provenance, approval gates, and what is never claimed.",
  alternates: { canonical: "/legal/ai-processing" },
};

const UPDATED = "2026-11-26";

export default function AiProcessingPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d4a017]">Legal (draft)</p>
      <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">AI Processing &amp; Data Usage Policy</h1>
      <LegalDraftBanner document="policy draft" updated={UPDATED} />

      <h2 className="mt-9 text-xl font-bold text-white">1. One gateway, disclosed per step</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        All AI-assisted features run through a single configured provider gateway. The provider and model used for a
        response are disclosed with that response (chat metadata, stage provenance, the model registry at Settings →
        models). There is no silent provider switch: if the configured provider fails, you get a typed error — never an
        unannounced fallback to a different provider.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">2. What the provider receives</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        For chat and planning: your conversation text, the current production/timeline context required to answer, and
        system instructions. For transcription: the audio you explicitly record or select, converted server-side and
        sent as encoded audio. For speech output: the text to be spoken. For image generation (LAXII): your validated
        generation parameters and reference assets you explicitly attach from your own library. BEAN FX does not send
        your raw private footage to any external provider for general analysis; on-server media inspection uses FFprobe
        and FFmpeg locally.
      </p>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Provider-side retention and training practices are governed by the provider&apos;s own terms — BEAN FX cannot
        truthfully warrant them. We do not use your content to train our own models.{" "}
        <em>[OWNER TO CONFIRM: exact provider agreement, data-processing addendum, and any regional processing restrictions.]</em>
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">3. Deterministic automation vs AI — honest labels</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Stages that run deterministic code (FFmpeg assembly, FFprobe QA, silence detection planning, relink checks) are
        labeled deterministic automation — they involve no model. Stages where a model contributes are labeled with the
        provider and model. A configured environment variable alone is never treated as proof of an AI capability: the
        registry marks a capability ready only after a real call succeeds.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">4. Approval gates and provenance</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Consequential actions (timeline changes, asset binding, renders, exports) pass explicit approval gates — an AI
        proposal is a proposal until you approve it. Generated assets and derivatives carry provenance records (what
        produced them, on which source). Voice instructions follow the same plan-and-approve flow as typed ones; speech
        detection alone never executes a destructive edit.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">5. What we never claim</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        No fabricated agent activity; no &ldquo;AI verified&rdquo; claims where only deterministic code ran; no
        universal-language promises (see the Voice policy for the verified/unverified register); no invented
        testimonials or benchmark numbers in marketing.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">6. Data usage for improvement</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        BEAN FX does not sell your data and does not use your content for model training. Operational logs exist for
        reliability and security auditing; retention periods are not yet fixed.{" "}
        <em>[OWNER TO CONFIRM: log retention periods, data residency and the applicable jurisdiction.]</em>
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">7. Contact</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Questions about AI processing: <em>[OWNER TO CONFIRM: legal contact email]</em>. India-specific grievances: see
        the Copyright &amp; IP policy for the grievance-officer placeholder pending appointment.
      </p>
    </div>
  );
}
