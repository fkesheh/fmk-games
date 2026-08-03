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
// ============================================================================
import {
  ANCIENT,
  ANCIENT_GUARDS,
  BASE_INSET,
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

  return { lanes, side, paths, structures };
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

  return { ok: errors.length === 0, errors };
}

/** validateMap, but fatal — for startup/registry guards. */
export function assertValidMap(map: MapDef): void {
  const v = validateMap(map);
  if (!v.ok) throw new Error(`invalid map (${map.lanes} lanes): ${v.errors.join('; ')}`);
}
