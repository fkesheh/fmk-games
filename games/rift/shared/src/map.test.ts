// ============================================================================
// ANCIENTS (rift) — MAP GATE (CONTRACT §3, TERRAIN_CONTRACT §3). Every lane
// count builds a map that passes its own validator, mirrored lanes have equal
// path length, towers land on the owning team's half at the frozen fractions,
// structure ids are dense 0..N-1, and validateMap is proven to actually DETECT
// broken symmetry, blocked paths and insufficient clearance
// (deliberately-broken MapDefs built here — the real one is never mutated).
//
// The terrain half of this file re-derives TERRAIN_CONTRACT §3's six rules from
// the frozen queries (kindAt / elevationAt / isPassable) and from the raw grid,
// on purpose: validateMap is the PRODUCTION implementation of those rules, so a
// suite that only called validateMap would assert that the validator agrees
// with itself. These walk the grid independently and would catch a validator
// that silently stopped checking — and the detection block at the bottom then
// proves the validator still fires on a deliberately broken grid.
//
// DETECTION COVERAGE. The terrain detection block covers all six terrain rules
// — 6 mirror, 7 lane pathability, 8 connectivity, 9 concave traps, 10 camp
// isolation, 11 elevation coherence — plus the grid-covers-the-square
// precondition that gates them. Every one of those tests asserts on the string
// that rule ALONE emits, so deleting any single rule from validateMap turns
// exactly one test red rather than being absorbed by a sibling rule that
// happens to also fire on the same fixture. Each fixture below is minimal: it
// breaks the fewest cells or structures that can express the defect, so the
// error it names is the error it caused.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  ANCIENT_GUARDS,
  BASE_INSET,
  CAMPS_PER_HALF,
  CAMP_LANE_CLEARANCE,
  HERO_RADIUS,
  MAP_SIDE_BASE,
  MAP_SIDE_PER_LANE,
  TOWER_LANE_FRACTIONS,
  TOWERS_PER_LANE,
} from './config.js';
import { assertValidMap, buildMap, validateMap } from './map.js';
import {
  ELEV_HIGH,
  ELEV_LOW,
  TERRAIN_KINDS,
  buildTerrain,
  elevationAt,
  isPassable,
  kindAt,
} from './terrain.js';
import type { CampDef, TerrainDef, TerrainKind } from './terrain.js';
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

/** Copy a MapDef with a replaced structure list (the input is never mutated).
 *  `terrain` is REQUIRED on every MapDef (TERRAIN_CONTRACT §2) and is carried
 *  through untouched: these fixtures break structures, not the grid. */
function withStructures(map: MapDef, structures: StructureDef[]): MapDef {
  return {
    lanes: map.lanes,
    side: map.side,
    paths: map.paths,
    structures,
    terrain: map.terrain,
  };
}

/** Copy a MapDef with a replaced terrain (the input is never mutated). */
function withTerrain(map: MapDef, terrain: TerrainDef): MapDef {
  return {
    lanes: map.lanes,
    side: map.side,
    paths: map.paths,
    structures: map.structures,
    terrain,
  };
}

// ---- terrain test helpers (TERRAIN_CONTRACT §3) ------------------------------
// Cells are addressed the way the frozen queries address them: by the WORLD
// position of a cell centre, never by reaching into the arrays with index
// arithmetic — except in the two places that are explicitly about the raw
// bytes (mirror bit-equality and determinism), where the point IS the bytes.

/** The four orthogonal neighbours. Movement, the wall-slide and the flood fill
 *  are all 4-connected: a diagonal touch is not a crossing a unit can walk. */
const NBRS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/** World centre of cell `i` on either axis. The reflection of a centre through
 *  the map centre is exactly another centre, which is why the mirror rule can
 *  compare kinds and elevations with no tolerance at all. */
function mid(i: number, res: number): number {
  return (i + 0.5) / res;
}

/** Cell index containing world coordinate `v`, clamped like the frozen queries. */
function cellIndex(v: number, res: number, dim: number): number {
  const i = Math.floor(v * res);
  if (!(i > 0)) return 0; // also catches NaN
  return i > dim - 1 ? dim - 1 : i;
}

/** The point `arc` metres along the polyline, clamped to its two endpoints. */
function walkPath(path: readonly Vec2[], arc: number): Vec2 {
  const first = path[0]!;
  if (arc <= 0) return first;
  let acc = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (acc + seg >= arc) {
      const t = seg > 0 ? (arc - acc) / seg : 0;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    }
    acc += seg;
  }
  return path[path.length - 1]!;
}

/** Shortest distance from (x, z) to a polyline (segment-wise, not vertex-wise). */
function distToPolyline(path: readonly Vec2[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz));
    if (d < best) best = d;
  }
  return best;
}

/** A deep, MUTABLE copy of a terrain: the fixtures below break a copy so the
 *  real grid — shared by every other test in this file — is never touched. */
function cloneTerrain(t: TerrainDef): {
  readonly def: TerrainDef;
  readonly kind: Uint8Array;
  readonly elev: Uint8Array;
} {
  const kind = Uint8Array.from(t.grid.kind);
  const elev = Uint8Array.from(t.grid.elev);
  return {
    def: {
      grid: { side: t.grid.side, res: t.grid.res, dim: t.grid.dim, kind, elev },
      camps: t.camps,
      landmarks: t.landmarks,
    },
    kind,
    elev,
  };
}

/** Terrain with a replaced camp list; the grid is shared, unmodified. */
function withCamps(t: TerrainDef, camps: readonly CampDef[]): TerrainDef {
  return { grid: t.grid, camps, landmarks: t.landmarks };
}

/** Numeric code of a kind — the value stored in `TerrainGrid.kind`. */
function codeOf(kind: TerrainKind): number {
  const code = TERRAIN_KINDS.indexOf(kind);
  if (code < 0) throw new Error(`unknown terrain kind '${kind}'`);
  return code;
}

/** Passable cells reachable by a 4-connected flood fill from (x, z). */
function floodFrom(t: TerrainDef, x: number, z: number): Uint8Array {
  const { dim, res } = t.grid;
  const seen = new Uint8Array(dim * dim);
  const si = cellIndex(x, res, dim);
  const sj = cellIndex(z, res, dim);
  if (!isPassable(t, mid(si, res), mid(sj, res))) return seen;
  const start = sj * dim + si;
  seen[start] = 1;
  const stack: number[] = [start];
  while (stack.length > 0) {
    const p = stack.pop();
    if (p === undefined) break; // length > 0 guarantees a value; narrowing only
    const pi = p % dim;
    const pj = (p - pi) / dim;
    for (const [di, dj] of NBRS) {
      const ni = pi + di;
      const nj = pj + dj;
      if (ni < 0 || ni >= dim || nj < 0 || nj >= dim) continue;
      const q = nj * dim + ni;
      if (seen[q] === 1) continue;
      if (!isPassable(t, mid(ni, res), mid(nj, res))) continue;
      seen[q] = 1;
      stack.push(q);
    }
  }
  return seen;
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
      // (named midLane, not mid: `mid(i, res)` is the cell-centre helper below)
      const midLane = map.paths[lanes - 1]!;
      expect(midLane[1]).toMatchObject({ x: map.side / 2, z: map.side / 2 });
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
    // Minimal fixture: drag EXACTLY ONE team-0 guard 2 m toward its ancient.
    // 7.51 -> 5.51 m centre gap, 2.01 m edge-to-edge < STRUCTURE_MARGIN.
    let dragged = false;
    const structures = map.structures.map((s) => {
      if (!dragged && s.team === 0 && s.kind === 'guard') {
        dragged = true;
        const dx = BASE_INSET - s.x;
        const dz = BASE_INSET - s.z;
        const l = Math.hypot(dx, dz) || 1;
        return { ...s, x: s.x + (dx / l) * 2, z: s.z + (dz / l) * 2 };
      }
      return s;
    });
    expect(dragged, 'the fixture moved no guard at all').toBe(true);
    const v = validateMap(withStructures(map, structures));
    expect(v.ok).toBe(false);
    const clearance = v.errors.filter((e) => e.includes('edge-to-edge clearance'));
    expect(clearance.length).toBeGreaterThan(0);
    expect(clearance.some((e) => e.includes('2.01 m'))).toBe(true);
  });

  it('detects unequal structure counts per team', () => {
    const map = buildMap(2);
    // Minimal fixture: delete exactly one team-1 tower.
    const doomed = map.structures.find((s) => s.team === 1 && s.kind === 'tower')!;
    const structures = map.structures.filter((s) => s.id !== doomed.id);
    expect(structures).toHaveLength(map.structures.length - 1);
    const v = validateMap(withStructures(map, structures));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('identical structure counts'))).toBe(true);
  });

  it('detects non-finite geometry without throwing', () => {
    const map = buildMap(1);
    // Minimal fixture: exactly one coordinate of exactly one structure is NaN.
    const doomed = map.structures.find((s) => s.team === 0 && s.kind === 'guard')!;
    const structures = map.structures.map((s) =>
      s.id === doomed.id ? { ...s, x: Number.NaN } : s,
    );
    const v = validateMap(withStructures(map, structures));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('not finite'))).toBe(true);
  });
});

// ============================================================================
// TERRAIN (TERRAIN_CONTRACT §3). Terrain never travels on the wire: the client
// rebuilds it from the lane count alone. Every rule below is therefore also a
// desync gate — a grid that is not a pure, mirrored, bit-stable function of
// `lanes` is a client that walks into a cliff the server does not have.
// ============================================================================

describe.each([1, 2, 3])('buildTerrain(%i lanes) — grid shape', (lanes) => {
  const map = buildMap(lanes);
  const t = map.terrain;

  it('is a square grid covering the map, with dim = side * res', () => {
    expect(t.grid.side).toBe(map.side);
    expect(t.grid.res).toBe(1); // frozen at 1 by TERRAIN_CONTRACT §2
    expect(t.grid.dim).toBe(map.side * t.grid.res);
    expect(Number.isInteger(t.grid.dim)).toBe(true);
  });

  it('kind and elev are both exactly dim * dim long', () => {
    const cells = t.grid.dim * t.grid.dim;
    expect(t.grid.kind.length).toBe(cells);
    expect(t.grid.elev.length).toBe(cells);
  });

  it('every stored kind code indexes TERRAIN_KINDS and every elev is LOW or HIGH', () => {
    let badCode = -1;
    let badElev = -1;
    for (let p = 0; p < t.grid.kind.length; p++) {
      const code = t.grid.kind[p]!;
      if (badCode < 0 && (code >= TERRAIN_KINDS.length || TERRAIN_KINDS[code] === undefined)) {
        badCode = p;
      }
      const e = t.grid.elev[p]!;
      if (badElev < 0 && e !== ELEV_LOW && e !== ELEV_HIGH) badElev = p;
    }
    expect(badCode, `cell ${badCode} holds kind code ${String(t.grid.kind[badCode])}, but ` +
      `TERRAIN_KINDS has ${TERRAIN_KINDS.length} entries`).toBe(-1);
    expect(badElev, `cell ${badElev} holds elevation ${String(t.grid.elev[badElev])}, but only ` +
      `ELEV_LOW (${ELEV_LOW}) and ELEV_HIGH (${ELEV_HIGH}) exist`).toBe(-1);
  });

  it('each kind carries its contract elevation and passability', () => {
    const { dim, res } = t.grid;
    // The full law from TERRAIN_CONTRACT §3, one row per kind. A cell that
    // reports 'lane' but sits at ELEV_HIGH would make the uphill miss rule fire
    // in the middle of a lane; a passable 'cliff' would delete the cliff.
    const law: Readonly<Record<TerrainKind, { readonly elev: number; readonly passable: boolean }>> =
      {
        ground: { elev: ELEV_LOW, passable: true },
        lane: { elev: ELEV_LOW, passable: true },
        high: { elev: ELEV_HIGH, passable: true },
        cliff: { elev: ELEV_LOW, passable: false },
        river: { elev: ELEV_LOW, passable: true },
        foliage: { elev: ELEV_LOW, passable: true },
        ramp: { elev: ELEV_HIGH, passable: true },
        base: { elev: ELEV_HIGH, passable: true },
      };
    const offenders: string[] = [];
    for (let j = 0; j < dim && offenders.length < 5; j++) {
      for (let i = 0; i < dim && offenders.length < 5; i++) {
        const x = mid(i, res);
        const z = mid(j, res);
        const k = kindAt(t, x, z);
        // 'ground' is the one kind §3 allows at either elevation (a camp
        // clearing carved out of a plateau stays 'ground' at ELEV_HIGH).
        const want = law[k];
        if (k !== 'ground' && elevationAt(t, x, z) !== want.elev) {
          offenders.push(
            `(${x.toFixed(1)}, ${z.toFixed(1)}) is '${k}' at elevation ` +
              `${elevationAt(t, x, z)}, contract says ${want.elev}`,
          );
        }
        if (isPassable(t, x, z) !== want.passable) {
          offenders.push(
            `(${x.toFixed(1)}, ${z.toFixed(1)}) is '${k}' and ` +
              `${isPassable(t, x, z) ? 'passable' : 'impassable'}, contract says the opposite`,
          );
        }
      }
    }
    expect(offenders, offenders.join('; ')).toEqual([]);
  });

  it('actually contains every kind, and the impassable set IS the cliff set', () => {
    // The law table above derives its expectation from the same query it
    // checks, so by itself it pins what a kind MEANS, not what the grid holds:
    // it would stay green over a grid painted entirely 'ground'. This is the
    // half that reads the content — a census taken from the raw kind bytes,
    // every contract kind present, and the impassable cells counted two
    // independent ways (isPassable, and the stored 'cliff' code).
    const { dim, res } = t.grid;
    const census = new Map<TerrainKind, number>();
    for (const k of TERRAIN_KINDS) census.set(k, 0);
    for (let p = 0; p < t.grid.kind.length; p++) {
      const k = TERRAIN_KINDS[t.grid.kind[p]!];
      if (k !== undefined) census.set(k, (census.get(k) ?? 0) + 1);
    }
    const report = [...census].map(([k, n]) => `${k}=${String(n)}`).join(' ');
    const missing = [...census].filter(([, n]) => n === 0).map(([k]) => k);
    expect(
      missing,
      `the ${lanes}-lane grid never paints ${missing.join(', ')} — census: ${report}`,
    ).toEqual([]);

    let impassable = 0;
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        if (!isPassable(t, mid(i, res), mid(j, res))) impassable++;
      }
    }
    expect(
      impassable,
      `isPassable rejects ${impassable} cell(s) but the grid stores ` +
        `${String(census.get('cliff'))} 'cliff' cell(s) — 'cliff' is the only impassable kind, ` +
        `so those two counts are the same number (census: ${report})`,
    ).toBe(census.get('cliff'));
    expect(impassable, 'a map with no impassable cell has no cliffs at all').toBeGreaterThan(0);
  });
});

describe.each([1, 2, 3])('buildTerrain(%i lanes) — mirror exactness (§3.1)', (lanes) => {
  const map = buildMap(lanes);
  const t = map.terrain;

  it('every cell is BIT-identical to its reflection through the map centre', () => {
    const { dim } = t.grid;
    // Raw byte comparison, not a resampled query: the mirror is exact or it is
    // broken, and an approximate check would hide a one-cell desync between a
    // client and the server that both call buildTerrain(lanes).
    let breaks = 0;
    let first = '';
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        const p = j * dim + i;
        const q = (dim - 1 - j) * dim + (dim - 1 - i);
        if (p >= q) continue; // one report per PAIR
        const kp = t.grid.kind[p]!;
        const kq = t.grid.kind[q]!;
        const ep = t.grid.elev[p]!;
        const eq = t.grid.elev[q]!;
        if (kp === kq && ep === eq) continue;
        breaks++;
        if (first === '') {
          first =
            `cell (${i}, ${j}) is kind ${String(TERRAIN_KINDS[kp])}/elev ${ep} but its ` +
            `reflection (${dim - 1 - i}, ${dim - 1 - j}) is kind ${String(TERRAIN_KINDS[kq])}/` +
            `elev ${eq}`;
        }
      }
    }
    expect(breaks, `${breaks} mirrored cell pair(s) differ; first: ${first}`).toBe(0);
  });

  it('the frozen queries read exactly the raw bytes, at every cell', () => {
    // The test above compares BYTES; the sim reads through kindAt/elevationAt.
    // This is the only place the two representations are joined, and it is what
    // makes the byte comparison mean anything: if the queries did not address
    // the arrays the way this suite indexes them, the mirror could be perfect in
    // the bytes and broken in play. Every cell is visited, so every reflected
    // partner is visited too.
    const { dim, res } = t.grid;
    let mismatch = '';
    for (let j = 0; j < dim && mismatch === ''; j++) {
      for (let i = 0; i < dim && mismatch === ''; i++) {
        const p = j * dim + i;
        const wantKind = TERRAIN_KINDS[t.grid.kind[p]!];
        const gotKind = kindAt(t, mid(i, res), mid(j, res));
        const wantElev = t.grid.elev[p]!;
        const gotElev = elevationAt(t, mid(i, res), mid(j, res));
        if (gotKind !== wantKind) {
          mismatch =
            `kindAt(${mid(i, res)}, ${mid(j, res)}) reads '${gotKind}', but byte ${p} — ` +
            `cell (${i}, ${j}) — holds '${String(wantKind)}'`;
        } else if (gotElev !== wantElev) {
          mismatch =
            `elevationAt(${mid(i, res)}, ${mid(j, res)}) reads ${gotElev}, but byte ${p} — ` +
            `cell (${i}, ${j}) — holds ${wantElev}`;
        }
      }
    }
    expect(mismatch, mismatch).toBe('');
  });
});

describe.each([1, 2, 3])('buildTerrain(%i lanes) — lane pathability (§3.2)', (lanes) => {
  const map = buildMap(lanes);
  const t = map.terrain;
  const { dim, res } = t.grid;
  const STEP = 0.25; // a quarter of a cell: no cell can slip between two samples

  it('a hero disc walking every lane never touches a cliff cell', () => {
    const offenders: string[] = [];
    for (const [li, path] of map.paths.entries()) {
      const len = pathLength(path);
      const samples = Math.ceil(len / STEP);
      for (let s = 0; s <= samples && offenders.length < 5; s++) {
        const arc = Math.min(len, s * STEP);
        const p = walkPath(path, arc);
        const i0 = cellIndex(p.x - HERO_RADIUS, res, dim);
        const i1 = cellIndex(p.x + HERO_RADIUS, res, dim);
        const j0 = cellIndex(p.z - HERO_RADIUS, res, dim);
        const j1 = cellIndex(p.z + HERO_RADIUS, res, dim);
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            if (kindAt(t, mid(i, res), mid(j, res)) !== 'cliff') continue;
            // Overlap against the cell SQUARE, not its centre: a disc clipping
            // the corner of a cliff cell is still a collision.
            const qx = Math.min(Math.max(p.x, i / res), (i + 1) / res);
            const qz = Math.min(Math.max(p.z, j / res), (j + 1) / res);
            if (Math.hypot(p.x - qx, p.z - qz) >= HERO_RADIUS) continue;
            offenders.push(
              `lane ${li} at ${arc.toFixed(2)} m: hero disc at (${p.x.toFixed(2)}, ` +
                `${p.z.toFixed(2)}) overlaps the 'cliff' cell (${i}, ${j})`,
            );
          }
        }
      }
    }
    expect(offenders, offenders.join('; ')).toEqual([]);
  });

  it('every sampled lane point is passable and never a cliff', () => {
    for (const [li, path] of map.paths.entries()) {
      const len = pathLength(path);
      const samples = Math.ceil(len / STEP);
      for (let s = 0; s <= samples; s++) {
        const arc = Math.min(len, s * STEP);
        const p = walkPath(path, arc);
        const k = kindAt(t, p.x, p.z);
        expect(
          isPassable(t, p.x, p.z),
          `lane ${li} crosses an impassable '${k}' cell ${arc.toFixed(2)} m along its polyline`,
        ).toBe(true);
        // §3: a lane corridor is 'lane' end to end except where it climbs onto
        // its own base platform through the base-mouth ramp.
        expect(
          ['lane', 'ramp', 'base'].includes(k),
          `lane ${li} runs over a '${k}' cell ${arc.toFixed(2)} m along its polyline — only ` +
            `'lane', the base-mouth 'ramp' and 'base' are legal under a lane`,
        ).toBe(true);
      }
    }
  });

  it('elevation is constant along the lane except at the two base-mouth ramps', () => {
    for (const [li, path] of map.paths.entries()) {
      const len = pathLength(path);
      const samples = Math.ceil(len / STEP);
      const profile: { arc: number; kind: TerrainKind; elev: number }[] = [];
      for (let s = 0; s <= samples; s++) {
        const arc = Math.min(len, s * STEP);
        const p = walkPath(path, arc);
        profile.push({ arc, kind: kindAt(t, p.x, p.z), elev: elevationAt(t, p.x, p.z) });
      }
      const first = profile[0]!;
      const last = profile[profile.length - 1]!;
      // Both ends stand on their own ancient's platform: the last stand is
      // always uphill (DESIGN_DELTA §1).
      expect(first.kind, `lane ${li} does not start on a base platform`).toBe('base');
      expect(last.kind, `lane ${li} does not end on a base platform`).toBe('base');
      expect(first.elev).toBe(ELEV_HIGH);
      expect(last.elev).toBe(ELEV_HIGH);

      const changes: number[] = [];
      for (let s = 1; s < profile.length; s++) {
        const prev = profile[s - 1]!;
        const cur = profile[s]!;
        if (prev.elev === cur.elev) continue;
        changes.push(s);
        // No cliff crossing: every level change on a lane happens ON a ramp.
        expect(
          prev.kind === 'ramp' || cur.kind === 'ramp',
          `lane ${li} changes elevation ${prev.elev} -> ${cur.elev} at ` +
            `${cur.arc.toFixed(2)} m between a '${prev.kind}' and a '${cur.kind}' cell — a level ` +
            `change on a lane is only legal across a 'ramp'`,
        ).toBe(true);
      }
      expect(
        changes.length,
        `lane ${li} changes elevation ${changes.length} time(s) at arcs ` +
          `[${changes.map((s) => profile[s]!.arc.toFixed(2)).join(', ')}] — exactly two are legal, ` +
          `the two base mouths`,
      ).toBe(2);

      // Everything strictly between the two mouths is one consistent level.
      const inner = profile.slice(changes[0]!, changes[1]!);
      expect(inner.length).toBeGreaterThan(0);
      for (const sample of inner) {
        expect(
          sample.elev,
          `lane ${li} sits at elevation ${sample.elev} on a '${sample.kind}' cell ` +
            `${sample.arc.toFixed(2)} m along, between the base mouths — the corridor is ` +
            `ELEV_LOW end to end`,
        ).toBe(ELEV_LOW);
        expect(sample.kind).toBe('lane');
      }
    }
  });
});

describe.each([1, 2, 3])('buildTerrain(%i lanes) — connectivity (§3.3)', (lanes) => {
  const map = buildMap(lanes);
  const t = map.terrain;
  const { dim, res } = t.grid;
  const ancients = map.structures.filter((s) => s.kind === 'ancient');

  it('a flood fill from one fountain reaches the other', () => {
    // FOUNTAIN_RADIUS is centred on the owning ancient, so the ancient cell IS
    // the fountain cell.
    expect(ancients).toHaveLength(2);
    const from = ancients[0]!;
    const to = ancients[1]!;
    const seen = floodFrom(t, from.x, from.z);
    const cell = cellIndex(to.z, res, dim) * dim + cellIndex(to.x, res, dim);
    expect(
      seen[cell],
      `team ${to.team}'s fountain at (${to.x}, ${to.z}) is not reachable on passable ground from ` +
        `team ${from.team}'s fountain at (${from.x}, ${from.z})`,
    ).toBe(1);
  });

  it('that fill also reaches every structure and every camp clearing', () => {
    const from = ancients[0]!;
    const seen = floodFrom(t, from.x, from.z);
    const unreachable: string[] = [];
    for (const s of map.structures) {
      const cell = cellIndex(s.z, res, dim) * dim + cellIndex(s.x, res, dim);
      if (seen[cell] !== 1) unreachable.push(`structure #${s.id} (team ${s.team} ${s.kind})`);
    }
    for (const c of t.camps) {
      const cell = cellIndex(c.z, res, dim) * dim + cellIndex(c.x, res, dim);
      if (seen[cell] !== 1) unreachable.push(`camp #${c.id} (${c.tier})`);
    }
    expect(unreachable, `unreachable from team 0's fountain: ${unreachable.join(', ')}`).toEqual([]);
  });

  it('leaves no sealed pocket: the fill covers EVERY passable cell', () => {
    const from = ancients[0]!;
    const seen = floodFrom(t, from.x, from.z);
    let passable = 0;
    let reached = 0;
    let firstOrphan = '';
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        if (!isPassable(t, mid(i, res), mid(j, res))) continue;
        passable++;
        if (seen[j * dim + i] === 1) {
          reached++;
        } else if (firstOrphan === '') {
          firstOrphan = `(${i}, ${j}) '${kindAt(t, mid(i, res), mid(j, res))}'`;
        }
      }
    }
    expect(
      reached,
      `the fill covers ${reached} of ${passable} passable cells — first sealed-off cell: ` +
        `${firstOrphan}`,
    ).toBe(passable);
  });
});

describe.each([1, 2, 3])('buildTerrain(%i lanes) — no concave traps (§3.4)', (lanes) => {
  const t = buildMap(lanes).terrain;

  it('every passable cell has at least two passable neighbours', () => {
    // The wall-slide in the movement push-out is only sufficient if no pocket
    // has a single mouth: a unit that walks into a one-neighbour cell cannot
    // steer back out, and lane creeps have no pathfinding to rescue them.
    // Off-map counts as impassable — the movement clamp behaves like a wall.
    const { dim, res } = t.grid;
    const offenders: string[] = [];
    for (let j = 0; j < dim && offenders.length < 5; j++) {
      for (let i = 0; i < dim && offenders.length < 5; i++) {
        if (!isPassable(t, mid(i, res), mid(j, res))) continue;
        let open = 0;
        for (const [di, dj] of NBRS) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || ni >= dim || nj < 0 || nj >= dim) continue;
          if (isPassable(t, mid(ni, res), mid(nj, res))) open++;
        }
        if (open >= 2) continue;
        offenders.push(
          `(${i}, ${j}) '${kindAt(t, mid(i, res), mid(j, res))}' has ${open} passable ` +
            `neighbour(s) — a unit that walks in cannot steer out`,
        );
      }
    }
    expect(offenders, offenders.join('; ')).toEqual([]);
  });
});

describe.each([1, 2, 3])('buildTerrain(%i lanes) — camps (§3.5, §5)', (lanes) => {
  const map = buildMap(lanes);
  const t = map.terrain;
  // Pinned literally as well as read from config: TERRAIN_CONTRACT §7 fixes the
  // census at 2/3/4 per half, so a config edit that quietly changes it must
  // fail here rather than silently reshape the jungle economy.
  const perHalf = [0, 2, 3, 4][lanes]!;

  it(`fields ${String(perHalf)} camps per half, ${String(perHalf * 2)} in total`, () => {
    expect(CAMPS_PER_HALF[lanes]).toBe(perHalf);
    expect(t.camps).toHaveLength(perHalf * 2);
    for (const half of [0, 1] as const) {
      expect(
        t.camps.filter((c) => c.half === half),
        `half ${half} camp census`,
      ).toHaveLength(perHalf);
    }
  });

  it('camp ids are dense 0..N-1', () => {
    expect(t.camps.map((c) => c.id).sort((a, b) => a - b)).toEqual(t.camps.map((_, i) => i));
  });

  it('every camp is at least CAMP_LANE_CLEARANCE from every lane polyline', () => {
    for (const c of t.camps) {
      for (const [li, path] of map.paths.entries()) {
        const d = distToPolyline(path, c.x, c.z);
        expect(
          d,
          `camp #${c.id} (${c.tier}) at (${c.x.toFixed(2)}, ${c.z.toFixed(2)}) is ` +
            `${d.toFixed(2)} m from lane ${li} — a passing wave would aggro it`,
        ).toBeGreaterThanOrEqual(CAMP_LANE_CLEARANCE);
      }
    }
  });

  it('the two halves are exact mirrors, camp for camp and tier for tier', () => {
    for (const c of t.camps) {
      const mx = map.side - c.x;
      const mz = map.side - c.z;
      const twins = t.camps.filter(
        (d) => d.half !== c.half && d.tier === c.tier && Math.hypot(d.x - mx, d.z - mz) <= 1e-9,
      );
      expect(
        twins,
        `camp #${c.id} (${c.tier}, half ${c.half}) at (${c.x.toFixed(2)}, ${c.z.toFixed(2)}) ` +
          `reflects to (${mx.toFixed(2)}, ${mz.toFixed(2)}), where half ${1 - c.half} has no ` +
          `matching ${c.tier} camp`,
      ).toHaveLength(1);
    }
    for (const tier of ['pack', 'brute', 'hive'] as const) {
      const a = t.camps.filter((c) => c.half === 0 && c.tier === tier).length;
      const b = t.camps.filter((c) => c.half === 1 && c.tier === tier).length;
      expect(a, `tier '${tier}' census differs between the halves`).toBe(b);
    }
  });

  it("each camp's declared half is the half it actually stands in", () => {
    // The mirror is a point reflection through the centre, so the halves are
    // the two sides of the anti-diagonal x + z = side.
    for (const c of t.camps) {
      const sum = c.x + c.z;
      expect(
        c.half === 0 ? sum < map.side : sum > map.side,
        `camp #${c.id} claims half ${c.half} but sits at (${c.x.toFixed(2)}, ` +
          `${c.z.toFixed(2)}), where x + z = ${sum.toFixed(2)} against a side of ${map.side}`,
      ).toBe(true);
    }
  });

  it('every camp clearing centre is passable and off the lanes', () => {
    for (const c of t.camps) {
      expect(
        isPassable(t, c.x, c.z),
        `camp #${c.id} stands on an impassable '${kindAt(t, c.x, c.z)}' cell`,
      ).toBe(true);
      expect(kindAt(t, c.x, c.z)).not.toBe('lane');
    }
  });
});

describe.each([1, 2, 3])('buildTerrain(%i lanes) — elevation coherence (§3.6)', (lanes) => {
  const t = buildMap(lanes).terrain;

  it("every level change is marked by a 'cliff' or a 'ramp'", () => {
    // Scanned as adjacent PAIRS (+x and +z only, so each pair is seen once):
    // an unmarked step in either direction lets units walk uphill and makes the
    // uphill vision block and the uphill miss chance read as a bug.
    const { dim, res } = t.grid;
    const offenders: string[] = [];
    for (let j = 0; j < dim && offenders.length < 5; j++) {
      for (let i = 0; i < dim && offenders.length < 5; i++) {
        const x = mid(i, res);
        const z = mid(j, res);
        const ka = kindAt(t, x, z);
        const ea = elevationAt(t, x, z);
        for (const [di, dj] of [
          [1, 0],
          [0, 1],
        ] as const) {
          const ni = i + di;
          const nj = j + dj;
          if (ni >= dim || nj >= dim) continue;
          const nx = mid(ni, res);
          const nz = mid(nj, res);
          if (elevationAt(t, nx, nz) === ea) continue;
          const kb = kindAt(t, nx, nz);
          if (ka === 'cliff' || ka === 'ramp' || kb === 'cliff' || kb === 'ramp') continue;
          offenders.push(
            `(${i}, ${j}) '${ka}' at elevation ${ea} borders (${ni}, ${nj}) '${kb}' at ` +
              `elevation ${elevationAt(t, nx, nz)} with no 'cliff' or 'ramp' between them`,
          );
        }
      }
    }
    expect(offenders, offenders.join('; ')).toEqual([]);
  });
});

describe.each([1, 2, 3])('buildTerrain(%i lanes) — determinism (§1)', (lanes) => {
  it('two calls return bit-identical grids', () => {
    const a = buildTerrain(lanes);
    const b = buildTerrain(lanes);
    expect(a).not.toBe(b); // genuinely two builds, not a memoised singleton
    expect(a.grid.dim).toBe(b.grid.dim);
    let kindDiff = -1;
    let elevDiff = -1;
    for (let p = 0; p < a.grid.kind.length; p++) {
      if (kindDiff < 0 && a.grid.kind[p] !== b.grid.kind[p]) kindDiff = p;
      if (elevDiff < 0 && a.grid.elev[p] !== b.grid.elev[p]) elevDiff = p;
    }
    expect(
      kindDiff,
      `kind byte ${kindDiff} differs between two buildTerrain(${lanes}) calls — terrain is not a ` +
        `pure function of the lane count, so a client will desync from the server`,
    ).toBe(-1);
    expect(elevDiff, `elev byte ${elevDiff} differs between two buildTerrain(${lanes}) calls`).toBe(
      -1,
    );
  });

  it('camps and landmarks are value-identical across calls', () => {
    expect(buildTerrain(lanes).camps).toEqual(buildTerrain(lanes).camps);
    expect(buildTerrain(lanes).landmarks).toEqual(buildTerrain(lanes).landmarks);
  });

  it('buildMap embeds exactly what a client rebuilding from the lane count gets', () => {
    // The client never receives a MapDef; it calls buildMap(rift_begin.lanes).
    // If these two ever diverge, terrain silently stops matching the sim.
    const embedded = buildMap(lanes).terrain;
    const standalone = buildTerrain(lanes);
    expect(Array.from(embedded.grid.kind)).toEqual(Array.from(standalone.grid.kind));
    expect(Array.from(embedded.grid.elev)).toEqual(Array.from(standalone.grid.elev));
    expect(embedded.camps).toEqual(standalone.camps);
    expect(embedded.landmarks).toEqual(standalone.landmarks);
  });
});

describe('buildTerrain lane-count guard', () => {
  it.each([0, 4, 1.5, Number.NaN])('throws on lanes = %s', (lanes) => {
    expect(() => buildTerrain(lanes)).toThrow();
  });
});

describe('validateMap terrain detection (broken grids must fail)', () => {
  it('detects a broken terrain mirror, naming the offending cell', () => {
    const map = buildMap(1);
    const broken = cloneTerrain(map.terrain);
    // A jungle cell far from the anti-diagonal, flipped on one side only.
    const dim = broken.def.grid.dim;
    const p = 20 * dim + 20;
    broken.kind[p] = broken.kind[p] === codeOf('foliage') ? codeOf('ground') : codeOf('foliage');
    const v = validateMap(withTerrain(map, broken.def));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('terrain mirror break at'))).toBe(true);
  });

  it('detects a cliff dropped across a lane corridor', () => {
    const map = buildMap(1);
    const broken = cloneTerrain(map.terrain);
    const dim = broken.def.grid.dim;
    const c = Math.floor(map.side / 2);
    broken.kind[c * dim + c] = codeOf('cliff'); // dead centre of the mid lane
    const v = validateMap(withTerrain(map, broken.def));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('is not pathable'))).toBe(true);
  });

  it('detects a camp clearing walled off from the ancients (rule 8)', () => {
    const map = buildMap(1);
    const broken = cloneTerrain(map.terrain);
    const { dim, res } = broken.def.grid;
    const camp = map.terrain.camps[0]!;
    const ci = cellIndex(camp.x, res, dim);
    const cj = cellIndex(camp.z, res, dim);
    // Minimal island: the flood fill is 4-connected, so four 'cliff' cells are
    // the entire wall. The clearing itself stays PASSABLE on purpose — a target
    // standing on a cliff is a different rule-8 error, reported separately, and
    // this fixture must exercise the fill, not that shortcut. (The sealed cell
    // is also a rule-9 trap by construction — any island is — which is why the
    // assertion below is on the rule-8 sentence alone.)
    for (const [di, dj] of NBRS) broken.kind[(cj + dj) * dim + (ci + di)] = codeOf('cliff');
    expect(
      isPassable(broken.def, mid(ci, res), mid(cj, res)),
      'the fixture sealed the clearing cell itself, which is the other rule-8 error',
    ).toBe(true);
    const v = validateMap(withTerrain(map, broken.def));
    expect(v.ok).toBe(false);
    const unreachable = v.errors.filter(
      (e) => e.includes('terrain connectivity:') && e.includes('is unreachable from team'),
    );
    // One report per ancient: both fills must fail to find it.
    expect(unreachable, v.errors.join('; ')).toHaveLength(2);
    expect(
      unreachable.every((e) => e.includes(`camp #${camp.id}`)),
      unreachable.join('; '),
    ).toBe(true);
  });

  it('detects a one-mouth pocket a unit cannot steer out of (rule 9)', () => {
    const map = buildMap(1);
    const broken = cloneTerrain(map.terrain);
    const { dim, res } = broken.def.grid;
    // Carve the pocket into a 5x5 of plain low 'ground' so the three new cliffs
    // touch nothing else: the pocket keeps one mouth, so it stays reachable and
    // rule 8 has nothing to say about it — this fixture is a trap and only a
    // trap.
    let ti = -1;
    let tj = -1;
    for (let j = 2; j < dim - 2 && ti < 0; j++) {
      for (let i = 2; i < dim - 2 && ti < 0; i++) {
        let plain = true;
        for (let dj = -2; dj <= 2 && plain; dj++) {
          for (let di = -2; di <= 2 && plain; di++) {
            const p = (j + dj) * dim + (i + di);
            if (broken.kind[p] !== codeOf('ground') || broken.elev[p] !== ELEV_LOW) plain = false;
          }
        }
        if (plain) {
          ti = i;
          tj = j;
        }
      }
    }
    expect(ti, 'no 5x5 of plain low ground to carve a pocket in — the fixture is broken').toBeGreaterThan(-1);
    for (const [di, dj] of [
      [-1, 0],
      [1, 0],
      [0, -1],
    ] as const) {
      broken.kind[(tj + dj) * dim + (ti + di)] = codeOf('cliff');
    }
    const v = validateMap(withTerrain(map, broken.def));
    expect(v.ok).toBe(false);
    const traps = v.errors.filter((e) => e.includes('terrain trap at'));
    expect(traps, v.errors.join('; ')).toHaveLength(1);
    expect(
      traps[0],
      `the trap report must name the pocket at cell (${ti}, ${tj}) and its three walls`,
    ).toContain(`(${mid(ti, res).toFixed(1)}, ${mid(tj, res).toFixed(1)})`);
    expect(traps[0]).toContain('walled on 3 of its 4 sides');
  });

  it('detects a camp parked on a lane, with the measured distance', () => {
    const map = buildMap(1);
    const onLane = map.paths[0]![1]!; // a lane waypoint: clearance 0
    const camps: CampDef[] = map.terrain.camps.map((c) =>
      c.id === 0 ? { ...c, x: onLane.x, z: onLane.z } : c,
    );
    const v = validateMap(withTerrain(map, withCamps(map.terrain, camps)));
    expect(v.ok).toBe(false);
    expect(
      v.errors.some((e) => e.includes("lane 0's polyline") && e.includes('camp #0')),
      v.errors.join('; '),
    ).toBe(true);
  });

  it('detects an unmarked elevation step in open ground', () => {
    const map = buildMap(2);
    const broken = cloneTerrain(map.terrain);
    const dim = broken.def.grid.dim;
    // Raise one cell that is 'ground' and surrounded by 'ground': no cliff, no
    // ramp, so the high cell borders low ground on all four sides.
    let raised = -1;
    for (let j = 2; j < dim - 2 && raised < 0; j++) {
      for (let i = 2; i < dim - 2 && raised < 0; i++) {
        const p = j * dim + i;
        if (broken.kind[p] !== codeOf('ground')) continue;
        if (broken.elev[p] !== ELEV_LOW) continue;
        const ok = [
          p - 1,
          p + 1,
          p - dim,
          p + dim,
        ].every((q) => broken.kind[q] === codeOf('ground') && broken.elev[q] === ELEV_LOW);
        if (!ok) continue;
        broken.elev[p] = ELEV_HIGH;
        raised = p;
      }
    }
    expect(raised, 'no all-ground cell to raise — the fixture itself is broken').toBeGreaterThan(-1);
    const v = validateMap(withTerrain(map, broken.def));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('terrain elevation step at')), v.errors.join('; ')).toBe(
      true,
    );
  });

  it('detects a grid that does not cover the map square, and skips the cell rules', () => {
    const map = buildMap(1);
    const t = map.terrain;
    const shrunk: TerrainDef = {
      grid: {
        side: t.grid.side,
        res: t.grid.res,
        dim: t.grid.dim - 1, // arrays now disagree with the declared dim
        kind: t.grid.kind,
        elev: t.grid.elev,
      },
      camps: t.camps,
      landmarks: t.landmarks,
    };
    const v = validateMap(withTerrain(map, shrunk));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('does not cover the map square'))).toBe(true);
    expect(v.errors.some((e) => e.includes('terrain mirror break at'))).toBe(false);
  });
});
