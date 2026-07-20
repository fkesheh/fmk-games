// ============================================================================
// FROZEN CONTRACT — KART GP: the named palette. ALL colors trace here.
// ============================================================================

export const KPAL = {
  asphalt: '#3a3f45',
  asphaltLight: '#4a5058',
  curbRed: '#c0392b',
  curbWhite: '#e8e6df',
  grass: '#4a7a3d',
  grassDark: '#3d6a31',
  dirt: '#7a5a39',
  sky: '#87a8c8',
  horizon: '#c8d8e8',
  fog: '#a8bccc',
  treeTrunk: '#5d3a1a',
  treeLeaf: '#2d5e23',
  treeLeafLight: '#3e7c2f',
  rock: '#6e6e66',
  barrierWhite: '#e8e6df',
  barrierRed: '#a03028',
  startLine: '#e8e6df',
  ink: '#14171c',
  charcoal: '#23282f',
  gold: '#d4af37',
  steel: '#9aa3ad',
  tire: '#1d2126',
  hudText: '#e8e6df',
  danger: '#c0392b',
  // player karts (index = KartPlayerInfo.color)
  kartRed: '#c0392b',
  kartBlue: '#3d5a9b',
  kartGreen: '#4a7a3d',
  kartYellow: '#c8912f',
  kartPurple: '#7a4a9b',
  kartOrange: '#c86a2f',
  kartTeal: '#2f8f8f',
  kartPink: '#c86a9b',
} as const;

export const KART_COLORS: string[] = [
  KPAL.kartRed,
  KPAL.kartBlue,
  KPAL.kartGreen,
  KPAL.kartYellow,
  KPAL.kartPurple,
  KPAL.kartOrange,
  KPAL.kartTeal,
  KPAL.kartPink,
];
