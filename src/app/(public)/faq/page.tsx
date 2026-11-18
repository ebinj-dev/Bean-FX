import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FAQ — BEAN FX",
  description: "What BEAN FX does, how the editor works, supported media, AI generation and data handling, exports, account security and deletion.",
  alternates: { canonical: "/faq" },
};

const QA = [
  ["What is BEAN FX?", "A browser-based professional video editor: you import your own media, cut it on a multitrack timeline, apply effects and audio automation, add captions and graphics, use AI assistance where configured, and export finished videos through a validated render pipeline."],
  ["How does the editor work?", "Everything runs on a versioned timeline: every edit is a reversible command (split, ripple delete, move, gain, automation keyframes), undo/redo is per-command, and the project autosaves with full version history you can reload."],
  ["What media is supported?", "Video (MP4/H.264 family), audio files, and images for stills and graphics. Each upload is probed by a background worker; placement waits for the probe so durations and streams are known before the clip lands on the timeline."],
  ["Does AI generation exist, and what happens to my data?", "AI features run only when a provider is configured on the server. When you consent, text-only requests (and, for specific visual features, small subject crops) are sent to that provider; results are metered. The Privacy Policy lists the exact categories."],
  ["Where is my data stored?", "On the server that runs BEAN FX: your account row in the database, your projects and timelines as versioned JSON, and your media files in server-side storage with per-user paths. Nothing is stored in your browser beyond the session cookie."],
  ["What do cookies do here?", "One essential httpOnly session cookie keeps you signed in. There are no analytics, advertising or third-party tracking cookies — see the Cookie Policy."],
  ["Can I export long videos?", "Yes. Renders run as durable background jobs with progress and cancellation. Long sequences render as frame-aligned windows stitched losslessly; a ten-minute multitrack export has been validated end-to-end with FFprobe."],
  ["Is my account secure?", "Passwords are hashed with scrypt; sessions are httpOnly cookies with server-side revocation; login, registration and password resets are rate-limited; password changes sign out other sessions; deleted accounts are locked out immediately."],
  ["How do I delete my account?", "Account → Privacy → Delete account. You re-authenticate, confirm, and every session is revoked immediately. Physical cleanup of storage runs deferred with reference checks so shared assets stay intact — the retention exceptions are listed in the Privacy Policy."],
  ["Is billing available?", "Not yet — the product does not accept payments. The Pricing page will only present real plans once billing actually exists."],
  ["Who do I contact?", "The Contact page lists bug-report, feature-request and security-report channels. If no support email is configured on this deployment, it says so honestly instead of showing a broken address."],
];

export default function FaqPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d4a017]">FAQ</p>
      <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">Frequently asked questions</h1>
      <div className="mt-8 space-y-4">
        {QA.map(([q, a]) => (
          <details key={q} className="rounded-lg border border-[#1c1c1a] bg-[#101010] p-4">
            <summary className="cursor-pointer text-[14.5px] font-bold text-white">{q}</summary>
            <p className="mt-3 text-[13.5px] leading-relaxed text-[#b8b8b0]">{a}</p>
          </details>
        ))}
      </div>
    </div>
  );
}
