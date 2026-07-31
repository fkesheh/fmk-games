// ============================================================================
// FROZEN CONTRACT — WORDBOMB palette. ALL colour traces here.
//
// Every game on this platform has one of these (see games/bank/shared/palette.ts,
// games/kart/shared/palette.ts) and VISUAL_UPGRADE.md §0 forbids ad-hoc hex
// outside them. The launcher card in platform/server/src/index.ts MIRRORS exact
// entries from this file.
//
// TIER SYSTEM (VISUAL_UPGRADE.md §2): …Lit / base / …Dark / …Deep, with two
// HARD FLOORS enforced by valueLadder.test.ts — `…Lit` >= base + 8 L*, and
// `…Deep` <= base - 8 L*.
//
// MOOD: a lit fuse in a dark room. Near-black ground so the burning fuse and
// the letters are the only bright things; amber is the fuse and the clock;
// paper-cream is language; the boom is the one saturated red in the game.
// ============================================================================

export const WPAL = {
  // ---- room ----
  ink: '#0d1014', //              L  5  page ground
  inkLit: '#171c22', //           L 11  raised panel
  inkDeep: '#05070a', //          L  2  vignette floor / drop shadow

  // ---- surfaces ----
  slateLit: '#3d4854', //         L 30  panel border / raised edge
  slate: '#28303a', //            L 19  card surface
  slateDeep: '#141a21', //        L  9  inset well / contact shadow

  // ---- the fuse (accent + timer) ----
  fuseLit: '#ffd47a', //          L 86  hot core / highlight
  fuse: '#f0a63c', //             L 74  the accent colour
  fuseDeep: '#8a5410', //         L 40  burnt / spent fuse

  // ---- the boom ----
  boomLit: '#ff8a5c', //          L 68  flash
  boom: '#d93a2b', //             L 47  the explosion, the one saturated red
  boomDeep: '#6e1710', //         L 21  scorch

  // ---- language ----
  paperLit: '#fbf7ec', //         L 97  the fragment itself — brightest thing
  paper: '#e6ded0', //            L 89  typed letters
  paperDim: '#9d968a', //         L 62  placeholder / hint
  paperDeep: '#585349', //        L 36  disabled

  // ---- semantic states (never colour ALONE — pair with icon/weight) --------
  accept: '#5fc98a', //           L 73  a valid lock
  reject: '#c0564a', //           L 48  a refused submission
  unique: '#7fb8f0', //           L 72  nobody else found it — the prize state
  split: '#b08fd0', //            L 62  shared with others

  // ---- player chips ----
  p1: '#f0a63c',
  p2: '#7fb8f0',
  p3: '#5fc98a',
  p4: '#d97fb0',
  p5: '#b08fd0',
  p6: '#e8d060',
  p7: '#6fd0c8',
  p8: '#e8845c',
} as const;

export type WordbombPaletteKey = keyof typeof WPAL;

/**
 * CSS custom-property name per entry. `style.css` declares exactly these on
 * `:root` with exactly these values (the ONE permitted place for hex outside
 * this file), and `main.ts` mirrors them at boot. The mirror is checked by
 * `valueLadder.test.ts`.
 */
export const WPAL_CSS_VARS: Record<WordbombPaletteKey, string> = {
  ink: '--ink',
  inkLit: '--ink-lit',
  inkDeep: '--ink-deep',
  slateLit: '--slate-lit',
  slate: '--slate',
  slateDeep: '--slate-deep',
  fuseLit: '--fuse-lit',
  fuse: '--fuse',
  fuseDeep: '--fuse-deep',
  boomLit: '--boom-lit',
  boom: '--boom',
  boomDeep: '--boom-deep',
  paperLit: '--paper-lit',
  paper: '--paper',
  paperDim: '--paper-dim',
  paperDeep: '--paper-deep',
  accept: '--accept',
  reject: '--reject',
  unique: '--unique',
  split: '--split',
  p1: '--p1',
  p2: '--p2',
  p3: '--p3',
  p4: '--p4',
  p5: '--p5',
  p6: '--p6',
  p7: '--p7',
  p8: '--p8',
};

/** Chip colour by seat index. */
export const WORDBOMB_COLORS: string[] = [
  WPAL.p1, WPAL.p2, WPAL.p3, WPAL.p4, WPAL.p5, WPAL.p6, WPAL.p7, WPAL.p8,
];
