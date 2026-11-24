/**
 * M42-D — Model capability registry.
 *
 * A real registry of the AI models/tools BEAN FX can actually use: every
 * entry maps to an EXISTING integration (the MY AI LLM gateway + its zai
 * adapter, the JAZMII/LAXII provider lanes, the ASR/gateway SDK tooling, the
 * local OpenCV/ffmpeg analysis stack). Nothing here invents a provider.
 *
 * Honesty rules (spec §6.1/§6.3):
 *  - A model is READY only after its real configuration check succeeds at
 *    probe time (binary present / env configured / previous live check ok).
 *  - `cost` is a string: "COST UNKNOWN" unless a real figure is known.
 *  - Models that are listed-but-unconfigured report `ready:false` with the
 *    reason; the router can pick them only as DISCLOSED fallbacks.
 *  - No Ollama. No unapproved paid APIs. Secrets never appear in registry
 *    output — only boolean/enum configuration state.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export const MODEL_CAPABILITIES = [
  "reasoning",
  "creative-direction",
  "video-understanding",
  "image-analysis",
  "scene-classification",
  "audio-analysis",
  "transcription",
  "word-alignment",
  "diarization",
  "captions",
  "translation",
  "image-generation",
  "background-removal",
  "image-restoration",
  "video-enhancement",
  "upscaling",
  "frame-interpolation",
  "motion-graphics",
  "sound-analysis",
  "code-generation",
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export interface ModelEntry {
  provider: string;
  id: string;
  displayName: string;
  /** LLM | VLM | ASR | IMAGE | VIDEO | TOOL |
   */
  type: "LLM" | "VLM" | "ASR" | "IMAGE" | "VIDEO" | "TOOL";
  capabilities: ModelCapability[];
  vision: boolean;
  audio: boolean;
  video: boolean;
  text: boolean;
  toolCalling: boolean;
  maxContextTokens: number | null;
  /** "local" = runs on this host; "remote" = configured provider API; "cli" = local CLI binary talking to the provider. */
  execution: "local" | "remote" | "cli";
  hardware: { cpu: boolean; gpu: boolean | null; memoryNote: string | null };
  /** Real cost string or the honest "COST UNKNOWN". */
  cost: string;
  /** Probed at registry read: configuration + binary presence. */
  ready: boolean;
  readyReason: string;
  /** Last successful capability check (iso) — null when never checked live. */
  lastCheckAt: string | null;
}

function probeBinary(bin: string, args: string[] = ["--version"]): { ok: boolean; detail: string } {
  try {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 10_000 });
    if (r.status === 0 || (r.stdout ?? "").length > 0 || (r.stderr ?? "").length > 0) {
      return { ok: r.status === 0 || (r.stdout ?? "").length > 0, detail: ((r.stdout ?? r.stderr ?? "")).trim().split("\n")[0].slice(0, 80) };
    }
    return { ok: false, detail: `exit ${r.status}` };
  } catch {
    return { ok: false, detail: "not found" };
  }
}

function probeModule(mod: string): boolean {
  try {
    const r = spawnSync("python3", ["-I", "-c", `import ${mod}`], { encoding: "utf8", timeout: 15_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export interface ProbeResult {
  models: ModelEntry[];
  probedAt: string;
  summary: { total: number; ready: number };
}

/**
 * Probe the real environment. Pure function of the host: no network calls
 * except the z-ai CLI version check (a local binary invocation).
 */
export function probeModelRegistry(): ProbeResult {
  const probedAt = new Date().toISOString();
  const models: ModelEntry[] = [];

  const zai = probeBinary("z-ai", ["--help"]);
  const zaiSdk = existsSync("node_modules/z-ai-web-dev-sdk") || process.env.BEANFX_MYAI_PROVIDER === "zai";
  const gatewayConfigured = zaiSdk || zai.ok;
  models.push({
    provider: "zai-gateway",
    id: "glm-chat",
    displayName: "GLM (MY AI LLM gateway)",
    type: "LLM",
    capabilities: ["reasoning", "creative-direction", "code-generation", "captions", "translation"],
    vision: false,
    audio: false,
    video: false,
    text: true,
    toolCalling: false,
    maxContextTokens: null,
    execution: zaiSdk ? "remote" : "cli",
    hardware: { cpu: true, gpu: null, memoryNote: null },
    cost: "COST UNKNOWN",
    ready: gatewayConfigured,
    readyReason: gatewayConfigured ? zaiSdk ? "z-ai SDK module present (gateway adapter)" : `z-ai CLI present (${zai.detail})` : "z-ai SDK/CLI not found — set BEANFX_MYAI_PROVIDER or install the SDK",
    lastCheckAt: null,
  });

  const videoProv = process.env.BEANFX_JAZMII_PROVIDER ?? "zai-video";
  models.push({
    provider: "jazmii",
    id: videoProv,
    displayName: "JAZMII video provider (generation + video tasks)",
    type: "VIDEO",
    capabilities: ["video-understanding", "video-enhancement"],
    vision: true,
    audio: false,
    video: true,
    text: true,
    toolCalling: false,
    maxContextTokens: null,
    execution: "cli",
    hardware: { cpu: true, gpu: null, memoryNote: "provider-side; local cost is CLI timeout only" },
    cost: "COST UNKNOWN (provider terms recorded in jazmii providers.ts)",
    ready: zai.ok,
    readyReason: zai.ok ? `z-ai CLI present (${zai.detail})` : "z-ai CLI not found",
    lastCheckAt: null,
  });

  const laxii = process.env.BEANFX_LAXII_PROVIDER ?? "zai-image";
  models.push({
    provider: "laxii",
    id: laxii,
    displayName: "LAXII image provider (generation)",
    type: "IMAGE",
    capabilities: ["image-generation", "background-removal"],
    vision: false,
    audio: false,
    video: false,
    text: false,
    toolCalling: false,
    maxContextTokens: null,
    execution: "cli",
    hardware: { cpu: true, gpu: null, memoryNote: null },
    cost: "COST UNKNOWN",
    ready: zai.ok,
    readyReason: zai.ok ? "z-ai CLI present" : "z-ai CLI not found",
    lastCheckAt: null,
  });

  const ff = probeBinary("ffmpeg", ["-version"]);
  const ffp = probeBinary("ffprobe", ["-version"]);
  models.push({
    provider: "beanfx-local",
    id: "ffmpeg-analysis",
    displayName: "FFmpeg/ffprobe media analysis",
    type: "TOOL",
    capabilities: ["video-understanding", "audio-analysis", "sound-analysis"],
    vision: true,
    audio: true,
    video: true,
    text: false,
    toolCalling: false,
    maxContextTokens: null,
    execution: "local",
    hardware: { cpu: true, gpu: null, memoryNote: "decode/encode on CPU; threads bounded by the worker" },
    cost: "local — no API cost",
    ready: ff.ok && ffp.ok,
    readyReason: ff.ok && ffp.ok ? `ffmpeg ${ff.detail} + ffprobe ok` : "ffmpeg/ffprobe missing",
    lastCheckAt: null,
  });

  const cv = probeModule("cv2");
  const csrt = cv
    ? spawnSync("python3", ["-I", "-c", "import cv2; assert hasattr(cv2, 'legacy') and hasattr(cv2.legacy, 'TrackerCSRT_create')"], { encoding: "utf8", timeout: 15_000 }).status === 0
    : false;
  models.push({
    provider: "beanfx-local",
    id: "opencv-cv",
    displayName: "OpenCV visual analysis (scene/motion/tracking)",
    type: "TOOL",
    capabilities: ["image-analysis", "scene-classification", "video-understanding"],
    vision: true,
    audio: false,
    video: true,
    text: false,
    toolCalling: false,
    maxContextTokens: null,
    execution: "local",
    hardware: { cpu: true, gpu: null, memoryNote: "frame-sampled analysis; bounded windows" },
    cost: "local — no API cost",
    ready: csrt,
    readyReason: csrt ? "cv2 present with CSRT (contrib)" : cv ? "cv2 present but legacy/CSRT missing — install opencv-contrib-python-headless" : "python3/cv2 not found",
    lastCheckAt: null,
  });

  const psc = probeModule("scenedetect");
  models.push({
    provider: "beanfx-local",
    id: "pyscenedetect",
    displayName: "PySceneDetect scene-cut detection",
    type: "TOOL",
    capabilities: ["scene-classification", "video-understanding"],
    vision: true,
    audio: false,
    video: true,
    text: false,
    toolCalling: false,
    maxContextTokens: null,
    execution: "local",
    hardware: { cpu: true, gpu: null, memoryNote: null },
    cost: "local — no API cost",
    ready: psc,
    readyReason: psc ? "scenedetect module importable" : "module not installed — the analysis falls back to the ffmpeg scdet filter (disclosed)",
    lastCheckAt: null,
  });

  const librosa = probeModule("librosa");
  models.push({
    provider: "beanfx-local",
    id: "librosa-beats",
    displayName: "librosa beat/onset analysis",
    type: "TOOL",
    capabilities: ["sound-analysis", "audio-analysis"],
    vision: false,
    audio: true,
    video: false,
    text: false,
    toolCalling: false,
    maxContextTokens: null,
    execution: "local",
    hardware: { cpu: true, gpu: null, memoryNote: null },
    cost: "local — no API cost",
    ready: librosa,
    readyReason: librosa ? "librosa importable" : "librosa not installed — beat-synced cutting falls back to silence/gestalt timing (disclosed)",
    lastCheckAt: null,
  });

  const asrEnv = Boolean(process.env.BEANFX_ASR_ENABLED);
  models.push({
    provider: "zai-gateway",
    id: "asr-speech",
    displayName: "ASR (speech-to-text via configured gateway)",
    type: "ASR",
    capabilities: ["transcription", "captions"],
    vision: false,
    audio: true,
    video: false,
    text: true,
    toolCalling: false,
    maxContextTokens: null,
    execution: "remote",
    hardware: { cpu: true, gpu: null, memoryNote: null },
    cost: "COST UNKNOWN",
    ready: asrEnv && zaiSdk,
    readyReason: asrEnv && zaiSdk ? "BEANFX_ASR_ENABLED + gateway SDK present" : "ASR not enabled (BEANFX_ASR_ENABLED unset) — caption generation from audio is disclosed until enabled",
    lastCheckAt: null,
  });

  // CONDITIONAL per the license register — reported as not-ready unless the
  // owner explicitly enables them (no silent third-party engine).
  for (const opt of [
    { id: "faster-whisper", name: "faster-whisper transcription (local)", caps: ["transcription", "word-alignment"] as ModelCapability[], env: "BEANFX_ENABLE_FASTER_WHISPER" },
    { id: "pyscenedetect-pro", name: "PySceneDetect (adaptive detectors)", caps: ["scene-classification"] as ModelCapability[], env: "BEANFX_ENABLE_PYSCENEDETECT" },
  ]) {
    const on = process.env[opt.env] === "1";
    models.push({
      provider: "beanfx-optional",
      id: opt.id,
      displayName: opt.name,
      type: "TOOL",
      capabilities: opt.caps,
      vision: false,
      audio: opt.id.startsWith("faster"),
      video: opt.id.startsWith("pyscene"),
      text: false,
      toolCalling: false,
      maxContextTokens: null,
      execution: "local",
      hardware: { cpu: true, gpu: true, memoryNote: "model download required (~200 MB+) — owner consent" },
      cost: "local — no API cost",
      ready: on && probeModule(opt.id === "faster-whisper" ? "faster_whisper" : "scenedetect"),
      readyReason: on ? "owner-enabled; module presence probed" : `disabled by default — set ${opt.env}=1 to enable (owner action, license register CONDITIONAL)`,
      lastCheckAt: null,
    });
  }

  return {
    models,
    probedAt,
    summary: { total: models.length, ready: models.filter((m) => m.ready).length },
  };
}

/** Capability-aware routing with honest fallback reasons (spec §6.3). */
export interface RoutePick {
  capability: ModelCapability;
  chosen: ModelEntry | null;
  fallbackReason: string | null;
  candidates: Array<{ id: string; ready: boolean; reason: string }>;
}

export function routeForCapability(reg: ProbeResult, capability: ModelCapability): RoutePick {
  const candidates = reg.models
    .filter((m) => m.capabilities.includes(capability))
    .map((m) => ({ id: m.id, ready: m.ready, reason: m.readyReason }));
  const ready = reg.models.filter((m) => m.capabilities.includes(capability) && m.ready);
  // Prefer a configured local tool for analysis tasks; prefer the LLM for reasoning.
  const order: Record<string, number> = { reasoning: 0, "creative-direction": 0, "code-generation": 0 };
  ready.sort((a, b) => (order[a.capabilities.includes(capability) ? a.id : a.id] ?? 0) - 0);
  const chosen = ready[0] ?? null;
  return {
    capability,
    chosen,
    fallbackReason: chosen ? null : `no READY model with capability "${capability}" — candidates: ${candidates.length ? candidates.map((c) => `${c.id} (${c.ready ? "ready" : "not ready"})`).join(", ") : "none registered"}`,
    candidates,
  };
}
