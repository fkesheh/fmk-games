// ============================================================================
// ANCIENTS (rift) — VISION (T5). Fog-of-war filter sets, one per team,
// recomputed every tick and REUSED by the caller (computeTeamVisible clears
// and refills `out`; this module never allocates per call — source candidates
// go into a module-level scratch array reused across calls; the room calls
// this twice per tick, sequentially, so sharing the scratch is safe).
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
// ============================================================================
import {
  ANCIENT,
  CREEP_MELEE,
  CREEP_RANGED,
  CREEP_SIEGE,
  GUARD_TOWER,
  HERO_VISION,
  SUMMON_SHADE,
  TOWER,
  WARD_VISION,
} from '@rift/shared';
import type { TeamId } from '@rift/shared';
import type { Ent, EntId, World } from './types.js';

/** Vision radius of a source entity, from config by kind. Callers only ever
 *  ask about kinds that are legal sources; 'proj' is never a source. */
function visionRadius(e: Ent): number {
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
    case 'proj':
      return 0;
  }
}

/** Is `e` a living vision source for its team? Dead heroes/creeps/wards and
 *  destroyed structures see nothing; projectiles are effects, not eyes. */
function isSource(e: Ent): boolean {
  return e.alive && e.kind !== 'proj';
}

/** Reused across calls; never escapes the module. Single-threaded sim, two
 *  sequential calls per tick — no reentrancy. */
const sourceScratch: Ent[] = [];

/** Frozen seam (CONTRACT §4): clears `out` and fills it with the MOBILE
 *  entity ids visible to `team`. Structures are never added. The caller
 *  keeps two sets (one per team) and reuses them every tick. */
export function computeTeamVisible(world: World, team: TeamId, out: Set<EntId>): void {
  out.clear();
  sourceScratch.length = 0;
  for (const e of world.all()) {
    if (e.team === team && isSource(e)) sourceScratch.push(e);
  }
  for (const m of world.mobiles()) {
    if (m.kind === 'proj' || m.team === team) {
      out.add(m.id);
      continue;
    }
    // Enemy mobile: wards are invisible to the enemy no matter what; the
    // dead leave no corpse on the wire (the kill event already carried it).
    if (m.kind === 'ward' || !m.alive) continue;
    for (const s of sourceScratch) {
      const r = visionRadius(s);
      const dx = m.x - s.x;
      const dz = m.z - s.z;
      if (dx * dx + dz * dz <= r * r) {
        out.add(m.id);
        break;
      }
    }
  }
}
