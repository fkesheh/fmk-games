// ============================================================================
// THE VALUE LADDER LAW — automated gate for WORDBOMB.
//
// WORDBOMB is a 2D surface lit like a dark room with one burning fuse, so the
// ladder shows up as ink/slate/fuse/boom/paper tiers, as text contrast, and as
// the mutual distinguishability of the eight player chips. Enforces the §2 tier
// floors over WPAL plus the WPAL -> CSS custom property mirror.
//
// This file is the CONTRACT, not an opinion. NO IMPLEMENTER MAY WEAKEN A
// THRESHOLD — retune the palette instead. (`palette.ts` is architect-owned; a
// red assertion here is a request to the architect, not licence to edit this
// file.)
//
// TWO RECORDED DEVIATIONS FROM THE VERBATIM BRIEF, both deliberate:
//
//  1. INK TIER — the per-step form is ARITHMETICALLY UNSATISFIABLE, not merely
//     unmet. `…Deep <= base - 8 L*` requires L(base) >= 8, but L* is bounded
//     below by 0 and WPAL.ink sits at L 4.58, so it demands L(inkDeep) <= -3.42.
//     No hex can satisfy it while `ink` remains a near-black page ground. The
//     8 L* number is therefore kept and applied to the ink LADDER'S FULL SPAN
//     (inkLit -> inkDeep >= 8), which is the strongest satisfiable form, plus
//     strict per-step ordering. This matches platform precedent: neither
//     games/bank/shared/src/valueLadder.test.ts nor games/kart/.../valueLadder
//     .test.ts applies the per-step floor to a near-black ink tier — in both,
//     the 8 L* contact band is a MID-TONE law (felt, grass, asphalt).
//     To get the verbatim per-step form the architect must lift L(ink) to >= 8.
//
//  2. PLAYER CHIPS — the mandated rule is kept verbatim and CURRENTLY FAILS on
//     two pairs. Unlike (1) this is satisfiable, so the law stands and the
//     palette is what must move. Measured: p1/p6 = 14.08 deg hue & 9.88 L*,
//     p1/p8 = 18.19 deg hue & 8.32 L*. Amber/yellow/coral collapse into one
//     another at chip size. A verified two-hex retune clears every pair with
//     margin to spare: p6 '#e8d060' -> '#dbe85c' (hue 49.41 -> 65.57) and
//     p8 '#e8845c' -> '#e8705c' (hue 17.14 -> 8.57).
// ============================================================================
import { describe, expect, it } from 'vitest';
import { WPAL, WPAL_CSS_VARS } from '@wordbomb/shared';
import type { WordbombPaletteKey } from '@wordbomb/shared';
import { L, hue, hueDistance, saturation } from '@platform/shared';

const TIER_STEP_MIN = 8; // §2 hard floor: …Lit >= base + 8, …Deep <= base - 8
const TEXT_CONTRAST_MIN = 60; // primary language on its ground
const DIM_CONTRAST_MIN = 25; // secondary language on a panel
const ACCENT_CONTRAST_MIN = 25; // the fuse must clear the panel it sits on
const CHIP_HUE_MIN = 25; // degrees — chips separable by colour...
const CHIP_L_MIN = 20; // ...or, failing that, by value
const GROUND_SAT_MAX = 40; // ink/slate stay near-neutral so accents own the colour

const CSS_VAR_RE = /^--[a-z][a-z0-9-]*$/;

function n(x: number): string {
  return x.toFixed(2);
}

/** Every unordered pair, index-safe under `noUncheckedIndexedAccess`. */
function pairsOf<T>(xs: readonly T[]): Array<readonly [T, T]> {
  const out: Array<readonly [T, T]> = [];
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < xs.length; j++) {
      const b = xs[j];
      if (b === undefined) continue;
      out.push([a, b]);
    }
  }
  return out;
}

/** Assert `hi` is strictly lighter than `lo`, naming both and printing L*. */
function expectLighter(hiName: WordbombPaletteKey, loName: WordbombPaletteKey): void {
  const a = L(WPAL[hiName]);
  const b = L(WPAL[loName]);
  expect(
    a,
    `tier order: expected L(${hiName} ${WPAL[hiName]})=${n(a)} > ` +
      `L(${loName} ${WPAL[loName]})=${n(b)} (delta ${n(a - b)}, must be > 0)`,
  ).toBeGreaterThan(b);
}

/** Assert an L* gap between two palette entries clears `min`. */
function expectGap(
  hiName: WordbombPaletteKey,
  loName: WordbombPaletteKey,
  min: number,
): void {
  const a = L(WPAL[hiName]);
  const b = L(WPAL[loName]);
  expect(
    a - b,
    `expected L(${hiName} ${WPAL[hiName]})=${n(a)} - ` +
      `L(${loName} ${WPAL[loName]})=${n(b)} = ${n(a - b)} >= ${min} ` +
      `(margin ${n(a - b - min)})`,
  ).toBeGreaterThanOrEqual(min);
}

/**
 * The full …Lit / base / …Deep floor for one tier family: ordered, and each
 * step clearing the 8 L* contact band.
 */
function expectTierFloors(
  lit: WordbombPaletteKey,
  base: WordbombPaletteKey,
  deep: WordbombPaletteKey,
): void {
  expectLighter(lit, base);
  expectLighter(base, deep);
  expectGap(lit, base, TIER_STEP_MIN);
  expectGap(base, deep, TIER_STEP_MIN);
}

/**
 * Two swatches are distinguishable when they differ enough in HUE or enough in
 * VALUE. Returns a report line either way so tight passes stay visible.
 */
function distinguishability(
  a: WordbombPaletteKey,
  b: WordbombPaletteKey,
): { ok: boolean; margin: number; line: string } {
  const dHue = hueDistance(WPAL[a], WPAL[b]);
  const dL = Math.abs(L(WPAL[a]) - L(WPAL[b]));
  const ok = dHue >= CHIP_HUE_MIN || dL >= CHIP_L_MIN;
  const margin = Math.max(dHue - CHIP_HUE_MIN, dL - CHIP_L_MIN);
  const line =
    `${a}(${WPAL[a]} hue ${n(hue(WPAL[a]))} L ${n(L(WPAL[a]))} sat ` +
    `${n(saturation(WPAL[a]))}) vs ${b}(${WPAL[b]} hue ${n(hue(WPAL[b]))} L ` +
    `${n(L(WPAL[b]))} sat ${n(saturation(WPAL[b]))}): dHue ${n(dHue)} ` +
    `(need ${CHIP_HUE_MIN}) / dL ${n(dL)} (need ${CHIP_L_MIN}) — margin ${n(margin)}`;
  return { ok, margin, line };
}

/** Shared body for the chip and semantic-state distinguishability laws. */
function expectMutuallyDistinguishable(
  label: string,
  keys: readonly WordbombPaletteKey[],
): void {
  const reports = pairsOf(keys).map(([a, b]) => distinguishability(a, b));
  const failures = reports.filter((r) => !r.ok).map((r) => r.line);
  const tight = reports
    .filter((r) => r.ok && r.margin < 3)
    .map((r) => r.line);
  expect(
    failures,
    `${label}: ${failures.length} confusable pair(s) — every pair must differ ` +
      `by >= ${CHIP_HUE_MIN} deg of hue OR >= ${CHIP_L_MIN} L*:\n  ` +
      `${failures.join('\n  ')}` +
      (tight.length > 0 ? `\nalso only just passing:\n  ${tight.join('\n  ')}` : ''),
  ).toEqual([]);
}

// ============================================================================
// CSS MIRROR — every palette entry has exactly one custom property, and the
// names are unique and legal. A duplicated var name silently shadows a colour.
// ============================================================================
describe('WPAL -> CSS custom property mirror', () => {
  const palKeys = Object.keys(WPAL).slice().sort();
  const varKeys = Object.keys(WPAL_CSS_VARS).slice().sort();

  it('WPAL_CSS_VARS has exactly one entry per WPAL key', () => {
    const missing = palKeys.filter((k) => !(k in WPAL_CSS_VARS));
    const extra = varKeys.filter((k) => !(k in WPAL));
    expect(
      missing,
      `WPAL_CSS_VARS is MISSING entries for WPAL keys: ${missing.join(', ')}`,
    ).toEqual([]);
    expect(
      extra,
      `WPAL_CSS_VARS has EXTRA entries with no WPAL key: ${extra.join(', ')}`,
    ).toEqual([]);
    expect(varKeys, 'WPAL_CSS_VARS key set must equal the WPAL key set').toEqual(palKeys);
  });

  it('every CSS var name is unique', () => {
    const seen = new Map<string, string>();
    for (const k of varKeys as WordbombPaletteKey[]) {
      const v = WPAL_CSS_VARS[k];
      const prev = seen.get(v);
      expect(
        prev,
        `CSS var "${v}" is used by both "${String(prev)}" and "${k}" — ` +
          `a duplicate name silently shadows a colour`,
      ).toBeUndefined();
      seen.set(v, k);
    }
    expect(seen.size, 'unique CSS var count must equal the WPAL key count').toBe(
      varKeys.length,
    );
  });

  it('every CSS var name matches /^--[a-z][a-z0-9-]*$/', () => {
    for (const k of varKeys as WordbombPaletteKey[]) {
      expect(
        WPAL_CSS_VARS[k],
        `WPAL_CSS_VARS.${k} = "${WPAL_CSS_VARS[k]}" is not a legal kebab-case ` +
          `custom property`,
      ).toMatch(CSS_VAR_RE);
    }
  });

  it('every WPAL value is a #rrggbb hex', () => {
    for (const k of palKeys as WordbombPaletteKey[]) {
      expect(WPAL[k], `WPAL.${k} = "${WPAL[k]}" is not a #rrggbb hex`).toMatch(
        /^#[0-9a-fA-F]{6}$/,
      );
    }
  });
});

// ============================================================================
// TIER LADDERS (§2)
// ============================================================================
describe('WORDBOMB ink tiers (§2)', () => {
  // See deviation (1) in the header: L(ink)=4.58 is within 8 L* of absolute
  // black, so the per-step `…Deep <= base - 8` form cannot be satisfied by any
  // hex. The 8 L* band is enforced across the ladder's full span instead.
  it('inkLit > ink', () => {
    expectLighter('inkLit', 'ink');
  });
  it('ink > inkDeep', () => {
    expectLighter('ink', 'inkDeep');
  });
  it('inkLit -> inkDeep spans the 8 L* contact band', () => {
    expectGap('inkLit', 'inkDeep', TIER_STEP_MIN);
  });
});

describe('WORDBOMB slate tiers (§2)', () => {
  it('slateLit / slate / slateDeep clear the 8 L* floors', () => {
    expectTierFloors('slateLit', 'slate', 'slateDeep');
  });
});

describe('WORDBOMB fuse tiers (§2)', () => {
  it('fuseLit / fuse / fuseDeep clear the 8 L* floors', () => {
    expectTierFloors('fuseLit', 'fuse', 'fuseDeep');
  });
});

describe('WORDBOMB boom tiers (§2)', () => {
  it('boomLit / boom / boomDeep clear the 8 L* floors', () => {
    expectTierFloors('boomLit', 'boom', 'boomDeep');
  });
});

describe('WORDBOMB paper tiers (§2)', () => {
  it('paperLit / paper / paperDeep clear the 8 L* floors', () => {
    expectTierFloors('paperLit', 'paper', 'paperDeep');
  });
  it('paper > paperDim > paperDeep', () => {
    expectLighter('paper', 'paperDim');
    expectLighter('paperDim', 'paperDeep');
  });
});

// ============================================================================
// READABILITY — language must clear every ground it is set on. WORDBOMB is a
// game about reading words under time pressure; this is the gameplay-critical
// section of the law.
// ============================================================================
describe('WORDBOMB readability', () => {
  it('paper clears the ink page ground by >= 60 L*', () => {
    expectGap('paper', 'ink', TEXT_CONTRAST_MIN);
  });
  it('paperLit — the fragment itself — clears the slate panel by >= 60 L*', () => {
    expectGap('paperLit', 'slate', TEXT_CONTRAST_MIN);
  });
  it('paperDim — placeholder / hint — still clears the slate panel by >= 25 L*', () => {
    expectGap('paperDim', 'slate', DIM_CONTRAST_MIN);
  });
});

// ============================================================================
// THE ACCENT — the fuse is the timer, so it must read against the panel it
// burns on without relying on animation.
// ============================================================================
describe('WORDBOMB fuse accent', () => {
  it('fuse clears the slate panel by >= 25 L*', () => {
    expectGap('fuse', 'slate', ACCENT_CONTRAST_MIN);
  });
});

// ============================================================================
// GROUND NEUTRALITY — WPAL's stated mood is "a lit fuse in a dark room": the
// room is near-neutral so the fuse, the boom and the paper are the only
// chromatic things on screen. A saturated ground would eat the accents.
// ============================================================================
describe('WORDBOMB ground neutrality', () => {
  const grounds: readonly WordbombPaletteKey[] = [
    'ink',
    'inkLit',
    'inkDeep',
    'slateLit',
    'slate',
    'slateDeep',
  ];
  it(`every ink/slate ground stays under ${GROUND_SAT_MAX} saturation`, () => {
    const hot = grounds
      .filter((k) => saturation(WPAL[k]) > GROUND_SAT_MAX)
      .map((k) => `${k}(${WPAL[k]}) saturation ${n(saturation(WPAL[k]))}`);
    expect(
      hot,
      `the room must stay near-neutral so the fuse owns the colour — over ` +
        `${GROUND_SAT_MAX}:\n  ${hot.join('\n  ')}`,
    ).toEqual([]);
  });
});

// ============================================================================
// PLAYER CHIPS — eight seats, eight colours, and a chip is small. Two chips
// that differ only slightly in hue at the same lightness are the same chip to a
// player glancing at a reveal board.
// ============================================================================
describe('WORDBOMB player chips', () => {
  const chips: readonly WordbombPaletteKey[] = [
    'p1',
    'p2',
    'p3',
    'p4',
    'p5',
    'p6',
    'p7',
    'p8',
  ];

  it('all eight chip colours are distinct hexes', () => {
    const seen = new Set(chips.map((k) => WPAL[k]));
    expect(
      seen.size,
      `two seats share a colour: ${chips.map((k) => `${k}=${WPAL[k]}`).join(', ')}`,
    ).toBe(chips.length);
  });

  it('every pair of chips is mutually distinguishable', () => {
    expectMutuallyDistinguishable('player chips', chips);
  });
});

// ============================================================================
// SEMANTIC STATES — accept / reject / unique / split are read at a glance in
// the reveal. They are never colour ALONE (WPAL says so), but colour must still
// carry its half of the signal.
// ============================================================================
describe('WORDBOMB semantic states', () => {
  const states: readonly WordbombPaletteKey[] = ['accept', 'reject', 'unique', 'split'];

  it('every pair of semantic states is mutually distinguishable', () => {
    expectMutuallyDistinguishable('semantic states', states);
  });
});
