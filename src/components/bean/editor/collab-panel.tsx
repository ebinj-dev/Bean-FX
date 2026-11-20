"use client";
/**
 * M30 §9 — collaboration panel (drawer content). Follows the existing BEAN FX
 * drawer conventions (black/yellow, bean-label sections) — no redesign.
 * Sections: WORKSPACE · INVITE · REVIEWS · COMMENTS · LINKS.
 * All authorization is server-side; the UI merely reflects what the API
 * allows and renders honest errors.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Notice = (msg: string) => void;

type Workspace = { id: string; name: string; role: string; memberCount: number; projectCount: number };
type Member = { id: string; role: string; user: { id: string; email: string; name: string | null } };
type Invitation = { id: string; email: string; role: string; state: string; expiresAt: string };
type Revision = {
  id: string; sessionNo: number; versionNumber: number; fingerprint: string; status: string;
  title: string; instruction: string | null; dueAt: string | null; approvalPolicy: string;
  approvedAt: string | null; createdAt: string; previewReady: boolean; previewDurationSec: number | null;
  commentCount: number;
  decisions: { state: string; reviewerUserId: string | null; guestName: string | null; decidedAt: string | null }[];
};
type Comment = {
  id: string; parentId: string | null; authorUserId: string | null; guestName: string | null;
  frame: number | null; fpsNum: number | null; fpsDen: number | null; timeSeconds: number | null;
  body: string; status: string; editCount: number; createdAt: string;
};
type LinkRow = { id: string; state: string; permission: string; expiresAt: string; accessCount: number; lastAccessAt: string | null; createdAt: string };

async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T | null }> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function fmtFrame(c: { frame: number | null; fpsNum: number | null; fpsDen: number | null }): string {
  if (c.frame === null || c.frame === undefined) return "";
  const fps = c.fpsNum && c.fpsDen ? c.fpsNum / c.fpsDen : 30;
  const sec = c.frame / fps;
  return `frame ${c.frame} · ${sec.toFixed(2)}s`;
}

const STATUS_COLOR: Record<string, string> = {
  PROCESSING: "text-[#8f8f8a]",
  READY_FOR_REVIEW: "text-[#d4a017]",
  IN_REVIEW: "text-[#d4a017]",
  CHANGES_REQUESTED: "text-[#e0803c]",
  APPROVED: "text-[#7dc45f]",
  SUPERSEDED: "text-[#8f8f8a]",
  CANCELLED: "text-[#8f8f8a]",
  FAILED: "text-[#e05c5c]",
};

export function CollabPanel({ projectId, onNotice }: { projectId: string; onNotice: Notice }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [wsName, setWsName] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [activeWs, setActiveWs] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("REVIEWER");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [revTitle, setRevTitle] = useState("");
  const [revInstruction, setRevInstruction] = useState("");
  const [selectedRev, setSelectedRev] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentText, setCommentText] = useState("");
  const [commentFrame, setCommentFrame] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [linkPermission, setLinkPermission] = useState("COMMENT");
  const [linkPassword, setLinkPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const inviteUrlRef = useRef<HTMLTextAreaElement | null>(null);

  const loadWorkspaces = useCallback(async () => {
    const r = await api("GET", "/api/workspaces");
    setWorkspaces(r.json?.workspaces ?? []);
  }, []);

  const loadRevisions = useCallback(async () => {
    const r = await api("GET", `/api/projects/${projectId}/reviews`);
    setRevisions(r.json?.revisions ?? []);
    if (!selectedRev && r.json?.revisions?.length) setSelectedRev(r.json.revisions[0].id);
  }, [projectId, selectedRev]);

  const loadDetail = useCallback(async (revId: string) => {
    const r = await api("GET", `/api/reviews/${revId}`);
    if (r.json?.comments) setComments(r.json.comments);
    const l = await api("GET", `/api/reviews/${revId}/links`);
    if (l.json?.links) setLinks(l.json.links);
  }, []);

  useEffect(() => {
    // Async fetch-and-set (network calls) — the rule cannot see through the
    // async callbacks; suppression is scoped to these load invocations.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadWorkspaces();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRevisions();
  }, [projectId]);

  useEffect(() => {
    if (selectedRev) void loadDetail(selectedRev);
  }, [selectedRev]);

  const createWorkspace = async () => {
    if (!wsName.trim()) return;
    setBusy(true);
    const r = await api("POST", "/api/workspaces", { name: wsName.trim() });
    setBusy(false);
    if (r.status === 201) { setWsName(""); onNotice("Workspace created."); void loadWorkspaces(); }
    else onNotice(r.json?.error ?? "Workspace creation failed.");
  };

  const loadMembers = async (wsId: string) => {
    setActiveWs(wsId);
    const r = await api("GET", `/api/workspaces/${wsId}`);
    if (r.json?.members) { setMembers(r.json.members); setMyRole(r.json.myRole); setInvitations(r.json.invitations ?? []); }
  };

  const invite = async (wsId: string) => {
    setBusy(true);
    const r = await api("POST", `/api/workspaces/${wsId}/invitations`, { email: inviteEmail.trim().toLowerCase(), role: inviteRole });
    setBusy(false);
    if (r.status === 201) {
      setInviteUrl(`${window.location.origin}/${window.location.hash ? "" : ""}#/invite/${r.json.token}`);
      setDelivery(r.json.delivery?.emailSent ? "Email delivered." : `Email not configured on this deployment (${r.json.delivery?.reason ?? "smtp-missing"}) — share the link below.`);
      setInviteEmail("");
      onNotice("Invitation created.");
      void loadMembers(wsId);
    } else {
      setInviteUrl(null); setDelivery(null);
      onNotice(r.json?.error ?? "Invitation failed.");
    }
  };

  const createRevision = async () => {
    setBusy(true);
    const r = await api("POST", `/api/projects/${projectId}/reviews`, {
      title: revTitle.trim(),
      instruction: revInstruction.trim() || undefined,
      approvalPolicy: "ALL",
    });
    setBusy(false);
    if (r.status === 201) {
      setRevTitle(""); setRevInstruction("");
      onNotice(`Review session ${r.json.revision.sessionNo} submitted — the preview renders now.`);
      setSelectedRev(r.json.revision.id);
      void loadRevisions();
    } else onNotice(r.json?.error ?? "Review submission failed.");
  };

  const addComment = async () => {
    if (!selectedRev || !commentText.trim()) return;
    const frameNum = commentFrame.trim() === "" ? undefined : Number(commentFrame.trim());
    const payload: Record<string, unknown> = { body: commentText.trim(), parentId: replyTo ?? undefined };
    if (frameNum !== undefined) {
      if (!Number.isInteger(frameNum) || frameNum < 0) { onNotice("Frame must be a non-negative integer."); return; }
      // Canonical fps comes from the revision's sequence settings (30fps default
      // matches BEAN FX defaults; the API persists num/den alongside the frame).
      payload.frame = frameNum; payload.fpsNum = 30; payload.fpsDen = 1;
    }
    setBusy(true);
    const r = await api("POST", `/api/reviews/${selectedRev}/comments`, payload);
    setBusy(false);
    if (r.status === 201) {
      setCommentText(""); setReplyTo(null); setCommentFrame("");
      void loadDetail(selectedRev);
      void loadRevisions();
    } else onNotice(r.json?.error ?? "Comment failed.");
  };

  const patchComment = async (commentId: string, action: "RESOLVE" | "REOPEN") => {
    const r = await api("PATCH", `/api/reviews/${selectedRev}/comments`, { commentId, action });
    if (r.status === 200) { void loadDetail(selectedRev!); }
    else onNotice(r.json?.error ?? "Action not permitted.");
  };

  const decide = async (decision: "APPROVE" | "REQUEST_CHANGES") => {
    if (!selectedRev) return;
    setBusy(true);
    const r = await api("PUT", `/api/reviews/${selectedRev}`, { decision });
    setBusy(false);
    if (r.status === 200) { onNotice(`Decision recorded: ${decision}.`); void loadRevisions(); }
    else onNotice(r.json?.error ?? "Decision failed.");
  };

  const createLink = async () => {
    if (!selectedRev) return;
    setBusy(true);
    const r = await api("POST", `/api/reviews/${selectedRev}/links`, {
      permission: linkPermission,
      ttlHours: 336,
      password: linkPassword.trim() ? linkPassword : undefined,
    });
    setBusy(false);
    if (r.status === 201) {
      const url = `${window.location.origin}${window.location.hash ? "" : ""}#/review/${r.json.token}`;
      setInviteUrl(url);
      setDelivery("Review link created — anyone with the URL can review (within scope and expiry).");
      setLinkPassword("");
      void loadDetail(selectedRev);
    } else onNotice(r.json?.error ?? "Link creation failed.");
  };

  const revokeLink = async (linkId: string) => {
    const r = await api("DELETE", `/api/reviews/${selectedRev}/links?linkId=${linkId}`);
    if (r.status === 200) { void loadDetail(selectedRev!); onNotice("Link revoked — takes effect immediately."); }
    else onNotice(r.json?.error ?? "Revoke failed.");
  };

  const cancelRevision = async (revId: string) => {
    const r = await api("DELETE", `/api/reviews/${revId}`);
    if (r.status === 200) { void loadRevisions(); onNotice("Review cancelled."); }
    else onNotice(r.json?.error ?? "Cancel failed.");
  };

  const copyInvite = () => {
    if (inviteUrlRef.current) {
      inviteUrlRef.current.select();
      void navigator.clipboard?.writeText(inviteUrlRef.current.value).catch(() => undefined);
      onNotice("Copied.");
    }
  };

  return (
    <div className="space-y-3 text-xs text-[#d8d8d2]">
      {/* One-time capability URLs (invitations, review links) — always visible. */}
      {inviteUrl && (
        <section className="rounded border border-[#d4a017]/40 bg-[#1a1206] p-2" aria-label="One-time link">
          <div className="bean-label mb-1 text-[10px] text-[#d4a017]">ONE-TIME LINK — COPY NOW</div>
          <textarea ref={inviteUrlRef} readOnly value={inviteUrl} rows={2}
            className="w-full resize-none bg-transparent text-[10px] text-[#d4a017] outline-none" />
          <div className="mt-1 flex items-center gap-2">
            <button type="button" onClick={copyInvite} className="rounded border border-[#d4a017] px-2 py-1 text-[10px] text-[#d4a017]">Copy link</button>
            <span className="text-[10px] text-[#8f8f8a]">{delivery}</span>
          </div>
        </section>
      )}
      {/* WORKSPACE */}
      <section className="rounded border border-[#2a2a2a] p-2.5" aria-label="Team workspace">
        <div className="bean-label mb-1.5 text-[10px] text-[#d4a017]">TEAM WORKSPACE</div>
        {workspaces.length === 0 && <p className="mb-2 text-[#8f8f8a]">No workspace yet — create one to collaborate with editors and reviewers.</p>}
        <div className="space-y-1.5">
          {workspaces.map((w) => (
            <div key={w.id} className="flex items-center justify-between rounded border border-[#2a2a2a] px-2 py-1.5">
              <div className="min-w-0">
                <div className="truncate">{w.name}</div>
                <div className="text-[10px] text-[#8f8f8a]">your role: {w.role} · {w.memberCount} members · {w.projectCount} projects</div>
              </div>
              <button type="button" onClick={() => void loadMembers(w.id)} className="shrink-0 rounded border border-[#2a2a2a] px-2 py-1 text-[10px] hover:border-[#d4a017] hover:text-[#d4a017]">members</button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-1.5">
          <input value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="New workspace…" maxLength={120}
            className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#111] px-2 py-1.5 outline-none focus:border-[#d4a017]" />
          <button type="button" disabled={busy || !wsName.trim()} onClick={createWorkspace}
            className="shrink-0 rounded border border-[#d4a017] px-2.5 py-1.5 text-[#d4a017] disabled:opacity-40">Create</button>
        </div>
        {members.length > 0 && (
          <div className="mt-2 border-t border-[#2a2a2a] pt-2">
            <div className="mb-1 text-[10px] text-[#8f8f8a]">MEMBERS ({members.length}){myRole ? ` · you are ${myRole}` : ""}</div>
            {members.map((m) => (
              <div key={m.id} className="flex items-center justify-between py-0.5">
                <span className="min-w-0 truncate">{m.user.name ?? m.user.email} <span className="text-[#8f8f8a]">({m.role})</span></span>
              </div>
            ))}
            {invitations.length > 0 && (
              <div className="mt-1 text-[10px] text-[#8f8f8a]">Pending invites: {invitations.map((i) => `${i.email} (${i.role})`).join(", ")}</div>
            )}
            <div className="mt-2 space-y-1.5">
              <div className="flex gap-1.5">
                <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="collaborator@example.com" type="email"
                  className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#111] px-2 py-1.5 outline-none focus:border-[#d4a017]" />
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}
                  className="rounded border border-[#2a2a2a] bg-[#111] px-1.5 py-1.5 outline-none focus:border-[#d4a017]" aria-label="Invite role">
                  {["ADMIN", "EDITOR", "REVIEWER", "VIEWER"].map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
              <button type="button" disabled={busy || !inviteEmail.trim() || !activeWs} onClick={() => activeWs && void invite(activeWs)}
                className="w-full rounded border border-[#d4a017] px-2.5 py-1.5 text-[#d4a017] disabled:opacity-40">Send invitation</button>
            </div>
          </div>
        )}
      </section>

      {/* REVIEWS */}
      <section className="rounded border border-[#2a2a2a] p-2.5" aria-label="Review sessions">
        <div className="bean-label mb-1.5 text-[10px] text-[#d4a017]">REVIEW SESSIONS</div>
        <div className="space-y-1.5">
          <input value={revTitle} onChange={(e) => setRevTitle(e.target.value)} placeholder="Review title (e.g. Cut v2 — client check)" maxLength={160}
            className="w-full rounded border border-[#2a2a2a] bg-[#111] px-2 py-1.5 outline-none focus:border-[#d4a017]" />
          <textarea value={revInstruction} onChange={(e) => setRevInstruction(e.target.value)} placeholder="Instructions for reviewers (optional)" rows={2} maxLength={4000}
            className="w-full resize-none rounded border border-[#2a2a2a] bg-[#111] px-2 py-1.5 outline-none focus:border-[#d4a017]" />
          <button type="button" disabled={busy || !revTitle.trim()} onClick={createRevision}
            className="w-full rounded border border-[#d4a017] px-2.5 py-1.5 text-[#d4a017] disabled:opacity-40">Submit review session (locks an immutable revision)</button>
        </div>
        <div className="mt-2 space-y-1.5">
          {revisions.length === 0 && <p className="text-[#8f8f8a]">No review sessions yet.</p>}
          {revisions.map((r) => (
            <button type="button" key={r.id} onClick={() => setSelectedRev(r.id)}
              className={`block w-full rounded border px-2 py-1.5 text-left ${selectedRev === r.id ? "border-[#d4a017]" : "border-[#2a2a2a]"}`}>
              <div className="flex items-center justify-between">
                <span className="min-w-0 truncate">#{r.sessionNo} · {r.title}</span>
                <span className={`ml-2 shrink-0 text-[10px] ${STATUS_COLOR[r.status] ?? "text-[#8f8f8a]"}`}>{r.status}</span>
              </div>
              <div className="text-[10px] text-[#8f8f8a]">v{r.versionNumber} · fp {r.fingerprint.slice(0, 8)} · {r.commentCount} comments · {r.decisions.filter((d) => d.state !== "PENDING").length}/{r.decisions.length} decided</div>
            </button>
          ))}
        </div>
      </section>

      {/* COMMENTS + DECISION + LINKS for the selected revision */}
      {selectedRev && (
        <section className="rounded border border-[#2a2a2a] p-2.5" aria-label="Review comments">
          <div className="bean-label mb-1.5 text-[10px] text-[#d4a017]">COMMENTS (SELECTED SESSION)</div>
          <div className="mb-2 flex flex-wrap gap-1.5">
            <button type="button" onClick={() => void decide("APPROVE")} disabled={busy} className="rounded border border-[#7dc45f] px-2 py-1 text-[10px] text-[#7dc45f] disabled:opacity-40">Approve</button>
            <button type="button" onClick={() => void decide("REQUEST_CHANGES")} disabled={busy} className="rounded border border-[#e0803c] px-2 py-1 text-[10px] text-[#e0803c] disabled:opacity-40">Request changes</button>
            <button type="button" onClick={() => void cancelRevision(selectedRev)} disabled={busy} className="rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-[#8f8f8a] disabled:opacity-40">Cancel session</button>
          </div>
          <div className="max-h-56 space-y-1.5 overflow-y-auto">
            {comments.length === 0 && <p className="text-[#8f8f8a]">No comments yet.</p>}
            {comments.filter((c) => !c.parentId).map((c) => (
              <div key={c.id} className="rounded border border-[#2a2a2a] p-2">
                <div className="flex items-center justify-between text-[10px] text-[#8f8f8a]">
                  <span>{c.authorUserId ? "member" : `guest ${c.guestName ?? ""}`} · {fmtFrame(c) || "general"}</span>
                  <span className={c.status === "RESOLVED" ? "text-[#7dc45f]" : ""}>{c.status}{c.editCount > 0 ? ` · edited×${c.editCount}` : ""}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
                <div className="mt-1 flex gap-2 text-[10px]">
                  <button type="button" onClick={() => setReplyTo(c.id)} className="text-[#d4a017]">reply</button>
                  {c.status === "OPEN"
                    ? <button type="button" onClick={() => void patchComment(c.id, "RESOLVE")} className="text-[#8f8f8a]">resolve</button>
                    : <button type="button" onClick={() => void patchComment(c.id, "REOPEN")} className="text-[#8f8f8a]">reopen</button>}
                </div>
                {comments.filter((x) => x.parentId === c.id).map((x) => (
                  <div key={x.id} className="mt-1.5 border-l border-[#d4a017]/40 pl-2">
                    <div className="text-[10px] text-[#8f8f8a]">{x.authorUserId ? "member" : `guest ${x.guestName ?? ""}`} · {fmtFrame(x) || "reply"}</div>
                    <p className="whitespace-pre-wrap">{x.body}</p>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="mt-2 space-y-1.5">
            {replyTo && <div className="text-[10px] text-[#d4a017]">replying to a comment — <button type="button" onClick={() => setReplyTo(null)} className="underline">cancel</button></div>}
            <textarea value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Write a review comment…" rows={2} maxLength={4000}
              className="w-full resize-none rounded border border-[#2a2a2a] bg-[#111] px-2 py-1.5 outline-none focus:border-[#d4a017]" />
            <div className="flex gap-1.5">
              <input value={commentFrame} onChange={(e) => setCommentFrame(e.target.value)} placeholder="frame # (optional, e.g. 90)" inputMode="numeric"
                className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#111] px-2 py-1.5 outline-none focus:border-[#d4a017]" />
              <button type="button" disabled={busy || !commentText.trim()} onClick={addComment}
                className="shrink-0 rounded border border-[#d4a017] px-2.5 py-1.5 text-[#d4a017] disabled:opacity-40">Comment</button>
            </div>
          </div>
        </section>
      )}

      {selectedRev && (
        <section className="rounded border border-[#2a2a2a] p-2.5" aria-label="Review links">
          <div className="bean-label mb-1.5 text-[10px] text-[#d4a017]">REVIEW LINKS</div>
          <div className="flex gap-1.5">
            <select value={linkPermission} onChange={(e) => setLinkPermission(e.target.value)}
              className="rounded border border-[#2a2a2a] bg-[#111] px-1.5 py-1.5 outline-none focus:border-[#d4a017]" aria-label="Link permission">
              <option value="VIEW">VIEW only</option>
              <option value="COMMENT">VIEW + comment</option>
              <option value="APPROVE">VIEW + comment + approve</option>
            </select>
            <input value={linkPassword} onChange={(e) => setLinkPassword(e.target.value)} placeholder="optional password (≥6)" type="password"
              className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#111] px-2 py-1.5 outline-none focus:border-[#d4a017]" />
            <button type="button" disabled={busy} onClick={createLink} className="shrink-0 rounded border border-[#d4a017] px-2.5 py-1.5 text-[#d4a017] disabled:opacity-40">Create link</button>
          </div>
          <div className="mt-2 space-y-1">
            {links.length === 0 && <p className="text-[#8f8f8a]">No external links.</p>}
            {links.map((l) => (
              <div key={l.id} className="flex items-center justify-between rounded border border-[#2a2a2a] px-2 py-1">
                <span className="text-[10px]">{l.permission} · {l.state} · {l.accessCount} views{l.lastAccessAt ? ` · last ${new Date(l.lastAccessAt).toLocaleString()}` : ""}</span>
                {l.state === "ACTIVE" && (
                  <button type="button" onClick={() => void revokeLink(l.id)} className="text-[10px] text-[#e05c5c]">revoke</button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
