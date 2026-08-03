// ============================================================================
// ANCIENTS (rift) — CONFIG. Every gameplay number lives here. PURE DATA: no
// logic, no functions, no derived computation beyond literal arithmetic on
// other entries in this file. Balance changes happen HERE, never in sim code.
// All distances in metres, times in seconds, rates per second. Tick-domain
// values derive from TICK_DT. See games/rift/CONTRACT.md for semantics.
// ============================================================================

// --- Clock -------------------------------------------------------------------
export const TICK_RATE = 20; // sim + snapshot rate (handoff §2.6)
export const TICK_DT = 1 / TICK_RATE;

// --- Players, teams, lobby ----------------------------------------------------
export const MIN_PLAYERS = 1; // one human + bot fill is a valid match
export const MAX_PLAYERS = 16; // 8v8
export const MIN_TEAM_SIZE = 2;
export const MAX_TEAM_SIZE = 8;
export const LOBBY_COUNTDOWN_MS = 3_000;
export const MATCH_END_MS = 20_000; // ended phase dwell before reset to lobby
/** Indexed by team size (2..8); entry = lane count. Handoff §2.2 — do NOT
 *  decouple lanes from team size; per-lane income is what keeps big matches
 *  from sprawling. */
export const LANES_FOR_TEAM_SIZE: readonly number[] = [0, 0, 1, 2, 2, 3, 3, 3, 3];
export const MIN_LANES = 1;
export const MAX_LANES = 3;

// --- Map geometry -------------------------------------------------------------
export const MAP_SIDE_BASE = 96; // side length at 1 lane
export const MAP_SIDE_PER_LANE = 16; // side = BASE + PER_LANE * (lanes - 1)
export const BASE_INSET = 11; // ancient distance from its corner on the diagonal
export const LANE_EDGE_INSET = 13; // side-lane waypoint distance from map edges
export const STRUCTURE_MARGIN = 4; // min clearance between any two structures
export const TOWERS_PER_LANE = 2; // per team per lane
export const ANCIENT_GUARDS = 2; // per team, flanking the ancient
/** Tower positions along a lane path, as fraction of path length measured
 *  from the owning team's base. */
export const TOWER_LANE_FRACTIONS: readonly number[] = [0.3, 0.62];
export const GUARD_FLANK_DIST = 7.5; // guards sit this far off the base diagonal
// (ancient radius 2.3 + guard radius 1.2 + STRUCTURE_MARGIN 4 = 7.5 exactly)
/** Lane towers stand this far off their lane polyline, perpendicular, on the
 *  side facing away from the map centre. */
export const TOWER_LANE_OFFSET = 2.5;

// --- Combat model ---------------------------------------------------------------
export const ARMOR_K = 0.06; // phys reduction = K*armor / (1 + K*|armor|)
export const HERO_MAGIC_RESIST = 0.25; // all heroes, flat
export const AGGRO_RADIUS = 7; // creep/tower acquire radius
export const TOWER_HERO_AGGRO_WINDOW_S = 3; // tower switches to a hero that
// damaged an allied hero within its range in the last this-many seconds
/** Fortify: structures take reduced hero damage while no enemy creep is near.
 *  The anti-backdoor rule; without it walking past creeps wins every game. */
export const FORTIFY_RADIUS = 11;
export const FORTIFY_HERO_DAMAGE_MULT = 0.35;

// --- Creeps ---------------------------------------------------------------------
export const WAVE_FIRST_AT_S = 10;
export const WAVE_PERIOD_S = 30;
export const WAVE_GROWTH = 0.02; // +2% hp & damage per wave, compounding
export const SIEGE_EVERY_NTH_WAVE = 5;
export const WAVE_MELEE = 3;
export const WAVE_RANGED = 1;

export interface CreepTuning {
  readonly hp: number;
  readonly damage: number;
  readonly armor: number;
  readonly attackPeriod: number;
  readonly attackRange: number;
  readonly moveSpeed: number;
  readonly bounty: number;
  readonly xp: number;
  readonly vision: number;
  readonly radius: number;
}
export const CREEP_MELEE: CreepTuning = {
  hp: 450, damage: 21, armor: 2, attackPeriod: 1.25, attackRange: 1.3,
  moveSpeed: 3.1, bounty: 45, xp: 40, vision: 8, radius: 0.42,
};
export const CREEP_RANGED: CreepTuning = {
  hp: 300, damage: 26, armor: 0, attackPeriod: 1.1, attackRange: 8,
  moveSpeed: 3.1, bounty: 52, xp: 50, vision: 8, radius: 0.4,
};
export const CREEP_SIEGE: CreepTuning = {
  hp: 820, damage: 46, armor: 4, attackPeriod: 2.5, attackRange: 9,
  moveSpeed: 2.7, bounty: 95, xp: 90, vision: 8, radius: 0.62,
};
export const SIEGE_BUILDING_MULT = 3; // siege damage multiplier vs structures

// --- Structures -------------------------------------------------------------------
export interface StructureTuning {
  readonly hp: number;
  readonly armor: number;
  readonly damage: number;
  readonly attackPeriod: number;
  readonly attackRange: number;
  readonly vision: number;
  readonly radius: number;
  readonly bounty: number; // team gold, each living enemy hero, 0 = none
}
export const TOWER: StructureTuning = {
  hp: 1400, armor: 8, damage: 110, attackPeriod: 1.0, attackRange: 10.5,
  vision: 12, radius: 1.2, bounty: 200,
};
export const GUARD_TOWER: StructureTuning = {
  hp: 1600, armor: 10, damage: 130, attackPeriod: 1.0, attackRange: 10.5,
  vision: 12, radius: 1.2, bounty: 250,
};
export const ANCIENT = {
  hp: 2600, armor: 10, vision: 12, radius: 2.3,
} as const;
/** An ancient is INVULNERABLE while any of its team's guard towers stands. */
export const FOUNTAIN_RADIUS = 6; // centred on own ancient
export const FOUNTAIN_HEAL_PCT = 0.06; // fraction of max hp per second
export const FOUNTAIN_MANA_PCT = 0.06;

// --- Heroes: shared curve ---------------------------------------------------------
export const LEVEL_CAP = 10;
/** Cumulative xp required to BE each level; index = level (0 unused).
 *  To-next = 100 + (level-1)*60. */
export const XP_THRESHOLDS: readonly number[] = [
  0, 0, 200, 510, 930, 1460, 2100, 2860, 3750, 4780, 5960,
];
export const SKILL_POINTS_PER_LEVEL = 1;
export const STARTING_SKILL_POINTS = 1; // heroes spawn with 1 point at level 1
export const BASIC_ABILITY_MAX_RANK = 4;
export const ULT_MAX_RANK = 2;
/** Hero level required to put a point into ult rank (index = rank-1). */
export const ULT_LEVEL_REQ: readonly number[] = [6, 10];
export const XP_SHARE_RADIUS = 12; // creep death xp splits among heroes in range
export const HERO_KILL_XP_BASE = 120;
export const HERO_KILL_XP_PER_LEVEL = 40;
export const RESPAWN_BASE_S = 6;
export const RESPAWN_PER_LEVEL_S = 3;
export const HERO_VISION = 11;
export const HERO_RADIUS = 0.5;
export const STARTING_GOLD = 600;
export const PASSIVE_GOLD_PER_S = 1.2;
export const KILL_GOLD_BASE = 150;
export const KILL_GOLD_PER_LEVEL = 15;
export const FIRST_BLOOD_BONUS = 100;
export const ASSIST_GOLD = 80; // split among non-killer damagers
export const ASSIST_WINDOW_S = 8;
export const INVENTORY_SLOTS = 6;
/** Regen stats on HeroDef are per-second. Attack projectiles do not exist for
 *  basic attacks: ranged attacks land instantly (no dodge mechanics in v1);
 *  the client renders a tracer. Ability projectiles DO exist (sim entities). */

// --- Vision ---------------------------------------------------------------------
export const WARD_VISION = 9;
export const WARD_DURATION_S = 90;
export const WARD_PLACE_RANGE = 5;
export const WARD_TEAM_STOCK = 2; // max charges a team can hold
export const WARD_RESTOCK_S = 120; // +1 team stock per interval
/** Structures are always visible to everyone (position/alive/hp) — only mobile
 *  units are fog-filtered. Wards are visible to their own team only. */

// --- Match arc ----------------------------------------------------------------------
export const OVERTIME_AT_S = 1_200; // 20:00 — surge begins
export const SURGE_WAVE_GROWTH = 0.06; // replaces WAVE_GROWTH in overtime
export const SURGE_EXTRA_MELEE_PERIOD_S = 60; // +1 melee per wave per elapsed minute of OT
export const MATCH_HARD_CAP_S = 1_800; // 30:00 — tiebreak end
/** Tiebreak order at hard cap: 1) ancient hp fraction 2) structures standing
 *  3) hero kills 4) team gold earned. Still equal -> draw (winner null). */

// --- Summons --------------------------------------------------------------------
export const SUMMON_SHADE: CreepTuning = {
  hp: 200, damage: 30, armor: 0, attackPeriod: 1.0, attackRange: 1.5,
  moveSpeed: 5.6, bounty: 20, xp: 20, vision: 8, radius: 0.4,
};
export const SUMMON_MAX_ACTIVE = 6; // per hero, oldest expires first

// --- Wire limits (parser clamps; never trust a client) ---------------------------
export const MAP_COORD_MAX = 200; // |x|,|z| accepted in orders/casts
export const MAX_NAME_LEN = 16; // platform already enforces; restated for parsers

// --- Room identity ---------------------------------------------------------------
export const ROOM_ID_LEN = 8;
export const ROOM_CODE_LEN = 5;
export const ROOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
