"use client";

import { useState } from "react";
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";
import { BeanLogo } from "@/components/bean/logo";
import type { SessionUser } from "@/lib/types";

export function AuthView({
  initialMode,
  onAuthed,
  notice,
}: {
  initialMode: AuthMode;
  onAuthed: (user: SessionUser) => void;
  notice?: string;
}) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res =
        mode === "login"
          ? await fetch("/api/auth/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, password }),
            })
          : await fetch("/api/auth/register", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, password, name }),
            });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Request failed (${res.status}).`);
        return;
      }
      if (data?.user) onAuthed(data.user);
      else setError("Unexpected response from the server.");
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bean-hero-light flex min-h-screen flex-col bg-[#050505]">
      <header className="border-b border-[#1a1a1a]">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-4 sm:px-6">
          <a href="#/" aria-label="BEAN FX home">
            <BeanLogo />
          </a>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="rounded-xl border border-[#1e1e1e] bg-[#0d0d0d] p-7">
            <h1 className="text-xl font-extrabold tracking-tight text-white">
              {mode === "login" ? "LOGIN" : "CREATE ACCOUNT"}
            </h1>
            {notice && (
              <p className="mt-2 rounded-md border border-[#2e2410] bg-[#161007] px-3 py-2 text-xs leading-relaxed text-[#d4a017]">
                {notice}
              </p>
            )}
            <p className="mt-2 text-[13px] text-[#8f8f8a]">
              {mode === "login"
                ? "Sign in to open your studio, media library and editing tools."
                : "Register to import media, plan cuts and export results."}
            </p>

            <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
              {mode === "register" && (
                <label className="block">
                  <span className="bean-label text-[10px] text-[#8f8f8a]">NAME (OPTIONAL)</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="mt-1.5 h-10 w-full rounded-md border border-[#2a2a2a] bg-[#121212] px-3 text-sm text-white placeholder:text-[#555] focus:border-[#d4a017] focus:outline-none"
                    placeholder="Creator name"
                    autoComplete="name"
                  />
                </label>
              )}
              <label className="block">
                <span className="bean-label text-[10px] text-[#8f8f8a]">EMAIL</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1.5 h-10 w-full rounded-md border border-[#2a2a2a] bg-[#121212] px-3 text-sm text-white placeholder:text-[#555] focus:border-[#d4a017] focus:outline-none"
                  placeholder="you@studio.com"
                  autoComplete="email"
                />
              </label>
              <label className="block">
                <span className="bean-label text-[10px] text-[#8f8f8a]">PASSWORD</span>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1.5 h-10 w-full rounded-md border border-[#2a2a2a] bg-[#121212] px-3 text-sm text-white placeholder:text-[#555] focus:border-[#d4a017] focus:outline-none"
                  placeholder={mode === "register" ? "8+ chars, letters and numbers" : "••••••••"}
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                />
              </label>

              {error && (
                <p className="flex items-start gap-2 rounded-md border border-[#3b1515] bg-[#1a0d0d] px-3 py-2 text-xs leading-relaxed text-[#f87171]">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="bean-glow inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#d4a017] text-[12px] font-extrabold uppercase tracking-[0.14em] text-[#0c0c0c] transition-colors hover:bg-[#e9b52a] disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {mode === "login" ? "LOGIN" : "CREATE ACCOUNT"}
                {!busy && <ArrowRight className="h-4 w-4" strokeWidth={2.5} />}
              </button>
            </form>

            <div className="mt-5 border-t border-[#1c1c1c] pt-4">
              <button
                onClick={() => {
                  setMode(mode === "login" ? "register" : "login");
                  setError(null);
                }}
                className="text-xs font-semibold text-[#8f8f8a] transition-colors hover:text-white"
              >
                {mode === "login" ? (
                  <>
                    No account yet? <span className="text-[#d4a017]">Create one</span>
                  </>
                ) : (
                  <>
                    Already registered? <span className="text-[#d4a017]">Log in</span>
                  </>
                )}
              </button>
              <p className="mt-3 text-[11px] leading-relaxed text-[#55555a]">
                Password recovery requires an email service that is not configured in this deployment — contact the
                operator if you lose access.
              </p>
            </div>
          </div>

          <p className="mt-5 text-center text-[11px] text-[#55555a]">
            Sessions persist for 14 days. Passwords are stored as salted scrypt hashes.
          </p>
        </div>
      </main>
    </div>
  );
}

export type AuthMode = "login" | "register";
