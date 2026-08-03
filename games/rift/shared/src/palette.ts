// ============================================================================
// ANCIENTS (rift) — PALETTE. Every colour in the game, by name. Ad-hoc hex in
// any implementer file is a contract violation; the ONLY sanctioned derivation
// is mix()/composite() from @platform/shared with both endpoints from APAL.
// Tier law (VISUAL_UPGRADE §2): Lit >= base + 8 L*, Deep <= base - 8 L*.
// Team colours must read against moss AND against fog-darkened moss
// (composite(moss, shroud, 0.55)) — asserted in valueLadder.test.ts.
//
// Mood: overgrown celestial ruins at dusk — cool mossy dark ground, warm worn
// stone lanes and monuments, two team lights (azure vs ember) burning against
// the dark, arcane violet/gold for magic and treasure.
// ============================================================================

export const APAL = {
  // --- app shell ------------------------------------------------------------
  ink: '#0e1116', // page background; index.html pre-boot bg MUST equal this
  inkLit: '#20262f',
  inkDeep: '#07090c',

  // --- terrain (ground is the darkest large surface — L5 floor L>=22) --------
  moss: '#2e3827', // open ground
  mossLit: '#424e38',
  mossDeep: '#1a2114',
  leaf: '#3a5230', // scattered foliage clusters
  leafDeep: '#24331f',
  trunk: '#4a3b2c',

  // --- lanes + structures (worn monument stone, always above ground) ---------
  stone: '#6e675a', // lane paving
  stoneLit: '#8d8577', // trim, cornice
  stoneDeep: '#4d483f', // plinth, contact band
  monument: '#7d7466', // tower/ancient body — lighter than lane stone
  monumentLit: '#a39a88',
  monumentDeep: '#575046',

  // --- team identity ---------------------------------------------------------
  azure: '#5a8fd6', // team 0
  azureLit: '#9dc0ec',
  azureDeep: '#2f4f86',
  ember: '#d96a3f', // team 1
  emberLit: '#f0a37c',
  emberDeep: '#8a3a20',

  // --- hero accents (hero.ts visual.accent keys; pairwise distinguishable,
  //       none equal to a team colour — asserted by the ladder test) ----------
  frost: '#7fc4d9', // longbow
  arcane: '#9a6fd6', // ability fx
  heal: '#6fc97f', // mender
  shade: '#7d6fa8', // shade
  pine: '#3f7a52', // bullwark
  void: '#c95aa8', // hex

  // --- semantic / fx ----------------------------------------------------------
  gold: '#d9b25f', // shop, bounty, ancient glow
  goldLit: '#f0d79a',
  danger: '#d94f4f', // enemy-targeted UI, kill feed, low hp
  ward: '#c9c2ae', // observer ward glow

  // --- sky + fog (S1: zenith cooler and >=12 L darker than horizon; S2: fog IS
  //       the horizon stop, exactly) ------------------------------------------
  skyHigh: '#0b1024',
  horizon: '#2b3242',
  fog: '#2b3242', // MUST equal horizon (S2)
  shroud: '#07090c', // unexplored fog-of-war overlay == inkDeep

  // --- text ------------------------------------------------------------------
  paper: '#e8e6df',
  paperDim: '#a9a69c',
  paperDeep: '#6f6d64',
} as const;

export type AncientsPaletteKey = keyof typeof APAL;

/** CSS custom property mirror, applied to :root at boot (client main.ts) and
 *  duplicated as fallback literals in style.css. 1:1 with APAL — the ladder
 *  test asserts the mirror is complete and exact. */
export const APAL_CSS_VARS: Record<AncientsPaletteKey, string> = {
  ink: '--ink',
  inkLit: '--ink-lit',
  inkDeep: '--ink-deep',
  moss: '--moss',
  mossLit: '--moss-lit',
  mossDeep: '--moss-deep',
  leaf: '--leaf',
  leafDeep: '--leaf-deep',
  trunk: '--trunk',
  stone: '--stone',
  stoneLit: '--stone-lit',
  stoneDeep: '--stone-deep',
  monument: '--monument',
  monumentLit: '--monument-lit',
  monumentDeep: '--monument-deep',
  azure: '--azure',
  azureLit: '--azure-lit',
  azureDeep: '--azure-deep',
  ember: '--ember',
  emberLit: '--ember-lit',
  emberDeep: '--ember-deep',
  frost: '--frost',
  arcane: '--arcane',
  heal: '--heal',
  shade: '--shade',
  pine: '--pine',
  void: '--void',
  gold: '--gold',
  goldLit: '--gold-lit',
  danger: '--danger',
  ward: '--ward',
  skyHigh: '--sky-high',
  horizon: '--horizon',
  fog: '--fog',
  shroud: '--shroud',
  paper: '--paper',
  paperDim: '--paper-dim',
  paperDeep: '--paper-deep',
};

/** Team colour by TeamId index. */
export const TEAM_COLORS: readonly string[] = [APAL.azure, APAL.ember];
