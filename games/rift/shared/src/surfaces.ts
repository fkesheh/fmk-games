// ============================================================================
// ANCIENTS (rift) — SURFACE TABLE. The frozen material vocabulary of the game,
// transcribed from STYLE_BIBLE §2 and referenced by GRAPHICS_CONTRACT §2.
// PURE DATA: no THREE import, no logic, no derived computation. This file lives
// in shared/ so the client kit and any tooling read the SAME table.
//
// The law it encodes (STYLE_BIBLE §2): one material model — MeshStandardMaterial
// for every world and unit surface — and exactly ONE construction path, the
// kit's `surface(id, tint?)` / `emissiveSurface(id, colorKey, intensity, tint?)`.
// Nobody calls a material constructor directly, and nobody invents a family:
// adding a SurfaceId requires an orchestrator amendment. AMENDMENT_3 §C is such
// an amendment and adds the three transparent families at the foot of the table.
//
// Roughness is the primary storytelling dial. It is what makes river-washed
// stone read differently from dry wind-scoured cliff under the same sun, and it
// is why families that sit close in hue are still unmistakable — they separate
// on roughness and normal character, not only on colour.
//
// All colour is an APAL key (games/rift/shared/src/palette.ts). The field types
// below are `AncientsPaletteKey`, so a mistyped colour name cannot compile.
// ============================================================================

import type { AncientsPaletteKey } from './palette.js';

// --- Normal-map character ----------------------------------------------------

/** The structural character of a family's normal map — the "normal" column of
 *  the STYLE_BIBLE §2 table, made typed so every implementer that generates a
 *  surface produces the SAME kind of detail for the same family. The kit's
 *  `noiseTexture` / `normalFromHeight` generators switch on this; nothing else
 *  interprets it.
 *
 *  Frequencies are described relative to the UV law (GRAPHICS_CONTRACT §2:
 *  1 UV unit ≙ 1 world metre), so "fine" and "coarse" mean centimetres and
 *  decimetres respectively, uniformly across the whole map. */
export type NormalPattern =
  /** Dense isotropic grain — damp moss, silt. Centimetre scale. */
  | 'fineNoise'
  /** Chunky isotropic grain — churned earth, gravel. Decimetre scale. */
  | 'coarseNoise'
  /** A rectilinear lattice of recessed joints between worn flagstones. */
  | 'slabSeam'
  /** Horizontal bedding planes with hard breaks — sedimentary rock faces. */
  | 'strata'
  /** Vertical fibrous ridges running up a trunk. */
  | 'barkStrata'
  /** Low-frequency directional waves; the ONLY animated pattern (the kit
   *  scrolls its offset for the river; see STYLE_BIBLE §9 "a still frame of a
   *  MOBA should never look still"). */
  | 'ripple'
  /** Tooled relief — chisel facets, incised glyph channels, mortar courses. */
  | 'carved'
  /** Broad, rounded, low-contrast undulation for leaf and frond masses; it must
   *  read as volume at gameplay zoom, never as per-leaf detail. */
  | 'soft'
  /** Crossed warp/weft threads — banners, robes, tabards. */
  | 'weave'
  /** Irregular pebbled hide grain with soft creases. */
  | 'grain'
  /** Fine unidirectional scratches — machined/whetted metal. */
  | 'brushed'
  /** Shallow overlapping dimples — beaten metal. */
  | 'hammered'
  /** Near-flat with only faint wear; keeps a polished metal's mirror read. */
  | 'polished';

/** A family's normal map. `null` on a family means the material carries no
 *  normal map at all — see `crystal`, whose read is emissive core plus bloom,
 *  not surface detail. */
export interface SurfaceNormal {
  /** Which generator the kit runs for this family. */
  readonly pattern: NormalPattern;
  /** Multiplier written to `MeshStandardMaterial.normalScale` on BOTH axes.
   *  1.0 is the generator's natural depth; above 1 exaggerates relief, below 1
   *  damps it. Low-roughness families are deliberately damped — a strong normal
   *  on a glossy surface boils the specular highlight as the camera pans, which
   *  is the classic way procedural PBR reads as cheap. */
  readonly strength: number;
}

/** How a family's fragments combine with what is already in the frame buffer.
 *  A STRING, not a `THREE.Blending`, because this file is pure data and imports
 *  no renderer; the kit maps it to the THREE constant in exactly one place.
 *
 *  `'normal'` is source-over — the default every opaque family and the river
 *  use. `'additive'` adds light to the frame and can therefore never darken or
 *  occlude what is behind it, which is precisely what a burst, a dome, a tracer
 *  or a mote must do (AMENDMENT_3 §C: an opaque, depth-writing 5.8 m dome hard-
 *  occluded the fight on every cast). */
export type SurfaceBlending = 'normal' | 'additive';

/** A family's depth-bias, or `null` for none. Applied as
 *  `material.polygonOffset` + `polygonOffsetFactor` / `polygonOffsetUnits`.
 *
 *  NEGATIVE values bias TOWARD the camera. That direction is the whole point:
 *  a ground decal is coplanar with the terrain it sits on, and without a bias
 *  it z-fights. Biasing it toward the camera is how a decal stays a FLAT quad
 *  instead of being lifted into a mound the units then stand buried in
 *  (AMENDMENT_3 §C measured 0.208 m of burial from exactly that workaround). */
export interface SurfacePolygonOffset {
  /** `material.polygonOffsetFactor` — scales with the face's depth slope, so a
   *  quad seen edge-on gets more bias than one seen flat. */
  readonly factor: number;
  /** `material.polygonOffsetUnits` — a constant bias in resolvable depth
   *  units. */
  readonly units: number;
}

/** A family's emissive default. `null` means the family does not glow.
 *  Emissive surfaces are the ONLY inputs to selective bloom (STYLE_BIBLE §6),
 *  and every object built from one must be passed to the kit's `markBloom`. */
export interface SurfaceEmissive {
  /** Written to `material.emissive`. This is the neutral fallback used when a
   *  family is built through plain `surface(id)`; `emissiveSurface(id, colorKey,
   *  intensity, tint?)` overrides both fields with the caller's team/ability
   *  colour, and its optional `tint` independently sets the ALBEDO — the two are
   *  separate channels precisely so a team crystal can glow azure AND be azure
   *  rather than having its tint swamped by the family default (AMENDMENT_3 §A). */
  readonly color: AncientsPaletteKey;
  /** Written to `material.emissiveIntensity`. Tuned to be pleasant by day and
   *  dominant by night (STYLE_BIBLE §4) — glowing geometry is the primary light
   *  source in the night state. */
  readonly intensity: number;
}

// --- The family vocabulary ---------------------------------------------------

/** Every surface family, in STYLE_BIBLE §2 table order. Iterating this is the
 *  sanctioned way to walk the table — the kit's material prewarm does exactly
 *  that so no material is constructed mid-frame. */
export const SURFACE_IDS = [
  'groundMoss',
  'groundDirt',
  'lanePaving',
  'cliffRock',
  'wetRock',
  'riverWater',
  'monumentStone',
  'bark',
  'canopy',
  'fern',
  'cloth',
  'leather',
  'iron',
  'bronze',
  'gold',
  'crystal',
  // --- the transparent families (AMENDMENT_3 §C). They are listed last because
  //     the sixteen above are the STYLE_BIBLE §2 table verbatim and their order
  //     is the table's; these three are the amendment's addition to it.
  'fxAdditive',
  'fxDecal',
  'shroud',
] as const;

/** The frozen surface vocabulary. Exactly the family keys of the STYLE_BIBLE §2
 *  table — no more, no fewer. Every material in the game is `surface(id)` for
 *  one of these. */
export type SurfaceId = (typeof SURFACE_IDS)[number];

/** The physical description of one family. Every field maps to a
 *  `MeshStandardMaterial` property the kit sets; the kit sets no material
 *  property this table does not specify, which is what keeps sixteen families
 *  looking like they were lit by one sun. */
export interface SurfaceDef {
  /** `material.color`, resolved as `APAL[albedo]`. Never an ad-hoc hex. The
   *  kit's optional `tint` argument mixes AWAY from this base toward another
   *  APAL entry; the base is what the family reads as untinted. */
  readonly albedo: AncientsPaletteKey;
  /** `material.roughness` — the constant, and the base level the roughness map
   *  (when present) varies around. 0 = mirror, 1 = fully diffuse. */
  readonly roughness: number;
  /** `material.metalness`. 0 for everything except the three true-metal
   *  families; PBR admits no in-between values on a physically plausible
   *  surface, so this is 0 or 1 and never a fraction. */
  readonly metalness: number;
  /** `material.flatShading`. True only where the form is GENUINELY faceted —
   *  cut rock and crystal. Organic and manufactured curved surfaces shade
   *  smooth (STYLE_BIBLE §2); faceting a lathe-turned tower shaft is a defect. */
  readonly flatShading: boolean;
  /** `material.normalMap` + `normalScale`, or `null` for no normal map. */
  readonly normal: SurfaceNormal | null;
  /** Whether the family carries a generated `material.roughnessMap`. True where
   *  the surface is heterogeneously wet, worn or weathered and a single constant
   *  would read as plastic; false where the family is uniform enough that a map
   *  costs texture memory and buys nothing. */
  readonly roughnessMap: boolean;
  /** `material.transparent`. True for the river and for the three FX/overlay
   *  families below it. Sorting transparent geometry is not free, and a
   *  transparent surface neither writes usable depth nor receives screen-space
   *  AO cleanly — which is why this is four families out of nineteen and not a
   *  dial an implementer reaches for. */
  readonly transparent: boolean;
  /** `material.opacity`. 1 for every opaque family; consumers may write it
   *  unconditionally. */
  readonly opacity: number;
  /** `material.emissive` + `emissiveIntensity`, or `null` for a non-glowing
   *  family. */
  readonly emissive: SurfaceEmissive | null;

  // --- transparency controls (AMENDMENT_3 §C) --------------------------------
  //
  // These three are OPTIONAL and their omission means exactly what THREE's own
  // defaults mean, so every family authored before the amendment keeps its
  // rendered result bit-for-bit. They exist so that depth and blend state come
  // FROM THE TABLE: `surface()` caches one material per (id, tint, emissive),
  // every consumer of a family shares that instance, and therefore setting
  // `depthWrite` / `blending` / `polygonOffset` at a call site silently drags
  // every other user of the family with it. Declaring it here is the only legal
  // way to have it.

  /** `material.depthWrite`. Omitted (or true) means the family writes depth.
   *  False for everything that must not occlude the fight behind it. */
  readonly depthWrite?: boolean;
  /** How fragments combine with the frame buffer. Omitted means `'normal'`. */
  readonly blending?: SurfaceBlending;
  /** Depth bias, or omitted/`null` for none (`material.polygonOffset = false`). */
  readonly polygonOffset?: SurfacePolygonOffset | null;
}

// --- The frozen table --------------------------------------------------------
//
// Roughness and metalness are transcribed EXACTLY from STYLE_BIBLE §2; they are
// the art direction and may not be retuned by an implementer. Each entry quotes
// its table row so a reviewer can check the transcription without leaving the
// file.

export const SURFACES: Record<SurfaceId, SurfaceDef> = {
  /** "damp open ground | 0.95 | 0 | fine noise | the darkest large surface".
   *  The floor of the value ladder: everything gameplay-relevant stands on this
   *  and must out-read it. Its normal detail must stay visible at the day
   *  exposure — a moss ground that crushes to black is a lighting failure, not
   *  a licence to raise this albedo. */
  groundMoss: {
    albedo: 'moss',
    roughness: 0.95,
    metalness: 0,
    flatShading: false,
    normal: { pattern: 'fineNoise', strength: 0.55 },
    roughnessMap: true, // damp patches vs. drier tufts; the wet/dry read
    transparent: false,
    opacity: 1,
    emissive: null,
  },

  /** "worn lane earth | 0.90 | 0 | coarse | lane edges, camp floors".
   *  The transition material: it bleeds from the paving out into the moss so a
   *  lane looks built into the ground rather than taped onto it
   *  (STYLE_BIBLE §10a.3). */
  groundDirt: {
    albedo: 'dirt',
    roughness: 0.9,
    metalness: 0,
    flatShading: false,
    normal: { pattern: 'coarseNoise', strength: 0.85 },
    roughnessMap: true, // rutted, trodden and puddled in uneven measure
    transparent: false,
    opacity: 1,
    emissive: null,
  },

  /** "worn flagstone | 0.72 | 0 | slab-seam | lanes read as *built*".
   *  Smooth-shaded despite being cut stone: the paving is a near-planar surface
   *  and its form comes from the seam normals, not from facets. */
  lanePaving: {
    albedo: 'stone',
    roughness: 0.72,
    metalness: 0,
    flatShading: false,
    normal: { pattern: 'slabSeam', strength: 0.9 },
    roughnessMap: true, // polished centre wear against rough, silted joints
    transparent: false,
    opacity: 1,
    emissive: null,
  },

  /** "bare wind-scoured rock | 0.85 | 0 | strong strata | flat-shaded, faceted".
   *  The only large surface that is faceted, and deliberately so: hard shading
   *  breaks are what make a two-level map's elevation legible from above. */
  cliffRock: {
    albedo: 'cliff',
    roughness: 0.85,
    metalness: 0,
    flatShading: true,
    normal: { pattern: 'strata', strength: 1.3 }, // "strong"
    roughnessMap: true, // scoured faces vs. sheltered, lichened crevices
    transparent: false,
    opacity: 1,
    emissive: null,
  },

  /** "river-washed stone | 0.35 | 0 | medium | low roughness = wet".
   *  The proof of the material model: identical geometry to cliffRock, read as
   *  soaked purely because roughness dropped. Strength is damped to "medium" so
   *  the wet specular stays a coherent sheet rather than a field of glints. */
  wetRock: {
    albedo: 'wetStone',
    roughness: 0.35,
    metalness: 0,
    flatShading: false, // water rounds stone; faceting would fight the read
    normal: { pattern: 'fineNoise', strength: 0.7 }, // "medium"
    roughnessMap: true, // the waterline: submerged glossy into dry bank
    transparent: false,
    opacity: 1,
    emissive: null,
  },

  /** "shallow moving water | 0.08 | 0 | scrolling ripple | transparent, animated".
   *  The map's central landmark (DESIGN_DELTA §4). Opacity is set so the wetRock
   *  bed reads through — a fully opaque river is a blue road, and a nearly clear
   *  one stops catching the horizon. No roughness map: the sheet is uniformly
   *  wet and the ripple normal alone carries the motion. */
  riverWater: {
    albedo: 'water',
    roughness: 0.08,
    metalness: 0,
    flatShading: false,
    normal: { pattern: 'ripple', strength: 0.45 },
    roughnessMap: false,
    transparent: true,
    opacity: 0.72,
    emissive: null,
  },

  /** "tower / ancient body | 0.68 | 0 | carved detail | lighter than lane stone".
   *  Structures are landmarks and must separate from the paving they stand on;
   *  the albedo is the lighter monument family and the roughness sits below the
   *  lane's so a tower shaft catches a distinct sheen. Smooth-shaded: tapered
   *  shafts and lathed cornices are curved manufactured forms. */
  monumentStone: {
    albedo: 'monument',
    roughness: 0.68,
    metalness: 0,
    flatShading: false,
    normal: { pattern: 'carved', strength: 0.8 },
    roughnessMap: true, // weathered upper courses against sheltered relief
    transparent: false,
    opacity: 1,
    emissive: null,
  },

  /** "trunk | 0.92 | 0 | vertical strata".
   *  Takes the PBR `bark` family rather than the flat `trunk` entry: under IBL
   *  the old trunk value reads too dark and too cold against the canopy above
   *  it. The near-neighbour material is `leather` (on `trunk`), and the two are
   *  separated exactly as §2 intends — by roughness (0.92 vs 0.75) and by normal
   *  character (fibrous vertical ridges vs pebbled hide), not by hue. */
  bark: {
    albedo: 'bark',
    roughness: 0.92,
    metalness: 0,
    flatShading: false,
    normal: { pattern: 'barkStrata', strength: 1.0 },
    roughnessMap: true, // damp shaded flanks vs. sun-dried bark
    transparent: false,
    opacity: 1,
    emissive: null,
  },

  /** "leaf mass | 0.88 | 0 | soft | subtle translucency fake".
   *  The translucency is faked in albedo and normal softness only — this stays a
   *  MeshStandardMaterial with no transmission, and the canopy is opaque so it
   *  can be a real vision wall (STYLE_BIBLE §8: the tree line is a wall you
   *  cannot see through). No roughness map: leaf mass reads as volume, and
   *  per-leaf roughness variation is invisible at gameplay zoom. */
  canopy: {
    albedo: 'canopy',
    roughness: 0.88,
    metalness: 0,
    flatShading: false,
    normal: { pattern: 'soft', strength: 0.4 },
    roughnessMap: false,
    transparent: false,
    opacity: 1,
    emissive: null,
  },

  /** "undergrowth | 0.85 | 0 | soft".
   *  Its own family, yellower than the canopy above it, so the two jungle layers
   *  split instead of reading as one green mass from the 55° camera. Slightly
   *  glossier than canopy — undergrowth sits in the damp, and that is what sells
   *  the low jungle as wet and close (STYLE_BIBLE §1). */
  fern: {
    albedo: 'fern',
    roughness: 0.85,
    metalness: 0,
    flatShading: false,
    normal: { pattern: 'soft', strength: 0.35 },
    roughnessMap: false,
    transparent: false,
    opacity: 1,
    emissive: null,
  },

  /** "banners, robes, tabards | 0.95 | 0 | weave | team colored".
   *  The base is a neutral warm grey precisely BECAUSE the family is tinted: a
   *  saturated base would drag every team tint toward it. Callers pass the team
   *  key as `surface('cloth', tint)`. Fully matte — cloth is the roughest family
   *  in the game alongside moss, which is what keeps a banner readable as fabric
   *  next to metal trim. */
  cloth: {
    albedo: 'paperDim',
    roughness: 0.95,
    metalness: 0,
    flatShading: false,
    normal: { pattern: 'weave', strength: 0.5 },
    roughnessMap: false, // uniform fabric; the weave normal carries it
    transparent: false,
    opacity: 1,
    emissive: null,
  },

  /** "armor straps, packs | 0.75 | 0 | grain".
   *  Sits between cloth and metal on the roughness dial, which is its whole job:
   *  it is the material that makes a strapped iron pauldron read as two
   *  materials rather than one silhouette. */
  leather: {
    albedo: 'trunk',
    roughness: 0.75,
    metalness: 0,
    flatShading: false,
    normal: { pattern: 'grain', strength: 0.6 },
    roughnessMap: true, // burnished wear at the flexes, matte elsewhere
    transparent: false,
    opacity: 1,
    emissive: null,
  },

  /** "weapons, armor plate | 0.45 | 1.0 | brushed | true metal".
   *  A true metal: with metalness 1 the diffuse term vanishes and the surface is
   *  ENTIRELY the environment map, which is why IBL is mandatory
   *  (GRAPHICS_CONTRACT §1a). With `scene.environment` null this renders black. */
  iron: {
    albedo: 'iron',
    roughness: 0.45,
    metalness: 1.0,
    flatShading: false,
    normal: { pattern: 'brushed', strength: 0.35 }, // damped: glossy metal
    roughnessMap: true, // scuffs, pitting and edge wear; the anti-CGI cue
    transparent: false,
    opacity: 1,
    emissive: null,
  },

  /** "trim, braziers, ornament | 0.35 | 1.0 | hammered | true metal, warm".
   *  The warm metal against iron's cold one. Brazier bowls are bronze while
   *  their fire is an emissive; the metal itself never glows. */
  bronze: {
    albedo: 'bronze',
    roughness: 0.35,
    metalness: 1.0,
    flatShading: false,
    normal: { pattern: 'hammered', strength: 0.6 },
    roughnessMap: true, // verdigris in the hollows, polished on the highs
    transparent: false,
    opacity: 1,
    emissive: null,
  },

  /** "bounty, ancient ornament | 0.25 | 1.0 | polished | true metal, the
   *  treasure read". The glossiest metal, and a bloom target (STYLE_BIBLE §6):
   *  it blooms because the sun's specular anchor in the environment scene is
   *  genuinely bright in it, NOT because it is emissive. Gold is marked into
   *  BLOOM_LAYER by its builder; it carries no emissive here. */
  gold: {
    albedo: 'gold',
    roughness: 0.25,
    metalness: 1.0,
    flatShading: false,
    normal: { pattern: 'polished', strength: 0.2 },
    roughnessMap: true, // tarnish in the recesses keeps it from reading as CGI
    transparent: false,
    opacity: 1,
    emissive: null,
  },

  /** "team crystals, ancient heart | 0.10 | 0 | none | emissive; **not**
   *  transmissive — the frozen factory returns MeshStandardMaterial, which has
   *  no transmission. The read is emissive core + bloom, not refraction."
   *
   *  Faceted (a crystal is genuinely faceted) and normal-map-free, so the facets
   *  themselves are the only structure. The emissive default is the pale ward
   *  glow; every real crystal in the game is built through
   *  `emissiveSurface('crystal', teamKey, intensity, teamTint)`, which replaces
   *  both emissive fields AND (given the fourth argument) the albedo, and must
   *  then be passed to `markBloom`. Reaching this family through plain
   *  `surface('crystal', tint)` renders cream: the unconditional `ward` emissive
   *  swamps the tint, which is the defect AMENDMENT_3 §A closes. */
  crystal: {
    albedo: 'ward',
    roughness: 0.1,
    metalness: 0,
    flatShading: true,
    normal: null,
    roughnessMap: false,
    transparent: false, // NOT transmissive — see the quoted table note above
    opacity: 1,
    emissive: { color: 'ward', intensity: 2.2 },
  },

  // ==========================================================================
  // THE TRANSPARENT FAMILIES (AMENDMENT_3 §C)
  //
  // Before the amendment `riverWater` was the table's only transparent entry,
  // so every effect that needed to NOT occlude the game either shipped opaque
  // or mutated the shared cached material at its call site. Both happened, both
  // shipped, and both are measured in §C. These three families are the frozen
  // answer: the blend state lives in the table, one material per family, and no
  // call site touches `transparent`, `depthWrite`, `blending` or `opacity`
  // again.
  // ==========================================================================

  /** Bursts, shockwave domes, tracers, motes — everything that is LIGHT rather
   *  than matter.
   *
   *  Additive blending is the load-bearing property: additive output can only
   *  ever brighten what is already in the frame buffer, so a 5.8 m dome held
   *  for 21 frames is a flash over the fight instead of a wall in front of it.
   *  `depthWrite: false` is its partner — an additive surface that writes depth
   *  still punches a hole in everything drawn after it.
   *
   *  Deliberately unlit-ish: roughness 1 and metalness 0 mean the PBR shading
   *  term is a flat lambert wash rather than a specular event, and with no
   *  normal map there is no relief to catch a highlight. An FX flash must read
   *  the same from every camera angle; a shockwave whose brightness swings as
   *  the camera pans is the classic tell.
   *
   *  Albedo is `paper` (near-white) BECAUSE the family is always tinted: with
   *  `TINT_MIX = 1` the caller's `surface('fxAdditive', APAL.azure)` makes the
   *  tint the whole albedo, and the near-white base is what an untinted call
   *  falls back to. PER-EFFECT FADE RIDES THE VERTEX COLOUR, never `opacity`:
   *  the material is shared, and the vertex-colour law already puts a per-
   *  vertex multiplier on every geometry the kit emits. */
  fxAdditive: {
    albedo: 'paper',
    roughness: 1,
    metalness: 0,
    flatShading: false,
    normal: null,
    roughnessMap: false,
    transparent: true,
    opacity: 1,
    emissive: null,
    depthWrite: false,
    blending: 'additive',
    polygonOffset: null,
  },

  /** Ground scars, scorch marks, order markers — a FLAT QUAD LYING ON THE
   *  GROUND. Never a mound, never lifted: a decal raised off the terrain to
   *  dodge z-fighting is what buried units to mid-shin in §C.
   *
   *  The bias is `polygonOffset` toward the camera instead, which resolves the
   *  coplanar depth tie without moving a single vertex. -1 / -1 is the minimum
   *  guaranteed-resolvable bias in both terms: one depth-slope unit (so a decal
   *  on the 55 deg camera's view of a ramp is biased as much as its slope needs)
   *  plus one constant unit. It is deliberately the minimum — a large offset
   *  makes the decal pop through the shin of anything standing on it.
   *
   *  `depthWrite: false` keeps the decal out of the depth buffer entirely, so
   *  it can never occlude a unit standing on it. Matte (0.95) and normal-map-
   *  free: a scorch mark has no relief, and giving it any is how it stops
   *  reading as a mark on the ground.
   *
   *  Albedo is the neutral `paperDim`, exactly as `cloth` is, and for the same
   *  reason — the family is always tinted (scorch `inkDeep`, an order marker in
   *  its team colour) and a saturated base would drag every tint toward it. */
  fxDecal: {
    albedo: 'paperDim',
    roughness: 0.95,
    metalness: 0,
    flatShading: false,
    normal: null,
    roughnessMap: false,
    transparent: true,
    opacity: 1,
    emissive: null,
    depthWrite: false,
    blending: 'normal',
    polygonOffset: { factor: -1, units: -1 },
  },

  /** The fog-of-war overlay planes, and nothing else.
   *
   *  This family exists so the overlay stops being a clone-with-eight-overrides
   *  of `cloth` (§C). Its albedo is the `shroud` palette key — the unexplored
   *  ink the whole fog system is measured against — at the roughest end of the
   *  dial, with no normal map at all: the overlay is atmosphere read through,
   *  and a weave relief on atmosphere is a UI-lid read.
   *
   *  `depthWrite: false` because the overlay hangs above the world and must not
   *  occlude the depth of anything under it (screen-space AO and the whole post
   *  chain sample that buffer). Blending stays `'normal'` — the shroud DARKENS,
   *  which is the one thing additive cannot do. */
  shroud: {
    albedo: 'shroud',
    roughness: 0.95,
    metalness: 0,
    flatShading: false,
    normal: null,
    roughnessMap: false,
    transparent: true,
    opacity: 1,
    emissive: null,
    depthWrite: false,
    blending: 'normal',
    polygonOffset: null,
  },
};
