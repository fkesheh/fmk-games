// ============================================================================
// srv-fence — pure fence system.
//
// damageSegment / repairSegment / fenceSolids / nearestSegment. Everything
// here reads its numbers from ECONOMY / FENCE (@outpost/shared/config) and
// its geometry from SEGMENTS / segmentAABB / segmentDistance
// (@outpost/shared/map) — see CONTRACT.md "server/src/fence.ts" and
// DESIGN_BIBLE.md "The fence clock" / "Economy pacing (solo)".
//
// Breaching (damageSegment reaching <= 0 hp) is the one moment this module
// touches state outside the segment itself: it clears `targetSeg` on every
// zombie pointing at the segment that just breached (a dangling target is
// the #1 crash class per CONTRACT.md) and asks the room to rebuild `solids`
// via `ctx.rebuildSolids()`, since a breached segment stops colliding.
// ============================================================================

import type { AABB } from '@fps/shared';
import type {
  DamageSegmentFn,
  FenceSegment,
  FenceSolidsFn,
  NearestSegmentFn,
  RepairSegmentFn,
  SegmentGeom,
} from '@outpost/shared';
import { ECONOMY, SEGMENTS, segmentAABB, segmentDistance } from '@outpost/shared';

/** SEGMENTS is built once as a dense array whose index === SegmentId. */
const GEOM_BY_ID: readonly SegmentGeom[] = SEGMENTS;

/**
 * Apply `dmg` (already time-scaled by the caller — fence damage is
 * CONTINUOUS, `FENCE.damageIsContinuous`, so `horde.ts` passes
 * `ZOMBIE_BASE[kind].fenceDps * dt` per zombie in contact, per tick) to a
 * segment.
 *
 * A no-op on an out-of-range id, a non-positive `dmg`, or a segment that is
 * ALREADY breached: a breached segment has no hp left to lose, and while it
 * is being rebuilt (`hp` climbing back up under `repairSegment`) it must not
 * be re-damaged by a caller still tracking a stale attack — zombies clear
 * their `targetSeg` the instant a segment breaches, so a live caller should
 * never reach this branch, but a defensive no-op is cheap and keeps this
 * function safe against any future caller that does not honour that.
 *
 * On reaching <= 0 hp: clamps hp to 0, sets `breached`, clears `targetSeg`
 * on every zombie that was pointing at this segment, emits `seg_breached`,
 * and calls `ctx.rebuildSolids()` so `solids` drops this segment's AABB.
 */
export const damageSegment: DamageSegmentFn = (ctx, seg, dmg) => {
  const segment = ctx.segments[seg];
  if (!segment || dmg <= 0 || segment.breached) return;

  segment.hp = Math.max(0, segment.hp - dmg);
  segment.sinceHit = 0;
  ctx.emit({ t: 'seg_hit', seg, hp: segment.hp });

  if (segment.hp <= 0) {
    segment.hp = 0;
    segment.breached = true;
    segment.rebuild = 0;

    for (const z of ctx.zombies) {
      if (z.alive && z.targetSeg === seg) z.targetSeg = -1;
    }

    ctx.emit({ t: 'seg_breached', seg });
    ctx.rebuildSolids();
  }
};

/**
 * One tick of survivor `s` holding INTERACT on segment `seg`. Charges
 * `ECONOMY.repairScrapPerHp` per hp continuously (this tick's worth only —
 * `ECONOMY.repairHpPerSec * ctx.dt`), clamped to the hp actually missing.
 *
 * A BREACHED segment rebuilds at `ECONOMY.rebuildRateMul` of the normal
 * speed and `ECONOMY.rebuildCostMul` of the normal cost per hp — the
 * "letting a segment breach is roughly a wave's income" pressure from
 * DESIGN_BIBLE.md. It only un-breaches once `hp` reaches `maxHp` exactly;
 * until then `rebuild` (0..1) tracks progress for the client's fence ring.
 *
 * Returns the hp actually restored, which is 0 when there is nothing left
 * to repair OR the survivor cannot afford this tick's cost — in the latter
 * case NEITHER scrap NOR hp move; the caller is responsible for emitting
 * the deny feedback. Never applies a partial amount for a partially
 * affordable tick: an all-or-nothing tick keeps `s.scrap` from a decision
 * this function did not make (how much of the tick to sell).
 */
export const repairSegment: RepairSegmentFn = (ctx, s, seg) => {
  const segment: FenceSegment | undefined = ctx.segments[seg];
  if (!segment) return 0;

  const hpRoom = segment.maxHp - segment.hp;
  if (hpRoom <= 0) return 0;

  const rateMul = segment.breached ? ECONOMY.rebuildRateMul : 1;
  const costMul = segment.breached ? ECONOMY.rebuildCostMul : 1;

  const hpWanted = ECONOMY.repairHpPerSec * rateMul * ctx.dt;
  const hpToApply = Math.min(hpWanted, hpRoom);
  if (hpToApply <= 0) return 0;

  const scrapCost = hpToApply * ECONOMY.repairScrapPerHp * costMul;
  if (scrapCost > s.scrap) return 0;

  s.scrap -= scrapCost;
  segment.hp += hpToApply;
  s.repairHp += hpToApply;

  const nowFull = segment.hp >= segment.maxHp;
  if (segment.breached) {
    segment.rebuild = nowFull ? 1 : segment.hp / segment.maxHp;
    if (nowFull) {
      segment.breached = false;
      ctx.rebuildSolids();
    }
  }

  ctx.emit({ t: 'seg_repaired', seg, byId: s.id, full: nowFull });
  return hpToApply;
};

/** The AABBs of every INTACT segment, in segment order. Breached segments contribute none. */
export const fenceSolids: FenceSolidsFn = (segments) => {
  const out: AABB[] = [];
  for (const segment of segments) {
    if (segment.breached) continue;
    const geom = GEOM_BY_ID[segment.id];
    if (!geom) continue;
    out.push(segmentAABB(geom));
  }
  return out;
};

/**
 * Nearest segment to world point `(x, z)`, measured by `segmentDistance` —
 * perpendicular distance to the segment's WALL clamped to its 10 m span,
 * NEVER distance to `SegmentGeom.cx/cz` (a centre point; see that helper's
 * doc for why a centre-point reading silently un-repairs half of every
 * segment). Walks the frozen, never-empty `SEGMENTS` geometry table, so a
 * result always exists.
 */
export const nearestSegment: NearestSegmentFn = (x, z) => {
  let bestId = 0;
  let bestDist = Infinity;
  for (const geom of SEGMENTS) {
    const d = segmentDistance(x, z, geom);
    if (d < bestDist) {
      bestDist = d;
      bestId = geom.id;
    }
  }
  return { seg: bestId, dist: bestDist };
};
