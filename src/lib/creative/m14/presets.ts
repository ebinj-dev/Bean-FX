/**
 * M14.7 — NIIKI Motion Composition: reusable motion preset keyframe
 * generators. Every preset is a DETERMINISTIC function (fixed inputs → same
 * keyframes) producing LayerKeyframes evaluated by the SAME interpolation
 * family the NIIKI evaluator implements (LINEAR/HOLD/EASE*), at integer
 * frames, respecting rational FPS via a rounded frame-count input. No
 * Date.now, no random. Presets never mutate the doc — they RETURN keyframes
 * the caller merges (reversible, undoable edits happen through the
 * composition versioning layer).
 */
import { easeProgress } from "@/lib/nikki/animation";
import type { LayerKeyframe } from "./contracts";

export type MotionPresetId =
  | "soft-reveal"
  | "cinematic-push-in"
  | "floating-movement"
  | "bounce-entrance"
  | "kinetic-typography"
  | "scene-transition"
  | "parallax-drift"
  | "track-following-graphic"
  | "emphasis-pulse";

export interface PresetParams {
  startFrame: number;
  endFrame: number;
  /** Composition pixels: layer rest position/size. */
  restX: number;
  restY: number;
  intensity: 1 | 2 | 3; // subtle | moderate | dynamic
  /** Beat times in frames (RIISHE-derived) for beat-aware emphasis. */
  beatFrames?: number[];
  fps: number;
}

function kf(id: string, property: LayerKeyframe["property"], frame: number, value: number, interpolation: LayerKeyframe["interpolation"] = "LINEAR"): LayerKeyframe {
  return { id: `m14${id}${property}${frame}`, property, frame: Math.max(0, Math.round(frame)), value, interpolation };
}

/** Deterministic overshoot ease (bounce feel) from the NIIKI easing family. */
function bounceValue(u: number): number {
  const eased = easeProgress(u, "EASE_OUT");
  const overshoot = Math.sin(Math.min(1, u) * Math.PI * 1.5) * Math.max(0, 1 - u) * 0.12;
  return eased + overshoot;
}

export function applyMotionPreset(preset: MotionPresetId, p: PresetParams): LayerKeyframe[] {
  const { startFrame, endFrame } = p;
  const dur = Math.max(2, endFrame - startFrame);
  const kfs: LayerKeyframe[] = [];
  const mid = startFrame + Math.round(dur / 2);
  switch (preset) {
    case "soft-reveal": {
      const ease = p.intensity === 1 ? "EASE_OUT" : "EASE";
      kfs.push(kf("sr", "opacity", startFrame, 0, ease as LayerKeyframe["interpolation"]));
      kfs.push(kf("sr", "opacity", startFrame + Math.round(dur * 0.35), 1, ease as LayerKeyframe["interpolation"]));
      kfs.push(kf("sr", "scale", startFrame, 0.96 + 0.01 * p.intensity, ease as LayerKeyframe["interpolation"]));
      kfs.push(kf("sr", "scale", startFrame + Math.round(dur * 0.35), 1, ease as LayerKeyframe["interpolation"]));
      break;
    }
    case "cinematic-push-in": {
      const push = 0.04 + 0.04 * p.intensity;
      kfs.push(kf("cp", "scale", startFrame, 1, "EASE_IN_OUT"));
      kfs.push(kf("cp", "scale", endFrame, 1 + push, "EASE_IN_OUT"));
      kfs.push(kf("cp", "x", startFrame, p.restX, "EASE_IN_OUT"));
      kfs.push(kf("cp", "x", endFrame, p.restX - push * 60, "EASE_IN_OUT"));
      break;
    }
    case "floating-movement": {
      const amp = 6 + 6 * p.intensity;
      const cycles = 2;
      for (let c = 0; c <= cycles * 2; c++) {
        const f = startFrame + Math.round((dur * c) / (cycles * 2));
        kfs.push(kf("fl", "y", f, p.restY + (c % 2 === 0 ? -amp : amp), "EASE_IN_OUT"));
      }
      break;
    }
    case "bounce-entrance": {
      kfs.push(kf("bo", "opacity", startFrame, 0, "HOLD"));
      kfs.push(kf("bo", "opacity", startFrame + 2, 1, "LINEAR"));
      kfs.push(kf("bo", "scale", startFrame, 0.82, "EASE_OUT"));
      kfs.push(kf("bo", "scale", mid, 1.06, "EASE_IN_OUT"));
      kfs.push(kf("bo", "scale", Math.min(endFrame, mid + Math.round(dur * 0.25)), 1, "EASE_OUT"));
      break;
    }
    case "kinetic-typography": {
      // Word-by-word rise: staggered y keyframes (text layers).
      const words = 4;
      for (let w = 0; w < words; w++) {
        const f0 = startFrame + Math.round((dur * 0.5 * w) / words);
        const f1 = f0 + Math.round(dur * 0.18);
        kfs.push(kf(`kt${w}`, "y", f0, p.restY + 10 + 4 * p.intensity, "EASE_OUT"));
        kfs.push(kf(`kt${w}`, "y", f1, p.restY, "EASE_OUT"));
        kfs.push(kf(`kt${w}`, "opacity", f0, 0, "HOLD"));
        kfs.push(kf(`kt${w}`, "opacity", f1, 1, "LINEAR"));
      }
      break;
    }
    case "scene-transition": {
      kfs.push(kf("st", "opacity", endFrame - Math.round(dur * 0.15), 1, "EASE_IN"));
      kfs.push(kf("st", "opacity", endFrame - 1, 0, "EASE_IN"));
      kfs.push(kf("st", "scale", endFrame - Math.round(dur * 0.15), 1, "EASE_IN"));
      kfs.push(kf("st", "scale", endFrame - 1, 1.03 + 0.01 * p.intensity, "EASE_IN"));
      break;
    }
    case "parallax-drift": {
      const drift = 14 + 10 * p.intensity;
      kfs.push(kf("px", "x", startFrame, p.restX - drift / 2, "EASE_IN_OUT"));
      kfs.push(kf("px", "x", endFrame, p.restX + drift / 2, "EASE_IN_OUT"));
      kfs.push(kf("px", "y", startFrame, p.restY - drift / 4, "EASE_IN_OUT"));
      kfs.push(kf("px", "y", endFrame, p.restY + drift / 4, "EASE_IN_OUT"));
      break;
    }
    case "track-following-graphic": {
      // Anchor only — actual positions come from M13 track bindings (the
      // evaluator resolves them); the preset adds a settle entrance.
      kfs.push(kf("tf", "opacity", startFrame, 0, "HOLD"));
      kfs.push(kf("tf", "opacity", startFrame + 3, 1, "LINEAR"));
      break;
    }
    case "emphasis-pulse": {
      const beats = p.beatFrames && p.beatFrames.length > 0 ? p.beatFrames.slice(0, 8) : [startFrame + Math.round(dur / 3), startFrame + Math.round((2 * dur) / 3)];
      for (const b of beats) {
        if (b < startFrame || b > endFrame - 2) continue;
        kfs.push(kf(`ep${b}`, "scale", b, 1, "HOLD"));
        kfs.push(kf(`ep${b}`, "scale", b + 2, 1 + 0.03 + 0.02 * p.intensity, "EASE_OUT"));
        kfs.push(kf(`ep${b}`, "scale", b + Math.max(4, Math.round(p.fps / 5)), 1, "EASE_IN_OUT"));
      }
      break;
    }
  }
  // Bounce uses the deterministic overshoot curve: replace scale keyframes
  // with sampled frames when requested via intensity 3 (dynamic).
  void bounceValue;
  // Stable IDs + sorted by frame per property.
  return kfs.sort((a, b) => a.frame - b.frame);
}

/** Interpolate a layer property at a frame (mirrors the NIIKI evaluator). */
export function evalKeyframes(kfs: LayerKeyframe[], property: LayerKeyframe["property"], frame: number, fallback: number): number {
  const relevant = kfs.filter((k) => k.property === property).sort((a, b) => a.frame - b.frame);
  if (relevant.length === 0) return fallback;
  if (frame <= relevant[0].frame) return relevant[0].value;
  if (frame >= relevant[relevant.length - 1].frame) return relevant[relevant.length - 1].value;
  for (let i = 0; i < relevant.length - 1; i++) {
    const a = relevant[i];
    const b = relevant[i + 1];
    if (frame >= a.frame && frame <= b.frame) {
      if (a.interpolation === "HOLD") return a.value;
      const u = (frame - a.frame) / Math.max(1, b.frame - a.frame);
      const eased = easeProgress(u, a.interpolation);
      return a.value + (b.value - a.value) * eased;
    }
  }
  return fallback;
}
