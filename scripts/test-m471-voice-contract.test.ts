/**
 * M47.1 §A1/§A2 — the voice format contract unit tests.
 *
 * These are the regression tests for the reported defect: "the speech endpoint
 * can wrap raw PCM output into WAV; the chat playback code may label the
 * returned audio as audio/mpeg". The contract is now: bytes are verified by
 * magic number, labels come FROM the bytes, and raw PCM gets a real WAV
 * header — never a MIME string rename.
 *
 * Run: bun test scripts/test-m471-voice-contract.test.ts
 */
import { describe, test, expect } from "bun:test";
import { detectAudioFormat, wrapPcmAsWav, validateAudioBase64 } from "../src/lib/audio-format";
import { VOICE_LANGUAGES, detectScriptMix, voiceLanguageById } from "../src/lib/voice-language";

const bytes = (...xs: number[]) => new Uint8Array(xs);
const strBytes = (s: string) => new Uint8Array(Buffer.from(s, "binary"));

describe("detectAudioFormat — magic numbers", () => {
  test("real WAV container (RIFF....WAVE) → audio/wav, headered", () => {
    const b = new Uint8Array(16);
    b.set(strBytes("RIFF"), 0);
    b.set(strBytes("WAVE"), 8);
    const info = detectAudioFormat(b);
    expect(info.format).toBe("wav");
    expect(info.mime).toBe("audio/wav");
    expect(info.headered).toBe(true);
  });

  test("MP3 with ID3 tag → audio/mpeg", () => {
    const info = detectAudioFormat(strBytes("ID3\x04\x00"));
    expect(info.format).toBe("mp3");
    expect(info.mime).toBe("audio/mpeg");
  });

  test("MP3 frame sync (0xFFFB, layer=01) → audio/mpeg", () => {
    const info = detectAudioFormat(bytes(0xff, 0xfb, 0x90, 0x00));
    expect(info.format).toBe("mp3");
    expect(info.mime).toBe("audio/mpeg");
  });

  test("AAC ADTS sync (0xFFF1, layer=00) → audio/aac — not mislabelled mp3", () => {
    const info = detectAudioFormat(bytes(0xff, 0xf1, 0x50, 0x80));
    expect(info.format).toBe("aac");
    expect(info.mime).toBe("audio/aac");
  });

  test("OggS → audio/ogg", () => {
    expect(detectAudioFormat(strBytes("OggS\x02")).format).toBe("ogg");
  });

  test("fLaC → audio/flac", () => {
    expect(detectAudioFormat(strBytes("fLaC\x00")).format).toBe("flac");
  });

  test("EBML/WebM → audio/webm", () => {
    expect(detectAudioFormat(bytes(0x1a, 0x45, 0xdf, 0xa3)).format).toBe("webm");
  });

  test("headerless bytes → raw-pcm, unheadered (needs a real wrap)", () => {
    const info = detectAudioFormat(bytes(0x01, 0x02, 0x03, 0x04, 0x05, 0x06));
    expect(info.format).toBe("raw-pcm");
    expect(info.mime).toBeNull();
    expect(info.headered).toBe(false);
  });

  test("too-short buffer → unknown", () => {
    expect(detectAudioFormat(bytes(0x52, 0x49)).format).toBe("unknown");
  });
});

describe("wrapPcmAsWav — a real container, not a label", () => {
  test("wrapped output parses back as WAV with the documented rate/bits", () => {
    const pcm = new Uint8Array(3200); // 0.1 s @16 kHz mono 16-bit
    pcm[0] = 0x21; // non-trivial content
    const wav = wrapPcmAsWav(pcm, 16000, 1, 16);
    const s = (i: number, n: number) => Buffer.from(wav.slice(i, i + n)).toString("binary");
    expect(s(0, 4)).toBe("RIFF");
    expect(s(8, 4)).toBe("WAVE");
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16000); // sample rate
    expect(new DataView(wav.buffer).getUint16(34, true)).toBe(16); // bits
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(3200); // data size
    expect(wav.length).toBe(44 + 3200);
    // The wrapped bytes are again detected as a real WAV.
    const back = detectAudioFormat(wav);
    expect(back.format).toBe("wav");
    expect(back.headered).toBe(true);
  });
});

describe("validateAudioBase64 — bytes win over labels (the reported defect)", () => {
  test("WAV bytes wrongly labelled audio/mpeg are corrected to audio/wav", () => {
    const b = new Uint8Array(64);
    b.set(strBytes("RIFF"), 0);
    b.set(strBytes("WAVE"), 8);
    const b64 = Buffer.from(b).toString("base64");
    const v = validateAudioBase64(b64, "audio/mpeg");
    expect(v.ok).toBe(true);
    expect(v.mime).toBe("audio/wav");
    expect(v.correctedFrom).toBe("audio/mpeg");
    expect(v.detail).toContain("bytes are wav");
  });

  test("unknown bytes are refused for playback with a visible detail", () => {
    const b64 = Buffer.from(bytes(0xde, 0xad, 0xbe, 0xef, 0x00, 0x11)).toString("base64");
    const v = validateAudioBase64(b64, "audio/mpeg");
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("unrecognised container");
    expect(v.detail).toContain("de ad be ef"); // head bytes are disclosed
  });

  test("MP3 bytes keep the mp3 label", () => {
    const b64 = Buffer.from(strBytes("ID3\x04\x00\x00")).toString("base64");
    const v = validateAudioBase64(b64, "audio/mpeg");
    expect(v.ok).toBe(true);
    expect(v.mime).toBe("audio/mpeg");
    expect(v.correctedFrom).toBeUndefined();
  });

  test("garbage base64 is refused", () => {
    const v = validateAudioBase64("!!!!", "audio/wav");
    expect(v.ok).toBe(false);
  });
});

describe("voice language register — truthful by construction", () => {
  test("English is the only verified language", () => {
    const verified = VOICE_LANGUAGES.filter((l) => l.status === "verified").map((l) => l.id);
    expect(verified).toEqual(["auto", "en"]);
  });

  test("Tamil and Tanglish are flagged unverified with native-speaker caveat", () => {
    for (const id of ["ta", "tanglish"]) {
      const l = voiceLanguageById(id);
      expect(l).toBeDefined();
      expect(l!.status).toBe("unverified");
      expect(l!.note).toMatch(/native-speaker validation/i);
    }
  });

  test("Tanglish is described as code-switching, not relabelled English", () => {
    const l = voiceLanguageById("tanglish")!;
    expect(l.note).toMatch(/code-switching/i);
    expect(l.label).toMatch(/Tamil–English/);
  });

  test("auto sends no language hint", () => {
    const l = voiceLanguageById("auto")!;
    expect(l.note).toMatch(/No hint sent/);
  });
});

describe("detectScriptMix — informational heuristic only", () => {
  test("mixed Tamil+Latin script is detected as code-switching-shaped", () => {
    const m = detectScriptMix("வணக்கம் start the edit please");
    expect(m.mix).toBe("mixed");
    expect(m.tamilChars).toBeGreaterThan(0);
    expect(m.latinChars).toBeGreaterThan(0);
    expect(m.disclosure).toMatch(/Informational only/);
  });

  test("pure Latin stays latin", () => {
    expect(detectScriptMix("cut the first three seconds").mix).toBe("latin");
  });

  test("empty text is empty", () => {
    expect(detectScriptMix("").mix).toBe("empty");
  });
});
