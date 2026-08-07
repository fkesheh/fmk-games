// ============================================================================
// ANCIENTS (rift) — VISION (T5). Fog-of-war filter sets, one per team,
// recomputed every tick and REUSED by the caller (computeTeamVisible clears
// and refills `out`; this module never allocates per call — the per-source
// scratch is a module-level pool reused across calls; the room calls this
// twice per tick, sequentially, so sharing the pool is safe).
//
// Semantics (CONTRACT §4 vision.ts bullet):
//   - vision sources: own LIVING heroes, creeps, summons, wards, structures,
//     with radii from config (HERO_VISION, creep/summon vision, WARD_VISION,
//     TOWER/GUARD/ANCIENT vision); squared distances, no sqrt.
//   - structures are never in the set (they are always sent in snapshots);
//     dead sources provide no vision.
//   - own-team mobiles are always visible to their own team (dead or alive).
//   - wards are NEVER visible to the enemy team, even inside a vision radius.
//   - 'proj' ents are in-flight ability effects, not intel: they are visible
//     to both teams unconditionally so clients can render the flight.
//
// TERRAIN (TERRAIN_CONTRACT §4, DESIGN_DELTA §1/§3/§5) adds three modifiers,
// and ONLY inside the "can viewer V see entity E" test. Pass 1 (collecting the
// viewers) is untouched, and the two bypasses above — own team, projectiles —
// are never subject to terrain.
//
//   1. NIGHT scales the radius BEFORE the range test, for heroes, creeps,
//      summons and camp creeps; wards, towers, guards and ancients are lit
//      installations and keep full radius (DESIGN_DELTA §5).
//   2. UPHILL BLOCK is a veto after the range test: low never sees high, high
//      sees low freely, equal elevations are unaffected.
//   3. CONCEALMENT is a veto after that: a foliage cell hides its occupant from
//      viewers farther than CONCEAL_REVEAL_RADIUS, unless the viewer is itself
//      concealed or is looking DOWN from high ground (config.ts's three
//      exceptions), and unless the target swung last tick — attacking reveals.
//      The look-down exception excludes a viewer standing on a RAMP
//      (AMENDMENT_1 §C): `elevationAt` reads a ramp as ELEV_HIGH, so without
//      that narrowing anyone on any ramp would see through every bush on the
//      map. A ramp still counts as high ground for the uphill veto — only the
//      foliage exemption is narrowed.
//
// A veto is absolute: it is not a range penalty, and no combination of vetoes
// ever ADDS visibility. Structures and enemy wards never reach the concealment
// test at all (structures are not in `mobiles()`, enemy wards are dropped
// earlier), so "structures and wards are never concealed" holds by
// construction rather than by a special case.
// ============================================================================
import {
  ANCIENT,
  CAMP_BRUTE,
  CAMP_HIVE,
  CAMP_PACK,
  CONCEAL_REVEAL_RADIUS,
  CREEP_MELEE,
  CREEP_RANGED,
  CREEP_SIEGE,
  GUARD_TOWER,
  HERO_VISION,
  SUMMON_SHADE,
  TOWER,
  WARD_VISION,
  dayPhase,
  elevationAt,
  isConcealing,
  kindAt,
  nightVisionScale,
} from '@rift/shared';
import type { EntKind, TeamId, TerrainDef } from '@rift/shared';
import { NO_ENT } from './types.js';
import type { Ent, EntId, World } from './types.js';

/** Vision radius of a source entity, from config by kind.
 *
 *  Exported for the suite only, and deliberately: `computeTeamVisible` takes a
 *  `TeamId`, so a NEUTRAL_TEAM camp creep can never be collected as a viewer
 *  and the three camp arms below are unreachable through the frozen seam. They
 *  are not dead code — the switch is exhaustive over `EntKind` with no default,
 *  so dropping an arm makes the return type `number | undefined` and fails the
 *  build — but the only way to pin what they return is to call this directly.
 *  Nothing in `server/` imports it; `computeTeamVisible` stays the seam. */
export function visionRadius(e: Pick<Ent, 'kind'>): number {
  switch (e.kind) {
    case 'hero':
      return HERO_VISION;
    case 'melee':
      return CREEP_MELEE.vision;
    case 'ranged':
      return CREEP_RANGED.vision;
    case 'siege':
      return CREEP_SIEGE.vision;
    case 'shade':
      return SUMMON_SHADE.vision;
    case 'ward':
      return WARD_VISION;
    case 'tower':
      return TOWER.vision;
    case 'guard':
      return GUARD_TOWER.vision;
    case 'ancient':
      return ANCIENT.vision;
    case 'campPack':
      return CAMP_PACK.vision;
    case 'campBrute':
      return CAMP_BRUTE.vision;
    case 'campHive':
      return CAMP_HIVE.vision;
    case 'proj':
      return 0;
  }
}

/** Does night shrink this kind's radius? DESIGN_DELTA §5 names the exceptions
 *  positively — "structures and wards are unaffected, they are lit" — so the
 *  false arm is the closed list (ward, tower, guard, ancient) and everything
 *  with living eyes scales. 'proj' is never a source; its arm is a formality.
 *  Exported for the suite for the same reason as `visionRadius` above. */
export function scalesAtNight(kind: EntKind): boolean {
  switch (kind) {
    case 'hero':
    case 'melee':
    case 'ranged':
    case 'siege':
    case 'shade':
    case 'campPack':
    case 'campBrute':
    case 'campHive':
      return true;
    case 'ward':
    case 'tower':
    case 'guard':
    case 'ancient':
    case 'proj':
      return false;
  }
}

/** Is `e` a living vision source for its team? Dead heroes/creeps/wards and
 *  destroyed structures see nothing; projectiles are effects, not eyes. */
function isSource(e: Ent): boolean {
  return e.alive && e.kind !== 'proj';
}

/** Beyond this distance a foliage cell hides its occupant; inside it, an enemy
 *  is close enough to see what it is standing next to (config.ts's "unless the
 *  enemy is adjacent"). Squared once, at module load, for the inner loop. */
const CONCEAL_REVEAL_R2 = CONCEAL_REVEAL_RADIUS * CONCEAL_REVEAL_RADIUS;

/** Everything the inner loop needs from one vision source, flattened to
 *  numbers so the loop touches no `Ent` and no terrain query per pair. */
interface Viewer {
  x: number;
  z: number;
  /** Squared radius, night scale already applied. */
  r2: number;
  /** ELEV_LOW | ELEV_HIGH at the viewer's own cell. */
  elev: number;
  /** Viewer stands in foliage itself, so foliage does not hide from it. */
  concealed: boolean;
  /** Viewer stands on a ramp. Its `elev` is ELEV_HIGH (a ramp reads as high
   *  ground, one value — terrain.ts §3), which is right for the uphill veto but
   *  wrong for the look-down foliage exemption: a ramp is a slope up out of the
   *  low ground, not a vantage over it. AMENDMENT_1 §C. */
  onRamp: boolean;
}

/** Pool of Viewer records, grown once to the largest source count ever seen
 *  and never released. `viewers` is the active window into it: `length = 0`
 *  plus `push` of an ALREADY POOLED object, so a steady-state tick allocates
 *  nothing and the loop below can iterate it with `for..of` without an
 *  index-undefined narrowing in the hot path. Single-threaded sim, two
 *  sequential calls per tick — no reentrancy. */
const viewerPool: Viewer[] = [];
const viewers: Viewer[] = [];

/** Next free pooled Viewer, appended to the active window. */
function pushViewer(): Viewer {
  const i = viewers.length;
  const pooled = viewerPool[i];
  if (pooled !== undefined) {
    viewers.push(pooled);
    return pooled;
  }
  const fresh: Viewer = { x: 0, z: 0, r2: 0, elev: 0, concealed: false, onRamp: false };
  viewerPool.push(fresh);
  viewers.push(fresh);
  return fresh;
}

/** Frozen seam (CONTRACT §4): clears `out` and fills it with the MOBILE
 *  entity ids visible to `team`. Structures are never added. The caller
 *  keeps two sets (one per team) and reuses them every tick. */
export function computeTeamVisible(world: World, team: TeamId, out: Set<EntId>): void {
  out.clear();
  const terrain: TerrainDef = world.map.terrain;
  // AMENDMENT_1 §B.1: the cycle has exactly one definition, in config.ts, and
  // room.ts puts that same value on the wire — the sim's night and the client's
  // lighting can no longer drift.
  const night = nightVisionScale(dayPhase(world.tick));

  // Pass 1 — collect this team's living sources, with their radius (night
  // applied), their own elevation, concealment and ramp-ness resolved once.
  // Camp creeps carry NEUTRAL_TEAM and `team` is a TeamId, so the jungle is
  // never a viewer for either player team; it is only ever a target below.
  viewers.length = 0;
  for (const e of world.all()) {
    if (e.team !== team || !isSource(e)) continue;
    const r = scalesAtNight(e.kind) ? visionRadius(e) * night : visionRadius(e);
    const v = pushViewer();
    v.x = e.x;
    v.z = e.z;
    v.r2 = r * r;
    v.elev = elevationAt(terrain, e.x, e.z);
    v.concealed = isConcealing(terrain, e.x, e.z);
    v.onRamp = kindAt(terrain, e.x, e.z) === 'ramp';
  }

  // Pass 2 — one test per (enemy mobile, viewer) pair.
  for (const m of world.mobiles()) {
    if (m.kind === 'proj' || m.team === team) {
      out.add(m.id);
      continue;
    }
    // Enemy mobile: wards are invisible to the enemy no matter what; the
    // dead leave no corpse on the wire (the kill event already carried it).
    if (m.kind === 'ward' || !m.alive) continue;
    const mElev = elevationAt(terrain, m.x, m.z);
    // `atkTarget` is cleared at the top of every stepCombat and set on the
    // swing, and computeTeamVisible runs BEFORE advance() — so a non-NO_ENT
    // value here means "swung during the previous tick". Attacking reveals;
    // casting does not (DESIGN_DELTA §3).
    const hidden = m.atkTarget === NO_ENT && isConcealing(terrain, m.x, m.z);
    for (const v of viewers) {
      const dx = m.x - v.x;
      const dz = m.z - v.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > v.r2) continue;
      // Uphill veto: low ground never sees high ground, at any range.
      if (v.elev < mElev) continue;
      // Concealment veto: the viewer is at or below the target's level here
      // (the uphill veto already returned on the rest), so `v.elev <= mElev`
      // is exactly "not looking down into the bush". A viewer on a ramp reads
      // as high but is not looking down, so it never earns the exemption.
      if (hidden && d2 > CONCEAL_REVEAL_R2 && !v.concealed && (v.elev <= mElev || v.onRamp)) {
        continue;
      }
      out.add(m.id);
      break;
    }
  }
}
