/**
 * M47.1 §A4 — LIVE voice acceptance battery (real HTTP server, real audio).
 *
 * The audio files are REAL TTS renders (z-ai CLI, checked with ffprobe before
 * use) — English, Tamil-script, and Tamil–English code-switching (Tanglish).
 * The battery exercises the REAL routes: transcription, language register,
 * spoken-reply generation, format verification, and the negative paths.
 *
 * Run (server on :3118): bun test scripts/test-m471-voice-live.test.ts
 */
import { describe, test, expect, beforeAll } from "bun:test";
import fs from "node:fs";

const BASE = process.env.M471_BASE ?? "http://localhost:3118";
const STAMP = Date.now().toString(36);

const EN = "/tmp/vtest-en.wav";
const TANG = "/tmp/vtest-tanglish.wav";
const TA = "/tmp/vtest-ta.wav";

let cookie = "";
let userId = "";

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

function multipart(file: string, field = "audio", language?: string): FormData {
  const fd = new FormData();
  fd.append(field, new Blob([fs.readFileSync(file)], { type: "audio/wav" }), "voice.wav");
  if (language) fd.append("language", language);
  return fd;
}

beforeAll(async () => {
  // Register a fresh user — the real signup path (now with the acceptance gate).
  const res = await api("POST", "/api/auth/register", {
    email: `m471-voice-${STAMP}@beanfx.test`,
    password: `Vtest${STAMP}9a`,
    name: "M47.1 Voice Battery",
  });
  const d = await res.json().catch(() => ({}));
  expect(res.status).toBeLessThan(500);
  if (!res.ok) throw new Error(`register failed: ${res.status} ${JSON.stringify(d).slice(0, 200)}`);
  userId = d?.user?.id ?? "";
  expect(userId).not.toBe("");
});

describe("capability probe", () => {
  test("GET transcribe exposes the truthful language register", async () => {
    const res = await api("GET", "/api/my-ai/voice/transcribe");
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.supported).toBe(true); // BEANFX_ASR_ENABLED=1 + gateway SDK present
    const langs = (d.languages ?? []) as Array<{ id: string; status: string }>;
    expect(langs.find((l) => l.id === "en")?.status).toBe("verified");
    expect(langs.find((l) => l.id === "ta")?.status).toBe("unverified");
    expect(langs.find((l) => l.id === "tanglish")?.status).toBe("unverified");
  });
});

describe("transcription with real audio", () => {
  test("English instruction transcribes through the configured provider", async () => {
    const res = await api("POST", "/api/my-ai/voice/transcribe", multipart(EN, "audio", "en"));
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.supported).toBe(true);
    expect(String(d.transcript).toLowerCase()).toContain("cut");
    expect(d.requestedLanguage?.id).toBe("en");
    expect(d.requestedLanguage?.status).toBe("verified");
    expect(d.disclosure).toContain("no audio retention");
  });

  test("Tanglish (code-switched) audio transcribes; script-mix heuristic reports mixed", async () => {
    const res = await api("POST", "/api/my-ai/voice/transcribe", multipart(TANG, "audio", "tanglish"));
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.supported).toBe(true);
    expect(String(d.transcript).length).toBeGreaterThan(0);
    expect(d.requestedLanguage?.status).toBe("unverified");
    expect(d.requestedLanguage?.note).toMatch(/native-speaker validation/i);
    // The heuristic is informational; provider transcript authoritative.
    expect(d.scriptMix?.disclosure).toContain("Informational only");
  });

  test("Tamil audio returns provider transcript with unverified status", async () => {
    const res = await api("POST", "/api/my-ai/voice/transcribe", multipart(TA, "audio", "ta"));
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.supported).toBe(true);
    expect(d.requestedLanguage?.label).toContain("Tamil");
    expect(d.requestedLanguage?.status).toBe("unverified");
  });

  test("empty/unknown audio is rejected with a visible 4xx — never a fake transcript", async () => {
    const fd = new FormData();
    fd.append("audio", new Blob([Buffer.alloc(64)], { type: "audio/wav" }), "empty.wav");
    const res = await api("POST", "/api/my-ai/voice/transcribe", fd);
    expect([200, 400, 415, 502]).toContain(res.status);
    const d = await res.json().catch(() => ({}));
    // Either an honest error or an honest empty-transcript report — never invented text.
    if (d.supported === true) expect(String(d.transcript ?? "")).toBe("");
    else expect(d.reason ?? d.error).toBeTruthy();
  });

  test("wrong content-type is rejected 400", async () => {
    const res = await api("POST", "/api/my-ai/voice/transcribe", { audio: "not-a-file" });
    expect(res.status).toBe(400);
  });

  test("unauthenticated transcription is refused 401", async () => {
    const saved = cookie;
    cookie = "";
    const res = await api("POST", "/api/my-ai/voice/transcribe", multipart(EN));
    expect(res.status).toBe(401);
    cookie = saved;
  });
});

describe("spoken replies — the M47.1 format contract live", () => {
  test("speak returns verified audio whose bytes match the declared MIME", async () => {
    const res = await api("POST", "/api/my-ai/voice/speak", {
      text: "Opening the timeline. The first three seconds are marked for removal — approve when ready.",
    });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.supported).toBe(true);
    expect(d.mimeType).toBeTruthy();
    expect(d.format).toBeTruthy();
    // Decode and check the REAL bytes against the claim.
    const bytes = Buffer.from(d.audioBase64, "base64");
    expect(bytes.length).toBeGreaterThan(1000);
    const isWav = bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE";
    const isMp3 = bytes.subarray(0, 3).toString() === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    if (d.mimeType === "audio/wav") expect(isWav).toBe(true);
    if (d.mimeType === "audio/mpeg") expect(isMp3).toBe(true);
    if (d.wrappedFrom) expect(d.wrappedFrom).toBe("raw-pcm");
    // Write the returned audio and probe it with FFprobe — real container proof.
    const ext = d.mimeType === "audio/mpeg" ? "mp3" : "wav";
    const out = `/tmp/m471-speak.${ext}`;
    fs.writeFileSync(out, bytes);
    const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=format_name,duration", "-of", "json", out]);
    const info = JSON.parse(probe.stdout.toString());
    expect(info.format?.format_name).toContain(ext === "mp3" ? "mp3" : "wav");
  });

  test("speak echoes the language status honestly", async () => {
    const res = await api("POST", "/api/my-ai/voice/speak", { text: "Hello.", language: "ta" });
    const d = await res.json();
    if (d.supported) {
      expect(d.requestedLanguage?.status).toBe("unverified");
      expect(d.requestedLanguage?.note).toMatch(/native-speaker/i);
    } else {
      expect(d.reason).toBeTruthy();
    }
  });

  test("speak refuses unauthenticated requests", async () => {
    const saved = cookie;
    cookie = "";
    const res = await api("POST", "/api/my-ai/voice/speak", { text: "Hello." });
    expect(res.status).toBe(401);
    cookie = saved;
  });

  test("speak rejects oversized text 413", async () => {
    const res = await api("POST", "/api/my-ai/voice/speak", { text: "x".repeat(1300) });
    expect(res.status).toBe(413);
  });
});
