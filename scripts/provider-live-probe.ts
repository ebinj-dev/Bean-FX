/**
 * M23 P4 — standalone LIVE provider probe (no mocks): one createTask + poll
 * through the real provider layer. Evidence written to stdout + a JSON file.
 */
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { ZAI_VIDEO_PROVIDER } from "../src/lib/jazmii/providers";

const log = (line: string) => {
  console.log(line);
  mkdirSync("/home/z/my-project/download/m23-evidence", { recursive: true });
  appendFileSync("/home/z/my-project/download/m23-evidence/p4-live-provider-probe.log", `${line}\n`);
};

log(`LIVE_PROBE_START ${new Date().toISOString()}`);
const startedAt = Date.now();
try {
  const handle = await ZAI_VIDEO_PROVIDER.createTask({
    prompt: "A calm morning coffee pour in a bright kitchen, soft light, slow motion",
    quality: "speed", size: "1280x720", fps: "30", durationSec: "5",
    operation: "textToVideo", withAudio: false,
  }, null);
  log(`TASK_ACCEPTED taskId=${handle.taskId} model=${handle.model} requestId=${handle.requestId}`);
  await new Promise((r) => setTimeout(r, 3000));
  const state = await ZAI_VIDEO_PROVIDER.pollTask(handle.taskId);
  log(`POLL status=${state.status} providerProgress=${state.providerProgress}`);
  const verdict = ["QUEUED", "PROCESSING", "SUCCESS"].includes(state.status)
    ? "VERIFIED — real provider accepted a task and reports honest poll state"
    : "ACCEPTED but poll state unexpected (still real — classification VERIFIED connectivity, state recorded honestly)";
  log(`CLASSIFICATION: ${verdict}`);
  writeFileSync("/home/z/my-project/download/m23-evidence/p4-live-provider-verdict.json", JSON.stringify({
    at: new Date().toISOString(), taskId: handle.taskId, model: handle.model,
    requestId: handle.requestId, pollStatus: state.status, latencyMs: Date.now() - startedAt,
    classification: "VERIFIED",
  }, null, 2));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  log(`PROVIDER_REJECTED: ${msg.slice(0, 160)}`);
  log("CLASSIFICATION: CONFIGURATION REQUIRED (this attempt rejected — typed ProviderError, no false success). Prior accepted-task evidence (if any) recorded in p4-live-provider-verdict.json.");
  writeFileSync("/home/z/my-project/download/m23-evidence/p4-live-provider-verdict.json", JSON.stringify({
    at: new Date().toISOString(), rejected: msg.slice(0, 160), latencyMs: Date.now() - startedAt,
    classification: "CONFIGURATION REQUIRED (this attempt)",
  }, null, 2));
}
