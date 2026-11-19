"use client";
/** M30 §2 — invitation landing page (#/invite/<token>). Token-only capability:
 * preview the invitation, accept (bound to the logged-in account's email) or
 * reject. Honest delivery/expiry errors surface verbatim from the API. */
import { useCallback, useEffect, useState } from "react";

type Preview = { workspaceName: string; role: string; inviterName: string; email: string; expiresAt: string };
type Me = { user: { id: string; email: string; name: string | null } | null };

export function InviteView({ token }: { token: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [me, setMe] = useState<Me["user"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const p = await fetch(`/api/invitations/respond?token=${encodeURIComponent(token)}`).then((r) => r.json()).catch(() => null);
    if (p?.invitation) setPreview(p.invitation); else setError(p?.error ?? "This invitation is no longer valid.");
    const m = await fetch("/api/auth/me").then((r) => r.json()).catch(() => null);
    setMe(m?.user ?? null);
  }, [token]);

  // Async fetch-and-set (network), not a synchronous cascading render.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const act = async (action: "accept" | "reject") => {
    setBusy(true);
    const r = await fetch("/api/invitations/respond", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, action }),
    });
    const json = await r.json().catch(() => null);
    setBusy(false);
    if (r.ok) setDone(action === "accept" ? `You are now a member of "${json.workspace?.name ?? "the workspace"}" as ${json.role}.` : "Invitation declined.");
    else setError(json?.error ?? "Action failed.");
  };

  if (done) {
    return (
      <div className="mx-auto mt-24 max-w-md rounded border border-[#2a2a2a] bg-[#0b0b0a] p-6 text-center text-sm text-[#d8d8d2]">
        <div className="bean-label mb-2 text-[10px] text-[#d4a017]">INVITATION</div>
        <p>{done}</p>
        <a href="#/editor" className="mt-4 inline-block rounded border border-[#d4a017] px-3 py-1.5 text-[#d4a017]">Open the editor</a>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-24 max-w-md rounded border border-[#2a2a2a] bg-[#0b0b0a] p-6 text-sm text-[#d8d8d2]">
      <div className="bean-label mb-3 text-[10px] text-[#d4a017]">WORKSPACE INVITATION</div>
      {error && <p className="mb-3 text-[#e05c5c]">{error}</p>}
      {preview && (
        <div className="space-y-2">
          <p><span className="text-[#8f8f8a]">Workspace:</span> {preview.workspaceName}</p>
          <p><span className="text-[#8f8f8a]">Invited by:</span> {preview.inviterName} <span className="text-[#8f8f8a]">as</span> {preview.role}</p>
          <p><span className="text-[#8f8f8a]">Bound to email:</span> {preview.email}</p>
          <p><span className="text-[#8f8f8a]">Expires:</span> {new Date(preview.expiresAt).toLocaleString()}</p>
          {!me && (
            <div className="rounded border border-[#d4a017]/40 bg-[#1a1206] p-2 text-xs">
              You need to sign in as <strong>{preview.email}</strong> to accept. <a className="text-[#d4a017] underline" href={`#/login`}>Log in</a> or <a className="text-[#d4a017] underline" href="#/register">register</a>, then reopen this page.
            </div>
          )}
          {me && me.email.toLowerCase() !== preview.email.toLowerCase() && (
            <div className="rounded border border-[#e0803c]/40 bg-[#1a0d06] p-2 text-xs text-[#e0803c]">
              You are signed in as {me.email} — this invitation was issued for {preview.email} and cannot be accepted from this account.
            </div>
          )}
          {me && me.email.toLowerCase() === preview.email.toLowerCase() && (
            <div className="flex gap-2 pt-2">
              <button type="button" disabled={busy} onClick={() => void act("accept")} className="rounded border border-[#d4a017] px-3 py-1.5 text-[#d4a017] disabled:opacity-40">Accept</button>
              <button type="button" disabled={busy} onClick={() => void act("reject")} className="rounded border border-[#2a2a2a] px-3 py-1.5 text-[#8f8f8a] disabled:opacity-40">Reject</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
