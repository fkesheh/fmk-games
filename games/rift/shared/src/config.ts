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
 *  from the owning team's base. Both sit on the owning team's half, so
 *  opposing towers never open fire on each other. */
export const TOWER_LANE_FRACTIONS: readonly number[] = [0.25, 0.45];
export const GUARD_FLANK_DIST = 7.51; // guards sit this far off the base diagonal
// (ancient radius 2.3 + guard radius 1.2 + STRUCTURE_MARGIN 4, + 0.01 so the
// edge-to-edge clearance clears the margin in floating point, not just decimal)
/** Lane towers stand this far off their lane polyline, perpendicular, on the
 *  side facing away from the map centre. */
export const TOWER_LANE_OFFSET = 2.5;

// --- Terrain geometry (TERRAIN_CONTRACT §3) -----------------------------------
// All of these are inputs to buildTerrain(lanes) in terrain.ts and to nothing
// else. They are metres/fractions on the frozen res = 1 grid, so a value below
// 1 m cannot be represented by a cell and is a design error, not a tuning.
/** Half-width of the `'lane'` corridor swept around each lane polyline.
 *  DESIGN_DELTA §1 "lanes stay clean, readable arenas": the corridor must hold
 *  a whole wave abreast (WAVE_MELEE 3 + WAVE_RANGED 1 at radius ~0.42) plus a
 *  hero at HERO_RADIUS passing them, and it must be wider than the visual lane
 *  ribbon so no creep ever walks on painted-looking ground. 6 m of walkable
 *  corridor also puts TOWER_LANE_OFFSET (2.5) inside the band, so the corridor
 *  stays continuous past a tower instead of pinching around it. */
export const LANE_CORRIDOR_HALF_W = 3;
/** Radius of the `'base'` high-ground disc centred on each ancient.
 *  DESIGN_DELTA §1 "the last stand is always uphill". Derived, not chosen:
 *  it must clear the guard towers' outer edge, GUARD_FLANK_DIST 7.51 +
 *  GUARD_TOWER.radius 1.2 = 8.71, and it is set to BASE_INSET - 1 = 10 so the
 *  platform plus its one-cell cliff ring exactly fills the ground between the
 *  ancient and the map edge — no wasted corner, and the ring never leaves the
 *  grid. FOUNTAIN_RADIUS (6) sits entirely inside it. */
export const BASE_PLATFORM_RADIUS = 10;
/** Full width (not half-width) of the `'river'` band along the anti-diagonal
 *  through the map centre. DESIGN_DELTA §4: the river is a landmark and a
 *  chokepoint with NO mechanic, so it must be wide enough to read as a place
 *  from the fixed 55° camera and to be named ("mid river"), yet narrow enough
 *  that crossing it is not travel time. 9 m = 1.5 lane corridors. */
export const RIVER_BAND_W = 9;
/** Width of a `'ramp'` cut through a cliff ring. TERRAIN_CONTRACT §3 requires
 *  ramp width >= the lane corridor width (2 * LANE_CORRIDOR_HALF_W = 6) at
 *  base mouths; 7 leaves a half-metre of lip on each side so a wave entering
 *  the base never brushes the cliff cells that flank the ramp. */
export const RAMP_WIDTH = 7;
/** Fraction of the JUNGLE area — cells that are neither lane corridor, base
 *  platform nor river — that buildTerrain marks `'high'`. DESIGN_DELTA §1:
 *  "the jungle between lanes carries the high-ground plateaus", so plateaus
 *  must be common enough that every jungle quadrant has one worth holding, and
 *  rare enough that TERRAIN_CONTRACT §3.4 (no passable cell walled on 3 sides)
 *  survives — past roughly a quarter coverage the cliff rings interlock and
 *  the jungle becomes a maze, which is travel time without a decision. */
export const HIGH_GROUND_COVERAGE = 0.22;
/** Fraction of the same jungle area marked `'foliage'`. DESIGN_DELTA §3:
 *  concealment exists to make ganking possible and wards worth their gold.
 *  Roughly half the plateau coverage — enough clumps that every lane has a
 *  concealed approach within one CONCEAL_REVEAL_RADIUS hop of it, not so many
 *  that the jungle is uniformly invisible and wards stop mattering. */
export const FOLIAGE_COVERAGE = 0.12;
/** Minimum distance from a camp clearing centre to EVERY lane polyline
 *  (TERRAIN_CONTRACT §3.5, validated in map.test.ts). DESIGN_DELTA §2: "a camp
 *  that can be dragged into a lane is a bug". Two derived guarantees, both of
 *  which must hold, and which is why this is 14 rather than 10:
 *    1. A camp AT REST never acquires a passing wave. A resting member sits
 *       within ~2 m of the clearing centre, so its AGGRO_RADIUS (7) reaches to
 *       14 - 2 - 7 = 5 m from the lane polyline — 2 m short of the corridor
 *       edge at LANE_CORRIDOR_HALF_W (3).
 *    2. A camp cannot be DRAGGED onto the corridor: CAMP_LEASH_RADIUS (10) is
 *       the hard cap on distance from the clearing centre, so a fully-extended
 *       member is 4 m from the polyline, still 1 m clear of the corridor, and
 *       is by definition already leashing home on that tick.
 *  The §5 exclusion of camps from `nearestEnemyMobile` for lane creeps and
 *  summons is the third, independent guard; all three are wanted, because any
 *  one of them failing alone would fail silently. */
export const CAMP_LANE_CLEARANCE = 14;

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
/** Uphill miss chance: a BASIC attack whose attacker stands on ELEV_LOW and
 *  whose target stands on ELEV_HIGH deals no damage this often. DESIGN_DELTA §1
 *  fixes this value at 0.25 — it is not a tuning knob, it is the stated rule.
 *  Abilities are unaffected, which is why TERRAIN_CONTRACT §4 puts the gate in
 *  combat.ts's fire() and not in dealDamage(). Combined with the uphill vision
 *  block, this is the "holding high ground is worth about one hero level"
 *  target: a quarter of a defender's incoming basic damage is deleted, which is
 *  roughly the effective-hp swing of one level of HeroGrowth.hp. The roll is
 *  the pure hash missRoll(tick, attacker, target) — never an RNG stream, or
 *  balance.test.ts's headless bot matches stop being reproducible. */
export const HIGH_GROUND_MISS = 0.25;

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
  moveSpeed: 3.1, bounty: 45, xp: 70, vision: 8, radius: 0.42,
};
export const CREEP_RANGED: CreepTuning = {
  hp: 300, damage: 26, armor: 0, attackPeriod: 1.1, attackRange: 8,
  moveSpeed: 3.1, bounty: 52, xp: 85, vision: 8, radius: 0.4,
};
export const CREEP_SIEGE: CreepTuning = {
  hp: 820, damage: 46, armor: 4, attackPeriod: 2.5, attackRange: 9,
  moveSpeed: 2.7, bounty: 95, xp: 105, vision: 8, radius: 0.62,
};
export const SIEGE_BUILDING_MULT = 6; // siege damage multiplier vs structures

// --- Neutral jungle camps (DESIGN_DELTA §2, TERRAIN_CONTRACT §5) ----------------
// THE DERIVATION. These are the load-bearing balance numbers of the terrain
// pass, so the arithmetic is written out: a reviewer checks the RELATIONSHIPS
// below, not the constants. Nothing here is a free parameter — every figure
// falls out of the lane economy already frozen above.
//
// (a) THE LANE, which is the thing camps are measured against. Bounty and xp are
//     flat (WAVE_GROWTH scales hp and damage only), so lane income is a constant
//     rate. One 5-wave block spans 5*WAVE_PERIOD_S = 150 s = 2.5 min and carries
//     exactly one siege (SIEGE_EVERY_NTH_WAVE):
//       normal wave = 3*45 + 1*52   =  187 g | 3*70 + 1*85   =  295 xp
//       siege wave  = 187 + 95      =  282 g | 295 + 105     =  400 xp
//       block       = 4*187 + 282   = 1030 g | 4*295 + 400   = 1580 xp
//       LANE POOL   = 1030 / 2.5    =  412 g/min | 1580 / 2.5 = 632 xp/min
//     Reference laner = one of TWO heroes sharing a lane (LANES_FOR_TEAM_SIZE
//     puts 1.7-2.7 heroes per lane across the supported team sizes) at 85%
//     uptime for travel, waves lost under tower, and deaths:
//       laner gold = 412*0.85/2 + 60*PASSIVE_GOLD_PER_S = 175 + 114 = 289 g/min
//       laner xp   = 632*0.85/2                                     = 269 xp/min
//       => XP_THRESHOLDS[6] = 1750 xp reached at 1750/269 = 6.5 min; add
//          WAVE_FIRST_AT_S and the walk out and the laner is LEVEL 6 AT ~6.8 min.
//     That is the ~6-7 min anchor DESIGN_DELTA §2 names, and everything below is
//     fitted to it.
//
// (b) THE JUNGLER. Reference is a melee carry sustaining 95 raw dps (autos plus
//     amortised abilities around level 4-6) and 10 s of travel between camps.
//     Camp armour bites via ARMOR_K: reduction = 0.06a/(1+0.06a).
//       pack  a=1 ->  5.7% -> 89.6 dps -> 4*240 =  960 hp -> 10.7 s
//       brute a=4 -> 19.4% -> 76.6 dps -> 3*470 = 1410 hp -> 18.4 s
//       hive  a=0 ->  0.0% -> 95.0 dps -> 5*300 = 1500 hp -> 15.8 s
//     A 4-camp half (pack, pack, brute, hive — see CAMPS_PER_HALF) is one lap:
//       lap  = 55.6 s clearing + 4*10 s travel = 95.6 s = 1.593 min
//       gold = 76 + 76 + 132 + 115 = 399  -> 399/1.593 = 250 g/min
//       xp   = 84 + 84 + 141 + 120 = 429  -> 429/1.593 = 269 xp/min
//     => jungler xp 269/min vs laner xp 269/min: LEVEL 6 AT ~6.8 min for both,
//        which is DESIGN_DELTA §2's "roughly the same time".
//     => jungler gold 250 + 114 passive = 364 g/min vs laner 289 g/min: MORE
//        GOLD, +26%. The two axes split exactly as the design asks, because the
//        jungler eats 100% of a smaller pool while the laner splits a larger one.
//     (Sensitivity: at 8 s hops the lap is 91.6 s and level 6 lands at 6.5 min —
//      still inside the band, so the target does not hinge on the travel guess.)
//
// (c) THE POOL MUST STAY SMALLER THAN THE LANE'S. Production per half is
//     camp value / respawn, i.e. what the jungle yields if cleared on cooldown
//     forever:
//       gold: 2*(76/45) + 132/75 + 115/95 = 6.35 g/s   = 381 g/min
//       xp:   2*(84/45) + 141/75 + 120/95 = 6.88 xp/s  = 413 xp/min
//     against a 3-lane half's 3*412 = 1236 g/min and 3*632 = 1896 xp/min:
//       jungle is 31% of lane GOLD and 22% of lane XP. Both below (DESIGN_DELTA
//       §2), and gold-weighted relative to xp — which is the same statement as
//       the per-unit ratio: camps pay g/xp ~0.90-0.96 where wave creeps pay
//       0.63. A camp is ~1.5x more gold-per-experience than a lane creep, and
//       that single ratio is what makes jungling a tempo choice, not an upgrade.
//     The tightest case is 1 lane, where 2 camps produce 207 g/min against one
//     lane's 412 g/min — still below, by design, with the least margin.
//     Also per DESIGN_DELTA §2: the richest single camp cleared the instant it
//     respawns forever yields 132/75*60 = 106 g/min, so 106 + 114 passive =
//     220 g/min < the laner's 289 g/min. No camp is free money.
//
// (d) THE HIVE MUST BE DANGEROUS SOLO BEFORE 6. Five ranged bodies put out
//     5*26/1.0 = 130 raw dps at full strength, ~65 averaged over a clear as they
//     die one by one, ~55 after a hero's typical armour 3:
//       level 4 (~874 hp, ~76 dps): 19.7 s clear, 1084 incoming -> DIES
//       level 6 (~1030 hp, ~120 dps with items): 12.5 s, 688 incoming -> lives at ~a third
//       level 8 (~1186 hp, ~165 dps with items): 9.1 s, 500 incoming -> comfortable
//     which is exactly "attemptable at 6, comfortable at 8". The brute is the
//     mid-cost camp (~497 incoming on an 18.4 s clear: half a level-5 hero's hp,
//     a real cost rather than a threat) and the pack is the entry camp (~300
//     incoming, ~38% of a level-3 hero).
//
// ONE STATLINE PER TIER. EntKind gains exactly campPack/campBrute/campHive and
// buildCamp(tier) returns exactly one UnitBuild per tier, so a camp's members
// all share the tuning below; DESIGN_DELTA's "one heavy brute plus escorts" is
// silhouette variation inside buildCamp, not a second statline. A per-member
// statline would double the balance surface for no gameplay the count does not
// already express.

/** Small quadruped pack — the entry camp. Fast, fragile, low individual value;
 *  clearable from level 2-3, which is what stops the jungle from being a
 *  level-6 gate. bounty:xp = 0.90, well above the lane's 0.63. */
export const CAMP_PACK: CreepTuning = {
  hp: 240, damage: 14, armor: 1, attackPeriod: 1.15, attackRange: 1.4,
  moveSpeed: 3.4, bounty: 19, xp: 21, vision: 7, radius: 0.38,
};
/** Heavy melee brutes — the mid camp and the jungle's best gold rate. Armoured
 *  (4) and slow (2.9), so it punishes low-damage heroes and can be kited but
 *  never outrun into a lane; see CAMP_LEASH_RADIUS. */
export const CAMP_BRUTE: CreepTuning = {
  hp: 470, damage: 30, armor: 4, attackPeriod: 1.4, attackRange: 1.9,
  moveSpeed: 2.9, bounty: 44, xp: 47, vision: 7, radius: 0.7,
};
/** Ranged swarm — the large camp. Unarmoured and individually weak, but five
 *  bodies at 7.5 m range means the damage arrives whether or not the hero is in
 *  contact, and that is the whole reason it is dangerous before level 6 (see
 *  derivation (d)). Killing members individually is the counterplay. */
export const CAMP_HIVE: CreepTuning = {
  hp: 300, damage: 26, armor: 0, attackPeriod: 1.0, attackRange: 7.5,
  moveSpeed: 2.8, bounty: 23, xp: 24, vision: 7, radius: 0.4,
};

/** Members spawned per camp; the camp respawns whole. Camp totals are therefore
 *  pack 960 hp / 76 g / 84 xp, brute 1410 / 132 / 141, hive 1500 / 115 / 120. */
export const CAMP_PACK_COUNT = 4;
export const CAMP_BRUTE_COUNT = 3;
export const CAMP_HIVE_COUNT = 5;

/** Seconds from the death of a camp's LAST member to the camp respawning whole.
 *  Staggered so camp timing is a thing worth tracking (DESIGN_DELTA §2) and so
 *  the three tiers drift in and out of phase rather than all coming up together.
 *  All three are below the 95.6 s reference lap of derivation (b), so a jungler
 *  is never idle, and the lap consumes only ~65% of the half's production —
 *  headroom for a second hero to dip in without starving the jungler. */
export const CAMP_PACK_RESPAWN_S = 45;
export const CAMP_BRUTE_RESPAWN_S = 75;
export const CAMP_HIVE_RESPAWN_S = 95;

/** Hard cap on a camp member's distance from its clearing centre. Beyond it the
 *  member returns to the clearing and restores to full hp on arrival. Set above
 *  AGGRO_RADIUS (7) so a member can actually reach what it acquired instead of
 *  ping-ponging at the boundary, and well below CAMP_LANE_CLEARANCE (14) so a
 *  fully-extended camp is still 4 m clear of any lane polyline — DESIGN_DELTA
 *  §2's "a camp that can be dragged into a lane is a bug". */
export const CAMP_LEASH_RADIUS = 10;

/** Camps per team half, indexed by LANE COUNT (index 0 unused; MAX_LANES = 3).
 *  DESIGN_DELTA §2 fixes 2/3/4 — camp count scales with the map exactly as
 *  every other structure does, so per-half jungle density is roughly constant
 *  as the map grows and the lane:jungle income ratio of derivation (c) holds at
 *  every team size. Tier allocation is terrain.ts's to place, and is the one
 *  derivation (b) and (c) assume: 4 -> pack, pack, brute, hive; 3 -> pack,
 *  brute, hive; 2 -> pack, brute (the smallest map drops the large camp, which
 *  needs the most clearing room and the most hero levels to be a decision). */
export const CAMPS_PER_HALF: readonly number[] = [0, 2, 3, 4];

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
  hp: 3300, armor: 18, damage: 150, attackPeriod: 1.0, attackRange: 10.5,
  vision: 12, radius: 1.2, bounty: 200,
};
export const GUARD_TOWER: StructureTuning = {
  hp: 1100, armor: 12, damage: 150, attackPeriod: 1.0, attackRange: 10.5,
  vision: 12, radius: 1.2, bounty: 250,
};
export const ANCIENT = {
  hp: 1700, armor: 10, vision: 12, radius: 2.3,
} as const;
/** An ancient is INVULNERABLE while any of its team's guard towers stands. */
export const FOUNTAIN_RADIUS = 6; // centred on own ancient
export const FOUNTAIN_HEAL_PCT = 0.06; // fraction of max hp per second
export const FOUNTAIN_MANA_PCT = 0.06;

// --- Heroes: shared curve ---------------------------------------------------------
export const LEVEL_CAP = 10;
/** Cumulative xp required to BE each level; index = level (0 unused). */
export const XP_THRESHOLDS: readonly number[] = [
  0, 0, 200, 510, 930, 1300, 1750, 2860, 3750, 4780, 5960,
];
export const SKILL_POINTS_PER_LEVEL = 1;
export const STARTING_SKILL_POINTS = 1; // heroes spawn with 1 point at level 1
export const BASIC_ABILITY_MAX_RANK = 4;
export const ULT_MAX_RANK = 2;
/** Hero level required to put a point into ult rank (index = rank-1). */
export const ULT_LEVEL_REQ: readonly number[] = [6, 10];
export const XP_SHARE_RADIUS = 20; // creep death xp splits among heroes in range
export const HERO_KILL_XP_BASE = 120;
export const HERO_KILL_XP_PER_LEVEL = 40;
export const RESPAWN_BASE_S = 3;
export const RESPAWN_PER_LEVEL_S = 3.5;
export const HERO_VISION = 11;
export const HERO_RADIUS = 0.5;
export const STARTING_GOLD = 600;
export const PASSIVE_GOLD_PER_S = 1.9;
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
/** A unit standing on a `'foliage'` cell is hidden from enemies farther away
 *  than this, unless the watcher is itself concealed, is looking down from
 *  ELEV_HIGH, or the target attacked last tick. DESIGN_DELTA §3 words the
 *  exception as "unless the enemy is adjacent", so this is deliberately short:
 *  it sits above every melee attackRange in the roster (1.7-1.9) so a melee
 *  hero in contact always sees what it is hitting, and well below AGGRO_RADIUS
 *  (7) and WARD_VISION (9) so stepping into a bush genuinely breaks a chase and
 *  a ward genuinely un-breaks it — that ward/gank relationship IS the balance
 *  target, and if this number approaches WARD_VISION the feature does nothing. */
export const CONCEAL_REVEAL_RADIUS = 4;
/** Night multiplier on the vision radius of HEROES and CREEPS only; wards,
 *  towers, guards and ancients are lit and unaffected (DESIGN_DELTA §5).
 *  "Roughly a quarter" reduction: HERO_VISION 11 -> 8.25, creep vision 8 -> 6.
 *  Note 8.25 stays above WARD_VISION*0.75 territory and above CONCEAL_REVEAL —
 *  night shifts initiative toward the jungler and the roamer, it must never
 *  become a blackout that stops people playing. */
export const NIGHT_VISION_MULT = 0.75;
/** Seconds for one full day+night cycle, derived from matchTick alone and
 *  starting at full day. TERRAIN_CONTRACT §6 fixes 600: the §9 match-duration
 *  band puts a typical game around two cycles — long enough that a night is a
 *  phase you plan wards for (WARD_DURATION_S 90 is well inside one), short
 *  enough that most matches see night at all, and far from the strobing you get
 *  if the period approaches WAVE_PERIOD_S. `rift_snap.dayPhase` carries the
 *  0 = day / 1 = night phase so a reconnecting client's lighting is correct. */
export const DAY_PERIOD_S = 600;

/** The day/night phase at a given match tick: 0 = full day, 1 = full night.
 *
 *  AMENDMENT_1 §B.1 hoisted this out of vision.ts. It is the SINGLE definition
 *  of the cycle — `sim/vision.ts` scales vision by it and `room.ts` puts it on
 *  the wire as `rift_snap.dayPhase`, and they MUST call this same function.
 *  They were about to derive it independently, and BUILD_SPECS had handed
 *  room.ts a sawtooth (`(t / TICK_RATE / DAY_PERIOD_S) % 1`) while protocol.ts
 *  freezes dayPhase as a wrapping TRIANGLE. Near a cycle boundary the sawtooth
 *  reads 0.99 where the triangle reads 0.02: the client would have rendered
 *  full day while the server ran full night.
 *
 *  Triangle, not sawtooth, because the value is a physical phase that must be
 *  continuous across the wrap — a sawtooth's 1 -> 0 jump would snap every
 *  light and every vision radius in the game in a single tick. */
export function dayPhase(matchTick: number): number {
  const cycle = DAY_PERIOD_S * TICK_RATE;
  const t = ((matchTick % cycle) + cycle) % cycle; // non-negative even pre-start
  const half = cycle / 2;
  return t < half ? t / half : 2 - t / half;
}

/** Vision multiplier at a given day phase — a SMOOTH RAMP from 1 at full day to
 *  NIGHT_VISION_MULT at full night.
 *
 *  AMENDMENT_1 §C ratifies the ramp and amends TERRAIN_CONTRACT §4.3, which had
 *  written this as a boolean snap. A boolean `night` is undefined against a
 *  dayPhase that protocol.ts freezes as continuous, and a snap would pop every
 *  unit's vision radius by 25% in one tick at the threshold.
 *
 *  Applies to heroes and creeps (including camp creeps) ONLY. Wards, towers,
 *  guards and ancients are lit and keep full radius — see NIGHT_VISION_MULT. */
export function nightVisionScale(phase: number): number {
  const p = phase < 0 ? 0 : phase > 1 ? 1 : phase;
  return 1 - (1 - NIGHT_VISION_MULT) * p;
}

// --- Match arc ----------------------------------------------------------------------
export const OVERTIME_AT_S = 660; // 11:00 — surge begins (measured: 1200 pushes the duration median past the §9 band)
export const SURGE_WAVE_GROWTH = 0.11; // replaces WAVE_GROWTH in overtime
export const SURGE_EXTRA_MELEE_PERIOD_S = 600; // +1 melee per wave per elapsed period of OT
// (slow by design: the unit flood at 60s broke the §10 2ms tick budget — surge
// growth, not unit count, carries the anti-sprawl)
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
