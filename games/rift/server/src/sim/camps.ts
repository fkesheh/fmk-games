// ============================================================================
// ANCIENTS (rift) — NEUTRAL JUNGLE CAMPS (TERRAIN_CONTRACT §5, DESIGN_DELTA §2).
// advance() step (7), inserted between stepDeaths and stepUnits so a camp sees
// this tick's deaths and can stamp its respawn on the same tick its last member
// falls.
//
// This module owns camp STATE and camp INTENT; it owns no motion. The split is
// the same one every other AI in this sim uses: camps.ts decides what a member
// wants (rest at its post / chase this enemy / walk home), writes that as the
// ordinary order fields (`order`, `ox`, `oz`, `orderTarget`), and movement.ts's
// camp branch executes it. combat.ts then swings at `orderTarget` with no camp
// special-casing at all, because a neutral is an enemy of both player teams for
// free (`attackable()` tests `t.team !== e.team`).
//
// The three rules that make the jungle safe, in the order they are enforced:
//   1. LEASH FIRST. A member at or beyond CAMP_LEASH_RADIUS from its clearing
//      centre drops everything and walks home. A camp that can be dragged into
//      a lane is a defect (DESIGN_DELTA §2), so the distance is also HARD
//      CLAMPED here: whatever moved the member — steering overshoot at high
//      moveSpeed, a slow-release displacement, a future ability — the member is
//      pulled back onto the leash circle on the same tick. Combined with
//      CAMP_LANE_CLEARANCE (14) a fully extended member is still 4 m clear of
//      every lane polyline.
//   2. RETURNING IS UNINTERRUPTIBLE. A leashing member does not re-acquire, and
//      it restores to full hp ON ARRIVAL (TERRAIN_CONTRACT §5 — "returns to it
//      and restores to full hp on arrival"), clearing `lastHitBy` and
//      `recentDamagers` both at the break and at the arrival. Without that
//      clear a hero could chip a camp, walk away, and still be credited when
//      somebody else finished it.
//   3. NEVER A LANE UNIT. Members spawn with lane = -1, owner = NO_ENT,
//      team = NEUTRAL_TEAM and path = null. A camp creep with lane >= 0 walks a
//      lane polyline, which is the single most likely way this feature breaks.
//
// Determinism: no RNG, no clock. Member posts come from a fixed unit-vector
// table (no trigonometry), acquisition ties break on entity id, and the only
// per-tick allocation is none — `memberIds` is rewritten in place on respawn.
// ============================================================================
import {
  AGGRO_RADIUS,
  CAMP_BRUTE,
  CAMP_BRUTE_COUNT,
  CAMP_BRUTE_RESPAWN_S,
  CAMP_HIVE,
  CAMP_HIVE_COUNT,
  CAMP_HIVE_RESPAWN_S,
  CAMP_LEASH_RADIUS,
  CAMP_PACK,
  CAMP_PACK_COUNT,
  CAMP_PACK_RESPAWN_S,
  NEUTRAL_TEAM,
  TICK_RATE,
  isPlayerTeam,
} from '@rift/shared';
import type { CampDef, CreepTuning, EntKind } from '@rift/shared';
import { NO_ENT } from './types.js';
import type { CampState, Ent, EntId } from './types.js';
import type { CoreStats, SimWorld } from './world.js';

type CampTier = CampDef['tier'];

/** One EntKind per tier. `EntKind` gains exactly these three (shared/types.ts);
 *  a camp's members all share one statline, so the tier is the whole identity. */
const TIER_KIND: Record<CampTier, EntKind> = {
  pack: 'campPack',
  brute: 'campBrute',
  hive: 'campHive',
};

/** The frozen per-tier statlines. Every number here is config's; this module
 *  invents none of them (shared/config.ts carries the derivation). */
const TIER_TUNING: Record<CampTier, CreepTuning> = {
  pack: CAMP_PACK,
  brute: CAMP_BRUTE,
  hive: CAMP_HIVE,
};

/** Members spawned per camp. The camp respawns whole, never trickles. */
const TIER_COUNT: Record<CampTier, number> = {
  pack: CAMP_PACK_COUNT,
  brute: CAMP_BRUTE_COUNT,
  hive: CAMP_HIVE_COUNT,
};

/** Ticks from the death of the LAST member to the camp coming back. Rounded
 *  once at module load, so the delay is identical in every replay. */
const TIER_RESPAWN_TICKS: Record<CampTier, number> = {
  pack: Math.round(CAMP_PACK_RESPAWN_S * TICK_RATE),
  brute: Math.round(CAMP_BRUTE_RESPAWN_S * TICK_RATE),
  hive: Math.round(CAMP_HIVE_RESPAWN_S * TICK_RATE),
};

/** Resting ring radius around the clearing centre. Deliberately small: the
 *  CAMP_LANE_CLEARANCE derivation assumes "a resting member sits within ~2 m of
 *  the clearing centre", and that assumption is what keeps a camp at rest from
 *  ever reaching a passing wave with its AGGRO_RADIUS. */
const POST_RING_R = 1.6;

/** Eight unit vectors as exact literals. A table instead of Math.cos/Math.sin
 *  because trigonometry is the one piece of arithmetic whose last bits are
 *  implementation-defined, and camp spawn positions feed the replay. */
const POST_DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0.7071067811865476, 0.7071067811865476],
  [0, 1],
  [-0.7071067811865476, 0.7071067811865476],
  [-1, 0],
  [-0.7071067811865476, -0.7071067811865476],
  [0, -1],
  [0.7071067811865476, -0.7071067811865476],
];

/** How close a returning member must get to its post to count as home. Matches
 *  movement.ts's own arrival epsilon band, which snaps exactly onto the
 *  destination, so this triggers on the tick the walk finishes. */
const POST_ARRIVE_EPS = 0.15;

/** The resting post of member `index` of a `count`-member camp: a fixed spoke
 *  of the ring, spread as evenly as the 8-direction table allows. Pure in
 *  (def, index, count), so it survives a respawn unchanged and needs no
 *  storage on CampState. */
function postDir(index: number, count: number): readonly [number, number] {
  const stride = count > 0 ? POST_DIRS.length / count : 1;
  const slot = Math.floor(index * stride) % POST_DIRS.length;
  return POST_DIRS[slot] ?? POST_DIRS[0] ?? [1, 0];
}

function postX(def: CampDef, index: number, count: number): number {
  return def.x + postDir(index, count)[0] * POST_RING_R;
}

function postZ(def: CampDef, index: number, count: number): number {
  return def.z + postDir(index, count)[1] * POST_RING_R;
}

/** Is `t` something a camp member may swing at? Player-team MOBILES only: a
 *  camp never acquires a structure (it would have to leave its clearing to
 *  reach one), never fights another neutral, and wards/projectiles are not
 *  legal targets for anybody. `isPlayerTeam` is the narrowing guard — it is the
 *  only sanctioned way to assert a team is not NEUTRAL_TEAM. */
function hostileToCamp(t: Ent): boolean {
  if (!t.alive || t.id < 1000) return false;
  if (t.kind === 'ward' || t.kind === 'proj') return false;
  return isPlayerTeam(t.team);
}

/** Nearest hostile mobile within `r`. Ties break on the lower entity id so the
 *  choice cannot depend on map iteration order. Uses the world's shared scratch
 *  buffer and allocates nothing. */
function nearestHostile(w: SimWorld, e: Ent, r: number): Ent | undefined {
  const n = w.inRadius(e.x, e.z, r, w.scratchA);
  let best: Ent | undefined;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const t = w.scratchA[i];
    if (!t || !hostileToCamp(t)) continue;
    const d = Math.hypot(t.x - e.x, t.z - e.z);
    if (d < bestD || (d === bestD && best !== undefined && t.id < best.id)) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/** The member's current victim, if it is still a legal one. */
function stickyTarget(w: SimWorld, e: Ent): Ent | undefined {
  if (e.orderTarget === NO_ENT) return undefined;
  const t = w.get(e.orderTarget);
  return t && hostileToCamp(t) ? t : undefined;
}

/** A member is walking home exactly when it has a move order and no victim —
 *  nothing else ever issues an order to a neutral (World.order takes heroes). */
function isReturning(e: Ent): boolean {
  return e.order === 'move' && e.orderTarget === NO_ENT;
}

/** Drop aggro and walk to the post. Damage bookkeeping is wiped here as well as
 *  on arrival: a camp that resets must not carry credit for the chip damage
 *  that pulled it. */
function beginReturn(e: Ent, px: number, pz: number): void {
  e.order = 'move';
  e.orderTarget = NO_ENT;
  e.ox = px;
  e.oz = pz;
  e.atkTarget = NO_ENT;
  e.lastHitBy = NO_ENT;
  e.recentDamagers.length = 0;
}

/** Home again: full hp, idle, no memory of the fight. */
function restAtPost(e: Ent, px: number, pz: number): void {
  e.order = 'idle';
  e.orderTarget = NO_ENT;
  e.ox = px;
  e.oz = pz;
  e.hp = e.maxHp;
  e.lastHitBy = NO_ENT;
  e.recentDamagers.length = 0;
}

/** Stamp one freshly spawned member with its tier's statline.
 *
 *  Both halves are required. `Ent.*` is what combat, movement and the snapshot
 *  read this tick; `SimWorld.base` is what recomputeEnt() derives those same
 *  fields from every single tick (advance step 3) — write only the first and
 *  the camp is back to 1 hp within a tick. bounty, xpValue and vision live on
 *  the Ent alone (recomputeEnt does not touch them), exactly as they do for
 *  wave creeps. */
function applyCampStats(w: SimWorld, e: Ent, t: CreepTuning): void {
  e.maxHp = t.hp;
  e.hp = t.hp;
  e.mana = 0;
  e.maxMana = 0;
  e.damage = t.damage;
  e.armor = t.armor;
  e.attackPeriod = t.attackPeriod;
  e.attackRange = t.attackRange;
  e.moveSpeed = t.moveSpeed;
  e.hpRegen = 0;
  e.manaRegen = 0;
  e.lifesteal = 0;
  e.vision = t.vision;
  e.bounty = t.bounty;
  e.xpValue = t.xp;
  const core: CoreStats = {
    maxHp: t.hp,
    maxMana: 0,
    damage: t.damage,
    armor: t.armor,
    attackPeriod: t.attackPeriod,
    attackRange: t.attackRange,
    moveSpeed: t.moveSpeed,
    hpRegen: 0,
    manaRegen: 0,
    lifesteal: 0,
    vision: t.vision,
  };
  w.base.set(e.id, core);
}

/**
 * Fill `c` with a whole fresh generation of creeps and mark it UP.
 *
 * Called once per camp at match start (the world builds every CampState with
 * `aliveCount` 0 and `respawnAtTick` 0, so the first stepCamps stands the
 * jungle up) and again on every respawn. Entity ids are never recycled —
 * `memberIds` is rewritten in place with brand-new ids, so a stale id held by
 * anything else resolves to `undefined` rather than to somebody else's creep.
 */
export function spawnCamp(w: SimWorld, c: CampState): void {
  const tier = c.def.tier;
  const kind = TIER_KIND[tier];
  const tuning = TIER_TUNING[tier];
  const count = TIER_COUNT[tier];
  const ids = c.memberIds;
  ids.length = 0;
  for (let i = 0; i < count; i++) {
    const px = postX(c.def, i, count);
    const pz = postZ(c.def, i, count);
    // The frozen recipe (TERRAIN_CONTRACT §5): neutral team, lane -1 so the
    // member never touches a lane polyline, no owner, and no expiry.
    const id = w.spawnMobile(kind, NEUTRAL_TEAM, px, pz, -1, -1, NO_ENT);
    const e = w.get(id);
    if (!e) continue;
    applyCampStats(w, e, tuning);
    e.lane = -1;
    e.waypoint = 0;
    e.path = null;
    e.pathIndex = 0;
    e.atkTarget = NO_ENT;
    e.nextAttackTick = 0;
    restAtPost(e, px, pz);
    ids.push(id);
  }
  c.aliveCount = ids.length;
  c.respawnAtTick = -1; // -1 is the ONLY "camp is up" encoding
}

/** Drive one member: leash, return, acquire, chase. Writes intent only. */
function stepMember(w: SimWorld, c: CampState, e: Ent, index: number, count: number): void {
  const ox = c.def.x;
  const oz = c.def.z;
  const px = postX(c.def, index, count);
  const pz = postZ(c.def, index, count);
  const dOrigin = Math.hypot(e.x - ox, e.z - oz);

  // 1. Leash. Checked before anything else, and enforced positionally: past the
  //    radius the member is pulled back onto the circle, so "a camp never
  //    leaves its clearing" holds no matter what moved it.
  if (dOrigin >= CAMP_LEASH_RADIUS) {
    if (dOrigin > CAMP_LEASH_RADIUS) {
      const k = CAMP_LEASH_RADIUS / dOrigin;
      e.x = ox + (e.x - ox) * k;
      e.z = oz + (e.z - oz) * k;
    }
    beginReturn(e, px, pz);
    return;
  }

  // 2. Already walking home: no re-acquisition, and the heal lands on arrival.
  if (isReturning(e)) {
    if (Math.hypot(e.x - px, e.z - pz) <= POST_ARRIVE_EPS) restAtPost(e, px, pz);
    return;
  }

  // 3. Aggro. A damaged member acquires its damager at ANY range — that is the
  //    pull — otherwise it acquires the nearest hostile inside AGGRO_RADIUS.
  let t = stickyTarget(w, e);
  if (!t && e.lastHitBy !== NO_ENT) {
    const dmg = w.get(e.lastHitBy);
    if (dmg && hostileToCamp(dmg)) t = dmg;
  }
  if (!t) t = nearestHostile(w, e, AGGRO_RADIUS);
  if (t) {
    e.order = 'attack';
    e.orderTarget = t.id;
    e.ox = t.x;
    e.oz = t.z;
    return;
  }

  // 4. Nothing to fight: hold the post, or walk back to it.
  if (Math.hypot(e.x - px, e.z - pz) > POST_ARRIVE_EPS) beginReturn(e, px, pz);
  else restAtPost(e, px, pz);
}

/** Recount liveness, drive the living, stamp/serve the respawn clock. */
function stepOneCamp(w: SimWorld, c: CampState): void {
  const ids = c.memberIds;
  const count = ids.length;
  let alive = 0;
  for (let i = 0; i < count; i++) {
    const id = ids[i];
    if (id === undefined) continue;
    const e = w.get(id);
    // stepDeaths (step 6) removes dead non-hero mobiles from the store
    // outright, so a missing entity is a dead member, not a bug.
    if (!e || !e.alive) continue;
    alive += 1;
    stepMember(w, c, e, i, count);
  }
  c.aliveCount = alive;

  if (alive > 0) {
    c.respawnAtTick = -1;
    return;
  }
  if (c.respawnAtTick < 0) {
    // The last member died this tick: start the clock.
    c.respawnAtTick = w.tick + TIER_RESPAWN_TICKS[c.def.tier];
    return;
  }
  if (w.tick >= c.respawnAtTick) spawnCamp(w, c);
}

/**
 * advance() step (7). Runs after stepDeaths so a camp emptied this tick starts
 * its respawn timer immediately, and before stepUnits so a respawned member is
 * a normal mobile for the rest of the tick.
 */
export function stepCamps(w: SimWorld): void {
  const camps = w.camps;
  for (let i = 0; i < camps.length; i++) {
    const c = camps[i];
    if (!c) continue;
    stepOneCamp(w, c);
  }
}
