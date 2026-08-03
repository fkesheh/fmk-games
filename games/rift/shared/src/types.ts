// ============================================================================
// ANCIENTS (rift) — TYPES. Every cross-module and on-the-wire shape. Types
// only; no logic. Frozen: implementers fill bodies, never alter these.
// ============================================================================
import type { HeroId } from './hero.js';
import type { ItemId } from './item.js';

export type TeamId = 0 | 1;
export type Phase = 'lobby' | 'live' | 'ended';

export interface Vec2 {
  readonly x: number;
  readonly z: number;
}

// --- Map (built deterministically by shared/src/map.ts from the lane count) ---
export type StructureKind = 'tower' | 'guard' | 'ancient';

export interface StructureDef {
  /** Stable id; the sim uses it directly as the entity id for the structure. */
  readonly id: number;
  readonly kind: StructureKind;
  readonly team: TeamId;
  /** Lane index for lane towers; null for guards and ancients. */
  readonly lane: number | null;
  readonly x: number;
  readonly z: number;
}

export interface MapDef {
  readonly lanes: number;
  readonly side: number;
  /** Waypoint polylines per lane, team 0 base -> team 1 base. Team 1 creeps
   *  walk the same polyline reversed. */
  readonly paths: readonly (readonly Vec2[])[];
  readonly structures: readonly StructureDef[];
}

export interface MapValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

// --- Entities on the wire -------------------------------------------------------
export type EntKind =
  | 'hero'
  | 'melee'
  | 'ranged'
  | 'siege'
  | 'shade'
  | 'tower'
  | 'guard'
  | 'ancient'
  | 'ward'
  | 'proj';

/** One entity in a snapshot. Structures are sent to every client every tick
 *  (they are static objectives — position/alive/hp is public knowledge).
 *  Mobile units are fog-filtered per team. Optional fields are per-kind:
 *  lvl/hero/pid for heroes; tx/tz + fx for 'proj'. */
export interface EntSnap {
  id: number;
  k: EntKind;
  team: TeamId;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  lvl?: number;
  hero?: HeroId;
  pid?: string;
  tx?: number;
  tz?: number;
  /** For 'proj': the ability effect payload tag so the client can colour it. */
  fx?: string;
  /** Target of this unit's most recent basic attack (drives client tracers);
   *  omitted when the unit has not attacked since the previous snapshot. */
  atk?: number;
}

/** The owning player's full private state, every snapshot. All tick fields
 *  (cdUntilTick, respawnAtTick, itemCdUntilTick) are in the MATCH-TICK domain
 *  — compare against rift_snap.matchTick, never against snap.tick drift. */
export interface YouSnap {
  hero: HeroId;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  level: number;
  xp: number;
  gold: number;
  kills: number;
  deaths: number;
  assists: number;
  skillPoints: number;
  /** Tick at which the hero respawns; 0 while alive. */
  respawnAtTick: number;
  /** 4 entries, slot order q/w/e/r. */
  abilities: readonly AbilitySnap[];
  /** 6 inventory slots. */
  items: readonly (ItemId | null)[];
  itemCharges: readonly number[];
  itemCdUntilTick: readonly number[];
}

export interface AbilitySnap {
  rank: number;
  cdUntilTick: number;
}

// --- Roster / lobby ---------------------------------------------------------------
export interface RosterEntry {
  id: string;
  name: string;
  team: TeamId;
  bot: boolean;
  connected: boolean;
  pick: HeroId | null;
}

// --- Settings ----------------------------------------------------------------------
export interface RiftSettings {
  /** 2..8; 0 or omitted = auto (smallest even split that seats every human,
   *  clamped to [MIN_TEAM_SIZE, MAX_TEAM_SIZE]). Locks at match start. */
  readonly teamSize?: number;
  /** Sim speed multiplier, 1..20. Dev/test hook (e2e, balance harness). */
  readonly speed?: number;
}

/** Live scoreboard row — one per seat, sent in every rift_snap so the TAB
 *  overlay and team kill score are authoritative (reconnect-safe, unlike
 *  accumulating rift_kill events). */
export interface BoardEntry {
  id: string;
  hero: HeroId;
  team: TeamId;
  level: number;
  kills: number;
  deaths: number;
  assists: number;
  bot: boolean;
  connected: boolean;
}

// --- Match end ----------------------------------------------------------------------
export type EndReason = 'ancient' | 'tiebreak' | 'draw';

export interface PlayerStats {
  id: string;
  name: string;
  hero: HeroId;
  team: TeamId;
  kills: number;
  deaths: number;
  assists: number;
  goldEarned: number;
  heroDamage: number;
  structureDamage: number;
}
