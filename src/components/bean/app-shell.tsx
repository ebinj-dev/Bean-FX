"use client";

import { useCallback, useEffect, useState } from "react";
import { SiteHeader } from "@/components/bean/site-header";
import { LandingPage } from "@/components/bean/landing";
import { AuthView } from "@/components/bean/auth-view";
import { StudioDashboard } from "@/components/bean/studio-dashboard";
import { UploadGate, readMediaRef, clearMediaRef, type ToolUploadSpec } from "@/components/bean/upload-gate";
import { AutoCutTool } from "@/components/bean/tools/auto-cut";
import { CaptionsTool } from "@/components/bean/tools/captions";
import { WatermarkTool } from "@/components/bean/tools/watermark";
import { AudioTool } from "@/components/bean/tools/audio-tool";
import { BrollTool } from "@/components/bean/tools/broll";
import { EditorTool } from "@/components/bean/tools/editor";
import { InviteView } from "@/components/bean/invite-view";
import { ReviewLinkView } from "@/components/bean/review-link-view";
import type { SessionUser } from "@/lib/types";

function currentHashRoute(): string {
  // M15: hash routes may carry query params (e.g. #/editor?project=<id>) —
  // the route id is everything before the query separator.
  const h = window.location.hash.replace(/^#/, "").split("?")[0];
  if (!h || h === "/") return "/";
  return h.startsWith("/") ? h : `/${h}`;
}

export function AppShell() {
  const [route, setRoute] = useState<string>("/");
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  useEffect(() => {
    const onHash = () => {
      setRoute(currentHashRoute());
      window.scrollTo({ top: 0 });
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // 8 s timeout: a hung /api/auth/me (DB lock, dead upstream) must not hold
    // the shell on the spinner forever — treat it like signed-out and render
    // the landing page. Real failures were already treated the same way.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    fetch("/api/auth/me", { signal: controller.signal })
      .then((r) => r.json())
      .then((res) => {
        if (!cancelled) setUser(res?.user ?? null);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  const onAuthed = useCallback((u: SessionUser) => {
    setUser(u);
    window.location.hash = "#/editor";
  }, []);

  const onLogout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
      window.location.hash = "#/";
    }
  }, []);

  const openStudio = useCallback(() => {
    window.location.hash = "#/editor";
  }, []);

  const openLogin = useCallback(() => {
    window.location.hash = "#/login";
  }, []);

  // Loading state while the session check runs.
  if (user === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050505]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#2a2a2a] border-t-[#d4a017]" aria-label="Loading" />
      </div>
    );
  }

  const isWorkspaceRoute = ["/studio", "/editor", "/autocut", "/captions", "/watermark", "/audio", "/broll"].includes(route) || /^\/(autocut|captions|watermark|audio|broll)(\/editor)?$/.test(route);

  // Protected workspace routes require authentication.
  if (isWorkspaceRoute && !user) {
    return (
      <AuthView
        initialMode="login"
        onAuthed={onAuthed}
        notice="Sign in to access the BEAN FX studio and editing tools."
      />
    );
  }

  if (route === "/login" || route === "/register") {
    if (user) {
      return <RedirectToEditor />;
    }
    return <AuthView initialMode={route === "/register" ? "register" : "login"} onAuthed={onAuthed} />;
  }

  // M30: collaboration entry points (token capability pages).
  if (route.startsWith("/invite/")) {
    const token = route.slice("/invite/".length);
    return <InviteView token={token} />;
  }
  if (route.startsWith("/review/")) {
    const token = route.slice("/review/".length);
    return <ReviewLinkView token={token} />;
  }
  if (route === "/studio") {
    return <StudioDashboard user={user!} onLogout={onLogout} />;
  }

  if (route === "/editor") {
    return <EditorTool user={user!} onLogout={onLogout} />;
  }

  const toolSpecs: Record<string, ToolUploadSpec> = {
    autocut: {
      key: "autocut", label: "AUTO CUT", title: "Auto Cut",
      description: "Import a recording, get evidence-backed KEEP / REMOVE / REVIEW proposals, correct any wrong mark, and approve every cut before it is applied.",
      extensions: [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".mp4", ".mov", ".webm", ".mkv", ".m4v", ".jpg", ".jpeg", ".png", ".webp"],
      formatsLabel: "MP4, MOV, WebM, MKV, MP3, WAV, M4A, AAC, FLAC",
      streamNote: "Audio is required; video files are supported and their audio stream is used.",
      oneStep: true,
    },
    captions: {
      key: "captions", label: "CAPTIONS", title: "Captions",
      description: "Import media, transcribe or import subtitles, edit them against the real waveform, and export SRT/VTT.",
      extensions: [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".mp4", ".mov", ".webm", ".mkv", ".m4v", ".jpg", ".jpeg", ".png", ".webp"],
      formatsLabel: "MP4, MOV, WebM, MKV, MP3, WAV, M4A, AAC, FLAC",
      streamNote: "An audio stream is required for transcription; video files are supported.",
    },
    watermark: {
      key: "watermark", label: "WATERMARK", title: "Watermark Removal",
      description: "Import a video, mark the watermark region on the real preview, and export a cleaned copy.",
      extensions: [".mp4", ".mov", ".webm", ".mkv", ".m4v", ".jpg", ".jpeg", ".png", ".webp"],
      formatsLabel: "MP4, MOV, WebM, MKV, M4V (video only)",
      streamNote: "A video stream with known dimensions is required.",
    },
    audio: {
      key: "audio", label: "AUDIO", title: "Audio Studio",
      description: "Import audio, clean and shape it with real server-side processing, and export the result.",
      extensions: [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"],
      formatsLabel: "MP3, WAV, M4A, AAC, FLAC, OGG (audio only)",
      streamNote: "An audio stream is required.",
    },
    broll: {
      key: "broll", label: "B-ROLL", title: "B-Roll Library",
      description: "Import your main footage, build the B-roll library with notes, and get transcript-linked insertion suggestions.",
      extensions: [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".mp4", ".mov", ".webm", ".mkv", ".m4v", ".jpg", ".jpeg", ".png", ".webp"],
      formatsLabel: "MP4, MOV, WebM, MKV, MP3, WAV, M4A, AAC, FLAC",
      streamNote: "Main footage: video or audio. B-roll library items are uploaded inside the editor.",
    },
  };
  const editorMatch = route.match(/^\/(autocut|captions|watermark|audio|broll)\/editor$/);
  const gateMatch = route.match(/^\/(autocut|captions|watermark|audio|broll)$/);
  if (editorMatch) {
    const key = editorMatch[1];
    if (!readMediaRef(key)) {
      // Never open an editor with missing or invalid media.
      return <UploadGate user={user!} onLogout={onLogout} spec={toolSpecs[key]} />;
    }
  }
  if (gateMatch) {
    return <UploadGate user={user!} onLogout={onLogout} spec={toolSpecs[gateMatch[1]]} />;
  }
  if (editorMatch) {
    if (editorMatch[1] === "autocut") return <AutoCutTool key={route} user={user!} onLogout={onLogout} />;
    if (editorMatch[1] === "captions") return <CaptionsTool key={route} user={user!} onLogout={onLogout} />;
    if (editorMatch[1] === "watermark") return <WatermarkTool key={route} user={user!} onLogout={onLogout} />;
    if (editorMatch[1] === "audio") return <AudioTool key={route} user={user!} onLogout={onLogout} />;
    if (editorMatch[1] === "broll") return <BrollTool key={route} user={user!} onLogout={onLogout} />;
  }
  if (route === "/captions") return <CaptionsTool user={user!} onLogout={onLogout} />;
  if (route === "/watermark") return <WatermarkTool user={user!} onLogout={onLogout} />;
  if (route === "/audio") return <AudioTool user={user!} onLogout={onLogout} />;
  if (route === "/broll") return <BrollTool user={user!} onLogout={onLogout} />;

  // Landing page.
  return (
    <div className="flex min-h-screen flex-col bg-[#050505]">
      <SiteHeader currentRoute={route} onOpenStudio={openStudio} onLogin={openLogin} isAuthenticated={Boolean(user)} />
      <main className="flex-1">
        <LandingPage onOpenStudio={openStudio} onLogin={user ? undefined : openLogin} />
      </main>
    </div>
  );
}

/** Renders the same redirecting spinner while moving an authed user out of /login. */
function RedirectToEditor() {
  useEffect(() => {
    window.location.hash = "#/editor";
  }, []);
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#050505]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#2a2a2a] border-t-[#d4a017]" aria-label="Redirecting" />
    </div>
  );
}
