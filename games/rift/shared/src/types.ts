// ============================================================================
// ANCIENTS (rift) — TYPES. Every cross-module and on-the-wire shape. Types
// only; no logic — the single exception is `isPlayerTeam`, a narrowing guard
// that must live beside the type it narrows. Frozen: implementers fill bodies,
// never alter these.
// ============================================================================
import type { HeroId } from './hero.js';
import type { ItemId } from './item.js';
import type { TerrainDef } from './terrain.js';

/** A PLAYER team. Stays `0 | 1` forever: it indexes the two-element per-team
 *  tuples the whole game is built on (scores, fountains, ancients, vision
 *  sets, ward stock) and it is the domain of the board, the roster, the kill
 *  tuple, structures and the tiebreak. Widening it is a contract change. */
export type TeamId = 0 | 1;

/** The third team: neutral jungle camps (TERRAIN_CONTRACT §5). Not a player
 *  team — it owns no base, no fountain, no score and no seat, and it never
 *  appears in a roster, a board row, a structure or a match result. */
export const NEUTRAL_TEAM = 2;

/** The team of an ENTITY, as opposed to the team of a player. Entities may be
 *  neutral; players, structures and board rows may not.
 *
 *  **Narrowing obligation.** Several structures in the sim and the client are
 *  two-element tuples/arrays/Records indexed by an entity's team — `visSets`,
 *  `wardStockArr`, `ancientId`/`ancientX`/`ancientZ`, `kills`, `fountainX`/`Z`,
 *  `TEAM_COLOUR`, `TEAM_MARKER`. Indexing any of them with `NEUTRAL_TEAM` is an
 *  out-of-bounds read that produces `undefined` (or worse, silently wrong data
 *  on a typed array) at runtime.
 *
 *  > **Every site that indexes a per-team tuple, array or `Record` with an
 *  > entity's `team` MUST narrow with `isPlayerTeam` first.** No exceptions,
 *  > no non-null assertions, no `as TeamId` casts. If the neutral case is
 *  > impossible at a site, prove it with the guard and handle the else branch
 *  > explicitly — that branch is the documentation. */
export type EntTeam = TeamId | 2;

/** The narrowing guard for {@link EntTeam}. True for the two player teams,
 *  false for `NEUTRAL_TEAM`. This is the ONLY sanctioned way to go from
 *  `EntTeam` to `TeamId`. */
export function isPlayerTeam(t: EntTeam): t is TeamId {
  return t === 0 || t === 1;
}

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
  /** `TeamId`, not `EntTeam`: a structure always belongs to a player team.
   *  There are no neutral towers, guards or ancients. */
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
  /** Cliffs, ramps, river, foliage and the neutral camps — the same pure
   *  function of the lane count as everything else here, so server and client
   *  compute it independently and agree bit-for-bit (TERRAIN_CONTRACT §1).
   *
   *  REQUIRED, never optional (TERRAIN_CONTRACT §2): `exactOptionalPropertyTypes`
   *  makes an optional field awkward at every consumer, and a silently absent
   *  terrain yields a match with no cliffs and no camps — a failure that hides.
   *  Every `MapDef` object literal, including those in tests, supplies it. */
  readonly terrain: TerrainDef;
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
  | 'proj'
  // Neutral jungle camps, one kind per tier (TERRAIN_CONTRACT §5). Always
  // team === NEUTRAL_TEAM, always lane === -1, always owner === NO_ENT.
  | 'campPack'
  | 'campBrute'
  | 'campHive';

/** One entity in a snapshot. Structures are sent to every client every tick
 *  (they are static objectives — position/alive/hp is public knowledge).
 *  Mobile units are fog-filtered per team. Optional fields are per-kind:
 *  lvl/hero/pid for heroes; tx/tz + fx for 'proj'. */
export interface EntSnap {
  id: number;
  k: EntKind;
  /** `EntTeam`: a camp entity carries `NEUTRAL_TEAM`. Anything that indexes a
   *  per-team structure with this — marker colour, minimap glyph, kill credit —
   *  narrows with `isPlayerTeam` first. */
  team: EntTeam;
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
  /** `TeamId`: a seat is always on a player team. */
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
  /** `TeamId`: a board row is always a player seat. */
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
  /** `TeamId`: a stats row is always a player seat. */
  team: TeamId;
  kills: number;
  deaths: number;
  assists: number;
  goldEarned: number;
  heroDamage: number;
  structureDamage: number;
}
