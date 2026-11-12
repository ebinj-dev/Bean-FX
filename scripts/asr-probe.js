/* Probe the z-ai ASR provider's full response shape on real speech audio. */
const fs = require("fs");
const { execFileSync } = require("child_process");
const ZAI = require("z-ai-web-dev-sdk").default;

async function main() {
  const src = "/tmp/not edited(2).mp3";
  // 40s slice from the middle where speech is expected
  execFileSync("ffmpeg", ["-y", "-ss", "60", "-t", "25", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "/tmp/asr-probe.wav"], { stdio: "ignore" });
  const b64 = fs.readFileSync("/tmp/asr-probe.wav").toString("base64");
  console.log("payload KB:", Math.round(b64.length / 1024));
  const zai = await ZAI.create();
  const res = await zai.audio.asr.create({ file_base64: b64 });
  console.log("RESPONSE TYPE:", typeof res);
  console.log("TOP-LEVEL KEYS:", Object.keys(res ?? {}));
  console.log("FULL RESPONSE:", JSON.stringify(res, null, 2).slice(0, 3000));
}
main().catch((e) => { console.error("PROBE FAILED:", e.message); process.exit(1); });
