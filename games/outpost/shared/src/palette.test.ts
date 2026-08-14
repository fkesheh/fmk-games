// ============================================================================
// THE VALUE LADDER LAW — automated gate for OUTPOST's palette additions.
//
// Enforces the header of palette.ts: the four-tier value ladder for every
// OUTPOST-only family, and the horde's value-contrast guarantee. The inherited
// STRICKEN colours are already covered by games/fps/shared/src/valueLadder.test.ts
// — this file tests ONLY what OUTPOST_ADD introduces.
//
// THIS FILE IS THE CONTRACT, NOT AN OPINION. palette.ts is FROZEN — if a
// number here is unreachable, that is a contract gap to report, never a
// licence to weaken a threshold or edit the palette.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { OUTPOST_PALETTE_KEYS, PALETTE } from './palette.js';
import { PALETTE as FPS_PALETTE } from '@fps/shared';
import { L } from '@platform/shared';

const TIER_GAP_MIN = 8; // palette.ts header: Lit/Dark/Deep step >= 8 L* per tier

/** Palette lookup by a runtime-derived key, with a descriptive throw instead of `!`. */
function hexOf(key: string): string {
  const table = PALETTE as Record<string, string>;
  const hex = table[key];
  if (hex === undefined) {
    throw new Error(`palette.test.ts: expected PALETTE.${key} to exist but it does not`);
  }
  return hex;
}

// ============================================================================
// FAMILY DISCOVERY — programmatic, from OUTPOST_PALETTE_KEYS, so a later
// addition to OUTPOST_ADD is covered automatically without editing this file.
//
// A family is identified by its `<name>Dark` key (every 4-tier family has one).
// From that we derive:
//   - the "deep" tier:  `<name>Deep`            (optional — not every family has one)
//   - the "top" tier:   `<name>Lit` OR `<name>Pale` (rot uses Pale, not Lit)
//   - the "base" tier:  the key literally named `<name>`, OR — when no such key
//                        exists (rot's base is `rotFlesh`, not `rot`) — the sole
//                        remaining key that starts with `<name>` and isn't one
//                        of the tier keys already claimed.
// ============================================================================
interface Family {
  name: string;
  base: string;
  top: string;
  dark: string;
  deep: string | undefined;
}

function discoverFamilies(): Family[] {
  const keys = OUTPOST_PALETTE_KEYS as readonly string[];
  const keySet = new Set(keys);
  const families: Family[] = [];

  for (const darkKey of keys) {
    if (!darkKey.endsWith('Dark')) continue;
    const name = darkKey.slice(0, -'Dark'.length);
    if (name.length === 0) continue;

    const deepKey = `${name}Deep`;
    const litKey = `${name}Lit`;
    const paleKey = `${name}Pale`;
    const deep = keySet.has(deepKey) ? deepKey : undefined;
    const top = keySet.has(litKey) ? litKey : keySet.has(paleKey) ? paleKey : undefined;
    if (top === undefined) continue; // no documented top tier — not a ladder family

    let base: string | undefined;
    if (keySet.has(name)) {
      base = name;
    } else {
      const claimed = new Set([darkKey, top, deepKey]);
      const candidates = keys.filter((k) => k.startsWith(name) && !claimed.has(k));
      base = candidates.length === 1 ? candidates[0] : undefined;
    }
    if (base === undefined) continue;

    families.push({ name, base, top, dark: darkKey, deep });
  }

  return families;
}

const FAMILIES = discoverFamilies();

describe('family discovery finds the documented OUTPOST ladders', () => {
  it('discovers rot, pine, mud, sandbag, rust, stone and gravel', () => {
    const names = FAMILIES.map((f) => f.name).sort();
    // stone + gravel were added pre-freeze: the gauntlet found the model sheet
    // calling for `stone` on three of the five surfaces in the mandated
    // fence-line framing while no `stone` key existed in either ramp, and
    // `articulate()` silently drops the plinth when a contact tier is null.
    expect(names).toEqual(['gravel', 'mud', 'pine', 'rot', 'rust', 'sandbag', 'stone']);
  });

  it("rot's top tier is rotPale, not rotLit (the documented exception)", () => {
    const rot = FAMILIES.find((f) => f.name === 'rot');
    expect(rot).toBeDefined();
    expect(rot?.top).toBe('rotPale');
    expect(rot?.base).toBe('rotFlesh');
  });

  // skyNight (skyNight/skyNightHigh/fogNight/moonlight) has no `skyNightDark`
  // key, so it is NOT a 4-tier value-ladder family — it follows the S1
  // zenith/horizon convention (see valueLadder.test.ts) instead. Documenting
  // this here so the omission reads as deliberate, not a discovery-code bug.
  it('skyNight is not a 4-tier ladder family (no skyNightDark key)', () => {
    expect(FAMILIES.some((f) => f.name === 'skyNight')).toBe(false);
  });
});

// ============================================================================
// THE FOUR-TIER VALUE LADDER — palette.ts header law, per discovered family.
// ============================================================================
describe.each(FAMILIES.map((f): [string, Family] => [f.name, f]))(
  '%s — four-tier value ladder',
  (_name, family) => {
    it(`${family.top} (top) is >= ${TIER_GAP_MIN} L* above ${family.base} (base)`, () => {
      const top = L(hexOf(family.top));
      const base = L(hexOf(family.base));
      expect(
        top - base,
        `expected L(${family.top})=${top.toFixed(1)} - L(${family.base})=${base.toFixed(1)} ` +
          `= ${(top - base).toFixed(1)} >= ${TIER_GAP_MIN}`,
      ).toBeGreaterThanOrEqual(TIER_GAP_MIN);
    });

    it(`${family.dark} is >= ${TIER_GAP_MIN} L* below ${family.base} (base)`, () => {
      const base = L(hexOf(family.base));
      const dark = L(hexOf(family.dark));
      expect(
        base - dark,
        `expected L(${family.base})=${base.toFixed(1)} - L(${family.dark})=${dark.toFixed(1)} ` +
          `= ${(base - dark).toFixed(1)} >= ${TIER_GAP_MIN}`,
      ).toBeGreaterThanOrEqual(TIER_GAP_MIN);
    });

    if (family.deep !== undefined) {
      const deepKey = family.deep;
      it(`${deepKey} is >= ${TIER_GAP_MIN} L* below ${family.dark} (dark)`, () => {
        const dark = L(hexOf(family.dark));
        const deep = L(hexOf(deepKey));
        expect(
          dark - deep,
          `expected L(${family.dark})=${dark.toFixed(1)} - L(${deepKey})=${deep.toFixed(1)} ` +
            `= ${(dark - deep).toFixed(1)} >= ${TIER_GAP_MIN}`,
        ).toBeGreaterThanOrEqual(TIER_GAP_MIN);
      });
    }
  },
);

// ============================================================================
// THE HORDE'S VALUE CONTRAST — the load-bearing law.
//
// The style bible stakes the horde's readability on VALUE, not hue: a pale
// zombie must stay lighter than what it is seen against, at any distance and
// through any fog. The PREVIOUS OUTPOST build bet readability on hue instead
// and measured 0.00% saturated-green pixels with zombies on screen — fog
// desaturated the horde into the background long before it arrived. rotPale
// is deliberately high-value (L* ~84) so it survives that desaturation.
// ============================================================================
describe('the horde stays lighter than everything it is seen against', () => {
  it('rotPale itself clears the documented floor (L* >= 78)', () => {
    const rotPale = L(PALETTE.rotPale);
    expect(rotPale, `L(rotPale)=${rotPale.toFixed(1)} must be >= 78`).toBeGreaterThanOrEqual(78);
  });

  it('rotPale vs pineDeep — zombie against the treeline it emerges from (>= 45 L*)', () => {
    const d = L(PALETTE.rotPale) - L(PALETTE.pineDeep);
    expect(
      d,
      `L(rotPale)=${L(PALETTE.rotPale).toFixed(1)} - L(pineDeep)=${L(PALETTE.pineDeep).toFixed(1)} ` +
        `= ${d.toFixed(1)} must be >= 45`,
    ).toBeGreaterThanOrEqual(45);
  });

  it('rotPale vs mudDark — zombie against the ground it walks on (>= 40 L*)', () => {
    const d = L(PALETTE.rotPale) - L(PALETTE.mudDark);
    expect(
      d,
      `L(rotPale)=${L(PALETTE.rotPale).toFixed(1)} - L(mudDark)=${L(PALETTE.mudDark).toFixed(1)} ` +
        `= ${d.toFixed(1)} must be >= 40`,
    ).toBeGreaterThanOrEqual(40);
  });

  it('rotPale vs fogNight — zombie against the night fog it is lerped toward (>= 30 L*)', () => {
    const d = L(PALETTE.rotPale) - L(PALETTE.fogNight);
    expect(
      d,
      `L(rotPale)=${L(PALETTE.rotPale).toFixed(1)} - L(fogNight)=${L(PALETTE.fogNight).toFixed(1)} ` +
        `= ${d.toFixed(1)} must be >= 30`,
    ).toBeGreaterThanOrEqual(30);
  });

  // -------------------------------------------------------------------------
  // DUSK. Waves 1-3 are the dusk mood — the FIRST thing any player ever sees —
  // and the original suite only ever checked night, so it was blind to the fact
  // that the horde's whole readability mechanism collapsed there. Measured
  // against STRICKEN's warm desert dusk, rotPale sat 11.8 L* from fogDusk:
  // below even this palette's own 8 L* per-tier step. That is the previous
  // build's hue-space failure reincarnated in value space. OUTPOST therefore
  // has its OWN cool dusk keys, and they are gated here.
  // -------------------------------------------------------------------------

  it('rotPale vs duskFog — the horde at dusk, waves 1-3 (>= 30 L*)', () => {
    const d = L(PALETTE.rotPale) - L(PALETTE.duskFog);
    expect(
      d,
      `L(rotPale)=${L(PALETTE.rotPale).toFixed(1)} - L(duskFog)=${L(PALETTE.duskFog).toFixed(1)} ` +
        `= ${d.toFixed(1)} must be >= 30`,
    ).toBeGreaterThanOrEqual(30);
  });

  it('rotPale vs duskSky — the horde against the dusk sky (>= 30 L*)', () => {
    const d = L(PALETTE.rotPale) - L(PALETTE.duskSky);
    expect(d, `rotPale - duskSky = ${d.toFixed(1)} must be >= 30`).toBeGreaterThanOrEqual(30);
  });

  it('rotPale vs duskHorizon — the one warm band is still dark enough (>= 25 L*)', () => {
    const d = L(PALETTE.rotPale) - L(PALETTE.duskHorizon);
    expect(d, `rotPale - duskHorizon = ${d.toFixed(1)} must be >= 25`).toBeGreaterThanOrEqual(25);
  });

  it('the night sky dome is not below the VISUAL_GATES shadow threshold by construction', () => {
    // Rec.601 luma, the same measure the capture harness uses on the PNG.
    const luma = (hex: string): number => {
      const n = Number.parseInt(hex.slice(1), 16);
      return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    };
    for (const key of ['skyNight', 'skyNightHigh', 'fogNight', 'duskSky', 'duskSkyHigh', 'duskFog'] as const) {
      expect(luma(PALETTE[key]), `${key} luma ${luma(PALETTE[key]).toFixed(1)} must exceed 20`).toBeGreaterThan(20);
    }
  });
});

// ============================================================================
// WELL-FORMEDNESS — every OUTPOST addition is a lowercase 6-digit hex.
// ============================================================================
describe('OUTPOST additions are well-formed lowercase 6-digit hex', () => {
  it.each(OUTPOST_PALETTE_KEYS)('%s', (key) => {
    const hex = PALETTE[key];
    expect(hex, `PALETTE.${key} = ${hex} is not a lowercase #rrggbb hex`).toMatch(
      /^#[0-9a-f]{6}$/,
    );
  });
});

// ============================================================================
// NO DUPLICATE SWATCHES — "One swatch, one job" (style bible). Two OUTPOST
// keys sharing a hex means one swatch is silently doing two jobs.
// ============================================================================
describe('no duplicate hex values among the OUTPOST additions', () => {
  it('every OUTPOST key maps to a unique hex', () => {
    const byHex = new Map<string, string[]>();
    for (const key of OUTPOST_PALETTE_KEYS) {
      const hex = PALETTE[key];
      const existing = byHex.get(hex);
      if (existing) {
        existing.push(key);
      } else {
        byHex.set(hex, [key]);
      }
    }
    const duplicates = [...byHex.entries()].filter(([, ks]) => ks.length > 1);
    expect(
      duplicates,
      `duplicate OUTPOST swatches (same hex, two jobs): ${duplicates
        .map(([hex, ks]) => `${hex} <- ${ks.join(', ')}`)
        .join('; ')}`,
    ).toEqual([]);
  });
});

// ============================================================================
// NO COLLISION WITH INHERITED STRICKEN KEYS — adding the OUTPOST family must
// not have silently overwritten an inherited STRICKEN colour.
// ============================================================================
describe('OUTPOST additions do not collide with inherited STRICKEN keys', () => {
  const fpsKeySet = new Set(Object.keys(FPS_PALETTE));

  it.each(OUTPOST_PALETTE_KEYS)('%s is not an inherited STRICKEN key', (key) => {
    expect(
      fpsKeySet.has(key),
      `PALETTE.${key} is an OUTPOST addition that shares its name with an ` +
        `inherited STRICKEN key — it would have silently overwritten @fps/shared's colour`,
    ).toBe(false);
  });

  it('PALETTE resolves every OUTPOST key to the OUTPOST_ADD value, not a shadowed STRICKEN one', () => {
    for (const key of OUTPOST_PALETTE_KEYS) {
      if (fpsKeySet.has(key)) {
        // Already asserted unreachable above; this is a defence-in-depth check
        // in case a future STRICKEN key is added with the same name.
        expect(PALETTE[key]).not.toBe((FPS_PALETTE as Record<string, string>)[key]);
      }
    }
  });
});
