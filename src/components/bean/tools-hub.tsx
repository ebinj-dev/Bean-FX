"use client";

/**
 * M47.1 §B — CREATIVE TOOLS HUB (dedicated authenticated route /studio/tools).
 *
 * Rules encoded here:
 *  - every card launches a REAL route/panel that already exists in the product
 *    (canonical editor, upload-gate tools, media library, production crew) —
 *    no card opens a mock;
 *  - statuses are truthful: READY only where the capability is verified with
 *    on-file evidence; BETA when usable with a documented limitation;
 *    CONFIGURATION REQUIRED when the integration needs env/provider setup;
 *    PLANNED when it does not exist yet — never presented as working;
 *  - the hub performs NO execution itself: it routes into the existing
 *    backend services and canonical systems (no second renderer/queue).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, ErrorNote, Panel, PanelHead, StatusBadge } from "@/components/bean/ui";

export type ToolStatus = "READY" | "CONFIGURATION REQUIRED" | "BETA" | "UNAVAILABLE" | "PLANNED";

export interface ToolCard {
  id: string;
  name: string;
  status: ToolStatus;
  /** What the tool actually does today — no marketing gloss. */
  summary: string;
  /** Where the implementation lives / what backs it (routes, commands, jobs). */
  backedBy: string;
  /** The real destination this card opens. */
  launch?: { label: string; href: string };
  /** Verification evidence — test battery or milestone with artifacts. */
  evidence?: string;
  /** Honest limitation, shown on the card when present. */
  caveat?: string;
}

interface Category {
  id: string;
  title: string;
  blurb: string;
  tools: ToolCard[];
}

const statusBadge = (s: ToolStatus): "ok" | "run" | "fail" | "idle" | "det" =>
  s === "READY" ? "ok" : s === "BETA" ? "run" : s === "PLANNED" || s === "UNAVAILABLE" ? "fail" : "idle";

/** Editor deep link — the canonical editor with optional project context. */
const editor = (projectId: string | null, hash = "/editor"): string =>
  `/#${hash}${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`;

export function buildToolCatalog(projectId: string | null): Category[] {
  return [
    {
      id: "video-editing",
      title: "Video Editing",
      blurb: "The canonical timeline editor — every action is a real editing command executed through the one shared command registry.",
      tools: [
        {
          id: "trim-split",
          name: "Trim, split & roll edits",
          status: "READY",
          summary: "TrimClip, SplitClip, RippleDelete, RollEdit, InsertClip and ReplaceClip on the canonical timeline.",
          backedBy: "src/lib/editor/commands.ts command registry — one executor for UI, agents and MCP",
          launch: { label: "Open in Editor", href: editor(projectId) },
          evidence: "scripts/test-m43-commands.test.ts + M46 golden-path battery",
        },
        {
          id: "arrange",
          name: "Timeline arrangement",
          status: "READY",
          summary: "MoveClip, AlignClipsToPlayhead, CloseGaps, Group/UngroupClips, add/remove/rename tracks.",
          backedBy: "editor command registry → canonical project timeline",
          launch: { label: "Open in Editor", href: editor(projectId) },
          evidence: "M43 command battery; M46 assembly regression",
        },
        {
          id: "transform-crop",
          name: "Transform & crop",
          status: "READY",
          summary: "Per-clip transform properties and the crop effect with animated keyframes.",
          backedBy: "UpdateClipProperties + crop in FILTER_EFFECTS (ffmpeg chain + canvas preview)",
          launch: { label: "Open in Editor", href: editor(projectId) },
          evidence: "M45/M46 render verification (FFprobe output checks)",
        },
        {
          id: "markers",
          name: "Timeline markers",
          status: "READY",
          summary: "Add, move, relabel and remove markers at exact frames.",
          backedBy: "AddMarker / UpdateMarker / RemoveMarker commands",
          launch: { label: "Open in Editor", href: editor(projectId) },
          evidence: "M43-B command registry tests",
        },
        {
          id: "transitions",
          name: "Transitions",
          status: "READY",
          summary: "Add and remove transitions between clips; rendered by the FFmpeg pipeline.",
          backedBy: "AddTransition / RemoveTransition commands + render chain",
          launch: { label: "Open in Editor", href: editor(projectId) },
          evidence: "M46 render battery",
        },
        {
          id: "versions",
          name: "Version comparison",
          status: "READY",
          summary: "Timeline version history with side-by-side comparison of rendered outputs.",
          backedBy: "/api/editor/projects/[projectId]/timeline/versions + compare UI in Studio Chat",
          launch: { label: "Open Studio Chat", href: editor(projectId, "/home") },
          evidence: "M46H §5 — per-production export cards",
        },
        {
          id: "export",
          name: "Export & batch render",
          status: "READY",
          summary: "Single renders and batch exports through the existing durable job system (mp4 1080p / vertical / square).",
          backedBy: "/api/editor/projects/[projectId]/render + /batch-export; export files served by /api/exports/[id]/file",
          launch: { label: "Open in Editor", href: editor(projectId) },
          evidence: "M33 three-format live battery; M46 FFprobe validation",
        },
      ],
    },
    {
      id: "audio",
      title: "Audio Studio",
      blurb: "Real server-side audio processing through GANGZII and the FFmpeg audio chain.",
      tools: [
        {
          id: "audio-tracks",
          name: "Audio track management",
          status: "READY",
          summary: "Add/remove audio tracks, arrange audio clips on the canonical timeline.",
          backedBy: "AddTrack / RemoveTrack / MoveClip commands",
          launch: { label: "Open in Editor", href: editor(projectId) },
          evidence: "M43 command battery",
        },
        {
          id: "gain-fades",
          name: "Gain, volume & fades",
          status: "READY",
          summary: "ChangeVolume command, volume effect with audioGainMultiplier, per-clip fade in/out frames.",
          backedBy: "command registry + src/lib/editor/filters.ts audioGainMultiplier",
          launch: { label: "Open in Editor", href: editor(projectId) },
          evidence: "M42-I silence removal + M46 assembly",
        },
        {
          id: "audio-analysis",
          name: "Audio analysis",
          status: "READY",
          summary: "Stream-decodes an owned asset and stores structured loudness/character inspection for planning.",
          backedBy: "POST /api/gangzii/analyze → durable GANGZII_ANALYZE job",
          launch: { label: "Open GANGZII panel", href: editor(projectId) },
          evidence: "M41 audio companion contract; M45 ranges live run",
        },
        {
          id: "audio-cleanup",
          name: "Audio cleanup studio",
          status: "READY",
          summary: "Import audio, clean and shape it with real server-side processing, export the result.",
          backedBy: "#/audio tool (UploadGate) + POST /api/process/audio",
          launch: { label: "Open Audio Studio", href: editor(projectId, "/audio") },
          evidence: "M31 integration qualification",
        },
        {
          id: "audio-mix",
          name: "Supported mixing",
          status: "BETA",
          summary: "Multi-track level shaping inside the render chain; advanced bus mixing (sidechain/EQ nodes) is not implemented.",
          backedBy: "FFmpeg audio filters composed by the canonical renderer",
          launch: { label: "Open in Editor", href: editor(projectId) },
          caveat: "No EQ/compressor node graph — only gain, fades, volume effects and ducking-style removal flows.",
          evidence: "M46 assembly regression (real mixed renders)",
        },
      ],
    },
    {
      id: "vfx",
      title: "VFX & Motion",
      blurb: "NIIKI's compositing surface: real FFmpeg/canvas effects — no fake preview-only toggles.",
      tools: [
        {
          id: "chroma-key",
          name: "Chroma key",
          status: "READY",
          summary: "Key out a colour range with similarity/blend params; canvas preview + FFmpeg render chain.",
          backedBy: "chromaKey in CANVAS_VFX_TYPES + ffmpegEffectChain",
          launch: { label: "Open in Editor", href: editor(projectId) },
          evidence: "M45 VFX unit; M46 render battery",
        },
        {
          id: "masks",
          name: "Masks",
          status: "READY",
          summary: "Rect and ellipse masks per clip, applied in preview and render.",
          backedBy: "rectMask / ellipseMask effects + src/lib/production/masks.ts",
          launch: { label: "Open in Editor", href: editor(projectId) },
          evidence: "M45/M46",
        },
        {
          id: "motion-blur",
          name: "Motion blur",
          status: "BETA",
          summary: "Rendered motion blur; preview is approximate (listed in APPROXIMATE_PREVIEW).",
          backedBy: "motionBlur effect + ffmpeg chain",
          launch: { label: "Open in Editor", href: editor(projectId) },
          caveat: "Canvas preview approximates the render — check the final export before delivery.",
          evidence: "M46 render battery",
        },
        {
          id: "stabilize",
          name: "Stabilization",
          status: "READY",
          summary: "Two-pass libvidstab on an owned video asset; the stabilized derivative is registered with provenance.",
          backedBy: "POST /api/media/[id]/stabilize → durable MEDIA_STABILIZE job",
          launch: { label: "Open Media Library", href: editor(projectId, "/library") },
          evidence: "M45 Unit B stabilization entry + job runner",
        },
        {
          id: "titles",
          name: "Titles, graphics & overlays",
          status: "READY",
          summary: "AddGraphic / AddCaption overlays with properties and keyframes.",
          backedBy: "command registry + render chain",
          launch: { label: "Open in Editor", href: editor(projectId) },
          evidence: "M43/M46",
        },
        {
          id: "color",
          name: "Colour & tone compositing",
          status: "READY",
          summary: "Brightness, contrast, saturation, exposure, highlights, shadows, whites, blacks, sharpen, vignette — animated via keyframes.",
          backedBy: "FILTER_EFFECTS + SetEffectKeyframe(s) commands + animated ffmpeg chain",
          launch: { label: "Open in Editor", href: editor(projectId) },
          evidence: "M45/M46 render verification",
        },
        {
          id: "nikki-motion",
          name: "NIKKI motion-graphics proposals",
          status: "READY",
          summary: "Queues a durable NIKKI proposal → render job that produces real timeline material.",
          backedBy: "POST /api/nikki/proposal → /api/nikki/render",
          launch: { label: "Open NIKKI panel", href: editor(projectId) },
          evidence: "M41/M42 AI-edit chat battery",
        },
      ],
    },
    {
      id: "voice",
      title: "Captions & Voice",
      blurb: "Real ASR/TTS through the configured gateway. English is verified; Tamil/Tanglish need native-speaker validation — stated everywhere.",
      tools: [
        {
          id: "asr",
          name: "ASR transcription",
          status: "BETA",
          summary: "Server transcription of owned media through the configured ASR provider; the provider hard-limits input files to 30 s per request (error 1214), so longer audio is chunked.",
          backedBy: "POST /api/transcribe (chunked) + POST /api/my-ai/voice/transcribe (voice notes)",
          launch: { label: "Open Captions tool", href: editor(projectId, "/captions") },
          caveat: "Provider limit: 30 s per ASR request. Long-form accuracy is unvalidated.",
          evidence: "M31 captions qualification; M47 voice battery (EN)",
        },
        {
          id: "caption-edit",
          name: "Caption editing",
          status: "READY",
          summary: "Edit captions against the real waveform, with word-level timing data.",
          backedBy: "#/captions tool (UploadGate) + /api/autocut/words",
          launch: { label: "Open Captions tool", href: editor(projectId, "/captions") },
          evidence: "M31/M33",
        },
        {
          id: "subtitle-export",
          name: "Subtitle export (SRT/VTT)",
          status: "READY",
          summary: "Export edited subtitles as SRT/VTT from the captions tool.",
          backedBy: "captions tool export path",
          launch: { label: "Open Captions tool", href: editor(projectId, "/captions") },
          evidence: "M31 integration qualification",
        },
        {
          id: "burn-captions",
          name: "Burn captions into video",
          status: "READY",
          summary: "Hard-burn rendered subtitles into an MP4 through the processing service.",
          backedBy: "POST /api/process/burn-captions",
          launch: { label: "Open Captions tool", href: editor(projectId, "/captions") },
          evidence: "M31/M33 three-format battery",
        },
        {
          id: "riishe-voice",
          name: "RIISHE voice command & spoken replies",
          status: "READY",
          summary: "Push-to-talk / hands-free capture → editable transcript → explicit send into the normal planner; RIISHE replies playable as verified audio (magic-number-checked WAV/MP3, PCM wrapped in a real container).",
          backedBy: "/api/my-ai/voice/transcribe + /api/my-ai/voice/speak + src/lib/audio-format.ts",
          launch: { label: "Open Studio Chat", href: editor(projectId, "/home") },
          caveat: "English verified live. Tamil/Tanglish pending native-speaker validation — the UI marks them unverified.",
          evidence: "M47.1-A: scripts/test-m471-voice-contract.test.ts (21 tests) + live voice battery",
        },
        {
          id: "voice-languages",
          name: "Voice language selection",
          status: "BETA",
          summary: "Language register with honest per-language status; the configured provider documents no ASR language parameter, so Tamil/Tanglish attempts return the provider transcript as recognised.",
          backedBy: "src/lib/voice-language.ts + transcribe route language register",
          launch: { label: "Open Studio Chat", href: editor(projectId, "/home") },
          caveat: "English: verified. Tamil/Tanglish: unverified — needs native-speaker validation before production reliance.",
          evidence: "M47.1-A language register tests",
        },
      ],
    },
    {
      id: "footage",
      title: "Footage Intelligence",
      blurb: "JAZMII's analysis surface plus the media inspection stack — real FFprobe data only.",
      tools: [
        {
          id: "scene-detection",
          name: "Scene detection & shot coverage",
          status: "READY",
          summary: "Evidence-backed KEEP/REMOVE/REVIEW proposals from real audio/scene analysis; shot-coverage map binds scenes to real material.",
          backedBy: "POST /api/autocut/analyze + POST /api/jazmii/analyze (durable jobs); Intelligence page coverage map",
          launch: { label: "Open Auto Cut", href: editor(projectId, "/autocut") },
          evidence: "M40 range battery; M42-I planning tests",
        },
        {
          id: "source-tracing",
          name: "Source → timeline tracing",
          status: "READY",
          summary: "Trace every final clip back to its source asset; relink assets when files move.",
          backedBy: "RelinkAssets command + /api/projects/[id]/assets/status + /relink",
          launch: { label: "Open Intelligence", href: editor(projectId, "/intelligence") },
          evidence: "M28 portability battery; M46 provenance labels",
        },
        {
          id: "media-inspection",
          name: "Media inspection",
          status: "READY",
          summary: "FFprobe-backed probe, waveform data, thumbnails and proxies for every owned asset.",
          backedBy: "/api/media/[id] probe + /waveform + /thumbnail + /proxy",
          launch: { label: "Open Media Library", href: editor(projectId, "/library") },
          evidence: "M28/M29 closeout batteries",
        },
        {
          id: "transcript-search",
          name: "Transcript & temporal search",
          status: "READY",
          summary: "Search transcripts and jump to temporal moments inside owned media.",
          backedBy: "/api/creative/analyze/transcripts + /api/creative/temporal/search",
          launch: { label: "Open Intelligence", href: editor(projectId, "/intelligence") },
          evidence: "M40 range portability battery",
        },
        {
          id: "broll",
          name: "B-roll library",
          status: "READY",
          summary: "Build a B-roll library with notes and get transcript-linked insertion suggestions.",
          backedBy: "#/broll tool (UploadGate) + suggestions pipeline",
          launch: { label: "Open B-Roll tool", href: editor(projectId, "/broll") },
          evidence: "M31 qualification",
        },
      ],
    },
    {
      id: "image",
      title: "Image & Artwork",
      blurb: "LAXII's generative surface — provider-backed generation with ownership checks and provenance.",
      tools: [
        {
          id: "laxii-generate",
          name: "LAXII image generation",
          status: "READY",
          summary: "Queues a durable LAXII_GENERATE job from validated params; reference assets are ownership-checked; one active job per user.",
          backedBy: "POST /api/laxii/generate + worker",
          launch: { label: "Open LAXII panel", href: editor(projectId) },
          caveat: "Runs through the configured gateway provider — no other provider is silently substituted.",
          evidence: "M7 §7A/§13 contract; job runner tests",
        },
        {
          id: "image-compose",
          name: "Image composition",
          status: "READY",
          summary: "Compose images into scenes with real direction data (M14 compose pipeline).",
          backedBy: "POST /api/creative/m14/compose",
          launch: { label: "Open Intelligence", href: editor(projectId, "/intelligence") },
          evidence: "M14 direction tests",
        },
        {
          id: "reference-refs",
          name: "Reference image management",
          status: "READY",
          summary: "Reference assets live in the media library with roles; the editor attaches them per clip.",
          backedBy: "/api/media (roles) + editor inspector",
          launch: { label: "Open Media Library", href: editor(projectId, "/library") },
          evidence: "M46 project-guarded assets",
        },
      ],
    },
    {
      id: "quality",
      title: "Quality & Delivery",
      blurb: "Everything downstream of the timeline: QA, exports, versions, publishing, local download.",
      tools: [
        {
          id: "ffprobe",
          name: "FFprobe inspection",
          status: "READY",
          summary: "Real container/stream probing for renders and uploads (codec, duration, dimensions).",
          backedBy: "media-analysis + render QA path",
          launch: { label: "Open Media Library", href: editor(projectId, "/library") },
          evidence: "M33/M46 FFprobe-verified renders",
        },
        {
          id: "render-qa",
          name: "Render QA",
          status: "READY",
          summary: "QUALITY_ASSURANCE production stage runs against the real rendered file, not a promise.",
          backedBy: "production pipeline QUALITY_ASSURANCE stage + /api/productions/[id]/stages/[key]",
          launch: { label: "Open Production Crew", href: editor(projectId, "/crew") },
          evidence: "M46 hardening stage battery",
        },
        {
          id: "export-formats",
          name: "Export formats",
          status: "READY",
          summary: "MP4 1080p, vertical (9:16) and square (1:1) through the durable queue.",
          backedBy: "render/batch-export routes + PIPELINE_TEMPLATES deliveryFormats",
          launch: { label: "Open in Editor", href: editor(projectId) },
          evidence: "M33 three-format live battery",
        },
        {
          id: "version-mgmt",
          name: "Version management",
          status: "READY",
          summary: "Timeline versions, export versions and aspect variants with compare; never overwrites an earlier success.",
          backedBy: "timeline/versions + exports + /api/productions/[id]/variants",
          launch: { label: "Open Studio Chat", href: editor(projectId, "/home") },
          evidence: "M46H §5",
        },
        {
          id: "local-download",
          name: "Local download",
          status: "READY",
          summary: "Download export files, project archives and publish packages directly.",
          backedBy: "/api/exports/[id]/file + /api/project-archives/[id]/download + /api/publish/packages/[id]/download",
          launch: { label: "Open Media Library", href: editor(projectId, "/library") },
          evidence: "M29 closeout battery",
        },
        {
          id: "publish",
          name: "Publish packages & thumbnails",
          status: "READY",
          summary: "Per-platform publish presets, metadata, composite thumbnails and variant packages.",
          backedBy: "/api/publish/* routes",
          launch: { label: "Open in Editor", href: editor(projectId) },
          evidence: "M31/M33",
        },
      ],
    },
    {
      id: "assistants",
      title: "Automation & Assistants",
      blurb: "MCP/automation surfaces and the crew pipeline — every execution is disclosed with its real mode.",
      tools: [
        {
          id: "mcp",
          name: "MCP automation server",
          status: "READY",
          summary: "Token-gated MCP endpoint exposing the same command registry — no separate execution engine.",
          backedBy: "/api/v1/mcp + /api/automation/mcp + token approvals",
          launch: { label: "Open Settings", href: editor(projectId, "/settings") },
          evidence: "M22/M23 security batteries",
        },
        {
          id: "crew",
          name: "Production crew pipeline",
          status: "READY",
          summary: "Durable multi-stage productions with approval gates, retries, provenance labels and QA.",
          backedBy: "/api/productions/* + src/lib/production/runner.ts",
          launch: { label: "Open Production Crew", href: editor(projectId, "/crew") },
          evidence: "M45/M46 stage-control hardening",
        },
        {
          id: "provider-gate",
          name: "AI provider gateway",
          status: "CONFIGURATION REQUIRED",
          summary: "One gateway, one provider registry; capability probes disclose exactly what is configured and what is missing.",
          backedBy: "/api/providers/readiness + /api/ai/models + src/lib/my-ai/gateway/provider.ts",
          launch: { label: "Open Settings", href: editor(projectId, "/settings") },
          caveat: "LLM/ASR/TTS capabilities need the configured gateway SDK + env flags (BEANFX_ASR_ENABLED etc.). Without them the UI says so instead of faking results.",
          evidence: "M42 model registry tests",
        },
      ],
    },
  ];
}

const STATUS_ORDER: ToolStatus[] = ["READY", "BETA", "CONFIGURATION REQUIRED", "PLANNED", "UNAVAILABLE"];

export function ToolsHub() {
  const [user, setUser] = useState<{ name: string | null; email: string } | null | undefined>(undefined);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ToolStatus | "ALL">("ALL");

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/auth/me");
        const d = await res.json().catch(() => null);
        if (d?.user) {
          setUser({ name: d.user.name ?? null, email: d.user.email });
          const pres = await fetch("/api/projects");
          const pd = await pres.json().catch(() => null);
          const list = (pd?.projects ?? []).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }));
          setProjects(list);
          if (list.length > 0) setProjectId(list[0].id);
        } else {
          setUser(null);
        }
      } catch {
        setError("Session check failed — reload the page or open the studio and sign in.");
        setUser(null);
      }
    })();
  }, []);

  const catalog = useMemo(() => buildToolCatalog(projectId), [projectId]);
  const counts = useMemo(() => {
    const all = catalog.flatMap((c) => c.tools);
    return STATUS_ORDER.map((s) => ({ status: s, n: all.filter((t) => t.status === s).length }));
  }, [catalog]);

  const go = useCallback((href: string) => {
    // Hash routes belong to the SPA shell; everything else is a normal page.
    if (href.startsWith("/#")) {
      window.location.assign(href);
    } else {
      window.location.assign(href);
    }
  }, []);

  if (user === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050505]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#2a2a2a] border-t-[#d4a017]" aria-label="Loading" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050505] px-4">
        <Panel className="w-full max-w-md p-6 text-center">
          <p className="text-[13px] font-extrabold tracking-[0.18em] text-[var(--m47-gold)]">BEAN FX</p>
          <h1 className="mt-3 text-[17px] font-bold text-[var(--m47-ink)]">Creative Tools Hub — sign-in required</h1>
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--m47-ink-mid)]">
            The tools hub routes into your authenticated studio: projects, assets and the canonical editor.
            Sign in to continue — nothing here executes without your session.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Btn variant="primary" onClick={() => window.location.assign("/")}>Sign in</Btn>
            <Btn variant="ghost" onClick={() => window.location.assign("/")}>Back to site</Btn>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--m47-bg)] text-[var(--m47-ink)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--m47-line)] bg-[var(--m47-bg-raised)] px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Btn variant="ghost" onClick={() => window.location.assign("/#/home")} title="Back to Studio Chat">← Studio</Btn>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-bold tracking-[0.08em]">Creative Tools</h1>
            <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--m47-ink-dim)]">Every card opens a real route · statuses reflect verified evidence</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-[var(--m47-ink-dim)]">
            Project
            <select
              className="m47-select px-2 py-1.5 text-[11px]"
              value={projectId ?? ""}
              onChange={(e) => setProjectId(e.target.value || null)}
              aria-label="Active project for tool launches"
            >
              <option value="">No project selected</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        {error && <ErrorNote>{error}</ErrorNote>}

        <Panel className="mb-5 p-4">
          <PanelHead title="Inventory honesty" />
          <div className="flex flex-wrap gap-2 pb-2">
            {counts.map(({ status, n }) => (
              <button
                key={status}
                onClick={() => setFilter(filter === status ? "ALL" : status)}
                className={`m47-chip ${filter === status ? "m47-chip-gold" : ""}`}
                title={`Show only ${status} tools`}
              >
                {status}: {n}
              </button>
            ))}
            <button onClick={() => setFilter("ALL")} className={`m47-chip ${filter === "ALL" ? "m47-chip-gold" : ""}`}>All: {catalog.flatMap((c) => c.tools).length}</button>
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--m47-ink-mid)]">
            Statuses come from verified evidence, not from the existence of an API route. READY = implemented and executed
            against real media in a test battery on file. BETA = usable with the documented limitation shown on the card.
            CONFIGURATION REQUIRED = the real integration needs environment/provider setup. PLANNED = not implemented.
            Tools execute through the existing backend — this hub adds no second renderer, queue or editor.
          </p>
        </Panel>

        {catalog.map((cat) => {
          const tools = cat.tools.filter((t) => filter === "ALL" || t.status === filter);
          if (tools.length === 0) return null;
          return (
            <section key={cat.id} className="mb-7" aria-label={cat.title}>
              <div className="mb-2.5">
                <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--m47-gold-soft)]">{cat.title}</h2>
                <p className="mt-0.5 text-[11px] text-[var(--m47-ink-dim)]">{cat.blurb}</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {tools.map((t) => (
                  <Panel key={t.id} className="flex flex-col p-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-[13px] font-bold text-[var(--m47-ink)]">{t.name}</h3>
                      <StatusBadge s={statusBadge(t.status)}>{t.status}</StatusBadge>
                    </div>
                    <p className="mt-1.5 flex-1 text-[11.5px] leading-relaxed text-[var(--m47-ink-mid)]">{t.summary}</p>
                    <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--m47-ink-dim)]"><span className="font-bold uppercase tracking-[0.1em]">Backed by</span> {t.backedBy}</p>
                    {t.caveat && <p className="mt-1 text-[10px] leading-relaxed text-[var(--m47-warn)]">⚠ {t.caveat}</p>}
                    {t.evidence && <p className="mt-1 text-[10px] leading-relaxed text-[var(--m47-ink-dim)]"><span className="font-bold uppercase tracking-[0.1em]">Evidence</span> {t.evidence}</p>}
                    <div className="mt-2.5">
                      {t.launch ? (
                        <Btn variant="primary" onClick={() => go(t.launch!.href)} title={`Opens ${t.launch.href}`}>{t.launch.label}</Btn>
                      ) : (
                        <span className="text-[10.5px] text-[var(--m47-ink-dim)]">No launch route — see status.</span>
                      )}
                    </div>
                  </Panel>
                ))}
              </div>
            </section>
          );
        })}

        <footer className="border-t border-[var(--m47-line)] py-5 text-[10px] leading-relaxed text-[var(--m47-ink-dim)]">
          Creative Tools Hub (M47.1) — routes into the canonical studio surfaces. Ownership and project guards are enforced
          server-side on every execution path; private media is never uploaded to external providers without the configured
          gateway contract. <a className="text-[var(--m47-gold-soft)] hover:underline" href="/open-source">Open Source &amp; Credits</a> ·{" "}
          <a className="text-[var(--m47-gold-soft)] hover:underline" href="/legal">Legal Center</a>
        </footer>
      </main>
    </div>
  );
}
