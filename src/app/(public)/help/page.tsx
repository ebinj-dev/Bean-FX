import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Help & Documentation — BEAN FX",
  description: "Getting started with BEAN FX: projects, media import, timeline editing, audio, captions, effects, AI Studio, exporting, troubleshooting.",
  alternates: { canonical: "/help" },
};

const SECTIONS: [string, string[]][] = [
  ["Getting started", [
    "Create an account from the homepage (GET STARTED → Create one). You land in the workspace: the media browser on the left, the program monitor center, the timeline below.",
    "Click the + button (top bar), type a project name, press Enter — the project opens immediately and autosaves as you work.",
  ]],
  ["Importing media", [
    "In the MEDIA panel use the import control to select video, audio or image files. Upload limits and file types are enforced server-side.",
    "Each upload is probed in the background (duration, streams). The asset card shows its status; place it once analysis finishes.",
  ]],
  ["Timeline editing", [
    "Press the V and A buttons above the timeline to add video and audio tracks.",
    "Place media with the asset's + place button. Use the toolbar tools (T = split, R = ripple delete) and drag to move clips. Every operation is undoable (⇤ / redo ⇥).",
    "Seek by clicking the time ruler; step frame-by-frame with the transport arrows.",
  ]],
  ["Audio editing", [
    "Select a clip and open the inspector's media tab: volume, pan, mute and playback speed.",
    "The VOLUME AUTOMATION strip under the volume slider takes keyframes: click to add a point at the playhead value, drag a diamond to move it, select and remove to delete. Automation is audible in preview and honored by exports.",
  ]],
  ["Captions & graphics", [
    "Add caption clips on a caption track and set text, size, color and position in the inspector.",
    "Graphics (lower thirds, titles) are NIIKI templates — pick a template, edit the text fields, and the graphic becomes a normal timeline clip.",
  ]],
  ["Effects & color", [
    "Open the EFFECTS panel with a clip selected. Color effects merge into the export encoder as a single eq chain; geometry effects (crop, vignette) are applied per segment.",
    "Preview and export are the same filter semantics; documented approximations exist per effect and are being measured continuously.",
  ]],
  ["AI Studio", [
    "AI STUDIO hosts MY AI plus the five engines (RIISHE, GANGZII, NIIKI, JAZMII, LAXII). MY AI reads your project and selection context and proposes edits; nothing applies without your approval, and approved operations are reversible timeline commands.",
    "AI features require a configured provider; when none is set, they are unavailable rather than simulated.",
  ]],
  ["Exporting", [
    "Open EXPORT, pick your range and submit. Renders are durable jobs: progress updates live, cancellation is honored, and finished files stay in your export history.",
    "Long sequences render in aligned windows and are stitched losslessly; a 10-minute multitrack export has been validated end-to-end.",
  ]],
  ["Troubleshooting", [
    "Media won't place: wait for the probe to finish (the card shows analysis status).",
    "Export failed: the job page shows a safe error code and a request ID — include both when contacting support.",
    "Signed out unexpectedly: sessions expire after 14 days of inactivity; sign in again.",
  ]],
  ["Account & privacy", [
    "Account settings (link in the app header) cover your profile, password change, active sessions, storage usage, data export and account deletion.",
    "See the Privacy Policy for exactly what is collected and what AI providers receive.",
  ]],
];

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d4a017]">Help</p>
      <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">Help &amp; documentation</h1>
      <div className="mt-8 space-y-8">
        {SECTIONS.map(([h, items]) => (
          <section key={h}>
            <h2 className="text-lg font-bold text-white">{h}</h2>
            <ul className="mt-2 list-disc space-y-2 pl-5 text-[14px] leading-relaxed text-[#b8b8b0]">
              {items.map((i) => <li key={i.slice(0, 24)}>{i}</li>)}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
