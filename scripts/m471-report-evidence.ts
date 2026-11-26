/**
 * M47.1 report evidence — prints the ACTUAL transcription results per language
 * and the speak-route format fields. Read-only; server on :3118.
 */
import fs from "node:fs";

const BASE = "http://localhost:3118";
const STAMP = Date.now().toString(36);
let cookie = "";

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return res;
}

const r = await api("POST", "/api/auth/register", {
  email: `m471-report-${STAMP}@beanfx.test`,
  password: `Vtest${STAMP}9a`,
  name: "M47.1 Report",
});

for (const [label, file, lang] of [
  ["ENGLISH", "/tmp/vtest-en.wav", "en"],
  ["TANGLISH (code-switch)", "/tmp/vtest-tanglish.wav", "tanglish"],
  ["TAMIL", "/tmp/vtest-ta.wav", "ta"],
] as Array<[string, string, string]>) {
  const fd = new FormData();
  fd.append("audio", new Blob([fs.readFileSync(file)], { type: "audio/wav" }), "voice.wav");
  fd.append("language", lang);
  const res = await api("POST", "/api/my-ai/voice/transcribe", fd);
  const d = await res.json();
  console.log(`\n=== ${label} (requested: ${lang}) ===`);
  console.log("transcript:", JSON.stringify(d.transcript));
  console.log("provider language:", d.language ?? "(none reported)");
  console.log("scriptMix:", d.scriptMix?.mix, `tamil=${d.scriptMix?.tamilChars} latin=${d.scriptMix?.latinChars}`);
}

const sres = await api("POST", "/api/my-ai/voice/speak", { text: "Approved. Rendering version two now." });
const sd = await sres.json();
console.log("\n=== SPEAK ===");
console.log("mimeType:", sd.mimeType, "| format:", sd.format, "| wrappedFrom:", sd.wrappedFrom, "| bytes:", sd.bytes, "| providerShape:", sd.providerShape);
const head = Buffer.from(sd.audioBase64, "base64").subarray(0, 12);
console.log("head bytes:", head.toString("binary").replace(/[^\x20-\x7e]/g, "."), "|", Array.from(head).map((x) => x.toString(16)).join(" "));
