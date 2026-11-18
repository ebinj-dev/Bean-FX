"use client";

/**
 * Route-level error boundary: catches render/data errors for a route segment
 * (including server-component failures) and renders a real error state inside
 * the app shell instead of a blank screen. The error message is shown as-is.
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="font-mono text-[10px] tracking-[0.3em] text-[#d4a017]">BEAN FX</div>
      <h1 className="text-base font-semibold text-[#e6e6e0]">This view failed to load.</h1>
      <p className="max-w-lg text-xs leading-relaxed text-[#8f8f8a]">
        The failure is real and reported below; nothing was hidden or retried silently.
      </p>
      <pre className="max-w-xl overflow-auto rounded border border-[#2a2a2a] bg-[#0d0d0c] p-3 text-left text-[10px] leading-relaxed text-[#c9c4b8]">
        {error.message}
        {error.digest ? `\n\ndigest: ${error.digest}` : ""}
      </pre>
      <button
        type="button"
        onClick={reset}
        className="rounded border border-[#d4a017] px-4 py-2 text-xs font-semibold text-[#d4a017] hover:bg-[#d4a017]/10"
      >
        Try again
      </button>
    </div>
  );
}
