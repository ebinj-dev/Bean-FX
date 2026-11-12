/* Probe several 25s slices of the user's recording to find recognized speech. */
const fs = require("fs");
const { execFileSync } = require("child_process");
const ZAI = require("z-ai-web-dev-sdk").default;

async function probe(zai, start) {
  execFileSync("ffmpeg", ["-y", "-ss", String(start), "-t", "25", "-i", "/tmp/not edited(2).mp3", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", `/tmp/probe-${start}.wav`], { stdio: "ignore" });
  const b64 = fs.readFileSync(`/tmp/probe-${start}.wav`).toString("base64");
  try {
    const res = await zai.audio.asr.create({ file_base64: b64 });
    const text = (res?.text ?? "").trim();
    console.log(`@${start}s: ${text ? "TEXT: " + text.slice(0, 120) : "(empty)"} | keys: ${Object.keys(res ?? {}).join(",")}`);
  } catch (e) {
    console.log(`@${start}s: ERROR ${String(e.message).slice(0, 140)}`);
  }
}

async function main() {
  const zai = await ZAI.create();
  for (const s of [10, 200, 700, 1300, 1900, 2300]) await probe(zai, s);
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
