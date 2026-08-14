// ============================================================================
// srv-combat — pure shooting resolution.
//
// Wraps @fps/shared's hitscan; never reimplements raycasting. No I/O, no
// Date.now, no timers — everything comes through SimContext.
// ============================================================================
import {
  aimDir,
  applySpread,
  eyePos,
  falloffMul,
  hitscan,
  raycastSolids,
  rng,
  shotSeed,
  type HitscanTarget,
  type WeaponDef,
} from '@fps/shared';
import { ECONOMY, HORDE } from '@outpost/shared';
import type { SimContext, Survivor, Vec3W, ZombieId } from '@outpost/shared';

export interface ZombieTarget extends HitscanTarget {
  zid: ZombieId;
}

// ---------------------------------------------------------------------------
// Object pool backing zombieTargets()/resolveShot(), preallocated to
// HORDE.maxAlive up front — the hard cap on concurrently-alive zombies, so
// this array never grows during play. Kept separate from the caller-supplied
// `out` array so a target object, once allocated, is reused forever
// regardless of how `out` itself is resized between calls (setting
// `out.length` shorter drops array slots, not the objects they pointed at —
// this pool is what makes re-growing `out` free again on the next call).
// ---------------------------------------------------------------------------
const targetPool: ZombieTarget[] = Array.from({ length: HORDE.maxAlive }, () => ({
  id: '',
  x: 0,
  y: 0,
  z: 0,
  height: 0,
  zid: -1,
}));

function pooledTarget(i: number): ZombieTarget {
  let t = targetPool[i];
  if (t === undefined) {
    // Defensive only: ctx.zombies is documented as never exceeding
    // HORDE.maxAlive, so this path should be unreachable in practice.
    t = { id: '', x: 0, y: 0, z: 0, height: 0, zid: -1 };
    targetPool[i] = t;
  }
  return t;
}

/**
 * Living, hittable zombies as HitscanTargets. "Living" excludes both a freed
 * pool slot (`!alive`) and a zombie whose killing blow already landed this
 * tick (`state === 'dying'`) — a corpse mid-death-animation is not a valid
 * target, so a second pellet in the same shotgun blast cannot double-kill it.
 * Fills and returns `out` in place; never allocates once `out` has warmed up
 * to the live zombie count at least once (see targetPool above).
 */
export function zombieTargets(ctx: SimContext, out: ZombieTarget[]): ZombieTarget[] {
  let n = 0;
  for (const z of ctx.zombies) {
    if (!z.alive || z.state === 'dying') continue;
    const t = pooledTarget(n);
    t.id = String(z.id);
    t.x = z.body.x;
    t.y = z.body.y;
    t.z = z.body.z;
    t.height = z.height;
    t.zid = z.id;
    out[n] = t;
    n++;
  }
  out.length = n;
  return out;
}

/** Module-level scratch array — the one resolveShot always fills and reuses. */
const scratchTargets: ZombieTarget[] = [];

/**
 * Resolve one trigger pull for survivor `s` firing `def`. Builds live-zombie
 * targets, fires `def.pellets` hitscan rays (1 for everything but the
 * shotgun), applies falloff + the weapon's own headshotMul to damage, and on
 * a kill awards `ECONOMY.killScrap[kind]` (x `ECONOMY.headshotMul` on a
 * headshot). A hit that damages but does not kill awards proportional
 * "assist" scrap per `ECONOMY.assistScrapPer100`. Emits `shot` once per call,
 * `hit` per connecting pellet, and `zombie_died` on every kill. Never throws.
 */
export function resolveShot(ctx: SimContext, s: Survivor, def: WeaponDef): void {
  const targets = zombieTargets(ctx, scratchTargets);
  const eye = eyePos(s.body);
  const aim = aimDir(s.yaw, s.pitch);
  // Knife reaches exactly its falloff end; firearms get a generous flat cap —
  // SimContext carries no separate range budget for this to clamp against.
  const maxDist = def.id === 'knife' ? def.rangeEnd : 200;
  const spread = Math.min(def.spreadDeg + s.bloom, def.maxSpreadDeg);
  const seed = shotSeed(ctx.tick, s.shotSeq);

  // Tracer endpoint: the UNSPREAD aim ray against solids only, independent of
  // which pellet (if any) actually connects — mirrors STRICKEN's wallEndPoint.
  const wallDist = raycastSolids(eye, aim, ctx.solids, maxDist);
  const tracerDist = wallDist >= 0 ? wallDist : maxDist;
  const from: Vec3W = { x: eye.x, y: eye.y, z: eye.z };
  const to: Vec3W = {
    x: eye.x + aim.x * tracerDist,
    y: eye.y + aim.y * tracerDist,
    z: eye.z + aim.z * tracerDist,
  };
  ctx.emit({ t: 'shot', shooterId: s.id, weapon: def.id, from, to });

  for (let i = 0; i < def.pellets; i++) {
    const dir = applySpread(aim, spread, rng(seed + i));
    const hit = hitscan(eye, dir, targets, ctx.solids, maxDist);
    if (hit === null) continue;

    let zt: ZombieTarget | undefined;
    for (const t of targets) {
      if (t.id === hit.targetId) {
        zt = t;
        break;
      }
    }
    if (zt === undefined) continue;
    const zombie = ctx.zombies[zt.zid];
    // Already killed by an earlier pellet in this same shot, or otherwise gone.
    if (zombie === undefined || !zombie.alive || zombie.state === 'dying') continue;

    const dmg = Math.max(
      1,
      Math.round(
        def.damage *
          falloffMul(hit.dist, def.rangeStart, def.rangeEnd, def.minDmgMul) *
          (hit.headshot ? def.headshotMul : 1),
      ),
    );
    zombie.hp = Math.max(0, zombie.hp - dmg);
    s.damageDealt += dmg;

    const killed = zombie.hp <= 0;
    if (killed) {
      zombie.state = 'dying';
      zombie.dyingFor = 0;
      zombie.targetSeg = -1;
      zombie.targetPlayer = null;
      s.kills += 1;
      if (hit.headshot) s.headshots += 1;
      const baseScrap = ECONOMY.killScrap[zombie.kind];
      const scrap = hit.headshot ? Math.round(baseScrap * ECONOMY.headshotMul) : baseScrap;
      s.scrap += scrap;
      ctx.emit({
        t: 'zombie_died',
        zombieId: zombie.id,
        kind: zombie.kind,
        x: zombie.body.x,
        y: zombie.body.y,
        z: zombie.body.z,
        byId: s.id,
        scrap,
      });
    } else {
      const assist = Math.round((dmg / 100) * ECONOMY.assistScrapPer100);
      if (assist > 0) s.scrap += assist;
    }

    ctx.emit({ t: 'hit', shooterId: s.id, zombieId: zombie.id, dmg, headshot: hit.headshot, killed });
  }
}
