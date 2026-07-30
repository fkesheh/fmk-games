// ============================================================================
// FROZEN CONTRACT — MatId -> PALETTE, plus the ladder-partner tables.
//
// Moved here from the client's mapRenderer.ts so that map authors (who add
// MatIds) and the renderer author (who consumes them) never contend for one
// file. Every MatId resolves to a PALETTE entry. Adding a MatId means adding a
// row to EVERY table here AND to the `MatId` union in maps/types.ts.
//
// WHY THE PARTNER TABLES ARE NULLABLE (VISUAL_UPGRADE.md §1 L2a/L3):
// a `…Lit` surface is already at the top of its ladder and has nothing >= 8 L*
// above it; a `…Deep` surface is at the bottom and has nothing below it.
// Earlier drafts self-mapped those ends, which silently produced ZERO-CONTRAST
// trim — exactly the flat-quad defect this upgrade exists to remove. They are
// now `null`, and `articulate()` skips the element rather than emitting it.
// ============================================================================
import { PALETTE } from './palette.js';
import type { MatId } from './maps/types.js';

export const MAT_COLORS: Record<MatId, string> = {
  // desert
  sandLit: PALETTE.sandLit,
  sand: PALETTE.sand,
  sandDark: PALETTE.sandDark,
  sandDeep: PALETTE.sandDeep,
  dust: PALETTE.dust,
  dustDeep: PALETTE.dustDeep,
  // hard ground
  tarmac: PALETTE.tarmac,
  tarmacDeep: PALETTE.tarmacDeep,
  // concrete
  concreteLit: PALETTE.concreteLit,
  concrete: PALETTE.concrete,
  concreteDark: PALETTE.concreteDark,
  concreteDeep: PALETTE.concreteDeep,
  // metal
  metalLit: PALETTE.steelLit,
  metal: PALETTE.steel,
  metalDark: PALETTE.metalDark,
  metalDeep: PALETTE.metalDeep,
  // wood
  woodLit: PALETTE.woodLit,
  wood: PALETTE.wood,
  woodDark: PALETTE.woodDark,
  woodDeep: PALETTE.woodDeep,
  crate: PALETTE.crate,
  crateLit: PALETTE.crateLit,
  // urban
  brickLit: PALETTE.brickLit,
  brick: PALETTE.brick,
  brickDeep: PALETTE.brickDeep,
  plasterLit: PALETTE.plasterLit,
  plaster: PALETTE.plaster,
  plasterDeep: PALETTE.plasterDeep,
  roofRed: PALETTE.roofRed,
  roofRedDeep: PALETTE.roofRedDeep,
  // office
  carpet: PALETTE.carpet,
  carpetDeep: PALETTE.carpetDeep,
  desk: PALETTE.deskTop,
  paper: PALETTE.paper,
  // snow / rock
  snowLit: PALETTE.snowLit,
  snow: PALETTE.snow,
  snowShadow: PALETTE.snowShadow,
  snowDeep: PALETTE.snowDeep,
  ice: PALETTE.ice,
  rock: PALETTE.rockDark,
  rockDeep: PALETTE.rockDeep,
  // foliage
  leafLit: PALETTE.leafLit,
  leaf: PALETTE.leaf,
  leafDark: PALETTE.leafDark,
  leafDeep: PALETTE.leafDeep,
  cactus: PALETTE.cactus,
};

/**
 * CONTACT BAND partner (VISUAL_UPGRADE.md §1 L2a): the plinth colour for a wall
 * of this material, >= 8 L* below the material itself. `null` = already at the
 * bottom of its ladder, so `articulate()` emits no plinth.
 * Verified by `valueLadder.test.ts`.
 */
export const CONTACT_MAT: Record<MatId, MatId | null> = {
  sandLit: 'sandDark', sand: 'sandDeep', sandDark: 'sandDeep', sandDeep: null,
  dust: 'dustDeep', dustDeep: null,
  tarmac: 'tarmacDeep', tarmacDeep: null,
  concreteLit: 'concreteDark', concrete: 'concreteDeep',
  concreteDark: 'concreteDeep', concreteDeep: null,
  metalLit: 'metalDark', metal: 'metalDark', metalDark: 'metalDeep', metalDeep: null,
  woodLit: 'woodDark', wood: 'woodDeep', woodDark: 'woodDeep', woodDeep: null,
  crate: 'woodDeep', crateLit: 'woodDark',
  brickLit: 'brickDeep', brick: 'brickDeep', brickDeep: null,
  plasterLit: 'plasterDeep', plaster: 'plasterDeep', plasterDeep: null,
  roofRed: 'roofRedDeep', roofRedDeep: null,
  carpet: 'carpetDeep', carpetDeep: null,
  desk: 'woodDeep', paper: 'plasterDeep',
  snowLit: 'snowShadow', snow: 'snowDeep', snowShadow: 'snowDeep', snowDeep: null,
  ice: 'snowDeep',
  rock: 'rockDeep', rockDeep: null,
  leafLit: 'leafDark', leaf: 'leafDeep', leafDark: 'leafDeep', leafDeep: null,
  cactus: 'leafDeep',
};

/**
 * TRIM partner (VISUAL_UPGRADE.md §1 L3): cornice / mid-rail colour, >= 8 L*
 * ABOVE the material. `null` = already at the top of its ladder, so
 * `articulate()` emits no cornice. Verified by `valueLadder.test.ts`.
 */
export const TRIM_MAT: Record<MatId, MatId | null> = {
  sandLit: null, sand: 'sandLit', sandDark: 'sand', sandDeep: 'sandDark',
  dust: 'sandDark', dustDeep: 'dust',
  tarmac: 'concreteDark', tarmacDeep: 'tarmac',
  concreteLit: null, concrete: 'concreteLit',
  concreteDark: 'concrete', concreteDeep: 'concreteDark',
  metalLit: null, metal: 'metalLit', metalDark: 'metal', metalDeep: 'metalDark',
  woodLit: null, wood: 'woodLit', woodDark: 'wood', woodDeep: 'woodDark',
  crate: 'crateLit', crateLit: null,
  brickLit: null, brick: 'brickLit', brickDeep: 'brick',
  plasterLit: null, plaster: 'plasterLit', plasterDeep: 'plaster',
  roofRed: 'brickLit', roofRedDeep: 'roofRed',
  carpet: 'concreteDark', carpetDeep: 'carpet',
  desk: 'paper', paper: null,
  snowLit: null, snow: 'snowLit', snowShadow: 'snow', snowDeep: 'snowShadow',
  ice: 'snowLit',
  rock: 'concreteDark', rockDeep: 'rock',
  leafLit: null, leaf: 'leafLit', leafDark: 'leaf', leafDeep: 'leafDark',
  cactus: 'leafLit',
};

/**
 * The alternating pilaster tier (VISUAL_UPGRADE.md §3b): a step DOWN from the
 * material, so a long wall reads as rhythm rather than a flat span. Never null
 * — falls back to the material itself.
 *
 * NOTE: for 14 of the 46 entries this resolves to the SAME MatId as
 * `CONTACT_MAT` (e.g. `plaster` -> `plasterDeep`), because those families have
 * no intermediate tier. Such walls carry three values — body, trim, dark —
 * rather than four. That is accepted, not an oversight: adding a mid tier to
 * every family would double the palette for marginal gain. Do NOT assume
 * `DARK_MAT[m] !== CONTACT_MAT[m]`.
 */
export const DARK_MAT: Record<MatId, MatId> = {
  sandLit: 'sand', sand: 'sandDark', sandDark: 'sandDeep', sandDeep: 'sandDeep',
  dust: 'dustDeep', dustDeep: 'dustDeep',
  tarmac: 'tarmacDeep', tarmacDeep: 'tarmacDeep',
  concreteLit: 'concrete', concrete: 'concreteDark',
  concreteDark: 'concreteDeep', concreteDeep: 'concreteDeep',
  metalLit: 'metal', metal: 'metalDark', metalDark: 'metalDeep', metalDeep: 'metalDeep',
  woodLit: 'wood', wood: 'woodDark', woodDark: 'woodDeep', woodDeep: 'woodDeep',
  crate: 'wood', crateLit: 'crate',
  brickLit: 'brick', brick: 'brickDeep', brickDeep: 'brickDeep',
  plasterLit: 'plaster', plaster: 'plasterDeep', plasterDeep: 'plasterDeep',
  roofRed: 'roofRedDeep', roofRedDeep: 'roofRedDeep',
  carpet: 'carpetDeep', carpetDeep: 'carpetDeep',
  desk: 'wood', paper: 'plasterDeep',
  snowLit: 'snow', snow: 'snowShadow', snowShadow: 'snowDeep', snowDeep: 'snowDeep',
  ice: 'snowShadow',
  rock: 'rockDeep', rockDeep: 'rockDeep',
  leafLit: 'leaf', leaf: 'leafDark', leafDark: 'leafDeep', leafDeep: 'leafDeep',
  cactus: 'leafDark',
};

/**
 * Impact particle family per material. Lives here (not in the client) so that
 * adding a MatId cannot silently break `effects.ts` — the 26 new tiers added by
 * this upgrade would otherwise each need an implementer to guess a family.
 */
export type ImpactKind = 'dust' | 'spark' | 'snow' | 'chip' | 'leaf';

export const IMPACT_MAT: Record<MatId, ImpactKind> = {
  sandLit: 'dust', sand: 'dust', sandDark: 'dust', sandDeep: 'dust',
  dust: 'dust', dustDeep: 'dust',
  tarmac: 'dust', tarmacDeep: 'dust',
  concreteLit: 'dust', concrete: 'dust', concreteDark: 'dust', concreteDeep: 'dust',
  metalLit: 'spark', metal: 'spark', metalDark: 'spark', metalDeep: 'spark',
  woodLit: 'chip', wood: 'chip', woodDark: 'chip', woodDeep: 'chip',
  crate: 'chip', crateLit: 'chip',
  brickLit: 'dust', brick: 'dust', brickDeep: 'dust',
  plasterLit: 'dust', plaster: 'dust', plasterDeep: 'dust',
  roofRed: 'dust', roofRedDeep: 'dust',
  carpet: 'dust', carpetDeep: 'dust', desk: 'chip', paper: 'dust',
  snowLit: 'snow', snow: 'snow', snowShadow: 'snow', snowDeep: 'snow',
  ice: 'snow', rock: 'snow', rockDeep: 'snow',
  leafLit: 'leaf', leaf: 'leaf', leafDark: 'leaf', leafDeep: 'leaf', cactus: 'leaf',
};
