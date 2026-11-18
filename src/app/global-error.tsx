"use client";

/**
 * Root client error boundary (Next.js app router). Without this, an uncaught
 * render error anywhere in the tree unmounts the whole app and the preview
 * shows a blank dark screen. This keeps the BEAN FX shell visible, shows the
 * real error, and offers a retry — errors are never hidden.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#050505] text-[#e6e6e0] antialiased">
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="font-mono text-[11px] tracking-[0.3em] text-[#d4a017]">BEAN FX</div>
          <h1 className="text-lg font-semibold">Something went wrong rendering the app.</h1>
          <p className="max-w-lg text-xs leading-relaxed text-[#8f8f8a]">
            The error below is shown unfiltered — it is also written to the server console. Retry the render or reload the page.
          </p>
          <pre className="max-w-xl overflow-auto rounded border border-[#2a2a2a] bg-[#0d0d0c] p-3 text-left text-[10px] leading-relaxed text-[#c9c4b8]">
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ""}
          </pre>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={reset}
              className="rounded border border-[#d4a017] px-4 py-2 text-xs font-semibold text-[#d4a017] hover:bg-[#d4a017]/10"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded border border-[#2a2a2a] px-4 py-2 text-xs text-[#8f8f8a] hover:text-[#e6e6e0]"
            >
              Reload page
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
