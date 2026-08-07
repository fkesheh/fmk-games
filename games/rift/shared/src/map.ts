// ============================================================================
// ANCIENTS (rift) — MAP GEOMETRY (CONTRACT §3). Pure math/data, no I/O, no rng.
// The SAME MapDef feeds the server's sim and the client's mesh; both build it
// deterministically from the lane count via buildMap().
//
// Geometry: square [0, side]^2, side = MAP_SIDE_BASE + MAP_SIDE_PER_LANE *
// (lanes-1). Team 0's Ancient at (BASE_INSET, BASE_INSET), team 1's at
// (side-BASE_INSET, side-BASE_INSET); lane paths are waypoint polylines
// between them. Lane towers stand TOWER_LANE_OFFSET off their polyline,
// perpendicular, on the side facing AWAY from the map centre.
//
// MID-LANE TIEBREAK (contract ambiguity, resolved toward self-consistency):
// on the mid diagonal both offset sides are equidistant from the centre, so
// the contract pins the side as "LEFT of the team-0 -> team-1 travel
// direction". Read as a FIXED world-space side for both teams, team 1's mid
// towers would land 2*TOWER_LANE_OFFSET (5.0 m) away from where validateMap
// rule 2 (exact mirror symmetry through the centre, both directions) requires
// them — the contract would fail its own validator. The reading implemented
// here is the unique 180°-rotation-covariant one: each team's towers are
// placed walking FROM THEIR OWN Ancient toward the enemy (team 1 walks the
// polyline reversed), offset left of THAT travel direction; for team 0 this
// is exactly the contract sentence, and team 1's placement is then the exact
// mirror image rule 2 demands. "Left of travel" uses the kart handedness
// (track.ts closestOnTrack/gridSlot): left of unit tangent (tx,tz) is
// (-tz, tx).
//
// TERRAIN (TERRAIN_CONTRACT §1-3): buildMap also compiles the terrain, by
// calling buildTerrain(lanes) — the SAME pure function of the lane count the
// client calls, because terrain is never sent on the wire and both sides must
// agree bit-for-bit. buildMap therefore stays deterministic, rng-free and
// clock-free. validateMap gains the six terrain rules of TERRAIN_CONTRACT §3
// (numbered 6..11 here, after the five structure rules). Those rules read the
// grid ONLY through the frozen O(1) queries kindAt/elevationAt/isPassable,
// sampled at cell centres: the row/column order inside TerrainGrid is
// terrain.ts's private business and is never assumed here.
// ============================================================================
import {
  ANCIENT,
  ANCIENT_GUARDS,
  BASE_INSET,
  CAMP_LANE_CLEARANCE,
  GUARD_FLANK_DIST,
  GUARD_TOWER,
  HERO_RADIUS,
  LANE_EDGE_INSET,
  MAP_SIDE_BASE,
  MAP_SIDE_PER_LANE,
  MAX_LANES,
  MIN_LANES,
  STRUCTURE_MARGIN,
  TOWER,
  TOWER_LANE_FRACTIONS,
  TOWER_LANE_OFFSET,
  TOWERS_PER_LANE,
} from './config.js';
import { ELEV_HIGH, buildTerrain, elevationAt, isPassable, kindAt } from './terrain.js';
import type { CampDef, TerrainDef, TerrainKind } from './terrain.js';
import type {
  MapDef,
  MapValidation,
  StructureDef,
  StructureKind,
  Vec2,
} from './types.js';

/** validateMap rule 3: a lane tower's centre must stand this close to its
 *  lane polyline (contract §3: "within 6m"). */
const TOWER_PATH_MAX_DIST = 6;
/** Mirror symmetry (rule 2) is asserted to this tolerance; the deterministic
 *  construction agrees to ~1e-13, so 1e-6 only trips on real breakage. */
const MIRROR_TOL = 1e-6;
/** Terrain rule 7 (lane pathability) marches the hero disc along each lane
 *  polyline at this spacing, in metres. A quarter of a cell at the frozen
 *  res = 1, so no cliff cell can slip between two consecutive samples. */
const LANE_DISC_STEP = 0.25;
/** The grid-wide terrain rules (6, 9, 11) name at most this many offending
 *  cells before falling back to a count. One error string per bad cell would
 *  emit thousands on a broken grid and bury the one a reviewer needs; a total
 *  plus the first offenders still says WHICH rule broke and BY HOW MUCH. */
const TERRAIN_ERROR_SAMPLES = 4;

const KIND_RADIUS: Record<StructureKind, number> = {
  tower: TOWER.radius,
  guard: GUARD_TOWER.radius,
  ancient: ANCIENT.radius,
};

// ---- small geometry helpers --------------------------------------------------

function pathLength(path: readonly Vec2[]): number {
  let len = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!; // i and i+1 bounded by the loop condition
    const b = path[i + 1]!;
    len += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return len;
}

/** Walk `arc` metres along the polyline from path[0]; returns the point and
 *  the unit tangent of the segment it lands on (the direction of travel). */
function walkPath(
  path: readonly Vec2[],
  arc: number,
): { x: number; z: number; tx: number; tz: number } {
  let remain = arc;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (remain <= seg || i + 2 === path.length) {
      const u = seg > 1e-9 ? Math.min(1, Math.max(0, remain / seg)) : 0;
      const l = seg || 1;
      return {
        x: a.x + (b.x - a.x) * u,
        z: a.z + (b.z - a.z) * u,
        tx: (b.x - a.x) / l,
        tz: (b.z - a.z) / l,
      };
    }
    remain -= seg;
  }
  const last = path[path.length - 1];
  return { x: last ? last.x : 0, z: last ? last.z : 0, tx: 1, tz: 0 };
}

/** Perpendicular offset direction for a lane tower at (px,pz) on a segment
 *  with unit tangent (tx,tz): the side facing AWAY from the map centre
 *  (cx,cz); on the mid diagonal both sides are equidistant, and the tiebreak
 *  is LEFT of the travel direction — kart handedness, left = (-tz, tx). */
function towerOffsetSide(
  px: number,
  pz: number,
  tx: number,
  tz: number,
  cx: number,
  cz: number,
): { nx: number; nz: number } {
  const lx = -tz;
  const lz = tx;
  const dl =
    (px + lx * TOWER_LANE_OFFSET - cx) ** 2 + (pz + lz * TOWER_LANE_OFFSET - cz) ** 2;
  const dr =
    (px - lx * TOWER_LANE_OFFSET - cx) ** 2 + (pz - lz * TOWER_LANE_OFFSET - cz) ** 2;
  if (Math.abs(dl - dr) < 1e-9) return { nx: lx, nz: lz }; // mid diagonal: LEFT
  return dl > dr ? { nx: lx, nz: lz } : { nx: -lx, nz: -lz };
}

/** Exact distance from (px,pz) to a polyline (min over segments). */
function polylineDistance(path: readonly Vec2[], px: number, pz: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((px - a.x) * dx + (pz - a.z) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (a.x + t * dx), pz - (a.z + t * dz));
    if (d < best) best = d;
  }
  return best;
}

// ---- terrain helpers (validateMap rules 6..11) ---------------------------------

/** The four orthogonal neighbours of a grid cell, each with the label the trap
 *  and elevation-coherence rules print. Everything these rules reason about —
 *  unit movement, the cliff push-out's wall-slide, the connectivity flood fill
 *  — is 4-connected: a diagonal touch is not a crossing a unit can walk. */
const NEIGHBOURS: readonly {
  readonly di: number;
  readonly dj: number;
  readonly label: string;
}[] = [
  { di: -1, dj: 0, label: '-x' },
  { di: 1, dj: 0, label: '+x' },
  { di: 0, dj: -1, label: '-z' },
  { di: 0, dj: 1, label: '+z' },
];

/** One thing the connectivity flood fill (rule 8) must be able to walk to: a
 *  structure or a camp clearing, resolved to the cell that contains it. */
interface ReachTarget {
  /** Human-readable identity, e.g. `structure #7 (team 0 tower)`. */
  readonly label: string;
  readonly x: number;
  readonly z: number;
  /** Linear index in the VALIDATOR's own row-major enumeration (j * dim + i).
   *  Never the grid's internal index — that order is terrain.ts's business. */
  readonly cell: number;
  readonly kind: TerrainKind;
  readonly passable: boolean;
}

/** Bounded error sink for the grid-wide terrain rules (6, 7, 9, 11). A broken
 *  grid can offend in thousands of cells, and one string per cell would bury
 *  the one line a reviewer needs. The first TERRAIN_ERROR_SAMPLES offenders are
 *  reported in full — with measured values, like every other rule in this file
 *  — and the remainder collapse into one count. `add` takes a THUNK so a
 *  catastrophically broken grid never formats the messages it will not print. */
interface CappedErrors {
  add(detail: () => string): void;
  flush(): void;
}

function capped(errors: string[], surplus: (n: number) => string): CappedErrors {
  let found = 0;
  return {
    add(detail: () => string): void {
      if (found < TERRAIN_ERROR_SAMPLES) errors.push(detail());
      found++;
    },
    flush(): void {
      if (found > TERRAIN_ERROR_SAMPLES) errors.push(surplus(found - TERRAIN_ERROR_SAMPLES));
    },
  };
}

/** Grid cell index containing world coordinate `v`, clamped into [0, dim-1] —
 *  the same clamp the frozen terrain queries apply out of bounds. */
function cellIndex(v: number, res: number, dim: number): number {
  const i = Math.floor(v * res);
  if (!(i > 0)) return 0; // also catches NaN
  return i > dim - 1 ? dim - 1 : i;
}

/** World x (or z) of the CENTRE of cell `i`. Every terrain rule samples cell
 *  centres: cells are addressed by world position through kindAt/elevationAt/
 *  isPassable, never by index arithmetic into the grid's arrays. Note that the
 *  mirror of a centre is exactly another centre — side - (i+0.5)/res is the
 *  centre of cell dim-1-i — which is why rule 6 can compare kinds exactly. */
function cellMid(i: number, res: number): number {
  return (i + 0.5) / res;
}

/** The two kinds that are a MARKED level transition. Rule 11 lets a high region
 *  border low ground only through one of these; rule 7 lets a lane cross
 *  exactly a 'ramp' (a 'cliff' across a lane would strand every creep wave,
 *  which have no pathfinding — TERRAIN_CONTRACT §4). */
function isTransition(k: TerrainKind): boolean {
  return k === 'cliff' || k === 'ramp';
}

/** Stable identity for a camp in error strings. */
function campLabel(c: CampDef): string {
  return `camp #${c.id} (${c.tier}, half ${c.half})`;
}

/** How many of cell (i,j)'s four orthogonal sides are impassable (rule 9).
 *  **Off-map counts as impassable**: the movement clamp at the map frame
 *  behaves exactly like a wall, so a one-cell pocket against the frame traps a
 *  unit precisely as a pocket between cliffs does. */
function blockedSideCount(
  terrain: TerrainDef,
  res: number,
  dim: number,
  i: number,
  j: number,
): number {
  let blocked = 0;
  for (const n of NEIGHBOURS) {
    const ni = i + n.di;
    const nj = j + n.dj;
    if (ni < 0 || ni >= dim || nj < 0 || nj >= dim) {
      blocked++;
    } else if (!isPassable(terrain, cellMid(ni, res), cellMid(nj, res))) {
      blocked++;
    }
  }
  return blocked;
}

/** The labels of those sides, e.g. `-x, +z (map edge)`. Split from the count so
 *  the every-cell scan allocates nothing and only a reported cell formats. */
function blockedSideLabels(
  terrain: TerrainDef,
  res: number,
  dim: number,
  i: number,
  j: number,
): string {
  const parts: string[] = [];
  for (const n of NEIGHBOURS) {
    const ni = i + n.di;
    const nj = j + n.dj;
    if (ni < 0 || ni >= dim || nj < 0 || nj >= dim) {
      parts.push(`${n.label} (map edge)`);
    } else if (!isPassable(terrain, cellMid(ni, res), cellMid(nj, res))) {
      parts.push(`${n.label} ('${kindAt(terrain, cellMid(ni, res), cellMid(nj, res))}')`);
    }
  }
  return parts.join(', ');
}

/** Resolve a structure or camp position to the cell the flood fill must reach. */
function reachTarget(
  terrain: TerrainDef,
  res: number,
  dim: number,
  label: string,
  x: number,
  z: number,
): ReachTarget {
  const i = cellIndex(x, res, dim);
  const j = cellIndex(z, res, dim);
  const mx = cellMid(i, res);
  const mz = cellMid(j, res);
  return {
    label,
    x,
    z,
    cell: j * dim + i,
    kind: kindAt(terrain, mx, mz),
    passable: isPassable(terrain, mx, mz),
  };
}

// ---- buildMap ----------------------------------------------------------------

/**
 * Compile the lane count into the MapDef every consumer speaks. Deterministic:
 * no rng, no time — the server and every client build identical geometry.
 * Throws unless lanes is an integer in [MIN_LANES, MAX_LANES].
 *
 * Structure ids are dense 0..N-1 in the contract order: team 0 lane towers
 * (lane-major, near-to-far from team 0's Ancient), team 0 guards, team 0
 * ancient, then team 1 mirrored (lane-major, near-to-far from team 1's
 * Ancient, guards, ancient).
 *
 * `terrain` comes from `buildTerrain(lanes)` and is REQUIRED on every MapDef
 * (TERRAIN_CONTRACT §2). It is a pure function of the same lane count, so a
 * client that rebuilds the map from `rift_begin.lanes` gets a bit-identical
 * grid without terrain ever touching the wire.
 */
export function buildMap(lanes: number): MapDef {
  if (!Number.isInteger(lanes) || lanes < MIN_LANES || lanes > MAX_LANES) {
    throw new Error(
      `buildMap: lanes must be an integer in [${MIN_LANES}, ${MAX_LANES}], got ${String(lanes)}`,
    );
  }
  const side = MAP_SIDE_BASE + MAP_SIDE_PER_LANE * (lanes - 1);
  const B = BASE_INSET;
  const E = LANE_EDGE_INSET;
  const cx = side / 2;
  const cz = side / 2;
  const a0: Vec2 = { x: B, z: B };
  const a1: Vec2 = { x: side - B, z: side - B };
  const mid: Vec2 = { x: cx, z: cz };

  const paths: Vec2[][] = [];
  if (lanes === 1) {
    paths.push([a0, mid, a1]);
  } else {
    paths.push([a0, { x: E, z: side - E }, a1]); // west-north edge lane
    paths.push([a0, { x: side - E, z: E }, a1]); // south-east edge lane
    if (lanes === MAX_LANES) paths.push([a0, mid, a1]); // mid diagonal
  }

  const structures: StructureDef[] = [];
  let nextId = 0;

  for (const team of [0, 1] as const) {
    // Lane towers, lane-major, near-to-far from THIS team's Ancient: team 0
    // walks each polyline forward, team 1 walks it reversed (see the header
    // note on the mid-lane tiebreak).
    for (const [lane, path] of paths.entries()) {
      const walked = team === 0 ? path : [...path].reverse();
      const len = pathLength(walked);
      for (let k = 0; k < TOWERS_PER_LANE; k++) {
        const f = TOWER_LANE_FRACTIONS[k];
        if (f === undefined) {
          throw new Error('config: TOWER_LANE_FRACTIONS shorter than TOWERS_PER_LANE');
        }
        const pose = walkPath(walked, f * len);
        const n = towerOffsetSide(pose.x, pose.z, pose.tx, pose.tz, cx, cz);
        structures.push({
          id: nextId++,
          kind: 'tower',
          team,
          lane,
          x: pose.x + n.nx * TOWER_LANE_OFFSET,
          z: pose.z + n.nz * TOWER_LANE_OFFSET,
        });
      }
    }

    // Guards: ANCIENT_GUARDS flanking the Ancient, perpendicular to the
    // base-to-base diagonal, at GUARD_FLANK_DIST — sized so the guard/ancient
    // edge-to-edge gap is exactly STRUCTURE_MARGIN (see config.ts).
    const ancient = team === 0 ? a0 : a1;
    const gx = (a1.x - a0.x) / Math.hypot(a1.x - a0.x, a1.z - a0.z);
    const gz = (a1.z - a0.z) / Math.hypot(a1.x - a0.x, a1.z - a0.z);
    const px = -gz; // perpendicular to the diagonal (kart left-handedness)
    const pz = gx;
    for (let g = 0; g < ANCIENT_GUARDS; g++) {
      const sgn = g % 2 === 0 ? 1 : -1;
      structures.push({
        id: nextId++,
        kind: 'guard',
        team,
        lane: null,
        x: ancient.x + px * GUARD_FLANK_DIST * sgn,
        z: ancient.z + pz * GUARD_FLANK_DIST * sgn,
      });
    }

    structures.push({
      id: nextId++,
      kind: 'ancient',
      team,
      lane: null,
      x: ancient.x,
      z: ancient.z,
    });
  }

  return { lanes, side, paths, structures, terrain: buildTerrain(lanes) };
}

// ---- validateMap ---------------------------------------------------------------

/**
 * Reject a map the game cannot be played on, kart-style: returns EVERY
 * problem found with measured values, never throws. Empty errors == legal.
 * The five contract rules (§3):
 *  1. waypoint/structure finiteness and bounds (inside [0, side] minus 1 m);
 *  2. exact mirror symmetry through the map centre, BOTH directions;
 *  3. pathability: a HERO_RADIUS disc walking each lane polyline never
 *     intersects a structure disc expanded by HERO_RADIUS (the two Ancients
 *     at the path endpoints are EXEMPT), and every tower centre is within
 *     TOWER_PATH_MAX_DIST of its lane polyline;
 *  4. min pairwise structure edge-to-edge clearance >= STRUCTURE_MARGIN;
 *  5. identical structure counts per team per kind.
 *
 * And the six terrain rules (TERRAIN_CONTRACT §3), numbered on from those:
 *  6. mirror exactness: every cell's kind AND elevation equal its reflection's
 *     through the map centre, and every camp has an exact mirror counterpart
 *     of the same tier in the other half;
 *  7. lane pathability: a HERO_RADIUS disc walking every lane polyline never
 *     touches a 'cliff' cell ('ramp' is permitted, and expected at base
 *     mouths — lane creeps have no pathfinding, so a cliff strands the wave);
 *  8. connectivity: a flood fill over passable cells from EACH ancient reaches
 *     the other ancient, every structure and every camp clearing;
 *  9. no concave traps: no passable cell has impassable neighbours on 3+ of
 *     its 4 sides — this is what makes the wall-slide push-out sufficient and
 *     is why creeps need no navmesh;
 * 10. camp isolation: every camp centre is >= CAMP_LANE_CLEARANCE from every
 *     lane polyline, so a passing wave can never aggro a camp;
 * 11. elevation coherence: every high cell borders low ground only through a
 *     'cliff' or a 'ramp' — an unmarked step would let units walk uphill and
 *     make the uphill vision and miss rules read as a bug.
 *
 * Rules 6..11 read the grid ONLY through the frozen O(1) queries, sampled at
 * cell centres, and are skipped as a body if the grid does not cover the map
 * square (every sample would address the wrong cell).
 */
export function validateMap(map: MapDef): MapValidation {
  const errors: string[] = [];
  const finite = (s: StructureDef): boolean => Number.isFinite(s.x) && Number.isFinite(s.z);

  // -- rule 1: finiteness + bounds --------------------------------------------
  const sideOk = Number.isFinite(map.side) && map.side > 0;
  if (!sideOk) {
    errors.push(`map side is not a positive finite number: ${String(map.side)}`);
  }
  if (sideOk) {
    const hi = map.side - 1; // inside [0, side] minus a 1 m frame
    for (const [pi, path] of map.paths.entries()) {
      for (const [wi, w] of path.entries()) {
        if (!Number.isFinite(w.x) || !Number.isFinite(w.z)) {
          errors.push(
            `lane ${pi} waypoint ${wi} is not finite: [${String(w.x)}, ${String(w.z)}]`,
          );
        } else if (w.x < 1 || w.x > hi || w.z < 1 || w.z > hi) {
          errors.push(
            `lane ${pi} waypoint ${wi} at (${w.x.toFixed(2)}, ${w.z.toFixed(2)}) is outside ` +
              `[1, ${hi.toFixed(2)}]^2 — the map square minus its 1 m frame`,
          );
        }
      }
    }
    for (const s of map.structures) {
      if (!finite(s)) {
        errors.push(
          `structure #${s.id} (${s.kind}) is not finite: [${String(s.x)}, ${String(s.z)}]`,
        );
      } else if (s.x < 1 || s.x > hi || s.z < 1 || s.z > hi) {
        errors.push(
          `structure #${s.id} (${s.kind}) at (${s.x.toFixed(2)}, ${s.z.toFixed(2)}) is outside ` +
            `[1, ${hi.toFixed(2)}]^2 — the map square minus its 1 m frame`,
        );
      }
    }
  }

  // -- rule 2: mirror symmetry through the centre, both directions ------------
  // Iterating every structure asserts team 0 -> team 1 AND team 1 -> team 0.
  if (sideOk) {
    for (const s of map.structures) {
      if (!finite(s)) continue; // rule 1 already reports it
      const mx = map.side - s.x;
      const mz = map.side - s.z;
      let best = Infinity;
      for (const t of map.structures) {
        if (t.team === s.team || t.kind !== s.kind || !finite(t)) continue;
        const d = Math.hypot(t.x - mx, t.z - mz);
        if (d < best) best = d;
      }
      if (!(best <= MIRROR_TOL)) {
        errors.push(
          `structure #${s.id} (team ${s.team} ${s.kind} at (${s.x.toFixed(2)}, ${s.z.toFixed(2)})) ` +
            `has no mirror counterpart: its reflection through the centre lands at ` +
            `(${mx.toFixed(2)}, ${mz.toFixed(2)}), ` +
            (best === Infinity
              ? `and team ${1 - s.team} has no ${s.kind} at all`
              : `and the nearest team ${1 - s.team} ${s.kind} is ${best.toFixed(4)} m away`),
        );
      }
    }
  }

  // -- rule 3: pathability + tower proximity -----------------------------------
  // Walking the polyline in both directions intersects the same discs, so an
  // exact point-to-polyline distance check covers both directions at once.
  for (const [pi, path] of map.paths.entries()) {
    const first = path[0];
    const last = path[path.length - 1];
    for (const s of map.structures) {
      if (!finite(s)) continue; // rule 1 already reports it
      // The two Ancients at the path endpoints are EXEMPT: units must reach
      // them to attack. Only an ancient sitting exactly on an endpoint is.
      if (s.kind === 'ancient' && first && last) {
        const onEndpoint =
          Math.hypot(s.x - first.x, s.z - first.z) <= MIRROR_TOL ||
          Math.hypot(s.x - last.x, s.z - last.z) <= MIRROR_TOL;
        if (onEndpoint) continue;
      }
      const d = polylineDistance(path, s.x, s.z);
      const need = KIND_RADIUS[s.kind] + HERO_RADIUS;
      if (d < need) {
        errors.push(
          `lane ${pi} path passes ${d.toFixed(2)} m from structure #${s.id} (${s.kind}) — ` +
            `a ${HERO_RADIUS} m hero disc walking the lane would overlap its ` +
            `${KIND_RADIUS[s.kind]} m disc (needs >= ${need.toFixed(2)} m)`,
        );
      }
    }
  }
  for (const s of map.structures) {
    if (s.kind !== 'tower' || !finite(s)) continue;
    if (s.lane === null || !Number.isInteger(s.lane) || s.lane < 0 || s.lane >= map.paths.length) {
      errors.push(
        `tower #${s.id} references lane ${String(s.lane)} — lane towers must sit on a lane ` +
          `polyline (0..${map.paths.length - 1})`,
      );
      continue;
    }
    const path = map.paths[s.lane];
    if (!path) continue; // bounds-checked above; unreachable
    const d = polylineDistance(path, s.x, s.z);
    if (d > TOWER_PATH_MAX_DIST) {
      errors.push(
        `tower #${s.id} centre is ${d.toFixed(2)} m from lane ${s.lane} polyline — ` +
          `lane towers must stand within ${TOWER_PATH_MAX_DIST} m of their lane`,
      );
    }
  }

  // -- rule 4: pairwise edge-to-edge clearance ----------------------------------
  for (let i = 0; i < map.structures.length; i++) {
    const a = map.structures[i]!;
    if (!finite(a)) continue;
    for (let j = i + 1; j < map.structures.length; j++) {
      const b = map.structures[j]!;
      if (!finite(b)) continue;
      const dist = Math.hypot(a.x - b.x, a.z - b.z);
      const edge = dist - KIND_RADIUS[a.kind] - KIND_RADIUS[b.kind];
      if (edge < STRUCTURE_MARGIN) {
        errors.push(
          `structures #${a.id} (${a.kind}) and #${b.id} (${b.kind}) have ${edge.toFixed(2)} m ` +
            `edge-to-edge clearance — below the ${STRUCTURE_MARGIN} m minimum (centres ` +
            `${dist.toFixed(2)} m apart, radii ${KIND_RADIUS[a.kind]} + ${KIND_RADIUS[b.kind]})`,
        );
      }
    }
  }

  // -- rule 5: identical structure counts per team per kind ----------------------
  const kinds: readonly StructureKind[] = ['tower', 'guard', 'ancient'];
  for (const kind of kinds) {
    let c0 = 0;
    let c1 = 0;
    for (const s of map.structures) {
      if (s.kind !== kind) continue;
      if (s.team === 0) c0++;
      else if (s.team === 1) c1++;
    }
    if (c0 !== c1) {
      errors.push(
        `team 0 has ${c0} ${kind}(s) but team 1 has ${c1} — both teams must field ` +
          `identical structure counts per kind`,
      );
    }
  }

  // == TERRAIN (TERRAIN_CONTRACT §3), rules 6..11 ================================
  // Precondition for all six: the grid must BE the map square. A grid that
  // disagrees with map.side would make every sample below address the wrong
  // cell, so it is reported once and the six rules are skipped rather than
  // emitting thousands of meaningless offsets.
  const terrain = map.terrain;
  const dim = terrain.grid.dim;
  const res = terrain.grid.res;
  const gridOk =
    sideOk &&
    Number.isInteger(dim) &&
    dim > 0 &&
    Number.isFinite(res) &&
    res > 0 &&
    Math.abs(dim - map.side * res) < 1e-9;
  if (!gridOk) {
    errors.push(
      `terrain grid does not cover the map square: grid.dim = ${String(dim)} at grid.res = ` +
        `${String(res)} spans ${String(dim / res)} m, but the map side is ${String(map.side)} m — ` +
        `terrain rules 6..11 were skipped because every cell sample would address the wrong cell`,
    );
  }

  if (gridOk) {
    // -- rule 6: mirror exactness (cells, then camps) ---------------------------
    // The reflection of a cell centre is exactly another cell centre, so kinds
    // and elevations compare exactly — no tolerance. Each mirrored PAIR is
    // tested once (only cells whose own linear index is below their partner's),
    // so one broken cell yields one error, not two.
    const mirrorCells = capped(
      errors,
      (n) =>
        `terrain mirror: ${n} further cell(s) differ from their reflection through the map centre`,
    );
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        const p = j * dim + i;
        const q = (dim - 1 - j) * dim + (dim - 1 - i);
        if (p >= q) continue;
        const x = cellMid(i, res);
        const z = cellMid(j, res);
        const mx = map.side - x;
        const mz = map.side - z;
        const ka = kindAt(terrain, x, z);
        const kb = kindAt(terrain, mx, mz);
        if (ka !== kb) {
          mirrorCells.add(
            () =>
              `terrain mirror break at (${x.toFixed(1)}, ${z.toFixed(1)}): kind '${ka}', but its ` +
              `reflection through the centre at (${mx.toFixed(1)}, ${mz.toFixed(1)}) is '${kb}' — ` +
              `the halves must be identical under (x,z) -> (side-x, side-z)`,
          );
          continue; // one report per pair; a wrong kind usually drags elevation with it
        }
        const ea = elevationAt(terrain, x, z);
        const eb = elevationAt(terrain, mx, mz);
        if (ea !== eb) {
          mirrorCells.add(
            () =>
              `terrain mirror break at (${x.toFixed(1)}, ${z.toFixed(1)}): elevation ${ea} on a ` +
              `'${ka}' cell, but its reflection at (${mx.toFixed(1)}, ${mz.toFixed(1)}) is ` +
              `elevation ${eb} — the halves must be identical under (x,z) -> (side-x, side-z)`,
          );
        }
      }
    }
    mirrorCells.flush();
    // §3: "Every terrain cell AND EVERY CAMP must satisfy it exactly." Iterating
    // every camp asserts half 0 -> half 1 and half 1 -> half 0, exactly as rule
    // 2 does for structures, and reports the measured miss the same way.
    for (const c of terrain.camps) {
      const mx = map.side - c.x;
      const mz = map.side - c.z;
      let best = Infinity;
      for (const d of terrain.camps) {
        if (d.half === c.half || d.tier !== c.tier) continue;
        const gap = Math.hypot(d.x - mx, d.z - mz);
        if (gap < best) best = gap;
      }
      if (!(best <= MIRROR_TOL)) {
        errors.push(
          `${campLabel(c)} at (${c.x.toFixed(2)}, ${c.z.toFixed(2)}) has no mirror counterpart: ` +
            `its reflection through the centre lands at (${mx.toFixed(2)}, ${mz.toFixed(2)}), ` +
            (best === Infinity
              ? `and half ${1 - c.half} has no ${c.tier} camp at all`
              : `and the nearest half ${1 - c.half} ${c.tier} camp is ${best.toFixed(4)} m away`),
        );
      }
    }

    // -- rule 7: lane pathability (the hero disc never touches a cliff) ---------
    // Marched at LANE_DISC_STEP, a quarter of a cell, so no cliff cell can slip
    // between two consecutive samples. Overlap is measured against the cell
    // SQUARE, not its centre: a disc clipping the corner of a cliff cell is a
    // collision. Each offending cell is named once per lane, however many
    // samples touch it, and each lane gets its own budget of samples so a
    // broken lane 0 never hides a broken lane 1.
    for (const [pi, path] of map.paths.entries()) {
      const len = pathLength(path);
      const samples = Math.max(1, Math.ceil(len / LANE_DISC_STEP));
      const reported = new Set<number>();
      const laneErrors = capped(
        errors,
        (n) => `lane ${pi}: ${n} further 'cliff' cell(s) lie under the lane corridor`,
      );
      for (let s = 0; s <= samples; s++) {
        const arc = Math.min(len, s * LANE_DISC_STEP);
        const pose = walkPath(path, arc);
        const i0 = cellIndex(pose.x - HERO_RADIUS, res, dim);
        const i1 = cellIndex(pose.x + HERO_RADIUS, res, dim);
        const j0 = cellIndex(pose.z - HERO_RADIUS, res, dim);
        const j1 = cellIndex(pose.z + HERO_RADIUS, res, dim);
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const key = j * dim + i;
            if (reported.has(key)) continue;
            const x = cellMid(i, res);
            const z = cellMid(j, res);
            if (kindAt(terrain, x, z) !== 'cliff') continue;
            const qx = Math.min(Math.max(pose.x, i / res), (i + 1) / res);
            const qz = Math.min(Math.max(pose.z, j / res), (j + 1) / res);
            const d = Math.hypot(pose.x - qx, pose.z - qz);
            if (d >= HERO_RADIUS) continue;
            reported.add(key);
            laneErrors.add(
              () =>
                `lane ${pi} is not pathable ${arc.toFixed(2)} m along its polyline: a ` +
                `${HERO_RADIUS} m hero disc centred (${pose.x.toFixed(2)}, ${pose.z.toFixed(2)}) ` +
                `overlaps the 'cliff' cell at (${x.toFixed(1)}, ${z.toFixed(1)}) — ${d.toFixed(2)} m ` +
                `from the disc centre, needs >= ${HERO_RADIUS.toFixed(2)} m ('ramp' is permitted ` +
                `across a lane, 'cliff' is not)`,
            );
          }
        }
      }
      laneErrors.flush();
    }

    // -- rule 8: connectivity by flood fill over passable cells -----------------
    // One fill per ancient, each asserting it reaches the other ancient, every
    // structure and every camp clearing. A target's cell being impassable is a
    // different defect from its being walled off, so it is reported once, up
    // front, and excluded from the reachability pass rather than reported twice.
    let passableTotal = 0;
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        if (isPassable(terrain, cellMid(i, res), cellMid(j, res))) passableTotal++;
      }
    }
    const targets: ReachTarget[] = [];
    for (const s of map.structures) {
      if (!finite(s)) continue; // rule 1 already reports it
      targets.push(
        reachTarget(terrain, res, dim, `structure #${s.id} (team ${s.team} ${s.kind})`, s.x, s.z),
      );
    }
    for (const c of terrain.camps) {
      targets.push(reachTarget(terrain, res, dim, `${campLabel(c)} clearing`, c.x, c.z));
    }
    for (const target of targets) {
      if (!target.passable) {
        errors.push(
          `terrain connectivity: ${target.label} at (${target.x.toFixed(2)}, ` +
            `${target.z.toFixed(2)}) stands on an impassable '${target.kind}' cell — nothing can ` +
            `walk to it`,
        );
      }
    }
    for (const anc of map.structures) {
      if (anc.kind !== 'ancient' || !finite(anc)) continue;
      const si = cellIndex(anc.x, res, dim);
      const sj = cellIndex(anc.z, res, dim);
      if (!isPassable(terrain, cellMid(si, res), cellMid(sj, res))) continue; // reported above
      const seen = new Uint8Array(dim * dim);
      const start = sj * dim + si;
      seen[start] = 1;
      const stack: number[] = [start];
      let reached = 1;
      while (stack.length > 0) {
        const p = stack.pop();
        if (p === undefined) break; // length > 0 guarantees a value; narrowing only
        const pi = p % dim;
        const pj = (p - pi) / dim;
        for (const n of NEIGHBOURS) {
          const ni = pi + n.di;
          const nj = pj + n.dj;
          if (ni < 0 || ni >= dim || nj < 0 || nj >= dim) continue;
          const q = nj * dim + ni;
          if (seen[q] === 1) continue;
          if (!isPassable(terrain, cellMid(ni, res), cellMid(nj, res))) continue;
          seen[q] = 1;
          reached++;
          stack.push(q);
        }
      }
      for (const target of targets) {
        if (!target.passable) continue; // already reported, and trivially unreachable
        if (seen[target.cell] === 1) continue;
        errors.push(
          `terrain connectivity: ${target.label} at (${target.x.toFixed(2)}, ` +
            `${target.z.toFixed(2)}) is unreachable from team ${anc.team}'s ancient at ` +
            `(${anc.x.toFixed(2)}, ${anc.z.toFixed(2)}) — the passable flood fill from there ` +
            `covers ${reached} of ${passableTotal} passable cells and never reaches it`,
        );
      }
    }

    // -- rule 9: no concave traps -----------------------------------------------
    const traps = capped(
      errors,
      (n) =>
        `terrain traps: ${n} further passable cell(s) have impassable neighbours on 3 or more of ` +
        `their 4 sides`,
    );
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        const x = cellMid(i, res);
        const z = cellMid(j, res);
        if (!isPassable(terrain, x, z)) continue;
        const blocked = blockedSideCount(terrain, res, dim, i, j);
        if (blocked < 3) continue;
        traps.add(
          () =>
            `terrain trap at (${x.toFixed(1)}, ${z.toFixed(1)}): the passable ` +
            `'${kindAt(terrain, x, z)}' cell is walled on ${blocked} of its 4 sides ` +
            `(${blockedSideLabels(terrain, res, dim, i, j)}) — at most 2 may be impassable, or a ` +
            `unit that walks in cannot wall-slide back out`,
        );
      }
    }
    traps.flush();

    // -- rule 10: camp isolation from every lane ---------------------------------
    for (const c of terrain.camps) {
      let best = Infinity;
      let bestLane = -1;
      for (const [li, path] of map.paths.entries()) {
        const d = polylineDistance(path, c.x, c.z);
        if (d < best) {
          best = d;
          bestLane = li;
        }
      }
      if (best < CAMP_LANE_CLEARANCE) {
        errors.push(
          `${campLabel(c)} at (${c.x.toFixed(2)}, ${c.z.toFixed(2)}) is ${best.toFixed(2)} m from ` +
            `lane ${bestLane}'s polyline — a camp must sit at least ${CAMP_LANE_CLEARANCE} m from ` +
            `every lane, or a passing wave will aggro it`,
        );
      }
    }

    // -- rule 11: elevation coherence ---------------------------------------------
    // Subject: every non-transition cell at ELEV_HIGH — which is 'high', 'base'
    // and any high camp clearing, NOT just the plateau kinds, because §3 lets a
    // camp clearing be 'ground' at either elevation. 'cliff' and 'ramp' ARE the
    // marked transition, so they are never the subject and are always a legal
    // neighbour. The map frame is a wall and is skipped: there is no low ground
    // outside it to step down to.
    const stepErrors = capped(
      errors,
      (n) =>
        `terrain elevation: ${n} further high cell(s) border low ground with no 'cliff' or 'ramp' ` +
        `between them`,
    );
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        const x = cellMid(i, res);
        const z = cellMid(j, res);
        const k = kindAt(terrain, x, z);
        if (isTransition(k)) continue;
        if (elevationAt(terrain, x, z) !== ELEV_HIGH) continue;
        for (const n of NEIGHBOURS) {
          const ni = i + n.di;
          const nj = j + n.dj;
          if (ni < 0 || ni >= dim || nj < 0 || nj >= dim) continue;
          const nx = cellMid(ni, res);
          const nz = cellMid(nj, res);
          const nk = kindAt(terrain, nx, nz);
          if (isTransition(nk)) continue;
          if (elevationAt(terrain, nx, nz) === ELEV_HIGH) continue;
          stepErrors.add(
            () =>
              `terrain elevation step at (${x.toFixed(1)}, ${z.toFixed(1)}): the high '${k}' cell ` +
              `borders the low '${nk}' cell at (${nx.toFixed(1)}, ${nz.toFixed(1)}) on its ` +
              `${n.label} side with no 'cliff' or 'ramp' between them — an unmarked step lets ` +
              `units walk uphill and makes the uphill vision and miss rules read as a bug`,
          );
          break; // one report per offending high cell, however many sides step down
        }
      }
    }
    stepErrors.flush();
  }

  return { ok: errors.length === 0, errors };
}

/** validateMap, but fatal — for startup/registry guards. */
export function assertValidMap(map: MapDef): void {
  const v = validateMap(map);
  if (!v.ok) throw new Error(`invalid map (${map.lanes} lanes): ${v.errors.join('; ')}`);
}
