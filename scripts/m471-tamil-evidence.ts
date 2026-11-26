/** M47.1 — real Tamil-script audio through the transcribe route. */
import fs from "node:fs";

const BASE = "http://localhost:3118";
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
await api("POST", "/api/auth/register", { email: `m471-ta-${Date.now().toString(36)}@beanfx.test`, password: "Vta12345abc", name: "TA test" });
const fd = new FormData();
fd.append("audio", new Blob([fs.readFileSync("/tmp/vtest-ta2.wav")], { type: "audio/wav" }), "ta.wav");
fd.append("language", "ta");
const res = await api("POST", "/api/my-ai/voice/transcribe", fd);
const d = await res.json();
console.log("status", res.status);
console.log("transcript:", JSON.stringify(d.transcript));
console.log("scriptMix:", d.scriptMix?.mix, "tamil=", d.scriptMix?.tamilChars, "latin=", d.scriptMix?.latinChars);
console.log("requestedLanguage:", d.requestedLanguage?.status);
