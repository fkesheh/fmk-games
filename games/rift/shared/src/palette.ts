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
//
// EXTENDED (GRAPHICS_CONTRACT §3, PBR + terrain pass): the palette is extended,
// NEVER re-valued. Every entry that existed before this pass keeps its exact
// value, so every pre-existing ladder assertion still holds untouched. Added
// here: cliff rock, dirt, wet/river stone, water, canopy/bark/fern, the metals
// (iron/bronze, and goldDeep to complete the gold ladder), the neutral-camp
// identity, and the full night lighting state.
//
// Albedo source of record for the frozen surface table (STYLE_BIBLE §2): every
// SurfaceId in shared/src/surfaces.ts names exactly one key below as its
// `albedo`, and that binding is the only reason these families exist —
//   groundMoss -> moss   groundDirt -> dirt   lanePaving -> stone
//   cliffRock  -> cliff  wetRock -> wetStone  riverWater -> water
//   monumentStone -> monument  bark -> bark  canopy -> canopy  fern -> fern
//   cloth -> paperDim (tinted per team)  leather -> trunk  crystal -> ward
//   iron -> iron  bronze -> bronze  gold -> gold
// so renaming or re-valuing any of them silently re-skins the whole world.
//
// The Lit/Deep step of each family is ALSO the family's tint ladder: the >= 3
// seeded colour-tint steps STYLE_BIBLE §8 requires of every scattered instance
// are {base, Lit, Deep}, never an ad-hoc lighten/darken.
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
  trunk: '#4a3b2c', // also the `leather` surface family (straps, packs)

  // --- terrain relief: rock, earth, river (all separated from moss by >= 12 L*
  //       OR >= 25 deg hue — the ground must never merge with what stands on
  //       it; asserted per family in valueLadder.test.ts) --------------------
  cliff: '#6d737b', // bare wind-scoured cliff face; COOL grey, which is what
  cliffLit: '#8f959d', //   separates it from the warm lane/monument stone at
  cliffDeep: '#4b5057', //   almost the same L* (dH ~175 deg vs stone)
  dirt: '#66523d', // worn lane earth, camp floors, path shoulders
  dirtLit: '#8c765f',
  dirtDeep: '#3d3125',
  wetStone: '#4b5259', // river-washed stone; darker + cooler than dry cliff,
  wetStoneLit: '#727a82', //   and the low-roughness surface does the rest of
  wetStoneDeep: '#2e3439', //   the "wet" read (STYLE_BIBLE §2)
  water: '#3a6b7d', // shallow river; saturated teal against desaturated banks
  waterLit: '#63969f', //   (S 37 vs wetStone's S 9) so the channel reads even
  waterDeep: '#1f4450', //   where the two sit at similar value

  // --- jungle (canopy shares moss's hue by design — a forest IS the ground's
  //       colour family — so its separation is carried entirely by value:
  //       L(canopy) - L(moss) ~= 20) ----------------------------------------
  canopy: '#4e6b32', // leaf mass
  canopyLit: '#6e8f4c',
  canopyDeep: '#324521',
  bark: '#584535', // trunks under PBR; warmer + lighter than the flat `trunk`
  barkLit: '#7d6650',
  barkDeep: '#372a1f',
  fern: '#5b7038', // undergrowth; yellower than canopy so the two layers split
  fernLit: '#7e9453',
  fernDeep: '#3a4a24',

  // --- metals (metalness 1.0 families; albedo is only half the read — the
  //       other half is the IBL specular, so these sit close in L* on purpose)
  iron: '#838992', // weapons, armour plate — neutral cool steel
  ironLit: '#a8aeb7',
  ironDeep: '#5f646d',
  bronze: '#9a7142', // trim, braziers, ornament — warm, between iron and gold
  bronzeLit: '#c39a63',
  bronzeDeep: '#6c4d2b',

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

  // --- neutral-camp identity (NEUTRAL_TEAM = 2). A venom yellow-green that
  //       sits in the widest empty wedge of the wheel: >= 38 deg from every
  //       team colour and every hero accent, so a neutral creep can never be
  //       misread as an enemy creep. NOT a member of TEAM_COLORS — that array
  //       is indexed by TeamId and neutral entities must be narrowed out with
  //       isPlayerTeam before any per-team index (TERRAIN_CONTRACT §5). -------
  neutral: '#98b45c',
  neutralLit: '#bdd385',
  neutralDeep: '#6f8639',

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
  // completes the gold ladder — the shaded side of the `gold` metal family, and
  // the only sanctioned dark step for bounty and ancient ornament
  goldDeep: '#a8813a',
  danger: '#d94f4f', // enemy-targeted UI, kill feed, low hp
  ward: '#c9c2ae', // observer ward glow

  // --- sky + fog (S1: zenith cooler and >=12 L darker than horizon; S2: fog IS
  //       the horizon stop, exactly) ------------------------------------------
  skyHigh: '#0b1024',
  horizon: '#2b3242',
  fog: '#2b3242', // MUST equal horizon (S2)
  shroud: '#07090c', // unexplored fog-of-war overlay == inkDeep

  // --- night lighting state (STYLE_BIBLE §4 "NIGHT"). The SAME three sky laws
  //       bind at t=1 as at t=0: S1 (nightSky cooler AND >= 12 L* darker than
  //       nightHorizon), S2 (nightFog IS nightHorizon, exactly), S4 (the night
  //       ground is not the night horizon). setTimeOfDay interpolates the day
  //       triplet into this one — endpoints only, and both endpoints are
  //       palette entries, so mix() stays legal all the way across. ----------
  nightSky: '#04091f', // zenith under the moon
  nightHorizon: '#282d3a', // moonlit haze at the skyline
  nightFog: '#282d3a', // MUST equal nightHorizon (S2)
  nightGround: '#17211b', // moss under moonlight: ~7 L* BELOW nightHorizon and
  //                         ~79 deg off its hue, so the horizon line survives
  moon: '#c6d6ee', // cold blue-white moon disc + directional light tint

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
  cliff: '--cliff',
  cliffLit: '--cliff-lit',
  cliffDeep: '--cliff-deep',
  dirt: '--dirt',
  dirtLit: '--dirt-lit',
  dirtDeep: '--dirt-deep',
  wetStone: '--wet-stone',
  wetStoneLit: '--wet-stone-lit',
  wetStoneDeep: '--wet-stone-deep',
  water: '--water',
  waterLit: '--water-lit',
  waterDeep: '--water-deep',
  canopy: '--canopy',
  canopyLit: '--canopy-lit',
  canopyDeep: '--canopy-deep',
  bark: '--bark',
  barkLit: '--bark-lit',
  barkDeep: '--bark-deep',
  fern: '--fern',
  fernLit: '--fern-lit',
  fernDeep: '--fern-deep',
  iron: '--iron',
  ironLit: '--iron-lit',
  ironDeep: '--iron-deep',
  bronze: '--bronze',
  bronzeLit: '--bronze-lit',
  bronzeDeep: '--bronze-deep',
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
  neutral: '--neutral',
  neutralLit: '--neutral-lit',
  neutralDeep: '--neutral-deep',
  frost: '--frost',
  arcane: '--arcane',
  heal: '--heal',
  shade: '--shade',
  pine: '--pine',
  void: '--void',
  gold: '--gold',
  goldLit: '--gold-lit',
  goldDeep: '--gold-deep',
  danger: '--danger',
  ward: '--ward',
  skyHigh: '--sky-high',
  horizon: '--horizon',
  fog: '--fog',
  shroud: '--shroud',
  nightSky: '--night-sky',
  nightHorizon: '--night-horizon',
  nightFog: '--night-fog',
  nightGround: '--night-ground',
  moon: '--moon',
  paper: '--paper',
  paperDim: '--paper-dim',
  paperDeep: '--paper-deep',
};

/** Team colour by TeamId index. */
export const TEAM_COLORS: readonly string[] = [APAL.azure, APAL.ember];
