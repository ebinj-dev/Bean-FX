const fs = require("fs");
const ZAI = require("z-ai-web-dev-sdk").default;
(async () => {
  const zai = await ZAI.create();
  try {
    const res = await zai.audio.asr.create({ file_base64: fs.readFileSync("/tmp/tst/ta1.wav").toString("base64") });
    console.log("QUOTA-OK text:", JSON.stringify((res?.text ?? "").slice(0, 120)));
  } catch (e) {
    console.log("QUOTA-LIMITED:", String(e.message).slice(0, 90));
  }
})();
