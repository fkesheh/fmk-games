// ============================================================================
// srv-horde — pure horde AI.
//
// spawnZombie / stepHorde / stepSpits. Every zombie moves via @fps/shared's
// stepBody against ctx.solids, stepping its OWN persistent Zombie.body — the
// same collide-and-slide + step-up code survivors use — so a zombie can
// never walk through the fence or the tower, and climbs breach rubble the
// same way a survivor climbs a stair (both are <= PLAYER.stepUp risers).
//
// State ownership: this module owns ZombieState end-to-end EXCEPT the one
// transition combat.ts's resolveShot already makes on a killing hitscan hit
// (it sets state='dying' + clears both targets itself, in the same tick as
// the kill, per srv-combat). The hp<=0 branch below exists so death is still
// guaranteed to exit every state even if some OTHER future damage source
// (e.g. a debug op) reduces hp without going through combat.ts — "every
// state must exit on death" is an invariant this module is responsible for,
// not an accident of who currently calls damageSegment/damageSurvivor.
//
// Targeting: a zombie outside the fence steers at the nearest INTACT
// segment's segmentAttackSpot; once inside the compound (through a breach)
// it hunts the nearest living, connected survivor instead. Both targets are
// re-validated every tick before use (never dereferenced once stale) and a
// full retarget only runs at most every HORDE.retargetSec — UNLESS the
// current target has gone stale (segment breached/vanished, survivor
// dead/disconnected), which forces an immediate retarget regardless of the
// throttle.
//
// Fence damage is CONTINUOUS (FENCE.damageIsContinuous): every tick a zombie
// is within its kind's meleeReach of the segment's wall, it deals
// ZOMBIE_BASE[kind].fenceDps * dt via fence.ts's damageSegment. Damage to
// SURVIVORS is on the swing timer instead (meleeInterval), via
// survivors.ts's damageSurvivor.
//
// meleeDmg/meleeReach/meleeInterval/fenceDps are read straight from the
// frozen ZOMBIE_BASE table rather than re-deriving them from waves.ts's
// zombieStats every tick: per that function's own doc, "every other field
// [besides hp] is base tuning, verbatim" — so this is the same number by a
// shorter, allocation-free path, and it removes the ambiguity of which
// wave's scaling would apply to a zombie that has been alive across a wave
// boundary. zombieStats() IS used, once, at spawn time, for its wave-scaled
// hp.
// ============================================================================
import { PLAYER, raycastSolids, stepBody } from '@fps/shared';
import type { MoveInput } from '@fps/shared';
import {
  FENCE_HALF,
  HEARD_PULL,
  HORDE,
  NOISE_HEARD_S,
  NOISE_RADIUS_M,
  SEGMENTS,
  SIM_HZ,
  SPIT,
  ZOMBIE_BASE,
  hordeSpawnAngle,
  segmentAttackSpot,
  segmentDistance,
  yawTo,
} from '@outpost/shared';
import type {
  FenceSegment,
  PlayerId,
  SegmentGeom,
  SimContext,
  SpawnZombieFn,
  Spit,
  StepHordeFn,
  StepSpitsFn,
  Survivor,
  Zombie,
} from '@outpost/shared';
import { damageSegment } from './fence.js';
import { damageSurvivor } from './survivors.js';
import { zombieStats } from './waves.js';

// ---------------------------------------------------------------------------
// Hot-path scratch state. Preallocated once, mutated per zombie/spit per
// tick — the contract forbids allocation in stepHorde/stepSpits, which run
// every tick against up to HORDE.maxAlive zombies.
// ---------------------------------------------------------------------------
const scratchInput: MoveInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, crouch: false, walk: false };
const spitFrom = { x: 0, y: 0, z: 0 };
const spitDir = { x: 0, y: 0, z: 0 };

/** Presentation-only gait advance rate (cycles per metre walked). */
const GAIT_CYCLES_PER_METER = 0.6;

/**
 * Radius within which a spit impact counts as a direct hit on the nearest
 * survivor (as opposed to splash-only). Derived from the frozen PLAYER.radius
 * rather than a bespoke literal — the contract has no dedicated "spit direct
 * hit" constant, so this is the closest thing to "landed on you" the shared
 * geometry offers.
 */
const SPIT_DIRECT_RADIUS = PLAYER.radius + 0.3;

/** A gunshot's position in tick-time: who fired, from where, on which tick. */
export interface NoisePulse {
  x: number;
  z: number;
  tick: number;
  shooterId: PlayerId;
}

/** Ticks a pulse stays heard. Derived once — the config values are frozen. */
const NOISE_HEARD_TICKS = NOISE_HEARD_S * SIM_HZ;

/** Registry cap: a full magazine dump must not grow this without bound. */
const NOISE_CAP = 16;

/**
 * Module-level gunshot registry. room.ts's tryFire pushes one pulse per shot
 * actually fired; retarget consults it when deciding whether an outside
 * zombie hunts the nearest survivor directly. Module-level (not on the frozen
 * SimContext): pulses carry their own tick, and freshness is always evaluated
 * against the READING context's tick with an explicit age >= 0 guard, so
 * pulses from a different room's clock (or an earlier test) read as stale,
 * never fresh.
 */
const noisePulses: NoisePulse[] = [];

/**
 * Records a gunshot. Prunes pulses expired as of the pushed tick, then drops
 * oldest-first past NOISE_CAP. Allocation on push only — the per-tick query
 * path allocates nothing.
 */
export function pushNoise(pulse: NoisePulse): void {
  for (let i = noisePulses.length - 1; i >= 0; i--) {
    const p = noisePulses[i];
    if (p !== undefined && pulse.tick - p.tick > NOISE_HEARD_TICKS) noisePulses.splice(i, 1);
  }
  noisePulses.push({ x: pulse.x, z: pulse.z, tick: pulse.tick, shooterId: pulse.shooterId });
  while (noisePulses.length > NOISE_CAP) noisePulses.shift();
}

/**
 * Latest still-fresh pulse for `shooterId` as of `tick`, or null. Fresh =
 * 0 <= age <= NOISE_HEARD_TICKS: the lower bound is what keeps another room's
 * (or an earlier test's) higher-tick pulses from reading as fresh here.
 * Shooter liveness is NOT checked here — callers re-resolve the shooter via
 * ctx.survivors and require alive+connected before acting on the pulse.
 */
function freshPulseFor(shooterId: PlayerId, tick: number): NoisePulse | null {
  let best: NoisePulse | null = null;
  for (const p of noisePulses) {
    if (p.shooterId !== shooterId) continue;
    const age = tick - p.tick;
    if (age < 0 || age > NOISE_HEARD_TICKS) continue;
    if (best === null || p.tick > best.tick) best = p;
  }
  return best;
}

/**
 * Nearest FRESH in-earshot pulse's distance to the candidate spot (sx, sz),
 * or Infinity when no pulse qualifies (magnet term is then 0).
 *
 * Freshness uses the same recency rule as freshPulseFor (0 <= age <=
 * NOISE_HEARD_TICKS, tick-guard included); earshot is measured from the
 * ZOMBIE (zx, zz) to the PULSE POSITION, not from the live shooter. Shooter
 * liveness is deliberately NOT required: a pulse is a PLACE the zombie heard
 * a shot from, not a TARGET — the shooter dying (or disconnecting) afterwards
 * does not un-ring it. (v1 pursue does require liveness, because it chases a
 * living person.)
 *
 * Min over ALL fresh pulses (not latest-wins) so alternating shots from two
 * walls hold a stable nearer-wall choice instead of flip-flopping every shot.
 * Bounded 16 segments x <= 16 pulses on the throttled retarget path — no
 * pooling needed.
 */
function minHeardPulseDist(zx: number, zz: number, sx: number, sz: number, tick: number): number {
  let best = Infinity;
  for (const p of noisePulses) {
    const age = tick - p.tick;
    if (age < 0 || age > NOISE_HEARD_TICKS) continue;
    if (Math.hypot(p.x - zx, p.z - zz) > NOISE_RADIUS_M) continue;
    const d = Math.hypot(sx - p.x, sz - p.z);
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// spawnZombie
// ---------------------------------------------------------------------------

/**
 * Claims a free pool slot (dense index == ZombieId) and places the zombie on
 * the treeline spawn ring via `hordeSpawnAngle`, using the claimed slot as
 * the angular index so placement is deterministic and allocation-free.
 * Returns -1 when every slot is alive (HORDE.maxAlive reached).
 *
 * Resets the zombie's PERSISTENT body in place (never replaces the object —
 * `Zombie.body` must keep its identity for stepBody's onGround-gated
 * step-up assist to keep working across a respawn into the same slot).
 * `body.height` is set to PLAYER.heightStand, not the kind's presentation
 * height: stepBody force-resets it to PLAYER.heightStand on its very first
 * call regardless (see CONTRACT.md), so seeding anything else here is a
 * value that would be silently overwritten one tick later.
 */
export const spawnZombie: SpawnZombieFn = (ctx, kind, wave) => {
  const slot = ctx.zombies.findIndex((z) => !z.alive);
  if (slot < 0) return -1;
  const zombie = ctx.zombies[slot];
  if (!zombie) return -1;

  const stats = zombieStats(kind, wave);
  const jitter = ctx.rand();
  const angle = hordeSpawnAngle(slot, ctx.zombies.length, jitter);
  const x = Math.sin(angle) * HORDE.spawnRing;
  const z = -Math.cos(angle) * HORDE.spawnRing;

  zombie.kind = kind;
  zombie.alive = true;
  zombie.hp = stats.hp;
  zombie.maxHp = stats.hp;

  zombie.body.x = x;
  zombie.body.y = 0;
  zombie.body.z = z;
  zombie.body.vx = 0;
  zombie.body.vy = 0;
  zombie.body.vz = 0;
  zombie.body.height = PLAYER.heightStand;
  zombie.body.onGround = true;

  zombie.yaw = yawTo(x, z, 0, 0);
  zombie.height = stats.height;
  zombie.radius = stats.radius;
  zombie.speed = stats.speed;
  zombie.state = 'approach';
  zombie.targetSeg = -1;
  zombie.targetPlayer = null;
  zombie.retargetAt = 0;
  zombie.attackCooldown = 0;
  zombie.spitCooldown = 0;
  zombie.dyingFor = 0;
  zombie.gait = 0;

  return zombie.id;
};

// ---------------------------------------------------------------------------
// stepHorde
// ---------------------------------------------------------------------------

function nearestLivingSurvivor(ctx: SimContext, x: number, z: number): Survivor | null {
  let best: Survivor | null = null;
  let bestD2 = Infinity;
  for (const survivor of ctx.survivors.values()) {
    if (survivor.status === 'dead' || !survivor.connected) continue;
    const dx = survivor.body.x - x;
    const dz = survivor.body.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = survivor;
    }
  }
  return best;
}

/**
 * Can `z` land a MELEE swing on `s` given the VERTICAL separation between
 * them?
 *
 * Every other distance in this module is deliberately a ground-plane
 * distance — pursuit, separation and fence contact all happen on a plane, so
 * a horizontal metric is the right one there. Melee is the one place where
 * that is wrong on its own: a zombie standing on the mud at the tower
 * footing is 1.2 m from a survivor standing on the SPAWN DECK 8 m above it,
 * and a horizontal-only reach test lets it claw them off the deck. DESIGN
 * (config.ts WAVES): "spitters break turtling on the top deck" — a design
 * that only means something if CLAWS cannot.
 *
 * The test is capsule overlap on Y: the survivor's FEET must be no higher
 * than the top of the zombie's head (`z.height`), and the survivor's HEAD
 * (`s.body.height`, which shrinks when they crouch) no lower than the
 * zombie's feet. A survivor standing on the 0.4 m fence footing, on breach
 * rubble, or one PLAYER.stepUp riser up a stair still overlaps and is still
 * hittable; one on DECK1_Y (4 m) or DECK2_Y (8 m) is not.
 */
function meleeReachesVertically(z: Zombie, s: Survivor): boolean {
  return s.body.y <= z.body.y + z.height && z.body.y <= s.body.y + s.body.height;
}

/**
 * Full retarget: inside the compound (through a breach), chase the nearest
 * living+connected survivor; otherwise steer at the nearest INTACT segment's
 * attack spot. Falls back to hunting any survivor (through the open gaps)
 * when every segment is breached, and finally to standing pat when neither
 * exists — the run should already be ending in that case.
 */
function retarget(ctx: SimContext, z: Zombie): void {
  const inside = Math.abs(z.body.x) < FENCE_HALF && Math.abs(z.body.z) < FENCE_HALF;

  if (inside) {
    const survivor = nearestLivingSurvivor(ctx, z.body.x, z.body.z);
    if (survivor) {
      z.targetPlayer = survivor.id;
      z.targetSeg = -1;
      z.state = 'pursue';
      return;
    }
  }

  // A survivor who is out in the open (or has come through a breach) is hunted
  // directly — plodding past a human to go chew timber is what made the horde
  // read as uninterested in the player.
  const near = nearestLivingSurvivor(ctx, z.body.x, z.body.z);
  if (near) {
    const dx = near.body.x - z.body.x;
    const dz = near.body.z - z.body.z;
    const outside = Math.abs(near.body.x) > FENCE_HALF || Math.abs(near.body.z) > FENCE_HALF;
    // Gunshot hearing: a survivor who recently fired pulls outside zombies
    // off the fence from NOISE_RADIUS_M, not just pursueRadius. The shooter
    // is re-resolved via ctx.survivors (never trust the pulse for liveness)
    // and the zombie must be in earshot of where the shot went off. With no
    // fresh pulse this is exactly the old proximity-only condition.
    let heard = false;
    if (outside) {
      const pulse = freshPulseFor(near.id, ctx.tick);
      if (pulse !== null) {
        const shooter = ctx.survivors.get(near.id);
        heard =
          shooter !== undefined &&
          shooter.status !== 'dead' &&
          shooter.connected &&
          Math.hypot(pulse.x - z.body.x, pulse.z - z.body.z) <= NOISE_RADIUS_M;
      }
    }
    if (outside && (Math.hypot(dx, dz) <= HORDE.pursueRadius || heard)) {
      z.targetPlayer = near.id;
      z.targetSeg = -1;
      z.state = 'pursue';
      return;
    }
  }

  // Otherwise pick a segment — but score it by how close it is to the SQUAD as
  // well as to us, so the wave masses on the wall being defended instead of
  // spreading itself evenly around a 40 m perimeter.
  let bestSeg = -1;
  let bestDist = Infinity;
  for (const segState of ctx.segments) {
    if (segState.breached) continue;
    const geom = SEGMENTS[segState.id];
    if (!geom) continue;
    const spot = segmentAttackSpot(geom);
    let d = Math.hypot(spot.x - z.body.x, spot.z - z.body.z);
    if (near) {
      d += HORDE.survivorPull * Math.hypot(spot.x - near.body.x, spot.z - near.body.z);
    }
    // Gunshot magnet: walls near a heard shot score lower, so outside zombies
    // mass on the shot-side wall even when the shooter is inside the fence
    // (v1 pursue only serves outside shooters). Infinity = no fresh in-earshot
    // pulse = term is 0, i.e. exactly the baseline scoring above.
    const heard = minHeardPulseDist(z.body.x, z.body.z, spot.x, spot.z, ctx.tick);
    if (heard < Infinity) d += HEARD_PULL * heard;
    if (d < bestDist) {
      bestDist = d;
      bestSeg = segState.id;
    }
  }

  if (bestSeg >= 0) {
    z.targetSeg = bestSeg;
    z.targetPlayer = null;
    z.state = 'approach';
    return;
  }

  const survivor = nearestLivingSurvivor(ctx, z.body.x, z.body.z);
  if (survivor) {
    z.targetPlayer = survivor.id;
    z.targetSeg = -1;
    z.state = 'pursue';
  } else {
    z.targetSeg = -1;
    z.targetPlayer = null;
    z.state = 'approach';
  }
}

/**
 * Advance every living zombie one tick: retarget throttling + forced
 * retarget on a stale target, fence chewing (continuous dps) or player melee
 * (swing timer) / spitter ranged fire, separation steering, stepBody
 * movement, and corpse retirement. Never dereferences a dead target — every
 * target is re-validated before it is read this tick.
 */
export const stepHorde: StepHordeFn = (ctx) => {
  for (const z of ctx.zombies) {
    if (!z.alive) continue;

    // Guaranteed exit-on-death regardless of which module reduced hp to 0.
    // combat.ts's resolveShot already does this itself on a killing hitscan
    // hit; this is the backstop for every other damage source.
    if (z.hp <= 0 && z.state !== 'dying') {
      z.state = 'dying';
      z.dyingFor = 0;
      z.targetSeg = -1;
      z.targetPlayer = null;
    }

    if (z.state === 'dying') {
      z.dyingFor += ctx.dt;
      if (z.dyingFor >= HORDE.corpseSec) z.alive = false;
      continue;
    }

    // --- validate existing targets; drop (and flag for forced retarget)
    //     anything stale: a breached/vanished segment or a dead/disconnected
    //     survivor. ---
    let haveTarget = false;
    let segGeom: SegmentGeom | null = null;
    let segState: FenceSegment | null = null;
    let targetSurvivor: Survivor | null = null;

    if (z.targetSeg !== -1) {
      const s = ctx.segments[z.targetSeg];
      const g = SEGMENTS[z.targetSeg];
      if (s && g && !s.breached) {
        segState = s;
        segGeom = g;
        haveTarget = true;
      } else {
        z.targetSeg = -1;
      }
    }
    if (z.targetPlayer !== null) {
      const survivor = ctx.survivors.get(z.targetPlayer);
      if (survivor && survivor.status !== 'dead' && survivor.connected) {
        targetSurvivor = survivor;
        haveTarget = true;
      } else {
        z.targetPlayer = null;
      }
    }

    // Noise expiry: an outside zombie pursuing an outside survivor from
    // beyond pursueRadius is only on them because of a gunshot — once no
    // fresh pulse remains for that shooter, the pursuit reason is gone and
    // the zombie must retarget (back to the fence) immediately instead of
    // chasing a quiet survivor across the map until the throttle fires.
    // Inside zombies, inside survivors (the all-breached fallback), and
    // in-radius pursuits are untouched.
    if (targetSurvivor !== null) {
      const zOutside = Math.abs(z.body.x) > FENCE_HALF || Math.abs(z.body.z) > FENCE_HALF;
      const sOutside =
        Math.abs(targetSurvivor.body.x) > FENCE_HALF || Math.abs(targetSurvivor.body.z) > FENCE_HALF;
      if (zOutside && sOutside) {
        const pdist = Math.hypot(targetSurvivor.body.x - z.body.x, targetSurvivor.body.z - z.body.z);
        if (pdist > HORDE.pursueRadius && freshPulseFor(targetSurvivor.id, ctx.tick) === null) {
          z.targetPlayer = null;
          targetSurvivor = null;
          haveTarget = false;
        }
      }
    }

    if (!haveTarget || ctx.serverTime >= z.retargetAt) {
      retarget(ctx, z);
      z.retargetAt = ctx.serverTime + HORDE.retargetSec * 1000;
      segGeom = z.targetSeg !== -1 ? (SEGMENTS[z.targetSeg] ?? null) : null;
      segState = z.targetSeg !== -1 ? (ctx.segments[z.targetSeg] ?? null) : null;
      targetSurvivor = z.targetPlayer !== null ? (ctx.survivors.get(z.targetPlayer) ?? null) : null;
    }

    const base = ZOMBIE_BASE[z.kind];
    z.attackCooldown = Math.max(0, z.attackCooldown - ctx.dt);
    if (z.kind === 'spitter') z.spitCooldown = Math.max(0, z.spitCooldown - ctx.dt);

    let tx = z.body.x;
    let tz = z.body.z;
    let attacking = false;

    if (targetSurvivor) {
      tx = targetSurvivor.body.x;
      tz = targetSurvivor.body.z;
      const pdist = Math.hypot(tx - z.body.x, tz - z.body.z);

      if (z.kind === 'spitter' && pdist <= SPIT.range && pdist >= SPIT.minRange) {
        attacking = true;
        z.state = 'attackPlayer';
        if (z.spitCooldown <= 0) {
          launchSpit(ctx, z, targetSurvivor);
          z.spitCooldown = SPIT.cooldownSec;
        }
      } else if (pdist <= base.meleeReach && meleeReachesVertically(z, targetSurvivor)) {
        attacking = true;
        z.state = 'attackPlayer';
        if (z.attackCooldown <= 0) {
          damageSurvivor(ctx, targetSurvivor, base.meleeDmg, z.id);
          z.attackCooldown = base.meleeInterval;
        }
      } else {
        z.state = 'pursue';
      }
    } else if (segGeom && segState) {
      const spot = segmentAttackSpot(segGeom);
      tx = spot.x;
      tz = spot.z;
      const wallDist = segmentDistance(z.body.x, z.body.z, segGeom);
      if (wallDist <= base.meleeReach) {
        attacking = true;
        z.state = 'attackFence';
        damageSegment(ctx, segGeom.id, base.fenceDps * ctx.dt);
      } else {
        z.state = 'approach';
      }
    } else {
      z.state = 'approach';
    }

    // --- face the target while attacking; steer + separate while moving ---
    let yaw = z.yaw;
    let moveZ = 0;

    if (attacking) {
      const fdx = tx - z.body.x;
      const fdz = tz - z.body.z;
      if (Math.abs(fdx) > 1e-4 || Math.abs(fdz) > 1e-4) yaw = Math.atan2(-fdx, -fdz);
    } else {
      const dist = Math.hypot(tx - z.body.x, tz - z.body.z);
      if (dist > 0.05) {
        const dirX = (tx - z.body.x) / dist;
        const dirZ = (tz - z.body.z) / dist;

        let sepX = 0;
        let sepZ = 0;
        for (const other of ctx.zombies) {
          if (other === z || !other.alive || other.state === 'dying') continue;
          const ox = z.body.x - other.body.x;
          const oz = z.body.z - other.body.z;
          const od = Math.hypot(ox, oz);
          if (od < 1e-4) {
            // Exactly (or almost) coincident: push apart along a stable,
            // id-derived direction so two zombies spawned on the same point
            // don't sit fighting a zero vector forever.
            const a = (z.id - other.id) * 2.399963;
            sepX += Math.cos(a);
            sepZ += Math.sin(a);
          } else if (od < HORDE.separationRadius) {
            const push = (HORDE.separationRadius - od) / HORDE.separationRadius;
            sepX += (ox / od) * push;
            sepZ += (oz / od) * push;
          }
        }

        let wx = dirX + sepX * HORDE.separationForce;
        let wz = dirZ + sepZ * HORDE.separationForce;
        const wlen = Math.hypot(wx, wz) || 1;
        wx /= wlen;
        wz /= wlen;
        yaw = Math.atan2(-wx, -wz);
        moveZ = 1;
      }
    }

    z.yaw = yaw;
    scratchInput.moveX = 0;
    scratchInput.moveZ = moveZ;
    scratchInput.yaw = yaw;
    scratchInput.jump = false;
    scratchInput.crouch = false;
    scratchInput.walk = false;
    stepBody(z.body, scratchInput, z.speed / PLAYER.speedRun, ctx.dt, ctx.solids);

    if (moveZ !== 0) z.gait = (z.gait + z.speed * ctx.dt * GAIT_CYCLES_PER_METER) % 1;
  }
};

// ---------------------------------------------------------------------------
// Spitter fire
// ---------------------------------------------------------------------------

/**
 * Claims a free Spit pool slot and launches a gravity-arced glob at `target`
 * using a fixed launch speed (SPIT.speed) and solving for the launch angle
 * that lands on the target's position under SPIT.gravity. Silently drops the
 * shot if the pool is exhausted (never throws) and falls back to a 45° lob
 * if the target is out of range at this speed (the low-arc root has no real
 * solution) rather than producing a NaN trajectory.
 */
function launchSpit(ctx: SimContext, z: Zombie, target: Survivor): void {
  const slot = ctx.spits.findIndex((s) => !s.alive);
  if (slot < 0) return;
  const spit = ctx.spits[slot];
  if (!spit) return;

  const x0 = z.body.x;
  const y0 = z.body.y + z.height * 0.85;
  const z0 = z.body.z;
  const x1 = target.body.x;
  const y1 = target.body.y + PLAYER.heightStand * 0.5;
  const z1 = target.body.z;

  const dx = x1 - x0;
  const dz = z1 - z0;
  const d = Math.hypot(dx, dz) || 0.01;
  const dy = y1 - y0;
  const v = SPIT.speed;
  const g = SPIT.gravity;

  const v2 = v * v;
  const disc = v2 * v2 - g * (g * d * d + 2 * dy * v2);
  let angle: number;
  if (disc < 0) {
    angle = Math.PI / 4;
  } else {
    const root = Math.sqrt(disc);
    // Low-arc (minus) root — the "lazy arc" the style bible describes.
    angle = Math.atan((v2 - root) / (g * d));
  }
  angle = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, angle));

  const horizSpeed = v * Math.cos(angle);
  const vy = v * Math.sin(angle);
  const dirX = dx / d;
  const dirZ = dz / d;

  spit.alive = true;
  spit.x = x0;
  spit.y = y0;
  spit.z = z0;
  spit.vx = dirX * horizSpeed;
  spit.vy = vy;
  spit.vz = dirZ * horizSpeed;
  spit.ttl = SPIT.ttlSec;
  spit.ownerId = z.id;
}

function applySpitImpact(ctx: SimContext, s: Spit, x: number, y: number, z: number): void {
  let directVictim: Survivor | null = null;
  let directDist = Infinity;
  for (const survivor of ctx.survivors.values()) {
    if (survivor.status === 'dead') continue;
    const dx = survivor.body.x - x;
    const dz = survivor.body.z - z;
    const d = Math.hypot(dx, dz);
    if (d < directDist) {
      directDist = d;
      directVictim = survivor;
    }
  }
  const hasDirect = directVictim !== null && directDist <= SPIT_DIRECT_RADIUS;
  if (hasDirect && directVictim) {
    damageSurvivor(ctx, directVictim, SPIT.directDmg, s.ownerId);
  }
  for (const survivor of ctx.survivors.values()) {
    if (survivor.status === 'dead') continue;
    if (hasDirect && survivor === directVictim) continue; // already took the direct hit
    const dx = survivor.body.x - x;
    const dz = survivor.body.z - z;
    const d = Math.hypot(dx, dz);
    if (d <= SPIT.splashRadius) damageSurvivor(ctx, survivor, SPIT.splashDmg, s.ownerId);
  }
  ctx.emit({ t: 'spit_land', x, y, z });
}

// ---------------------------------------------------------------------------
// stepSpits
// ---------------------------------------------------------------------------

/**
 * Advances every alive spit's gravity-arced flight one tick. Swept, not
 * stepped: `SPIT.speed` 18 m/s covers 0.6 m/tick against a 0.3 m-thick
 * fence, so each sub-step is raycast against `ctx.solids` (per CONTRACT.md's
 * "projectiles must be swept, not stepped") rather than tested for overlap
 * only at its new position. Falls back to a y=0 ground-plane crossing check
 * when no solid is hit, and to TTL expiry when neither happens.
 */
export const stepSpits: StepSpitsFn = (ctx) => {
  for (const s of ctx.spits) {
    if (!s.alive) continue;

    s.ttl -= ctx.dt;
    s.vy -= SPIT.gravity * ctx.dt;

    const nx = s.x + s.vx * ctx.dt;
    const ny = s.y + s.vy * ctx.dt;
    const nz = s.z + s.vz * ctx.dt;

    const dx = nx - s.x;
    const dy = ny - s.y;
    const dz = nz - s.z;
    const segLen = Math.hypot(dx, dy, dz);

    let landed = false;
    let hx = nx;
    let hy = ny;
    let hz = nz;

    if (segLen > 1e-6) {
      spitFrom.x = s.x;
      spitFrom.y = s.y;
      spitFrom.z = s.z;
      spitDir.x = dx / segLen;
      spitDir.y = dy / segLen;
      spitDir.z = dz / segLen;
      const t = raycastSolids(spitFrom, spitDir, ctx.solids, segLen);
      if (t >= 0) {
        landed = true;
        hx = s.x + spitDir.x * t;
        hy = s.y + spitDir.y * t;
        hz = s.z + spitDir.z * t;
      }
    }

    if (!landed && s.y > 0 && ny <= 0) {
      const frac = s.y / (s.y - ny);
      landed = true;
      hx = s.x + dx * frac;
      hy = 0;
      hz = s.z + dz * frac;
    }

    if (landed) {
      applySpitImpact(ctx, s, hx, hy, hz);
      s.alive = false;
      continue;
    }

    if (s.ttl <= 0) {
      s.alive = false;
      continue;
    }

    s.x = nx;
    s.y = ny;
    s.z = nz;
  }
};
