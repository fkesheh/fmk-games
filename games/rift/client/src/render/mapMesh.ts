// ============================================================================
// ANCIENTS (rift) — MAP MESHES (R_MAPMESH). Everything static on the map that
// is NOT the ground and NOT a scattered prop:
//
//   * the STRUCTURES, from `buildStructure(kind, team)` (R_MESH_STRUCT), placed
//     at `map.structures` and drawn as one `InstancedMesh` per (archetype,
//     bucket) — plus the turning tower crystal and the bobbing Ancient heart,
//     which are this module's to animate because nothing else holds them;
//   * the LANE KERBS that frame the paving R_TERRAIN paints, laid against the
//     terrain GRID rather than against the polyline, so a stretch the terrain
//     did not pave gets no kerb — one `InstancedMesh` for every kerb on the map;
//   * the BASE RIM STELAE that give each base plateau a built edge, one
//     `InstancedMesh` per team;
//   * the four LANDMARK set pieces of `map.terrain.landmarks`, which are unique
//     geometry and therefore merged, per 16 m chunk, by `bakeChunked()`.
//
// ---- HOW THE DRAW-CALL BUDGET IS SPENT (GRAPHICS_CONTRACT §5) --------------
// `BUILD_SPECS` R_MAPMESH asks for two different things and they apply to
// different geometry: "bake per 16x16 m chunk" is for geometry that exists once,
// and "instance repeated props" is for geometry that exists many times. A kerb
// block is the SAME 0.50 x 0.26 x 1.40 box two hundred and forty-nine times
// over; chunk-baking it bought one draw call per chunk any kerb touched. Counted
// in the scene graph on the 3-lane map, putting the repeated props through the
// chunk bake cost 57 chunk groups and 104 meshes; instancing them and chunk-
// baking only the unique set pieces costs 10 groups and 51 meshes, of which one
// mesh carries every kerb on the map.
//
// ---- WHAT THIS MODULE NO LONGER DRAWS (AMENDMENT_3, BUILD_SPECS R_MAPMESH) --
// THE GROUND AND THE LANE PAVING ARE GONE. R_TERRAIN owns the walkable surface
// and paints `'lane'` cells `lanePaving`, `'base'` cells `monumentStone`,
// `'river'` `wetRock`, and so on. The previous cut drew its own `moss` disc, its
// own mottling decals and its own paving ribbons on top of all that — two
// modules drawing the same ground, which is z-fighting by construction. Every
// one of them is deleted, and with them the six `core.mat(...)` call sites and
// the last `MeshLambertMaterial` in this file.
//
// THE DECO CLUSTERS ARE GONE TOO. `render/vegetation.ts` (R_VEG) owns "trees,
// undergrowth, rocks, deadwood, ruin fragments and the river bank" through the
// kit's `scatter()`, at the STYLE_BIBLE §8 densities and with the §8 variation
// law applied per instance. The clusters here were the same three archetypes
// scattered a second time, from a second seed, with no keep-out agreement
// between the two. Hand-placed landmarks stay here, exactly as `contract.ts`
// and `terrain.ts` both say.
//
// ---- LAWS OBSERVED HERE ----------------------------------------------------
//  * MATERIAL LAW. This file constructs no material. Static parts name a
//    `SurfaceId` on a `Part` and `bake()`/`bakeChunked()` resolve it through
//    `partMaterial()`; the anim rigs call `partMaterial()` directly with the
//    `AnimPart`'s own (surfaceId, tint, emissive) triple, which is the one
//    resolver and therefore a cache hit on the material the archetype already
//    built. Zero `core.mat`, zero Lambert, zero `new THREE.Mesh*Material`.
//  * VERTEX-COLOUR LAW. Every static part is a kit primitive going through
//    `bake()` or `bakeChunked()` — including the two instanced prototypes, which
//    is exactly why they are baked rather than hand-assembled: `bake()` emits the
//    white `color` attribute and reprojects the UVs itself. The anim
//    geometry does NOT pass through `bake()`, so `whiteVertexColors(geo)` is
//    called on it here (AMENDMENT_3 §B) — idempotent, so it costs nothing when
//    the mesh module already did it, and without it the crystals render BLACK
//    with a perfectly clean typecheck.
//  * UV LAW. No `texture.repeat` anywhere and no per-object texture scale. The
//    static parts take `bake()`'s world-space reprojection at 1 UV unit = 1 m.
//    An instanced prototype is reprojected about the ORIGIN, so its copies do
//    not continue one world-space texture between them — which is how every
//    instanced prop in this game already works (`scatter()` in R_VEG) and is
//    invisible on a 1.4 m block against a 1 m tiling surface.
//    The anim parts need no UV scaling and get none: `SURFACES.crystal` is the
//    one family in the table with `normal: null` and `roughnessMap: false`, so
//    it samples no texture at all and its UVs are unused.
//  * BLOOM. Nothing here decides what glows. A structure archetype arrives with
//    its bloom buckets already on `BLOOM_LAYER` (R_MESH_STRUCT marked them) and
//    the instanced copy is marked iff the archetype's own bucket was; an anim
//    part is marked iff `AnimPart.bloom` says so. No emissive is invented and no
//    `emissiveIntensity` is raised to fake a glow.
//  * SHADOWS. `castShadow` is never written here. `applyShadowPolicy(root, cls)`
//    from R_SCENE is the single owner (AMENDMENT_3 §D.2, AMENDMENT_4 §C) and is
//    called once per group with its class: `'structure'` for the structures and
//    the landmark set pieces, `null` for kerbs, stelae and every anim part.
//  * DETERMINISM. Kerb gaps, tower yaw and stone lean come from the kit's seeded
//    `rng`, keyed on the lane count, consumed in a fixed job order. No
//    `Math.random`, and no clock in any geometry decision — the clock is read
//    only to decide how much of the build to do this frame.
//  * FRAME OWNERSHIP. One frame hook, and its whole body sits inside one
//    try/catch: a throw from a bake, from a mesh builder or from the anim rig is
//    a logged error and a stopped queue, never a dead frame (`core.ts`: "a hook
//    that throws takes the frame down with it; guard your own entry point"). A
//    failed build is never reported as a finished one.
//  * NOTHING FLOATS AND NOTHING SINKS. Every placement is seated on
//    `SceneCore.heightAt`, sampled at the part's OWN (x, z) — and at every foot
//    of a multi-footed piece, whose datum is the LOWEST of them, so the piece
//    rests on the ground rather than on the highest point under it.
//
// ---- MEASURED FACTS THIS FILE DEPENDS ON -----------------------------------
// LANE WIDTH. `paintLanes` marks a cell `'lane'` when its CENTRE is within
// `LANE_CORRIDOR_HALF_W` (3 m) of the polyline, so the painted paving reaches
// about 3.5 m either side — half a cell past the corridor. Kerbs at the old
// 1.7-2.2 m sat well INSIDE that: a rail down the middle of the road. They now
// sit at 3.60-4.10 m, and the placement is not trusted to that arithmetic at
// all — a block is emitted only where `kindAt` says the kerb point is open
// ground or foliage AND a probe 1.2 m inboard says `'lane'`. That is also why
// the terrain fold defect (lane stretches rendering as moss) could not have laid
// kerbs down both sides of moss even before R_TERRAIN fixed it: the grid is the
// same data the terrain paints from, and an unpaved stretch is still `'lane'`.
//
// STRUCTURE ENVELOPES. Measured off the baked archetypes at build time
// (`envelopeOf`), never typed. As shipped by R_MESH_STRUCT and measured here:
// tower 2.54 m x 9.41 m tall, guard 2.94 m x 9.10 m, Ancient 5.19 m x 13.93 m.
// The tripling of the heights (the tower was 3.5 m) is exactly the kind of
// change a hand-typed radius survives silently, and the old
// `PLATFORM_RADIUS = 7.6` in this file was one of those. The
// measured envelope is what keeps kerbs and stelae off the structures, and its
// RADIAL SILHOUETTE — the greatest reach per bearing, not one disc radius — is
// what `reportClearance` walks against the real placement so the Ancient/guard
// clearance is stated in numbers rather than in adjectives.
//
// GUARD INSET. The guards' visual envelope does not fit the ground the frozen
// placement gives them: at `GUARD_FLANK_DIST` 7.51 m from its Ancient, a guard's
// scattered plinth stone reached 10.11-10.27 m from the base plateau's centre
// against a `BASE_PLATFORM_RADIUS` of 10, so all four guards on the map hung
// over the cliff ring, and the team-1 flank grazed the Ancient's dais. Neither
// side can move: `GUARD_FLANK_DIST` drives tower aggro and pathing, and the
// plateau is a 1 m grid disc whose cliff ring already runs out to `BASE_INSET`
// with nothing spare. So the guard archetype is drawn with a HORIZONTAL inset —
// `guardInset`, ~0.87 — solved in closed form as the largest scale whose every
// vertex still lands inside the plateau rim. It is a mesh-side change only: the
// build stays on its entity's own coordinate, its height is untouched, and the
// sim's `GUARD_TOWER.radius` 1.2 never sees it. It also RETIRES ITSELF — the
// solve returns 1 the day R_MESH_STRUCT brings the guard's ground scatter inside
// 2.44 m of outward reach, which is what it would take to carry the authored
// "18% broader than a lane tower" tell at full size.
//
// LANDMARK FOOTPRINT. R_VEG keeps `LANDMARK_KEEP_R` = 4 m clear around every
// landmark anchor and says in its own comment that the number is an assumption
// to be moved if a set piece is wider. It is not: every set piece below fits
// inside `LANDMARK_MAX_R` = 4.0 m of its anchor, and `guardFootprint` MEASURES
// each one against that rather than promising it in prose.
// ============================================================================
import * as THREE from 'three';
import { APAL, BASE_PLATFORM_RADIUS, GUARD_FLANK_DIST, kindAt } from '@rift/shared';
import type { MapDef, StructureDef, TeamId, Vec2 } from '@rift/shared';
import type { SurfaceId } from '@rift/shared/surfaces.js';
import { mix } from '@platform/shared';
import type { SceneHandle } from '../contract.js';
import type { AnimPart, ChunkedBake, Part, Rng, UnitBuild } from './kit.js';
import {
  BLOOM_LAYER,
  bake,
  bakeChunked,
  box,
  cone,
  cyl,
  ico,
  markBloom,
  partMaterial,
  rng,
  sphere,
} from './kit.js';
import type { SceneCore } from './core.js';
import { sceneCore, whiteVertexColors } from './core.js';
import { applyShadowPolicy } from './scene.js';
import { buildStructure } from './meshes/structures.js';

// ---- budget -----------------------------------------------------------------

/** Spatial bake grid, metres. GRAPHICS_CONTRACT §5 and the kit's own `bake()`
 *  doc: static world geometry bakes per 16x16 m chunk. One map-wide merge would
 *  be one draw call with zero frustum culling, which is a different failure. */
const CHUNK_M = 16;

/** Ceiling on the main-thread time the whole build queue may spend in ONE frame,
 *  milliseconds. AMENDMENT_3 §E.2: "a budget of 16 ms means no frame exceeds
 *  16 ms", and three consecutive 32 ms frames is a failed slice, not a slow one.
 *  It is a DEADLINE ACROSS ALL JOBS, not a per-job slice — stepping five jobs at
 *  6 ms each would be the same 30 ms frame the budget exists to prevent. */
const FRAME_SLICE_MS = 6;

/** Per-step budget handed to each `bakeChunked`. Small on purpose: `step()`
 *  checks the clock only AFTER a unit of work, so the outer deadline can be
 *  overshot by at most one merge plus this. */
const BAKE_SLICE_MS = 1.5;

// ---- lane kerbs --------------------------------------------------------------

/** Distance from the lane polyline to the CENTRE of a kerb block, metres. The
 *  painted paving reaches ~3.5 m (see the header), so 3.85 puts the block's
 *  inner face at 3.60 — clear of the paving, on the verge, and 0.60 m clear of
 *  the 6 m walkable corridor. */
const KERB_OFFSET = 3.85;
const KERB_W = 0.5;
const KERB_L = 1.4;
const KERB_H = 0.26;
/** How far a block is pushed below the LOWEST ground sample under it, so it
 *  reads as set into the verge rather than resting on it: 0.26 m tall, 0.07 m
 *  buried, 0.19 m proud at its low end. */
const KERB_SINK = 0.07;
/** The most ground relief a block may span, metres, sampled at both ends AND at
 *  its centre. Seating on the LOW sample means a block never floats — but it
 *  says nothing about the HIGH one, and a block laid across more relief than it
 *  is tall is simply underground at its high end.
 *
 *  MEASURED, not assumed. The kerb line follows the lane verge and the verge
 *  runs past ramp mouths and plateau edges, so the relief under a 1.4 m block is
 *  NOT the +/-0.22 m of open-ground undulation the previous cut assumed: the
 *  worst block on the 3-lane map spanned 0.52 m, which buries all 0.26 m of it
 *  and then some. A block is proud at its high end only while the relief stays
 *  under `KERB_H - KERB_SINK` = 0.19 m, so 0.18 leaves 0.01 m of stone showing
 *  in the worst case that is still laid. Steeper than that and no block is
 *  emitted — a gap where the ground breaks is what a real kerb does anyway. */
const KERB_MAX_RELIEF = 0.18;
/** Arc-length spacing between kerb blocks, metres — 0.3 m of joint between
 *  1.4 m blocks. */
const KERB_STEP = 1.7;
/** Seeded chance that a block is simply missing. Without gaps a kerb reads as a
 *  railing; with them it reads as stone that has been there a while. */
const KERB_GAP_P = 0.3;
/** How far inboard of a candidate block the `'lane'` probe is taken, metres. */
const KERB_LANE_PROBE = 1.2;
/** Extra clearance kept between a kerb block and a structure's MEASURED
 *  envelope, metres. */
const KERB_STRUCTURE_CLEAR = 0.8;

// ---- base rim ----------------------------------------------------------------

/** Team stelae round the rim of each base plateau. `BASE_PLATFORM_RADIUS` is
 *  10 m and the disc's outermost cell is its cliff ring, so 8.6 m stands them ON
 *  the plateau rather than over the drop. */
const STELE_R = 8.6;
const STELE_COUNT = 12;
const STELE_H = 1.55;
const STELE_W = 0.52;
/** Clearance from a structure's measured envelope before a stele is dropped. */
const STELE_CLEAR = 0.5;

// ---- landmarks ---------------------------------------------------------------

/** Hard cap on the horizontal radius of every set piece, metres, checked
 *  against the emitted geometry by `guardFootprint`. R_VEG keeps exactly this
 *  much clear around each anchor (`LANDMARK_KEEP_R`), so a piece wider than this
 *  is a piece with a tree growing through it. */
const LANDMARK_MAX_R = 4.0;

// ---- structure animation -----------------------------------------------------

/** Orbit radius of a tower crystal about the tower axis in metres, and its
 *  angular rate in radians per second. */
const ORBIT_R = 0.9;
const ORBIT_RATE = 0.55;
/** Spin of an anim part about its own Y axis, radians per second. */
const SPIN_RATE = 1.1;
/** Bob amplitude in metres and rate in radians per second. */
const BOB_AMP = 0.22;
const BOB_RATE = 0.85;

/** Written over a dead structure's instance in every bucket it occupies. A
 *  zero-scale matrix collapses the instance to a single degenerate point at
 *  the origin — zero-area triangles are never rasterised — which is the one
 *  way to remove ONE instance from a static bake that has no per-instance
 *  visibility. */
const ZERO_INSTANCE = new THREE.Matrix4().makeScale(0, 0, 0);

// ============================================================================
// Small geometry helpers
// ============================================================================

/** Squared distance, so the placement loops never call `Math.hypot`. */
function d2(ax: number, az: number, bx: number, bz: number): number {
  return (ax - bx) * (ax - bx) + (az - bz) * (az - bz);
}

function pathLength(path: readonly Vec2[]): number {
  let len = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a === undefined || b === undefined) continue;
    len += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return len;
}

/** A point on a polyline plus its unit tangent. */
interface PathSample {
  readonly x: number;
  readonly z: number;
  readonly tx: number;
  readonly tz: number;
}

/** Arc-length sample `d` metres along the polyline, or null past its end. */
function samplePath(path: readonly Vec2[], d: number): PathSample | null {
  let left = d;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a === undefined || b === undefined) continue;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len <= 0) continue;
    if (left <= len) {
      const u = left / len;
      return {
        x: a.x + (b.x - a.x) * u,
        z: a.z + (b.z - a.z) * u,
        tx: (b.x - a.x) / len,
        tz: (b.z - a.z) / len,
      };
    }
    left -= len;
  }
  return null;
}

/** The nearest point on the polyline to (px, pz), with that segment's unit
 *  tangent. The ruined gate's anchor sits ON lane 0 and the gate has to straddle
 *  it square, so it needs the lane's direction rather than its own position. */
function tangentNear(path: readonly Vec2[], px: number, pz: number): PathSample | null {
  let best = Infinity;
  let out: PathSample | null = null;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a === undefined || b === undefined) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    if (len2 <= 0) continue;
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / len2));
    const qx = a.x + t * dx;
    const qz = a.z + t * dz;
    const dd = d2(px, pz, qx, qz);
    if (dd >= best) continue;
    best = dd;
    const len = Math.sqrt(len2);
    out = { x: qx, z: qz, tx: dx / len, tz: dz / len };
  }
  return out;
}

/** Seat a part on the ground under it: `heightAt` at its own (x, z), less
 *  `sink`. Everything this module places goes through here or through
 *  {@link footDatum}, which is what makes "nothing floats" a property of the
 *  code rather than a claim in a comment. */
function seat(core: SceneCore, x: number, z: number, sink: number): number {
  return core.heightAt(x, z) - sink;
}

/** The datum for a piece with more than one foot: the LOWEST ground sample under
 *  any of them. Seating on the mean, or on the anchor, leaves the downhill foot
 *  in the air. */
function footDatum(core: SceneCore, xs: readonly number[], zs: readonly number[]): number {
  let low = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const z = zs[i];
    if (x === undefined || z === undefined) continue;
    const y = core.heightAt(x, z);
    if (y < low) low = y;
  }
  return low === Infinity ? 0 : low;
}

// ============================================================================
// Part accumulation, chunked by 16 m
// ============================================================================

/** Deferred geometry: a chunk's parts are not built until the scheduler reaches
 *  that chunk, so `buildMapMeshes` returns after placement arithmetic alone and
 *  no frame pays for geometry it has not been asked for yet. */
type Emit = (out: Part[]) => void;

function chunkKey(x: number, z: number): string {
  return `${String(Math.floor(x / CHUNK_M))}:${String(Math.floor(z / CHUNK_M))}`;
}

/** The 16 m chunk grid, for geometry that is UNIQUE and therefore has to be
 *  merged rather than instanced — here, the four landmark set pieces. Insertion-
 *  ordered, so the bake order (and therefore the rng stream and the scene graph)
 *  is identical on every machine and in every judge round. */
class ChunkSet {
  readonly chunks = new Map<string, Emit[]>();

  add(x: number, z: number, emit: Emit): void {
    const key = chunkKey(x, z);
    let list = this.chunks.get(key);
    if (list === undefined) {
      list = [];
      this.chunks.set(key, list);
    }
    list.push(emit);
  }
}

function push(out: Part[], geo: THREE.BufferGeometry, surface: SurfaceId, tint: string): void {
  out.push({ geo, surface, tint });
}

/** One placed copy of an instanced prop family: where its ALREADY-SEATED origin
 *  goes, and how far it is turned about Y. `y` is the finished world height, so
 *  the frame hook never samples terrain and the prototype never carries an
 *  offset of its own. */
interface Placement {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

// ============================================================================
// Structure archetypes
// ============================================================================

/** Bearing buckets in a structure's radial silhouette, one degree each. Chosen
 *  against the vertex counts actually shipped — the guard archetype carries 4020
 *  vertices and the Ancient 8496, so a one-degree bucket holds ten or more of
 *  them and the profile is sampled, not guessed. Empty buckets are filled from
 *  their nearest occupied neighbours in `envelopeOf`, upwards: an unsampled
 *  bearing over-states the silhouette, so the clearance report errs towards
 *  firing rather than towards silence. */
const HULL_SECTORS = 360;

/** The measured reach and height of a built archetype. Both come off the baked
 *  buckets' own vertices, so they track whatever R_MESH_STRUCT actually shipped
 *  rather than a number written down beside it. The hidden damage layer is
 *  excluded: it is never drawn on a healthy structure, and including it would
 *  over-report the envelope of every structure on the map. */
interface Envelope {
  /** Greatest horizontal distance from the build origin to any visible VERTEX.
   *  Measured per vertex, not off the axis-aligned bounding box: a box corner
   *  distance over-reports a piece that is offset diagonally. This is the disc
   *  that keeps kerbs and stelae out — a prop can stand at any bearing, so for
   *  a keep-out the worst bearing IS the right number. */
  readonly radius: number;
  /** Top of the visible geometry above the build origin, metres. */
  readonly top: number;
  /** Greatest horizontal reach per bearing bucket, metres, indexed by
   *  `sectorOf`. Two structures at a KNOWN separation meet along one bearing,
   *  not along their worst two, and the difference is not academic: summing the
   *  disc radii called every Ancient/guard pair 0.51-0.62 m interpenetrated
   *  when, walked by bearing, three of the four flanks stand 0.23-1.08 m clear
   *  and the fourth grazes by 0.02 m. Quoting the disc sum at R_MESH_STRUCT
   *  would have asked for 0.6 m off the biggest build in the game to close a
   *  2 cm graze — the same mistake, one level up, that `radius` already avoids
   *  by not being an AABB corner. */
  readonly hull: Float32Array;
}

/** Bucket index for a bearing, from a horizontal offset. */
function sectorOf(x: number, z: number): number {
  const s = Math.floor(((Math.atan2(z, x) + Math.PI) / (2 * Math.PI)) * HULL_SECTORS);
  return s < 0 ? 0 : s >= HULL_SECTORS ? HULL_SECTORS - 1 : s;
}

/** The silhouette's reach in the direction of a horizontal offset, metres. */
function hullAt(env: Envelope, x: number, z: number): number {
  return env.hull[sectorOf(x, z)] ?? 0;
}

/** Measure an archetype, optionally as it will be DRAWN rather than as it was
 *  built: `xz` is the horizontal inset the instance matrices will carry, so
 *  every number this returns describes pixels on the screen. A caller that
 *  passes 1 measures the build itself.
 */
function envelopeOf(group: THREE.Object3D, xz: number): Envelope {
  // The archetype comes out of `bake()`, whose bucket meshes sit at identity —
  // but the world matrix is applied anyway, so a builder that ever nests a
  // transform cannot silently shrink the measured envelope.
  group.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const seen = new Float32Array(HULL_SECTORS);
  let r2 = 0;
  let top = 0;
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh !== true || mesh.visible === false) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (pos === undefined) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const x = v.x * xz;
      const z = v.z * xz;
      const d = x * x + z * z;
      if (d > r2) r2 = d;
      if (v.y > top) top = v.y;
      const s = sectorOf(x, z);
      const r = Math.sqrt(d);
      if (r > (seen[s] ?? 0)) seen[s] = r;
    }
  });
  // Close the bearings no vertex landed in, from the nearest occupied bucket on
  // each side, keeping the larger. Two wrapping laps per direction so a run of
  // empties that straddles the +/-180 seam is filled from both ends.
  const hull = Float32Array.from(seen);
  for (const dir of [1, -1] as const) {
    let carry = 0;
    for (let lap = 0; lap < 2; lap++) {
      for (let n = 0; n < HULL_SECTORS; n++) {
        const s = dir === 1 ? n : HULL_SECTORS - 1 - n;
        const hit = seen[s] ?? 0;
        if (hit > 0) carry = hit;
        else if (carry > (hull[s] ?? 0)) hull[s] = carry;
      }
    }
  }
  return { radius: Math.sqrt(r2), top, hull };
}

/** One archetype = one (kind, team) pair, built once and instanced across every
 *  structure that wears it. Twelve lane towers on a 3-lane map are twelve
 *  matrices in one `InstancedMesh` per bucket, not twelve copies of six meshes:
 *  the structures' draw cost is therefore (archetypes x buckets) plus the
 *  casting half of the same, FLAT in the number of structures. That is the
 *  single largest lever this module has on the 700 gate, and it is the reason
 *  AMENDMENT_3 §D's "≈228, at map scale" is not what this places. */
interface Archetype {
  readonly kind: StructureDef['kind'];
  readonly team: TeamId;
  readonly at: readonly StructureDef[];
}

function archetypesOf(map: MapDef): Archetype[] {
  const byKey = new Map<string, StructureDef[]>();
  for (const s of map.structures) {
    const key = `${s.kind}:${String(s.team)}`;
    let list = byKey.get(key);
    if (list === undefined) {
      list = [];
      byKey.set(key, list);
    }
    list.push(s);
  }
  const out: Archetype[] = [];
  for (const at of byKey.values()) {
    const first = at[0];
    if (first === undefined) continue;
    out.push({ kind: first.kind, team: first.team, at });
  }
  return out;
}

/** Yaw applied to one placed structure, radians.
 *
 *  Lane towers get a seeded EIGHTH-TURN, so twelve identical builds do not read
 *  as twelve photocopies of one building. An eighth turn and not a free angle
 *  because every lathe in `structures.ts` is `seg 8`: a multiple of the facet
 *  pitch keeps the octagon's silhouette crisp against a raking sun instead of
 *  landing a facet edge-on to it.
 *
 *  Guards and Ancients are left EXACTLY as authored. They are asymmetric builds
 *  — an Ancient has arms, a bowed helm and a standard — and the module that
 *  composed them chose which way they face. Spinning one here on a guess is how
 *  the game's biggest silhouette ends up presenting its back to the player. */
function yawOf(s: StructureDef, r: Rng): number {
  return s.kind === 'tower' ? Math.floor(r.next() * 8) * (Math.PI / 4) : 0;
}

// ============================================================================
// The animated carve-outs: tower crystals and Ancient hearts
// ============================================================================

/** One instanced anim rig: every structure of one archetype shares a geometry, a
 *  material and one `InstancedMesh`, and the frame hook rewrites the matrices.
 *  Four rigs exist on a 3-lane map (tower x 2 teams, ancient x 2 teams) and they
 *  cost four draw calls, none of them in the shadow pass — an anim part never
 *  casts (AMENDMENT_3 §D.2). */
interface AnimRig {
  readonly mesh: THREE.InstancedMesh;
  readonly kind: 'orbit' | 'bob' | 'spin';
  /** Base world position of each instance: the structure's foot plus `animY`. */
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  /** Per-instance phase offset, so twelve crystals do not turn in lockstep. */
  readonly phase: Float32Array;
  /** 1 at a dead structure's index: the frame hook skips it, so the zero-scale
   *  matrix `hideStructure` writes is never overwritten by the animation. */
  readonly dead: Uint8Array;
}

function makeAnimRig(
  anim: AnimPart,
  kind: 'orbit' | 'bob' | 'spin',
  animY: number,
  at: readonly StructureDef[],
  core: SceneCore,
  r: Rng,
): AnimRig {
  // The anim geometry never went through `bake()`, so the vertex-colour law is
  // this module's to keep (AMENDMENT_3 §B). Idempotent, so it is a no-op when
  // the mesh module already did it — and `structures.ts` does.
  whiteVertexColors(anim.geo);
  const material = partMaterial(anim.surfaceId, anim.tint, anim.emissive);
  const mesh = new THREE.InstancedMesh(anim.geo, material, at.length);
  mesh.name = 'rift:mapAnim';
  if (anim.bloom) markBloom(mesh);
  // The instances move every frame, so a bounding sphere computed once is wrong
  // by the orbit radius from the next frame on. Four meshes are cheap enough to
  // draw unconditionally; a per-frame world-bounds recompute is not.
  mesh.frustumCulled = false;
  const n = at.length;
  const rig: AnimRig = {
    mesh,
    kind,
    px: new Float32Array(n),
    py: new Float32Array(n),
    pz: new Float32Array(n),
    phase: new Float32Array(n),
    dead: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) {
    const s = at[i];
    if (s === undefined) continue;
    rig.px[i] = s.x;
    rig.py[i] = core.heightAt(s.x, s.z) + animY;
    rig.pz[i] = s.z;
    rig.phase[i] = r.next() * Math.PI * 2;
  }
  return rig;
}

/** Where one structure lives in the baked statics: the same instance index in
 *  every bucket `InstancedMesh` of its archetype, plus its anim-rig slot and
 *  the composed placement matrix they all share (kept so `resetStructures`
 *  can restore a hidden instance without re-measuring anything). */
interface StructureSlot {
  readonly buckets: readonly THREE.InstancedMesh[];
  readonly rig: AnimRig | null;
  readonly index: number;
  readonly mat: THREE.Matrix4;
  hidden: boolean;
}

/** Control over the baked structures after the build: collapse one dead
 *  structure's instance out of every bucket that draws it (and stop its anim
 *  rig), or restore them all at a rematch.
 *
 *  `buildMapMeshes` returns this AND installs it on the `SceneHandle` itself
 *  as `riftStructureControl`, because the one consumer that needs it — the
 *  Game (T8), which sees every snapshot — may not import this module
 *  (CONTRACT §6) and wire.ts has no channel for it. The Game reads the
 *  property off `ClientModules.scene` through the same kind of cast seam
 *  render/core.ts's `sceneCore` reads `.core` through. */
export interface MapStructureControl {
  /** Collapse one structure's instance in every bucket of its archetype.
   *  Idempotent; safe before the archetype's bake has run (the hide is
   *  applied when phase 2 of its job lands) and a no-op for an id the map
   *  does not have. */
  hideStructure(structureId: number): void;
  /** Restore every hidden instance. Called on rift_begin: a rematch on the
   *  same map reuses this bake (wire.ts), and last match's dead towers must
   *  not stay down. */
  resetStructures(): void;
}

// ============================================================================
// Landmarks
// ============================================================================

const STONE_A = mix(APAL.cliff, APAL.cliffDeep, 0.35);
const STONE_B = mix(APAL.cliff, APAL.cliffLit, 0.3);
const WET_A = mix(APAL.wetStone, APAL.wetStoneDeep, 0.3);
const WET_B = mix(APAL.wetStone, APAL.wetStoneLit, 0.35);
const MONU_A = mix(APAL.monument, APAL.monumentDeep, 0.4);
const MONU_B = mix(APAL.monument, APAL.monumentLit, 0.25);

/**
 * The collapsed arch in the river band — the map's one asymmetric set piece and
 * the thing players mean by "the arch". It SPANS the river rather than lying
 * along it: the anchor sits on the river centreline pushed out along the
 * anti-diagonal, so `anchor - centre` IS the river's own direction and the span
 * axis is its perpendicular. Derived, not hard-coded, so a change to the river's
 * bearing carries.
 *
 * Reach from the anchor: piers 2.50 + 0.86 = 3.36 m, rubble 3.10 + 0.66 =
 * 3.76 m — inside `LANDMARK_MAX_R`.
 */
function riverArch(
  out: Part[],
  core: SceneCore,
  cx: number,
  cz: number,
  x: number,
  z: number,
): void {
  let ax = x - cx;
  let az = z - cz;
  const len = Math.hypot(ax, az);
  if (len < 1e-3) {
    ax = 1;
    az = 0;
  } else {
    ax /= len;
    az /= len;
  }
  // Perpendicular to the river = the span axis.
  const sx = -az;
  const sz = ax;
  const yaw = Math.atan2(sx, sz);

  const fx = [x + sx * 2.5, x - sx * 2.5];
  const fz = [z + sz * 2.5, z - sz * 2.5];
  const base = footDatum(core, fx, fz);

  // Two piers, 3.5 m tall, leaning in toward each other by 0.09 rad. The lean
  // says "collapsed" before the missing span does. Seated with their centres
  // 1.65 m above the datum, so 0.10 m of each pier is buried.
  for (let i = 0; i < 2; i++) {
    const sgn = i === 0 ? 1 : -1;
    push(
      out,
      cyl(0.62, 0.86, 3.5, 8, {
        rz: -sgn * 0.09,
        ry: yaw,
        x: x + sx * 2.5 * sgn,
        y: base + 1.65,
        z: z + sz * 2.5 * sgn,
      }),
      'wetRock',
      WET_A,
    );
  }
  // The surviving haunch: three voussoirs climbing off ONE pier and stopping in
  // mid-air. The other half is gone, which is the whole read.
  for (let i = 0; i < 3; i++) {
    const t = (i + 0.5) / 5;
    const a = Math.PI * t;
    const px = x + sx * (2.5 - 2.5 * (1 - Math.cos(a)));
    const pz = z + sz * (2.5 - 2.5 * (1 - Math.cos(a)));
    push(
      out,
      box(1.0, 0.62, 0.9, {
        rz: -a * 0.5,
        ry: yaw,
        x: px,
        y: base + 3.4 + Math.sin(a) * 1.15,
        z: pz,
      }),
      'wetRock',
      WET_B,
    );
  }
  // Fallen voussoirs at the foot, each seated on its own ground sample.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.7;
    const rr = 2.2 + (i % 2) * 0.9;
    const px = x + Math.cos(a) * rr;
    const pz = z + Math.sin(a) * rr;
    push(
      out,
      ico(0.44 + (i % 3) * 0.11, 0, { ry: a, x: px, y: seat(core, px, pz, 0.16), z: pz }),
      'wetRock',
      i % 2 === 0 ? WET_A : WET_B,
    );
  }
}

/**
 * A ring of monoliths on bare high ground (STYLE_BIBLE §8), with a low altar
 * slab at its centre. SEVEN stones, not eight: an odd count never resolves into
 * two facing rows from the fixed 55 deg camera.
 *
 * Reach from the anchor: 2.90 + the stone's own corner 0.37 + up to 0.15 of
 * lean = 3.42 m — inside `LANDMARK_MAX_R`.
 */
function standingStones(out: Part[], core: SceneCore, x: number, z: number, r: Rng): void {
  const RING = 2.9;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const px = x + Math.cos(a) * RING;
    const pz = z + Math.sin(a) * RING;
    const h = r.range(1.7, 2.7);
    const lean = r.range(-0.11, 0.11);
    push(
      out,
      box(0.62, h, 0.42, {
        rz: lean,
        ry: -a,
        x: px,
        y: seat(core, px, pz, 0.22) + h / 2,
        z: pz,
      }),
      'cliffRock',
      i % 2 === 0 ? STONE_A : STONE_B,
    );
  }
  push(
    out,
    cyl(1.15, 1.3, 0.34, 10, { x, y: seat(core, x, z, 0.12) + 0.17, z }),
    'cliffRock',
    STONE_B,
  );
}

/**
 * A toppled colossus lying in open low jungle: a broken torso drum, the head
 * fallen clear of it, one forearm, and the stump of the plinth it stood on.
 *
 * The drum is 0.92 m at its wide end and its axis sits 0.60 m above the foot
 * datum, so its underside is 0.32 m BELOW the ground — settled in, which is what
 * a statue that has lain here long enough to be a landmark looks like.
 *
 * Reach from the anchor: the head at 3.10 + 0.72 = 3.82 m, the plinth stump at
 * 2.90 + its corner 0.96 = 3.86 m — inside `LANDMARK_MAX_R`.
 */
function fallenColossus(out: Part[], core: SceneCore, x: number, z: number, r: Rng): void {
  const a = r.next() * Math.PI * 2;
  const dx = Math.cos(a);
  const dz = Math.sin(a);
  const base = footDatum(core, [x - dx * 2.3, x + dx * 2.3], [z - dz * 2.3, z + dz * 2.3]);
  // `rz` lays the cylinder's Y axis into the XZ plane; `ry` then aims it down
  // the fall line.
  push(
    out,
    cyl(0.78, 0.92, 4.6, 10, { rz: Math.PI / 2, ry: -a, x, y: base + 0.6, z }),
    'monumentStone',
    MONU_A,
  );
  const hx = x + dx * 3.1;
  const hz = z + dz * 3.1;
  push(
    out,
    sphere(0.72, 10, { rz: 0.5, ry: a, x: hx, y: seat(core, hx, hz, 0.3) + 0.72, z: hz }),
    'monumentStone',
    MONU_B,
  );
  const ax = x - dz * 1.5 + dx * 0.6;
  const az = z + dx * 1.5 + dz * 0.6;
  push(
    out,
    cyl(0.3, 0.36, 1.9, 8, {
      rz: Math.PI / 2 - 0.18,
      ry: -a + 0.9,
      x: ax,
      y: seat(core, ax, az, 0.14) + 0.3,
      z: az,
    }),
    'monumentStone',
    MONU_B,
  );
  const px = x - dx * 2.9;
  const pz = z - dz * 2.9;
  push(
    out,
    box(1.5, 0.7, 1.2, { ry: -a, x: px, y: seat(core, px, pz, 0.3) + 0.35, z: pz }),
    'monumentStone',
    MONU_A,
  );
}

/**
 * An ARCH over lane 0 where it leaves the base ramp. `TerrainDef.landmarks`:
 * "the corridor under it stays walkable, and the mesh must not read as a wall."
 *
 * Both are geometry, not intent. The piers stand 3.50 m either side of the
 * polyline with a foot radius of 0.46 m, so their inner faces are at 3.04 m and
 * the 6 m walkable corridor (`LANE_CORRIDOR_HALF_W` 3) passes between them with
 * 0.04 m to spare. The lintel's underside sits `PIER_H` + the corbel's 0.34 m =
 * 4.44 m above the foot datum, which is more than twice the tallest hero, and it
 * is emitted as TWO blocks with a 1.60 m gap where the keystone fell — the gap
 * is the ruin, and it is also what stops the piece reading as a wall.
 *
 * Reach from the anchor: 3.50 + the corbel's 0.48 = 3.98 m — inside
 * `LANDMARK_MAX_R`, which is what keeps R_VEG's 4 m keep-out honest.
 */
function ruinedGate(
  out: Part[],
  core: SceneCore,
  x: number,
  z: number,
  tan: PathSample | null,
): void {
  const tx = tan === null ? 1 : tan.tx;
  const tz = tan === null ? 0 : tan.tz;
  // Left normal of travel: the axis the gate straddles along.
  const nx = -tz;
  const nz = tx;
  const yaw = Math.atan2(tx, tz);
  const OFF = 3.5;
  const PIER_H = 4.1;
  const base = footDatum(core, [x + nx * OFF, x - nx * OFF], [z + nz * OFF, z - nz * OFF]);

  for (let i = 0; i < 2; i++) {
    const sgn = i === 0 ? 1 : -1;
    const px = x + nx * OFF * sgn;
    const pz = z + nz * OFF * sgn;
    push(
      out,
      cyl(0.4, 0.46, PIER_H, 8, { ry: yaw, x: px, y: base + PIER_H / 2, z: pz }),
      'monumentStone',
      MONU_A,
    );
    // A corbel where the lintel lands, so the span does not float on a flat top.
    // Its top is at base + PIER_H + 0.34, which is exactly the lintel underside.
    push(
      out,
      cyl(0.48, 0.44, 0.34, 8, { ry: yaw, x: px, y: base + PIER_H + 0.17, z: pz }),
      'monumentStone',
      MONU_B,
    );
  }
  // Two lintel blocks, each 3.0 m long, centred 2.3 m out along the straddle
  // axis: each spans 0.80..3.80 m, so it lands 0.30 m onto its own corbel (which
  // reaches 3.98 m) and leaves a 1.60 m gap at the crown.
  const spanY = base + PIER_H + 0.34 + 0.31;
  for (let i = 0; i < 2; i++) {
    const sgn = i === 0 ? 1 : -1;
    push(
      out,
      box(0.72, 0.62, 3.0, {
        ry: yaw + Math.PI / 2,
        x: x + nx * 2.3 * sgn,
        y: spanY,
        z: z + nz * 2.3 * sgn,
      }),
      'monumentStone',
      MONU_B,
    );
  }
  // The keystone, on the ground under the gap it left.
  const kx = x + tx * 1.1;
  const kz = z + tz * 1.1;
  push(
    out,
    box(0.9, 0.55, 1.1, {
      rx: 0.32,
      ry: yaw + 0.4,
      x: kx,
      y: seat(core, kx, kz, 0.2) + 0.275,
      z: kz,
    }),
    'monumentStone',
    MONU_A,
  );
  // Two toppled cap stones off the gate mouth, each on its own ground sample.
  for (let i = 0; i < 2; i++) {
    const sgn = i === 0 ? 1 : -1;
    const qx = x + tx * 1.6 * sgn + nx * 2.7 * sgn;
    const qz = z + tz * 1.6 * sgn + nz * 2.7 * sgn;
    push(
      out,
      box(0.9, 0.4, 0.8, { ry: yaw + 0.5 * sgn, x: qx, y: seat(core, qx, qz, 0.16) + 0.2, z: qz }),
      'monumentStone',
      MONU_A,
    );
  }
}

/** Wrap a set piece's emitter so the geometry it actually produced is MEASURED
 *  against `LANDMARK_MAX_R`. R_VEG plants right up to a 4 m disc around every
 *  anchor on the strength of an assumption it flagged as one; this is the check
 *  that turns the assumption into a fact, or says out loud that it is not.
 *
 *  R_VEG's keep-out is a DISC, so the comparison is a per-vertex radius. The
 *  axis-aligned-box form of this check reported 4.25 m for the colossus and
 *  4.02 m for the gate — both false, and both a corner of a box around a piece
 *  lying on a diagonal rather than any vertex of it. */
function guardFootprint(x: number, z: number, kind: string, inner: Emit): Emit {
  return (out: Part[]): void => {
    const start = out.length;
    inner(out);
    let worst2 = 0;
    for (let i = start; i < out.length; i++) {
      const p = out[i];
      if (p === undefined) continue;
      const pos = p.geo.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (pos === undefined) continue;
      for (let v = 0; v < pos.count; v++) {
        const dx = pos.getX(v) - x;
        const dz = pos.getZ(v) - z;
        const d = dx * dx + dz * dz;
        if (d > worst2) worst2 = d;
      }
    }
    const worst = Math.sqrt(worst2);
    if (worst > LANDMARK_MAX_R) {
      console.warn(
        `rift mapMesh: the '${kind}' set piece reaches ${worst.toFixed(2)} m from its anchor, ` +
          `past the ${LANDMARK_MAX_R.toFixed(2)} m R_VEG keeps clear (LANDMARK_KEEP_R) — ` +
          'vegetation will grow through it.',
      );
    }
  };
}

// ============================================================================
// Placement
// ============================================================================

/** True when (x, z) is far enough from every structure's MEASURED envelope for a
 *  prop of radius `own` to stand there. */
function clearOfStructures(
  map: MapDef,
  envelopes: ReadonlyMap<string, Envelope>,
  x: number,
  z: number,
  own: number,
): boolean {
  for (const s of map.structures) {
    const env = envelopes.get(`${s.kind}:${String(s.team)}`);
    // An unmeasured archetype cannot happen — every archetype is built before
    // placement runs — but the fallback is deliberately GENEROUS rather than
    // zero, because the failure of a too-small keep-out is a prop inside a
    // tower and the failure of a too-large one is a missing kerb block.
    const need = (env === undefined ? 6 : env.radius) + own;
    if (d2(x, z, s.x, s.z) < need * need) return false;
  }
  return true;
}

/** Lane kerbs, laid against the terrain GRID. See the LANE WIDTH note in the
 *  header for why the polyline alone is not trusted.
 *
 *  Returns PLACEMENTS, not geometry: every kerb block on the map is the same
 *  0.50 x 0.26 x 1.40 box, so all 249 of them on the 3-lane map are one
 *  `InstancedMesh` and one draw call. Merging them per 16 m chunk instead cost
 *  one draw call per chunk they touch, against a 700 gate that AMENDMENT_3 §D
 *  already puts at ≈463 before this module contributes anything. */
function placeKerbs(
  map: MapDef,
  core: SceneCore,
  envelopes: ReadonlyMap<string, Envelope>,
  r: Rng,
): Placement[] {
  const out: Placement[] = [];
  for (const path of map.paths) {
    const steps = Math.floor(pathLength(path) / KERB_STEP);
    for (let i = 0; i < steps; i++) {
      const s = samplePath(path, (i + 0.5) * KERB_STEP);
      if (s === null) continue;
      const nx = -s.tz;
      const nz = s.tx;
      const yaw = Math.atan2(s.tx, s.tz);
      for (let side = 0; side < 2; side++) {
        if (r.next() < KERB_GAP_P) continue;
        const sgn = side === 0 ? 1 : -1;
        const x = s.x + nx * KERB_OFFSET * sgn;
        const z = s.z + nz * KERB_OFFSET * sgn;
        // The kerb point must be verge...
        const here = kindAt(map.terrain, x, z);
        if (here !== 'ground' && here !== 'foliage') continue;
        // ...and the paving must actually be beside it. This is the whole
        // defence against kerbing a stretch the terrain never paved.
        const ix = s.x + nx * (KERB_OFFSET - KERB_LANE_PROBE) * sgn;
        const iz = s.z + nz * (KERB_OFFSET - KERB_LANE_PROBE) * sgn;
        if (kindAt(map.terrain, ix, iz) !== 'lane') continue;
        if (!clearOfStructures(map, envelopes, x, z, KERB_STRUCTURE_CLEAR)) continue;
        // Seat on the LOWEST of the block's three ground samples, then sink —
        // and refuse the block outright where the relief across it would bury
        // its high end (see `KERB_MAX_RELIEF`).
        const ex = s.tx * (KERB_L / 2);
        const ez = s.tz * (KERB_L / 2);
        const ya = core.heightAt(x - ex, z - ez);
        const yb = core.heightAt(x, z);
        const yc = core.heightAt(x + ex, z + ez);
        const low = Math.min(ya, yb, yc);
        if (Math.max(ya, yb, yc) - low > KERB_MAX_RELIEF) continue;
        out.push({ x, y: low - KERB_SINK + KERB_H / 2, z, yaw });
      }
    }
  }
  return out;
}

/** One team's ring of rim stelae: the placements, and the tint every one of them
 *  wears. Two rings on a map, so two prototypes and two draw calls. */
interface SteleRing {
  readonly tint: string;
  readonly at: readonly Placement[];
}

/** Team stelae round each base plateau's rim: a capped monolith, desaturated
 *  well toward the monument stone it stands in. A saturated ring of team colour
 *  at this size reads as a UI element rather than as architecture.
 *
 *  Instanced per team for the same reason the kerbs are: twelve identical
 *  monoliths per base are one geometry, and the only thing that differs between
 *  the two rings is the tint, which is what mints the material. */
function placeBaseRim(
  map: MapDef,
  core: SceneCore,
  envelopes: ReadonlyMap<string, Envelope>,
): SteleRing[] {
  const rings: SteleRing[] = [];
  for (const s of map.structures) {
    if (s.kind !== 'ancient') continue;
    const tint = mix(s.team === 0 ? APAL.azure : APAL.ember, APAL.monument, 0.62);
    const at: Placement[] = [];
    for (let i = 0; i < STELE_COUNT; i++) {
      const a = (i / STELE_COUNT) * Math.PI * 2 + Math.PI / STELE_COUNT;
      const x = s.x + Math.cos(a) * STELE_R;
      const z = s.z + Math.sin(a) * STELE_R;
      // On the plateau itself, never on its cliff ring or over the drop.
      if (kindAt(map.terrain, x, z) !== 'base') continue;
      if (!clearOfStructures(map, envelopes, x, z, STELE_CLEAR)) continue;
      at.push({ x, y: seat(core, x, z, 0.15) + STELE_H / 2, z, yaw: -a });
    }
    if (at.length > 0) rings.push({ tint, at });
  }
  return rings;
}

/** The stele prototype, built about its own centre so a `Placement` is a
 *  position and a yaw and nothing else. The cap's quarter-turn against the shaft
 *  is baked in here — it is a property of the stele, not of where it stands. */
function steleProto(tint: string): Part[] {
  return [
    { geo: box(STELE_W, STELE_H, STELE_W), surface: 'monumentStone', tint },
    {
      geo: cone(0.42, 0.46, 4, { ry: Math.PI / 4, y: STELE_H / 2 + 0.23 }),
      surface: 'monumentStone',
      tint,
    },
  ];
}

/** The four set-piece kinds. `TerrainDef.landmarks[].kind` is typed `string`, so
 *  an unknown kind is representable even though the generator emits exactly
 *  four: it is skipped and NAMED, never silently dropped and never guessed at. */
function placeLandmarks(chunks: ChunkSet, map: MapDef, core: SceneCore, r: Rng): void {
  const cx = map.side / 2;
  const cz = map.side / 2;
  const lane0 = map.paths[0] ?? null;
  const unknown = new Set<string>();
  for (const lm of map.terrain.landmarks) {
    const { kind, x, z } = lm;
    if (kind === 'riverArch') {
      chunks.add(
        x,
        z,
        guardFootprint(x, z, kind, (out) => riverArch(out, core, cx, cz, x, z)),
      );
    } else if (kind === 'standingStones') {
      chunks.add(
        x,
        z,
        guardFootprint(x, z, kind, (out) => standingStones(out, core, x, z, r)),
      );
    } else if (kind === 'fallenColossus') {
      chunks.add(
        x,
        z,
        guardFootprint(x, z, kind, (out) => fallenColossus(out, core, x, z, r)),
      );
    } else if (kind === 'ruinedGate') {
      const tan = lane0 === null ? null : tangentNear(lane0, x, z);
      chunks.add(
        x,
        z,
        guardFootprint(x, z, kind, (out) => ruinedGate(out, core, x, z, tan)),
      );
    } else {
      unknown.add(kind);
    }
  }
  if (unknown.size > 0) {
    console.warn(
      `rift mapMesh: no set piece for landmark kind(s) ${[...unknown].join(', ')} — they are ` +
        'UNPLACED. TerrainDef.landmarks documents exactly four kinds.',
    );
  }
}

// ============================================================================
// Clearance (AMENDMENT_3 §G.3, and the R_MESH_STRUCT seam)
// ============================================================================

/** Metres of daylight a guard's drawn silhouette must keep inside
 *  `BASE_PLATFORM_RADIUS`. The plateau is painted on the frozen 1 m terrain grid
 *  and its cliff ring is carved from the LOW side, so the rim a player sees is a
 *  staircase about the nominal 10 m; a tenth of a metre is the smallest inset
 *  that reads as "standing on the plateau" rather than "level with its edge",
 *  and it costs the guard 0.03 of its scale over asking for zero. */
const RIM_CLEARANCE = 0.1;

/** Metres of daylight required between the Ancient's silhouette and a guard's,
 *  measured radially at the bearing where they face. Not zero: two builds that
 *  merely fail to share a vertex still read as one mass from the 55 deg camera,
 *  and `close-ancient` is a shot whose whole job is to show them apart. */
const STRUCT_CLEARANCE = 0.1;

/** Floor on `guardInset`. If the rim ever demanded more than this the answer is
 *  no longer "inset the guard" — a guard squashed past a fifth of its authored
 *  breadth stops reading as the broader-than-a-lane-tower build it is drawn to
 *  be — so the solve stops here and lets `reportClearance` say so out loud. */
const MIN_GUARD_INSET = 0.8;

/** Where one team's guards stand RELATIVE to the Ancient they flank — which is
 *  also relative to the centre of the base platform, since `terrain.ts` paints
 *  that disc on the Ancient. Read off `map.structures` rather than rebuilt from
 *  `GUARD_FLANK_DIST` and the diagonal, so a change to the placement rule
 *  arrives here on its own. */
function flankOffsets(map: MapDef, team: TeamId): Vec2[] {
  const seat = map.structures.find((s) => s.kind === 'ancient' && s.team === team);
  if (seat === undefined) return [];
  const out: Vec2[] = [];
  for (const s of map.structures) {
    if (s.kind === 'guard' && s.team === team) out.push({ x: s.x - seat.x, z: s.z - seat.z });
  }
  return out;
}

/**
 * The horizontal scale the guard archetype is DRAWN at, solved from the plateau
 * it stands on.
 *
 * A guard sits at `GUARD_FLANK_DIST` (7.51 m) from its Ancient, on a base
 * platform of `BASE_PLATFORM_RADIUS` (10 m) centred on that same Ancient. Both
 * numbers are frozen: `GUARD_FLANK_DIST` is derived from the GAMEPLAY radii
 * (`ANCIENT.radius` 2.3 + `GUARD_TOWER.radius` 1.2 + `STRUCTURE_MARGIN` 4) and
 * drives tower aggro and pathing, and the platform's radius plus its one-cell
 * cliff ring exactly fills the ground out to `BASE_INSET` with nothing spare.
 * The guard's VISUAL envelope answers to neither and, as shipped, overhung: its
 * scattered plinth stone reached 10.11-10.27 m from the plateau centre.
 *
 * So the geometry gives way, on the only side that can: for each placement this
 * asks for the largest scale `k` at which EVERY vertex still lands inside the
 * rim. |D + k v| = R is a quadratic in k with one positive root per vertex —
 * `(v.v)k^2 + 2(D.v)k + (D.D - R^2) = 0`, and `D.D < R^2` because the guard's
 * own origin is well inside the platform, so the discriminant is never negative
 * and the root is always real. The smallest root over every vertex and both
 * flanks is the answer, capped at 1: a guard that already fits is left alone.
 *
 * This changes pixels and nothing else. The build keeps its coordinate, its
 * yaw, its height and its hitbox; only its horizontal spread comes in, by ~13%.
 */
function guardInset(group: THREE.Object3D, offsets: readonly Vec2[]): number {
  group.updateMatrixWorld(true);
  const rim = BASE_PLATFORM_RADIUS - RIM_CLEARANCE;
  const v = new THREE.Vector3();
  let k = 1;
  for (const d of offsets) {
    const c = d.x * d.x + d.z * d.z - rim * rim;
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh !== true || mesh.visible === false) return;
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (pos === undefined) return;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        const a = v.x * v.x + v.z * v.z;
        // A vertex on the build's own axis cannot leave the rim at any scale.
        if (a < 1e-9) continue;
        const b = d.x * v.x + d.z * v.z;
        const root = (-b + Math.sqrt(b * b - a * c)) / a;
        if (root < k) k = root;
      }
    });
  }
  return k < MIN_GUARD_INSET ? MIN_GUARD_INSET : k;
}

/**
 * Walk the DRAWN Ancient and guard silhouettes against the REAL placement and
 * say, in metres, whether they stand clear of each other and of the plateau.
 *
 * This is the one place in the build that can see both sides — the archetypes
 * come from `structures.ts` and the coordinates from `map.ts`, and neither
 * module can see the other — so the measurement belongs here, and it is a
 * measurement of pixels: the envelopes it reads were taken AFTER `guardInset`,
 * so what it reports is what renders.
 *
 * It walks BEARINGS, not disc radii. Two builds 7.51 m apart meet along one
 * direction; adding the greatest reach of each, in whatever direction each
 * happens to have it, is a bound and not a measurement — on the shipped
 * archetypes it called every pair 0.51-0.62 m interpenetrated when the worst of
 * the four flanks grazes by 0.02 m and the other three stand 0.23-1.08 m clear,
 * and quoting that at R_MESH_STRUCT would have asked for 0.6 m off the biggest
 * build in the game to close a 2 cm graze.
 * Walking bearings is also STRICTER where it counts: it tests each flank
 * separately (the two differ by 0.28 m at the rim, which one disc cannot say),
 * it tests both directions of penetration, and it measures the true distance
 * from the plateau centre instead of assuming the worst vertex lies on the
 * outward ray.
 *
 * It reports; it does not fix. `guardInset` is the only lever this module
 * pulls, and it is solved from the rim alone — if the Ancient and its guard
 * still crowd each other after it, that IS R_MESH_STRUCT's to answer, and the
 * warning below is what asks, with the bearing and the metres.
 */
function reportClearance(map: MapDef, envelopes: ReadonlyMap<string, Envelope>): void {
  for (const team of [0, 1] as const) {
    const anc = envelopes.get(`ancient:${String(team)}`);
    const gua = envelopes.get(`guard:${String(team)}`);
    const seat = map.structures.find((s) => s.kind === 'ancient' && s.team === team);
    if (anc === undefined || gua === undefined || seat === undefined) continue;
    for (const g of map.structures) {
      if (g.kind !== 'guard' || g.team !== team) continue;
      const dx = g.x - seat.x;
      const dz = g.z - seat.z;
      const bearing = (Math.atan2(dz, dx) * 180) / Math.PI;
      let far = 0;
      let gap = Infinity;
      let gapAt = 0;
      // The guard's silhouette, bucket by bucket, in the Ancient's frame: how
      // far out on the plateau it reaches, and how much of the Ancient's own
      // reach is left under it.
      for (let s = 0; s < HULL_SECTORS; s++) {
        const phi = ((s + 0.5) / HULL_SECTORS) * 2 * Math.PI - Math.PI;
        const r = gua.hull[s] ?? 0;
        const wx = dx + r * Math.cos(phi);
        const wz = dz + r * Math.sin(phi);
        const dist = Math.hypot(wx, wz);
        if (dist > far) far = dist;
        const clear = dist - hullAt(anc, wx, wz);
        if (clear < gap) {
          gap = clear;
          gapAt = (Math.atan2(wz, wx) * 180) / Math.PI;
        }
      }
      // ...and the Ancient's silhouette in the guard's frame, which is the half
      // that catches an arm or a standard reaching sideways into the guard.
      for (let s = 0; s < HULL_SECTORS; s++) {
        const phi = ((s + 0.5) / HULL_SECTORS) * 2 * Math.PI - Math.PI;
        const r = anc.hull[s] ?? 0;
        const wx = r * Math.cos(phi) - dx;
        const wz = r * Math.sin(phi) - dz;
        const clear = Math.hypot(wx, wz) - hullAt(gua, wx, wz);
        if (clear < gap) {
          gap = clear;
          gapAt = (phi * 180) / Math.PI;
        }
      }
      if (gap < STRUCT_CLEARANCE) {
        console.warn(
          `rift mapMesh: team ${String(team)} Ancient and its guard at bearing ` +
            `${bearing.toFixed(0)} deg stand ${gap.toFixed(2)} m apart at bearing ` +
            `${gapAt.toFixed(0)} deg — under the ${STRUCT_CLEARANCE.toFixed(2)} m two ` +
            'silhouettes need to read as separate builds. The meshes must come in; ' +
            `GUARD_FLANK_DIST ${GUARD_FLANK_DIST.toFixed(2)} m is frozen gameplay data.`,
        );
      }
      if (far > BASE_PLATFORM_RADIUS) {
        console.warn(
          `rift mapMesh: team ${String(team)} guard at bearing ${bearing.toFixed(0)} deg ` +
            `overhangs the base plateau rim by ${(far - BASE_PLATFORM_RADIUS).toFixed(2)} m — ` +
            `its silhouette reaches ${far.toFixed(2)} m from the plateau centre against ` +
            `BASE_PLATFORM_RADIUS ${BASE_PLATFORM_RADIUS.toFixed(2)} m, and the inset ` +
            `hit its ${MIN_GUARD_INSET.toFixed(2)} floor.`,
        );
      }
    }
  }
}

// ============================================================================
// The build queue
// ============================================================================

/** One unit of deferred build work. `step()` returns true while work remains.
 *  `heavy` marks a job that cannot be subdivided from here — a `buildStructure`
 *  call — and that must therefore end the frame's slice by itself rather than
 *  start a second one inside the same deadline. */
interface Job {
  step(): boolean;
  readonly heavy: boolean;
}

/** Wrap one 16 m chunk of UNIQUE geometry — the landmark set pieces: the first
 *  step builds its parts and starts a `bakeChunked`, every later step drives it,
 *  and the shadow policy is applied once the last bucket has merged. A set piece
 *  is a static built mass, so it casts as a `'structure'`. */
function chunkJob(core: SceneCore, emits: readonly Emit[]): Job {
  let job: ChunkedBake | null = null;
  return {
    heavy: false,
    step(): boolean {
      if (job === null) {
        const parts: Part[] = [];
        for (const e of emits) e(parts);
        if (parts.length === 0) return false;
        job = bakeChunked(parts, BAKE_SLICE_MS);
        job.mesh.group.name = 'rift:map:set';
        core.three.add(job.mesh.group);
        return true;
      }
      const more = job.step();
      if (!more) applyShadowPolicy(job.mesh.group, 'structure');
      return more;
    },
  };
}

/**
 * One instanced prop family: a prototype built ONCE at the origin, and one
 * matrix per placement. This is `BUILD_SPECS` R_MAPMESH's "instance repeated
 * props", and it is the difference between one draw call for every kerb on the
 * map and one draw call per chunk any kerb touches.
 *
 * The prototype goes through `bake()` rather than being hand-assembled, because
 * `bake()` is what applies the UV law (world reprojection at 1 UV unit = 1 m)
 * and the vertex-colour law to a raw kit primitive. Its `group` is deliberately
 * discarded: this wants the merged BUCKETS — one geometry and one cached
 * material per (surface, tint) — not the meshes bake wraps them in. One bucket
 * becomes one `InstancedMesh`, so a prototype whose parts share a material is
 * exactly one draw call.
 *
 * Kerbs and stelae are props: `applyShadowPolicy(group, null)` per AMENDMENT_3
 * §D.2's caster whitelist, which names only `cliffRock`, structures, heroes and
 * tree trunks. They still RECEIVE.
 */
function instancedPropJob(
  core: SceneCore,
  name: string,
  proto: readonly Part[],
  at: readonly Placement[],
): Job {
  return {
    heavy: false,
    step(): boolean {
      if (at.length === 0) return false;
      const baked = bake(proto);
      const group = new THREE.Group();
      group.name = name;
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const p = new THREE.Vector3();
      const one = new THREE.Vector3(1, 1, 1);
      const axis = new THREE.Vector3(0, 1, 0);
      for (const bucket of baked.parts) {
        const inst = new THREE.InstancedMesh(bucket.geo, bucket.material, at.length);
        inst.name = name;
        inst.receiveShadow = true;
        for (let i = 0; i < at.length; i++) {
          const a = at[i];
          if (a === undefined) continue;
          p.set(a.x, a.y, a.z);
          q.setFromAxisAngle(axis, a.yaw);
          inst.setMatrixAt(i, m.compose(p, q, one));
        }
        inst.instanceMatrix.needsUpdate = true;
        // Instance-aware bounds: the prototype's own sphere is centred on the
        // origin and would cull every copy but one.
        inst.computeBoundingSphere();
        group.add(inst);
      }
      applyShadowPolicy(group, null);
      core.three.add(group);
      return false;
    },
  };
}

// ============================================================================
// buildMapMeshes
// ============================================================================

/**
 * Build every static map mesh that is not the ground and not a scattered prop,
 * and install the one frame hook that finishes the build and turns the
 * structures' animated parts.
 *
 * Called EXACTLY ONCE per match, by wire.ts, after `SceneHandle.setTerrain` —
 * every placement below samples `heightAt`, which returns 0 everywhere until
 * then. `core.fitMap(map)` is called here and only here. The sun's shadow
 * frustum is NOT fitted here any more: R_SCENE fits it to the camera's visible
 * ground footprint every frame (AMENDMENT_3, and `core.ts`'s `fitMap` doc).
 *
 * It returns as soon as the archetype list is queued — no geometry, no bake, not
 * one `buildStructure` call. Everything happens on the frame hook, one bounded
 * slice at a time, because a synchronous map build is precisely the one-second
 * join freeze this repo has already shipped once.
 *
 * The returned {@link MapStructureControl} collapses a dead structure's
 * instance out of the static bake (`hideStructure`) — the ONLY mutable door
 * into it. Because the build above is sliced, a hide that lands before its
 * archetype's bake is queued and applied when that bake finishes.
 */
export function buildMapMeshes(scene: SceneHandle, map: MapDef): MapStructureControl {
  const core = sceneCore(scene);
  core.fitMap(map);

  const r = rng(`rift:mapmesh:${String(map.lanes)}`);
  const envelopes = new Map<string, Envelope>();
  const rigs: AnimRig[] = [];
  const queue: Job[] = [];
  let failed = false;

  // ---- per-structure control state ------------------------------------------
  // Filled as each archetype's phase 2 lands; `pendingHide` carries deaths the
  // snapshots reported before the dead structure's bucket meshes existed.
  const slots = new Map<number, StructureSlot>();
  const pendingHide = new Set<number>();

  const applyHide = (slot: StructureSlot): void => {
    if (slot.hidden) return;
    slot.hidden = true;
    for (const b of slot.buckets) {
      b.setMatrixAt(slot.index, ZERO_INSTANCE);
      b.instanceMatrix.needsUpdate = true;
    }
    // The rig's matrices are rewritten every frame, so zeroing one here is not
    // enough — the `dead` flag is what keeps the frame hook off it.
    const rig = slot.rig;
    if (rig !== null) {
      rig.dead[slot.index] = 1;
      rig.mesh.setMatrixAt(slot.index, ZERO_INSTANCE);
      rig.mesh.instanceMatrix.needsUpdate = true;
    }
  };

  const control: MapStructureControl = {
    hideStructure(structureId: number): void {
      const slot = slots.get(structureId);
      if (slot === undefined) {
        // Not baked yet (or not a structure of this map — the pending set is
        // drained per archetype, so a foreign id costs one Set entry until
        // the build drains, then is dropped).
        pendingHide.add(structureId);
        return;
      }
      applyHide(slot);
    },
    resetStructures(): void {
      pendingHide.clear();
      for (const slot of slots.values()) {
        if (!slot.hidden) continue;
        slot.hidden = false;
        for (const b of slot.buckets) {
          b.setMatrixAt(slot.index, slot.mat);
          b.instanceMatrix.needsUpdate = true;
        }
        const rig = slot.rig;
        if (rig !== null) rig.dead[slot.index] = 0;
      }
    },
  };
  // The Game (T8) reads this off `ClientModules.scene`; see MapStructureControl.
  (scene as SceneHandle & { riftStructureControl?: MapStructureControl }).riftStructureControl =
    control;

  // ---- 1. one job per structure archetype, in THREE indivisible phases -------
  // Each phase ends the frame's slice by itself (`heavy`), because none of the
  // three can be subdivided from here. They are separated rather than run
  // together for a measured reason: as one step the archetype job peaked at
  // 15.9 ms of a 16 ms ceiling on this machine, which is not a margin — it is a
  // coin toss on a slower one. Split, the worst phase is well inside it.
  for (const a of archetypesOf(map)) {
    let build: UnitBuild | null = null;
    let mats: THREE.Matrix4[] = [];
    let phase = 0;
    queue.push({
      heavy: true,
      step(): boolean {
        // -- phase 0: the mesh build itself, the single most expensive call in
        //    this module and entirely R_MESH_STRUCT's to divide further.
        if (phase === 0) {
          build = buildStructure(a.kind, a.team);
          phase = 1;
          return true;
        }
        const done = build;
        if (done === null) return false;

        // -- phase 1: solve the guard's horizontal inset, measure the envelope
        //    AS DRAWN (a full vertex scan of the archetype) and compose the
        //    per-instance transforms. `heightAt` is the single authority for
        //    the foot of every structure.
        if (phase === 1) {
          // Only the guards are inset, and only by what the plateau rim demands
          // (`guardInset`). Every other archetype is drawn exactly as authored.
          const inset =
            a.kind === 'guard' ? guardInset(done.body.group, flankOffsets(map, a.team)) : 1;
          envelopes.set(`${a.kind}:${String(a.team)}`, envelopeOf(done.body.group, inset));
          mats = [];
          const q = new THREE.Quaternion();
          const pos = new THREE.Vector3();
          // Horizontal only: the guard's 9.10 m is a navigation tell against the
          // lane tower's 9.41 m, and scaling it away would trade one defect for
          // a worse one.
          const scale = new THREE.Vector3(inset, 1, inset);
          const axis = new THREE.Vector3(0, 1, 0);
          for (const s of a.at) {
            pos.set(s.x, core.heightAt(s.x, s.z), s.z);
            q.setFromAxisAngle(axis, yawOf(s, r));
            mats.push(new THREE.Matrix4().compose(pos, q, scale));
          }
          phase = 2;
          return mats.length > 0;
        }

        // -- phase 2: one InstancedMesh per bucket, plus the anim rig.
        const group = new THREE.Group();
        group.name = `rift:struct:${a.kind}:${String(a.team)}`;
        const buckets: THREE.InstancedMesh[] = [];
        for (const child of done.body.group.children) {
          if (!(child instanceof THREE.Mesh)) continue;
          // The hidden damage layer is never drawn on a healthy structure, and
          // there is no damaged structure in a static map bake.
          if (child.visible === false) continue;
          const mat = child.material;
          if (Array.isArray(mat)) continue;
          const inst = new THREE.InstancedMesh(child.geometry, mat, mats.length);
          inst.name = child.name === '' ? 'rift:structBucket' : child.name;
          inst.receiveShadow = true;
          for (let i = 0; i < mats.length; i++) {
            const mm = mats[i];
            if (mm !== undefined) inst.setMatrixAt(i, mm);
          }
          inst.instanceMatrix.needsUpdate = true;
          // Instance-aware bounds: the geometry's own sphere is centred on the
          // build origin and would cull every copy but the one at the origin.
          inst.computeBoundingSphere();
          // Bloom is INHERITED from the archetype's own decision, never re-made.
          if (child.layers.isEnabled(BLOOM_LAYER)) markBloom(inst);
          group.add(inst);
          buckets.push(inst);
        }
        // R_SCENE owns `castShadow`. This module names the class; it never
        // writes the flag.
        applyShadowPolicy(group, 'structure');
        core.three.add(group);

        let rig: AnimRig | null = null;
        const anim = done.anim;
        if (anim !== null && done.animKind !== null) {
          rig = makeAnimRig(anim, done.animKind, done.animY, a.at, core, r);
          applyShadowPolicy(rig.mesh, null);
          core.three.add(rig.mesh);
          rigs.push(rig);
        }

        // Every structure of this archetype now has an addressable slot, so a
        // death the snapshot reported before this phase landed can be applied.
        for (let i = 0; i < a.at.length; i++) {
          const s = a.at[i];
          const m = mats[i];
          if (s === undefined || m === undefined) continue;
          slots.set(s.id, { buckets, rig, index: i, mat: m, hidden: false });
        }
        for (const id of pendingHide) {
          const slot = slots.get(id);
          if (slot === undefined) continue;
          pendingHide.delete(id);
          applyHide(slot);
        }
        return false;
      },
    });
  }

  // ---- 2. placement, once every envelope is measured -------------------------
  // A single job behind the archetype jobs: kerbs and stelae keep out of the
  // structures by their MEASURED envelope, and no envelope exists until its
  // archetype is built. It emits no geometry — it appends the build jobs behind
  // itself: one instanced family per repeated prop, one chunk bake per 16 m
  // chunk of unique set-piece geometry.
  queue.push({
    heavy: false,
    step(): boolean {
      reportClearance(map, envelopes);
      const kerbs = placeKerbs(map, core, envelopes, r);
      const rings = placeBaseRim(map, core, envelopes);
      const chunks = new ChunkSet();
      placeLandmarks(chunks, map, core, r);
      queue.push(
        instancedPropJob(
          core,
          'rift:map:kerbs',
          [
            {
              geo: box(KERB_W, KERB_H, KERB_L),
              surface: 'lanePaving',
              tint: mix(APAL.stone, APAL.stoneDeep, 0.6),
            },
          ],
          kerbs,
        ),
      );
      for (const ring of rings) {
        queue.push(instancedPropJob(core, 'rift:map:stelae', steleProto(ring.tint), ring.at));
      }
      for (const emits of chunks.chunks.values()) queue.push(chunkJob(core, emits));
      return false;
    },
  });

  // ---- 3. the one frame hook -------------------------------------------------
  const clock =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? (): number => performance.now()
      : (): number => 0;
  // Scratch objects for the anim rig, allocated once: GRAPHICS_CONTRACT §5 bans
  // per-frame allocation in the render loop.
  const animM = new THREE.Matrix4();
  const animQ = new THREE.Quaternion();
  const animP = new THREE.Vector3();
  const animS = new THREE.Vector3(1, 1, 1);
  const animAxis = new THREE.Vector3(0, 1, 0);
  let elapsed = 0;

  core.addFrameHook((dtMs) => {
    // ONE try/catch around the WHOLE body. A throw from a bake, from a mesh
    // builder or from the anim rig is a logged error and a stopped build, never
    // a dead frame — and never a silent success either: the queue is dropped,
    // `failed` stays set, and the console carries the reason.
    //
    // `failed` gates the ANIMATION too, not just the queue. A rig that throws
    // once throws every frame, and a hook that logs at 60 Hz buries the one
    // message that says what broke under three thousand copies of itself.
    if (failed) return;
    try {
      if (queue.length > 0) {
        const t0 = clock();
        while (queue.length > 0) {
          const job = queue[0];
          if (job === undefined) break;
          if (!job.step()) queue.shift();
          // An indivisible unit ends the slice by itself; anything else runs
          // until the shared deadline.
          if (job.heavy) break;
          if (clock() - t0 >= FRAME_SLICE_MS) break;
        }
      }

      elapsed += dtMs;
      const t = elapsed * 0.001;
      for (const rig of rigs) {
        const n = rig.mesh.count;
        for (let i = 0; i < n; i++) {
          // A dead structure's rig instance keeps the zero-scale matrix
          // `hideStructure` wrote; rewriting it would resurrect the crystal.
          if (rig.dead[i] !== 0) continue;
          const ph = rig.phase[i] ?? 0;
          const bx = rig.px[i] ?? 0;
          const by = rig.py[i] ?? 0;
          const bz = rig.pz[i] ?? 0;
          if (rig.kind === 'orbit') {
            const a = t * ORBIT_RATE + ph;
            animP.set(bx + Math.cos(a) * ORBIT_R, by, bz + Math.sin(a) * ORBIT_R);
            animQ.setFromAxisAngle(animAxis, t * SPIN_RATE + ph);
          } else if (rig.kind === 'bob') {
            animP.set(bx, by + Math.sin(t * BOB_RATE + ph) * BOB_AMP, bz);
            animQ.setFromAxisAngle(animAxis, t * SPIN_RATE * 0.45 + ph);
          } else {
            animP.set(bx, by, bz);
            animQ.setFromAxisAngle(animAxis, t * SPIN_RATE + ph);
          }
          animM.compose(animP, animQ, animS);
          rig.mesh.setMatrixAt(i, animM);
        }
        rig.mesh.instanceMatrix.needsUpdate = true;
      }
    } catch (err) {
      failed = true;
      queue.length = 0;
      console.error('rift mapMesh: build/animation failed — the map is INCOMPLETE', err);
    }
  });

  return control;
}
