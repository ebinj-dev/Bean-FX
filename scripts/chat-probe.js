/* Probe the chat-completion path used by /api/riishe to find the 502 cause. */
const ZAI = require("z-ai-web-dev-sdk").default;

async function main() {
  const zai = await ZAI.create();
  // 1) exact shape used by the riishe route
  try {
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: "You are RIISHE, the content-aware editing coordinator inside BEAN FX. Classify candidate ranges. Respond with ONLY JSON." },
        { role: "user", content: 'Recording: "test" — total duration 60.00s.\n\nTRANSCRIPT:\n[0.00s - 5.00s] hello world\n\nCANDIDATE RANGES:\nid=sil-1 start=55.00s end=59.00s dur=4.00s rms=0.0010 snr=1.20' },
      ],
      thinking: { type: "disabled" },
    });
    console.log("SHAPE-1 OK, keys:", Object.keys(completion ?? {}));
    console.log("content:", String(completion?.choices?.[0]?.message?.content ?? "").slice(0, 300));
  } catch (e) {
    console.log("SHAPE-1 FAILED:", String(e.message).slice(0, 300));
  }
  // 2) with role "system" instead of "assistant"
  try {
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "system", content: "You are RIISHE. Respond with ONLY JSON." },
        { role: "user", content: 'Classify id=sil-1 (silence 4s, no transcript) as REMOVE/KEEP/REVIEW. Reply {"suggestions":[{"id":"sil-1","action":"REMOVE","confidence":0.9,"reason":"...","riskNotes":null}],"summary":"..."}' },
      ],
      thinking: { type: "disabled" },
    });
    console.log("SHAPE-2 OK:", String(completion?.choices?.[0]?.message?.content ?? "").slice(0, 300));
  } catch (e) {
    console.log("SHAPE-2 FAILED:", String(e.message).slice(0, 300));
  }
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
