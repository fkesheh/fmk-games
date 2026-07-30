// ============================================================================
// THE VALUE LADDER LAW — automated gate for KART GP.
//
// Enforces VISUAL_UPGRADE.md §1 (S1, S2) and §2 tier ordering over KPAL. KART's
// worst visual problem is large uncut surfaces: the grass and asphalt tier
// ladders below are what break them up, so their ordering is load-bearing.
//
// This file is the CONTRACT, not an opinion. NO IMPLEMENTER MAY WEAKEN A
// THRESHOLD — retune the palette instead.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { KPAL } from '@kart/shared';
import { L, hexToRgb, saturation } from '@platform/shared';

const S1_MIN = 12; // §1 S1 zenith / horizon separation
const TIER_SPAN_MIN = 8; // §2 hard floor: base -> …Deep contact band

function n(x: number): string {
  return x.toFixed(1);
}

/** "Cooler", machine-checkable: blue-minus-red channel difference. */
function blueBias(hex: string): number {
  const { r, b } = hexToRgb(hex);
  return b - r;
}

/** Assert `hi` is strictly lighter than `lo`, naming both and printing L*. */
function expectLighter(hiName: string, hiHex: string, loName: string, loHex: string): void {
  const a = L(hiHex);
  const b = L(loHex);
  expect(
    a,
    `tier order: expected L(${hiName})=${n(a)} > L(${loName})=${n(b)} ` +
      `(delta ${n(a - b)}, must be > 0)`,
  ).toBeGreaterThan(b);
}

/** Assert a base->deep span clears the §2 hard floor. */
function expectSpan(hiName: string, hiHex: string, loName: string, loHex: string): void {
  const a = L(hiHex);
  const b = L(loHex);
  expect(
    a - b,
    `tier span: expected L(${hiName})=${n(a)} - L(${loName})=${n(b)} = ${n(a - b)} ` +
      `>= ${TIER_SPAN_MIN}`,
  ).toBeGreaterThanOrEqual(TIER_SPAN_MIN);
}

// ============================================================================
// SKY LAW
// ============================================================================
describe('KART sky law (§1 S1/S2)', () => {
  it('S1 — skyHigh is >= 12 L* darker than horizon', () => {
    const hi = L(KPAL.skyHigh);
    const ho = L(KPAL.horizon);
    expect(
      ho - hi,
      `S1: expected L(horizon ${KPAL.horizon})=${n(ho)} - ` +
        `L(skyHigh ${KPAL.skyHigh})=${n(hi)} = ${n(ho - hi)} >= ${S1_MIN}`,
    ).toBeGreaterThanOrEqual(S1_MIN);
  });

  it('S1 — skyHigh is cooler than horizon', () => {
    const bhi = blueBias(KPAL.skyHigh);
    const bho = blueBias(KPAL.horizon);
    expect(
      bhi,
      `S1: zenith must be COOLER — expected blueBias(skyHigh ${KPAL.skyHigh})=${bhi} ` +
        `> blueBias(horizon ${KPAL.horizon})=${bho}`,
    ).toBeGreaterThan(bho);
  });

  it('S2 — fog matches the horizon stop exactly', () => {
    expect(
      KPAL.fog,
      `S2: expected KPAL.fog (${KPAL.fog}) === KPAL.horizon (${KPAL.horizon}) — ` +
        `fog never matches the zenith`,
    ).toBe(KPAL.horizon);
  });
});

// ============================================================================
// TERRAIN TIERS — the fix for the single flat uniform green.
// ============================================================================
describe('KART grass tiers (§2)', () => {
  it('grassLit > grass', () => {
    expectLighter('grassLit', KPAL.grassLit, 'grass', KPAL.grass);
  });
  it('grass > grassDark', () => {
    expectLighter('grass', KPAL.grass, 'grassDark', KPAL.grassDark);
  });
  it('grassDark > grassDeep', () => {
    expectLighter('grassDark', KPAL.grassDark, 'grassDeep', KPAL.grassDeep);
  });
  it('grass -> grassDeep clears the 8 L* contact-band floor', () => {
    expectSpan('grass', KPAL.grass, 'grassDeep', KPAL.grassDeep);
  });
});

describe('KART asphalt tiers (§2)', () => {
  it('asphaltLit > asphaltLight', () => {
    expectLighter('asphaltLit', KPAL.asphaltLit, 'asphaltLight', KPAL.asphaltLight);
  });
  it('asphaltLight > asphalt', () => {
    expectLighter('asphaltLight', KPAL.asphaltLight, 'asphalt', KPAL.asphalt);
  });
  it('asphalt > asphaltDeep', () => {
    expectLighter('asphalt', KPAL.asphalt, 'asphaltDeep', KPAL.asphaltDeep);
  });
  it('asphalt -> asphaltDeep clears the 8 L* shoulder contact-band floor', () => {
    expectSpan('asphalt', KPAL.asphalt, 'asphaltDeep', KPAL.asphaltDeep);
  });
});

// ============================================================================
// ATMOSPHERIC PERSPECTIVE — the far ridge tier fades toward the fog.
// ============================================================================
describe('KART atmospheric perspective (§4)', () => {
  it('ridgeFar is lighter than ridgeNear', () => {
    const a = L(KPAL.ridgeFar);
    const b = L(KPAL.ridgeNear);
    expect(
      a,
      `atmospheric perspective: expected L(ridgeFar)=${n(a)} > L(ridgeNear)=${n(b)} ` +
        `(delta ${n(a - b)})`,
    ).toBeGreaterThan(b);
  });

  it('ridgeFar is less saturated than ridgeNear', () => {
    const a = saturation(KPAL.ridgeFar);
    const b = saturation(KPAL.ridgeNear);
    expect(
      a,
      `atmospheric perspective: expected saturation(ridgeFar)=${n(a)} < ` +
        `saturation(ridgeNear)=${n(b)} (delta ${n(a - b)})`,
    ).toBeLessThan(b);
  });
});

// ============================================================================
// CANOPY TIERS
// ============================================================================
describe('KART tree canopy tiers (§2)', () => {
  it('treeLeafLight > treeLeaf', () => {
    expectLighter('treeLeafLight', KPAL.treeLeafLight, 'treeLeaf', KPAL.treeLeaf);
  });
  it('treeLeaf > treeLeafDeep', () => {
    expectLighter('treeLeaf', KPAL.treeLeaf, 'treeLeafDeep', KPAL.treeLeafDeep);
  });
});
