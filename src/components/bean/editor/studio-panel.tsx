"use client";

/**
 * Social Video Studio panel (M8.1 §12) — integrated topic→video workspace
 * inside the existing editor shell. Sections: CREATE (brief → plan),
 * SCRIPT (scene narration editing), STORYBOARD (scene visuals: assign /
 * generate JAZMII/LAXII), VOICE (TTS narration per scene), ASSEMBLE
 * (approval-gated timeline application + export handoff). Preserves the
 * BEAN FX visual language; publishing is NOT offered (no authorized
 * integrations exist).
 */
import { useCallback, useEffect, useState } from "react";
import { Clapperboard, Loader2, Wand2, Mic, Film, Layers, RefreshCw, Trash2, ArrowUp, ArrowDown, Plus } from "lucide-react";

interface StudioScene {
  id: string;
  sceneNumber: number;
  durationSec: number;
  narration: string;
  visualDescription: string;
  footageNeed: string;
  onScreenText: string;
  captionText: string;
  audioNote: string;
  transition: string;
  assetId: string | null;
  assetKind: string | null;
  assetSource: string;
  narrationAssetId: string | null;
  status: string;
}

interface PlanState {
  planId: string;
  projectId: string | null;
  status: string;
  plannerMode: string;
  topic: string;
  brief?: { topic?: string };
  scenes: StudioScene[];
  footage?: { stockSearchAvailable: boolean; note: string; alternatives: string[] };
}

interface MyMedia {
  id: string;
  originalName: string;
  kind: string;
  createdBy?: string | null;
}

type Tab = "create" | "script" | "storyboard" | "voice" | "assemble";

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export function StudioPanel({ onProjectCreated }: { onProjectCreated?: (projectId: string) => void }) {
  const [tab, setTab] = useState<Tab>("create");
  const [topic, setTopic] = useState("");
  const [language, setLanguage] = useState<"en" | "ta">("en");
  const [platform, setPlatform] = useState("youtube_shorts");
  const [durationSec, setDurationSec] = useState(45);
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("energetic, clear");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [plans, setPlans] = useState<{ planId: string; topic: string; status: string; plannerMode: string; sceneCount: number }[]>([]);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [media, setMedia] = useState<MyMedia[]>([]);
  const [batchTopics, setBatchTopics] = useState("");

  const refreshPlans = useCallback(async () => {
    try {
      const r = await jfetch<{ plans: { planId: string; topic: string; status: string; plannerMode: string; sceneCount: number }[] }>("/api/studio/plans");
      setPlans(r.plans);
    } catch {
      /* panel stays empty on failure */
    }
  }, []);

  const refreshMedia = useCallback(async () => {
    try {
      const r = await jfetch<{ media: MyMedia[] }>("/api/media");
      setMedia(r.media.slice(0, 60));
    } catch {
      /* panel works without the picker */
    }
  }, []);

  useEffect(() => {
    void refreshPlans();
    void refreshMedia();
  }, [refreshPlans, refreshMedia]);

  const openPlan = useCallback(async (planId: string) => {
    setBusy("open");
    try {
      const r = await jfetch<PlanState>(`/api/studio/plans/${planId}`);
      setPlan({ ...r, topic: r.brief?.topic ?? "(plan)" } as PlanState);
      setTab("script");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "open failed");
    } finally {
      setBusy(null);
    }
  }, []);

  const createPlan = useCallback(async () => {
    if (!topic.trim() || busy) return;
    setBusy("create");
    setNotice(null);
    try {
      const r = await jfetch<PlanState & { note: string; mode: string }>("/api/studio/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brief: { topic: topic.slice(0, 300), language, platform, durationSec, audience: audience.slice(0, 200), tone: tone.slice(0, 120) },
          projectId: null,
        }),
      });
      setPlan(r);
      setNotice(r.note);
      setTab("script");
      if (r.projectId && onProjectCreated) onProjectCreated(r.projectId);
      void refreshPlans();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "planning failed");
    } finally {
      setBusy(null);
    }
  }, [topic, language, platform, durationSec, audience, tone, busy, onProjectCreated, refreshPlans]);

  const sceneAction = useCallback(async (sceneId: string, action: string, extra: Record<string, unknown> = {}) => {
    if (!plan || busy) return;
    setBusy(`${action}:${sceneId}`);
    setNotice(null);
    try {
      const r = await jfetch<{ note?: string; disclosure?: string }>(`/api/studio/plans/${plan.planId}/scenes/${sceneId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      setNotice([r.note, r.disclosure].filter(Boolean).join(" — "));
      await openPlan(plan.planId);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusy(null);
    }
  }, [plan, busy, openPlan]);

  const editScene = useCallback(async (sceneId: string, fields: Record<string, unknown>) => {
    if (!plan) return;
    try {
      await jfetch(`/api/studio/plans/${plan.planId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sceneEdit: { sceneId, ...fields } }),
      });
      setPlan((p) => (p ? { ...p, scenes: p.scenes.map((s) => (s.id === sceneId ? ({ ...s, ...fields } as StudioScene) : s)) } : p));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "edit failed");
    }
  }, [plan]);

  const reorder = useCallback(async (sceneId: string, dir: -1 | 1) => {
    if (!plan || busy) return;
    const ids = plan.scenes.map((s) => s.id);
    const idx = ids.indexOf(sceneId);
    const swap = idx + dir;
    if (swap < 0 || swap >= ids.length) return;
    [ids[idx], ids[swap]] = [ids[swap], ids[idx]];
    setBusy("reorder");
    try {
      await jfetch(`/api/studio/plans/${plan.planId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reorder: ids }) });
      await openPlan(plan.planId);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "reorder failed");
    } finally {
      setBusy(null);
    }
  }, [plan, busy, openPlan]);

  const addScene = useCallback(async () => {
    if (!plan || busy) return;
    setBusy("add");
    try {
      await jfetch(`/api/studio/plans/${plan.planId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ addScene: { afterSceneNumber: null, durationSec: 5 } }) });
      await openPlan(plan.planId);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "add failed");
    } finally {
      setBusy(null);
    }
  }, [plan, busy, openPlan]);

  const deleteScene = useCallback(async (sceneId: string) => {
    if (!plan || busy) return;
    setBusy("del");
    try {
      await jfetch(`/api/studio/plans/${plan.planId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ deleteSceneId: sceneId }) });
      await openPlan(plan.planId);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(null);
    }
  }, [plan, busy, openPlan]);

  const assemble = useCallback(async () => {
    if (!plan || busy) return;
    setBusy("assemble");
    setNotice(null);
    try {
      const r = await jfetch<{ version: number; captionsMode: string; notes: string[]; next: string }>(`/api/studio/plans/${plan.planId}/assemble`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "assemble" }),
      });
      setNotice(`Assembled at timeline version ${r.version} (captions: ${r.captionsMode}). ${r.next} ${r.notes.slice(0, 2).join(" ")}`);
      await refreshPlans();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "assembly failed");
    } finally {
      setBusy(null);
    }
  }, [plan, busy, refreshPlans]);

  const runBatch = useCallback(async () => {
    if (!batchTopics.trim() || busy) return;
    setBusy("batch");
    setNotice(null);
    try {
      const topics = batchTopics.split("\n").map((t) => t.trim()).filter(Boolean).slice(0, 10);
      const r = await jfetch<{ dispatched: number; note: string }>("/api/studio/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sharedBrief: { topic: topics[0] ?? "batch", language, platform, durationSec, audience: audience.slice(0, 200), tone: tone.slice(0, 120) },
          topics,
        }),
      });
      setNotice(r.note);
      void refreshPlans();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "batch failed");
    } finally {
      setBusy(null);
    }
  }, [batchTopics, language, platform, durationSec, audience, tone, busy, refreshPlans]);

  const label = "bean-label text-[10px] text-[#8f8f8a]";
  const input = "w-full rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-1 text-[10px] text-[#d4d4d0] placeholder:text-[#5a5a55]";
  const btn = "rounded border border-[#2a2a2a] bg-[#111110] px-2 py-1 text-[10px] text-[#d4a017] hover:border-[#d4a017] disabled:opacity-40";

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0a] p-3">
      <div className="flex items-center justify-between">
        <h2 className={`${label} flex items-center gap-1.5`}>
          <Clapperboard className="h-3 w-3 text-[#d4a017]" /> SOCIAL VIDEO STUDIO
        </h2>
        <div className="flex gap-1">
          {(["create", "script", "storyboard", "voice", "assemble"] as Tab[]).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={`rounded px-1.5 py-0.5 text-[9px] ${tab === t ? "bg-[#d4a017]/15 text-[#d4a017]" : "text-[#7a7a76] hover:text-[#a0a09a]"}`}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {notice && <p className="mt-2 text-[10px] leading-relaxed text-[#a0a09a]">{notice}</p>}

      {tab === "create" && (
        <div className="mt-2 space-y-1.5">
          <input value={topic} onChange={(e) => setTopic(e.target.value.slice(0, 300))} placeholder="Video topic or keywords…" className={input} />
          <div className="flex gap-1">
            <select value={language} onChange={(e) => setLanguage(e.target.value as "en" | "ta")} className={input}>
              <option value="en">English</option>
              <option value="ta">Tamil (தமிழ்)</option>
            </select>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={input}>
              <option value="youtube_shorts">YouTube Shorts (9:16 · ≤60s)</option>
              <option value="instagram_reels">Instagram Reels (9:16 · ≤90s)</option>
              <option value="tiktok">TikTok (9:16 · ≤180s)</option>
              <option value="youtube_landscape">YouTube landscape (16:9)</option>
              <option value="square_social">Square social (1:1)</option>
            </select>
          </div>
          <div className="flex gap-1">
            <input value={durationSec === 0 ? "" : String(durationSec)} onChange={(e) => setDurationSec(Math.max(15, Math.min(300, Number(e.target.value) || 0)))} placeholder="Duration (s)" className={input} />
            <input value={audience} onChange={(e) => setAudience(e.target.value.slice(0, 200))} placeholder="Target audience" className={input} />
            <input value={tone} onChange={(e) => setTone(e.target.value.slice(0, 120))} placeholder="Tone" className={input} />
          </div>
          {language === "ta" && (
            <p className="text-[9px] text-amber-400/80">Tamil: planning, captions and NIIKI typography are Tamil-safe; TTS narration on the current provider is not verified for Tamil — you can upload your own Tamil voiceover per scene.</p>
          )}
          <div className="flex gap-1">
            <button type="button" onClick={() => void createPlan()} disabled={busy !== null || topic.trim().length < 3} className={`${btn} flex items-center gap-1`}>
              {busy === "create" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />} CREATE PLAN
            </button>
            <button type="button" onClick={() => void runBatch()} disabled={busy !== null || !batchTopics.trim()} className={btn} title="One topic per line (max 10) — durable per-topic jobs">
              BATCH
            </button>
          </div>
          <textarea value={batchTopics} onChange={(e) => setBatchTopics(e.target.value.slice(0, 3000))} placeholder="Batch topics — one per line…" rows={2} className={input} />
          {plans.length > 0 && (
            <div className="max-h-24 space-y-0.5 overflow-y-auto">
              {plans.map((p) => (
                <button key={p.planId} type="button" onClick={() => void openPlan(p.planId)} className="block w-full truncate rounded px-1 py-0.5 text-left text-[10px] text-[#a0a09a] hover:bg-[#161615]">
                  {p.topic.slice(0, 48)} · {p.status} · {p.sceneCount} scenes · {p.plannerMode}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "script" && plan && (
        <div className="mt-2 max-h-72 space-y-1.5 overflow-y-auto">
          {plan.scenes.map((s) => (
            <div key={s.id} className="rounded border border-[#1d1d1b] bg-[#101010] p-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold text-[#d4d4d0]">Scene {s.sceneNumber} · {s.durationSec}s · {s.transition}</p>
                <div className="flex gap-1">
                  <button type="button" onClick={() => void reorder(s.id, -1)} className="text-[#5a5a55] hover:text-[#d4a017]"><ArrowUp className="h-3 w-3" /></button>
                  <button type="button" onClick={() => void reorder(s.id, 1)} className="text-[#5a5a55] hover:text-[#d4a017]"><ArrowDown className="h-3 w-3" /></button>
                  <button type="button" onClick={() => void deleteScene(s.id)} className="text-[#5a5a55] hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
                </div>
              </div>
              <textarea
                value={s.narration}
                onChange={(e) => void editScene(s.id, { narration: e.target.value.slice(0, 1200) })}
                rows={2}
                className={`${input} mt-1`}
                placeholder="Narration (spoken aloud)…"
              />
              <div className="mt-1 flex items-center gap-1">
                <button type="button" onClick={() => void sceneAction(s.id, "regenerate")} disabled={busy !== null} className={`${btn} flex items-center gap-1`}>
                  {busy === `regenerate:${s.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} REGENERATE
                </button>
                <span className="text-[9px] text-[#5a5a55]">visual: {s.visualDescription.slice(0, 40)}</span>
              </div>
            </div>
          ))}
          <button type="button" onClick={() => void addScene()} disabled={busy !== null} className={`${btn} flex items-center gap-1`}>
            <Plus className="h-3 w-3" /> ADD SCENE
          </button>
        </div>
      )}

      {tab === "storyboard" && plan && (
        <div className="mt-2 max-h-72 space-y-1.5 overflow-y-auto">
          {plan.footage && !plan.footage.stockSearchAvailable && (
            <p className="rounded border border-[#2a2a2a] bg-[#101010] p-1.5 text-[9px] text-[#a0a09a]">
              {plan.footage.note} Options: {plan.footage.alternatives.join(" ")}
            </p>
          )}
          {plan.scenes.map((s) => (
            <div key={s.id} className="rounded border border-[#1d1d1b] bg-[#101010] p-1.5">
              <p className="text-[10px] text-[#d4d4d0]">
                Scene {s.sceneNumber} · <span className={s.assetId ? "text-emerald-400" : "text-amber-400"}>{s.assetId ? `${s.assetKind} (${s.assetSource})` : s.status}</span>
              </p>
              <p className="text-[9px] text-[#7a7a76]">{s.visualDescription.slice(0, 90)}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                <button type="button" onClick={() => void sceneAction(s.id, "generate-image")} disabled={busy !== null} className={btn}>LAXII IMAGE</button>
                <button type="button" onClick={() => void sceneAction(s.id, "generate-video")} disabled={busy !== null} className={btn}>JAZMII FOOTAGE</button>
                <select
                  onChange={(e) => {
                    if (e.target.value) void sceneAction(s.id, "assign-asset", { assetId: e.target.value });
                    e.currentTarget.selectedIndex = 0;
                  }}
                  className={input}
                  defaultValue=""
                >
                  <option value="">Assign own media…</option>
                  {media.filter((m) => m.kind === "VIDEO" || m.kind === "IMAGE").map((m) => (
                    <option key={m.id} value={m.id}>{m.originalName.slice(0, 36)} ({m.kind})</option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "voice" && plan && (
        <div className="mt-2 space-y-1.5">
          <p className="text-[9px] text-[#a0a09a]">Narration via the configured TTS provider (verified voice: tongtong). External processing: the narration text is sent for speech synthesis; audio is stored with provenance.</p>
          {plan.scenes.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded border border-[#1d1d1b] bg-[#101010] px-1.5 py-1">
              <p className="text-[10px] text-[#d4d4d0]">
                Scene {s.sceneNumber} · <span className={s.narrationAssetId ? "text-emerald-400" : "text-[#7a7a76]"}>{s.narrationAssetId ? "voice ready" : "no narration"}</span>
              </p>
              <button type="button" onClick={() => void sceneAction(s.id, "narrate")} disabled={busy !== null || !s.narration.trim()} className={`${btn} flex items-center gap-1`}>
                {busy === `narrate:${s.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Mic className="h-3 w-3" />} {s.narrationAssetId ? "REGENERATE" : "GENERATE"}
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === "assemble" && plan && (
        <div className="mt-2 space-y-1.5">
          <p className="text-[9px] text-[#a0a09a]">
            Assembly converts the approved scenes into a REAL editable BEAN FX timeline (M1 commands, versioned, undoable). Scene readiness — assets: {plan.scenes.every((s) => s.assetId) ? "ready" : "missing"}, narration: {plan.scenes.some((s) => s.narrationAssetId) ? "ready" : "missing"}.
          </p>
          <button type="button" onClick={() => void assemble()} disabled={busy !== null || !plan.scenes.every((s) => s.assetId)} className={`${btn} flex items-center gap-1`}>
            {busy === "assemble" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Film className="h-3 w-3" />} ASSEMBLE TIMELINE
          </button>
          {plan.status === "ASSEMBLED" && (
            <p className="flex items-center gap-1 text-[9px] text-emerald-400">
              <Layers className="h-3 w-3" /> Assembled — open the project in the editor; export runs through the existing render pipeline.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
