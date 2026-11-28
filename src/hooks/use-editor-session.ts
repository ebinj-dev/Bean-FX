"use client";

/**
 * BEAN FX — Editor session hook (Milestone 2, editor integration).
 *
 * Single owner of the interactive editing session:
 *   - holds the EditHistory (local undo/redo over validated commands),
 *   - applies every change optimistically and persists it to the server as
 *     the next timeline version (debounced autosave, serialized queue),
 *   - handles version conflicts (409): adopts the authoritative server head,
 *     resets the local stacks and surfaces the conflict to the UI,
 *   - owns playhead + selection so monitor, timeline and inspector stay in
 *     sync.
 *
 * Every mutation goes through the M1 command engine — the UI never pokes at
 * sequence fields directly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditHistory } from "@/lib/editor/engine";
import type { Command } from "@/lib/editor/commands";
import type { Sequence } from "@/lib/editor/model";

export type SaveState = "loading" | "saved" | "saving" | "error" | "conflict";

export interface EditorSessionState {
  sequence: Sequence | null;
  version: number | null;
  saveState: SaveState;
  error: string | null;
  conflictMessage: string | null;
  canUndo: boolean;
  canRedo: boolean;
  selectedClipId: string | null;
  playheadFrame: number;
}

const AUTOSAVE_DEBOUNCE_MS = 600;
/** Transient save failures (network/5xx) are retried with backoff before the
 *  authoritative reload is used as the honest last resort. */
const MAX_SAVE_RETRIES = 3;

export interface EditorSession extends EditorSessionState {
  /** Apply a batch of commands (atomic). Returns false if the engine refused them. */
  apply: (commands: unknown[]) => boolean;
  undo: () => void;
  redo: () => void;
  reload: () => Promise<void>;
  select: (clipId: string | null) => void;
  setPlayhead: (frame: number) => void;
  /** Create a fresh id for command payloads (unique per session). */
  newId: (prefix: string) => string;
  /** M16: flush pending autosave immediately (Ctrl+S / unload guard). */
  flushNow: () => Promise<void>;
}

export function useEditorSession(projectId: string | null): EditorSession {
  const [state, setState] = useState<EditorSessionState>({
    sequence: null,
    version: null,
    saveState: "loading",
    error: null,
    conflictMessage: null,
    canUndo: false,
    canRedo: false,
    selectedClipId: null,
    playheadFrame: 0,
  });

  const historyRef = useRef<EditHistory | null>(null);
  const versionRef = useRef<number>(0);
  // Persistence queue: edits accumulate while a POST is in flight; the chain
  // serializes batches so the server always sees a consistent command order.
  const queueRef = useRef<Command[]>([]);
  const persistingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveAttemptsRef = useRef(0);
  const retryScheduledRef = useRef(false);
  const idCounterRef = useRef(0);

  const publish = useCallback((patch: Partial<EditorSessionState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const syncFromHistory = useCallback(() => {
    const h = historyRef.current;
    if (!h) return;
    publish({
      sequence: h.current,
      canUndo: h.canUndo,
      canRedo: h.canRedo,
    });
  }, [publish]);

  /** Re-read the authoritative head from the server (fresh EditHistory). */
  const reload = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    publish({ saveState: "loading", error: null });
    try {
      const res = await fetch(`/api/editor/projects/${projectId}/timeline`);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // Drop any previously loaded project's sequence/selection: after a
        // failed load the inspector must not keep showing a stale project's
        // clip (commands would target a clip id the server no longer knows).
        publish({ saveState: "error", error: data?.error ?? `Failed to load timeline (${res.status})`, sequence: null, selectedClipId: null, playheadFrame: 0 });
        return;
      }
      const sequence: Sequence = data.sequence;
      historyRef.current = new EditHistory(sequence);
      versionRef.current = data.version as number;
      queueRef.current = [];
      publish({
        sequence,
        version: data.version as number,
        saveState: "saved",
        error: null,
        conflictMessage: null,
        canUndo: false,
        canRedo: false,
        selectedClipId: null,
        playheadFrame: 0,
      });
    } catch (err) {
      publish({ saveState: "error", error: err instanceof Error ? err.message : "Failed to load timeline.", sequence: null, selectedClipId: null, playheadFrame: 0 });
    }
  }, [projectId, publish]);

  const flushNow = useCallback(async (): Promise<void> => {
    if (persistingRef.current || queueRef.current.length === 0) return;
    persistingRef.current = true;
    publish({ saveState: "saving", error: null });
    const batch = queueRef.current;
    queueRef.current = [];
    try {
      const res = await fetch(`/api/editor/projects/${projectId}/timeline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseVersion: versionRef.current, edits: batch, isAutosave: true }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 409 && data?.headVersion) {
        // Authoritative head wins: adopt it, reset local stacks. The conflict
        // message stays visible until the next successful edit.
        const headSequence: Sequence = data.sequence;
        historyRef.current = new EditHistory(headSequence);
        versionRef.current = data.headVersion as number;
        queueRef.current = [];
        publish({
          saveState: "conflict",
          conflictMessage: `Another session advanced this timeline to version ${data.headVersion}. The authoritative version was reloaded — undo history was reset to match.`,
          sequence: headSequence,
          version: data.headVersion as number,
          canUndo: false,
          canRedo: false,
          selectedClipId: null,
        });
        return;
      }
      if (!res.ok) {
        if (res.status >= 500) {
          // Transient server failure: keep the batch and retry with backoff —
          // discarding user edits because a POST hiccupped would lose work.
          saveAttemptsRef.current += 1;
          if (saveAttemptsRef.current <= MAX_SAVE_RETRIES) {
            queueRef.current = [...batch, ...queueRef.current];
            retryScheduledRef.current = true;
            publish({
              saveState: "error",
              error: `Save failed (${res.status}) — retrying (attempt ${saveAttemptsRef.current}/${MAX_SAVE_RETRIES})…`,
            });
            setTimeout(() => {
              retryScheduledRef.current = false;
              void flushNow();
            }, 800 * saveAttemptsRef.current);
            return;
          }
        }
        // 4xx (the server validated and refused the batch, or access was
        // lost): retrying cannot help — reload the authoritative head instead
        // of guessing a revert. Edits made after the failure are NOT lost:
        // they stay in the engine/history until the reload replaces it.
        saveAttemptsRef.current = 0;
        queueRef.current = [];
        publish({ saveState: "error", error: data?.error ?? `Save failed (${res.status})` });
        await reload();
        return;
      }
      saveAttemptsRef.current = 0;
      versionRef.current = data.version as number;
      const serverSequence: Sequence = data.sequence;
      if (historyRef.current) historyRef.current.current = serverSequence;
      publish({
        saveState: "saved",
        version: data.version as number,
        sequence: serverSequence,
        error: null,
        conflictMessage: null,
      });
    } catch (err) {
      // Network-level failure: same retry-with-backoff contract as 5xx.
      saveAttemptsRef.current += 1;
      if (saveAttemptsRef.current <= MAX_SAVE_RETRIES) {
        queueRef.current = [...batch, ...queueRef.current];
        retryScheduledRef.current = true;
        publish({
          saveState: "error",
          error: `Save failed (${err instanceof Error ? err.message : "network"}) — retrying (attempt ${saveAttemptsRef.current}/${MAX_SAVE_RETRIES})…`,
        });
        setTimeout(() => {
          retryScheduledRef.current = false;
          void flushNow();
        }, 800 * saveAttemptsRef.current);
        return;
      }
      saveAttemptsRef.current = 0;
      queueRef.current = [];
      publish({
        saveState: "error",
        error: "Save failed repeatedly — reload will restore the server's authoritative version.",
      });
      void reload();
    } finally {
      persistingRef.current = false;
      // A scheduled retry owns the next flush — the chained flush here would
      // fire immediately and defeat the backoff.
      if (!retryScheduledRef.current && queueRef.current.length > 0) void flushNow();
    }
  }, [projectId, publish, reload]);

  const schedulePersist = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flushNow(), AUTOSAVE_DEBOUNCE_MS);
  }, [flushNow]);

  useEffect(() => {
    void reload();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // Reload only when the project changes.
     
  }, [projectId]);

  // Durability: flush queued edits when the tab closes — the 600 ms debounce
  // would otherwise silently drop the last batch. keepalive lets the POST
  // outlive the page; a persisted-then-dropped duplicate is impossible here
  // because the queue is cleared and the batch is atomic on the server.
  useEffect(() => {
    const flushOnUnload = () => {
      if (persistingRef.current || retryScheduledRef.current || queueRef.current.length === 0 || !projectId) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      const batch = queueRef.current;
      queueRef.current = [];
      void fetch(`/api/editor/projects/${projectId}/timeline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseVersion: versionRef.current, edits: batch, isAutosave: true }),
        keepalive: true,
      }).catch(() => undefined);
    };
    window.addEventListener("beforeunload", flushOnUnload);
    return () => window.removeEventListener("beforeunload", flushOnUnload);
  }, [projectId]);

  const apply = useCallback(
    (commands: unknown[]): boolean => {
      const h = historyRef.current;
      if (!h || commands.length === 0) return false;
      try {
        h.apply(commands);
      } catch (err) {
        publish({ error: err instanceof Error ? err.message : "Edit refused." });
        return false;
      }
      queueRef.current.push(...(commands as Command[]));
      syncFromHistory();
      schedulePersist();
      return true;
    },
    [publish, schedulePersist, syncFromHistory],
  );

  const undo = useCallback((): void => {
    const h = historyRef.current;
    if (!h) return;
    // The batch persisted to the server is exactly what the local undo
    // applies: the entry's inverse commands in undo's application order.
    const inverseBatch = h.peekUndoInverses();
    const result = h.undo();
    if (!result.ok) return;
    if (inverseBatch) queueRef.current.push(...inverseBatch);
    syncFromHistory();
    schedulePersist();
  }, [schedulePersist, syncFromHistory]);

  const redo = useCallback((): void => {
    const h = historyRef.current;
    if (!h) return;
    const forward = h.peekRedoForward();
    const ok = h.redo();
    if (!ok) return;
    if (forward) queueRef.current.push(...forward);
    syncFromHistory();
    schedulePersist();
  }, [schedulePersist, syncFromHistory]);

  const select = useCallback((clipId: string | null) => publish({ selectedClipId: clipId }), [publish]);
  const setPlayhead = useCallback((frame: number) => publish({ playheadFrame: Math.max(0, Math.round(frame)) }), [publish]);

  const newId = useCallback((prefix: string) => {
    idCounterRef.current += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounterRef.current}`;
  }, []);

  return useMemo(
    () => ({
      ...state,
      apply,
      undo,
      redo,
      reload,
      select,
      setPlayhead,
      newId,
      flushNow,
    }),
    [state, apply, undo, redo, reload, select, setPlayhead, newId, flushNow],
  );
}
