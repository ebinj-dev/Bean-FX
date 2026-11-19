"use client";
/** M30 §3/§5/§6 — external review page (#/review/<token>). Guest session +
 * real review-media playback with frame-accurate comments and decisions.
 * Guests act strictly within the shared revision — the server enforces it. */
import { useCallback, useEffect, useRef, useState } from "react";

type LinkView = {
  revision: { id: string; sessionNo: number; versionNumber: number; fingerprint: string; status: string; title: string; instruction: string | null; dueAt: string | null };
  permission: "VIEW" | "COMMENT" | "APPROVE";
  expiresAt: string;
  unresolvedComments: number;
  previewUrl: string | null;
  passwordRequired?: boolean;
};
type Comment = { id: string; parentId: string | null; guestName: string | null; authorUserId: string | null; frame: number | null; fpsNum: number | null; fpsDen: number | null; timeSeconds: number | null; body: string; status: string; createdAt: string };

export function ReviewLinkView({ token }: { token: string }) {
  const [view, setView] = useState<LinkView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [joined, setJoined] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [text, setText] = useState("");
  const [frame, setFrame] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [currentFrame, setCurrentFrame] = useState<number | null>(null);
  const [decided, setDecided] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const busy = useRef(false);

  const loadView = useCallback(async (pw?: string) => {
    const q = pw ? `?password=${encodeURIComponent(pw)}` : "";
    const r = await fetch(`/api/reviews/link/${encodeURIComponent(token)}${q}`).then((x) => x.json()).catch(() => null);
    if (r?.revision) { setView(r); setNeedsPassword(false); }
    else if (r?.passwordRequired) setNeedsPassword(true);
    else setError(r?.error ?? "This review link is no longer valid.");
  }, [token]);

  const loadComments = useCallback(async () => {
    if (!view) return;
    const r = await fetch(`/api/reviews/link/${encodeURIComponent(token)}`).then((x) => x.json()).catch(() => null);
    if (r?.revision) {
      const detail = await fetch(`/api/reviews/${r.revision.id}`).then((x) => x.json()).catch(() => null);
      if (detail?.comments) setComments(detail.comments);
    }
  }, [token, view]);

  // Async fetch-and-set (network), not a synchronous cascading render.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadView(); }, [loadView]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (view?.previewUrl) void loadComments();
  }, [view, loadComments]);

  const join = async () => {
    if (busy.current) return;
    busy.current = true;
    const r = await fetch(`/api/reviews/link/${encodeURIComponent(token)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: displayName.trim(), password: password || undefined }),
    });
    const json = await r.json().catch(() => null);
    busy.current = false;
    if (r.ok) { setJoined(true); await loadView(password || undefined); }
    else setError(json?.error ?? "Could not open the review session.");
  };

  /** Frame identity = integer frame in the canonical timebase (30fps default
   * for these packages); seconds are only derived for the player seek. */
  const currentFrameFromPlayer = (): number => {
    const v = videoRef.current;
    if (!v) return 0;
    return Math.round((v.currentTime || 0) * 30);
  };

  const seekToFrame = (f: number, fpsNum: number | null, fpsDen: number | null) => {
    const v = videoRef.current;
    if (!v) return;
    const fps = fpsNum && fpsDen ? fpsNum / fpsDen : 30;
    v.currentTime = Math.max(0, f / fps);
    void v.play().catch(() => undefined);
  };

  const postComment = async () => {
    if (!view || busy.current || !text.trim()) return;
    busy.current = true;
    const f = frame.trim() === "" ? currentFrameFromPlayer() : Number(frame.trim());
    const r = await fetch(`/api/reviews/${view.revision.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: text.trim(), frame: f, fpsNum: 30, fpsDen: 1, parentId: replyTo ?? undefined }),
    });
    const json = await r.json().catch(() => null);
    busy.current = false;
    if (r.status === 201) { setText(""); setFrame(""); setReplyTo(null); void loadComments(); }
    else setError(json?.error ?? "Comment failed.");
  };

  const decide = async (decision: "APPROVE" | "REQUEST_CHANGES" | "REJECT") => {
    if (!view || busy.current) return;
    busy.current = true;
    const r = await fetch(`/api/reviews/${view.revision.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const json = await r.json().catch(() => null);
    busy.current = false;
    if (r.ok) { setDecided(json.decision); }
    else setError(json?.error ?? "Decision failed.");
  };

  if (error && !needsPassword) {
    return <div className="mx-auto mt-24 max-w-md rounded border border-[#2a2a2a] bg-[#0b0b0a] p-6 text-sm text-[#e05c5c]">{error}</div>;
  }

  // Identity gate FIRST (no unauthenticated impersonation): the guest joins
  // with a display name (+ optional link password) before anything renders.
  if (!joined || !view) {
    return (
      <div className="mx-auto mt-24 max-w-md rounded border border-[#2a2a2a] bg-[#0b0b0a] p-6 text-sm text-[#d8d8d2]">
        <div className="bean-label mb-3 text-[10px] text-[#d4a017]">CLIENT REVIEW</div>
        {view && (
          <div className="mb-2 text-xs text-[#8f8f8a]">
            Session #{view.revision.sessionNo} · {view.revision.title} · {view.revision.status} · permission: {view.permission}
          </div>
        )}
        {error && <p className="mb-2 text-[#e05c5c]">{error}</p>}
        {needsPassword && (
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Review password"
            className="mb-2 w-full rounded border border-[#2a2a2a] bg-[#111] px-2 py-1.5 outline-none focus:border-[#d4a017]" />
        )}
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name (shown to the team)"
          className="mb-2 w-full rounded border border-[#2a2a2a] bg-[#111] px-2 py-1.5 outline-none focus:border-[#d4a017]" />
        <button type="button" onClick={join} disabled={!displayName.trim()}
          className="w-full rounded border border-[#d4a017] px-3 py-1.5 text-[#d4a017] disabled:opacity-40">Open review</button>
      </div>
    );
  }

  const unresolved = comments.filter((c) => !c.parentId && c.status === "OPEN").length;

  return (
    <div className="mx-auto max-w-3xl p-4 text-sm text-[#d8d8d2]">
      <div className="mb-3 rounded border border-[#2a2a2a] bg-[#0b0b0a] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="bean-label text-[10px] text-[#d4a017]">CLIENT REVIEW — SESSION #{view.revision.sessionNo}</div>
          <span className="text-[10px] text-[#8f8f8a]">revision v{view.revision.versionNumber} · fp {view.revision.fingerprint.slice(0, 8)} · {view.revision.status}</span>
        </div>
        <h1 className="mt-1 text-base text-[#f5f5f0]">{view.revision.title}</h1>
        {view.revision.instruction && <p className="mt-1 text-xs text-[#8f8f8a]">{view.revision.instruction}</p>}
        <p className="mt-1 text-[10px] text-[#8f8f8a]">Reviewing as <strong>{displayName}</strong> ({view.permission}) · {unresolved} unresolved comments · expires {new Date(view.expiresAt).toLocaleDateString()}</p>
      </div>

      {view.previewUrl ? (
        <video ref={videoRef} controls playsInline src={view.previewUrl} className="w-full rounded border border-[#2a2a2a] bg-black"
          onTimeUpdate={(e) => setCurrentFrame(Math.round((e.currentTarget.currentTime || 0) * 30))} />
      ) : (
        <div className="rounded border border-[#2a2a2a] bg-[#0b0b0a] p-6 text-center text-[#8f8f8a]">The review preview is still rendering — refresh in a moment.</div>
      )}

      <div className="mt-3 rounded border border-[#2a2a2a] bg-[#0b0b0a] p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="bean-label text-[10px] text-[#d4a017]">COMMENTS (FRAME-ACCURATE)</span>
          <span className="text-[10px] text-[#8f8f8a]">playhead: frame {currentFrame ?? "—"}</span>
        </div>
        <div className="max-h-64 space-y-1.5 overflow-y-auto">
          {comments.length === 0 && <p className="text-xs text-[#8f8f8a]">No comments yet — pause the video and leave the first one.</p>}
          {comments.filter((c) => !c.parentId).map((c) => (
            <div key={c.id} className="rounded border border-[#2a2a2a] p-2">
              <div className="flex items-center justify-between text-[10px] text-[#8f8f8a]">
                <span>{c.authorUserId ? "member" : c.guestName} · {c.frame !== null ? `frame ${c.frame} (${(c.timeSeconds ?? 0).toFixed(2)}s)` : "general"}</span>
                <span className={c.status === "RESOLVED" ? "text-[#7dc45f]" : ""}>{c.status}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
              <div className="mt-1 flex gap-3 text-[10px]">
                {c.frame !== null && <button type="button" onClick={() => seekToFrame(c.frame!, c.fpsNum, c.fpsDen)} className="text-[#d4a017]">go to frame</button>}
                <button type="button" onClick={() => setReplyTo(c.id)} className="text-[#d4a017]">reply</button>
              </div>
              {comments.filter((x) => x.parentId === c.id).map((x) => (
                <div key={x.id} className="mt-1.5 border-l border-[#d4a017]/40 pl-2 text-xs">
                  <span className="text-[10px] text-[#8f8f8a]">{x.authorUserId ? "member" : x.guestName}:</span> {x.body}
                </div>
              ))}
            </div>
          ))}
        </div>
        {view.permission !== "VIEW" && (
          <div className="mt-2 space-y-1.5">
            {replyTo && <div className="text-[10px] text-[#d4a017]">replying — <button type="button" onClick={() => setReplyTo(null)} className="underline">cancel</button></div>}
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={`Comment at the current playhead (frame ${currentFrame ?? 0})…`} rows={2} maxLength={4000}
              className="w-full resize-none rounded border border-[#2a2a2a] bg-[#111] px-2 py-1.5 outline-none focus:border-[#d4a017]" />
            <div className="flex gap-1.5">
              <input value={frame} onChange={(e) => setFrame(e.target.value)} placeholder="frame # (blank = playhead)" inputMode="numeric"
                className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#111] px-2 py-1.5 outline-none focus:border-[#d4a017]" />
              <button type="button" onClick={postComment} disabled={!text.trim()}
                className="shrink-0 rounded border border-[#d4a017] px-2.5 py-1.5 text-[#d4a017] disabled:opacity-40">Comment</button>
            </div>
          </div>
        )}
        {view.permission === "APPROVE" && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-[#2a2a2a] pt-2">
            {decided ? (
              <span className="text-xs text-[#7dc45f]">Decision recorded: {decided}. Thank you.</span>
            ) : (
              <>
                <button type="button" onClick={() => void decide("APPROVE")} className="rounded border border-[#7dc45f] px-3 py-1.5 text-xs text-[#7dc45f]">Approve</button>
                <button type="button" onClick={() => void decide("REQUEST_CHANGES")} className="rounded border border-[#e0803c] px-3 py-1.5 text-xs text-[#e0803c]">Request changes</button>
                <button type="button" onClick={() => void decide("REJECT")} className="rounded border border-[#e05c5c] px-3 py-1.5 text-xs text-[#e05c5c]">Reject</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
