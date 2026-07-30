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
  TRIM_MAT,
} from '@fps/shared';
import type { MapDef, MapId, MatId } from '@fps/shared';
import { L, hexToRgb, hueDistance, hueSplitOk, saturation } from '@platform/shared';

// ---- §3a per-map ladder assignments (VISUAL_UPGRADE.md §3a) ----------------
// The SINGLE material named as the L1 reference wall for each map. L1 is
// measured against this material only — never against "every material present".
const L1_REFERENCE_WALL: Record<MapId, MatId> = {
  dustbowl: 'sand',
  crossfire: 'concrete',
  office: 'plaster',
  frostbite: 'snow',
  urbana: 'plaster',
  bunker: 'concreteDark',
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
