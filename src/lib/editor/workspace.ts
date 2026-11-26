/**
 * M44 — Workspace mode + layout preferences (Essentials / Pro).
 *
 * "Professional power, simple workflow": Essentials surfaces the primary
 * editing actions; Pro keeps every advanced control. The mode is pure UI
 * state — switching never mutates sequence, clip or project data, it only
 * decides which panels and controls are rendered. Preferences persist in
 * localStorage so the editor reopens exactly the way the user left it.
 */

export type WorkspaceMode = "essentials" | "pro";

export interface WorkspacePrefs {
  mode: WorkspaceMode;
  leftWidth: number;
  rightWidth: number;
}

const STORAGE_KEY = "beanfx.workspace.v1";

export const WORKSPACE_MIN_DOCK = 200;
export const WORKSPACE_MAX_DOCK = 480;

/** Editing tools kept in Essentials — the primary cut/trim/caption loop. */
export const ESSENTIAL_TOOL_IDS = ["select", "razor", "text", "zoom", "transform"] as const;

/**
 * Clamp a dock width so both docks can never crush the central workspace:
 * at narrow viewports the cap shrinks with the window, and the floor stays
 * wide enough for the dock's own controls.
 */
export function clampDockWidth(width: number, viewport = 1440): number {
  const max = Math.max(WORKSPACE_MIN_DOCK, Math.min(WORKSPACE_MAX_DOCK, Math.round(viewport * 0.32)));
  return Math.max(WORKSPACE_MIN_DOCK, Math.min(max, Math.round(width)));
}

/** Defaults sized to the viewport so the monitor keeps room on laptops. */
export function defaultDockWidths(viewport = 1440): { left: number; right: number } {
  if (viewport < 1400) return { left: 232, right: 264 };
  if (viewport < 1700) return { left: 260, right: 300 };
  return { left: 280, right: 336 };
}

export function loadWorkspacePrefs(): WorkspacePrefs | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WorkspacePrefs>;
    if (parsed.mode !== "essentials" && parsed.mode !== "pro") return null;
    return {
      mode: parsed.mode,
      leftWidth: clampDockWidth(Number(parsed.leftWidth) || defaultDockWidths(1440).left),
      rightWidth: clampDockWidth(Number(parsed.rightWidth) || defaultDockWidths(1440).right),
    };
  } catch {
    // Corrupt or unreadable preferences fall back to defaults.
    return null;
  }
}

export function saveWorkspacePrefs(prefs: WorkspacePrefs): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable (private mode) — preferences simply do not persist.
  }
}
