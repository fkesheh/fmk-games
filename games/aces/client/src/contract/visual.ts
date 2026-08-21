// ============================================================================
// ACES client visual vocabulary — FROZEN Layer-1.
//
// The shared drawing kit every render module imports. Exists so five
// independent art agents produce ONE art-directed game: palette helpers that
// refuse non-palette colors, one puff model for every soft mass, seeded
// variation everywhere, and the grain/vignette passes that unify the frame
// into a printed page. See STYLE_BIBLE §2/§9.
//
// Perf law this file exists to make possible: NOTHING here allocates in the
// per-frame path. Gradients are baked once into tiles/canvases at init;
// per-frame calls are plain draws.
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
    Number.parseInt(h.slice(1, 3), 16),
    Number.parseInt(h.slice(3, 5), 16),
    Number.parseInt(h.slice(5, 7), 16),
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

/** Trace a closed polygon; caller sets fill/stroke and calls fill()/stroke(). */
export function poly(ctx: CanvasRenderingContext2D, pts: ReadonlyArray<[number, number]>): void {
  if (pts.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1]);
  ctx.closePath();
}

/**
 * Trace an N-point star/burst (roundels, bar-crosses, hit markers, MVP star).
 * Outer/inner radius ratio r2/r1 controls sharpness; caller fills/strokes.
 */
export function star(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  points: number,
  r1: number,
  r2: number,
  rot = 0,
): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? r1 : r2;
    const a = rot + (i * Math.PI) / points;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * THE soft-mass model: one radial-gradient puff factory shared by clouds,
 * smoke, blast bloom and splashes (STYLE_BIBLE §2 — nothing else may create
 * gradients). Draw cost is one gradient + one fillRect — pool your puffs and
 * keep counts bounded; do NOT call with fresh colors per frame when a cached
 * string will do (hoist withAlpha/mixA results to module constants).
 *
 * Convention: pass colors through withAlpha() yourself — typical calls use a
 * solid inner and a transparent outer (`withAlpha(k, 0)`).
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

// ---- frame unification (baked once, cheap forever) ----------------------------------

const GRAIN_TILE = 256;

/**
 * Bake n film-grain tiles once at init. Each tile is seeded ink speckle on
 * transparent ground; drawGrain() pattern-fills one per frame (cycled by
 * frame index so the grain "boils" like film without any per-frame rng or
 * allocation). This is the ONLY sanctioned way to draw grain.
 */
export function makeGrainTiles(seed: number, n = 3): HTMLCanvasElement[] {
  const tiles: HTMLCanvasElement[] = [];
  for (let k = 0; k < n; k++) {
    const c = document.createElement('canvas');
    c.width = GRAIN_TILE;
    c.height = GRAIN_TILE;
    const g = c.getContext('2d');
    if (!g) continue;
    const rng = makeRng(seed + k * 7919);
    g.fillStyle = APAL.ink;
    for (let y = 0; y < GRAIN_TILE; y++) {
      for (let x = 0; x < GRAIN_TILE; x++) {
        if (rng() < 0.06) {
          g.globalAlpha = 0.05 + rng() * 0.05;
          g.fillRect(x, y, 1, 1);
        }
      }
    }
    tiles.push(c);
  }
  return tiles;
}

/** Per-frame grain pass: ONE pattern fill. Pass a frame counter as tick.
 *  Patterns are cached per context — no per-frame allocation. */
const patternCache = new WeakMap<CanvasRenderingContext2D, Map<HTMLCanvasElement, CanvasPattern>>();

export function drawGrain(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  tiles: HTMLCanvasElement[],
  tick: number,
): void {
  if (tiles.length === 0) return;
  const tile = tiles[tick % tiles.length];
  if (!tile) return;
  let cache = patternCache.get(ctx);
  if (!cache) {
    cache = new Map();
    patternCache.set(ctx, cache);
  }
  let pat = cache.get(tile);
  if (!pat) {
    const made = ctx.createPattern(tile, 'repeat');
    if (!made) return;
    pat = made;
    cache.set(tile, made);
  }
  ctx.save();
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/**
 * Bake a vignette once per resize (radial darkening toward APAL.ink corners).
 * Returns an offscreen canvas sized (w,h); draw it last with drawImage.
 * The ONLY sanctioned vignette primitive.
 */
export function makeVignette(w: number, h: number): HTMLCanvasElement | null {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  const g = c.getContext('2d');
  if (!g) return null;
  const grad = g.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.42,
    w / 2,
    h / 2,
    Math.hypot(w, h) / 2,
  );
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, withAlpha('ink', 0.34));
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  return c;
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
