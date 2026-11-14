// The animated timeline (pure: no DOM). A clip [startMs, endMs) of the source is played at `speed`,
// optionally reversed and/or as a boomerang (forward then back), and optionally made seamless by
// cross-fading its tail into its head. planFrames() turns that into one entry per output frame
// at a constant frame rate: which source time to show, and (for the loop fade) which second source
// time to blend in and how much. Encoders only ever see constant-rate frames (brief §10).

export interface Clip {
  startMs: number;
  endMs: number;
  speed: number; // 0.25 … 4
  reverse: boolean;
  boomerang: boolean;
  loopFadeMs: number; // 0 = off
}

export interface PlannedFrame {
  /** Source time to draw (ms). */
  t: number;
  /** Position in the output loop, 0 ≤ phase < 1 (motion effects and text animations). */
  phase?: number;
  /** Optional second source time blended on top with weight `w` (the seamless-loop fade). */
  mix?: { t: number; w: number };
}

export interface Plan {
  fps: number;
  frames: PlannedFrame[];
  durationMs: number; // frames.length × 1000 / fps
}

export const SPEEDS = [0.5, 1, 1.5, 2] as const;

export function defaultClip(sourceMs: number, maxMs: number): Clip {
  return { startMs: 0, endMs: Math.max(1, Math.min(sourceMs, maxMs)), speed: 1, reverse: false, boomerang: false, loopFadeMs: 0 };
}

/** Output length of a clip before the frame-rate rounding (ms). */
export function outputMs(c: Clip): number {
  const base = Math.max(0, c.endMs - c.startMs) / c.speed;
  const len = c.boomerang ? base * 2 : base;
  return Math.max(0, len - (c.loopFadeMs > 0 ? Math.min(c.loopFadeMs, len / 2) : 0));
}

/** The longest source span (ms) whose output still fits `maxOutMs`. */
export function maxSpanMs(c: Pick<Clip, 'speed' | 'boomerang' | 'loopFadeMs'>, maxOutMs: number): number {
  // out = span/speed × (boomerang ? 2 : 1) − fade  ≤ max  →  span ≤ (max + fade) × speed / k
  const k = c.boomerang ? 2 : 1;
  return Math.floor(((maxOutMs + Math.max(0, c.loopFadeMs)) * c.speed) / k);
}

/** Clamps a clip into the source and into the target's maximum output length. */
export function clampClip(c: Clip, sourceMs: number, maxOutMs: number): Clip {
  const speed = Math.min(4, Math.max(0.25, c.speed || 1));
  let startMs = Math.max(0, Math.min(c.startMs, Math.max(0, sourceMs - 1)));
  let endMs = Math.max(startMs + 1, Math.min(c.endMs, sourceMs));
  const span = maxSpanMs({ ...c, speed }, maxOutMs);
  if (endMs - startMs > span) endMs = startMs + span;
  if (endMs <= startMs) endMs = Math.min(sourceMs, startMs + 1);
  if (endMs > sourceMs) {
    endMs = sourceMs;
    startMs = Math.max(0, endMs - span);
  }
  const loopFadeMs = Math.max(0, Math.min(c.loopFadeMs, 1000));
  return { ...c, speed, startMs, endMs, loopFadeMs };
}

/**
 * One entry per output frame. `maxOutMs` caps the output (e.g. Telegram 3000 ms): the plan never
 * exceeds it — the UI clamps the clip first, this is the last guard (never a silent cut of a valid
 * clip: clampClip() and the UI show the user the window).
 */
export function planFrames(c: Clip, fps: number, maxOutMs = Infinity): Plan {
  const span = Math.max(1, c.endMs - c.startMs);
  const base = span / c.speed; // one forward pass, output ms
  const full = c.boomerang ? base * 2 : base;
  const fade = c.loopFadeMs > 0 ? Math.min(c.loopFadeMs, full / 2) : 0;
  const out = Math.min(full - fade, maxOutMs);
  const n = Math.max(1, Math.floor((out * fps) / 1000 + 1e-6));
  // output time τ (ms, in the un-faded loop of length `full`) → source time
  const src = (tau: number): number => {
    let u = tau / base; // 0..1 forward pass, 1..2 the way back for a boomerang
    if (c.boomerang) u = u <= 1 ? u : 2 - u;
    u = Math.min(Math.max(u, 0), 1);
    if (c.reverse) u = 1 - u;
    // never sample the very end of the span (it belongs to the next frame)
    return c.startMs + Math.min(u * span, span - 1e-3);
  };
  const frames: PlannedFrame[] = [];
  for (let i = 0; i < n; i++) {
    const tau = (i * 1000) / fps;
    if (fade > 0 && tau < fade) {
      // the head fades in over the tail: at τ = 0 it shows the tail at full − fade (where the
      // previous loop ended), at τ = fade only the head
      frames.push({ t: src(tau + (full - fade)), mix: { t: src(tau), w: tau / fade }, phase: i / n });
    } else frames.push({ t: src(tau), phase: i / n });
  }
  return { fps, frames, durationMs: (n * 1000) / fps };
}

/** Picks every k-th frame of a plan for a lower frame rate (same timeline, fewer frames). */
export function resample(plan: Plan, fps: number): Plan {
  if (fps >= plan.fps) return plan;
  const n = Math.max(1, Math.floor((plan.durationMs * fps) / 1000 + 1e-6));
  const frames: PlannedFrame[] = [];
  for (let i = 0; i < n; i++) frames.push(plan.frames[Math.min(plan.frames.length - 1, Math.round((i * plan.fps) / fps))]);
  return { fps, frames, durationMs: (n * 1000) / fps };
}

/** Indexes into the full-rate frame list for a lower rate (so frames are rendered once). */
export function resampleIndexes(count: number, fromFps: number, toFps: number): number[] {
  const dur = (count * 1000) / fromFps;
  const n = Math.max(1, Math.floor((dur * toFps) / 1000 + 1e-6));
  return Array.from({ length: n }, (_, i) => Math.min(count - 1, Math.round((i * fromFps) / toFps)));
}
