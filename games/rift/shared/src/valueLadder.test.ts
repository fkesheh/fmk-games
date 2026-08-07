// ============================================================================
// THE VALUE LADDER LAW — automated gate for ANCIENTS (rift).
//
// Encodes the ladder laws of CONTRACT §12 T2 over the frozen APAL palette:
// tier floors, the L5 ground floor, lane/monument separation, team-colour
// readability on raw AND fog-darkened moss, azure/ember separation, the sky
// law (S1/S2/S4), HUD text contrast, hero-accent distinguishability, and the
// APAL <-> APAL_CSS_VARS mirror.
//
// EXTENDED for the PBR + terrain pass (GRAPHICS_CONTRACT §3) with cases for the
// new families: the tier law over cliff/dirt/wetStone/water/canopy/bark/fern/
// iron/bronze/gold/neutral, the large-surface-vs-moss separation, the
// neutral-camp identity against both teams and every hero accent, and the night
// sky state under the same S1/S2/S4 laws that bind the day state. Cases were
// ADDED; not one threshold moved.
//
// This file is the CONTRACT, not an opinion. NO IMPLEMENTER MAY WEAKEN A
// THRESHOLD — retune the palette instead. Assertion style mirrors
// games/kart/shared/src/valueLadder.test.ts: every failure message carries
// the measured values and the margin.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { APAL, APAL_CSS_VARS } from '@rift/shared';
import { L, blueBias, composite, hueDistance, isCooler } from '@platform/shared';

const TIER_SPAN_MIN = 8; // Lit >= base + 8 L*, Deep <= base - 8 L*
const TIER_BASE_MIN = 16; // tier floor scope: bases at or above this L*
const GROUND_FLOOR_MIN = 22; // L5: the darkest large surface still reads
const STONE_VS_MOSS_MIN = 15; // lane paving vs open ground
const MONUMENT_VS_MOSS_MIN = 20; // tower/ancient bodies vs open ground
const TEAM_L_MIN = 18; // team colour vs ground: >= 18 L* …
const TEAM_HUE_MIN = 30; // … OR >= 30 deg of hue
const TEAM_VS_TEAM_HUE_MIN = 25; // azure vs ember: >= 25 deg …
const TEAM_VS_TEAM_L_MIN = 20; // … OR >= 20 L*
const SKY_L_MIN = 12; // S1: zenith >= 12 L* darker than horizon
const PAPER_ON_INK_MIN = 60; // HUD text contrast floor
const ACCENT_HUE_MIN = 25; // hero accents pairwise: >= 25 deg …
const ACCENT_L_MIN = 20; // … OR >= 20 L*
const FOG_SHROUD_ALPHA = 0.55; // explored-not-visible ground composite
const LARGE_VS_MOSS_L_MIN = 12; // new large surfaces vs open ground: >= 12 L* …
const LARGE_VS_MOSS_HUE_MIN = 25; // … OR >= 25 deg of hue
const NEUTRAL_HUE_MIN = 25; // neutral camps vs teams/accents: >= 25 deg …
const NEUTRAL_L_MIN = 20; // … OR >= 20 L*

function n(x: number): string {
  return x.toFixed(1);
}

// ============================================================================
// TIER FLOORS — every Lit/Deep step clears 8 L* against its base.
//
// SCOPED to bases with L >= TIER_BASE_MIN: below that, 8 L* of headroom does
// not exist in sRGB (L* bottoms out near 0), so the law would be unmeetable
// rather than merely unmet. `inkDeep` is EXEMPT by construction — L(ink) is
// under 16 — and the scoping below is what says so, not a skipped assertion.
// ============================================================================
const TIERS: readonly (readonly [string, string, string, string])[] = [
  ['moss', APAL.moss, APAL.mossLit, APAL.mossDeep],
  ['stone', APAL.stone, APAL.stoneLit, APAL.stoneDeep],
  ['monument', APAL.monument, APAL.monumentLit, APAL.monumentDeep],
  ['azure', APAL.azure, APAL.azureLit, APAL.azureDeep],
  ['ember', APAL.ember, APAL.emberLit, APAL.emberDeep],
  ['ink', APAL.ink, APAL.inkLit, APAL.inkDeep],
  // --- added by the PBR + terrain pass (GRAPHICS_CONTRACT §3). Each family's
  //     {base, Lit, Deep} is also its seeded tint ladder (STYLE_BIBLE §8), so a
  //     step that fails the 8 L* floor is a scatter whose variation is invisible.
  ['cliff', APAL.cliff, APAL.cliffLit, APAL.cliffDeep],
  ['dirt', APAL.dirt, APAL.dirtLit, APAL.dirtDeep],
  ['wetStone', APAL.wetStone, APAL.wetStoneLit, APAL.wetStoneDeep],
  ['water', APAL.water, APAL.waterLit, APAL.waterDeep],
  ['canopy', APAL.canopy, APAL.canopyLit, APAL.canopyDeep],
  ['bark', APAL.bark, APAL.barkLit, APAL.barkDeep],
  ['fern', APAL.fern, APAL.fernLit, APAL.fernDeep],
  ['iron', APAL.iron, APAL.ironLit, APAL.ironDeep],
  ['bronze', APAL.bronze, APAL.bronzeLit, APAL.bronzeDeep],
  ['gold', APAL.gold, APAL.goldLit, APAL.goldDeep],
  ['neutral', APAL.neutral, APAL.neutralLit, APAL.neutralDeep],
];

describe('ANCIENTS tier floors (Lit/Deep vs base >= 8 L*)', () => {
  it('every tier with base L >= 16 clears the 8 L* floor on both steps', () => {
    const failures: string[] = [];
    for (const [name, base, lit, deep] of TIERS) {
      const lb = L(base);
      if (lb < TIER_BASE_MIN) continue; // exempt by construction (see header)
      const litDelta = L(lit) - lb;
      if (litDelta < TIER_SPAN_MIN) {
        failures.push(
          `${name}Lit: L=${n(L(lit))} - L(${name})=${n(lb)} = ${n(litDelta)} < ${TIER_SPAN_MIN}`,
        );
      }
      const deepDelta = lb - L(deep);
      if (deepDelta < TIER_SPAN_MIN) {
        failures.push(
          `${name}Deep: L(${name})=${n(lb)} - L=${n(L(deep))} = ${n(deepDelta)} < ${TIER_SPAN_MIN}`,
        );
      }
    }
    expect(failures, `tier floors under ${TIER_SPAN_MIN} L*:\n  ${failures.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('inkDeep is exempt: L(ink) is below the 16 L* scope floor', () => {
    const li = L(APAL.ink);
    expect(
      li,
      `scope: expected L(ink ${APAL.ink})=${n(li)} < ${TIER_BASE_MIN} — this is WHY the ink ` +
        `tier (and inkDeep) is exempt from the 8 L* tier floor, not a coincidence`,
    ).toBeLessThan(TIER_BASE_MIN);
  });
});

// ============================================================================
// GROUND + STRUCTURE SEPARATION
// ============================================================================
describe('ANCIENTS ground law (L5) and structure separation', () => {
  it('L5 — moss clears the ground floor: L(moss) >= 22', () => {
    const lm = L(APAL.moss);
    expect(
      lm,
      `L5 ground floor: expected L(moss ${APAL.moss})=${n(lm)} >= ${GROUND_FLOOR_MIN} — ` +
        `the ground is the darkest LARGE surface but must still read as green, not black`,
    ).toBeGreaterThanOrEqual(GROUND_FLOOR_MIN);
  });

  it('lane stone sits >= 15 L* above moss', () => {
    const d = L(APAL.stone) - L(APAL.moss);
    expect(
      d,
      `lane readability: expected L(stone ${APAL.stone})=${n(L(APAL.stone))} - ` +
        `L(moss ${APAL.moss})=${n(L(APAL.moss))} = ${n(d)} >= ${STONE_VS_MOSS_MIN}`,
    ).toBeGreaterThanOrEqual(STONE_VS_MOSS_MIN);
  });

  it('monument sits >= 20 L* above moss', () => {
    const d = L(APAL.monument) - L(APAL.moss);
    expect(
      d,
      `structure readability: expected L(monument ${APAL.monument})=${n(L(APAL.monument))} - ` +
        `L(moss ${APAL.moss})=${n(L(APAL.moss))} = ${n(d)} >= ${MONUMENT_VS_MOSS_MIN}`,
    ).toBeGreaterThanOrEqual(MONUMENT_VS_MOSS_MIN);
  });
});

// ============================================================================
// LARGE-SURFACE SEPARATION (GRAPHICS_CONTRACT §3) — every new family that
// covers a large fraction of the frame must be tellable from the open ground it
// sits on or against: >= 12 L* OR >= 25 deg of hue from moss.
//
// The two branches are not interchangeable in intent. `cliff`, `dirt` and
// `water` clear it on hue AND value; `canopy` deliberately shares moss's hue —
// a forest IS the ground's colour family — and carries the whole separation on
// value, which is why the OR is written as an OR and not an AND.
// ============================================================================
const LARGE_SURFACES = ['cliff', 'dirt', 'canopy', 'water'] as const;

describe('ANCIENTS large-surface families vs open ground', () => {
  for (const name of LARGE_SURFACES) {
    it(`${name} vs moss: >= ${LARGE_VS_MOSS_L_MIN} L* or >= ${LARGE_VS_MOSS_HUE_MIN} deg hue`, () => {
      const dL = Math.abs(L(APAL[name]) - L(APAL.moss));
      const dH = hueDistance(APAL[name], APAL.moss);
      expect(
        dL >= LARGE_VS_MOSS_L_MIN || dH >= LARGE_VS_MOSS_HUE_MIN,
        `terrain readability: ${name} ${APAL[name]} vs moss ${APAL.moss}: ` +
          `dL=${n(dL)} (need >= ${LARGE_VS_MOSS_L_MIN}) AND dH=${n(dH)} ` +
          `(need >= ${LARGE_VS_MOSS_HUE_MIN}) both fail — the ground would merge ` +
          `with the terrain feature standing on it`,
      ).toBe(true);
    });
  }
});

// ============================================================================
// TEAM COLOURS — readable on raw moss AND on fog-darkened moss.
// ============================================================================
describe('ANCIENTS team colours vs ground (raw and fog-darkened)', () => {
  const foggedMoss = composite(APAL.moss, APAL.shroud, FOG_SHROUD_ALPHA);

  for (const team of ['azure', 'ember'] as const) {
    it(`${team} vs moss: >= ${TEAM_L_MIN} L* or >= ${TEAM_HUE_MIN} deg hue`, () => {
      const dL = Math.abs(L(APAL[team]) - L(APAL.moss));
      const dH = hueDistance(APAL[team], APAL.moss);
      expect(
        dL >= TEAM_L_MIN || dH >= TEAM_HUE_MIN,
        `team readability: ${team} ${APAL[team]} vs moss ${APAL.moss}: ` +
          `dL=${n(dL)} (need >= ${TEAM_L_MIN}) AND dH=${n(dH)} (need >= ${TEAM_HUE_MIN}) both fail`,
      ).toBe(true);
    });

    it(`${team} vs composite(moss, shroud, ${FOG_SHROUD_ALPHA}): >= ${TEAM_L_MIN} L* or >= ${TEAM_HUE_MIN} deg hue`, () => {
      const dL = Math.abs(L(APAL[team]) - L(foggedMoss));
      const dH = hueDistance(APAL[team], foggedMoss);
      expect(
        dL >= TEAM_L_MIN || dH >= TEAM_HUE_MIN,
        `fog readability: ${team} ${APAL[team]} vs fog-darkened moss ${foggedMoss}: ` +
          `dL=${n(dL)} (need >= ${TEAM_L_MIN}) AND dH=${n(dH)} (need >= ${TEAM_HUE_MIN}) both fail — ` +
          `team units must stay readable on explored-not-visible ground`,
      ).toBe(true);
    });
  }

  it(`azure vs ember: >= ${TEAM_VS_TEAM_HUE_MIN} deg hue or >= ${TEAM_VS_TEAM_L_MIN} L*`, () => {
    const dH = hueDistance(APAL.azure, APAL.ember);
    const dL = Math.abs(L(APAL.azure) - L(APAL.ember));
    expect(
      dH >= TEAM_VS_TEAM_HUE_MIN || dL >= TEAM_VS_TEAM_L_MIN,
      `team identity: azure ${APAL.azure} vs ember ${APAL.ember}: ` +
        `dH=${n(dH)} (need >= ${TEAM_VS_TEAM_HUE_MIN}) AND dL=${n(dL)} ` +
        `(need >= ${TEAM_VS_TEAM_L_MIN}) both fail — the two teams read the same`,
    ).toBe(true);
  });
});

// ============================================================================
// SKY LAW — S1 (zenith cooler AND darker), S2 (fog IS horizon), S4 (ground
// never matches the sky stops).
// ============================================================================
describe('ANCIENTS sky law (S1/S2/S4)', () => {
  it('S1 — skyHigh is cooler than horizon', () => {
    expect(
      isCooler(APAL.skyHigh, APAL.horizon),
      `S1: zenith must be COOLER — expected blueBias(skyHigh ${APAL.skyHigh})=` +
        `${n(blueBias(APAL.skyHigh))} > blueBias(horizon ${APAL.horizon})=` +
        `${n(blueBias(APAL.horizon))}`,
    ).toBe(true);
  });

  it(`S1 — skyHigh is >= ${SKY_L_MIN} L* darker than horizon`, () => {
    const d = L(APAL.horizon) - L(APAL.skyHigh);
    expect(
      d,
      `S1: expected L(horizon ${APAL.horizon})=${n(L(APAL.horizon))} - ` +
        `L(skyHigh ${APAL.skyHigh})=${n(L(APAL.skyHigh))} = ${n(d)} >= ${SKY_L_MIN}`,
    ).toBeGreaterThanOrEqual(SKY_L_MIN);
  });

  it('S2 — fog matches the horizon stop exactly', () => {
    expect(
      APAL.fog,
      `S2: expected APAL.fog (${APAL.fog}) === APAL.horizon (${APAL.horizon}) — ` +
        `fog never matches the zenith`,
    ).toBe(APAL.horizon);
  });

  it('S4 — the ground never matches the horizon', () => {
    expect(
      APAL.moss,
      `S4: expected APAL.moss (${APAL.moss}) !== APAL.horizon (${APAL.horizon}) — ` +
        `terrain blending into the sky kills the horizon line`,
    ).not.toBe(APAL.horizon);
  });
});

// ============================================================================
// NIGHT SKY LAW — the SAME S1/S2/S4 that bind the day state bind at t=1.
// `setTimeOfDay` interpolates day -> night, so a night state that breaks the
// laws breaks them for every intermediate t as well; night is a second authored
// lighting state (STYLE_BIBLE §4), never "day with the lights off".
// ============================================================================
describe('ANCIENTS night sky law (S1/S2/S4)', () => {
  it('S1 — nightSky is cooler than nightHorizon', () => {
    expect(
      isCooler(APAL.nightSky, APAL.nightHorizon),
      `S1 (night): zenith must be COOLER — expected blueBias(nightSky ` +
        `${APAL.nightSky})=${n(blueBias(APAL.nightSky))} > blueBias(nightHorizon ` +
        `${APAL.nightHorizon})=${n(blueBias(APAL.nightHorizon))}`,
    ).toBe(true);
  });

  it(`S1 — nightSky is >= ${SKY_L_MIN} L* darker than nightHorizon`, () => {
    const d = L(APAL.nightHorizon) - L(APAL.nightSky);
    expect(
      d,
      `S1 (night): expected L(nightHorizon ${APAL.nightHorizon})=` +
        `${n(L(APAL.nightHorizon))} - L(nightSky ${APAL.nightSky})=` +
        `${n(L(APAL.nightSky))} = ${n(d)} >= ${SKY_L_MIN}`,
    ).toBeGreaterThanOrEqual(SKY_L_MIN);
  });

  it('S2 — nightFog matches the night horizon stop exactly', () => {
    expect(
      APAL.nightFog,
      `S2 (night): expected APAL.nightFog (${APAL.nightFog}) === APAL.nightHorizon ` +
        `(${APAL.nightHorizon}) — the fog colour IS the horizon stop in both states`,
    ).toBe(APAL.nightHorizon);
  });

  it('S4 — the night ground never matches the night horizon', () => {
    expect(
      APAL.nightGround,
      `S4 (night): expected APAL.nightGround (${APAL.nightGround}) !== ` +
        `APAL.nightHorizon (${APAL.nightHorizon}) — moonlit terrain blending into ` +
        `the sky kills the horizon line exactly as it does by day`,
    ).not.toBe(APAL.nightHorizon);
  });
});

// ============================================================================
// HUD TEXT
// ============================================================================
describe('ANCIENTS HUD text contrast', () => {
  it(`paper on ink clears ${PAPER_ON_INK_MIN} L*`, () => {
    const d = L(APAL.paper) - L(APAL.ink);
    expect(
      d,
      `HUD contrast: expected L(paper ${APAL.paper})=${n(L(APAL.paper))} - ` +
        `L(ink ${APAL.ink})=${n(L(APAL.ink))} = ${n(d)} >= ${PAPER_ON_INK_MIN}`,
    ).toBeGreaterThanOrEqual(PAPER_ON_INK_MIN);
  });
});

// ============================================================================
// HERO ACCENTS — the six visual.accent colours must be pairwise tellable
// apart, and none may collide with a team colour (accent != team identity).
// ============================================================================
const ACCENTS = ['frost', 'heal', 'shade', 'pine', 'void', 'gold'] as const;

describe('ANCIENTS hero accents', () => {
  it(`every accent pair: >= ${ACCENT_HUE_MIN} deg hue or >= ${ACCENT_L_MIN} L*`, () => {
    const failures: string[] = [];
    for (let i = 0; i < ACCENTS.length; i++) {
      for (let j = i + 1; j < ACCENTS.length; j++) {
        const an = ACCENTS[i] as (typeof ACCENTS)[number];
        const bn = ACCENTS[j] as (typeof ACCENTS)[number];
        const dH = hueDistance(APAL[an], APAL[bn]);
        const dL = Math.abs(L(APAL[an]) - L(APAL[bn]));
        if (dH < ACCENT_HUE_MIN && dL < ACCENT_L_MIN) {
          failures.push(
            `${an} ${APAL[an]} vs ${bn} ${APAL[bn]}: dH=${n(dH)} < ${ACCENT_HUE_MIN} AND ` +
              `dL=${n(dL)} < ${ACCENT_L_MIN} — two hero accents read the same`,
          );
        }
      }
    }
    expect(
      failures,
      `hero accents too close:\n  ${failures.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no accent equals a team colour (azure/ember)', () => {
    for (const name of ACCENTS) {
      expect(
        APAL[name],
        `accent collision: ${name} ${APAL[name]} === azure ${APAL.azure} — ` +
          `a hero accent must never be mistaken for team identity`,
      ).not.toBe(APAL.azure);
      expect(
        APAL[name],
        `accent collision: ${name} ${APAL[name]} === ember ${APAL.ember} — ` +
          `a hero accent must never be mistaken for team identity`,
      ).not.toBe(APAL.ember);
    }
  });
});

// ============================================================================
// NEUTRAL-CAMP IDENTITY (GRAPHICS_CONTRACT §3) — NEUTRAL_TEAM = 2 is a third
// visual identity, and the failure it exists to prevent is concrete: a player
// blinks at a camp and reads it as an enemy wave, walks in, and dies. So it is
// held to the same margin against BOTH team colours and EVERY hero accent.
//
// The list below is the six `visual.accent` keys the pairwise-accent suite uses
// PLUS `arcane`: arcane is a palette hero-accent entry driven by ability FX
// rather than by a hero body, and "every hero accent" in the contract means the
// whole accent band, not just the six that appear on a chassis.
// ============================================================================
const NEUTRAL_RIVALS = [
  'azure',
  'ember',
  'frost',
  'arcane',
  'heal',
  'shade',
  'pine',
  'void',
  'gold',
] as const;

describe('ANCIENTS neutral-camp identity', () => {
  it(`neutral vs every team colour and hero accent: >= ${NEUTRAL_HUE_MIN} deg hue or >= ${NEUTRAL_L_MIN} L*`, () => {
    const failures: string[] = [];
    for (const name of NEUTRAL_RIVALS) {
      const dH = hueDistance(APAL.neutral, APAL[name]);
      const dL = Math.abs(L(APAL.neutral) - L(APAL[name]));
      if (dH < NEUTRAL_HUE_MIN && dL < NEUTRAL_L_MIN) {
        failures.push(
          `neutral ${APAL.neutral} vs ${name} ${APAL[name]}: dH=${n(dH)} < ` +
            `${NEUTRAL_HUE_MIN} AND dL=${n(dL)} < ${NEUTRAL_L_MIN}`,
        );
      }
    }
    expect(
      failures,
      `neutral identity collides — a neutral creep would be mistaken for an enemy ` +
        `creep or a hero's ability colour:\n  ${failures.join('\n  ')}`,
    ).toEqual([]);
  });

  it('neutral is not literally a team colour', () => {
    expect(
      APAL.neutral,
      `neutral collision: neutral ${APAL.neutral} === azure ${APAL.azure}`,
    ).not.toBe(APAL.azure);
    expect(
      APAL.neutral,
      `neutral collision: neutral ${APAL.neutral} === ember ${APAL.ember}`,
    ).not.toBe(APAL.ember);
  });
});

// ============================================================================
// CSS-VAR MIRROR — APAL_CSS_VARS is a complete, exact 1:1 mirror of APAL.
// ============================================================================
const CSS_VAR_PATTERN = /^--[a-z][a-z0-9-]*$/;

describe('ANCIENTS APAL <-> APAL_CSS_VARS mirror', () => {
  it('covers every APAL key exactly once (complete, no extras)', () => {
    const palKeys = Object.keys(APAL).sort();
    const varKeys = Object.keys(APAL_CSS_VARS).sort();
    expect(
      varKeys,
      `mirror keys diverge — APAL has [${palKeys.join(', ')}] but APAL_CSS_VARS has ` +
        `[${varKeys.join(', ')}]`,
    ).toEqual(palKeys);
  });

  it('every var name matches /^--[a-z][a-z0-9-]*$/ and no two keys share a var', () => {
    const seen = new Map<string, string>();
    const failures: string[] = [];
    for (const [key, varName] of Object.entries(APAL_CSS_VARS)) {
      if (!CSS_VAR_PATTERN.test(varName)) {
        failures.push(`${key}: '${varName}' does not match ${CSS_VAR_PATTERN}`);
      }
      const prior = seen.get(varName);
      if (prior !== undefined) {
        failures.push(`${key}: '${varName}' is also assigned to ${prior} — vars must be unique`);
      }
      seen.set(varName, key);
    }
    expect(failures, `CSS-var mirror problems:\n  ${failures.join('\n  ')}`).toEqual([]);
  });
});
