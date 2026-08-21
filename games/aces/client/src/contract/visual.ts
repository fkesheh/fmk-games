// ============================================================================
// ACES client visual vocabulary — FROZEN Layer-1.
//
// The shared drawing kit every render module imports. Exists so five
// independent art agents produce ONE art-directed game: palette helpers that
// refuse non-palette colors, one puff model for every soft mass, seeded
// variation everywhere, and the grain pass that unifies the frame into a
// printed page. See STYLE_BIBLE §2/§9.
// ============================================================================

import { APAL, type ApalKey } from '@aces/shared/palette';
import { mulberry32 } from '@aces/shared/maps';

export const PAL = APAL;
export type PalKey = ApalKey;

// ---- color helpers -----------------------------------------------------------

/** Mix two PALETTE entries. t=0 → a, t=1 → b. Both endpoints must be keys. */
export function mixA(a: PalKey, b: PalKey, t: number): string {
  const ca = hex(APAL[a]);
  const cb = hex(APAL[b]);
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * k);
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * k);
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * k);
  return `rgb(${r},${g},${bl})`;
}

/** Lighten (f>0) or darken (f<0) a palette entry toward paper / ink. */
export function shadeA(key: PalKey, f: number): string {
  return f >= 0 ? mixA(key, 'paper', f) : mixA(key, 'ink', -f);
}

/** Palette entry with alpha suffix — the ONLY sanctioned transparency form. */
export function withAlpha(key: PalKey, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  return `${APAL[key]}${a.toString(16).padStart(2, '0')}`;
}

function hex(h: string): [number, number, number] {
  return [
    parseInt(h.slice(1, 3), 16)!,
    parseInt(h.slice(3, 5), 16)!,
    parseInt(h.slice(5, 7), 16)!,
  ];
}

// ---- seeded variation ---------------------------------------------------------

/** Seeded RNG wrapper — the ONLY randomness source allowed under games/aces. */
export function makeRng(seed: number): () => number {
  return mulberry32(seed);
}

/** Stable string hash for per-entity seeds (bot personalities, prop variants). */
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---- draw primitives -------------------------------------------------------------

/** Trace a closed polygon; caller sets fill/stroke and calls fill/stroke. */
export function poly(ctx: CanvasRenderingContext2D, pts: ReadonlyArray<[number, number]>): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
  ctx.closePath();
}

/**
 * THE soft-mass model: one radial-gradient puff factory shared by clouds,
 * smoke, blast bloom and splashes (STYLE_BIBLE §2 — nothing else may create
 * gradients). Draws centered at x,y with radius r.
 */
export function softPuff(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  colorInner: string,
  colorOuter: string,
): void {
  const g = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
  g.addColorStop(0, colorInner);
  g.addColorStop(1, colorOuter);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/** Aircraft hairline ink outline (STYLE_BIBLE §2). Caller strokes after poly. */
export const INK_STROKE = withAlpha('ink', 0.55);

// ---- frame unification --------------------------------------------------------------

/** Film-grain overlay pass, ≤0.05 alpha, deterministic per seed+t. */
export function applyGrain(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number): void {
  const rng = makeRng(seed);
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = APAL.ink;
  const step = 3;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (rng() < 0.12) ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.restore();
}

// ---- canvas plumbing -------------------------------------------------------------------

/** Size a canvas to its element box × DPR (capped at 2). Returns css size. */
export function fitCanvas(canvas: HTMLCanvasElement): { w: number; h: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  return { w, h };
}
