/**
 * M44 — Workspace mode + layout preferences (pure layer, no DB).
 *
 * Covers: dock-width clamping (never crushes the central workspace at any
 * viewport), viewport-sized defaults, preference round-trip through
 * localStorage, corrupt-storage fallback, and the Essentials tool subset.
 * Run: bun test scripts/test-m44-workspace.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  ESSENTIAL_TOOL_IDS,
  WORKSPACE_MAX_DOCK,
  WORKSPACE_MIN_DOCK,
  clampDockWidth,
  defaultDockWidths,
  loadWorkspacePrefs,
  saveWorkspacePrefs,
  type WorkspacePrefs,
} from "../src/lib/editor/workspace";
import { EDIT_TOOLS } from "../src/lib/editor/tools";

function withStorage<T>(fn: (store: Map<string, string>) => T): T {
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  };
  (globalThis as { localStorage?: typeof fake }).localStorage = fake;
  try {
    return fn(store);
  } finally {
    delete (globalThis as { localStorage?: typeof fake }).localStorage;
  }
}

describe("M44 workspace: clampDockWidth", () => {
  test("keeps widths inside the global floor and ceiling", () => {
    expect(clampDockWidth(10)).toBe(WORKSPACE_MIN_DOCK);
    // Ceiling is min(absolute cap, 32% of the viewport) — at the 1440 default
    // that is 461px, still safely inside the absolute cap.
    const capped = clampDockWidth(9999);
    expect(capped).toBeGreaterThanOrEqual(WORKSPACE_MIN_DOCK);
    expect(capped).toBeLessThanOrEqual(WORKSPACE_MAX_DOCK);
    expect(capped).toBe(Math.min(WORKSPACE_MAX_DOCK, Math.round(1440 * 0.32)));
  });

  test("shrinks the ceiling on narrow viewports so the center keeps room", () => {
    // 1024px viewport → ceiling 32% ≈ 328px, still above the floor.
    const narrow = clampDockWidth(480, 1024);
    expect(narrow).toBeLessThanOrEqual(Math.round(1024 * 0.32));
    expect(narrow).toBeGreaterThanOrEqual(WORKSPACE_MIN_DOCK);
    // Normal desktop sizes keep the requested width when within range.
    expect(clampDockWidth(300, 1920)).toBe(300);
    expect(clampDockWidth(460, 1920)).toBe(460);
  });
});

describe("M44 workspace: defaultDockWidths", () => {
  test("uses narrower docks on laptops than on desktops", () => {
    const laptop = defaultDockWidths(1366);
    const desktop = defaultDockWidths(1920);
    expect(laptop.left + laptop.right).toBeLessThan(desktop.left + desktop.right);
  });

  test("defaults leave a usable central workspace at 1366×768", () => {
    const vp = 1366;
    const d = defaultDockWidths(vp);
    expect(vp - d.left - d.right).toBeGreaterThanOrEqual(800);
  });
});

describe("M44 workspace: preferences persistence", () => {
  test("round-trips mode and dock widths through localStorage", () => {
    withStorage(() => {
      const prefs: WorkspacePrefs = { mode: "pro", leftWidth: 320, rightWidth: 400 };
      saveWorkspacePrefs(prefs);
      expect(loadWorkspacePrefs()).toEqual(prefs);
    });
  });

  test("returns null when nothing is stored or the payload is corrupt", () => {
    withStorage((store) => {
      expect(loadWorkspacePrefs()).toBeNull();
      store.set("beanfx.workspace.v1", "{not json");
      expect(loadWorkspacePrefs()).toBeNull();
      store.set("beanfx.workspace.v1", JSON.stringify({ mode: "bogus" }));
      expect(loadWorkspacePrefs()).toBeNull();
    });
  });

  test("survives missing localStorage entirely", () => {
    expect(loadWorkspacePrefs()).toBeNull();
    expect(() => saveWorkspacePrefs({ mode: "essentials", leftWidth: 240, rightWidth: 280 })).not.toThrow();
  });

  test("clamps out-of-range widths on load", () => {
    withStorage(() => {
      saveWorkspacePrefs({ mode: "pro", leftWidth: 5000, rightWidth: 1 });
      const loaded = loadWorkspacePrefs();
      // loadWorkspacePrefs clamps with its default viewport, matching clampDockWidth.
      expect(loaded?.leftWidth).toBe(clampDockWidth(5000));
      expect(loaded?.leftWidth).toBeLessThanOrEqual(WORKSPACE_MAX_DOCK);
      expect(loaded?.rightWidth).toBe(WORKSPACE_MIN_DOCK);
    });
  });
});

describe("M44 workspace: Essentials tool subset", () => {
  test("is a non-empty subset of the registered editing tools", () => {
    const all = new Set(EDIT_TOOLS.map((t) => t.id));
    expect(ESSENTIAL_TOOL_IDS.length).toBeGreaterThan(0);
    for (const id of ESSENTIAL_TOOL_IDS) expect(all.has(id)).toBe(true);
  });

  test("keeps the primary cut loop: select and razor", () => {
    expect(ESSENTIAL_TOOL_IDS).toContain("select");
    expect(ESSENTIAL_TOOL_IDS).toContain("razor");
  });
});
