"use client";

/**
 * M47 VOICE ADDENDUM — real speech capture → transcription → intent.
 *
 * Privacy contract: nothing records until the user activates voice mode.
 * The transcript is ALWAYS editable before submission; the original is
 * preserved. Processing location is disclosed per attempt (server response).
 *
 * Transcription path: recorded audio → POST /api/my-ai/voice/transcribe
 * (server-side provider from the capability registry — asr-speech). When the
 * registry reports the capability NOT ready, the response says so honestly and
 * the component falls back to (a) the browser Web Speech API when genuinely
 * available and (b) plain typing. Mic denial keeps the text composer usable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Btn, ErrorNote, StatusBadge } from "@/components/bean/ui";
import { VOICE_LANGUAGES, detectScriptMix, type ScriptMix } from "@/lib/voice-language";

type Phase = "idle" | "requesting" | "recording" | "processing" | "transcript" | "denied" | "unsupported";

const MAX_SECONDS = 120;
const MAX_BYTES = 15 * 1024 * 1024;

export function VoiceCapture({
  onTranscript,
  disabled,
  compact = false,
}: {
  onTranscript: (transcript: string, meta: {
    original: string;
    language?: string;
    confidence?: number;
    engine: string;
    requestedLanguage?: { id: string; label: string; status: string; note: string };
  }) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [bars, setBars] = useState<number[]>(Array.from({ length: 14 }, () => 3));
  const [transcript, setTranscript] = useState("");
  const [original, setOriginal] = useState("");
  const [meta, setMeta] = useState<{ language?: string; confidence?: number; engine: string }>({ engine: "server ASR" });
  const [disclosure, setDisclosure] = useState<string | null>(null);
  const [continuous, setContinuous] = useState(false);
  // M47.1 §A2 — language selection with truthful status (EN verified live;
  // Tamil/Tanglish unverified until native-speaker validation).
  const [language, setLanguage] = useState("auto");
  const [requestedLang, setRequestedLang] = useState<{ label: string; status: string; note: string } | null>(null);
  const [scriptMix, setScriptMix] = useState<ScriptMix | null>(null);

  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef(0);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  const teardown = useCallback(() => {
    // Resource release only — no state writes here (this also runs on unmount).
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
  }, []);
  const resetBars = useCallback(() => setBars(Array.from({ length: 14 }, () => 3)), []);

  useEffect(() => () => teardown(), [teardown]);

  const hardStop = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    try { if (recRef.current?.state === "recording") recRef.current.stop(); } catch { /* already stopped */ }
    teardown();
    resetBars();
    setPhase("processing");
  }, [teardown, resetBars]);

  const onAudioStop = useCallback(async () => {
    const blob = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || "audio/webm" });
    chunksRef.current = [];
    teardown();
    resetBars();
    if (blob.size > MAX_BYTES) {
      setError(`Recording too large (${(blob.size / 1024 / 1024).toFixed(1)} MB) — keep voice notes under ${MAX_SECONDS} s.`);
      setPhase("idle");
      return;
    }
    try {
      const fd = new FormData();
      fd.append("audio", blob, "voice.webm");
      if (language !== "auto") fd.append("language", language);
      const res = await fetch("/api/my-ai/voice/transcribe", { method: "POST", body: fd });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.supported) {
        // Honest limitation: the configured registry has no ready ASR provider.
        setError(d?.reason ?? "Server transcription is not enabled — use the editable text field (Web Speech fallback below) or type the instruction.");
        setPhase("idle");
        return;
      }
      const text = String(d.transcript ?? "");
      if (!text.trim()) {
        setError("The provider returned an empty transcript — try again or type the instruction.");
        setPhase("idle");
        return;
      }
      setOriginal(text);
      setTranscript(text);
      setMeta({ language: d.language ?? undefined, confidence: d.confidence ?? undefined, engine: d.provider ?? "server ASR" });
      setRequestedLang(d.requestedLanguage ?? null);
      setScriptMix(d.scriptMix ?? detectScriptMix(text));
      setDisclosure(d.disclosure ?? "Audio was processed by the configured server provider; the audio is not retained beyond this transcription.");
      setPhase("transcript");
    } catch (err) {
      setError(`Transcription network error: ${err instanceof Error ? err.message : "connection failed"}`);
      setPhase("idle");
    }
  }, [teardown, resetBars, language]);

  const startRecognitionFallback = useCallback(() => {
    // Web Speech API (browser engine) — only offered when actually present.
    const w = window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return false;
    try {
      const rec = new Ctor() as {
        continuous: boolean; interimResults: boolean; lang: string;
        onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
        onerror: ((e: { error?: string }) => void) | null;
        onend: (() => void) | null;
        start: () => void; stop: () => void;
      };
      rec.continuous = false;
      rec.interimResults = true;
      rec.lang = navigator.language || "en-US";
      rec.onresult = (e) => {
        let text = "";
        for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
        setTranscript(text);
        setOriginal(text);
        setMeta({ engine: "browser Web Speech", language: rec.lang });
        setPhase("transcript");
      };
      rec.onerror = (e) => {
        setError(`Browser speech engine error: ${e.error ?? "unknown"}`);
        teardown();
        setPhase("idle");
      };
      rec.onend = () => { recognitionRef.current = null; };
      rec.start();
      recognitionRef.current = rec;
      setDisclosure("Transcribed locally by the browser Web Speech engine — audio never leaves this device.");
      return true;
    } catch {
      return false;
    }
  }, [teardown]);

  const startRecording = useCallback(async (continuousMode: boolean) => {
    if (disabled || phase === "recording" || phase === "requesting") return;
    setError(null);
    setTranscript("");
    setOriginal("");
    setDisclosure(null);
    setRequestedLang(null);
    setScriptMix(null);
    setPhase("requesting");
    setContinuous(continuousMode);
    // Permission is requested HERE — only after an explicit user action.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const denied = err instanceof Error && (err.name === "NotAllowedError" || err.name === "SecurityError");
      setError(denied
        ? "Microphone access was denied — voice input is off; typing still works normally."
        : `Microphone unavailable: ${err instanceof Error ? err.message : "error"}`);
      setPhase(denied ? "denied" : "unsupported");
      return;
    }
    streamRef.current = stream;
    startRef.current = Date.now();
    setSeconds(0);
    // Live waveform (kept small and restrained per the design system).
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(buf);
        const step = Math.floor(buf.length / 14);
        setBars(Array.from({ length: 14 }, (_, i) => 3 + Math.round((buf[i * step] / 255) * 22)));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* waveform is decorative; recording continues */ }
    timerRef.current = setInterval(() => {
      const s = Math.floor((Date.now() - startRef.current) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) hardStop();
    }, 500);

    // Prefer the server ASR (multi-language incl. Tamil/Tanglish via provider);
    // if the recorder API is unavailable, try the browser engine.
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported?.("audio/webm")) {
      if (startRecognitionFallback()) { setPhase("recording"); return; }
      setError("This browser cannot record audio — type the instruction instead.");
      teardown();
      setPhase("unsupported");
      return;
    }
    try {
      const rec = new MediaRecorder(stream);
      recRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => { void onAudioStop(); };
      rec.start();
      setPhase("recording");
    } catch (err) {
      setError(`Recording failed: ${err instanceof Error ? err.message : "error"}`);
      teardown();
      setPhase("unsupported");
    }
  }, [disabled, phase, hardStop, onAudioStop, startRecognitionFallback, teardown, resetBars]);

  const submit = useCallback(() => {
    const t = transcript.trim();
    if (!t) return;
    const lang = VOICE_LANGUAGES.find((l) => l.id === language);
    onTranscript(t, {
      original,
      language: meta.language,
      confidence: meta.confidence,
      engine: meta.engine,
      requestedLanguage: lang ? { id: lang.id, label: lang.label, status: lang.status, note: lang.note } : undefined,
    });
    setPhase("idle");
    setTranscript("");
    setOriginal("");
    if (continuous) {
      // Hands-free continuation stays under user control; one click stops it.
      void startRecording(true);
    }
  }, [transcript, original, meta, onTranscript, continuous, startRecording, language]);

  const cancel = useCallback(() => {
    hardStop();
    recognitionRef.current = null;
    setPhase("idle");
  }, [hardStop]);

  return (
    <div className={`rounded-lg border border-[var(--m47-line)] bg-[var(--m47-bg)] ${compact ? "px-2.5 py-2" : "px-3 py-2.5"}`} aria-label="Voice input">
      {(phase === "idle" || phase === "denied" || phase === "unsupported") && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Btn disabled={disabled} onClick={() => void startRecording(false)} title="Push to talk">🎙 Speak</Btn>
            <Btn variant="ghost" disabled={disabled} onClick={() => void startRecording(true)} title="Hands-free conversation mode — stays on until you stop it">Hands-free</Btn>
            <select
              className="m47-select px-2 py-1.5 text-[11px]"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              aria-label="Voice language"
              title="English is verified live; Tamil and Tanglish need native-speaker validation before production use"
            >
              {VOICE_LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>{l.label}{l.status === "unverified" ? " ·unverified" : ""}</option>
              ))}
            </select>
          </div>
          <span className="block text-[9.5px] text-[var(--m47-ink-dim)]">
            {VOICE_LANGUAGES.find((l) => l.id === language)?.note ?? ""} recording starts only after you activate it · transcript stays editable
          </span>
        </div>
      )}

      {(phase === "recording" || phase === "requesting") && (
        <div className="flex items-center gap-3">
          <span className="m47-rec-dot" aria-hidden="true" />
          <div className="flex h-6 items-end gap-[3px]" aria-hidden="true">
            {bars.map((h, i) => <span key={i} className="m47-wavebar" style={{ height: `${h}px` }} />)}
          </div>
          <span className="text-[11px] text-[var(--m47-gold-soft)]">{phase === "requesting" ? "enabling mic…" : `recording ${seconds}s / ${MAX_SECONDS}s`}</span>
          <Btn variant="danger" onClick={hardStop}>Stop</Btn>
          {continuous && <StatusBadge s="run">hands-free</StatusBadge>}
        </div>
      )}

      {phase === "processing" && (
        <div className="flex items-center gap-2">
          <span className="m47-rec-dot" aria-hidden="true" />
          <span className="text-[11px] text-[var(--m47-ink-mid)]">transcribing…</span>
        </div>
      )}

      {phase === "transcript" && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[9.5px] font-bold uppercase tracking-widest text-[var(--m47-ink-dim)]">Transcript — edit before sending</span>
            {meta.language && <span className="m47-chip">{meta.language}</span>}
            {meta.confidence !== undefined && <span className="m47-chip">confidence {Math.round(meta.confidence * 100)}%</span>}
            <span className="m47-chip m47-chip-gold">{meta.engine}</span>
            {scriptMix && scriptMix.mix === "mixed" && <span className="m47-chip" title={scriptMix.disclosure}>script mix: Tamil+Latin (heuristic)</span>}
            {requestedLang && requestedLang.status !== "verified" && (
              <span className="m47-chip" title={requestedLang.note}>{requestedLang.label} · {requestedLang.status}</span>
            )}
          </div>
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            rows={2}
            className="m47-textarea w-full px-2.5 py-2 text-[12px]"
            aria-label="Editable transcript"
          />
          {original !== transcript && (
            <p className="text-[9.5px] text-[var(--m47-ink-dim)]">original preserved: “{original}”</p>
          )}
          {scriptMix && <p className="text-[9.5px] text-[var(--m47-ink-dim)]">{scriptMix.disclosure}</p>}
          {requestedLang && requestedLang.status !== "verified" && <p className="text-[9.5px] text-[var(--m47-warn)]">{requestedLang.note}</p>}
          {disclosure && <p className="text-[9.5px] text-[var(--m47-ink-dim)]">{disclosure}</p>}
          <div className="flex gap-2">
            <Btn variant="primary" disabled={!transcript.trim()} onClick={submit}>{continuous ? "Send & keep listening" : "Send"}</Btn>
            <Btn variant="ghost" onClick={() => { setPhase("idle"); setContinuous(false); }}>Cancel</Btn>
          </div>
        </div>
      )}

      <div className="mt-1.5">{error && <ErrorNote>{error}</ErrorNote>}</div>
    </div>
  );
}
