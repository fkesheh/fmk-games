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
  | 'plant' | 'paperStack'; // office

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
}
