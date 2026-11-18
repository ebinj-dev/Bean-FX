"use client";
/**
 * M19 §10 — Account settings. Profile, security (password + sessions),
 * privacy (AI disclosure, data export, account deletion) and storage usage.
 * Every action calls the real account APIs; nothing here is decorative.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Profile = { id: string; email: string; name: string | null; createdAt: string; emailVerified: boolean; role?: string | null };
type SessionRow = { id: string; current: boolean; createdAt: string; lastSeenAt: string | null };
type Storage = { bytesUsed: number; quotaBytes: number | null; uploads: number; projects: number; exports: number };
/** M24 §3.I — integration tokens (API v1 / MCP / Desktop Bridge). Same contract as /api/account/tokens. */
type IntegrationTokenRow = { id: string; prefix: string; name: string; scopes: string[]; createdAt: string; expiresAt: string | null; revokedAt: string | null };
type HealthInfo = { status?: string; checks?: Record<string, { ok: boolean; detail?: string }> };

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

/** The published integration scopes (src/lib/core/types.ts TOKEN_SCOPES). */
const SCOPES = ["projects:read", "projects:write", "jobs:submit", "jobs:read", "jobs:cancel", "media:upload", "mcp:invoke"] as const;

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
  // M24 §3.I — integration token manager state.
  const [tokens, setTokens] = useState<IntegrationTokenRow[]>([]);
  const [tokName, setTokName] = useState("");
  const [tokScopes, setTokScopes] = useState<string[]>(["projects:read", "jobs:read"]);
  const [tokTtl, setTokTtl] = useState("");
  const [tokRaw, setTokRaw] = useState<string | null>(null);
  const [tokMsg, setTokMsg] = useState<string | null>(null);
  const [tokBusy, setTokBusy] = useState(false);
  // M24 §6 — honest system status (public health + admin ops).
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [adminHealth, setAdminHealth] = useState<HealthInfo | null>(null);

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

  /** M24 §3.I — load integration tokens + public health alongside the rest. */
  const refreshIntegrations = useCallback(async () => {
    const t = await fetch("/api/account/tokens");
    if (t.ok) setTokens(((await t.json()) as { tokens: IntegrationTokenRow[] }).tokens);
    try { setHealth((await (await fetch("/api/health")).json()) as HealthInfo); } catch { setHealth(null); }
  }, []);

  useEffect(() => {
    // Defer past the sync phase: refresh() sets state after its awaits; the
    // react-hooks compiler flags direct invocation in the effect body.
    const t = setTimeout(() => void refresh(), 0);
    const t2 = setTimeout(() => void refreshIntegrations(), 0);
    return () => { clearTimeout(t); clearTimeout(t2); };
  }, [refresh, refreshIntegrations]);

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

  // ── M24 §3.I — integration token management (real /api/account/tokens CRUD).
  const createToken = async () => {
    setTokMsg(null);
    setTokRaw(null);
    setTokBusy(true);
    try {
      const res = await fetch("/api/account/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: tokName.trim().slice(0, 80),
          scopes: tokScopes,
          ...(tokTtl ? { ttlDays: Math.max(1, Math.min(365, Number(tokTtl) || 30)) } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { rawToken?: string; error?: string };
      if (res.ok && body.rawToken) {
        setTokRaw(body.rawToken); // shown exactly once; never stored client-side
        setTokName("");
        void refreshIntegrations();
      } else {
        setTokMsg(body.error ?? `Creation failed (${res.status}).`);
      }
    } finally {
      setTokBusy(false);
    }
  };

  const revokeToken = async (id: string) => {
    const res = await fetch(`/api/account/tokens?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    setTokMsg(res.ok ? "Token revoked — it stops working immediately." : `Revoke failed (${res.status}).`);
    if (res.ok) void refreshIntegrations();
  };

  /** Admin-only operational status (route is server-gated as well). */
  const loadAdminStatus = async () => {
    const [h, j] = await Promise.all([fetch("/api/admin/health"), fetch("/api/admin/jobs")]);
    let next: HealthInfo | null = null;
    if (h.ok) {
      const hb = (await h.json().catch(() => ({}))) as { health?: HealthInfo };
      next = hb.health ?? null;
    }
    if (j.ok) {
      const jb = (await j.json().catch(() => ({}))) as { jobs?: { status: string; _count?: { id: number } }[] };
      const lines = (jb.jobs ?? []).map((r) => `${r.status}: ${r._count?.id ?? 0}`).join(" · ");
      next = { ...(next ?? {}), checks: { ...(next?.checks ?? {}), queue: { ok: true, detail: lines || "no jobs" } } };
    }
    setAdminHealth(next ?? { status: "unavailable" });
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

      {/* M24 §3.I — Integrations: API v1 / MCP / Desktop Bridge token management
          + status. Same design language; every control calls the real APIs. */}
      <section className={card} aria-labelledby="integrations-h">
        <h2 id="integrations-h" className="text-sm font-semibold text-[#d8d8d2]">Integrations — API, MCP &amp; Desktop Bridge</h2>
        <p className="mt-2 text-xs leading-relaxed text-[#8f8f8a]">
          Integration tokens authenticate external clients against API v1 (<code className="text-[#b8b8b2]">/api/v1/*</code>), the MCP transport
          (<code className="text-[#b8b8b2]">/api/v1/mcp</code>, <code className="text-[#b8b8b2]">/api/automation/mcp</code>) and the local Desktop Bridge.
          Tokens are stored hashed — the full value is shown <strong>once</strong> at creation and can be revoked instantly.
        </p>

        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[160px] flex-1">
              <span className={label}>Token name</span>
              <input aria-label="Token name" className={`${input} mt-1`} placeholder="e.g. premiere-panel" value={tokName} onChange={(e) => setTokName(e.target.value)} maxLength={80} />
            </div>
            <div className="w-24">
              <span className={label}>TTL days</span>
              <input aria-label="Token lifetime in days (optional)" className={`${input} mt-1`} placeholder="∞" value={tokTtl} onChange={(e) => setTokTtl(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))} />
            </div>
          </div>
          <div>
            <span className={label}>Scopes</span>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-xs text-[#b8b8b2]">
                  <input
                    type="checkbox"
                    checked={tokScopes.includes(s)}
                    onChange={(e) => setTokScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
                  />
                  <code className="text-[11px]">{s}</code>
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btn} onClick={createToken} disabled={tokBusy || !tokName.trim() || tokScopes.length === 0}>
              {tokBusy ? "Creating…" : "Create token"}
            </button>
            <span className="text-[11px] text-[#8f8f8a]">{tokens.length} token{tokens.length === 1 ? "" : "s"}</span>
          </div>
          {tokRaw && (
            <div role="status" className="rounded-lg border border-[#d4a017]/40 bg-[#d4a017]/5 p-2">
              <p className={label}>Copy now — shown once</p>
              <p className="mt-1 break-all font-mono text-xs text-[#e8e8e2]">{tokRaw}</p>
            </div>
          )}
          {tokMsg && <p className="text-xs text-[#8f8f8a]" role="status">{tokMsg}</p>}
          <ul className="space-y-1.5">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 rounded-lg border border-[#2a2a26] px-3 py-2 text-xs text-[#b8b8b2]">
                <span className="min-w-0 flex-1 truncate">
                  <strong className="text-[#e8e8e2]">{t.name}</strong> · <code className="text-[11px] text-[#8f8f8a]">{t.prefix}…</code> · {t.scopes.join(", ")}
                  {" · "}created {new Date(t.createdAt).toLocaleDateString()}
                  {t.expiresAt ? ` · expires ${new Date(t.expiresAt).toLocaleDateString()}` : ""}
                  {t.revokedAt && <span className="ml-1 rounded border border-[#c45c4c]/40 px-1 text-[10px] text-[#c45c4c]">REVOKED</span>}
                </span>
                {!t.revokedAt && <button type="button" className="text-[#c45c4c] hover:underline" onClick={() => revokeToken(t.id)}>Revoke</button>}
              </li>
            ))}
            {tokens.length === 0 && <li className="text-xs text-[#8f8f8a]">No integration tokens yet.</li>}
          </ul>
        </div>

        <div className="mt-4 border-t border-[#2a2a26] pt-3">
          <span className={label}>Connection guide &amp; API status</span>
          <ul className="mt-1 space-y-1 text-xs leading-relaxed text-[#8f8f8a]">
            <li><strong className="text-[#b8b8b2]">API v1:</strong> <code>/api/v1/projects</code>, <code>/api/v1/jobs</code>, <code>/api/v1/projects/&#123;id&#125;/canonical</code> — auth: <code>Authorization: Bearer bfx_…</code>. Capability descriptor: <code>GET /api/v1/capabilities</code>.</li>
            <li><strong className="text-[#b8b8b2]">MCP:</strong> JSON-RPC 2.0 at <code>POST /api/v1/mcp</code> — initialize → tools/list (8 shared tools) → tools/call. Mutations require one-time approvals created in the editor MY AI panel. Legacy transport: <code>/api/automation/mcp</code>.</li>
            <li><strong className="text-[#b8b8b2]">Desktop Bridge:</strong> run <code>bun desktop-bridge.ts</code> locally (Windows Credential Manager-backed), pair with a token, loopback-only. Full guide in the repo docs.</li>
            <li><strong className="text-[#b8b8b2]">Premiere Pro:</strong> load the UXP extension (repo: <code>src/integrations/premiere-panel</code>) via Adobe UXP Developer Tool; point it at this deployment with an integration token.</li>
            <li>Service status: {health ? <span className="text-emerald-400">{health.status ?? "ok"}</span> : <span className="text-amber-400">unavailable</span>}</li>
          </ul>
        </div>
      </section>

      {/* M24 §6 — admin operational status (admin routes are server-gated). */}
      {profile.role === "admin" && (
        <section className={card} aria-labelledby="sysstatus-h">
          <h2 id="sysstatus-h" className="text-sm font-semibold text-[#d8d8d2]">System status (admin)</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className={btn} onClick={loadAdminStatus}>Load operational status</button>
          </div>
          {adminHealth && (
            <div className="mt-2 text-xs text-[#b8b8b2]">
              {Object.entries(adminHealth.checks ?? {}).map(([k, v]) => (
                <p key={k}>
                  <span className={v.ok ? "text-emerald-400" : "text-[#c45c4c]"}>{v.ok ? "OK" : "FAIL"}</span> {k}{v.detail ? ` — ${v.detail}` : ""}
                </p>
              ))}
              {!adminHealth.checks && <p className="text-[#8f8f8a]">{adminHealth.status ?? "no data"}</p>}
            </div>
          )}
        </section>
      )}

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
