import type { Metadata } from "next";
import { LegalDraftBanner } from "../draft-note";

export const metadata: Metadata = {
  title: "Voice & Audio Data Policy (draft) — BEAN FX",
  description: "Microphone activation, the transcription path, spoken replies, the verified/unverified language register, and voice-audio retention.",
  alternates: { canonical: "/legal/voice-data" },
};

const UPDATED = "2026-11-26";

export default function VoiceDataPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d4a017]">Legal (draft)</p>
      <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">Voice &amp; Audio Data Policy</h1>
      <LegalDraftBanner document="policy draft" updated={UPDATED} />

      <h2 className="mt-9 text-xl font-bold text-white">1. Recording starts only when you start it</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        The microphone is activated only after you explicitly click Speak or Hands-free. There is no always-on
        listening, no wake-word capture, and no background recording. Push-to-talk stops when you press Stop;
        hands-free continues only while the mode is on and stops with one click. A clear recording indicator (red dot
        + level bars) is visible the entire time.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">2. The transcription path</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Recorded audio is uploaded to the BEAN FX server over HTTPS, validated (type and size limits), and sent to the
        configured speech-to-text provider for that single request. The transcript and provider-reported language are
        returned to you; <strong className="text-white">the audio buffer is not retained beyond the transcription
        request</strong> — no voice recordings are stored as library media, and none are attached to your projects.
        If the configured provider is unavailable, the UI says so and offers the editable text composer instead —
        nothing is fabricated.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">3. Browser-only fallback, disclosed</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        When the server transcription capability is not ready but your browser exposes a Web Speech engine, the UI may
        offer it with an explicit disclosure that transcription happens locally in the browser and audio never leaves
        the device. Which engine ran is shown on the transcript panel.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">4. Language status — no false promises</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        English transcription is verified live against the configured gateway. Tamil and Tanglish are{" "}
        <strong className="text-white">unverified</strong>: the configured provider documents no language parameter, so
        attempts return the transcript exactly as recognised, and the interface labels these languages as needing
        native-speaker validation before production reliance. Tanglish is treated as Tamil–English code-switching — its
        own input style, not relabelled English. A script-mix heuristic (Tamil/Latin characters) is shown as
        informational only; the provider transcript remains authoritative.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">5. You control the transcript</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        The recognised transcript is always shown in an editable field with the original preserved alongside. You can
        correct it, cancel it, or explicitly send it — a voice instruction enters the same plan-and-approval flow as a
        typed one, and nothing consequential executes from speech detection alone.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">6. Spoken replies (TTS)</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        When you press the speak control on a RIISHE reply, the reply text (trimmed to the synthesis limit) is sent to
        the configured text-to-speech provider; the returned audio is verified by real container headers before
        playback and is not stored. If the format is unsupported, playback is refused with a visible message — the text
        transcript remains authoritative.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">7. Retention and deletion</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Voice audio: not retained beyond the transcription request (see §2). Transcripts: stored as part of your
        conversation history — you can delete the message or the conversation.{" "}
        <em>[OWNER TO CONFIRM: provider-side processing/retention terms for ASR/TTS requests, and log retention periods.]</em>
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">8. Contact</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        <em>[OWNER TO CONFIRM: privacy/grievance contact email and officer details.]</em>
      </p>
    </div>
  );
}
