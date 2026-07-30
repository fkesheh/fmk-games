// ============================================================================
// THE VALUE LADDER LAW — automated gate for BANK.
//
// BANK is a 2D surface, so the ladder shows up as felt/rail/gold/dice tiers and
// as text contrast rather than as walls and floors. Enforces VISUAL_UPGRADE.md
// §2 tier floors over BPAL, plus the BPAL -> CSS custom property mirror.
//
// This file is the CONTRACT, not an opinion. NO IMPLEMENTER MAY WEAKEN A
// THRESHOLD — retune the palette instead.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { BPAL, BPAL_CSS_VARS } from '@bank/shared';
import type { BankPaletteKey } from '@bank/shared';
import { L } from '@platform/shared';

const TIER_SPAN_MIN = 8; // §2 hard floor: base -> …Deep contact band
const TEXT_CONTRAST_MIN = 40; // readability floor for primary text on its ground
const PIP_CONTRAST_MIN = 60; // a die face must read at a glance

const CSS_VAR_RE = /^--[a-z][a-z0-9-]*$/;

function n(x: number): string {
  return x.toFixed(1);
}

function expectLighter(hiName: string, hiHex: string, loName: string, loHex: string): void {
  const a = L(hiHex);
  const b = L(loHex);
  expect(
    a,
    `tier order: expected L(${hiName})=${n(a)} > L(${loName})=${n(b)} ` +
      `(delta ${n(a - b)}, must be > 0)`,
  ).toBeGreaterThan(b);
}

function expectGap(
  hiName: string,
  hiHex: string,
  loName: string,
  loHex: string,
  min: number,
): void {
  const a = L(hiHex);
  const b = L(loHex);
  expect(
    a - b,
    `expected L(${hiName})=${n(a)} - L(${loName})=${n(b)} = ${n(a - b)} >= ${min}`,
  ).toBeGreaterThanOrEqual(min);
}

// ============================================================================
// CSS MIRROR — every palette entry has exactly one custom property, and the
// names are unique and legal. A duplicated var name silently shadows a colour.
// ============================================================================
describe('BPAL -> CSS custom property mirror', () => {
  const palKeys = Object.keys(BPAL).slice().sort();
  const varKeys = Object.keys(BPAL_CSS_VARS).slice().sort();

  it('BPAL_CSS_VARS has exactly one entry per BPAL key', () => {
    const missing = palKeys.filter((k) => !(k in BPAL_CSS_VARS));
    const extra = varKeys.filter((k) => !(k in BPAL));
    expect(
      missing,
      `BPAL_CSS_VARS is MISSING entries for BPAL keys: ${missing.join(', ')}`,
    ).toEqual([]);
    expect(
      extra,
      `BPAL_CSS_VARS has EXTRA entries with no BPAL key: ${extra.join(', ')}`,
    ).toEqual([]);
    expect(varKeys, 'BPAL_CSS_VARS key set must equal the BPAL key set').toEqual(palKeys);
  });

  it('every CSS var name is unique', () => {
    const seen = new Map<string, string>();
    for (const k of varKeys as BankPaletteKey[]) {
      const v = BPAL_CSS_VARS[k];
      const prev = seen.get(v);
      expect(
        prev,
        `CSS var "${v}" is used by both "${String(prev)}" and "${k}" — ` +
          `a duplicate name silently shadows a colour`,
      ).toBeUndefined();
      seen.set(v, k);
    }
    expect(seen.size, 'unique CSS var count must equal the BPAL key count').toBe(
      varKeys.length,
    );
  });

  it('every CSS var name matches /^--[a-z][a-z0-9-]*$/', () => {
    for (const k of varKeys as BankPaletteKey[]) {
      expect(
        BPAL_CSS_VARS[k],
        `BPAL_CSS_VARS.${k} = "${BPAL_CSS_VARS[k]}" is not a legal kebab-case custom property`,
      ).toMatch(CSS_VAR_RE);
    }
  });

  it('every BPAL value is a #rrggbb hex', () => {
    for (const k of palKeys as BankPaletteKey[]) {
      expect(BPAL[k], `BPAL.${k} = "${BPAL[k]}" is not a #rrggbb hex`).toMatch(
        /^#[0-9a-fA-F]{6}$/,
      );
    }
  });
});

// ============================================================================
// FELT / RAIL / GOLD TIERS (§2)
// ============================================================================
describe('BANK felt tiers (§2)', () => {
  it('feltLight > felt', () => {
    expectLighter('feltLight', BPAL.feltLight, 'felt', BPAL.felt);
  });
  it('felt > feltDark', () => {
    expectLighter('felt', BPAL.felt, 'feltDark', BPAL.feltDark);
  });
  it('feltDark > feltDeep', () => {
    expectLighter('feltDark', BPAL.feltDark, 'feltDeep', BPAL.feltDeep);
  });
  it('felt -> feltDeep clears the 8 L* contact-band floor', () => {
    expectGap('felt', BPAL.felt, 'feltDeep', BPAL.feltDeep, TIER_SPAN_MIN);
  });
});

describe('BANK rail tiers (§2)', () => {
  it('railLit > rail', () => {
    expectLighter('railLit', BPAL.railLit, 'rail', BPAL.rail);
  });
  it('rail > railDeep', () => {
    expectLighter('rail', BPAL.rail, 'railDeep', BPAL.railDeep);
  });
});

describe('BANK gold tiers (§2)', () => {
  it('goldBright > gold', () => {
    expectLighter('goldBright', BPAL.goldBright, 'gold', BPAL.gold);
  });
  it('gold > goldDeep', () => {
    expectLighter('gold', BPAL.gold, 'goldDeep', BPAL.goldDeep);
  });
});

// ============================================================================
// READABILITY — primary text must clear both grounds it sits on.
// ============================================================================
describe('BANK text contrast', () => {
  it('cream clears felt by >= 40 L*', () => {
    expectGap('cream', BPAL.cream, 'felt', BPAL.felt, TEXT_CONTRAST_MIN);
  });
  it('cream clears ink by >= 40 L*', () => {
    expectGap('cream', BPAL.cream, 'ink', BPAL.ink, TEXT_CONTRAST_MIN);
  });
});

// ============================================================================
// DICE — bevel/face/shade ladder plus pip legibility.
// ============================================================================
describe('BANK dice tiers', () => {
  it('diceBevel > diceFace', () => {
    expectLighter('diceBevel', BPAL.diceBevel, 'diceFace', BPAL.diceFace);
  });
  it('diceFace > diceFaceShade', () => {
    expectLighter('diceFace', BPAL.diceFace, 'diceFaceShade', BPAL.diceFaceShade);
  });
  it('diceFace clears dicePip by >= 60 L*', () => {
    expectGap('diceFace', BPAL.diceFace, 'dicePip', BPAL.dicePip, PIP_CONTRAST_MIN);
  });
});
