// Motion effects and text animations (pure math, no DOM): a transform per loop phase (0 ≤ p < 1),
// periodic so every effect loops seamlessly. Used by the animated compositor (anim/compose.ts) to
// turn a still sticker into a video sticker / GIF / WhatsApp animation (Phase 4).

export const EFFECTS = ['none', 'pulse', 'shake', 'spin', 'bounce', 'wobble', 'float', 'heartbeat', 'glow', 'swing'] as const;
export type EffectKind = (typeof EFFECTS)[number];

export const TEXT_ANIMS = ['none', 'typewriter', 'pop', 'wave', 'blink'] as const;
export type TextAnim = (typeof TEXT_ANIMS)[number];

export interface Motion {
  dx: number; // translation, fraction of the art size
  dy: number;
  scale: number;
  rotate: number; // radians
  alpha: number;
  glow: number; // 0..1 glow strength
}

const TAU = Math.PI * 2;
const still: Motion = { dx: 0, dy: 0, scale: 1, rotate: 0, alpha: 1, glow: 0 };

/** The art's transform at loop phase p for an effect of strength s (0.2 … 2, 1 = normal). */
export function motionAt(kind: EffectKind, p: number, s = 1): Motion {
  const sin = Math.sin(TAU * p);
  switch (kind) {
    case 'pulse':
      return { ...still, scale: 1 + 0.08 * s * (0.5 - 0.5 * Math.cos(TAU * p)) };
    case 'shake':
      // two quick shakes per loop, eased so the loop point is still
      return { ...still, dx: 0.035 * s * Math.sin(TAU * 4 * p) * Math.sin(Math.PI * p), rotate: 0.03 * s * Math.sin(TAU * 4 * p + 1) * Math.sin(Math.PI * p) };
    case 'spin':
      return { ...still, rotate: TAU * p, scale: 0.92 };
    case 'bounce': {
      const h = Math.abs(Math.sin(Math.PI * 2 * p)); // two hops
      const squash = 1 - 0.06 * s * Math.max(0, 1 - h * 4);
      return { ...still, dy: -0.12 * s * h, scale: squash };
    }
    case 'wobble':
      return { ...still, rotate: 0.12 * s * sin };
    case 'float':
      return { ...still, dy: 0.05 * s * sin, rotate: 0.02 * s * Math.cos(TAU * p) };
    case 'heartbeat': {
      // two beats then rest
      // distance on the loop (wraps at 1), so the end meets the start exactly
      const beat = (c: number, w: number) => {
        const d = Math.min(Math.abs(p - c), 1 - Math.abs(p - c));
        return Math.exp(-(d * d) / (2 * w * w));
      };
      return { ...still, scale: 1 + 0.12 * s * (beat(0.15, 0.04) + 0.7 * beat(0.35, 0.04)) };
    }
    case 'glow':
      return { ...still, glow: 0.5 + 0.5 * Math.sin(TAU * p - Math.PI / 2) };
    case 'swing':
      // a pendulum hanging from the top centre
      return { ...still, rotate: 0.18 * s * sin, dy: 0.02 * s * (1 - Math.cos(TAU * p * 2)) / 2 };
    default:
      return still;
  }
}

/** For 'swing' the pivot is the top centre; every other effect turns around the centre. */
export const pivotOf = (kind: EffectKind) => (kind === 'swing' ? 'top' : 'center');

/**
 * Text animation state at phase p for a text of n characters (graphemes): how many to show, a
 * scale, an alpha and a per-character vertical wave.
 */
export function textAt(kind: TextAnim, p: number, n: number): { chars: number; scale: number; alpha: number; wave: number } {
  switch (kind) {
    case 'typewriter':
      // type during the first 70 % of the loop, then hold the full text
      return { chars: Math.min(n, Math.floor((p / 0.7) * (n + 1))), scale: 1, alpha: 1, wave: 0 };
    case 'pop': {
      const t = Math.min(1, p / 0.25);
      const back = 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2; // ease-out-back
      return { chars: n, scale: Math.max(0.01, back), alpha: Math.min(1, t * 2), wave: 0 };
    }
    case 'wave':
      return { chars: n, scale: 1, alpha: 1, wave: p };
    case 'blink':
      return { chars: n, scale: 1, alpha: p % 0.5 < 0.35 ? 1 : 0.15, wave: 0 };
    default:
      return { chars: n, scale: 1, alpha: 1, wave: 0 };
  }
}

/** Splits text into user-perceived characters (keeps emoji and Persian marks together). */
export function graphemes(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment: (s: string) => Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
  return Array.from(text);
}
