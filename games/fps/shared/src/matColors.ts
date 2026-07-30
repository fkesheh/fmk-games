// ============================================================================
// FROZEN CONTRACT — MatId -> PALETTE hex. Moved here from the client's
// mapRenderer.ts so that map authors (who add MatIds) and the renderer author
// (who consumes them) never contend for the same file.
//
// Every MatId resolves to a PALETTE entry. Adding a MatId means adding a row
// here AND to the `MatId` union in maps/types.ts. Nothing else may map colours.
// See VISUAL_UPGRADE.md §1 for which tiers belong on floors vs walls vs
// contact bands.
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
  // snow
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
  cactus: PALETTE.cactus,
};

/**
 * The CONTACT BAND partner for each MatId (VISUAL_UPGRADE.md §1 L2).
 * `articulate()` and the prop builders use this to pick a plinth colour, so no
 * implementer ever has to choose one. Every wall base and prop base wears one.
 */
export const CONTACT_MAT: Record<MatId, MatId> = {
  sandLit: 'sandDeep', sand: 'sandDeep', sandDark: 'sandDeep', sandDeep: 'sandDeep',
  dust: 'dustDeep', dustDeep: 'dustDeep',
  tarmac: 'tarmacDeep', tarmacDeep: 'tarmacDeep',
  concreteLit: 'concreteDeep', concrete: 'concreteDeep',
  concreteDark: 'concreteDeep', concreteDeep: 'concreteDeep',
  metalLit: 'metalDeep', metal: 'metalDeep', metalDark: 'metalDeep', metalDeep: 'metalDeep',
  woodLit: 'woodDeep', wood: 'woodDeep', woodDark: 'woodDeep', woodDeep: 'woodDeep',
  crate: 'woodDeep', crateLit: 'woodDeep',
  brickLit: 'brickDeep', brick: 'brickDeep', brickDeep: 'brickDeep',
  plasterLit: 'plasterDeep', plaster: 'plasterDeep', plasterDeep: 'plasterDeep',
  roofRed: 'roofRedDeep', roofRedDeep: 'roofRedDeep',
  carpet: 'carpetDeep', carpetDeep: 'carpetDeep',
  desk: 'woodDeep', paper: 'plasterDeep',
  snowLit: 'snowDeep', snow: 'snowDeep', snowShadow: 'snowDeep', snowDeep: 'snowDeep',
  ice: 'snowDeep',
  rock: 'rockDeep', rockDeep: 'rockDeep',
  leafLit: 'leaf', leaf: 'leafDark', leafDark: 'leafDark', cactus: 'leafDark',
};

/**
 * The TRIM partner for each MatId (VISUAL_UPGRADE.md §1 L3) — cornices and
 * sun-hit detail sit >= 8 L* above the surface they trim.
 */
export const TRIM_MAT: Record<MatId, MatId> = {
  sandLit: 'sandLit', sand: 'sandLit', sandDark: 'sand', sandDeep: 'sandDark',
  dust: 'sandDark', dustDeep: 'dust',
  tarmac: 'concreteDark', tarmacDeep: 'tarmac',
  concreteLit: 'concreteLit', concrete: 'concreteLit',
  concreteDark: 'concrete', concreteDeep: 'concreteDark',
  metalLit: 'metalLit', metal: 'metalLit', metalDark: 'metal', metalDeep: 'metalDark',
  woodLit: 'woodLit', wood: 'woodLit', woodDark: 'wood', woodDeep: 'woodDark',
  crate: 'crateLit', crateLit: 'crateLit',
  brickLit: 'brickLit', brick: 'brickLit', brickDeep: 'brick',
  plasterLit: 'plasterLit', plaster: 'plasterLit', plasterDeep: 'plaster',
  roofRed: 'brickLit', roofRedDeep: 'roofRed',
  carpet: 'concreteDark', carpetDeep: 'carpet',
  desk: 'crateLit', paper: 'plasterLit',
  snowLit: 'snowLit', snow: 'snowLit', snowShadow: 'snow', snowDeep: 'snowShadow',
  ice: 'snowLit',
  rock: 'concreteDark', rockDeep: 'rock',
  leafLit: 'leafLit', leaf: 'leafLit', leafDark: 'leaf', cactus: 'leafLit',
};
