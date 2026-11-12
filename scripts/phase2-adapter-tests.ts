/**
 * Phase 5b — ADAPTER-LEVEL tests: the REAL application adapters
 * (src/lib/asr-providers.ts transcribeChunkViaProvider and
 * src/lib/riishe-inference.ts runRiisheInference) against the LIVE sidecars
 * (ports 9300/9301, started modelless by scripts/phase2-sidecar-tests.py's
 * sibling setup here).
 *
 * Expectation: the adapters surface the sidecars' actionable 503s verbatim
 * (endpoint named, no retry-into-hosted, isProviderUnavailable correct).
 * This is contract testing — NOT local inference (no models installed here).
 */
import { transcribeChunkViaProvider, resolveAsrProvider } from "../src/lib/asr-providers";
import { runRiisheInference, resolveSemanticProvider, isProviderUnavailable } from "../src/lib/riishe-inference";

const ASR = "http://127.0.0.1:9300/v1/audio/transcriptions";
const SEM = "http://127.0.0.1:9301/v1/chat/completions";
let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? " — " + detail.slice(0, 160) : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail.slice(0, 160) : ""}`); }
}

async function main() {
  process.env.BEANFX_ASR_PROVIDER = "local-http";
  process.env.BEANFX_ASR_ENDPOINT = ASR;
  process.env.BEANFX_ASR_MODEL = "faster-whisper-large-v3";
  process.env.BEANFX_SEMANTIC_PROVIDER = "local-http";
  process.env.BEANFX_SEMANTIC_ENDPOINT = SEM;
  process.env.BEANFX_SEMANTIC_MODEL = "qwen2.5-7b-instruct-q4_k_m";

  const asrCfg = resolveAsrProvider();
  check("adapter resolves sidecar endpoint", asrCfg.id === "local-http" && asrCfg.endpoint === ASR, asrCfg.reason);
  const semCfg = resolveSemanticProvider();
  check("semantic adapter resolves sidecar endpoint", semCfg.id === "local-http" && semCfg.endpoint === SEM, semCfg.reason);

  // Real 16 kHz mono WAV chunk (0.5 s of silence, correct header) — real request shape.
  const sr = 16000, n = sr / 2;
  const data = Buffer.alloc(n * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  const wav = Buffer.concat([header, data]);

  let asrErr: unknown = null;
  const t0 = performance.now();
  try {
    await transcribeChunkViaProvider(asrCfg, wav);
  } catch (e) { asrErr = e; }
  const asrMsg = asrErr instanceof Error ? asrErr.message : String(asrErr);
  check("real ASR adapter surfaces sidecar 503 verbatim", asrErr !== null && asrMsg.includes("local ASR endpoint answered 503"), `${Math.round(performance.now() - t0)}ms: ${asrMsg}`);
  check("sidecar 503 body is actionable (never-download rule reaches the app log)", /never downloads|model/i.test(asrMsg), asrMsg);

  let semErr: unknown = null;
  const t1 = performance.now();
  try {
    await runRiisheInference({
      mediaName: "adapter-contract-test.mp3",
      durationSec: 31.66,
      sensitivity: "BALANCED",
      candidates: [
        { id: "c1", start: 0.15, end: 0.61, duration: 0.46, rms: 0.0001, snr: 1.0, transcriptText: null },
        { id: "c2", start: 5.0, end: 5.9, duration: 0.9, rms: 0.0001, snr: 1.0, transcriptText: null },
        { id: "c3", start: 20.1, end: 21.0, duration: 0.9, rms: 0.0001, snr: 1.0, transcriptText: null },
      ],
      transcriptSegments: [],
    });
  } catch (e) { semErr = e; }
  const semMsg = semErr instanceof Error ? semErr.message : String(semErr);
  check("real semantic adapter surfaces sidecar 503 verbatim", semErr !== null && semMsg.includes("local semantic endpoint answered 503"), `${Math.round(performance.now() - t1)}ms: ${semMsg}`);
  check("isProviderUnavailable classifies the sidecar outage", isProviderUnavailable(semErr), semMsg.slice(0, 120));
  check("no classification was fabricated despite outage", /no classification|model|llama/i.test(semMsg), semMsg.slice(0, 140));

  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("crashed:", e); process.exit(2); });
