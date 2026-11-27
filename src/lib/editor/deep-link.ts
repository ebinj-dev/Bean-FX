/**
 * M48-B — editor deep-link contract.
 *
 * The Chat → Editor link previously carried only `project` (mount-only parse,
 * never re-read on hashchange). This module is the single parser for the
 * editor hash so both the mount effect and the hashchange listener share one
 * tested contract:
 *
 *   #/editor?project=<projectId>&conversation=<conversationId>&plan=<planId>&export=<exportId>
 *
 * `conversation` gives the editor context for "Return to Chat"
 * (#/home?conversation=<id>); `plan`/`export` are recorded context only —
 * they never mutate the timeline by themselves (the canonical approval flow
 * stays in the plans API).
 */
export interface EditorLinkContext {
  projectId: string | null;
  conversationId: string | null;
  planId: string | null;
  exportId: string | null;
}

export const EMPTY_EDITOR_LINK_CONTEXT: EditorLinkContext = {
  projectId: null,
  conversationId: null,
  planId: null,
  exportId: null,
};

export function parseEditorHash(hash: string | null | undefined): EditorLinkContext {
  if (!hash) return EMPTY_EDITOR_LINK_CONTEXT;
  const qIndex = hash.indexOf("?");
  if (qIndex === -1) return EMPTY_EDITOR_LINK_CONTEXT;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(hash.slice(qIndex + 1));
  } catch {
    return EMPTY_EDITOR_LINK_CONTEXT;
  }
  const pick = (key: string): string | null => {
    const raw = params.get(key);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
  };
  return {
    projectId: pick("project"),
    conversationId: pick("conversation"),
    planId: pick("plan"),
    exportId: pick("export"),
  };
}

/** Where "Return to Chat" should navigate for a conversation context. */
export function returnToChatHash(conversationId: string | null): string {
  return conversationId ? `#/home?conversation=${encodeURIComponent(conversationId)}` : "#/studio";
}
