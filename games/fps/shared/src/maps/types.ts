// ============================================================================
// FROZEN CONTRACT — map data format. Maps are PURE DATA consumed by:
//   server  -> collision solids + spawns
//   client  -> rendered geometry, deco prop scatter, sky/lighting theme
// All theme colors MUST be PALETTE references (import { PALETTE }).
// Coordinates: meters. x east, z south, y up. Ground plane at y=0.
// BoxDef pos = CENTER of the box; w/h/d = full extents.
// ============================================================================
import type { MapId } from '../types.js';

export type MatId =
  | 'sand' | 'sandDark' | 'concrete' | 'concreteDark'
  | 'metal' | 'metalDark' | 'wood' | 'crate'
  | 'brick' | 'plaster' | 'roofRed'
  | 'carpet' | 'desk' | 'paper'
  | 'snow' | 'ice' | 'rock'
  | 'leaf' | 'cactus';

export interface BoxDef {
  x: number; y: number; z: number; // center
  w: number; h: number; d: number; // full extents
  mat: MatId;
}

export interface SpawnPoint {
  x: number;
  z: number;
  yaw: number; // facing, same convention as input (0 = -Z/north)
}

export type DecoKind =
  | 'crate' | 'barrel' | 'pallet' | 'pipe' // industrial
  | 'rock' | 'shrub' | 'cactus' | 'snowRock' // natural
  | 'plant' | 'paperStack' // office
  // AAA richness pass (additive): stacked/field fortification variants of the
  // industrial set, frost shards, office furniture, market goods
  | 'palletStack' | 'sandbag' // industrial / military
  | 'icicle' // frost
  | 'deskChair' | 'waterCooler' // office
  | 'sack'; // market

export interface DecoZone {
  kind: DecoKind;
  count: number;
  x0: number; z0: number; x1: number; z1: number; // scatter rect
  minSpacing: number; // min distance between prop centers
}

export interface MapTheme {
  sky: string; // PALETTE hex — sky dome top
  horizon: string; // PALETTE hex — sky dome horizon
  ground: string; // PALETTE hex — ground plane tint (under floorMat overlay)
  fog: string; // PALETTE hex — MUST read as matched to sky/horizon
  fogDensity: number; // FogExp2 density (0.004..0.03)
  sunDir: [number, number, number]; // normalized-ish direction TOWARDS scene
  sunColor: string; // PALETTE hex
  sunIntensity: number; // 0.8..2.2
  hemiIntensity: number; // 0.3..2.5 (indoor/dark-albedo maps run 1.5-2.5: the hemisphere IS the light there)
}

/** AAA accent dressing: deliberate accent-color repeats (painted doors, tarps,
    hazard plates, wayfinding strips, whiteboards). Thin visual overlays baked
    by the client renderer — non-collidable, never in `boxes`. */
export interface AccentDef {
  x: number; y: number; z: number; // center
  w: number; h: number; d: number; // full extents
  hex: string; // PALETTE hex — the map's ONE deliberate accent (or family neutral)
  emissive?: boolean; // true => glow plate (lit signage); default flat
}

/** AAA skyline: silhouette landmark ring beyond the outer walls (client-only,
    non-collidable backdrop — dunes/mesas reading through the fog). */
export interface SkylineDef {
  hex: string; // PALETTE hex — body
  capHex?: string; // PALETTE hex — optional second-tier tint
  count: number; // landmarks around the ring
  minR: number; maxR: number; // ring radius band from map center (m)
  minH: number; maxH: number; // landmark height range (m)
}

export interface MapDef {
  id: MapId;
  name: string; // display name
  sizeX: number; // playable extent; outer walls expected at +/- sizeX/2
  sizeZ: number;
  floorMat: MatId; // ground plane material
  theme: MapTheme;
  boxes: BoxDef[]; // collidable + rendered
  spawns: { T: SpawnPoint[]; CT: SpawnPoint[] }; // >= 6 each
  deco: DecoZone[]; // client-only, non-collidable props
  accents?: AccentDef[]; // client-only accent overlays (optional)
  skyline?: SkylineDef; // client-only backdrop ring (optional)
}
