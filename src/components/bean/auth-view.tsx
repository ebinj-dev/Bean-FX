"use client";

/**
 * M45-A — BEAN FX premium authentication experience (login / register /
 * password recovery) over the EXISTING auth system: /api/auth/login,
 * /api/auth/register, /api/auth/reset-password, /api/auth/me. No second
 * identity system, no demo bypass. Sessions persist 14 days via the secure
 * server cookie (the "remember me" behavior is the deployment default and
 * is stated honestly).
 */

import { useState } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, Clapperboard, Eye, EyeOff, Film, Loader2, Music, Sparkles, Wand2 } from "lucide-react";
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
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Password recovery: token + new password (the token arrives by email when
  // SMTP is configured; the deployment discloses honestly when it is not).
  const [resetToken, setResetToken] = useState("");

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const passwordValid = password.length >= 8 && /[A-Za-z]/.test(password) && /[0-9A-Za-z]/.test(password);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      if (mode === "forgot") {
        if (!resetToken.trim()) {
          setError("Enter the reset token from your recovery email. No email service is configured on this deployment — contact the operator for a token if you cannot access yours.");
          return;
        }
        const res = await fetch("/api/auth/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: resetToken.trim(), password }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setError(data?.error ?? `Request failed (${res.status}).`);
          return;
        }
        setInfo(data?.message ?? "Password updated — please sign in again.");
        setMode("login");
        return;
      }
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
      if (data?.user) {
        onAuthed(data.user);
      } else {
        setError("Unexpected response from the server.");
      }
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError(null);
    setInfo(null);
  };

  return (
    <div className="flex min-h-screen bg-[#050505]">
      {/* Brand panel — BEAN FX identity, hidden on small screens */}
      <aside className="relative hidden w-[44%] flex-col justify-between overflow-hidden border-r border-[#161616] bg-gradient-to-br from-[#0a0a09] via-[#0d0c08] to-[#050505] p-10 lg:flex">
        <div className="pointer-events-none absolute -right-24 top-1/4 h-72 w-72 rounded-full bg-[#d4a017]/10 blur-3xl" />
        <div className="pointer-events-none absolute -left-16 bottom-10 h-56 w-56 rounded-full bg-[#d4a017]/5 blur-3xl" />
        <a href="#/" aria-label="BEAN FX home" className="relative z-10 w-fit">
          <BeanLogo />
        </a>
        <div className="relative z-10">
          <h2 className="max-w-md text-3xl font-extrabold leading-tight tracking-tight text-white">
            An entire production studio,
            <span className="text-[#d4a017]"> in one conversation.</span>
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-[#8f8f8a]">
            Describe the video you want. The AI crew writes, plans, edits and renders real
            deliverables — then hands you every frame in a professional editor.
          </p>
          <ul className="mt-8 flex flex-col gap-3.5">
            {[
              { icon: Sparkles, text: "RIISHE and the specialist crew build your production plan" },
              { icon: Film, text: "Real timelines, real renders, real deliverables — no mockups" },
              { icon: Wand2, text: "Chat-controlled editing with full manual override" },
              { icon: Music, text: "Your footage stays private and on your terms" },
            ].map((row) => (
              <li key={row.text} className="flex items-start gap-3 text-[13px] text-[#a8a8a0]">
                <row.icon className="mt-0.5 h-4 w-4 shrink-0 text-[#d4a017]" />
                {row.text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative z-10 text-[11px] text-[#55555a]">
          BEAN FX Production · Sessions persist for 14 days · Passwords are salted scrypt hashes
        </p>
      </aside>

      {/* Form panel */}
      <main className="flex flex-1 flex-col">
        <header className="flex h-16 items-center border-b border-[#161616] px-5 lg:hidden">
          <a href="#/" aria-label="BEAN FX home">
            <BeanLogo />
          </a>
        </header>
        <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
          <div className="w-full max-w-[420px]">
            <div className="rounded-2xl border border-[#1e1e1c] bg-[#0c0c0b]/90 p-7 shadow-[0_24px_80px_-24px_rgba(212,160,23,0.12)] backdrop-blur sm:p-8">
              <div className="mb-1 flex items-center gap-2 lg:hidden">
                <Clapperboard className="h-4 w-4 text-[#d4a017]" />
                <span className="bean-label text-[10px] text-[#7a7a76]">BEAN FX PRODUCTION</span>
              </div>
              <h1 className="text-[22px] font-extrabold tracking-tight text-white">
                {mode === "login" ? "Welcome back" : mode === "register" ? "Start your studio" : "Recover access"}
              </h1>
              <p className="mt-1.5 text-[13px] text-[#8f8f8a]">
                {mode === "login"
                  ? "Sign in to your productions, media library and the editing suite."
                  : mode === "register"
                    ? "Create an account to brief the AI crew and produce real videos."
                    : "Set a new password with your recovery token."}
              </p>

              {notice && (
                <p className="mt-4 rounded-lg border border-[#2e2410] bg-[#161007] px-3 py-2 text-xs leading-relaxed text-[#d4a017]">
                  {notice}
                </p>
              )}

              <form onSubmit={submit} className="mt-6 flex flex-col gap-4" noValidate>
                {mode === "register" && (
                  <Field label="Name (optional)">
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="auth-input"
                      placeholder="Creator name"
                      autoComplete="name"
                    />
                  </Field>
                )}
                {mode !== "forgot" && (
                  <Field label="Email">
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="auth-input"
                      placeholder="you@studio.com"
                      autoComplete="email"
                      aria-invalid={email.length > 3 && !emailValid}
                    />
                    {email.length > 3 && !emailValid && (
                      <span className="mt-1 block text-[11px] text-[#f87171]">Enter a valid email address.</span>
                    )}
                  </Field>
                )}
                {mode === "forgot" && (
                  <Field label="Recovery token">
                    <input
                      type="text"
                      required
                      value={resetToken}
                      onChange={(e) => setResetToken(e.target.value)}
                      className="auth-input font-mono"
                      placeholder="Paste the token from your recovery email"
                      autoComplete="one-time-code"
                    />
                  </Field>
                )}
                <Field label={mode === "forgot" ? "New password" : "Password"}>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      required
                      minLength={mode === "forgot" ? 8 : undefined}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="auth-input pr-10"
                      placeholder={mode === "login" ? "••••••••" : "8+ characters, letters and numbers"}
                      autoComplete={mode === "login" ? "current-password" : "new-password"}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-[#6a6a64] transition-colors hover:text-[#d4a017]"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      title={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {mode !== "login" && password.length > 0 && !passwordValid && (
                    <span className="mt-1 block text-[11px] text-[#f87171]">
                      Use at least 8 characters with letters and a number.
                    </span>
                  )}
                </Field>

                {error && (
                  <p className="flex items-start gap-2 rounded-lg border border-[#3b1515] bg-[#1a0d0d] px-3 py-2 text-xs leading-relaxed text-[#f87171]">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {error}
                  </p>
                )}
                {info && (
                  <p className="flex items-start gap-2 rounded-lg border border-[#153b1e] bg-[#0d1a10] px-3 py-2 text-xs leading-relaxed text-[#4cc47f]">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {info}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={busy || (mode === "login" && (!emailValid || password.length === 0)) || (mode === "register" && (!emailValid || !passwordValid))}
                  className="bean-glow inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#d4a017] text-[12px] font-extrabold uppercase tracking-[0.14em] text-[#0c0c0c] transition-colors hover:bg-[#e9b52a] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {mode === "login" ? "Sign in" : mode === "register" ? "Create account" : "Update password"}
                  {!busy && mode !== "forgot" && <ArrowRight className="h-4 w-4" strokeWidth={2.5} />}
                </button>
              </form>

              <div className="mt-5 flex flex-col gap-2 border-t border-[#1c1c1c] pt-4 text-xs">
                {mode !== "forgot" ? (
                  <>
                    <button
                      onClick={() => switchMode(mode === "login" ? "register" : "login")}
                      className="text-left font-semibold text-[#8f8f8a] transition-colors hover:text-white"
                    >
                      {mode === "login" ? (
                        <>
                          New to BEAN FX? <span className="text-[#d4a017]">Create an account</span>
                        </>
                      ) : (
                        <>
                          Already registered? <span className="text-[#d4a017]">Sign in</span>
                        </>
                      )}
                    </button>
                    {mode === "login" && (
                      <button
                        onClick={() => switchMode("forgot")}
                        className="text-left text-[#6a6a64] transition-colors hover:text-[#a8a8a0]"
                      >
                        Forgot your password?
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    onClick={() => switchMode("login")}
                    className="text-left font-semibold text-[#8f8f8a] transition-colors hover:text-white"
                  >
                    ← Back to sign in
                  </button>
                )}
                {mode === "forgot" && (
                  <p className="mt-1 leading-relaxed text-[#55555a]">
                    Email delivery is not configured on this deployment — recovery tokens cannot be
                    emailed. Contact the operator, or register a new account. Your data stays private.
                  </p>
                )}
              </div>
            </div>

            <p className="mt-5 text-center text-[11px] leading-relaxed text-[#55555a]">
              By continuing you agree that uploaded media is processed only for your own productions.
              <br />
              Sessions persist for 14 days on this device.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="bean-label text-[10px] text-[#8f8f8a]">{label.toUpperCase()}</span>
      {children}
    </label>
  );
}

export type AuthMode = "login" | "register" | "forgot";
