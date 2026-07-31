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
import { KART_COLORS, KPAL, MAX_PLAYERS } from '@kart/shared';
import { L, hexToRgb, hueDistance, saturation } from '@platform/shared';

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

// ============================================================================
// KART IDENTITY LAW — MAX_PLAYERS liveries, all tellable apart.
//
// With a 20-kart grid, livery is the ONLY way to tell rivals apart on track and
// the ONLY channel the minimap has at all. Two karts that read the same is the
// same defect as two karts with the same colour, so the bar is measured, not
// eyeballed: EVERY pair differs by >= 20 deg of hue OR >= 18 L*.
//
// LEGACY EXCEPTION, stated openly: the original eight liveries were chosen
// before this law and the red/orange/yellow trio spans only 33 deg of hue, so
// two of its pairs FAIL the bar (see LEGACY_TIGHT). They are pinned at their
// measured values — they may never get closer, and no NEW colour may join them.
// Fixing them means rotating kartOrange and kartYellow (~+7 deg and ~+10 deg),
// which also moves cones, the nitro flame, signal lenses, flowers and crowd
// blocks: an art-direction call, not something to sneak in under a perf ticket.
// ============================================================================
const KART_HUE_MIN = 20; // deg of hue separation …
const KART_L_MIN = 18; // … OR L* separation. Either one clears the bar.
const DESIGN_MARGIN = 1.1; // the tightest NEW pair must clear the bar by 10%

/** Reverse KPAL lookup, so a failure names the colour instead of a hex. */
const KPAL_NAME = new Map<string, string>();
for (const [k, v] of Object.entries(KPAL)) if (!KPAL_NAME.has(v)) KPAL_NAME.set(v, k);
function cname(hex: string): string {
  return `${KPAL_NAME.get(hex) ?? 'UNNAMED'} ${hex}`;
}

/** 1.0 == exactly on the bar; > 1 clears it; < 1 fails it. */
function separation(a: string, b: string): number {
  return Math.max(hueDistance(a, b) / KART_HUE_MIN, Math.abs(L(a) - L(b)) / KART_L_MIN);
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Pre-existing sub-threshold pairs, pinned at [dHue, dL] as measured today. */
const LEGACY_TIGHT = new Map<string, readonly [number, number]>([
  [pairKey(KPAL.kartOrange, KPAL.kartYellow), [15.3, 9.1]],
  [pairKey(KPAL.kartRed, KPAL.kartOrange), [17.5, 10.2]],
]);

describe('KART kart identity (20-kart grid)', () => {
  it('there is exactly one livery per grid slot', () => {
    expect(
      KART_COLORS.length,
      `KART_COLORS.length=${KART_COLORS.length} must equal MAX_PLAYERS=${MAX_PLAYERS} — ` +
        `the server assigns color = slot % KART_COLORS.length, so a short list hands ` +
        `${Math.max(0, MAX_PLAYERS - KART_COLORS.length)} karts a duplicate livery`,
    ).toBe(MAX_PLAYERS);
  });

  it('no livery is repeated', () => {
    expect(new Set(KART_COLORS).size, `duplicate hex in KART_COLORS: ${KART_COLORS.join(' ')}`).toBe(
      KART_COLORS.length,
    );
  });

  it('every livery is a named KPAL entry (no ad-hoc hex)', () => {
    const orphans = KART_COLORS.filter((c) => !KPAL_NAME.has(c));
    expect(orphans, `not in KPAL — every kart colour must trace to the palette: ${orphans}`).toEqual(
      [],
    );
  });

  it('every pair is tellable apart: >= 20 deg hue OR >= 18 L*', () => {
    const failures: string[] = [];
    for (let i = 0; i < KART_COLORS.length; i++) {
      for (let j = i + 1; j < KART_COLORS.length; j++) {
        const a = KART_COLORS[i] as string;
        const b = KART_COLORS[j] as string;
        const dh = hueDistance(a, b);
        const dl = Math.abs(L(a) - L(b));
        const pinned = LEGACY_TIGHT.get(pairKey(a, b));
        if (pinned !== undefined) {
          // legacy pair: below the bar already — assert only that it never worsens
          if (dh < pinned[0] - 0.05 || dl < pinned[1] - 0.05) {
            failures.push(
              `LEGACY REGRESSION ${cname(a)} / ${cname(b)}: dHue ${n(dh)} (pinned ${n(pinned[0])}), ` +
                `dL ${n(dl)} (pinned ${n(pinned[1])}) — this pair may never get closer`,
            );
          }
          continue;
        }
        if (dh < KART_HUE_MIN && dl < KART_L_MIN) {
          failures.push(
            `${cname(a)} / ${cname(b)}: dHue ${n(dh)} < ${KART_HUE_MIN} AND dL ${n(dl)} < ` +
              `${KART_L_MIN} — these two karts read the same on track and on the minimap`,
          );
        }
      }
    }
    expect(failures, `kart liveries too close:\n  ${failures.join('\n  ')}`).toEqual([]);
  });

  it('the tightest non-legacy pair clears the bar with design margin', () => {
    let worst = Infinity;
    let who = '';
    for (let i = 0; i < KART_COLORS.length; i++) {
      for (let j = i + 1; j < KART_COLORS.length; j++) {
        const a = KART_COLORS[i] as string;
        const b = KART_COLORS[j] as string;
        if (LEGACY_TIGHT.has(pairKey(a, b))) continue;
        const s = separation(a, b);
        if (s < worst) {
          worst = s;
          who = `${cname(a)} / ${cname(b)} (dHue ${n(hueDistance(a, b))}, dL ${n(Math.abs(L(a) - L(b)))})`;
        }
      }
    }
    expect(
      worst,
      `tightest non-legacy livery pair is ${who} at ${worst.toFixed(3)}x the bar — ` +
        `must clear it by ${DESIGN_MARGIN}x, so a later tweak cannot silently push it under`,
    ).toBeGreaterThanOrEqual(DESIGN_MARGIN);
  });
});
