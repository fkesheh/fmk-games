// ============================================================================
// THE VALUE LADDER LAW — automated gate for STRICKEN (FPS).
//
// Enforces VISUAL_UPGRADE.md §1 (L1, L2a, L3, L4, S1, S2) plus §2 tier floors
// and §3a per-map ladder assignments, numerically, over every palette tier and
// every `MapDef.theme`.
//
// This file is the CONTRACT, not an opinion. If a number here is unreachable
// that is a contract gap — report it. NO IMPLEMENTER MAY WEAKEN A THRESHOLD.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  CONTACT_MAT,
  DARK_MAT,
  IMPACT_MAT,
  MAPS,
  MAP_LIST,
  MAT_COLORS,
  PALETTE,
  TRIM_MAT,
} from '@fps/shared';
import type { MapDef, MapId, MatId } from '@fps/shared';
import { L, hexToRgb, hue, hueDistance, hueSplitOk, saturation } from '@platform/shared';

// ---- §3a per-map ladder assignments (VISUAL_UPGRADE.md §3a) ----------------
// The SINGLE material named as the L1 reference wall for each map. L1 is
// measured against this material only — never against "every material present".
const L1_REFERENCE_WALL: Record<MapId, MatId> = {
  dustbowl: 'sand',
  crossfire: 'concrete',
  office: 'plaster',
  frostbite: 'snow',
  urbana: 'plaster',
  // Bunker's reference wall was 'concreteDark' (L*46.2) while its floor was
  // 'metalDeep' (L*14.5). Adding the L5 readability floor made that pairing
  // UNSATISFIABLE: L5 wants ground >= 22, monochrome L1 wants ground <= 18.2,
  // and no MatId lies in an empty interval. The map lifts to 'concrete'/'metalDark'
  // (58.4 - 27.7 = 30.7 >= 28), which clears both.
  bunker: 'concrete',
};

// §1 L4 monochrome exemption: declared monochrome-by-design in §3a. Exempt from
// the hue split ONLY while they clear the harder L1 >= 28. No other map may claim it.
const MONOCHROME = new Set<MapId>(['frostbite', 'bunker']);

// ---- thresholds (VISUAL_UPGRADE.md §1/§2 — do not edit) --------------------
const L1_MIN = 20; // ground separation
const L1_MIN_MONOCHROME = 28; // harder floor bought in exchange for the L4 exemption
const L2A_MIN = 8; // wall plinth drop
const L3_MIN = 8; // trim lift
const S1_MIN = 12; // sky zenith / horizon separation
const L6_DL_MIN = 18; // team colour vs background: value escape
const L6_DHUE_MIN = 30; // team colour vs background: hue escape
const TEAM_TIER_MIN = 8; // …Lit above / …Dark below the team base

// ---- helpers ---------------------------------------------------------------

const MAT_IDS = (Object.keys(MAT_COLORS) as MatId[]).slice().sort();

function n(x: number): string {
  return x.toFixed(1);
}

/** L* of a MatId's resolved palette hex. */
function lm(m: MatId): number {
  return L(MAT_COLORS[m]);
}

/**
 * "Cooler", the machine-checkable way: blue-minus-red channel difference.
 * A cooler colour carries more blue relative to red than the colour it is
 * compared against.
 */
function blueBias(hex: string): number {
  const { r, b } = hexToRgb(hex);
  return b - r;
}

const CONTACT_PAIRS = MAT_IDS.filter((m) => CONTACT_MAT[m] !== null).map(
  (m) => [m, CONTACT_MAT[m] as MatId] as const,
);
const TRIM_PAIRS = MAT_IDS.filter((m) => TRIM_MAT[m] !== null).map(
  (m) => [m, TRIM_MAT[m] as MatId] as const,
);

// ============================================================================
// TABLE TOTALITY — every ladder-partner table has exactly one row per MatId.
// A missing row means `articulate()` silently emits nothing; an extra row means
// a MatId was deleted and its partners rotted.
// ============================================================================
describe('table totality: one row per MatId, no extras', () => {
  const TABLES: [string, Record<string, unknown>][] = [
    ['CONTACT_MAT', CONTACT_MAT as unknown as Record<string, unknown>],
    ['TRIM_MAT', TRIM_MAT as unknown as Record<string, unknown>],
    ['DARK_MAT', DARK_MAT as unknown as Record<string, unknown>],
    ['IMPACT_MAT', IMPACT_MAT as unknown as Record<string, unknown>],
  ];

  it('MAT_COLORS keys are unique and every value is a #rrggbb hex', () => {
    const raw = Object.keys(MAT_COLORS);
    expect(new Set(raw).size, `MAT_COLORS has duplicate keys: ${raw.join(', ')}`).toBe(
      raw.length,
    );
    for (const m of MAT_IDS) {
      expect(
        MAT_COLORS[m],
        `MAT_COLORS.${m} = ${String(MAT_COLORS[m])} is not a #rrggbb hex`,
      ).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it.each(TABLES)('%s has exactly one entry per MatId', (name, table) => {
    const keys = Object.keys(table).slice().sort();
    const missing = MAT_IDS.filter((m) => !(m in table));
    const extra = keys.filter((k) => !MAT_IDS.includes(k as MatId));
    expect(missing, `${name} is MISSING rows for MatIds: ${missing.join(', ')}`).toEqual([]);
    expect(
      extra,
      `${name} has EXTRA rows not present in MAT_COLORS: ${extra.join(', ')}`,
    ).toEqual([]);
    expect(keys, `${name} key set must equal the MAT_COLORS key set`).toEqual(MAT_IDS);
  });

  it.each([
    ['CONTACT_MAT', CONTACT_MAT as Record<MatId, MatId | null>],
    ['TRIM_MAT', TRIM_MAT as Record<MatId, MatId | null>],
    ['DARK_MAT', DARK_MAT as unknown as Record<MatId, MatId | null>],
  ])('%s values are themselves valid MatIds (or null)', (name, table) => {
    for (const m of MAT_IDS) {
      const v = table[m];
      if (v === null) continue;
      expect(
        MAT_IDS.includes(v),
        `${name}.${m} = "${String(v)}" is not a MatId present in MAT_COLORS`,
      ).toBe(true);
    }
  });

  it('DARK_MAT is never null (it falls back to the material itself)', () => {
    for (const m of MAT_IDS) {
      expect(DARK_MAT[m], `DARK_MAT.${m} must not be null/undefined`).toBeTruthy();
    }
  });
});

// ============================================================================
// L2a — WALL PLINTH. The contact band is >= 8 L* BELOW its own wall material.
// ============================================================================
describe('L2a — wall plinth is >= 8 L* below its own material', () => {
  it.each(CONTACT_PAIRS)('%s -> CONTACT_MAT %s', (m, p) => {
    const a = lm(m);
    const b = lm(p);
    expect(
      a - b,
      `L2a ${m}: expected L(${m})=${n(a)} - L(${p})=${n(b)} = ${n(a - b)} >= ${L2A_MIN}`,
    ).toBeGreaterThanOrEqual(L2A_MIN);
  });
});

// ============================================================================
// L3 — TRIM LIFT. Trim sits >= 8 L* ABOVE the material it trims.
// ============================================================================
describe('L3 — trim is >= 8 L* above the material it trims', () => {
  it.each(TRIM_PAIRS)('%s -> TRIM_MAT %s', (m, t) => {
    const a = lm(t);
    const b = lm(m);
    expect(
      a - b,
      `L3 ${m}: expected L(${t})=${n(a)} - L(${m})=${n(b)} = ${n(a - b)} >= ${L3_MIN}`,
    ).toBeGreaterThanOrEqual(L3_MIN);
  });
});

// ============================================================================
// §3b — DARK_MAT (the alternating pilaster tier) is a step DOWN, never up.
// Equality is allowed ONLY at the bottom of a ladder, where the table
// self-maps deliberately.
// ============================================================================
describe('DARK_MAT is strictly darker (equal only when it self-maps)', () => {
  it.each(MAT_IDS)('%s', (m) => {
    const d = DARK_MAT[m];
    const a = lm(d);
    const b = lm(m);
    if (d === m) {
      expect(
        a,
        `DARK_MAT.${m} self-maps (bottom of its ladder) — L must be identical`,
      ).toBe(b);
      return;
    }
    expect(
      a,
      `DARK_MAT ${m}: expected L(${d})=${n(a)} < L(${m})=${n(b)} (pilaster tier must step DOWN)`,
    ).toBeLessThan(b);
  });
});

// ============================================================================
// PER-MAP — L1, L4, S1, S2 and the ground/horizon defect, over every MapDef.
// ============================================================================
describe('per-map ladder + sky law', () => {
  it('MAP_LIST covers every registered map exactly once', () => {
    const ids = MAP_LIST.map((m) => m.id).slice().sort();
    const registered = Object.keys(MAPS).slice().sort();
    expect(ids, 'MAP_LIST must contain exactly the maps registered in MAPS').toEqual(
      registered,
    );
    expect(
      Object.keys(L1_REFERENCE_WALL).slice().sort(),
      'L1_REFERENCE_WALL (§3a) must name one reference wall per map',
    ).toEqual(registered);
  });

  const cases: [string, MapDef][] = MAP_LIST.map((m) => [m.id, m]);

  describe.each(cases)('%s', (_id, map) => {
    const wall = L1_REFERENCE_WALL[map.id];
    const groundHex = MAT_COLORS[map.floorMat];
    const wallHex = MAT_COLORS[wall];
    const mono = MONOCHROME.has(map.id);

    it('L1 — reference wall clears the floor', () => {
      const min = mono ? L1_MIN_MONOCHROME : L1_MIN;
      const a = L(wallHex);
      const b = L(groundHex);
      expect(
        a - b,
        `L1 ${map.id}${mono ? ' (monochrome: harder floor)' : ''}: expected ` +
          `L(${wall})=${n(a)} - L(${map.floorMat})=${n(b)} = ${n(a - b)} >= ${min}`,
      ).toBeGreaterThanOrEqual(min);
    });

    // L5 — brightness floor. The ladder sets a floor on CONTRAST but originally
    // none on DARKNESS, and the first fan-out crushed half of Crossfire to
    // near-black. In a competitive shooter that is a gameplay regression:
    // you cannot shoot what you cannot see. Readability wins every tie.
    it('L5 — ground is not crushed to black (readability floor)', () => {
      const b = L(groundHex);
      expect(
        b,
        `L5 ${map.id}: ground ${map.floorMat} is L=${n(b)}, below the readability floor of 22`,
      ).toBeGreaterThanOrEqual(22);
    });

    it('L5 — main wall is not crushed to black (readability floor)', () => {
      const a = L(wallHex);
      expect(
        a,
        `L5 ${map.id}: main wall ${wall} is L=${n(a)}, below the readability floor of 30`,
      ).toBeGreaterThanOrEqual(30);
    });

    if (mono) {
      it('L4 — exempt (monochrome by design), so L1 >= 28 does the work', () => {
        const a = L(wallHex);
        const b = L(groundHex);
        expect(
          a - b,
          `L4-exempt ${map.id}: a monochrome map buys its exemption with L1 — expected ` +
            `L(${wall})=${n(a)} - L(${map.floorMat})=${n(b)} = ${n(a - b)} >= ${L1_MIN_MONOCHROME}`,
        ).toBeGreaterThanOrEqual(L1_MIN_MONOCHROME);
      });
    } else {
      it('L4 — hue split between ground and reference wall', () => {
        const hd = hueDistance(groundHex, wallHex);
        const sg = saturation(groundHex);
        const sw = saturation(wallHex);
        expect(
          hueSplitOk(groundHex, wallHex),
          `L4 ${map.id}: expected hueDistance(${map.floorMat}, ${wall})=${n(hd)} >= 25 ` +
            `OR saturation(${wall})=${n(sw)} - saturation(${map.floorMat})=${n(sg)} = ` +
            `${n(sw - sg)} >= 15`,
        ).toBe(true);
      });
    }

    it('S1 — sky zenith is >= 12 L* darker than the horizon, and cooler', () => {
      const { skyHigh, horizon } = map.theme as { skyHigh?: string; horizon?: string };
      expect(
        typeof skyHigh,
        `S1 ${map.id}: theme.skyHigh is missing — MapTheme requires a zenith stop`,
      ).toBe('string');
      expect(
        typeof horizon,
        `S1 ${map.id}: theme.horizon is missing`,
      ).toBe('string');
      const hi = L(skyHigh as string);
      const ho = L(horizon as string);
      expect(
        ho - hi,
        `S1 ${map.id}: expected L(horizon ${horizon})=${n(ho)} - ` +
          `L(skyHigh ${skyHigh})=${n(hi)} = ${n(ho - hi)} >= ${S1_MIN}`,
      ).toBeGreaterThanOrEqual(S1_MIN);
      const bhi = blueBias(skyHigh as string);
      const bho = blueBias(horizon as string);
      expect(
        bhi,
        `S1 ${map.id}: zenith must be COOLER — expected blueBias(skyHigh ${skyHigh})=${bhi} ` +
          `> blueBias(horizon ${horizon})=${bho}`,
      ).toBeGreaterThan(bho);
    });

    it('S2 — fog matches the horizon stop exactly', () => {
      expect(
        map.theme.fog,
        `S2 ${map.id}: expected theme.fog (${map.theme.fog}) === theme.horizon ` +
          `(${map.theme.horizon}) — fog never matches the zenith`,
      ).toBe(map.theme.horizon);
    });

    it('ground tint is not the same hex as the horizon', () => {
      expect(
        map.theme.ground,
        `${map.id}: theme.ground (${map.theme.ground}) must not equal theme.horizon ` +
          `(${map.theme.horizon}) — the Crossfire/Frostbite same-hex defect flattens the frame`,
      ).not.toBe(map.theme.horizon);
    });
  });
});

// ============================================================================
// L6 — TEAM READABILITY. The one law that is about FAIRNESS rather than looks:
// you cannot shoot what you cannot see, and a round is one life.
//
// Every team colour must clear BOTH the ground and the L1 reference wall of
// EVERY map by >= 18 L* OR >= 30 degrees of hue. Before this gate existed,
// 6 of the 12 map/team BASE pairs failed: `ctBlue` #3d5a9b sat 4.3 L* and 8 deg
// from `tarmac` (Crossfire + Urbana floors) and 10.1 L* / 6 deg from `carpet`
// (Office floor); `tAmber` #c8912f sat 15.4 L* / 7 deg from `sand`, 19.5 L* /
// 1 deg from `plaster` and 5.6 L* / 22 deg from `concrete`. A CT was
// camouflaged against three floors and a T against three walls.
//
// The gate runs over ALL FOUR tiers of each team, not just the base, because
// `playerModels.ts` paints the soldier in all four (PALE helmet, LIT shoulders,
// BASE body, DARK limbs) — a readable base with an invisible helmet is still an
// invisible enemy at range. The four-tone script is what made `ice`/`muzzle`/
// `fire`/`tBrown` sneak onto the model in the first place; this gate is why
// they cannot come back.
//
// NO IMPLEMENTER MAY WEAKEN A THRESHOLD. If a team colour cannot satisfy this,
// the team colour moves — never the number.
// ============================================================================
describe('L6 — team colours clear every map ground and reference wall', () => {
  const TEAM_TIERS: [team: string, tier: string, hex: string][] = [
    ['CT', 'ctPale', PALETTE.ctPale],
    ['CT', 'ctLit', PALETTE.ctLit],
    ['CT', 'ctBlue (BASE)', PALETTE.ctBlue],
    ['CT', 'ctDark', PALETTE.ctDark],
    ['T', 'tPale', PALETTE.tPale],
    ['T', 'tLit', PALETTE.tLit],
    ['T', 'tAmber (BASE)', PALETTE.tAmber],
    ['T', 'tDark', PALETTE.tDark],
  ];

  // one row per (tier, map, ground|wall) — 8 tiers x 6 maps x 2 = 96 checks
  const ROWS: [label: string, teamHex: string, surface: string, bgHex: string][] = [];
  for (const [team, tier, hex] of TEAM_TIERS) {
    for (const map of MAP_LIST) {
      const wall = L1_REFERENCE_WALL[map.id];
      ROWS.push([`${team} ${tier} vs ${map.id} ground`, hex, map.floorMat, MAT_COLORS[map.floorMat]]);
      ROWS.push([`${team} ${tier} vs ${map.id} wall`, hex, wall, MAT_COLORS[wall]]);
    }
  }

  it.each(ROWS)('%s', (label, teamHex, surface, bgHex) => {
    const dL = Math.abs(L(teamHex) - L(bgHex));
    const dHue = hueDistance(teamHex, bgHex);
    expect(
      dL >= L6_DL_MIN || dHue >= L6_DHUE_MIN,
      `L6 ${label}: team ${teamHex} (L=${n(L(teamHex))}, hue=${n(hue(teamHex))}) against ` +
        `${surface} ${bgHex} (L=${n(L(bgHex))}, hue=${n(hue(bgHex))}) clears by only ` +
        `dL=${n(dL)} (needs ${L6_DL_MIN}) and dHue=${n(dHue)} (needs ${L6_DHUE_MIN}). ` +
        `An enemy in this tier is camouflaged on this surface.`,
    ).toBe(true);
  });

  // The escape hatch this law must never grow: "solve" a failing pair by
  // desaturating the team into the world. A team colour is a SIGNAL — it has to
  // out-chroma every surface it is seen against.
  it.each(TEAM_TIERS)('%s %s is more saturated than every map ground and wall', (_t, tier, hex) => {
    for (const map of MAP_LIST) {
      for (const m of [map.floorMat, L1_REFERENCE_WALL[map.id]]) {
        expect(
          saturation(hex) - saturation(MAT_COLORS[m]),
          `L6-chroma ${tier} (${hex}, sat=${n(saturation(hex))}) must out-saturate ` +
            `${map.id}'s ${m} (${MAT_COLORS[m]}, sat=${n(saturation(MAT_COLORS[m]))})`,
        ).toBeGreaterThan(0);
      }
    }
  });

  // §2 tier floors, applied to the character instead of a wall.
  it.each([
    ['ctLit', PALETTE.ctLit, 'ctBlue', PALETTE.ctBlue],
    ['ctPale', PALETTE.ctPale, 'ctLit', PALETTE.ctLit],
    ['tLit', PALETTE.tLit, 'tAmber', PALETTE.tAmber],
    ['tPale', PALETTE.tPale, 'tLit', PALETTE.tLit],
  ])('%s is >= 8 L* above %s', (hi, hiHex, lo, loHex) => {
    expect(
      L(hiHex) - L(loHex),
      `team tier: expected L(${hi})=${n(L(hiHex))} - L(${lo})=${n(L(loHex))} = ` +
        `${n(L(hiHex) - L(loHex))} >= ${TEAM_TIER_MIN}`,
    ).toBeGreaterThanOrEqual(TEAM_TIER_MIN);
  });

  it.each([
    ['ctDark', PALETTE.ctDark, 'ctBlue', PALETTE.ctBlue],
    ['tDark', PALETTE.tDark, 'tAmber', PALETTE.tAmber],
  ])('%s is >= 8 L* below %s (the limb value break)', (lo, loHex, hi, hiHex) => {
    expect(
      L(hiHex) - L(loHex),
      `team tier: expected L(${hi})=${n(L(hiHex))} - L(${lo})=${n(L(loHex))} = ` +
        `${n(L(hiHex) - L(loHex))} >= ${TEAM_TIER_MIN}`,
    ).toBeGreaterThanOrEqual(TEAM_TIER_MIN);
  });

  // The other half of the fairness bargain: fixing "enemy vs world" must never
  // cost "enemy vs ally". These floors are the separation the ORIGINAL
  // #3d5a9b / #c8912f pair carried (dL* 24.9), frozen so no future retune trades
  // one read for the other.
  it('the two teams stay at least as separated from each other as they ever were', () => {
    const dL = Math.abs(L(PALETTE.ctBlue) - L(PALETTE.tAmber));
    const dHue = hueDistance(PALETTE.ctBlue, PALETTE.tAmber);
    expect(
      dL,
      `team split: expected |L(ctBlue)=${n(L(PALETTE.ctBlue))} - ` +
        `L(tAmber)=${n(L(PALETTE.tAmber))}| = ${n(dL)} >= 22`,
    ).toBeGreaterThanOrEqual(22);
    expect(
      dHue,
      `team split: expected hueDistance(ctBlue, tAmber) = ${n(dHue)} >= 100 — the two ` +
        `sides must never converge on one hue family`,
    ).toBeGreaterThanOrEqual(100);
  });

  // A hazard stripe painted in the live enemy colour is a false-positive enemy
  // read on every corner you clear. Crossfire, Frostbite and Bunker all wear
  // safety amber, and it used to BE `tAmber`.
  it('no world dressing colour collides with a team colour', () => {
    const WORLD: [string, string][] = [
      ['hazardAmber', PALETTE.hazardAmber],
      ['hazardAmberLit', PALETTE.hazardAmberLit],
      ['tBrown (sacks/barrels)', PALETTE.tBrown],
      ['fire', PALETTE.fire],
      ['muzzle', PALETTE.muzzle],
      ['ice', PALETTE.ice],
    ];
    for (const [wn, wh] of WORLD) {
      for (const [, tier, th] of TEAM_TIERS) {
        const dL = Math.abs(L(wh) - L(th));
        const dHue = hueDistance(wh, th);
        expect(
          dL >= 12 || dHue >= 20,
          `world/team collision: ${wn} (${wh}) is only dL=${n(dL)} / dHue=${n(dHue)} ` +
            `from the team tier ${tier} (${th}) — world dressing must not read as an enemy`,
        ).toBe(true);
      }
    }
  });
});

// ============================================================================
// §3a — Urbana's SECONDARY facade mass. `brick` is not the L1 reference, but it
// must still clear the street by the full L1 margin or the inversion returns.
// ============================================================================
describe('§3a — Urbana secondary facade', () => {
  it('brick clears tarmac by >= 20 L*', () => {
    const a = lm('brick');
    const b = lm('tarmac');
    expect(
      a - b,
      `Urbana secondary facade: expected L(brick)=${n(a)} - L(tarmac)=${n(b)} = ` +
        `${n(a - b)} >= ${L1_MIN}`,
    ).toBeGreaterThanOrEqual(L1_MIN);
  });
});
