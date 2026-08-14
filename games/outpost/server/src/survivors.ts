// ============================================================================
// srv-survivors — pure survivor system.
//
// damageSurvivor / stepDowned / stepRevives / resolveInteract / isSquadWiped,
// per CONTRACT.md. Pure with respect to I/O: no sockets, no timers, no
// Date.now() — every mutation goes through the SimContext handle the room
// passes in, and every event goes through ctx.emit.
// ============================================================================

import { DOWNED, INTERACT, SEGMENTS, FEATURES, segmentDistance, yawTo } from '@outpost/shared';
import type {
  DamageSurvivorFn,
  StepDownedFn,
  StepRevivesFn,
  ResolveInteractFn,
  IsSquadWipedFn,
  Survivor,
  SimContext,
  InteractKind,
  PlayerId,
  ZombieId,
} from '@outpost/shared';

function dist2D(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

/**
 * Max vertical gap (metres) between two interacting parties before a floor
 * slab is treated as blocking them. `dist2D` is horizontal-only, so every
 * caller that resolves an interaction across the tower's storeys (revive,
 * weaponRack, ammoCrate) must pair it with this check — otherwise a player
 * standing on deck2 can interact through two solid slabs with whatever sits
 * directly below on the ground floor. Loose enough to tolerate a jump apex
 * (~0.87m, see PLAYER.jumpVel in @fps/shared config) on the SAME floor,
 * tight enough to reject every adjacent-floor gap in the tower (3.6m
 * footing->deck1, 4.0m deck1->deck2 — see FOOTING_H/DECK1_Y/DECK2_Y in
 * @outpost/shared map.ts).
 */
const FLOOR_TOLERANCE = 1.5;

function sameFloor(ay: number, by: number): boolean {
  return Math.abs(ay - by) <= FLOOR_TOLERANCE;
}

/**
 * Emits `dmg_taken` (direction-from-attacker, for the HUD's pain indicator).
 * `damageSurvivor` is the single funnel ALL survivor damage passes through —
 * zombie melee, spit splash, and the debug `hurt` op alike — so it is the
 * only module that can own this emission reliably; no sibling module's brief
 * (fence.ts, horde.ts, combat.ts) claims it, and leaving it unfired here
 * would silently break the UX bible's "take damage -> directional indicator"
 * requirement for every one of those callers.
 */
function emitDmgTaken(ctx: SimContext, victim: Survivor, dmg: number, fromZombie: ZombieId | null): void {
  let yaw = victim.yaw;
  if (fromZombie !== null) {
    const attacker = ctx.zombies[fromZombie];
    if (attacker !== undefined && attacker.alive) {
      yaw = yawTo(victim.body.x, victim.body.z, attacker.body.x, attacker.body.z);
    }
  }
  ctx.emit({ t: 'dmg_taken', victimId: victim.id, dmg, yaw });
}

/**
 * Damage a survivor. `alive` at <=0 hp goes `downed` (full bleedout timer,
 * emits `downed`). A `downed` survivor's hp is already pinned at 0 — hp-delta
 * arithmetic can never re-detect "crossed to <=0" a second time — so ANY
 * further positive damage while downed is treated as a finishing blow and
 * kills them outright (emits `died`), matching DOWNED.damageMul's own doc:
 * "zombies finish them." The multiplier still scales the credited/reported
 * damage (what the pain-flash and any future stat line see), it just does
 * not gate the life/death outcome once already downed.
 */
export const damageSurvivor: DamageSurvivorFn = (ctx, victim, dmg, fromZombie) => {
  if (victim.status === 'dead') return 0;

  const rawDmg = Number.isFinite(dmg) ? Math.max(0, dmg) : 0;
  if (rawDmg <= 0) return 0;

  if (victim.status === 'downed') {
    const credited = rawDmg * DOWNED.damageMul;
    victim.lastDamageAt = ctx.serverTime;
    emitDmgTaken(ctx, victim, credited, fromZombie);

    victim.status = 'dead';
    victim.hp = 0;
    victim.bleedout = 0;
    victim.reviveProgress = 0;
    victim.reviveBy = null;
    victim.returnAtWave = ctx.wave + 1;
    ctx.emit({ t: 'died', id: victim.id });
    return credited;
  }

  // status === 'alive'
  const before = victim.hp;
  const after = Math.max(0, before - rawDmg);
  const credited = before - after;
  victim.hp = after;

  if (credited > 0) {
    victim.lastDamageAt = ctx.serverTime;
    emitDmgTaken(ctx, victim, credited, fromZombie);
  }

  if (after <= 0) {
    victim.status = 'downed';
    victim.bleedout = DOWNED.bleedoutSec;
    victim.reviveProgress = 0;
    victim.reviveBy = null;
    ctx.emit({ t: 'downed', id: victim.id, x: victim.body.x, y: victim.body.y, z: victim.body.z });
  }

  return credited;
};

/** Tick bleedout on every downed survivor; kill those who reach 0 unrevived. */
export const stepDowned: StepDownedFn = (ctx) => {
  for (const s of ctx.survivors.values()) {
    if (s.status !== 'downed') continue;
    s.bleedout = Math.max(0, s.bleedout - ctx.dt);
    if (s.bleedout <= 0) {
      s.status = 'dead';
      s.hp = 0;
      s.reviveProgress = 0;
      s.reviveBy = null;
      s.returnAtWave = ctx.wave + 1;
      ctx.emit({ t: 'died', id: s.id });
    }
  }
};

/**
 * True iff `cand` is, THIS TICK, validly reviving `target`: alive, holding
 * INTERACT, aimed at exactly this target (via `resolveInteract`'s fields —
 * never re-derived here), and within DOWNED.range (centre-to-centre, per
 * that constant's own doc).
 */
function isValidReviver(cand: Survivor, target: Survivor): boolean {
  if (cand.id === target.id) return false;
  if (!cand.connected) return false;
  if (cand.status !== 'alive') return false;
  if (!cand.interacting) return false;
  if (cand.interactKind !== 'revive') return false;
  if (cand.reviveTargetId !== target.id) return false;
  if (!sameFloor(cand.body.y, target.body.y)) return false;
  return dist2D(cand.body.x, cand.body.z, target.body.x, target.body.z) <= DOWNED.range;
}

/**
 * Resolve revive progress for every downed survivor. `reviveBy` is a single
 * PlayerId by construction (see the Survivor struct) — so when two teammates
 * are both holding INTERACT on the same casualty, only ONE is credited per
 * tick: the one already crediting last tick if they are still valid (avoids
 * flicker between two simultaneous revivers), else the first valid one found.
 * Progress resets to 0 the instant no reviver qualifies at all.
 */
export const stepRevives: StepRevivesFn = (ctx) => {
  for (const target of ctx.survivors.values()) {
    if (target.status !== 'downed') continue;

    let reviverId: PlayerId | null = null;
    const prev = target.reviveBy !== null ? ctx.survivors.get(target.reviveBy) : undefined;
    if (prev !== undefined && isValidReviver(prev, target)) {
      reviverId = prev.id;
    } else {
      for (const cand of ctx.survivors.values()) {
        if (isValidReviver(cand, target)) {
          reviverId = cand.id;
          break;
        }
      }
    }

    if (reviverId === null) {
      target.reviveProgress = 0;
      target.reviveBy = null;
      continue;
    }

    target.reviveBy = reviverId;
    target.reviveProgress = Math.min(1, target.reviveProgress + ctx.dt / DOWNED.holdSec);

    if (target.reviveProgress >= 1) {
      const reviver = ctx.survivors.get(reviverId);
      target.status = 'alive';
      target.hp = DOWNED.reviveHp;
      target.bleedout = 0;
      target.reviveProgress = 0;
      target.reviveBy = null;
      if (reviver !== undefined) reviver.revivesGiven += 1;
      ctx.emit({ t: 'revived', id: target.id, byId: reviverId });
    }
  }
};

/**
 * Nearest valid interactable for `s` this tick: a damaged/breached fence
 * segment (via `segmentDistance` — perpendicular distance to the segment's
 * WALL, clamped to its span, NEVER distance to its centre point), a downed
 * teammate, or the weaponRack/ammoCrate feature points. Only an `alive`
 * survivor can interact; downed/dead get `none`. Ties (equal distance)
 * favour repair > revive > weaponRack > ammoCrate, in the order checked
 * below, via a strict `<` on the running best distance.
 */
export const resolveInteract: ResolveInteractFn = (ctx, s) => {
  if (s.status !== 'alive') {
    s.interactKind = 'none';
    s.interactTarget = -1;
    s.reviveTargetId = null;
    return;
  }

  let bestKind: InteractKind = 'none';
  let bestTarget = -1;
  let bestRevive: PlayerId | null = null;
  let bestDist = Infinity;

  for (const seg of ctx.segments) {
    if (seg.hp >= seg.maxHp) continue; // only damaged/breached segments are repairable
    const geom = SEGMENTS[seg.id];
    if (geom === undefined) continue;
    const d = segmentDistance(s.body.x, s.body.z, geom);
    if (d <= INTERACT.repairRange && d < bestDist) {
      bestDist = d;
      bestKind = 'repair';
      bestTarget = seg.id;
      bestRevive = null;
    }
  }

  for (const other of ctx.survivors.values()) {
    if (other.id === s.id || other.status !== 'downed') continue;
    if (!sameFloor(s.body.y, other.body.y)) continue;
    const d = dist2D(s.body.x, s.body.z, other.body.x, other.body.z);
    if (d <= INTERACT.reviveRange && d < bestDist) {
      bestDist = d;
      bestKind = 'revive';
      bestTarget = -1;
      bestRevive = other.id;
    }
  }

  const rack = FEATURES.find((f) => f.key === 'weaponRack');
  if (rack !== undefined && sameFloor(s.body.y, rack.y)) {
    const d = dist2D(s.body.x, s.body.z, rack.x, rack.z);
    if (d <= INTERACT.stationRange && d < bestDist) {
      bestDist = d;
      bestKind = 'weaponRack';
      bestTarget = -1;
      bestRevive = null;
    }
  }

  const crate = FEATURES.find((f) => f.key === 'ammoCrate');
  if (crate !== undefined && sameFloor(s.body.y, crate.y)) {
    const d = dist2D(s.body.x, s.body.z, crate.x, crate.z);
    if (d <= INTERACT.stationRange && d < bestDist) {
      bestDist = d;
      bestKind = 'ammoCrate';
      bestTarget = -1;
      bestRevive = null;
    }
  }

  s.interactKind = bestKind;
  s.interactTarget = bestTarget;
  s.reviveTargetId = bestRevive;
};

/**
 * True only when nobody is both `alive` AND `connected` — i.e. every seated
 * survivor is downed, dead, or a disconnected ghost still flagged `alive`
 * (room.ts's mid-run disconnect path never revises `status`, only
 * `connected`). An empty roster is not "wiped": there is no run in progress
 * to have lost.
 */
export const isSquadWiped: IsSquadWipedFn = (survivors) => {
  if (survivors.size === 0) return false;
  for (const s of survivors.values()) {
    if (s.status === 'alive' && s.connected) return false;
  }
  return true;
};
