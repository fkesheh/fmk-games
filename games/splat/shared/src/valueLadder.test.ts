// ============================================================================
// THE VALUE LADDER LAW — automated gate for SKI SPLAT.
//
// Enforces the skier-identity and terrain laws over SPAL: on a snow-white
// canvas the player colours are the ONLY identity channel at speed (glyphs
// help, colour carries), so their contrast against snow and their pairwise
// separation under colour-blindness simulation are load-bearing, not taste.
//
// This file is the CONTRACT, not an opinion. NO IMPLEMENTER MAY WEAKEN A
// THRESHOLD — retune the palette instead.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { MAX_PLAYERS, SKIER_COLORS, SPAL } from '@splat/shared';
import { L, hexToRgb, luminance } from '@platform/shared';

const SKIER_VS_SNOW_MIN = 2.8; // WCAG contrast ratio; measured worst is 3.1:1
const PLANT_BELOW_SNOW_MIN = 25; // CIE L* — plants must sit clearly under snow
const CVD_PAIR_MIN = 0.09; // simulated-RGB Euclidean distance, worst pair
// (measured worst: 0.105, ember/burnt-orange under deuteranopia)

function n(x: number): string {
  return x.toFixed(1);
}

/** WCAG contrast ratio (1..21) between two hex colours. */
function contrastRatio(a: string, b: string): number {
  const ya = luminance(a);
  const yb = luminance(b);
  const hi = Math.max(ya, yb);
  const lo = Math.min(ya, yb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Names aligned with SKIER_COLORS, so a failure names the skier, not a hex. */
const SKIER_NAMES = [
  'azure',
  'ember red',
  'burnt orange',
  'charcoal',
  'violet',
  'deep teal',
  'magenta',
  'navy',
] as const;

// ---------------------------------------------------------------------------
// Colour-blindness simulation. @platform/shared has no simulator, so the
// Machado et al. 2009 matrices (severity 1.0, full precision, applied to
// gamma-encoded sRGB triples exactly as published) live here. Distance is the
// Euclidean norm in the simulated sRGB space — the metric the palette header's
// documented numbers (worst pair 0.105, ember/burnt-orange deutan) were
// measured in.
// ---------------------------------------------------------------------------
type Mat3 = readonly (readonly [number, number, number])[];

const MACHADO: Record<'protanopia' | 'deuteranopia', Mat3> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

/** Simulate `hex` under a Machado matrix; returns the clamped sRGB triple. */
function simulate(hex: string, m: Mat3): [number, number, number] {
  const { r, g, b } = hexToRgb(hex);
  const v = [r / 255, g / 255, b / 255];
  const out = m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  return [
    Math.min(1, Math.max(0, out[0] ?? 0)),
    Math.min(1, Math.max(0, out[1] ?? 0)),
    Math.min(1, Math.max(0, out[2] ?? 0)),
  ];
}

function simDistance(a: string, b: string, m: Mat3): number {
  const sa = simulate(a, m);
  const sb = simulate(b, m);
  return Math.hypot(sa[0] - sb[0], sa[1] - sb[1], sa[2] - sb[2]);
}

// ============================================================================
// SKY / FOG LAW — fog is matched to the horizon stop so the world dissolves
// into sky (STYLE_BIBLE; the kart suite's S2).
// ============================================================================
describe('SPLAT sky/fog law (S2)', () => {
  it('there is no separate fog colour — the fog IS skyHorizon', () => {
    // SPAL deliberately carries no `fog` key: the client builds FogExp2 and
    // the clear colour straight from SPAL.skyHorizon (client/render/scene.ts),
    // so fog === horizon BY CONSTRUCTION. A future `fog` entry would break
    // that single source — adding one fails here.
    expect(
      'fog' in SPAL,
      `SPAL grew a separate fog entry — the style law is fog === skyHorizon ` +
        `(${SPAL.skyHorizon}); use skyHorizon at the call site instead`,
    ).toBe(false);
  });
});

// ============================================================================
// PLANT TIERS — the antagonists must sit clearly BELOW the snow canvas.
// ============================================================================
describe('SPLAT plant tiers vs snow', () => {
  const plants = ['pine', 'pineDark', 'shrub', 'shrubDark', 'thorn'] as const;
  for (const key of plants) {
    it(`${key} is >= ${PLANT_BELOW_SNOW_MIN} L* below snow`, () => {
      const drop = L(SPAL.snow) - L(SPAL[key]);
      expect(
        drop,
        `plant tier: expected L(snow ${SPAL.snow})=${n(L(SPAL.snow))} - ` +
          `L(${key} ${SPAL[key]})=${n(L(SPAL[key]))} = ${n(drop)} >= ${PLANT_BELOW_SNOW_MIN} — ` +
          `a plant that approaches snow's value disappears against the piste`,
      ).toBeGreaterThanOrEqual(PLANT_BELOW_SNOW_MIN);
    });
  }
});

// ============================================================================
// SKIER IDENTITY LAW — MAX_PLAYERS colours, all readable on snow, all
// tellable apart even under protanopia/deuteranopia.
// ============================================================================
describe('SPLAT skier identity (8-skier field)', () => {
  it('there is exactly one colour per player slot', () => {
    expect(
      SKIER_COLORS.length,
      `SKIER_COLORS.length=${SKIER_COLORS.length} must equal MAX_PLAYERS=${MAX_PLAYERS} — ` +
        `a short list hands two skiers the same colour`,
    ).toBe(MAX_PLAYERS);
  });

  it('no skier colour collides with another skier or with sunGold', () => {
    // sunGold is the finish gate / crown: a skier wearing it would read as
    // "already finished". It is deliberately NOT a skier colour (1.61:1 on
    // snow, below the bar).
    const all = [...SKIER_COLORS, SPAL.sunGold];
    expect(
      new Set(all).size,
      `duplicate hex across SKIER_COLORS + sunGold: ${all.join(' ')}`,
    ).toBe(all.length);
  });

  it('every skier colour clears 2.8:1 contrast against snow', () => {
    const failures: string[] = [];
    for (let i = 0; i < SKIER_COLORS.length; i++) {
      const c = SKIER_COLORS[i] as string;
      const r = contrastRatio(c, SPAL.snow);
      if (r < SKIER_VS_SNOW_MIN) {
        failures.push(
          `${SKIER_NAMES[i] ?? '?'} ${c}: ${r.toFixed(2)}:1 < ${SKIER_VS_SNOW_MIN}:1 vs snow ` +
            `${SPAL.snow} — this skier washes out on the piste`,
        );
      }
    }
    expect(failures, `skier colours failing on snow:\n  ${failures.join('\n  ')}`).toEqual([]);
  });

  for (const [cvd, m] of Object.entries(MACHADO)) {
    it(`every skier pair is tellable apart under ${cvd} (>= ${CVD_PAIR_MIN})`, () => {
      const failures: string[] = [];
      let worst = Infinity;
      let who = '';
      for (let i = 0; i < SKIER_COLORS.length; i++) {
        for (let j = i + 1; j < SKIER_COLORS.length; j++) {
          const a = SKIER_COLORS[i] as string;
          const b = SKIER_COLORS[j] as string;
          const d = simDistance(a, b, m);
          if (d < worst) {
            worst = d;
            who = `${SKIER_NAMES[i]} / ${SKIER_NAMES[j]}`;
          }
          if (d < CVD_PAIR_MIN) {
            failures.push(
              `${SKIER_NAMES[i]} ${a} / ${SKIER_NAMES[j]} ${b}: simulated distance ` +
                `${d.toFixed(3)} < ${CVD_PAIR_MIN} — indistinguishable under ${cvd}`,
            );
          }
        }
      }
      expect(
        failures,
        `skier pairs too close under ${cvd} (worst: ${who} at ${worst.toFixed(3)}):` +
          `\n  ${failures.join('\n  ')}`,
      ).toEqual([]);
    });
  }
});
