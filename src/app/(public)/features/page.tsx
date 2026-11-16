import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Features — BEAN FX",
  description: "The BEAN FX professional editor: multitrack timeline, program monitor, effects, audio automation, captions, AI Studio with five AI engines, and validated long-form export.",
  alternates: { canonical: "/features" },
};

const ENGINES = [
  { name: "RIISHE", text: "Silence removal and audio-first cleanup. RIISHE analyzes your own speech tracks and proposes reversible cut ranges — every proposed edit is a real timeline command you can review, apply and undo." },
  { name: "GANGZII", text: "B-roll and visual intelligence. GANGZII tracks subjects across frames, searches your own library semantically, and generates or suggests visual assets against your real project context." },
  { name: "NIIKI", text: "Motion graphics and lower thirds. NIIKI renders template-driven graphics — bars, cards, titles — with anchors, animation and exit modes, as timeline clips with real export parity." },
  { name: "JAZMII", text: "AI generation for images, video and voice (TTS) and transcription (ASR). JAZMII calls configured providers from the server only; generated assets land in your media library with provenance." },
  { name: "LAXII", text: "Script and planning assistant. LAXII drafts scripts, storyboards and scene plans from your briefs, feeding MY AI's plan assembly." },
  { name: "MY AI", text: "The coordinator. MY AI reads your project and selection context, proposes edits across the five engines, and executes only the operations you approve — every approved operation is a reversible timeline command with undo/redo." },
];

export default function FeaturesPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d4a017]">Product</p>
      <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">What BEAN FX actually does</h1>
      <p className="mt-4 max-w-3xl text-[15px] leading-relaxed text-[#b8b8b0]">
        BEAN FX is a browser-based editing workspace: a multitrack timeline, a program monitor, an effects and
        color panel, per-clip and per-track audio controls with keyframe automation, captions and motion graphics,
        an AI Studio built from five named engines, and a durable render/export pipeline validated on real
        ten-minute multitrack jobs.
      </p>

      <h2 className="mt-12 text-2xl font-bold text-white">The professional editor</h2>
      <ul className="mt-5 grid gap-4 text-[14px] leading-relaxed text-[#b8b8b0] sm:grid-cols-2">
        <li className="rounded-lg border border-[#1c1c1a] bg-[#101010] p-4"><span className="font-bold text-white">Timeline.</span> Multiple video and audio tracks, ripple edits, group moves, split, trim, transitions, and a 500-clip stress-tested project model with versioned autosave.</li>
        <li className="rounded-lg border border-[#1c1c1a] bg-[#101010] p-4"><span className="font-bold text-white">Program monitor.</span> A shared playback clock with frame stepping, seeking, and a Web Audio mixer that schedules clip gain, fades, pan and volume automation.</li>
        <li className="rounded-lg border border-[#1c1c1a] bg-[#101010] p-4"><span className="font-bold text-white">Project &amp; media browser.</span> Import video, audio and images; probe analysis runs in background workers; media placement is probe-aware.</li>
        <li className="rounded-lg border border-[#1c1c1a] bg-[#101010] p-4"><span className="font-bold text-white">Properties inspector.</span> Volume, pan, mute, speed, effects and a volume-automation strip — add, move and remove keyframes with undo/redo and reload-safe persistence.</li>
        <li className="rounded-lg border border-[#1c1c1a] bg-[#101010] p-4"><span className="font-bold text-white">Effects &amp; color.</span> Brightness, contrast, saturation, exposure, temperature, tint, highlights, shadows, whites, blacks, vignette, crop, sharpen and more — pixel-verified on the export path.</li>
        <li className="rounded-lg border border-[#1c1c1a] bg-[#101010] p-4"><span className="font-bold text-white">Export.</span> Durable render jobs with progress, cancellation and FFprobe validation; long sequences render as frame-aligned windows stitched losslessly.</li>
      </ul>

      <h2 className="mt-12 text-2xl font-bold text-white">The AI engines</h2>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {ENGINES.map((e) => (
          <section key={e.name} className="rounded-lg border border-[#1c1c1a] bg-[#101010] p-4">
            <h3 className="text-[13px] font-bold tracking-[0.14em] text-[#d4a017]">{e.name}</h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-[#b8b8b0]">{e.text}</p>
          </section>
        ))}
      </div>

      <h2 className="mt-12 text-2xl font-bold text-white">Honest limitations</h2>
      <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-[#8f8f8a]">
        AI features call external providers from the server; they run only when a provider is configured, and
        every provider call is metered and consent-gated. Approximate preview parity is documented per effect —
        see the FAQ and Privacy Policy for what that means for your data.
      </p>
    </div>
  );
}
