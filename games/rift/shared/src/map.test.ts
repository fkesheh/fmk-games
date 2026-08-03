// ============================================================================
// ANCIENTS (rift) — MAP GATE (CONTRACT §3). Every lane count builds a map that
// passes its own validator, mirrored lanes have equal path length, towers land
// on the owning team's half at the frozen fractions, structure ids are dense
// 0..N-1, and validateMap is proven to actually DETECT broken symmetry,
// blocked paths and insufficient clearance (deliberately-broken MapDefs built
// here — the real one is never mutated).
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  ANCIENT_GUARDS,
  BASE_INSET,
  MAP_SIDE_BASE,
  MAP_SIDE_PER_LANE,
  TOWER_LANE_FRACTIONS,
  TOWERS_PER_LANE,
} from './config.js';
import { assertValidMap, buildMap, validateMap } from './map.js';
import type { MapDef, StructureDef, Vec2 } from './types.js';

function pathLength(path: readonly Vec2[]): number {
  let len = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    len += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return len;
}

/** Arc length along the polyline (from path[0]) of the nearest point to
 *  (x, z) — recovers a tower's path fraction from its offset centre. */
function arcFromStart(path: readonly Vec2[], x: number, z: number): number {
  let best = Infinity;
  let bestArc = 0;
  let acc = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const seg = Math.sqrt(len2);
    let t = len2 > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz));
    if (d < best) {
      best = d;
      bestArc = acc + seg * t;
    }
    acc += seg;
  }
  return bestArc;
}

function structuresOf(map: MapDef, team: 0 | 1, kind: StructureDef['kind']): StructureDef[] {
  return map.structures.filter((s) => s.team === team && s.kind === kind);
}

/** Copy a MapDef with a replaced structure list (the input is never mutated). */
function withStructures(map: MapDef, structures: StructureDef[]): MapDef {
  return { lanes: map.lanes, side: map.side, paths: map.paths, structures };
}

describe.each([1, 2, 3])('buildMap(%i lanes)', (lanes) => {
  const map = buildMap(lanes);

  it('passes its own validator (assertValidMap does not throw)', () => {
    expect(() => assertValidMap(map)).not.toThrow();
    expect(validateMap(map).errors).toEqual([]);
  });

  it('has the contract shape: side, lane count, structure counts per team', () => {
    expect(map.side).toBe(MAP_SIDE_BASE + MAP_SIDE_PER_LANE * (lanes - 1));
    expect(map.paths).toHaveLength(lanes);
    for (const team of [0, 1] as const) {
      expect(structuresOf(map, team, 'tower')).toHaveLength(lanes * TOWERS_PER_LANE);
      expect(structuresOf(map, team, 'guard')).toHaveLength(ANCIENT_GUARDS);
      expect(structuresOf(map, team, 'ancient')).toHaveLength(1);
    }
  });

  it('places the ancients on the base diagonal and paths endpoint-to-endpoint', () => {
    const [a0] = structuresOf(map, 0, 'ancient');
    const [a1] = structuresOf(map, 1, 'ancient');
    expect(a0).toMatchObject({ x: BASE_INSET, z: BASE_INSET });
    expect(a1).toMatchObject({ x: map.side - BASE_INSET, z: map.side - BASE_INSET });
    for (const path of map.paths) {
      expect(path[0]).toMatchObject({ x: a0!.x, z: a0!.z });
      expect(path[path.length - 1]).toMatchObject({ x: a1!.x, z: a1!.z });
    }
  });

  it('mirrored lanes have equal path length (1e-9)', () => {
    const lengths = map.paths.map(pathLength);
    if (lanes >= 2) {
      // west-north and south-east edge lanes are mirror images
      const [l0, l1] = lengths;
      expect(Math.abs(l0! - l1!)).toBeLessThanOrEqual(1e-9);
    }
    if (lanes % 2 === 1) {
      // the mid lane is its own mirror: it passes through the map centre
      const mid = map.paths[lanes - 1]!;
      expect(mid[1]).toMatchObject({ x: map.side / 2, z: map.side / 2 });
    }
  });

  it('structure ids are dense 0..N-1', () => {
    const ids = map.structures.map((s) => s.id).sort((a, b) => a - b);
    expect(ids).toEqual(map.structures.map((_, i) => i));
  });

  it('orders ids per contract: team 0 towers/guards/ancient, then team 1', () => {
    const n = lanes * TOWERS_PER_LANE;
    expect(map.structures[0]).toMatchObject({ id: 0, kind: 'tower', team: 0, lane: 0 });
    expect(map.structures[n - 1]).toMatchObject({ kind: 'tower', team: 0, lane: lanes - 1 });
    expect(map.structures[n]).toMatchObject({ kind: 'guard', team: 0, lane: null });
    expect(map.structures[n + ANCIENT_GUARDS]).toMatchObject({ kind: 'ancient', team: 0 });
    expect(map.structures[n + ANCIENT_GUARDS + 1]).toMatchObject({
      kind: 'tower',
      team: 1,
      lane: 0,
    });
    expect(map.structures[map.structures.length - 1]).toMatchObject({
      kind: 'ancient',
      team: 1,
    });
  });

  it('towers land at TOWER_LANE_FRACTIONS from their OWN ancient, on their half', () => {
    for (const team of [0, 1] as const) {
      const towers = structuresOf(map, team, 'tower');
      for (const [i, tower] of towers.entries()) {
        const lane = tower.lane;
        expect(lane).not.toBeNull();
        const path = map.paths[lane!]!;
        const len = pathLength(path);
        const arc = arcFromStart(path, tower.x, tower.z);
        // team 1 measures from the END of the polyline (its own ancient)
        const fracFromOwn = team === 0 ? arc / len : (len - arc) / len;
        const expected = TOWER_LANE_FRACTIONS[i % TOWERS_PER_LANE]!;
        expect(Math.abs(fracFromOwn - expected)).toBeLessThanOrEqual(1e-9);
        expect(expected).toBeLessThan(0.5); // the frozen fractions are own-half
      }
    }
  });
});

describe('buildMap lane-count guard', () => {
  it.each([0, 4, 1.5, Number.NaN])('throws on lanes = %s', (lanes) => {
    expect(() => buildMap(lanes)).toThrow();
  });
});

describe('validateMap detection (broken maps must fail)', () => {
  it('detects a broken mirror symmetry, with the measured distance', () => {
    const map = buildMap(1);
    let moved = false;
    const structures = map.structures.map((s) => {
      if (!moved && s.team === 1 && s.kind === 'tower') {
        moved = true;
        return { ...s, x: s.x + 1.5 };
      }
      return s;
    });
    const v = validateMap(withStructures(map, structures));
    expect(v.ok).toBe(false);
    const symErrors = v.errors.filter((e) => e.includes('mirror counterpart'));
    expect(symErrors.length).toBeGreaterThan(0);
    expect(symErrors.some((e) => e.includes('1.5000 m away'))).toBe(true);
    expect(() => assertValidMap(withStructures(map, structures))).toThrow(/invalid map/);
  });

  it('detects a structure blocking a lane path', () => {
    const map = buildMap(1);
    const blocker: StructureDef = {
      id: map.structures.length,
      kind: 'guard',
      team: 0,
      lane: null,
      x: map.side / 2, // dead centre of the mid lane
      z: map.side / 2,
    };
    const v = validateMap(withStructures(map, [...map.structures, blocker]));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('hero disc walking the lane'))).toBe(true);
  });

  it('detects insufficient edge-to-edge clearance, with the measured gap', () => {
    const map = buildMap(1);
    // drag one team-0 guard 2 m toward its ancient: 7.51 -> 5.51 centre gap,
    // 2.01 m edge-to-edge < STRUCTURE_MARGIN
    const structures = map.structures.map((s) => {
      if (s.team === 0 && s.kind === 'guard') {
        const dx = BASE_INSET - s.x;
        const dz = BASE_INSET - s.z;
        const l = Math.hypot(dx, dz) || 1;
        return { ...s, x: s.x + (dx / l) * 2, z: s.z + (dz / l) * 2 };
      }
      return s;
    });
    const v = validateMap(withStructures(map, structures));
    expect(v.ok).toBe(false);
    const clearance = v.errors.filter((e) => e.includes('edge-to-edge clearance'));
    expect(clearance.length).toBeGreaterThan(0);
    expect(clearance.some((e) => e.includes('2.01 m'))).toBe(true);
  });

  it('detects unequal structure counts per team', () => {
    const map = buildMap(2);
    const structures = map.structures.filter(
      (s) => !(s.team === 1 && s.kind === 'tower' && s.lane === 0),
    );
    const v = validateMap(withStructures(map, structures));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('identical structure counts'))).toBe(true);
  });

  it('detects non-finite geometry without throwing', () => {
    const map = buildMap(1);
    const structures = map.structures.map((s) =>
      s.team === 0 && s.kind === 'guard' ? { ...s, x: Number.NaN } : s,
    );
    const v = validateMap(withStructures(map, structures));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('not finite'))).toBe(true);
  });
});
