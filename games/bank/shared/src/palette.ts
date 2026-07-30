// ============================================================================
// FROZEN CONTRACT — BANK: the named palette. NEW in the visual upgrade round.
//
// BANK previously had no palette source of truth: colours lived as CSS custom
// properties in style.css with hardcoded hex leaking into dice.ts and game.ts.
// This file is now the ONE source. `style.css` mirrors these values into CSS
// custom properties (same names, `--kebab-case`); dice.ts and game.ts consume
// the CSS variables, never raw hex.
//
// Mood (VISUAL_UPGRADE.md §5): a real casino table you would sit down at —
// warm felt, weighty gold, chips with heft. The `…Deep` tiers are contact
// shadows and stitched edges; they are what give the table physical weight.
// ============================================================================

export const BPAL = {
  // ---- room ----
  ink: '#0e130f', //             page background
  inkLit: '#161d18', //          raised panel over the page
  inkDeep: '#070a08', //         drop shadow / vignette floor

  // ---- felt ----
  feltLight: '#2a7a55', //       centre of the table (lit)
  felt: '#1d5c3f', //            main felt
  feltDark: '#123c2a', //        felt falloff toward the rail
  feltDeep: '#0b2618', //        stitched edge / inner contact shadow

  // ---- rail (the wood/leather surround the table currently lacks) ----
  railLit: '#6b4a2c', //         top bevel catching light
  rail: '#4a3220', //            rail body
  railDeep: '#2a1c11', //        rail underside / contact shadow

  // ---- gold ----
  goldBright: '#f0d488', //      highlight / win state
  gold: '#d8b45a', //            accents, pot value
  goldDeep: '#9c7c2e', //        engraved / inactive gold

  // ---- type ----
  cream: '#f3ead2', //           primary text
  creamDim: '#b8ab8a', //        secondary text
  creamFaint: '#7d7460', //      tertiary / timestamps

  // ---- dice ----
  diceFace: '#f6f1e2', //        warm cream face (was flat white)
  diceFaceShade: '#d9d2be', //   side faces catching less light
  diceBevel: '#fbf8ee', //       bevel highlight
  dicePip: '#1a1a18', //         pip
  dicePipDeep: '#000000', //     pip inner shadow

  // ---- semantic states (never colour-alone; pair with icon/weight/border) ---
  danger: '#c0392b', //          bust
  bank: '#5fae7f', //            banked
  warn: '#d8923a', //            timer low
} as const;

export type BankPaletteKey = keyof typeof BPAL;

/**
 * CSS custom-property name for each palette entry. `style.css` MUST declare
 * exactly these on `:root` with exactly these values — the mirror is checked by
 * `palette.test.ts`. Consumers use `var(--felt)`, never a raw hex.
 */
export const BPAL_CSS_VARS: Record<BankPaletteKey, string> = {
  ink: '--ink',
  inkLit: '--ink-lit',
  inkDeep: '--ink-deep',
  feltLight: '--felt-light',
  felt: '--felt',
  feltDark: '--felt-dark',
  feltDeep: '--felt-deep',
  railLit: '--rail-lit',
  rail: '--rail',
  railDeep: '--rail-deep',
  goldBright: '--gold-bright',
  gold: '--gold',
  goldDeep: '--gold-deep',
  cream: '--cream',
  creamDim: '--cream-dim',
  creamFaint: '--cream-faint',
  diceFace: '--dice-face',
  diceFaceShade: '--dice-face-shade',
  diceBevel: '--dice-bevel',
  dicePip: '--dice-pip',
  dicePipDeep: '--dice-pip-deep',
  danger: '--danger',
  bank: '--bank',
  warn: '--warn',
};
