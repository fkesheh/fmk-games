// ============================================================================
// FROZEN CONTRACT — the named palette. ALL colors in the game (map boxes,
// props, characters, weapons, fx, sky/fog themes, HUD) MUST trace to these
// entries. Ad-hoc hex literals outside this file are a contract violation.
// ============================================================================

export const PALETTE = {
  // neutrals / industrial
  ink: '#14171c',
  charcoal: '#23282f',
  concrete: '#8d8d83',
  concreteDark: '#6e6e66',
  steel: '#9aa3ad',
  metalDark: '#3c4249',
  // desert
  sand: '#cbb678',
  sandDark: '#a8945e',
  dust: '#b09a6a',
  // wood
  wood: '#8b5a2b',
  woodDark: '#5d3a1a',
  crate: '#a97142',
  // urban / office
  brick: '#9b5a4a',
  plaster: '#d8cfc0',
  roofRed: '#8a4a3a',
  carpet: '#4a5568',
  deskTop: '#b08d57',
  paper: '#e8e6df',
  screenGlow: '#2f6f8f',
  // snow
  snow: '#e8eef2',
  snowShadow: '#c3ccd8',
  ice: '#a8c8d8',
  rockDark: '#4a4f55',
  // foliage
  leaf: '#3e7c2f',
  leafDark: '#2d5e23',
  cactus: '#4a7a3d',
  shrubDead: '#7a6a3f',
  // teams
  ctBlue: '#3d5a9b',
  ctDark: '#2a3f6e',
  tAmber: '#c8912f',
  tBrown: '#6e5232',
  skin: '#e0ac69',
  // fx
  muzzle: '#ffcf6e',
  tracer: '#ffd88a',
  blood: '#a03028',
  fire: '#ff7733',
  // skies & fog (map themes only)
  skyDay: '#87a8c8',
  skyDusk: '#e8a86a',
  skyCold: '#b8ccd8',
  skyIndoor: '#20242a',
  fogDay: '#a8bccc',
  fogDusk: '#d8a878',
  fogCold: '#ccd8e0',
  // HUD
  hudText: '#e8e6df',
  hudAccent: '#c8912f',
  danger: '#c0392b',
  hpGreen: '#7fb069',
} as const;

export type PaletteKey = keyof typeof PALETTE;
