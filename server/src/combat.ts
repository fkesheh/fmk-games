// ============================================================================
// S3 — combat resolution: lag-compensation history buffer + authoritative
// hitscan shot resolution. PURE: no I/O, no Date.now, no timers.
// Used by game.ts (S2): LagBuffer fed every tick, resolveShot per trigger pull.
// ============================================================================
import {
  aimDir,
  applySpread,
  falloffMul,
  hitscan,
  raycastSolids,
  rng,
  type AABB,
  type HitscanTarget,
  type PlayerId,
  type Vec3,
  type WeaponDef,
} from '@fps/shared';

/** One stored world state: where every player stood at a given server tick. */
interface LagFrame {
  tick: number;
  entries: HitscanTarget[]; // private copies; treated as read-only
}

/**
 * Ring buffer of recent per-tick player positions for lag compensation.
 * Ticks are pushed monotonically increasing (game loop order). Keeps at most
 * maxTicks frames (NET.lagBufferTicks); older frames are evicted oldest-first.
 */
export class LagBuffer {
  private readonly maxTicks: number;
  private frames: LagFrame[] = []; // ascending tick order

  constructor(maxTicks: number) {
    this.maxTicks = Math.max(1, maxTicks);
  }

  push(
    tick: number,
    entries: Array<{ id: PlayerId; x: number; y: number; z: number; height: number }>,
  ): void {
    // Copy entries: the caller may reuse/mutate its own objects after push.
    const copied = entries.map((e) => ({ id: e.id, x: e.x, y: e.y, z: e.z, height: e.height }));
    const last = this.frames[this.frames.length - 1];
    if (last !== undefined && tick === last.tick) {
      last.entries = copied; // idempotent re-push of the same tick
      return;
    }
    if (last !== undefined && tick < last.tick) return; // stale tick, never happens in tick order
    this.frames.push({ tick, entries: copied });
    while (this.frames.length > this.maxTicks) this.frames.shift();
  }

  /**
   * World state at the stored tick nearest to but NOT newer than `tick`
   * (i.e. the latest frame with frame.tick <= tick), excluding excludeId
   * (the shooter). Empty buffer / no frame old enough => [].
   */
  at(tick: number, excludeId: PlayerId): HitscanTarget[] {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i];
      if (frame === undefined || frame.tick > tick) continue;
      return frame.entries.filter((e) => e.id !== excludeId);
    }
    return [];
  }
}

export interface ShotContext {
  tick: number;
  shooterId: PlayerId;
  origin: Vec3; // shooter eye
  yaw: number;
  pitch: number;
  weapon: WeaponDef;
  bloomDeg: number; // accumulated spread bloom from consecutive shots
  scoped: boolean;
  targets: HitscanTarget[]; // already lag-compensated by the caller, shooter excluded
  solids: AABB[];
  maxDist: number; // caller cap; firearms are clamped to 200 (see below)
}

export interface ShotHit {
  targetId: PlayerId;
  dmg: number;
  headshot: boolean;
  point: Vec3;
  dist: number;
}

/**
 * Resolve one trigger pull. Deterministic for a given (ctx, seed): pellet i
 * uses rng(seed + i) so server resolution matches the client's bloom model.
 * - effectiveSpread = scoped && weapon.scopedSpreadDeg != null
 *     ? scopedSpreadDeg : min(spreadDeg + bloomDeg, maxSpreadDeg)
 * - each pellet: hitscan vs targets, blocked by solids
 * - dmg = max(1, round(damage * falloffMul(dist, ...) * (headshot ? headshotMul : 1)))
 */
export function resolveShot(ctx: ShotContext, seed: number): ShotHit[] {
  const w = ctx.weapon;
  // Knife reaches exactly its falloff end; anything else gets a generous cap.
  const maxDist = w.id === 'knife' ? w.rangeEnd : Math.min(ctx.maxDist, 200);
  const spread =
    ctx.scoped && w.scopedSpreadDeg != null
      ? w.scopedSpreadDeg
      : Math.min(w.spreadDeg + ctx.bloomDeg, w.maxSpreadDeg);
  const aim = aimDir(ctx.yaw, ctx.pitch);

  const hits: ShotHit[] = [];
  for (let i = 0; i < w.pellets; i++) {
    const dir = applySpread(aim, spread, rng(seed + i));
    const hit = hitscan(ctx.origin, dir, ctx.targets, ctx.solids, maxDist);
    if (hit === null) continue;
    const dmg = Math.max(
      1,
      Math.round(
        w.damage *
          falloffMul(hit.dist, w.rangeStart, w.rangeEnd, w.minDmgMul) *
          (hit.headshot ? w.headshotMul : 1),
      ),
    );
    hits.push({ targetId: hit.targetId, dmg, headshot: hit.headshot, point: hit.point, dist: hit.dist });
  }
  return hits;
}

/**
 * Where a tracer should visually stop along dir: the nearest solid hit, else
 * the ray's far end at maxDist. Independent of player targets.
 */
export function wallEndPoint(origin: Vec3, dir: Vec3, solids: AABB[], maxDist: number): Vec3 {
  const d = raycastSolids(origin, dir, solids, maxDist);
  const t = d >= 0 ? d : maxDist;
  return { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
}
