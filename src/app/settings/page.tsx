"use client";
/**
 * M19 §10 — Account settings. Profile, security (password + sessions),
 * privacy (AI disclosure, data export, account deletion) and storage usage.
 * Every action calls the real account APIs; nothing here is decorative.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Profile = { id: string; email: string; name: string | null; createdAt: string; emailVerified: boolean };
type SessionRow = { id: string; current: boolean; createdAt: string; lastSeenAt: string | null };
type Storage = { bytesUsed: number; quotaBytes: number | null; uploads: number; projects: number; exports: number };

const fmtBytes = (n: number | null) => {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
};

const card = "rounded-2xl border border-[#2a2a26] bg-[#141412]/80 p-5";
const label = "text-[11px] uppercase tracking-[0.14em] text-[#8f8f8a]";
const btn = "rounded-lg border border-[#d4a017]/40 bg-[#d4a017]/10 px-3 py-1.5 text-xs font-medium text-[#d4a017] hover:bg-[#d4a017]/20 disabled:opacity-40";
const btnDanger = "rounded-lg border border-[#c45c4c]/40 bg-[#c45c4c]/10 px-3 py-1.5 text-xs font-medium text-[#c45c4c] hover:bg-[#c45c4c]/20 disabled:opacity-40";
const input = "w-full rounded-lg border border-[#2a2a26] bg-[#0d0d0b] px-3 py-2 text-sm text-[#e8e8e2] outline-none focus:border-[#d4a017]/60";

export default function SettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [name, setName] = useState("");
  const [nameMsg, setNameMsg] = useState<string | null>(null);
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [delPw, setDelPw] = useState("");
  const [delConfirm, setDelConfirm] = useState(false);
  const [delMsg, setDelMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [a, s, sess] = await Promise.all([
      fetch("/api/account"), fetch("/api/account/storage"), fetch("/api/auth/sessions"),
    ]);
    if (a.status === 401) { setProfile(null); setLoading(false); return; }
    const aj = (await a.json()) as { profile: Profile };
    setProfile(aj.profile);
    setName(aj.profile.name ?? "");
    if (s.ok) setStorage((await s.json()) as Storage);
    if (sess.ok) setSessions(((await sess.json()) as { sessions: SessionRow[] }).sessions);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveName = async () => {
    setNameMsg(null);
    const res = await fetch("/api/account", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    setNameMsg(res.ok ? "Display name saved." : `Save failed (${res.status}).`);
    if (res.ok) void refresh();
  };

  const changePw = async () => {
    setPwMsg(null);
    const res = await fetch("/api/auth/change-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: curPw, newPassword: newPw }) });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setPwMsg(res.ok
      ? "Password changed. Other sessions were signed out."
      : body.error ?? `Change failed (${res.status}).`);
    if (res.ok) { setCurPw(""); setNewPw(""); void refresh(); }
  };

  const revoke = async (id: string) => {
    const res = await fetch(`/api/auth/sessions?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) void refresh();
  };

  const exportData = async () => {
    const res = await fetch("/api/account/export-data");
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "beanfx-account-export.json"; a.click();
    URL.revokeObjectURL(url);
  };

  const deleteAccount = async () => {
    setDelMsg(null);
    const res = await fetch("/api/account/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: delPw, confirm: delConfirm }) });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.ok) {
      window.location.href = "/";
      return;
    }
    setDelMsg(body.error ?? `Deletion failed (${res.status}).`);
  };

  if (loading) return <main className="mx-auto max-w-3xl px-6 py-16 text-sm text-[#8f8f8a]">Loading…</main>;
  if (!profile) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-2xl font-semibold text-[#e8e8e2]">Account settings</h1>
        <p className="mt-3 text-sm text-[#8f8f8a]">Please <Link className="text-[#d4a017] underline" href="/login">sign in</Link> to manage your account.</p>
      </main>
    );
  }

  const pct = storage?.quotaBytes ? Math.min(100, Math.round((storage.bytesUsed / storage.quotaBytes) * 100)) : null;

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <header>
        <h1 className="text-2xl font-semibold text-[#e8e8e2]">Account settings</h1>
        <p className="mt-1 text-xs text-[#8f8f8a]">Signed in as {profile.email} · member since {new Date(profile.createdAt).toLocaleDateString()}</p>
      </header>

      {/* Profile */}
      <section className={card} aria-labelledby="profile-h">
        <h2 id="profile-h" className="text-sm font-semibold text-[#d8d8d2]">Profile</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <span className={label}>Email</span>
            <p className="mt-1 text-sm text-[#e8e8e2]">{profile.email}{" "}{profile.emailVerified
              ? <span className="ml-1 rounded border border-emerald-500/40 px-1 text-[10px] text-emerald-400">VERIFIED</span>
              : <span className="ml-1 rounded border border-amber-500/40 px-1 text-[10px] text-amber-400">UNVERIFIED</span>}</p>
          </div>
          <div>
            <span className={label}>Display name</span>
            <div className="mt-1 flex gap-2">
              <input aria-label="Display name" className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
              <button type="button" className={btn} onClick={saveName}>Save</button>
            </div>
            {nameMsg && <p className="mt-1 text-xs text-[#8f8f8a]">{nameMsg}</p>}
          </div>
        </div>
      </section>

      {/* Security */}
      <section className={card} aria-labelledby="security-h">
        <h2 id="security-h" className="text-sm font-semibold text-[#d8d8d2]">Security</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <span className={label}>Change password</span>
            <input aria-label="Current password" type="password" className={`${input} mt-1`} placeholder="Current password" value={curPw} onChange={(e) => setCurPw(e.target.value)} />
            <input aria-label="New password" type="password" className={`${input} mt-2`} placeholder="New password (min 10 chars)" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
            <button type="button" className={`${btn} mt-2`} onClick={changePw} disabled={!curPw || !newPw}>Update password</button>
            {pwMsg && <p className="mt-1 text-xs text-[#8f8f8a]" role="status">{pwMsg}</p>}
          </div>
          <div>
            <span className={label}>Active sessions</span>
            <ul className="mt-1 space-y-2">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-center justify-between rounded-lg border border-[#2a2a26] px-3 py-2 text-xs text-[#b8b8b2]">
                  <span>{s.current ? "This session" : `Session ${s.id.slice(-6)}`} · {new Date(s.createdAt).toLocaleString()}</span>
                  {!s.current && <button type="button" className="text-[#c45c4c] hover:underline" onClick={() => revoke(s.id)}>Sign out</button>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Privacy */}
      <section className={card} aria-labelledby="privacy-h">
        <h2 id="privacy-h" className="text-sm font-semibold text-[#d8d8d2]">Privacy</h2>
        <p className="mt-2 text-xs leading-relaxed text-[#8f8f8a]">
          Local editing, preview and export run on our servers without external AI providers. AI features (MY AI, RIISHE, GANGZII,
          NIIKI, JAZMII, LAXII, COMPOSE) send only the content you explicitly submit — prompts, small subject crops or generated
          assets — to our configured provider for processing. See the <Link className="text-[#d4a017] underline" href="/privacy">Privacy Policy</Link> for details.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={btn} onClick={exportData}>Export my data (JSON)</button>
          <Link className={btn} href="/privacy">Privacy Policy</Link>
        </div>
      </section>

      {/* Storage */}
      <section className={card} aria-labelledby="storage-h">
        <h2 id="storage-h" className="text-sm font-semibold text-[#d8d8d2]">Storage</h2>
        {storage ? (
          <div className="mt-2 text-xs text-[#b8b8b2]">
            <p>Used: <strong>{fmtBytes(storage.bytesUsed)}</strong>{storage.quotaBytes ? <> of {fmtBytes(storage.quotaBytes)} ({pct}%)</> : " · quota not enforced on this deployment"}</p>
            <p className="mt-1">{storage.uploads} uploads · {storage.projects} projects · {storage.exports} exports</p>
            {pct !== null && <div className="mt-2 h-1.5 w-full rounded bg-[#2a2a26]"><div className="h-1.5 rounded bg-[#d4a017]" style={{ width: `${pct}%` }} /></div>}
          </div>
        ) : <p className="mt-2 text-xs text-[#8f8f8a]">Usage unavailable.</p>}
      </section>

      {/* Deletion */}
      <section className={`${card} border-[#c45c4c]/30`} aria-labelledby="delete-h">
        <h2 id="delete-h" className="text-sm font-semibold text-[#c45c4c]">Delete account</h2>
        <p className="mt-2 text-xs leading-relaxed text-[#8f8f8a]">
          Deleting removes your access immediately and signs out every session. Your profile, projects, timelines, uploads and
          exports are queued for permanent cleanup. Media already referenced by other users is not removed. This cannot be undone.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input aria-label="Confirm password" type="password" className={`${input} max-w-xs`} placeholder="Confirm with your password" value={delPw} onChange={(e) => setDelPw(e.target.value)} />
          <label className="flex items-center gap-2 text-xs text-[#b8b8b2]">
            <input type="checkbox" checked={delConfirm} onChange={(e) => setDelConfirm(e.target.checked)} />
            I understand this is permanent
          </label>
          <button type="button" className={btnDanger} onClick={deleteAccount} disabled={!delPw || !delConfirm}>Delete my account</button>
        </div>
        {delMsg && <p className="mt-2 text-xs text-[#c45c4c]" role="alert">{delMsg}</p>}
      </section>
    </main>
  );
}
