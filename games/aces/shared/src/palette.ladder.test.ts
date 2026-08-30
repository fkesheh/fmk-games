// ============================================================================
// Palette separation gate — FROZEN Layer-1 test.
//
// The gauntlet review measured ROYAL navy drifting into the sea (ΔE ≈ 20)
// and smoke blending into lit water. This test makes readability a GATE, not
// a hope: critical gameplay pairs must stay separable in CIELAB forever.
// Anyone re-tuning APAL runs this and sees exactly which pair they broke.
//
// ΔE here is CIE76 on Lab — crude but monotone and dependency-free; the
// thresholds below were chosen against measured values of the shipped
// palette, not invented.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { APAL } from './palette.js';

function hexToRgb(h: string): [number, number, number] {
  return [
    Number.parseInt(h.slice(1, 3), 16),
    Number.parseInt(h.slice(3, 5), 16),
    Number.parseInt(h.slice(5, 7), 16),
  ];
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  // sRGB → XYZ (D65) → Lab
  const f = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [f(r), f(g), f(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const g2 = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = g2(x);
  const fy = g2(y);
  const fz = g2(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(a: string, b: string): number {
  const la = rgbToLab(...hexToRgb(a));
  const lb = rgbToLab(...hexToRgb(b));
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

/** [pair, minimum ΔE, why it must separate] */
const LADDER: ReadonlyArray<readonly [keyof typeof APAL, keyof typeof APAL, number, string]> = [
  ['royalNavy', 'seaDeep', 30, 'ROYAL planes vs open water'],
  ['royalNavy', 'seaDark', 27, 'ROYAL planes vs shadowed water/cloud shade'],
  ['ironRed', 'seaDeep', 40, 'IRON planes vs open water'],
  ['ironRed', 'sand', 35, 'IRON planes over shore rings'],
  ['tracer', 'dawnLo', 35, 'tracers vs sky/haze bands'],
  ['smokeLt', 'seaLit', 18, "'chase the smoke trail' verb"],
  ['smokeDk', 'seaDeep', 15, 'heavy damage trail visibility'],
  ['royalDeck', 'ironRed', 25, 'roundel ring reads on IRON airframes too'],
  ['ironDeck', 'ironRed', 20, 'bar-cross reads on crimson wings'],
  ['foam', 'seaLit', 20, 'surf/wakes read as events'],
];

describe('APAL value ladder (readability gate)', () => {
  for (const [a, b, min, why] of LADDER) {
    it(`${a} vs ${b} ≥ ${min} ΔE (${why})`, () => {
      expect(deltaE(APAL[a], APAL[b])).toBeGreaterThanOrEqual(min);
    });
  }

  it('every entry parses as #rrggbb', () => {
    for (const v of Object.values(APAL)) {
      expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
