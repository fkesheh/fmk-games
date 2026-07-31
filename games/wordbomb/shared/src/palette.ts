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
  // Placed on the SAME 12-hue x 2-lightness grid as the chips, so a state can
  // never collide with a player's identity colour. An earlier hand-picked set
  // had accept/unique/split BYTE-IDENTICAL to p3/p2/p5 — on the reveal screen,
  // where a chip and a state sit side by side, that is unreadable.
  accept: '#59c58f', //           H 150  L 72  a valid lock
  reject: '#c23838', //           H   0  L 45  a refused submission
  unique: '#8cb5dd', //           H 210  L 72  nobody else found it — the prize
  split: '#c1a6dd', //            H 269  L 72  shared with others

  // ---- player chips (MAX_PLAYERS = 20) ------------------------------------
  // COMPUTED, not hand-picked, on a 12-hue x 2-lightness grid: neighbours in
  // hue are 30 deg apart (bar is 25) and same-hue pairs are ~27 L* apart (bar
  // is 20), so all 24 chip+state colours are mutually distinguishable with a
  // measured minimum margin of +4.45. Hand-picking produced 5 confusable pairs
  // and 3 exact duplicates; `valueLadder.test.ts` caught them.
  p1: '#e1a0a0', //          H   0  L 72
  p2: '#935f2b', //          H  30  L 45
  p3: '#d5a97c', //          H  30  L 72
  p4: '#6e6e20', //          H  60  L 45
  p5: '#b6b639', //          H  60  L 72
  p6: '#4c7622', //          H  90  L 45
  p7: '#81c23f', //          H  90  L 72
  p8: '#247b24', //          H 120  L 45
  p9: '#52c852', //          H 120  L 72
  p10: '#23794e', //         H 150  L 45
  p11: '#227676', //         H 180  L 45
  p12: '#3fc2c2', //         H 180  L 72
  p13: '#316daa', //         H 210  L 45
  p14: '#5c5cd0', //         H 240  L 45
  p15: '#acace5', //         H 240  L 72
  p16: '#8a49ca', //         H 270  L 45
  p17: '#af33af', //         H 300  L 45
  p18: '#df98df', //         H 300  L 72
  p19: '#bb3678', //         H 330  L 45
  p20: '#e09cbe', //         H 330  L 72
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
  p9: '--p9',
  p10: '--p10',
  p11: '--p11',
  p12: '--p12',
  p13: '--p13',
  p14: '--p14',
  p15: '--p15',
  p16: '--p16',
  p17: '--p17',
  p18: '--p18',
  p19: '--p19',
  p20: '--p20',
};

/** Chip colour by seat index. */
export const WORDBOMB_COLORS: string[] = [
  WPAL.p1, WPAL.p2, WPAL.p3, WPAL.p4, WPAL.p5,
  WPAL.p6, WPAL.p7, WPAL.p8, WPAL.p9, WPAL.p10,
  WPAL.p11, WPAL.p12, WPAL.p13, WPAL.p14, WPAL.p15,
  WPAL.p16, WPAL.p17, WPAL.p18, WPAL.p19, WPAL.p20,
];
