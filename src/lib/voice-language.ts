/**
 * M47.1 §A2 — truthful voice language status.
 *
 * The configured gateway ASR/TTS documents NO language-selection parameter
 * (the ASR call accepts file_base64 only). So the honest contract is:
 *  - English: verified live against the configured gateway (M47 evidence);
 *  - Tamil / Tanglish: the provider is NOT documented for them. Transcription
 *    is ATTEMPTED and the provider-reported language is returned as-is, but
 *    the status stays "unverified" until a native speaker validates output;
 *  - Tanglish is Tamil–English CODE-SWITCHING — a distinct input style, not
 *    English with a different label.
 * No universal multilingual support is promised anywhere in the UI.
 */

export type VoiceLanguageStatus = "verified" | "unverified" | "experimental";

export interface VoiceLanguage {
  id: string;
  label: string;
  status: VoiceLanguageStatus;
  /** One honest line shown in the picker and surfaced in API responses. */
  note: string;
}

export const VOICE_LANGUAGES: VoiceLanguage[] = [
  {
    id: "auto",
    label: "Auto",
    status: "verified",
    note: "No hint sent; the provider-reported language is returned as-is.",
  },
  {
    id: "en",
    label: "English",
    status: "verified",
    note: "Verified live against the configured gateway (real transcription evidence on file).",
  },
  {
    id: "ta",
    label: "தமிழ் (Tamil)",
    status: "unverified",
    note: "The configured provider documents no Tamil support. The attempt is real and the transcript is returned as recognised — accuracy needs native-speaker validation before production use.",
  },
  {
    id: "tanglish",
    label: "Tanglish (Tamil–English mix)",
    status: "unverified",
    note: "Tamil–English code-switching, treated as its own input style — not English with another label. Accuracy needs native-speaker validation before production use.",
  },
];

export function voiceLanguageById(id: string | null | undefined): VoiceLanguage | undefined {
  if (!id) return undefined;
  return VOICE_LANGUAGES.find((l) => l.id === id);
}

export interface ScriptMix {
  tamilChars: number;
  latinChars: number;
  /** Heuristic, NON-authoritative: "tamil" | "latin" | "mixed" | "empty". */
  mix: "tamil" | "latin" | "mixed" | "empty";
  disclosure: string;
}

/** Informational script-mix heuristic — never presented as a language verdict. */
export function detectScriptMix(text: string): ScriptMix {
  if (!text || !text.trim()) return { tamilChars: 0, latinChars: 0, mix: "empty", disclosure: "No transcript to inspect." };
  let tamil = 0;
  let latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x0b80 && c <= 0x0bff) tamil++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
  }
  const mix = tamil > 0 && latin > 0 ? "mixed" : tamil > 0 ? "tamil" : "latin";
  return {
    tamilChars: tamil,
    latinChars: latin,
    mix,
    disclosure:
      mix === "mixed"
        ? `Script mix heuristic: Tamil (${tamil}) + Latin (${latin}) characters — consistent with Tamil–English code-switching. Informational only; the provider transcript is authoritative.`
        : mix === "tamil"
          ? `Script mix heuristic: Tamil script detected (${tamil} characters). Informational only.`
          : `Script mix heuristic: Latin script (${latin} characters). Informational only.`,
  };
}
