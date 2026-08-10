// ============================================================================
// SKI SPLAT — SPAL PALETTE. Pure data. ALL colours trace here (CONTRACT §2.5).
// Tiers follow the repo value-ladder law (…Lit / base / …Dark / …Deep),
// verifiable with @platform/shared color helpers (valueLadder.test.ts).
// ============================================================================

export const SPAL = {
  // Snow — the canvas. Shadows on snow are blue-violet, never grey.
  snowLit: '#ffffff',
  snow: '#eef2f8',
  snowShade: '#c3cfe8',
  snowDeep: '#93a5cc',   // contact bands, carved edges

  // Sky + fog. Fog is matched to skyHorizon so the world dissolves into sky.
  skyZenith: '#2c5fb8',
  skyHorizon: '#bcd4ee',
  sunWarm: '#fff1d6',    // sunlight tint

  // Plants — the antagonists; the only saturated greens on the mountain.
  pineLit: '#5da878',
  pine: '#2f7d4e',
  pineDark: '#1c5233',
  shrubLit: '#7ab35f',
  shrub: '#4d8a38',
  shrubDark: '#2e5c22',
  thornLit: '#c98a4b',   // warm "danger" read
  thorn: '#8f5c2a',

  // Rock, bark, wood.
  rockLit: '#9aa2b0',
  rock: '#6b7280',
  bark: '#5f4632',
  lodge: '#7a5a3e',

  // Accent + UI.
  sunGold: '#f2b72e',    // finish gate, crown, UI accent
  ink: '#10141c',        // UI text on light, pre-boot paint guard
  paper: '#f4f7fb',      // UI panels
} as const;

export type SpalKey = keyof typeof SPAL;

/** The 8 player identities. Verified against snow (all >= 3.1:1 contrast) and
 *  pairwise under Machado protanopia/deuteranopia simulation (worst pair
 *  distance 0.105 — ember/burnt-orange under deutan; threshold 0.10).
 *  sunGold is deliberately NOT a skier colour: it fails on snow (1.61:1) and
 *  belongs to the finish gate/crown. valueLadder.test.ts re-enforces all of
 *  this. Length === MAX_PLAYERS. */
export const SKIER_COLORS = [
  '#2f7fe0', // azure
  '#e04a2a', // ember red
  '#c26a1b', // burnt orange
  '#3a4150', // charcoal
  '#7a3ec0', // violet
  '#15919e', // deep teal
  '#e0559a', // magenta
  '#1c3f8f', // navy
] as const;

/** Animal glyphs, one per slot. Identity = colour + glyph (never colour alone). */
export const SKIER_GLYPHS = [
  '🦊', '🐻', '🦅', '🐸', '🦉', '🐬', '🦩', '🦫',
] as const;
