// ============================================================================
// FROZEN CONTRACT — game-agnostic colour maths.
// Exists so the VALUE LADDER LAW (VISUAL_UPGRADE.md §1) is machine-checkable
// instead of a matter of opinion. Used by palette tests and by review agents.
// Pure functions, no state, no THREE dependency.
// ============================================================================

export interface Rgb {
  r: number; // 0..255
  g: number;
  b: number;
}

/** Parse `#rrggbb` (with or without `#`). Throws on malformed input. */
export function hexToRgb(hex: string): Rgb {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`bad hex: ${hex}`);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** sRGB channel (0..1) -> linear light. */
function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance Y (0..1), Rec. 709 weights. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return (
    0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255)
  );
}

/**
 * Perceptual lightness CIE L* (0..100) — THE metric the value ladder law is
 * written in. `L(mainWall) - L(ground) >= 20` etc.
 */
export function L(hex: string): number {
  const y = luminance(hex);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

/** Hue in degrees (0..360). Returns 0 for achromatic colours. */
export function hue(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** HSL saturation as 0..100 points (the unit the ladder law's escape clause uses). */
export function saturation(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return 0;
  const l = (max + min) / 2;
  return 100 * (l > 0.5 ? d / (2 - max - min) : d / (max + min));
}

/** Smallest angular distance between two hues, in degrees (0..180). */
export function hueDistance(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return d > 180 ? 360 - d : d;
}

/** Clamp to 0..255 and format one channel. */
function ch(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
}

/**
 * Linear blend between two hex colours, `t` in 0..1 (0 = a, 1 = b).
 *
 * Exists because ATMOSPHERIC PERSPECTIVE (VISUAL_UPGRADE.md §3c/§4 — the far
 * skyline tier desaturating toward the fog) needs intermediate colours that no
 * named palette entry can provide. This is the ONLY sanctioned way to produce a
 * colour that is not a literal palette entry: both endpoints must still be
 * palette entries, so the result remains traceable to the palette.
 */
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  return `#${ch(ca.r + (cb.r - ca.r) * k)}${ch(ca.g + (cb.g - ca.g) * k)}${ch(
    ca.b + (cb.b - ca.b) * k,
  )}`;
}

/**
 * Composite `over` at `alpha` on top of `under` — what an alpha-blended contact
 * shadow ACTUALLY renders as. Use it to verify a contact shadow really clears
 * the >= 8 L* drop that §1 L2b requires: the rule applies to this composite,
 * not to the raw shadow hex.
 */
export function composite(under: string, over: string, alpha: number): string {
  return mix(under, over, alpha);
}

/**
 * VISUAL_UPGRADE.md §1 L4 — hue split. Satisfied when the two families are
 * >= 25 degrees apart in hue, OR the ground is >= 15 saturation points less
 * saturated than the wall (the desaturation escape clause).
 */
export function hueSplitOk(ground: string, wall: string): boolean {
  return hueDistance(ground, wall) >= 25 || saturation(wall) - saturation(ground) >= 15;
}
