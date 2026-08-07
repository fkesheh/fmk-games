// ============================================================================
// ANCIENTS (rift) — NEUTRAL JUNGLE CAMPS (TERRAIN_CONTRACT §5, DESIGN_DELTA §2,
// AMENDMENT_1 §A/§C). advance() step (7), inserted between stepDeaths and
// stepUnits so a camp sees this tick's deaths and can stamp its respawn on the
// same tick its last member falls.
//
// THE SEAM, AND WHY IT IS WRITTEN DOWN HERE (AMENDMENT_1 §A). Camp behaviour
// was originally split across two modules with no owner named for "where does a
// member want to be", and each half invented the other: this file parked members
// on a post ring and healed them only within 15 cm of a post, while movement's
// camp branch steered at the clearing centre and never read the order fields at
// all. Composed, the hp restore, the leash clamp, the de-aggro and the damager
// wipe were unreachable and every member of a camp converged on one point.
//
//   camps.ts DECIDES. It is the only writer of a camp member's `order`, `ox`,
//   `oz` and `orderTarget`, and it NEVER writes `x` or `z`.
//   movement.ts EXECUTES. `campMotion` reads those four fields and does exactly
//   what they say — no acquisition, no leash, no home search, no hp.
//
// `stepCamps` runs AFTER `stepMovement` in the same tick, so an order written
// here takes effect on the next tick. That one-tick latency is accepted; it is
// not to be "fixed" by moving ents from this file.
//
// The rules that make the jungle safe, in the order they are enforced:
//   1. LEASH FIRST. A member further than CAMP_LEASH_RADIUS from its clearing
//      centre drops everything and is ORDERED home. It is never teleported:
//      camps.ts runs after movement's push-out, and writing a position there
//      could drop a member across a cliff or inside a structure.
//   2. THE CHASE IS CAPPED AT THE SOURCE. A member only ever acquires or keeps
//      a target that is itself inside the leash disc AND connected to the
//      clearing centre by walkable ground, so a member steering at its target
//      is steering at a point inside a convex region it is already in — the
//      leash in rule 1 is a safety net against displacement, not the mechanism.
//      The cap is CAMP_LEASH_RADIUS (10), NOT CAMP_LANE_CLEARANCE (14):
//      config.ts derives 14 FROM 10 (AMENDMENT_1 §C).
//   3. RETURNING IS UNINTERRUPTIBLE, AND THE HEAL IS AN EVENT. A member walking
//      home does not re-acquire, and it restores to full hp on the single tick
//      it ARRIVES — never while it rests, and never anywhere else. Camps carry
//      hpRegen 0 (AMENDMENT_1 §C), so this is the only heal a camp ever gets.
//   4. DISTINCT POSTS. Every member of a camp rests on its own point of a small
//      ring. One shared point makes 3-5 bodies fight pass-2 separation for ever.
//   5. NEVER A LANE UNIT. Members spawn with lane = -1, owner = NO_ENT,
//      team = NEUTRAL_TEAM and path = null. A camp creep with lane >= 0 walks a
//      lane polyline, which is the single most likely way this feature breaks.
//
// Determinism: no RNG, no clock. Member posts come from a fixed unit-vector
// table (no trigonometry), acquisition ties break on entity id, and there is no
// per-tick allocation — `memberIds` is rewritten in place on respawn.
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
import { segmentWalkable } from './pathing.js';
import { NO_ENT } from './types.js';
import type { CampState, Ent } from './types.js';
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

/** Radius of the ring of resting posts around the clearing centre.
 *
 *  Two constraints fix it. Above: the CAMP_LANE_CLEARANCE derivation assumes a
 *  resting member sits within ~2 m of the centre, which is what keeps a camp at
 *  rest from reaching a passing wave with its AGGRO_RADIUS. Below: two adjacent
 *  posts must be further apart than the two members' radii combined, or the
 *  bodies overlap at rest and pass-2 separation pushes them off their posts for
 *  ever. The tightest pair the tables can produce is two posts 45 degrees apart
 *  (the 5-member hive), a chord of 2*1.6*sin(22.5 deg) = 1.22 m against a hive
 *  member pair's 0.80 m of radius — and the widest bodies (brute, 0.70 m each,
 *  1.40 m combined) only ever sit 90 degrees apart. `camps.test.ts` measures
 *  this against the real spawned entities rather than trusting the arithmetic. */
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

/** How close a returning member must be to its post to count as home. Movement
 *  snaps exactly onto a destination it can reach within one step, so a member
 *  walking home lands ON the post and this triggers on that tick; the band
 *  exists only to absorb the sub-centimetre nudge separation can leave behind.
 *  Well under half the closest post spacing (1.22 m), so "home" can never be
 *  ambiguous between two members. */
const POST_ARRIVE_EPS = 0.15;

/** Hysteresis band on acquisition, in metres inside the leash disc.
 *
 *  A member RETAINS a target out to CAMP_LEASH_RADIUS but only ACQUIRES one
 *  inside `CAMP_LEASH_RADIUS - this`. Without the band a target loitering on
 *  the disc edge is dropped and re-taken on alternate ticks — and because
 *  `lastHitBy` survives until the camp resets, a hero who once poked the camp
 *  would re-pull it every other tick for the rest of the match. One metre is
 *  more than a camp member covers in a tick at any tier's moveSpeed (3.4 m/s ->
 *  0.17 m), so a target that crosses the band has genuinely walked out. */
const CAMP_ACQUIRE_MARGIN = 1;

/** The resting post of member `index` of a `count`-member camp: a fixed spoke
 *  of the ring, spread as evenly as the 8-direction table allows. Pure in
 *  (def, index, count), so it survives a respawn unchanged and needs no
 *  storage on CampState. Every camp size the tiers can produce (3, 4, 5) maps
 *  to a distinct spoke per member. */
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
 *  legal targets for anybody.
 *
 *  "Mobile" is asked of the world's mobile store, not of the entity id. Ids are
 *  partitioned at 1000, but that partition is world.ts's private numbering with
 *  no type-level link to this file — `mobileMap` IS the set of mobiles, so this
 *  is the definition rather than a proxy for it. `isPlayerTeam` is the
 *  narrowing guard: it is the only sanctioned way to assert a team is not
 *  NEUTRAL_TEAM, and it is what makes camp-vs-camp impossible. */
function hostileToCamp(w: SimWorld, t: Ent): boolean {
  if (!t.alive || !w.mobileMap.has(t.id)) return false;
  if (t.kind === 'ward' || t.kind === 'proj') return false;
  return isPlayerTeam(t.team);
}

/**
 * Is `t` inside the camp's reach — the range AND reachability cap that bounds
 * every acquisition this file makes?
 *
 * Both halves are load-bearing:
 *  - RANGE, measured from the CLEARING CENTRE and not from the member. This is
 *    what caps the chase at CAMP_LEASH_RADIUS: a member inside the disc that
 *    steers at a target inside the disc stays inside it, because a disc is
 *    convex. Measuring from the member instead would let a camp be walked
 *    across the map one member-length at a time.
 *  - REACHABILITY, as a walkable straight line from the centre to the target.
 *    A hero standing on the plateau above a clearing, or behind the rock at its
 *    edge, is inside the disc and cannot be reached; without this the member
 *    takes an attack order it can never satisfy and presses against the face
 *    until the hero chooses to stop. `segmentWalkable` is the same swept veto
 *    movement itself obeys, so the two cannot disagree about what is reachable.
 */
function withinCampReach(w: SimWorld, c: CampState, t: Ent, radius: number): boolean {
  const dx = t.x - c.def.x;
  const dz = t.z - c.def.z;
  if (dx * dx + dz * dz > radius * radius) return false;
  return segmentWalkable(w.map.terrain, c.def.x, c.def.z, t.x, t.z);
}

/** Nearest acquirable hostile within `AGGRO_RADIUS` of the member. Ties break on
 *  the lower entity id so the choice cannot depend on map iteration order. Uses
 *  the world's shared scratch buffer and allocates nothing. */
function nearestHostile(w: SimWorld, c: CampState, e: Ent): Ent | undefined {
  const n = w.inRadius(e.x, e.z, AGGRO_RADIUS, w.scratchA);
  const acquireR = CAMP_LEASH_RADIUS - CAMP_ACQUIRE_MARGIN;
  let best: Ent | undefined;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const t = w.scratchA[i];
    if (!t || !hostileToCamp(w, t)) continue;
    if (!withinCampReach(w, c, t, acquireR)) continue;
    const d = Math.hypot(t.x - e.x, t.z - e.z);
    if (d < bestD || (d === bestD && best !== undefined && t.id < best.id)) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/**
 * Who this member should be fighting, or undefined for "nobody".
 *
 * Priority, and every step of it is capped:
 *  1. the victim it already has, while that victim is still legal and still
 *     inside the disc. Retention uses the FULL leash radius — the band in
 *     {@link CAMP_ACQUIRE_MARGIN} is what stops it flickering at the edge;
 *  2. otherwise the nearest hostile inside AGGRO_RADIUS. This sits ABOVE the
 *     damager pull deliberately: a pull that outranked proximity let a sniper
 *     far away shadow a hero standing on top of the member;
 *  3. otherwise the damager — the pull that makes a camp answer ranged poke.
 *     Capped like everything else, so poking from outside the clearing no
 *     longer drags the camp onto a target it can never reach.
 */
function pickTarget(w: SimWorld, c: CampState, e: Ent): Ent | undefined {
  if (e.orderTarget !== NO_ENT) {
    const cur = w.get(e.orderTarget);
    if (cur && hostileToCamp(w, cur) && withinCampReach(w, c, cur, CAMP_LEASH_RADIUS)) return cur;
  }
  const near = nearestHostile(w, c, e);
  if (near) return near;
  if (e.lastHitBy !== NO_ENT) {
    const dmg = w.get(e.lastHitBy);
    const acquireR = CAMP_LEASH_RADIUS - CAMP_ACQUIRE_MARGIN;
    if (dmg && hostileToCamp(w, dmg) && withinCampReach(w, c, dmg, acquireR)) return dmg;
  }
  return undefined;
}

/** Order the member home and drop the fight. Damage bookkeeping is wiped here
 *  as well as on arrival: a camp that resets must not carry credit for the chip
 *  damage that pulled it, or a hero could chip a camp, walk away, and still be
 *  credited when somebody else finished it.
 *
 *  `recentDamagers` is cleared as AMENDMENT_1 §A requires. In production that
 *  list is empty on a neutral — `world.ts` only calls `noteDamager` when the
 *  VICTIM is a hero — so this clear is the guard that keeps the invariant true
 *  if that ever changes, and `camps.test.ts` drives `noteDamager` directly to
 *  hold it honest rather than asserting against a list nothing can fill. */
function beginReturn(e: Ent, px: number, pz: number): void {
  e.order = 'move';
  e.orderTarget = NO_ENT;
  e.ox = px;
  e.oz = pz;
  e.atkTarget = NO_ENT;
  e.lastHitBy = NO_ENT;
  e.recentDamagers.length = 0;
}

/** Hold the post. Idle means idle: `campMotion` refuses to move a member whose
 *  order is 'idle', so this is a true rest state.
 *
 *  NO HP IS WRITTEN HERE. This runs on every tick a member rests, and healing
 *  from it made the camp regenerate to full continuously — a camp being shot
 *  from outside its clearing would never die. The restore belongs to
 *  {@link arriveAtPost}, which runs on exactly one tick per return. */
function restAtPost(e: Ent, px: number, pz: number): void {
  e.order = 'idle';
  e.orderTarget = NO_ENT;
  e.ox = px;
  e.oz = pz;
}

/** The member has finished walking home: full hp, idle, no memory of the fight.
 *
 *  This is the leash-break arrival of TERRAIN_CONTRACT §5, and it is the ONLY
 *  heal a camp receives — camps carry hpRegen 0 (AMENDMENT_1 §C), so nothing
 *  else can top one up. It is reachable only from the returning state, and a
 *  member only enters the returning state by disengaging: it has no target that
 *  is inside the leash disc, alive, and reachable. */
function arriveAtPost(e: Ent, px: number, pz: number): void {
  restAtPost(e, px, pz);
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
 *  wave creeps.
 *
 *  hpRegen is 0 in BOTH, per AMENDMENT_1 §C: stepUnits' regen loop would
 *  otherwise heal a camp passively mid-fight, which is in no design document
 *  and interacts badly with the leash restore. */
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
 * Remove any member of the OUTGOING generation that is still alive, before the
 * CampState is reused.
 *
 * A respawn rewrites `memberIds` in place. Emptying the list without removing
 * the entities left them alive in the world, neutral, still moving, still worth
 * a bounty, and invisible to `stepCamps` — nothing would ever step, leash or
 * reap them again. In the normal respawn path the list is already all corpses
 * and this does nothing; it exists for the abnormal one (a forced respawn, a
 * mid-match reset) where it is the difference between a rebuilt camp and a
 * permanent leak.
 *
 * This is a DESPAWN, not a death: the ents leave the store without routing
 * through `killCreep`, so a replaced generation pays no bounty and no xp. A
 * camp that is being rebuilt was not killed by anybody.
 */
function despawnOldGeneration(w: SimWorld, c: CampState): void {
  const ids = c.memberIds;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id === undefined) continue;
    const e = w.get(id);
    if (!e) continue; // already reaped by stepDeaths: the ordinary case
    e.alive = false;
    e.hp = 0;
    e.order = 'idle';
    e.orderTarget = NO_ENT;
    e.atkTarget = NO_ENT;
    w.mobileMap.delete(id);
    w.base.delete(id);
    w.passiveAuras.delete(id);
  }
  ids.length = 0;
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
  despawnOldGeneration(w, c);
  const tier = c.def.tier;
  const kind = TIER_KIND[tier];
  const tuning = TIER_TUNING[tier];
  const count = TIER_COUNT[tier];
  const ids = c.memberIds;
  for (let i = 0; i < count; i++) {
    const px = postX(c.def, i, count);
    const pz = postZ(c.def, i, count);
    // The frozen recipe (TERRAIN_CONTRACT §5): neutral team, lane -1 so the
    // member never touches a lane polyline, no owner, and no expiry (-1, which
    // AMENDMENT_1 §B.3 fixes as "never" alongside 0).
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
    e.lastHitBy = NO_ENT;
    e.recentDamagers.length = 0;
    restAtPost(e, px, pz);
    ids.push(id);
  }
  c.aliveCount = ids.length;
  c.respawnAtTick = -1; // -1 is the ONLY "camp is up" encoding
}

/** Decide what one member wants. Writes intent only — never `x`/`z`. */
function stepMember(w: SimWorld, c: CampState, e: Ent, index: number, count: number): void {
  const px = postX(c.def, index, count);
  const pz = postZ(c.def, index, count);
  const dx = e.x - c.def.x;
  const dz = e.z - c.def.z;

  // 1. Leash. Checked before anything else. The chase cap in `withinCampReach`
  //    is what normally keeps a member inside the disc; this catches whatever
  //    moved it anyway — separation, a structure push-out, a displacement
  //    ability — and answers with an ORDER, not a teleport. Rewriting x/z here
  //    would run after movement's push-out and could drop the member across a
  //    cliff or inside a structure.
  if (dx * dx + dz * dz > CAMP_LEASH_RADIUS * CAMP_LEASH_RADIUS) {
    beginReturn(e, px, pz);
    return;
  }

  // 2. Already walking home: no re-acquisition, and the restore lands on the
  //    one tick the walk finishes.
  if (e.order === 'move') {
    if (Math.hypot(e.x - px, e.z - pz) <= POST_ARRIVE_EPS) arriveAtPost(e, px, pz);
    return;
  }

  // 3. Fight whatever is in the clearing.
  const t = pickTarget(w, c, e);
  if (t) {
    e.order = 'attack';
    e.orderTarget = t.id;
    e.ox = t.x;
    e.oz = t.z;
    return;
  }

  // 4. Nothing to fight: hold the post, or start walking back to it. Entering
  //    the returning state IS the disengagement, which is why step 2's arrival
  //    is the leash-break restore.
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
