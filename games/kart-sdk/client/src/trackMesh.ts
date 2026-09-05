// ============================================================================
// KART GP — track/environment mesh builder (split out of render.ts; the frozen
// KartScene export still owns the public API). Everything static on the circuit:
//   road ribbon (tier-banded asphalt: asphaltDeep edge wear, longitudinal seams,
//     rubbered racing lines, asphaltLight crown, seeded albedo grain)
//   painted markings (dashes, start line, grid stalls) + repair patches/grime
//   curbs, dirt shoulders + the asphaltDeep contact band where road meets grass
//   ground: a tier-mottled grass field (NEVER one uncut green), mown stripe
//     bands along the verge, seeded tone patches and track-edge dirt wear
//   barrier posts, furniture: start gantry ('KART GP'), apex tire stacks + skid
//     decals, pit building + cones, billboards, lamp posts, packed grandstand
//   scatter (3 two-tier-canopy tree species in seeded clusters / rocks),
//     mid-distance tree line, three-layer ridgeline horizon hazing toward fog
// Every prop, post and tree sits on a `…Deep` contact pad — this round's stand-in
// for ambient occlusion (VISUAL_UPGRADE.md §4), and what stops trackside
// furniture reading as decals pasted on the grass.
// All statics are baked into ~1 mesh per material to keep draw calls flat
// (~35 world draw calls total). All scatter is seeded (@platform/shared rng) —
// Math.random is never touched. The cached material factory (mat) stays in
// render.ts and is threaded through here as MatFn so both modules share the one
// material cache. NOTHING here feeds closestOnTrack/barrier math: every add-on
// is a flat paint layer or sits outside the physical barrier band.
//
// TRACK-RELATIVE BY CONSTRUCTION. This builder used to bake ONE circuit into
// its module constants — Greenvale's bbox (a 700 m ground slab and a 150x140 m
// scatter rect centred on the WORLD ORIGIN), Greenvale's horizon radii, and
// literal centreline indices (pit at sample 238, grandstand at 14, the pit-lane
// cone row at 222..252). With eight circuits sharing this file that is three
// distinct bugs: every circuit gets identical scatter, the pit building lands
// somewhere arbitrary, and a circuit wider than Greenvale is built INSIDE its
// own horizon. So:
//   * a TrackWorld is derived per build from the centreline bounding box — the
//     scatter rect, ground plane, tree line and the three ridge rings are all
//     centred on the CIRCUIT and sized as MARGINS outward from it;
//   * every anchor index is derived from gate 0 plus a distance in METRES;
//   * every "every N samples" constant is a distance in metres too, because
//     SAMPLES is fixed at 256 for every circuit — a long circuit has long
//     samples, so a literal sample count silently stretches with track length;
//   * every colour resolves through `P` = { ...KPAL, ...track.theme.palette },
//     which is what makes TrackTheme.palette a real per-circuit scenery re-skin;
//   * every deco RNG is seeded `kart-<track.id>`, so two circuits never get the
//     same trees in the same places.
// The formulas were chosen so GREENVALE reproduces the numbers it had before
// (each one names its reference value below); its scatter reshuffles only
// because the deco seed is now per-track, which is the point.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { decoSeed, mix, rng, rngInt, rngRange } from '@platform/shared';
import {
  CROWD_COLORS,
  KPAL,
  MAX_PLAYERS,
  gridSlot,
  type TrackDef,
} from '@kart/shared';

/** The cached flat-shaded Lambert factory owned by render.ts (mat). */
export type MatFn = (hex: string) => THREE.MeshLambertMaterial;

/**
 * Optional per-phase build profiler. `buildTrackMesh` calls it after each phase
 * with that phase's name; it is a NO-OP unless something installs
 * `globalThis.__kartBuildPhase`, which nothing in the shipped client does. It
 * exists because "where does the circuit build spend its time" is a question
 * this file has had to answer twice now, and guessing has been wrong both
 * times. Cost when unset: one property read per build.
 */
type PhaseFn = (name: string) => void;
const noPhase: PhaseFn = () => {};
const phaseHook = (): PhaseFn =>
  (globalThis as { __kartBuildPhase?: PhaseFn }).__kartBuildPhase ?? noPhase;

type PalKey = keyof typeof KPAL;
type Pal = Record<PalKey, string>;
/** Resolved palette for the circuit CURRENTLY being built ({...KPAL, ...theme.palette}).
 *  Set once at the top of buildTrackMesh; every colour below reads through it. */
let P: Pal = { ...KPAL };

// ---- track deco tuning ---------------------------------------------------------
// NOTHING below may be an absolute world coordinate or an absolute sample index:
// eight circuits share this builder. What survives as a module constant is only
// what is genuinely circuit-invariant — physical sizes in metres, paint stack
// heights, and MARGINS measured outward from the circuit (resolved per build by
// trackWorld()) or DISTANCES in metres (resolved per build by sampleStep()).
const CURB_W = 0.6; // curb stripe width (m)
const DASH_W = 0.18; // center-line dash strip width
const BARRIER_OFF = 1.2; // posts sit at roadHalfW + this (docs/KART.md)
const BARRIER_H = 0.55;
const CURB_Y = 0.015; // flat paint heights stack above the road (z-fight guard)
const DASH_Y = 0.02;
const PAINT_Y = 0.03; // start line + grid slot markers
const CHECKER_COLS = 10;
const CHECKER_ROWS = 2;
const TREE_COUNT = 120; // docs/KART.md: ~120 seeded trees on a Greenvale-sized apron
const ROCK_COUNT = 40; // (every base count here is scaled by TrackWorld.density)
const PROP_CLEARANCE = 4; // never on the road: |lateral| > roadHalfW + this
const PROP_SPACING = 5; // min center distance between props
const CLUSTER_COUNT = 16; // tree clusters; the gaps between them stay bare
const CLUSTER_SPACING = 26; // min distance between cluster centers
const CLUSTER_R = 13; // max tree offset from the cluster center
const RIDGE_SEGS = 180; // segments per ridgeline ring
const RIDGE_NEAR_PEAK = 22; // near ridge: dark, low (peak HEIGHTS are absolute —
const RIDGE_MID_PEAK = 33; //  a mountain does not get taller because the circuit
const RIDGE_FAR_PEAK = 46; //  is wider; only the ring RADII are track-relative)

// -- world sizing margins: metres OUTWARD from the circuit's own bounding box.
// The old absolute literals (in brackets) were Greenvale's numbers with its
// bbox folded in; measured on Greenvale's sampled centreline (halfX 93.42,
// halfZ 76.24, radius 104.68 about its centre at [1.03, -7.79]) these margins
// reproduce them to within a metre, except SCATTER_Z which lands at 134 rather
// than the old 140 — the old rect was hand-padded on z, not measured.
const SCATTER_MARGIN = 58; // scatter rect half-extents [150 x 140]
const TREELINE_MARGIN_MIN = 3; // mid-distance tree band [108]
const TREELINE_MARGIN_MAX = 45; // [150]
const RIDGE_NEAR_MARGIN = 97; // [202]
const RIDGE_MID_MARGIN = 119; // [224]
const RIDGE_FAR_MARGIN = 143; // [248]
const GROUND_MARGIN = 102; // grass field reaches this far past the far ridge [700 across]
const GROUND_CELL_M = 21.875; // target field cell size; keeps the mottling scale constant
const GROUND_CELLS_MIN = 24; // [Greenvale: 700 / 21.875 -> 32 cells]
const GROUND_CELLS_MAX = 64;
const DENSITY_REF_AREA = 150 * 133; // Greenvale's scatter rect: density 1 by definition
const DENSITY_MIN = 0.75; // a tiny circuit still gets a populated apron
const DENSITY_MAX = 1.8; // a huge one does not get 400 trees

// -- sample counts that are really DISTANCES ---------------------------------
// SAMPLES is fixed at 256 for EVERY circuit, so a longer circuit has longer
// samples (Greenvale: 598.2 m / 256 = 2.337 m per sample). A literal "every 2
// samples" barrier spacing therefore stretches to 9 m posts and 9 m curb
// stripes on a 1.2 km circuit. Everything here is metres; sampleStep() converts
// per build, and the bracketed number is the Greenvale sample count reproduced.
const BARRIER_SPACING_M = 4.7; // barrier posts [2]
const CURB_STRIPE_M = 4.7; // red/white curb alternation [2]
const DASH_PERIOD_M = 4.7; // centre-line dashes [2]; floored at 2 so a dash row
//                            can never collapse into a solid painted line
const MOWN_STRIPE_M = 11.7; // mown stripe length [5]
const APEX_SPACING_M = 46.7; // min distance between apexes [20]
const LAMP_SPACING_M = 37; // lamp posts [16]
const LAMP_PHASE = 7; // first lamp sample — a phase offset, not a distance
const BRAKE_BOARD_M: readonly number[] = [28, 18.7, 9.35]; // 3/2/1 boards [12, 8, 4]
const BB_LINK_MIN_M = 79.4; // billboard link gate: real links only [34]
const BB_LINK_MAX_M = 210.3; // …not chicanes (below) or whole sweepers (above) [90]
const PIT_BEFORE_LINE_M = 42; // pit building anchor, back from gate 0 [gate0-18 = 238]
const STAND_AFTER_LINE_M = 33; // grandstand anchor, past gate 0 [gate0+14 = 14]
const CONE_ROW_FROM_M = 80; // pit-lane cone row, furthest back from the line [34]
const CONE_ROW_TO_M = 9.5; // …nearest the line [4]
const CONE_ROW_STEP_M = 7; // …spacing between cones [3] => samples 222,225,…,252
/**
 * Minimum smoothed turn to count as a corner, in radians PER METRE. It used to
 * be 0.045 rad per SAMPLE, which is scale-dependent for exactly the reason
 * above: at 256 fixed samples a long circuit's longer samples turn further per
 * sample, so every one of its corners would read as sharper (and a short
 * circuit's as flatter). 2.3367 is Greenvale's metres-per-sample, so this is
 * bit-for-bit its old threshold — its apex set is unchanged.
 */
const APEX_TURN_PER_M = 0.045 / 2.3367;
// -- asphalt banding (VISUAL_UPGRADE.md §4: "road is a uniform black ribbon").
// One entry per longitudinal column across the road, sorted by lateral offset
// (fraction of halfW). `key` is the NAMED ladder tier the column is painted
// from — every value step comes from the tier, never from a multiplier; `tone`
// is grain only. `rubber` columns darken further where karts fight for grip.
// Reads outward-in: asphaltDeep edge wear -> asphalt body -> a thin asphaltDeep
// longitudinal seam under each racing line -> asphaltLight centre crown.
// The table holds palette KEYS, not hexes: it is evaluated once at module load,
// but the circuit's palette re-skin is only known per build, so the key is
// resolved through `P` inside roadGeometry.
interface RoadBand {
  readonly off: number;
  readonly key: PalKey;
  readonly tone: number;
  readonly rubber: boolean;
}
const ROAD_BANDS: readonly RoadBand[] = [
  { off: -1.0, key: 'asphaltDeep', tone: 1.0, rubber: false },
  { off: -0.93, key: 'asphaltDeep', tone: 1.14, rubber: false },
  { off: -0.86, key: 'asphalt', tone: 0.88, rubber: false },
  { off: -0.64, key: 'asphalt', tone: 1.0, rubber: false },
  { off: -0.6, key: 'asphaltDeep', tone: 1.18, rubber: false },
  { off: -0.56, key: 'asphalt', tone: 0.94, rubber: true },
  { off: -0.4, key: 'asphalt', tone: 1.02, rubber: true },
  { off: -0.22, key: 'asphaltLight', tone: 0.97, rubber: false },
  { off: 0, key: 'asphaltLight', tone: 1.03, rubber: false },
  { off: 0.22, key: 'asphaltLight', tone: 0.97, rubber: false },
  { off: 0.4, key: 'asphalt', tone: 1.02, rubber: true },
  { off: 0.56, key: 'asphalt', tone: 0.94, rubber: true },
  { off: 0.6, key: 'asphaltDeep', tone: 1.18, rubber: false },
  { off: 0.64, key: 'asphalt', tone: 1.0, rubber: false },
  { off: 0.86, key: 'asphalt', tone: 0.88, rubber: false },
  { off: 0.93, key: 'asphaltDeep', tone: 1.14, rubber: false },
  { off: 1.0, key: 'asphaltDeep', tone: 1.0, rubber: false },
];
const GRIME_Y = 0.013; // road-edge dirt accumulation (road < grime < curb paint)
const SKID_Y = 0.016; // apex skid decals (below repair patches)
const PATCH_Y = 0.017; // repair rectangles (below the dashes)
const PATCH_COUNT = 22; // Greenvale-reference count; scaled by TrackWorld.density
const SHOULDER_W = 0.8; // dirt ring just outside the curbs
const SHOULDER_DEEP_W = 0.55; // asphaltDeep CONTACT BAND: road assembly -> grass
const SHOULDER_Y = -0.004; // on the grass field (top -0.02), under the road plane
const BLOB_Y = -0.008; // grass tone blobs sit on the field, under the road plane
const BLOB_BIG = 30; // broad faint mottling (Greenvale-reference counts, x density)
const BLOB_SMALL = 190; // distinct four-tier patches
const BLOB_SPACING = 3.4; // min center distance between grass patches
const EDGE_WEAR_Y = -0.005; // dirt scuffed off the shoulder onto the grass
const GROUND_Y = -0.02; // the grass field plane (was a flat slab, now mottled)
const MOWN_Y = -0.006; // mown stripe bands ride over the field, under the dirt
// Mown stripe bands: lateral offsets past the contact band, each alternating
// between two named grass tiers. §4: "mown-stripe bands running along the track".
// Palette KEYS, not hexes — resolved through `P` per build (see ROAD_BANDS).
const MOWN_BANDS: ReadonlyArray<{ from: number; to: number; a: PalKey; b: PalKey }> = [
  { from: 0, to: 2.4, a: 'grassLit', b: 'grassDark' },
  { from: 2.4, to: 5.3, a: 'grass', b: 'grassLit' },
  { from: 5.3, to: 9.0, a: 'grassDark', b: 'grass' },
];
const APRON_FOLD_MIN = 0.3; // min arc factor for offset apron layers (see apronLimits)
const PAD_H = 0.024; // …Deep contact pad thickness under every prop
const TREELINE_COUNT = 64; // mid-distance tree band between track and hills
const TREELINE_SQUASH = 0.94; // slight ellipse so the band is not a perfect circle
const STACK_OFF = 2.4; // tire stacks sit at roadHalfW + this (behind the barrier)
const LAMP_OFF = 3.05; // lamp posts at roadHalfW + this
const BILLBOARD_COUNT = 5;
const BILLBOARD_OFF = 8.5; // min lateral offset past the road edge
const GANTRY_OFF = 1.8; // gantry posts at roadHalfW + this (outside the barriers)
const STAND_OFF = 13.5; // grandstand lateral offset from centerline
const BOARD_OFF = 1.9; // brake boards at roadHalfW + this (corner outside)

/**
 * Everything about the world around ONE circuit that used to be an absolute
 * module constant. Derived per build from the centreline bounding box, so the
 * apron, horizon and scatter follow the circuit instead of the world origin.
 *
 * Greenvale (the reference circuit every margin above was calibrated on):
 * bbox x [-92.39, 94.44], z [-84.04, 68.45] => centre [1.03, -7.79],
 * halfX 93.42, halfZ 76.24, radius 104.68 — which yields scatter 151x134
 * (was 150x140), treeline 107.7..149.7 (was 108..150), ridges 201.7 / 223.7 /
 * 247.7 (was 202 / 224 / 248), ground 699.4 across in 32 cells (was 700 / 32)
 * and density 1.02 (was 1 by definition).
 */
interface TrackWorld {
  cx: number; cz: number;        // centre of the centreline bounding box
  halfX: number; halfZ: number;  // bbox half-extents
  radius: number;                // max distance from (cx,cz) to any centreline sample
  scatterX: number; scatterZ: number;   // scatter rect half-extents about (cx,cz)
  groundSize: number; groundCells: number;
  ridgeNearR: number; ridgeMidR: number; ridgeFarR: number;
  treelineMin: number; treelineMax: number;
  mPerSample: number;            // track.length / centerline.length
  density: number;               // count multiplier for scatter/blobs
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Derive the per-circuit world sizing. Pure function of the centreline. */
function trackWorld(track: TrackDef): TrackWorld {
  const cl = track.centerline;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of cl) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  let radius = 0;
  for (const p of cl) radius = Math.max(radius, Math.hypot(p[0] - cx, p[1] - cz));
  const scatterX = (maxX - minX) / 2 + SCATTER_MARGIN;
  const scatterZ = (maxZ - minZ) / 2 + SCATTER_MARGIN;
  const ridgeFarR = radius + RIDGE_FAR_MARGIN;
  const groundSize = 2 * (ridgeFarR + GROUND_MARGIN);
  return {
    cx,
    cz,
    halfX: (maxX - minX) / 2,
    halfZ: (maxZ - minZ) / 2,
    radius,
    scatterX,
    scatterZ,
    groundSize,
    // a ~constant cell size keeps the field's mottling scale the same on every
    // circuit instead of stretching with the slab
    groundCells: clamp(Math.round(groundSize / GROUND_CELL_M), GROUND_CELLS_MIN, GROUND_CELLS_MAX),
    ridgeNearR: radius + RIDGE_NEAR_MARGIN,
    ridgeMidR: radius + RIDGE_MID_MARGIN,
    ridgeFarR,
    treelineMin: radius + TREELINE_MARGIN_MIN,
    treelineMax: radius + TREELINE_MARGIN_MAX,
    mPerSample: track.length / cl.length,
    density: clamp((scatterX * scatterZ) / DENSITY_REF_AREA, DENSITY_MIN, DENSITY_MAX),
  };
}

/** A Greenvale-reference base count, scaled to this circuit's apron area. */
function scaled(base: number, density: number): number {
  return Math.max(1, Math.round(base * density));
}

/** Vertex-color paint layers (road/curbs/dirt/patches/blobs): one lazy Lambert. */
let paintMat: THREE.MeshLambertMaterial | null = null;
function vertexPaintMaterial(): THREE.MeshLambertMaterial {
  if (!paintMat) paintMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  return paintMat;
}

/** palette hex -> rgb triplet, scaled by `mul` (stays a palette tone, just shaded). */
function shade(hex: string, mul: number): [number, number, number] {
  const c = new THREE.Color(hex).multiplyScalar(mul);
  return [Math.min(1, c.r), Math.min(1, c.g), Math.min(1, c.b)];
}

// ---- mesh factories (origin at center, y-up) -----------------------------------
// Shared with kartMesh.ts; matFn is the render.ts material cache.
export function box(matFn: MatFn, w: number, h: number, d: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matFn(hex));
}
export function cyl(matFn: MatFn, rTop: number, rBottom: number, h: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, seg), matFn(hex));
}
export function cone(matFn: MatFn, r: number, h: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), matFn(hex));
}
export function sphere(matFn: MatFn, r: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(4, Math.floor(seg * 0.75))), matFn(hex));
}

/** Convenience: position a mesh and return it (chainable builder style). */
export function at<T extends THREE.Object3D>(obj: T, x: number, y: number, z: number): T {
  obj.position.set(x, y, z);
  return obj;
}

// ---- prototype geometry cache for the BAKED statics -----------------------------
// A circuit builds ~5 000 prop meshes and most of them are the SAME primitive:
// every barrier post is one of three shapes, every crowd seat is one of two
// boxes, every checker cell / grid-stall bar / cone / lamp / gantry member is a
// fixed size. Constructing each one from scratch was ~40 % of the build outside
// bake(). These factories hand out ONE prototype per (shape, dimensions) and
// let bake() transform each instance into the merged buffer — bake only ever
// READS a source geometry, so sharing is invisible in the output (proven
// byte-for-byte by the buildTrackMesh fingerprint).
//
// TWO rules keep this safe:
//  * the cache is cleared at the top of every buildTrackMesh, so a prop built
//    from a seeded RANDOM size (trees, rocks, bushes — a fresh key every time)
//    cannot make it grow without bound across circuits;
//  * the EXPORTED box/cyl/cone/sphere above stay uncached, because kartMesh.ts
//    builds karts from them and render.ts disposes a removed kart's geometries
//    — which would free a shared prototype out from under the next circuit.
//    Nothing outside a buildTrackMesh call may use the s* factories.
const protoCache = new Map<string, THREE.BufferGeometry>();
function proto(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = protoCache.get(key);
  if (g === undefined) {
    g = make();
    protoCache.set(key, g);
  }
  return g;
}
function sbox(matFn: MatFn, w: number, h: number, d: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(proto(`b|${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d)), matFn(hex));
}
function scyl(matFn: MatFn, rTop: number, rBottom: number, h: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(
    proto(`c|${rTop}|${rBottom}|${h}|${seg}`, () => new THREE.CylinderGeometry(rTop, rBottom, h, seg)),
    matFn(hex),
  );
}
function scone(matFn: MatFn, r: number, h: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(proto(`k|${r}|${h}|${seg}`, () => new THREE.ConeGeometry(r, h, seg)), matFn(hex));
}
function ssphere(matFn: MatFn, r: number, seg: number, hex: string): THREE.Mesh {
  return new THREE.Mesh(
    proto(`s|${r}|${seg}`, () => new THREE.SphereGeometry(r, seg, Math.max(4, Math.floor(seg * 0.75)))),
    matFn(hex),
  );
}

/** The only attributes a baked static carries; anything else is dropped. */
const BAKE_ATTRS = ['position', 'normal', 'uv'] as const;

/** Plain, non-normalised Float32 storage, or null if the attribute is exotic. */
function plainF32(attr: THREE.BufferAttribute | undefined): Float32Array | null {
  if (attr === undefined || attr.normalized) return null;
  return attr.array instanceof Float32Array ? attr.array : null;
}

/**
 * Merge all Mesh descendants of `root` into one mesh per material, preserving
 * world transforms. Used for EVERY static structure (ground, barriers, painted
 * markings, scatter, hills) to keep draw calls flat. Karts must NOT be baked —
 * their wheels/steering animate per frame.
 *
 * PERF (this was 57–68 % of the whole circuit build). The old body was
 * `geometry.clone().applyMatrix4(m)` per prop and then `mergeGeometries`, which
 * writes every prop's attribute arrays THREE times — once cloning, once
 * transforming in place, once copying into the merged buffer — and allocates
 * four typed arrays per prop, ~5 000 props per circuit. It is now a two-pass
 * direct write: count, allocate the merged buffers ONCE, then transform each
 * source vertex straight into its slot in them.
 *
 * The arithmetic is deliberately the same operations in the same order as
 * THREE's BufferAttribute.applyMatrix4 (perspective-divided Matrix4 multiply)
 * and applyNormalMatrix (Matrix3 multiply then normalise by 1/length), reading
 * f32 and writing f32, so every float lands BIT-IDENTICAL to the old path.
 * `mergeGeometries` is still the fallback for any bucket whose geometries are
 * exotic (interleaved/normalised/unindexed, or disagreeing on which attributes
 * they carry) — none of this file's primitives are, but the seam is public.
 */
function bake(root: THREE.Group): THREE.Group {
  root.updateMatrixWorld(true);
  const byMaterial = new Map<THREE.Material, THREE.Mesh[]>();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const arr = byMaterial.get(child.material as THREE.Material);
    if (arr) arr.push(child);
    else byMaterial.set(child.material as THREE.Material, [child]);
  });
  const out = new THREE.Group();
  const nm = new THREE.Matrix3();
  for (const [material, meshes] of byMaterial) {
    const merged = mergeMeshes(meshes, nm) ?? mergeFallback(meshes);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
  }
  return out;
}

/**
 * One material's worth of props transformed straight into shared buffers.
 * Returns null (rather than a wrong answer) whenever the inputs are not the
 * plain indexed Float32 primitives this file builds, so the caller can fall
 * back to THREE's own merge.
 */
function mergeMeshes(meshes: readonly THREE.Mesh[], nm: THREE.Matrix3): THREE.BufferGeometry | null {
  const first = meshes[0];
  if (first === undefined) return null;
  // the attribute set is the FIRST geometry's, exactly as mergeGeometries does;
  // a geometry that disagrees makes the whole bucket a fallback
  const names = BAKE_ATTRS.filter((n) => first.geometry.getAttribute(n) !== undefined);
  if (!names.includes('position')) return null;
  let verts = 0;
  let indices = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const idx = g.getIndex();
    if (idx === null || !(idx.array instanceof Uint16Array || idx.array instanceof Uint32Array)) return null;
    for (const n of BAKE_ATTRS) {
      if ((g.getAttribute(n) !== undefined) !== names.includes(n)) return null;
      if (names.includes(n) && plainF32(g.getAttribute(n) as THREE.BufferAttribute) === null) return null;
    }
    verts += (g.getAttribute('position') as THREE.BufferAttribute).count;
    indices += idx.count;
  }
  if (verts === 0) return null;
  const pos = new Float32Array(verts * 3);
  const nrm = names.includes('normal') ? new Float32Array(verts * 3) : null;
  const uvs = names.includes('uv') ? new Float32Array(verts * 2) : null;
  const idxOut = new Uint32Array(indices);
  let vo = 0;
  let io = 0;
  let maxIndex = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const src = plainF32(g.getAttribute('position') as THREE.BufferAttribute)!;
    const count = (g.getAttribute('position') as THREE.BufferAttribute).count;
    const e = m.matrixWorld.elements;
    const e0 = e[0]!, e4 = e[4]!, e8 = e[8]!, e12 = e[12]!;
    const e1 = e[1]!, e5 = e[5]!, e9 = e[9]!, e13 = e[13]!;
    const e2 = e[2]!, e6 = e[6]!, e10 = e[10]!, e14 = e[14]!;
    const e3 = e[3]!, e7 = e[7]!, e11 = e[11]!, e15 = e[15]!;
    for (let i = 0; i < count; i++) {
      const x = src[i * 3]!;
      const y = src[i * 3 + 1]!;
      const z = src[i * 3 + 2]!;
      const w = 1 / (e3 * x + e7 * y + e11 * z + e15);
      const k = (vo + i) * 3;
      pos[k] = (e0 * x + e4 * y + e8 * z + e12) * w;
      pos[k + 1] = (e1 * x + e5 * y + e9 * z + e13) * w;
      pos[k + 2] = (e2 * x + e6 * y + e10 * z + e14) * w;
    }
    if (nrm !== null) {
      const ns = plainF32(g.getAttribute('normal') as THREE.BufferAttribute)!;
      nm.getNormalMatrix(m.matrixWorld);
      const t = nm.elements;
      const t0 = t[0]!, t1 = t[1]!, t2 = t[2]!;
      const t3 = t[3]!, t4 = t[4]!, t5 = t[5]!;
      const t6 = t[6]!, t7 = t[7]!, t8 = t[8]!;
      for (let i = 0; i < count; i++) {
        const x = ns[i * 3]!;
        const y = ns[i * 3 + 1]!;
        const z = ns[i * 3 + 2]!;
        const ax = t0 * x + t3 * y + t6 * z;
        const ay = t1 * x + t4 * y + t7 * z;
        const az = t2 * x + t5 * y + t8 * z;
        // Vector3.normalize(): divideScalar(length() || 1) => multiply by 1/len
        const inv = 1 / (Math.sqrt(ax * ax + ay * ay + az * az) || 1);
        const k = (vo + i) * 3;
        nrm[k] = ax * inv;
        nrm[k + 1] = ay * inv;
        nrm[k + 2] = az * inv;
      }
    }
    if (uvs !== null) {
      const us = plainF32(g.getAttribute('uv') as THREE.BufferAttribute)!;
      uvs.set(us.subarray(0, count * 2), vo * 2);
    }
    const idx = g.getIndex()!;
    const ia = idx.array as Uint16Array | Uint32Array;
    for (let i = 0; i < idx.count; i++) {
      const v = ia[i]! + vo;
      idxOut[io + i] = v;
      if (v > maxIndex) maxIndex = v;
    }
    vo += count;
    io += idx.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (nrm !== null) geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  if (uvs !== null) geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  // setIndex() picks Uint16 below 65536 — match it, or the buffer type (and so
  // the GPU upload) would differ from the old path for small buckets
  geo.setIndex(new THREE.BufferAttribute(maxIndex > 65535 ? idxOut : new Uint16Array(idxOut), 1));
  return geo;
}

/** THREE's own merge, for a bucket mergeMeshes declined (see its contract). */
function mergeFallback(meshes: readonly THREE.Mesh[]): THREE.BufferGeometry | null {
  const geoms = meshes.map((child) => {
    const g = child.geometry.clone().applyMatrix4(child.matrixWorld);
    for (const name of Object.keys(g.attributes)) {
      if (!(BAKE_ATTRS as readonly string[]).includes(name)) g.deleteAttribute(name);
    }
    return g;
  });
  return mergeGeometries(geoms, false);
}

// ---- track frames ---------------------------------------------------------------
// Per centerline sample: center + unit "left of travel" (lateral +, matching the
// sign convention of closestOnTrack in @kart/shared).
interface SampleFrame {
  cx: number;
  cz: number;
  lx: number;
  lz: number;
}

function trackFrames(centerline: ReadonlyArray<readonly [number, number]>): SampleFrame[] {
  const n = centerline.length;
  const frames: SampleFrame[] = [];
  for (let i = 0; i < n; i++) {
    const prev = centerline[(i - 1 + n) % n]!;
    const c = centerline[i]!;
    const nxt = centerline[(i + 1) % n]!;
    let tx = nxt[0] - prev[0];
    let tz = nxt[1] - prev[1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    frames.push({ cx: c[0], cz: c[1], lx: -tz, lz: tx });
  }
  return frames;
}

/** Tangent of travel for a frame (unit): left = (-tz, tx) => t = (lz, -lx). */
function frameTangent(f: SampleFrame): [number, number] {
  return [f.lz, -f.lx];
}

// ---- flat ribbon geometry ---------------------------------------------------------
// Road strip: one shared vertex per ROAD_BANDS column per sample, indices wound
// to face +y. Normals are set straight up — the road is flat by construction.
// Vertex colors carry the asphalt TIER banding (asphaltDeep edge wear and
// longitudinal seams, asphalt body, rubbered lines that deepen where karts fight
// through corners, asphaltLight crown) x a seeded albedo grain (4-sample groups
// + fine drift). The tiers do the value work; the grain only breaks up flatness.

function roadGeometry(
  frames: SampleFrame[],
  halfW: number,
  turn: readonly number[],
  next: () => number,
): THREE.BufferGeometry {
  const n = frames.length;
  const cols = ROAD_BANDS.length;
  const bandCol = ROAD_BANDS.map((b) => new THREE.Color(P[b.key]));
  // patchwork: per 4-sample group multiplier, ~18% of groups noticeably shifted
  const groups = Math.ceil(n / 4);
  const groupMul: number[] = [];
  for (let g = 0; g < groups; g++) {
    groupMul.push(next() < 0.18 ? (next() < 0.5 ? 0.86 : 1.14) : 0.95 + next() * 0.1);
  }
  const pos = new Float32Array(n * cols * 3);
  const nrm = new Float32Array(n * cols * 3);
  const col = new Float32Array(n * cols * 3);
  for (let i = 0; i < n; i++) {
    const f = frames[i]!;
    const jitter = groupMul[Math.floor(i / 4)]! * (0.98 + next() * 0.04);
    // rubber lines deepen where the karts fight (braking/turn-in zones)
    const cornerGrip = Math.min(0.3, Math.abs(turn[i]!) * 0.8);
    for (let c = 0; c < cols; c++) {
      const band = ROAD_BANDS[c]!;
      const off = band.off * halfW;
      const k = (i * cols + c) * 3;
      pos[k] = f.cx + f.lx * off;
      pos[k + 1] = 0;
      pos[k + 2] = f.cz + f.lz * off;
      nrm[k + 1] = 1;
      const tone = (band.rubber ? band.tone * (1 - cornerGrip) : band.tone) * jitter;
      const base = bandCol[c]!;
      col[k] = Math.min(1, base.r * tone);
      col[k + 1] = Math.min(1, base.g * tone);
      col[k + 2] = Math.min(1, base.b * tone);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    for (let c = 0; c < cols - 1; c++) {
      const ri = i * cols + c; // smaller lateral offset
      const li = i * cols + c + 1;
      const rj = j * cols + c;
      const lj = j * cols + c + 1;
      idx.push(li, lj, ri, ri, lj, rj); // ribbonGeometry winding, faces +y
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * Per-segment ribbon with DUPLICATED vertices (4 per emitted segment) so adjacent
 * segments can carry different vertex colors (curb stripes) or be skipped
 * entirely (center-line dashes). Requires leftOff > rightOff; winding faces +y.
 */
function ribbonGeometry(
  frames: SampleFrame[],
  leftOff: number,
  rightOff: number,
  y: number,
  colorFor: (seg: number) => [number, number, number],
  skip: (seg: number) => boolean,
): THREE.BufferGeometry {
  const n = frames.length;
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (skip(i)) continue;
    const a = frames[i]!;
    const b = frames[(i + 1) % n]!;
    const c = colorFor(i);
    const verts: Array<[number, number, number]> = [
      [a.cx + a.lx * leftOff, y, a.cz + a.lz * leftOff], // Li
      [b.cx + b.lx * leftOff, y, b.cz + b.lz * leftOff], // Lj
      [a.cx + a.lx * rightOff, y, a.cz + a.lz * rightOff], // Ri
      [b.cx + b.lx * rightOff, y, b.cz + b.lz * rightOff], // Rj
    ];
    const base = pos.length / 3;
    for (const v of verts) {
      pos.push(v[0], v[1], v[2]);
      nrm.push(0, 1, 0);
      col.push(c[0], c[1], c[2]);
    }
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * Asphalt wear layer: seeded repair rectangles (fresh dark / bleached light
 * repaves) + broken grime strips where the road meets the curbs + skid decals
 * arcing through every corner apex. One geometry, one vertex-color draw call;
 * everything sits in the paint stack just above the road.
 */
function roadDetailGeometry(
  frames: SampleFrame[],
  halfW: number,
  apexes: ReadonlyArray<{ index: number; side: number }>,
  patchCount: number,
  next: () => number,
): THREE.BufferGeometry {
  const n = frames.length;
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  // quad corners in [Li, Lj, Ri, Rj] order, same winding as ribbonGeometry (+y)
  const quad = (verts: ReadonlyArray<readonly [number, number, number]>, c: readonly [number, number, number]): void => {
    const base = pos.length / 3;
    for (const v of verts) {
      pos.push(v[0], v[1], v[2]);
      nrm.push(0, 1, 0);
      col.push(c[0], c[1], c[2]);
    }
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  };
  // per-segment strip helper: [Li, Lj, Ri, Rj] between two lateral offsets
  const strip = (i: number, latA: number, latB: number, y: number, c: readonly [number, number, number]): void => {
    const a = frames[i]!;
    const b = frames[(i + 1) % n]!;
    const lo = Math.max(latA, latB);
    const ro = Math.min(latA, latB);
    quad(
      [
        [a.cx + a.lx * lo, y, a.cz + a.lz * lo],
        [b.cx + b.lx * lo, y, b.cz + b.lz * lo],
        [a.cx + a.lx * ro, y, a.cz + a.lz * ro],
        [b.cx + b.lx * ro, y, b.cz + b.lz * ro],
      ],
      c,
    );
  };

  // grime strips: lat in [halfW-0.85, halfW-0.15] on both sides, ~62% coverage,
  // alternating the two dirt tiers so the road edge is never one flat smear
  for (let i = 0; i < n; i++) {
    if (next() < 0.38) continue;
    const c = shade(next() < 0.45 ? P.dirtDeep : P.dirt, 0.9 + next() * 0.2);
    for (const side of [1, -1]) {
      strip(i, side * (halfW - 0.15), side * (halfW - 0.85), GRIME_Y, c);
    }
  }

  // skid/wear decals: broken dark strips on the racing line through each apex
  for (const apex of apexes) {
    const marks = rngInt(next, 2, 3);
    for (let m = 0; m < marks; m++) {
      const start = apex.index - rngInt(next, 2, 5);
      const len = rngInt(next, 5, 8);
      const latBase = apex.side * rngRange(next, 1.5, 2.7);
      for (let s = 0; s < len; s++) {
        if (next() < 0.15) continue; // broken marks, not a solid band
        const lat = latBase + rngRange(next, -0.3, 0.3) + apex.side * s * 0.12; // drift outward on exit
        const w2 = rngRange(next, 0.2, 0.35);
        strip((start + s + n) % n, lat + w2, lat - w2, SKID_Y, shade(P.asphaltDeep, rngRange(next, 0.62, 0.86)));
      }
    }
  }

  // repair patches: flat rectangles aligned to one frame, kept off the curbs
  // and away from the start-line checker
  for (let p = 0; p < patchCount; p++) {
    const si = rngInt(next, 10, n - 11);
    const f = frames[si]!;
    const [tx, tz] = frameTangent(f);
    const halfLen = rngRange(next, 1.3, 3.1);
    const halfWid = rngRange(next, 0.7, 1.5);
    const latLim = halfW - 1.0 - halfWid;
    const lat = rngRange(next, -latLim, latLim);
    // fresh dark repaves in asphaltDeep, bleached old ones in asphaltLit — the
    // patch value comes from the named tier, the jitter is grain only (§4).
    const dark = next() < 0.5;
    const c = dark
      ? shade(P.asphaltDeep, rngRange(next, 0.94, 1.14))
      : shade(P.asphaltLit, rngRange(next, 0.9, 1.06));
    const px = f.cx + f.lx * lat;
    const pz = f.cz + f.lz * lat;
    quad(
      [
        [px - tx * halfLen + f.lx * halfWid, PATCH_Y, pz - tz * halfLen + f.lz * halfWid],
        [px + tx * halfLen + f.lx * halfWid, PATCH_Y, pz + tz * halfLen + f.lz * halfWid],
        [px - tx * halfLen - f.lx * halfWid, PATCH_Y, pz - tz * halfLen - f.lz * halfWid],
        [px + tx * halfLen - f.lx * halfWid, PATCH_Y, pz + tz * halfLen - f.lz * halfWid],
      ],
      c,
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * The grass field itself. THE worst thing in KART was one flat uniform green
 * slab covering the whole world (VISUAL_UPGRADE.md §4), so the slab is gone:
 * this is a subdivided plane whose PER-VERTEX colour is a named grass tier
 * chosen by a seeded harmonic field. The GPU interpolates between neighbouring
 * tier vertices, so the ground reads as soft organic patches of grassDeep /
 * grassDark / grass / grassLit and never as one uncut colour. Flat, one draw
 * call, no texture — the colour attribute of the pre-existing vertex-colour
 * Lambert is doing all of the work.
 *
 * The plane is centred on the CIRCUIT (w.cx, w.cz), not on the world origin,
 * and sized to reach past the far ridge — a circuit whose centre sits 400 m off
 * the origin would otherwise race over the void. The harmonic field is
 * evaluated at WORLD x/z so the mottling pattern stays put as the slab moves.
 */
function groundGeometry(w: TrackWorld, next: () => number): THREE.BufferGeometry {
  const cells = w.groundCells;
  const half = w.groundSize / 2;
  const step = w.groundSize / cells;
  const tiers = [P.grassDeep, P.grassDark, P.grass, P.grassLit].map((h) => new THREE.Color(h));
  // three broad harmonics: big soft regions, not a checkerboard
  const wave = [
    { fx: rngRange(next, 0.008, 0.017), fz: rngRange(next, 0.008, 0.017), p: next() * Math.PI * 2, a: 0.46 },
    { fx: rngRange(next, 0.02, 0.035), fz: rngRange(next, 0.02, 0.035), p: next() * Math.PI * 2, a: 0.33 },
    { fx: rngRange(next, 0.05, 0.08), fz: rngRange(next, 0.05, 0.08), p: next() * Math.PI * 2, a: 0.21 },
  ];
  const verts = (cells + 1) * (cells + 1);
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  for (let ix = 0; ix <= cells; ix++) {
    for (let iz = 0; iz <= cells; iz++) {
      const x = w.cx - half + ix * step;
      const z = w.cz - half + iz * step;
      let f = 0;
      for (const w of wave) f += w.a * Math.sin(w.fx * x + w.p) * Math.cos(w.fz * z + w.p * 0.5);
      // ragged tier boundaries: without the jitter the field bands too cleanly
      f = 0.5 + f * 0.5 + rngRange(next, -0.09, 0.09);
      const tier = f < 0.2 ? 0 : f < 0.44 ? 1 : f < 0.84 ? 2 : 3;
      const c = tiers[tier]!;
      const k = ((ix * (cells + 1)) + iz) * 3;
      pos[k] = x;
      pos[k + 1] = GROUND_Y;
      pos[k + 2] = z;
      nrm[k + 1] = 1;
      col[k] = c.r;
      col[k + 1] = c.g;
      col[k + 2] = c.b;
    }
  }
  const idx: number[] = [];
  const vid = (ix: number, iz: number): number => ix * (cells + 1) + iz;
  for (let ix = 0; ix < cells; ix++) {
    for (let iz = 0; iz < cells; iz++) {
      const a = vid(ix, iz + 1);
      const b = vid(ix + 1, iz + 1);
      const c = vid(ix, iz);
      const d = vid(ix + 1, iz);
      idx.push(a, b, c, c, b, d); // same winding convention as ribbonGeometry (+y)
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * Per-sample cap on how far a flat apron layer may be offset to each side before
 * the parallel curve folds back through the corner's centre of curvature. A
 * ribbon at lateral offset `o` has arc factor (1 - k*o) for signed curvature k
 * (+ = turning left); keeping that above APRON_FOLD_MIN makes the apron PINCH
 * SHUT on the inside of a hairpin instead of self-intersecting. This circuit
 * drops to a ~9 m radius, so a fixed-width apron would fold on ~24 samples.
 * Returns [maxLeftOffset, maxRightOffset] per sample.
 */
function apronLimits(frames: SampleFrame[]): Array<[number, number]> {
  const n = frames.length;
  const cap = 1 - APRON_FOLD_MIN;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = frames[(i - 2 + n) % n]!;
    const b = frames[(i + 2) % n]!;
    const [tax, taz] = frameTangent(a);
    const [tbx, tbz] = frameTangent(b);
    let arc = 0;
    for (let s = -2; s < 2; s++) {
      const p = frames[(i + s + n) % n]!;
      const q = frames[(i + s + 1 + n) % n]!;
      arc += Math.hypot(q.cx - p.cx, q.cz - p.cz);
    }
    const dth = Math.atan2(tax * tbz - taz * tbx, tax * tbx + taz * tbz);
    const k = arc > 0 ? dth / arc : 0;
    out.push([k > 1e-6 ? cap / k : Infinity, k < -1e-6 ? cap / -k : Infinity]);
  }
  return out;
}

/**
 * Mown stripe bands running ALONG the track (§4). Three lateral bands per side
 * outside the contact band, each alternating between two named grass tiers every
 * `mownSegs` segments with a per-band phase, so the verge reads as cut turf with
 * a mower's rhythm instead of a flat green apron. `mownSegs` is MOWN_STRIPE_M
 * converted to samples for THIS circuit — a mower cuts an ~11.7 m stripe
 * whatever the track length, which a fixed sample count would not give.
 * Offsets are clamped by apronLimits so the bands taper through tight corners.
 * One vertex-colour geometry, wound to face +y like every other paint layer.
 */
function mownStripeGeometry(
  frames: SampleFrame[],
  halfW: number,
  mownSegs: number,
  next: () => number,
): THREE.BufferGeometry {
  const n = frames.length;
  const inner = halfW + CURB_W + SHOULDER_W + SHOULDER_DEEP_W;
  const stripes = Math.ceil(n / mownSegs);
  const limits = apronLimits(frames);
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (const band of MOWN_BANDS) {
    const ca = new THREE.Color(P[band.a]);
    const cb = new THREE.Color(P[band.b]);
    const phase = rngInt(next, 0, 1);
    const tone: number[] = [];
    for (let s = 0; s < stripes; s++) tone.push(rngRange(next, 0.93, 1.07));
    for (const side of [1, -1]) {
      const li = side > 0 ? 0 : 1; // which apron limit this side is bounded by
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const cap = Math.min(limits[i]![li], limits[j]![li]);
        const from = Math.min(inner + band.from, cap);
        const to = Math.min(inner + band.to, cap);
        if (to - from < 0.06) continue; // pinched shut through the apex
        const s = Math.floor(i / mownSegs) % stripes;
        const c = (s + phase) % 2 === 0 ? ca : cb;
        const t = tone[s]!;
        const a = frames[i]!;
        const b = frames[j]!;
        const lo = side > 0 ? to : -from;
        const ro = side > 0 ? from : -to;
        const base = pos.length / 3;
        for (const v of [
          [a.cx + a.lx * lo, MOWN_Y, a.cz + a.lz * lo],
          [b.cx + b.lx * lo, MOWN_Y, b.cz + b.lz * lo],
          [a.cx + a.lx * ro, MOWN_Y, a.cz + a.lz * ro],
          [b.cx + b.lx * ro, MOWN_Y, b.cz + b.lz * ro],
        ] as ReadonlyArray<readonly [number, number, number]>) {
          pos.push(v[0], v[1], v[2]);
          nrm.push(0, 1, 0);
          col.push(Math.min(1, c.r * t), Math.min(1, c.g * t), Math.min(1, c.b * t));
        }
        idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * Grass tone layer: broad tier mottling + smaller four-tier patches + the dirt
 * WEAR scuffed off the shoulder onto the verge (irregular seeded fans, flat on
 * the field, never on the road/shoulder). One draw call.
 *
 * The two blob fields are sampled over the circuit's own scatter rect (about
 * w.cx/w.cz, widened as before) and their counts scale with w.density, so a
 * circuit twice Greenvale's footprint gets twice the mottling rather than the
 * same 220 patches spread twice as thin.
 */
function grassPatchGeometry(
  absLateral: (x: number, z: number) => number,
  frames: SampleFrame[],
  halfW: number,
  w: TrackWorld,
  next: () => number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const placed = new SpacedPoints(BLOB_SPACING);

  const blob = (x: number, z: number, r: number, y: number, c: readonly [number, number, number]): void => {
    const k = 12;
    const rot = next() * Math.PI * 2;
    const ex = rngRange(next, 0.7, 1.4); // elongation
    const ez = rngRange(next, 0.7, 1.4);
    const base = pos.length / 3;
    pos.push(x, y, z);
    nrm.push(0, 1, 0);
    col.push(c[0], c[1], c[2]);
    for (let i = 0; i < k; i++) {
      const ang = rot + (i / k) * Math.PI * 2;
      const rr = r * rngRange(next, 0.72, 1.25);
      pos.push(x + Math.cos(ang) * rr * ex, y, z + Math.sin(ang) * rr * ez);
      nrm.push(0, 1, 0);
      col.push(c[0], c[1], c[2]);
    }
    for (let i = 0; i < k; i++) {
      const a = base + 1 + i;
      const b = base + 1 + ((i + 1) % k);
      idx.push(base, b, a); // wound to face +y
    }
  };

  // broad mottling: large, soft tier shifts over the whole apron
  const bigCount = scaled(BLOB_BIG, w.density);
  for (let p = 0; p < bigCount; p++) {
    const x = rngRange(next, w.cx - w.scatterX - 30, w.cx + w.scatterX + 30);
    const z = rngRange(next, w.cz - w.scatterZ - 30, w.cz + w.scatterZ + 30);
    if (absLateral(x, z) <= halfW + PROP_CLEARANCE) continue;
    const hex = next() < 0.5 ? P.grassDark : P.grassLit;
    blob(x, z, rngRange(next, 10, 26), BLOB_Y - 0.006, shade(hex, rngRange(next, 0.95, 1.05)));
  }

  // distinct patches: all four grass tiers, weighted toward the mid two
  const smallCount = scaled(BLOB_SMALL, w.density);
  for (let attempt = 0, done = 0; attempt < smallCount * 20 && done < smallCount; attempt++) {
    const x = rngRange(next, w.cx - w.scatterX - 15, w.cx + w.scatterX + 15);
    const z = rngRange(next, w.cz - w.scatterZ - 15, w.cz + w.scatterZ + 15);
    if (absLateral(x, z) <= halfW + CURB_W + 2.0) continue;
    if (placed.has(x, z)) continue;
    placed.add(x, z);
    const pick = next();
    const hex = pick < 0.14 ? P.grassDeep : pick < 0.46 ? P.grassDark : pick < 0.82 ? P.grassLit : P.grass;
    blob(x, z, rngRange(next, 1.6, 5.5), BLOB_Y, shade(hex, rngRange(next, 0.94, 1.06)));
  }

  // track-edge wear: dirt scuffed off the shoulder onto the grass, broken so the
  // road never meets the verge on a clean machined line (§4)
  const wearFrom = halfW + CURB_W + SHOULDER_W + SHOULDER_DEEP_W;
  for (let i = 0; i < frames.length; i += 2) {
    for (const side of [1, -1]) {
      if (next() < 0.62) continue;
      const f = frames[i]!;
      const lat = side * (wearFrom + rngRange(next, -0.15, 1.3));
      const x = f.cx + f.lx * lat;
      const z = f.cz + f.lz * lat;
      const hex = next() < 0.42 ? P.dirtDeep : P.dirt;
      blob(x, z, rngRange(next, 0.5, 1.5), EDGE_WEAR_Y, shade(hex, rngRange(next, 0.92, 1.08)));
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

// ---- ridgeline silhouette (distant horizon layers) --------------------------------
// A ring strip whose top edge follows a seeded harmonic mountain profile; vertex
// colors grade bottom->top. Three layers (dark near, hazy far) + fog give the
// horizon real depth. Wound to face INWARD, and centred on the CIRCUIT (cx,cz)
// rather than the world origin — the ring has to enclose the track, and only
// Greenvale happens to sit near the origin.

function ridgelineGeometry(
  cx: number,
  cz: number,
  radius: number,
  hPeak: number,
  next: () => number,
  loHex: string,
  hiHex: string,
): THREE.BufferGeometry {
  const ks = [2, 3, 4]; // broad overtones: big mountain rhythm, not choppy
  const amps = ks.map(() => rngRange(next, 0.6, 1));
  const phases = ks.map(() => next() * Math.PI * 2);
  // profile in [0,1] with real valleys (~0) so the ridge breaks into peaks
  const profile = (th: number): number => {
    let s = 0;
    let norm = 0;
    for (let k = 0; k < ks.length; k++) {
      s += amps[k]! * (0.5 + 0.5 * Math.sin(ks[k]! * th + phases[k]!));
      norm += amps[k]!;
    }
    return Math.max(0.015, (s / norm - 0.3) / 0.7);
  };
  const lo = new THREE.Color(loHex);
  const hi = new THREE.Color(hiHex);
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < RIDGE_SEGS; i++) {
    const th = (i / RIDGE_SEGS) * Math.PI * 2;
    const r = radius + rngRange(next, -1.5, 1.5); // tiny wobble: silhouette, not striping
    const h = hPeak * profile(th);
    const x = cx + Math.cos(th) * r;
    const z = cz + Math.sin(th) * r;
    pos.push(x, -1, z, x, h, z);
    nrm.push(0, 1, 0, 0, 1, 0); // ignored: flatShading derives face normals
    col.push(lo.r, lo.g, lo.b, hi.r, hi.g, hi.b);
  }
  for (let i = 0; i < RIDGE_SEGS; i++) {
    const j = (i + 1) % RIDGE_SEGS;
    const bi = i * 2;
    const ti = i * 2 + 1;
    const bj = j * 2;
    const tj = j * 2 + 1;
    idx.push(bi, bj, ti, ti, bj, tj); // faces the ring centre (the circuit)
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

// ---- curvature analysis (visual furniture placement ONLY) ------------------------

/** Smoothed signed turn per sample (rad), window +-4 samples. */
function smoothedTurn(frames: SampleFrame[]): number[] {
  const n = frames.length;
  const turn = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = frames[(i - 2 + n) % n]!;
    const b = frames[(i + 2) % n]!;
    const [tax, taz] = frameTangent(a);
    const [tbx, tbz] = frameTangent(b);
    turn[i] = Math.atan2(tax * tbz - taz * tbx, tax * tbx + taz * tbz);
  }
  const sm = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -4; k <= 4; k++) s += turn[(i + k + n) % n]!;
    sm[i] = s / 9;
  }
  return sm;
}

/**
 * Corner apexes: local maxima of |turn| above threshold, spaced apart.
 * The threshold is compared in radians per METRE (|turn| / mPerSample), not per
 * sample: at 256 fixed samples a 1.2 km circuit turns twice as far per sample
 * as Greenvale does, so a per-sample threshold would call every one of its
 * bends a hairpin. `apexSpacing` is likewise a distance converted to samples.
 * May legitimately return [] (a near-circular circuit has no apex) — every
 * caller must tolerate that.
 */
function findApexes(
  frames: SampleFrame[],
  sm: readonly number[],
  mPerSample: number,
  apexSpacing: number,
): Array<{ index: number; side: number }> {
  const n = frames.length;
  const out: Array<{ index: number; side: number }> = [];
  for (let i = 0; i < n; i++) {
    const v = Math.abs(sm[i]!);
    if (v / mPerSample < APEX_TURN_PER_M) continue;
    let isMax = true;
    for (let k = -8; k <= 8; k++) {
      if (Math.abs(sm[(i + k + n) % n]!) > v) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    const last = out[out.length - 1];
    if (last !== undefined) {
      const d = Math.min((i - last.index + n) % n, (last.index - i + n) % n);
      if (d < apexSpacing) continue;
    }
    // inside of the corner: t(i+6) - t(i-6) is the centripetal direction;
    // project it on the frame's left vector to get the apex side
    const a = frames[(i - 6 + n) % n]!;
    const b = frames[(i + 6) % n]!;
    const f = frames[i]!;
    const dx = b.lz - a.lz;
    const dz = -b.lx + a.lx;
    out.push({ index: i, side: dx * f.lx + dz * f.lz >= 0 ? 1 : -1 });
  }
  return out;
}

// ---- scatter rejections ------------------------------------------------------------

interface AvoidZone {
  x: number;
  z: number;
  r: number;
}

/**
 * "Is anything already placed within `minDist` of here?" — the min-spacing test
 * every scatter loop runs before it commits a prop.
 *
 * It used to be a linear scan of the placed list, which is quadratic in the
 * count and the count now scales with the circuit: the grass-patch field alone
 * makes ~7 000 attempts against a list that grows to ~340, and the tree/rock
 * pass another ~9 000 against its own. This is a uniform hash grid with the
 * cell size set to `minDist`, so a point within `minDist` is ALWAYS in one of
 * the nine cells around the query — the answer is exactly the linear scan's,
 * the work is O(1). Cell keys pack the two cell indices into one integer,
 * which is exact for any circuit inside ±8 000 cells of the origin.
 */
class SpacedPoints {
  private readonly cell: number;
  private readonly minD2: number;
  private readonly grid = new Map<number, number[]>();

  constructor(minDist: number) {
    this.cell = minDist;
    this.minD2 = minDist * minDist;
  }

  private static key(cx: number, cz: number): number {
    return (cx + 8192) * 16384 + (cz + 8192);
  }

  has(x: number, z: number): boolean {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const bucket = this.grid.get(SpacedPoints.key(cx + i, cz + j));
        if (bucket === undefined) continue;
        for (let k = 0; k < bucket.length; k += 2) {
          const dx = bucket[k]! - x;
          const dz = bucket[k + 1]! - z;
          if (dx * dx + dz * dz < this.minD2) return true;
        }
      }
    }
    return false;
  }

  add(x: number, z: number): void {
    const k = SpacedPoints.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    const bucket = this.grid.get(k);
    if (bucket === undefined) this.grid.set(k, [x, z]);
    else bucket.push(x, z);
  }
}

/**
 * |lateral| from `closestOnTrack`, without its O(SAMPLES) scan.
 *
 * Every scatter loop rejects candidates with
 * `Math.abs(closestOnTrack(track, x, z).lateral) <= someClearance`, and
 * closestOnTrack walks all 256 centreline samples per call. Across the grass
 * patches, the tree clusters, the top-up, the rocks and the tree line that is
 * ~20 000 calls — five million distance tests — and it was the largest cost in
 * the build after bake().
 *
 * This is a bounding-box tree over CONTIGUOUS index ranges of the same
 * centreline. It answers the same question exactly:
 *  * children are visited in index order and a node is pruned only when its
 *    box is STRICTLY farther than the best distance so far, so a sample that
 *    ties the best is still visited — which reproduces the linear scan's
 *    first-wins tie-break (lowest index) sample for sample;
 *  * the squared distance is the same expression in the same order, so the
 *    comparisons are made on bit-identical values;
 *  * the lateral is then derived from the winning sample exactly as
 *    closestOnTrack derives it.
 * `closestOnTrack` itself is frozen shared code and is untouched.
 */
interface RangeNode {
  minX: number; maxX: number; minZ: number; maxZ: number;
  lo: number; hi: number;                       // sample range [lo, hi)
  left: RangeNode | null; right: RangeNode | null;
}
const RANGE_LEAF = 8; // samples per leaf: below this the box test costs more than the scan

function buildRangeTree(cl: ReadonlyArray<readonly [number, number]>, lo: number, hi: number): RangeNode {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = lo; i < hi; i++) {
    const p = cl[i]!;
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  const leaf = hi - lo <= RANGE_LEAF;
  const mid = (lo + hi) >> 1;
  return {
    minX, maxX, minZ, maxZ, lo, hi,
    left: leaf ? null : buildRangeTree(cl, lo, mid),
    right: leaf ? null : buildRangeTree(cl, mid, hi),
  };
}

/** Build the accelerator for one circuit; returns |lateral| at any world point. */
function lateralQuery(track: TrackDef): (x: number, z: number) => number {
  const cl = track.centerline;
  const n = cl.length;
  const root = buildRangeTree(cl, 0, n);
  return (x, z): number => {
    let best = 0;
    let bestD = Infinity;
    const visit = (node: RangeNode): void => {
      const dx = x < node.minX ? node.minX - x : x > node.maxX ? x - node.maxX : 0;
      const dz = z < node.minZ ? node.minZ - z : z > node.maxZ ? z - node.maxZ : 0;
      if (dx * dx + dz * dz > bestD) return; // strict: a tie must still be visited
      if (node.left === null) {
        for (let i = node.lo; i < node.hi; i++) {
          const c = cl[i]!;
          const d = (c[0] - x) * (c[0] - x) + (c[1] - z) * (c[1] - z);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        return;
      }
      visit(node.left);
      visit(node.right!);
    };
    visit(root);
    const c = cl[best]!;
    const nxt = cl[(best + 1) % n]!;
    const tx = nxt[0] - c[0];
    const tz = nxt[1] - c[1];
    const l = Math.hypot(tx, tz) || 1;
    return Math.abs(((x - c[0]) * (tz / l) - (z - c[1]) * (tx / l)) * -1);
  };
}

/** Inside any furniture keep-clear disc (buildings, billboards, lamps, stacks)? */
function inAvoid(x: number, z: number, zones: ReadonlyArray<AvoidZone>): boolean {
  for (const zn of zones) {
    const dx = x - zn.x;
    const dz = z - zn.z;
    if (dx * dx + dz * dz < zn.r * zn.r) return true;
  }
  return false;
}

// ---- block lettering (5x7 pixel font, palette boxes) -------------------------------
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  K: ['X...X', 'X..X.', 'X.X..', 'XX...', 'X.X..', 'X..X.', 'X...X'],
  A: ['.XXX.', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  R: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X.X..', 'X..X.', 'X...X'],
  T: ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', '..X..'],
  G: ['.XXX.', 'X...X', 'X....', 'X.XXX', 'X...X', 'X...X', '.XXX.'],
  P: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X....', 'X....', 'X....'],
  I: ['XXX', '.X.', '.X.', '.X.', '.X.', '.X.', 'XXX'],
  '1': ['..X..', '.XX..', '..X..', '..X..', '..X..', '..X..', '.XXX.'],
  '2': ['.XXX.', 'X...X', '....X', '...X.', '..X..', '.X...', 'XXXXX'],
  '3': ['.XXX.', 'X...X', '....X', '..XX.', '....X', 'X...X', '.XXX.'],
};

/**
 * Row of block letters centered on the group's local x at height cy, depth z.
 * `mirror` flips the row so the back face of a sign also reads correctly.
 */
function addBlockText(
  g: THREE.Group,
  matFn: MatFn,
  text: string,
  cell: number,
  hex: string,
  cy: number,
  z: number,
  mirror: boolean,
): void {
  const glyphs = [...text].map((ch) => (ch === ' ' ? null : GLYPHS[ch] ?? null));
  const widths = glyphs.map((gl) => (gl === null ? 2 : gl[0]!.length));
  const totalCells = widths.reduce((a, b) => a + b, 0) + glyphs.length - 1;
  let cursor = -totalCells / 2;
  const order = mirror ? [...glyphs.keys()].reverse() : glyphs.map((_, i) => i);
  for (const gi of order) {
    const gl = glyphs[gi]!;
    const w = widths[gi]!;
    if (gl !== null) {
      for (let r = 0; r < gl.length; r++) {
        const row = mirror ? [...gl[r]!].reverse() : [...gl[r]!];
        for (let c = 0; c < row.length; c++) {
          if (row[c] !== 'X') continue;
          g.add(at(sbox(matFn, cell * 0.84, cell * 0.84, 0.05, hex), (cursor + c + 0.5) * cell, cy + (3 - r) * cell, z));
        }
      }
    }
    cursor += w + 1;
  }
}

// ---- seeded prop recipes (resolved palette only, never an ad-hoc hex) ----------------

/**
 * Flat `…Deep` contact band under a prop. Every prop, post and tree gets one:
 * it is this round's stand-in for ambient occlusion (VISUAL_UPGRADE.md §4) and
 * is what stops trackside furniture reading as a decal pasted on the verge.
 * `hex` must be the Deep tier of whatever the prop is standing ON — grassDeep
 * out on the field, dirtDeep on the shoulder, concreteDeep under a footing.
 */
function contactPad(matFn: MatFn, w: number, d: number, hex: string): THREE.Mesh {
  return at(sbox(matFn, w, PAD_H, d, hex), 0, PAD_H / 2, 0);
}

/**
 * Seeded canopy trio for one tree: [lit, body, deep]. Every species gets a
 * TWO-TIER canopy plus a deep underside so it stops reading as broccoli (§4) —
 * the tiers always come from the frozen treeLeaf ladder, never a multiplier.
 */
function canopyTiers(next: () => number): [string, string, string] {
  // half the trees run the ladder one rung lower: grove-to-grove tone variance
  return next() < 0.5
    ? [P.treeLeafLight, P.treeLeaf, P.treeLeafDeep]
    : [P.treeLeaf, P.treeLeafDeep, P.treeLeafDeep];
}

/** seeded leaf tone for low scatter bushes: the canopy ladder, one pick. */
function leafTone(next: () => number): string {
  const r = next();
  return r < 0.4 ? P.treeLeaf : r < 0.75 ? P.treeLeafLight : P.treeLeafDeep;
}

/** broadleaf: trunk (+ deep root flare) + a lit crown over a deep underside. */
function buildBroadleaf(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  const [lit, body, deep] = canopyTiers(next);
  const h = rngRange(next, 1.0, 1.6);
  g.add(at(scyl(matFn, 0.12, 0.18, h, 6, P.treeTrunk), 0, h / 2, 0));
  g.add(at(scyl(matFn, 0.19, 0.26, 0.16, 6, P.treeTrunkDeep), 0, 0.08, 0)); // root flare
  const r1 = rngRange(next, 0.9, 1.3);
  const under = ssphere(matFn, r1 * 0.92, 6, deep); // shaded underside of the mass
  under.scale.set(1, 0.55, 1);
  g.add(at(under, 0, h + r1 * 0.4, 0));
  g.add(at(ssphere(matFn, r1, 7, body), 0, h + r1 * 0.62, 0));
  const r2 = r1 * rngRange(next, 0.55, 0.7);
  g.add(
    at(
      ssphere(matFn, r2, 6, lit),
      rngRange(next, -0.25, 0.25),
      h + r1 * 0.62 + r2 * 0.85,
      rngRange(next, -0.25, 0.25),
    ),
  );
  return g;
}

/** pine: short trunk + 3 stacked cones, deep skirt -> body -> lit tip. */
function buildPine(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  const [lit, body, deep] = canopyTiers(next);
  const h = rngRange(next, 0.7, 1.1);
  g.add(at(scyl(matFn, 0.1, 0.16, h, 6, P.treeTrunk), 0, h / 2, 0));
  g.add(at(scyl(matFn, 0.17, 0.24, 0.14, 6, P.treeTrunkDeep), 0, 0.07, 0)); // root flare
  const r1 = rngRange(next, 0.75, 1.05);
  g.add(at(scone(matFn, r1 * 1.12, rngRange(next, 1.0, 1.3), 7, deep), 0, h + 0.34, 0));
  g.add(at(scone(matFn, r1, rngRange(next, 1.3, 1.7), 7, body), 0, h + 0.72, 0));
  g.add(at(scone(matFn, r1 * 0.6, rngRange(next, 0.9, 1.2), 7, lit), 0, h + 0.72 + r1 * 0.85, 0));
  return g;
}

/** poplar: tall trunk + a stretched crown, deep skirt under a lit tip. */
function buildPoplar(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  const [lit, body, deep] = canopyTiers(next);
  const h = rngRange(next, 1.5, 2.2);
  g.add(at(scyl(matFn, 0.09, 0.14, h, 6, P.treeTrunk), 0, h / 2, 0));
  g.add(at(scyl(matFn, 0.15, 0.21, 0.13, 6, P.treeTrunkDeep), 0, 0.065, 0)); // root flare
  const r = rngRange(next, 0.5, 0.75);
  const skirt = ssphere(matFn, r * 1.02, 6, deep);
  skirt.scale.set(1, rngRange(next, 0.9, 1.15), 1);
  g.add(at(skirt, 0, h + r * 0.85, 0));
  const crown = ssphere(matFn, r, 7, body);
  crown.scale.set(1, rngRange(next, 1.9, 2.4), 1);
  crown.position.y = h + r * 1.65;
  g.add(crown);
  g.add(at(ssphere(matFn, r * 0.5, 6, lit), 0, h + r * 3.1, 0));
  return g;
}

/**
 * One of the three silhouettes + a grassDeep contact pad, per-instance yaw and
 * a +-30 % scale spread (§4). Placed on the grass field only.
 */
function buildAnyTree(matFn: MatFn, next: () => number): THREE.Group {
  const r = next();
  const g = r < 0.34 ? buildPine(matFn, next) : r < 0.67 ? buildBroadleaf(matFn, next) : buildPoplar(matFn, next);
  g.add(contactPad(matFn, rngRange(next, 0.95, 1.35), rngRange(next, 0.95, 1.35), P.grassDeep));
  g.rotation.y = next() * Math.PI * 2;
  g.scale.setScalar(rngRange(next, 0.7, 1.3));
  return g;
}

/** rock: 1-2 overlapping squashed spheres over a rockDeep base + grass pad. */
function buildRock(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  g.add(contactPad(matFn, rngRange(next, 1.1, 1.5), rngRange(next, 1.1, 1.5), P.grassDeep));
  const n = rngInt(next, 1, 2);
  for (let i = 0; i < n; i++) {
    const r = rngRange(next, 0.4, 0.9);
    const ox = rngRange(next, -0.4, 0.4);
    const oz = rngRange(next, -0.4, 0.4);
    const sx = rngRange(next, 0.9, 1.4);
    const sz = rngRange(next, 0.9, 1.4);
    const skirt = at(ssphere(matFn, r * 1.05, 6, P.rockDeep), ox, r * 0.16, oz); // bedded-in base
    skirt.scale.set(sx, 0.22, sz);
    g.add(skirt);
    const m = at(ssphere(matFn, r, 7, P.rock), ox, r * 0.5, oz);
    m.scale.set(sx, rngRange(next, 0.4, 0.65), sz);
    m.rotation.y = next() * Math.PI;
    g.add(m);
  }
  return g;
}

/** tire stack: 3 painted torus rings (red or white), apex furniture. */
function buildTireStack(matFn: MatFn, hex: string): THREE.Group {
  const g = new THREE.Group();
  g.add(contactPad(matFn, 1.0, 1.0, P.grassDeep));
  g.add(at(scyl(matFn, 0.44, 0.48, 0.06, 10, P.tire), 0, 0.05, 0)); // dark base ring
  for (let k = 0; k < 3; k++) {
    const t = new THREE.Mesh(proto('t|tire', () => new THREE.TorusGeometry(0.3, 0.13, 7, 12)), matFn(hex));
    t.rotation.x = Math.PI / 2; // lie flat, hole up
    t.position.y = 0.2 + k * 0.26;
    g.add(t);
  }
  return g;
}

/**
 * Traffic cone: charcoal contact base (cones live on the dirt shoulder, so the
 * contact band is a dark plate rather than a grassDeep pad) + orange body +
 * white reflective collar.
 */
function buildCone(matFn: MatFn): THREE.Group {
  const g = new THREE.Group();
  g.add(at(sbox(matFn, 0.34, 0.045, 0.34, P.charcoal), 0, 0.022, 0));
  g.add(at(scone(matFn, 0.16, 0.44, 8, P.kartOrange), 0, 0.28, 0));
  g.add(at(scyl(matFn, 0.085, 0.105, 0.09, 8, P.curbWhite), 0, 0.3, 0));
  return g;
}

/**
 * Start gantry: two truss posts flanking the road, a truss beam, and an ink
 * banner with 'KART GP' block letters readable from BOTH faces + gold trim and
 * start-light pods under the beam.
 */
function buildGantry(matFn: MatFn, track: TrackDef): THREE.Group {
  const g0 = track.gates[0]!;
  const w = track.roadHalfW;
  const g = new THREE.Group();
  g.position.set(g0.x, 0, g0.z);
  g.rotation.y = Math.atan2(-g0.tx, -g0.tz); // local +x = left of travel, -z = travel

  for (const side of [1, -1]) {
    const x = side * (w + GANTRY_OFF);
    g.add(at(sbox(matFn, 1.25, PAD_H, 1.25, P.concreteDeep), x, PAD_H / 2, 0)); // footing pad
    g.add(at(sbox(matFn, 0.9, 0.18, 0.9, P.steel), x, 0.11, 0)); // base plate
    g.add(at(sbox(matFn, 0.34, 5.7, 0.34, P.charcoal), x, 2.94, 0)); // column
    const brace = sbox(matFn, 0.16, 1.7, 0.16, P.steel); // angled brace inward
    brace.position.set(side * (w + GANTRY_OFF - 0.45), 4.75, 0);
    brace.rotation.z = side * 0.55;
    g.add(brace);
  }

  // truss beam: two chords + verticals
  const span = 2 * (w + GANTRY_OFF) + 0.5;
  g.add(at(sbox(matFn, span, 0.2, 0.2, P.steel), 0, 5.55, 0));
  g.add(at(sbox(matFn, span, 0.2, 0.2, P.steel), 0, 4.95, 0));
  for (let i = -3; i <= 3; i++) {
    g.add(at(sbox(matFn, 0.12, 0.6, 0.12, P.steel), (i * span) / 8, 5.25, 0));
  }

  // banner + gold trim, letters on both faces
  g.add(at(sbox(matFn, 7.8, 1.6, 0.14, P.ink), 0, 3.9, 0));
  g.add(at(sbox(matFn, 7.8, 0.09, 0.16, P.gold), 0, 4.66, 0));
  g.add(at(sbox(matFn, 7.8, 0.09, 0.16, P.gold), 0, 3.14, 0));
  addBlockText(g, matFn, 'KART GP', 0.155, P.curbWhite, 3.9, 0.096, false);
  addBlockText(g, matFn, 'KART GP', 0.155, P.curbWhite, 3.9, -0.096, true);

  // start lights: 5 ink housings under the bottom chord, red/amber/green lenses
  const LENSES = [P.kartRed, P.kartYellow, P.kartGreen, P.kartYellow, P.kartRed];
  for (let li = 0; li < LENSES.length; li++) {
    const x = (li - 2) * 0.55;
    g.add(at(sbox(matFn, 0.34, 0.34, 0.18, P.ink), x, 4.66, 0));
    for (const zSide of [1, -1]) {
      const lens = scyl(matFn, 0.1, 0.1, 0.05, 10, LENSES[li]!);
      lens.rotation.x = Math.PI / 2; // face along the straight (both ways)
      lens.position.set(x, 4.66, zSide * 0.11);
      g.add(lens);
    }
  }
  return g;
}

/**
 * Billboard: two steel posts + panel + a palette-block poster (5 seeded
 * designs). Faces the track (local +z toward the centerline sample).
 */
function buildBillboard(matFn: MatFn, design: number): THREE.Group {
  const g = new THREE.Group();
  g.add(contactPad(matFn, 3.6, 1.0, P.grassDeep));
  for (const x of [-1.4, 1.4]) {
    g.add(at(sbox(matFn, 0.42, 0.16, 0.42, P.concreteDeep), x, 0.08, 0)); // footing
    g.add(at(sbox(matFn, 0.16, 2.6, 0.16, P.steel), x, 1.3, 0));
  }
  const fields = [P.kartRed, P.charcoal, P.grassDark, P.ink, P.curbWhite];
  g.add(at(sbox(matFn, 4.4, 2.2, 0.12, fields[design % fields.length]!), 0, 2.6, 0));
  const z = 0.09; // poster blocks ride on the panel face
  switch (design % 5) {
    case 0: // red field: gold diagonal + ink foot + white chip
      g.add(at(sbox(matFn, 4.4, 0.5, 0.06, P.ink), 0, 1.85, z));
      g.add(rotZ(sbox(matFn, 3.6, 0.5, 0.06, P.gold), 0.45, 0, 2.75, z));
      g.add(at(sbox(matFn, 0.5, 0.5, 0.06, P.curbWhite), 1.5, 3.15, z));
      break;
    case 1: // charcoal field: white band + orange block + gold foot
      g.add(at(sbox(matFn, 4.4, 0.6, 0.06, P.curbWhite), 0, 2.95, z));
      g.add(at(sbox(matFn, 1.2, 1.2, 0.06, P.kartOrange), -1.2, 2.2, z));
      g.add(at(sbox(matFn, 4.4, 0.12, 0.06, P.gold), 0, 1.62, z));
      break;
    case 2: // green field: gold disc + light chip + ink foot
      g.add(rotX(scyl(matFn, 0.7, 0.7, 0.06, 14, P.gold), -1.2, 2.85, z));
      g.add(at(sbox(matFn, 1.0, 1.0, 0.06, P.treeLeafLight), 1.3, 2.7, z));
      g.add(at(sbox(matFn, 4.4, 0.4, 0.06, P.ink), 0, 1.8, z));
      break;
    case 3: // ink field: red band + 3 white chips + gold foot
      g.add(at(sbox(matFn, 4.4, 0.55, 0.06, P.kartRed), 0, 3.05, z));
      for (const x of [-0.75, 0, 0.75]) g.add(at(sbox(matFn, 0.45, 0.45, 0.06, P.curbWhite), x, 2.2, z));
      g.add(at(sbox(matFn, 4.4, 0.12, 0.06, P.gold), 0, 1.62, z));
      break;
    default: // white field: ink text bars + red corner + gold chip
      for (let r = 0; r < 3; r++) g.add(at(sbox(matFn, 1.7, 0.26, 0.06, P.ink), -1.05, 3.15 - r * 0.42, z));
      g.add(at(sbox(matFn, 1.1, 1.1, 0.06, P.kartRed), 1.45, 2.05, z));
      g.add(at(sbox(matFn, 0.5, 0.5, 0.06, P.gold), 1.45, 3.2, z));
      break;
  }
  return g;
}

/** billboard block rotated in-plane (poster diagonals). */
function rotZ<T extends THREE.Object3D>(obj: T, angle: number, x: number, y: number, z: number): T {
  obj.rotation.z = angle;
  obj.position.set(x, y, z);
  return obj;
}

/** billboard disc tipped to face +z (panel-parallel). */
function rotX<T extends THREE.Object3D>(obj: T, x: number, y: number, z: number): T {
  obj.rotation.x = Math.PI / 2;
  obj.position.set(x, y, z);
  return obj;
}

/** lamp post: steel pole + arm reaching over the barrier + head with lens. */
function buildLamp(matFn: MatFn): THREE.Group {
  const g = new THREE.Group(); // local +z = toward the road
  g.add(contactPad(matFn, 0.85, 0.85, P.grassDeep));
  g.add(at(scyl(matFn, 0.16, 0.2, 0.22, 8, P.steelDeep), 0, 0.11, 0)); // base collar
  g.add(at(scyl(matFn, 0.07, 0.1, 5.6, 7, P.steel), 0, 2.9, 0));
  g.add(at(sbox(matFn, 0.1, 0.1, 1.7, P.steel), 0, 5.52, 0.75));
  g.add(at(sbox(matFn, 0.34, 0.12, 0.66, P.charcoal), 0, 5.42, 1.55));
  g.add(at(sbox(matFn, 0.26, 0.03, 0.5, P.curbWhite), 0, 5.35, 1.55));
  return g;
}

/**
 * Pit building: white block + charcoal roof + red fascia with 'PIT' lettering,
 * windows/door, steel annex, roof clutter. Faces the track (local +z).
 */
function buildPitBuilding(matFn: MatFn): THREE.Group {
  const g = new THREE.Group();
  g.add(contactPad(matFn, 13.5, 8.0, P.grassDeep)); // grounding band on the verge
  g.add(at(sbox(matFn, 11.0, 0.34, 5.5, P.concreteDeep), 0, 0.17, 0)); // plinth
  g.add(at(sbox(matFn, 10.5, 3.4, 5.0, P.curbWhite), 0, 2.04, 0));
  g.add(at(sbox(matFn, 10.9, 0.14, 5.4, P.concrete), 0, 3.78, 0)); // eaves band
  g.add(at(sbox(matFn, 11.3, 0.28, 5.9, P.charcoal), 0, 3.99, 0));
  g.add(at(sbox(matFn, 11.3, 0.46, 0.12, P.kartRed), 0, 3.62, 2.92)); // fascia
  addBlockText(g, matFn, 'PIT', 0.13, P.curbWhite, 3.62, 3.0, false);
  for (const x of [-3.8, -1.3, 1.2]) {
    g.add(at(sbox(matFn, 1.5, 1.1, 0.1, P.ink), x, 2.24, 2.52)); // windows
    g.add(at(sbox(matFn, 1.66, 0.1, 0.08, P.concreteDeep), x, 1.63, 2.54)); // sill
  }
  g.add(at(sbox(matFn, 1.1, 2.2, 0.1, P.charcoal), 3.9, 1.44, 2.52)); // door
  g.add(at(sbox(matFn, 4.0, 0.3, 3.8, P.concreteDeep), -7.6, 0.15, -0.4)); // annex plinth
  g.add(at(sbox(matFn, 3.6, 2.4, 3.4, P.steel), -7.6, 1.5, -0.4)); // annex
  g.add(at(sbox(matFn, 3.8, 0.16, 3.6, P.steelDeep), -7.6, 2.78, -0.4)); // annex cap
  g.add(at(sbox(matFn, 0.9, 0.4, 0.9, P.steel), -2.5, 4.34, 0.8)); // roof clutter
  g.add(at(sbox(matFn, 0.9, 0.4, 0.9, P.charcoal), 1.8, 4.34, -1.2));
  return g;
}

/**
 * Grandstand: grassDeep contact band + concreteDeep plinth, 5 ascending
 * terraces PACKED with a seeded crowd (body block from the frozen CROWD_COLORS
 * cycle + a darker head, two staggered rows per terrace, varied stature so a
 * few stand), back wall, roof slab on posts. An empty stand reads as a dead
 * world (VISUAL_UPGRADE.md §4), so density here is the whole point. Faces the
 * track (local +z). ~20m long, sits along the start straight.
 */
function buildGrandstand(matFn: MatFn, next: () => number): THREE.Group {
  const g = new THREE.Group();
  const LEN = 20;
  const TIERS = 5;
  g.add(contactPad(matFn, LEN + 3.4, 10.4, P.grassDeep));
  g.add(at(sbox(matFn, LEN + 0.6, 0.34, 7.6, P.concreteDeep), 0, 0.17, 0)); // plinth
  g.add(at(sbox(matFn, LEN, 0.28, 7, P.steel), 0, 0.48, 0)); // deck
  let seat = rngInt(next, 0, CROWD_COLORS.length - 1);
  for (let k = 0; k < TIERS; k++) {
    const y = 0.62 + k * 0.55;
    const z = 2.5 - k * 1.35;
    // terraces overlap in y (0.62 tall on a 0.55 rise) so no slit shows between steps
    g.add(at(sbox(matFn, LEN, 0.62, 1.45, P.asphaltLight), 0, y + 0.19, z));
    g.add(at(sbox(matFn, LEN, 0.12, 0.1, P.concreteDeep), 0, y + 0.06, z + 0.72)); // riser shadow
    // two staggered crowd rows per terrace: front row sits, back row often stands
    for (let row = 0; row < 2; row++) {
      const rz = z + (row === 0 ? 0.34 : -0.3);
      let x = -LEN / 2 + 0.55 + (row === 0 ? 0 : 0.38);
      while (x < LEN / 2 - 0.55) {
        if (next() < 0.9) {
          const hex = CROWD_COLORS[seat % CROWD_COLORS.length]!;
          seat += rngInt(next, 1, 3); // cycle the palette, never two identical runs
          const stand = row === 1 && next() < 0.35;
          const bh = stand ? 0.72 : 0.5;
          const cx = x + rngRange(next, -0.08, 0.08);
          const cz = rz + rngRange(next, -0.12, 0.12);
          g.add(at(sbox(matFn, 0.44, bh, 0.42, hex), cx, y + 0.5 + bh / 2, cz));
          g.add(at(sbox(matFn, 0.26, 0.24, 0.26, P.charcoal), cx, y + 0.5 + bh + 0.12, cz)); // head
        }
        x += rngRange(next, 0.62, 0.92);
      }
    }
  }
  g.add(at(sbox(matFn, LEN, 2.4, 0.35, P.charcoal), 0, 1.8, -3.4)); // back wall
  g.add(at(sbox(matFn, LEN, 0.16, 0.42, P.steelDeep), 0, 0.68, -3.4)); // wall footing
  for (const px of [-LEN / 2 + 0.6, LEN / 2 - 0.6]) {
    g.add(at(sbox(matFn, 0.3, 3.0, 0.3, P.charcoal), px, 2.3, 2.9)); // roof posts (meet the slab)
    g.add(at(sbox(matFn, 0.46, 0.2, 0.46, P.steelDeep), px, 0.72, 2.9)); // post base
  }
  g.add(at(sbox(matFn, LEN + 0.8, 0.22, 7.6, P.ink), 0, 3.85, -0.2)); // roof slab
  g.add(at(sbox(matFn, LEN + 0.9, 0.14, 0.18, P.gold), 0, 3.7, 3.5)); // roof edge trim
  return g;
}

/** brake board: white post + board with a dark block numeral ('3'/'2'/'1'). */
function buildBrakeBoard(matFn: MatFn, numeral: string): THREE.Group {
  const g = new THREE.Group(); // local +z faces approaching traffic
  g.add(contactPad(matFn, 0.46, 0.46, P.dirtDeep)); // boards stand on the shoulder
  g.add(at(sbox(matFn, 0.16, 0.14, 0.16, P.steelDeep), 0, 0.07, 0)); // foot
  g.add(at(sbox(matFn, 0.08, 1.05, 0.08, P.curbWhite), 0, 0.55, 0)); // post
  g.add(at(sbox(matFn, 0.62, 0.48, 0.06, P.curbWhite), 0, 1.1, 0)); // board
  addBlockText(g, matFn, numeral, 0.052, P.ink, 1.1, 0.045, false);
  addBlockText(g, matFn, numeral, 0.052, P.ink, 1.1, -0.045, true);
  return g;
}

/**
 * Build the whole circuit: ground, banded road ribbon + painted markings,
 * curbs + dirt shoulders, barrier posts, furniture (gantry, tire stacks, cones,
 * billboards, lamps, pit building), seeded scatter, tree line, ridgelines.
 * Disposal of the returned group's geometries is the caller's job (render.ts
 * owns trackRoot lifetime and its disposeGeometries sweep).
 *
 * EVERYTHING here is derived from `track`: the palette from track.theme.palette,
 * the world sizing from the centreline bbox (`world`), every furniture anchor
 * from gate 0 plus a distance in metres (`s`), and every RNG from the track id.
 * Nothing in this function may reference the world origin or a literal sample
 * index — see the file header.
 */
export function buildTrackMesh(track: TrackDef, matFn: MatFn): THREE.Group {
  const ph = phaseHook();
  protoCache.clear(); // prototypes live for exactly one build (see `proto`)
  P = { ...KPAL, ...track.theme.palette };
  const frames = trackFrames(track.centerline);
  const w = track.roadHalfW;
  const root = new THREE.Group();
  const n = frames.length;
  const world = trackWorld(track);
  // every scatter loop's "not on the road" test, exactly as closestOnTrack
  // answers it but without its full-centreline scan (see lateralQuery)
  const absLateral = lateralQuery(track);
  const seed = `kart-${track.id}`; // per-circuit deco: two tracks never share scatter
  /**
   * Samples spanning `metres` of THIS circuit. SAMPLES is fixed at 256 for
   * every track, so a sample is 2.34 m on Greenvale and would be 4.7 m on a
   * 1.2 km circuit; a spacing expressed in samples is really a distance.
   * Floored at 1 so a step never becomes zero and hangs a loop.
   */
  const s = (metres: number): number => Math.max(1, Math.round((metres * n) / track.length));
  const g0i = track.gates[0]!.index;
  // curvature drives the road's rubber lines, the apex skids/stacks, billboards
  const turn = smoothedTurn(frames);
  const apexes = findApexes(frames, turn, world.mPerSample, s(APEX_SPACING_M));
  ph('frames');

  // ---- the grass field: a tier-mottled plane, NOT a flat slab ---------------
  const groundNext = rng(decoSeed(seed, 18));
  const ground = new THREE.Mesh(groundGeometry(world, groundNext), vertexPaintMaterial());
  ground.receiveShadow = true;
  root.add(ground);
  ph('ground');

  // mown stripe bands along the verge (over the field, under the dirt wear)
  const mownNext = rng(decoSeed(seed, 19));
  const mown = new THREE.Mesh(mownStripeGeometry(frames, w, s(MOWN_STRIPE_M), mownNext), vertexPaintMaterial());
  mown.receiveShadow = true;
  root.add(mown);
  ph('mownStripes');

  // ---- road ribbon + painted markings (flat, receive shadows only) -----------
  const roadNext = rng(decoSeed(seed, 10));
  const road = new THREE.Mesh(roadGeometry(frames, w, turn, roadNext), vertexPaintMaterial());
  road.receiveShadow = true;
  root.add(road);
  ph('roadRibbon');

  // subtle center-line dashes: thin lighter strip, every other segment.
  // max(2, …) so the on/off pattern always has an off segment: at 1 the dashes
  // would fuse into a solid painted line down the middle of the road.
  const dashPeriod = Math.max(2, s(DASH_PERIOD_M));
  const dashes = new THREE.Mesh(
    ribbonGeometry(frames, DASH_W / 2, -DASH_W / 2, DASH_Y, () => [1, 1, 1], (i) => i % dashPeriod !== 0),
    matFn(P.asphaltLight),
  );
  dashes.receiveShadow = true;
  root.add(dashes);
  ph('dashes');

  // curb stripes: alternating red/white every CURB_STRIPE_M of road, both edges
  const curbPeriod = s(CURB_STRIPE_M);
  const curbCols = [new THREE.Color(P.curbRed), new THREE.Color(P.curbWhite)];
  const curbColor = (seg: number): [number, number, number] => {
    const c = curbCols[Math.floor(seg / curbPeriod) % 2]!;
    return [c.r, c.g, c.b];
  };
  for (const side of [1, -1]) {
    const inner = side * w;
    const outer = side * (w + CURB_W);
    const curb = new THREE.Mesh(
      ribbonGeometry(frames, Math.max(inner, outer), Math.min(inner, outer), CURB_Y, curbColor, () => false),
      vertexPaintMaterial(),
    );
    curb.receiveShadow = true;
    root.add(curb);
  }
  ph('curbs');

  // dirt shoulder ring (the two dirt tiers, alternating in runs) followed by the
  // asphaltDeep CONTACT BAND where the whole road assembly meets the grass —
  // that band is KART's L2 contact rule (VISUAL_UPGRADE.md §4).
  const dirtNext = rng(decoSeed(seed, 11));
  const dirtCols = [new THREE.Color(P.dirt), new THREE.Color(P.dirtDeep)];
  const dirtColor = (seg: number): [number, number, number] => {
    const c = dirtCols[Math.floor(seg / 3) % 2]!;
    const j = 0.92 + dirtNext() * 0.16;
    return [Math.min(1, c.r * j), Math.min(1, c.g * j), Math.min(1, c.b * j)];
  };
  const deepBand = new THREE.Color(P.asphaltDeep);
  const deepColor = (): [number, number, number] => {
    const j = 0.92 + dirtNext() * 0.16;
    return [Math.min(1, deepBand.r * j), Math.min(1, deepBand.g * j), Math.min(1, deepBand.b * j)];
  };
  const shOuter = w + CURB_W + SHOULDER_W;
  const shDeep = shOuter + SHOULDER_DEEP_W;
  const shoulderParts = [
    ribbonGeometry(frames, shOuter, w + CURB_W, SHOULDER_Y, dirtColor, () => false),
    ribbonGeometry(frames, -(w + CURB_W), -shOuter, SHOULDER_Y, dirtColor, () => false),
    ribbonGeometry(frames, shDeep, shOuter, SHOULDER_Y, deepColor, () => false),
    ribbonGeometry(frames, -shOuter, -shDeep, SHOULDER_Y, deepColor, () => false),
  ];
  const dirtMerged = mergeGeometries(shoulderParts, false);
  if (dirtMerged) {
    const dirt = new THREE.Mesh(dirtMerged, vertexPaintMaterial());
    dirt.receiveShadow = true;
    root.add(dirt);
  }
  ph('shoulders');

  // asphalt wear: repair patches + edge grime + apex skids (one vertex-color mesh)
  const detailNext = rng(decoSeed(seed, 12));
  const detail = new THREE.Mesh(
    roadDetailGeometry(frames, w, apexes, scaled(PATCH_COUNT, world.density), detailNext),
    vertexPaintMaterial(),
  );
  detail.receiveShadow = true;
  root.add(detail);
  ph('roadDetail');

  // grass tone patches: four-tier blobs + broad mottling + track-edge dirt wear
  const blobNext = rng(decoSeed(seed, 13));
  const blobs = new THREE.Mesh(grassPatchGeometry(absLateral, frames, w, world, blobNext), vertexPaintMaterial());
  blobs.receiveShadow = true;
  root.add(blobs);
  ph('grassPatches');

  // ---- everything static below is baked into ~1 mesh per material ------------
  const statics = new THREE.Group();
  const avoid: AvoidZone[] = []; // furniture keep-clear discs for the scatter

  // (the ground is the vertex-coloured field mesh above — there is deliberately
  // no flat grass slab here any more: one uncut green was KART's worst flaw)

  // barrier posts: every BARRIER_SPACING_M of road at roadHalfW + BARRIER_OFF,
  // each socketed on a charcoal collar over a dirtDeep pad — the posts stand on
  // the dirt shoulder, so their contact band is the dirt ladder's Deep tier.
  const barrierEvery = s(BARRIER_SPACING_M);
  for (let i = 0; i < frames.length; i += barrierEvery) {
    const f = frames[i]!;
    const hex = (i / barrierEvery) % 2 === 0 ? P.barrierWhite : P.barrierRed;
    for (const side of [1, -1]) {
      const px = f.cx + f.lx * (w + BARRIER_OFF) * side;
      const pz = f.cz + f.lz * (w + BARRIER_OFF) * side;
      statics.add(at(sbox(matFn, 0.42, PAD_H, 0.42, P.dirtDeep), px, PAD_H / 2, pz));
      statics.add(at(scyl(matFn, 0.13, 0.15, 0.1, 8, P.charcoal), px, 0.07, pz));
      statics.add(at(scyl(matFn, 0.09, 0.09, BARRIER_H, 8, hex), px, BARRIER_H / 2 + 0.11, pz));
    }
  }

  ph('barriers');
  // start/finish: checkered band of small quads across gate 0
  const g0 = track.gates[0]!;
  const cell = (w * 2) / CHECKER_COLS;
  const checker = new THREE.Group();
  checker.position.set(g0.x, PAINT_Y, g0.z);
  checker.rotation.y = Math.atan2(-g0.tx, -g0.tz); // local -z = direction of travel
  for (let r = 0; r < CHECKER_ROWS; r++) {
    for (let c = 0; c < CHECKER_COLS; c++) {
      const hex = (r + c) % 2 === 0 ? P.startLine : P.ink;
      checker.add(
        at(
          sbox(matFn, cell * 0.98, 0.02, cell * 0.98, hex),
          (c + 0.5 - CHECKER_COLS / 2) * cell,
          0,
          (CHECKER_ROWS / 2 - r - 0.5) * cell,
        ),
      );
    }
  }
  statics.add(checker);

  // grid slot markers: one outlined stall per slot behind the line
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const s = gridSlot(track, i);
    const stall = new THREE.Group();
    stall.position.set(s.x, PAINT_Y, s.z);
    stall.rotation.y = s.yaw;
    stall.add(at(sbox(matFn, 1.7, 0.02, 0.14, P.startLine), 0, 0, -1.25));
    stall.add(at(sbox(matFn, 1.7, 0.02, 0.14, P.startLine), 0, 0, 1.25));
    stall.add(at(sbox(matFn, 0.14, 0.02, 2.5, P.startLine), -0.85, 0, 0));
    stall.add(at(sbox(matFn, 0.14, 0.02, 2.5, P.startLine), 0.85, 0, 0));
    statics.add(stall);
  }

  ph('startPaint');
  // ---- furniture ---------------------------------------------------------------
  const furnNext = rng(decoSeed(seed, 16));

  // start gantry over the line
  const gantry = buildGantry(matFn, track);
  statics.add(gantry);
  for (const side of [1, -1]) {
    avoid.push({ x: g0.x + -g0.tz * (w + GANTRY_OFF) * side, z: g0.z + g0.tx * (w + GANTRY_OFF) * side, r: 2 });
  }

  // red/white tire stacks at corner apexes (inside of the corner)
  let stackIdx = 0;
  for (const apex of apexes.slice(0, 8)) {
    for (const ds of [-2, 0, 2]) {
      const f = frames[(apex.index + ds + n) % n]!;
      const lat = apex.side * (w + STACK_OFF);
      const x = f.cx + f.lx * lat;
      const z = f.cz + f.lz * lat;
      const stack = buildTireStack(matFn, stackIdx % 2 === 0 ? P.barrierRed : P.barrierWhite);
      stack.position.set(x, 0, z);
      stack.rotation.y = furnNext() * Math.PI * 2;
      statics.add(stack);
      avoid.push({ x, z, r: 1.8 });
      stackIdx++;
    }
  }

  // lamp posts every LAMP_SPACING_M along the circuit, alternating sides
  const lampEvery = s(LAMP_SPACING_M);
  for (let i = LAMP_PHASE; i < n; i += lampEvery) {
    const f = frames[i]!;
    const side = (Math.floor(i / lampEvery) % 2) === 0 ? 1 : -1;
    const lat = side * (w + LAMP_OFF);
    const x = f.cx + f.lx * lat;
    const z = f.cz + f.lz * lat;
    const lamp = buildLamp(matFn);
    lamp.position.set(x, 0, z);
    lamp.rotation.y = Math.atan2(-side * f.lx, -side * f.lz); // arm toward the road
    statics.add(lamp);
    avoid.push({ x, z, r: 1.5 });
  }

  // billboards on the straightest links: midpoints between well-separated apexes
  // (a parkland circuit never flattens below ~0.11 rad/sample sustained, so an
  // absolute curvature threshold finds nothing — apex midpoints are straightest
  // by construction). The link gate is a DISTANCE: too short is a chicane, too
  // long is a whole sweeper, and both of those are metres, not samples.
  const bbMin = s(BB_LINK_MIN_M);
  const bbMax = s(BB_LINK_MAX_M);
  const links: Array<{ spot: number; gap: number }> = [];
  for (let k = 0; k < apexes.length; k++) {
    const a = apexes[k]!;
    const b = apexes[(k + 1) % apexes.length]!;
    const gap = (b.index - a.index + n) % n;
    if (gap === 0) continue; // a lone apex links only to itself
    links.push({ spot: (a.index + Math.floor(gap / 2)) % n, gap });
  }
  let bbSpots = links.filter((l) => l.gap >= bbMin && l.gap <= bbMax).map((l) => l.spot);
  if (bbSpots.length === 0) {
    // FALLBACK — a circuit whose corners are all chicanes (or a near-circular
    // one with no apex at all) would otherwise get NO billboards. Take the
    // longest links regardless of the gate; with no links at all, space them
    // evenly round the lap so the trackside is never bare.
    bbSpots =
      links.length > 0
        ? [...links].sort((a, b) => b.gap - a.gap).slice(0, BILLBOARD_COUNT).map((l) => l.spot)
        : Array.from({ length: BILLBOARD_COUNT }, (_, k) => Math.round((k * n) / BILLBOARD_COUNT) % n);
  }
  let bbSide = furnNext() < 0.5 ? 1 : -1;
  for (const spot of bbSpots.slice(0, BILLBOARD_COUNT)) {
    const f = frames[spot]!;
    const lat = bbSide * (w + BILLBOARD_OFF + rngRange(furnNext, 0, 2.5));
    const x = f.cx + f.lx * lat;
    const z = f.cz + f.lz * lat;
    const bb = buildBillboard(matFn, bbSpots.indexOf(spot));
    bb.position.set(x, 0, z);
    bb.rotation.y = Math.atan2(f.cx - x, f.cz - z); // face the centerline
    statics.add(bb);
    avoid.push({ x, z, r: 3.5 });
    bbSide = -bbSide;
  }

  // pit building on the infield side of the start straight + its cone row.
  // The anchor is PIT_BEFORE_LINE_M of road BACK from the start line, so the
  // pits land on the approach to the line on every circuit; it used to be the
  // literal sample 238, which is only "just before the line" on Greenvale.
  const pf = frames[(g0i - s(PIT_BEFORE_LINE_M) + n) % n]!;
  // toward the loop interior — measured against the TRACK centre, not the world
  // origin (a circuit centred at [400, -200] would put its pits in a field)
  const pitSide = ((world.cx - pf.cx) * pf.lx + (world.cz - pf.cz) * pf.lz) >= 0 ? 1 : -1;
  const pitLat = pitSide * (w + 13);
  const pitX = pf.cx + pf.lx * pitLat;
  const pitZ = pf.cz + pf.lz * pitLat;
  const pit = buildPitBuilding(matFn);
  pit.position.set(pitX, 0, pitZ);
  pit.rotation.y = Math.atan2(pf.cx - pitX, pf.cz - pitZ); // face the track
  statics.add(pit);
  avoid.push({ x: pitX, z: pitZ, r: 11 });

  // cones: pit-lane edge running up to the start line + a rank in front of the
  // garage. The row walks BACK from gate 0 in metres (Greenvale: k = 34 down to
  // 4 in steps of 3 => samples 222, 225, … 252, exactly the old literal loop).
  const coneStep = s(CONE_ROW_STEP_M);
  for (let k = s(CONE_ROW_FROM_M); k >= s(CONE_ROW_TO_M); k -= coneStep) {
    const f = frames[(g0i - k + n) % n]!;
    const lat = pitSide * (w + 1.55);
    statics.add(at(buildCone(matFn), f.cx + f.lx * lat, 0, f.cz + f.lz * lat));
  }
  for (let c = 0; c < 5; c++) {
    const fx = pitX + Math.sin(pit.rotation.y) * 4.2 + (c - 2) * 1.4 * Math.cos(pit.rotation.y);
    const fz = pitZ + Math.cos(pit.rotation.y) * 4.2 - (c - 2) * 1.4 * Math.sin(pit.rotation.y);
    statics.add(at(buildCone(matFn), fx, 0, fz));
  }

  // grandstand on the start straight, on the side away from any straight-side
  // billboard (completes the start-zone vignette: gantry + lights + stand + pit)
  // (anchored STAND_AFTER_LINE_M past gate 0 — mid start straight on any
  // circuit; it used to be the literal sample 14)
  const sf = frames[(g0i + s(STAND_AFTER_LINE_M)) % n]!;
  // prefer the OUTSIDE of the loop — again relative to the track centre
  let standSide = ((world.cx - sf.cx) * sf.lx + (world.cz - sf.cz) * sf.lz) >= 0 ? -1 : 1;
  for (const zn of avoid) {
    // a billboard keep-clear disc near the anchor on our side => flip
    const dAnchor = Math.hypot(zn.x - sf.cx, zn.z - sf.cz);
    if (dAnchor > 40) continue;
    const latSign = (zn.x - sf.cx) * sf.lx + (zn.z - sf.cz) * sf.lz >= 0 ? 1 : -1;
    if (latSign === standSide && zn.r >= 3) standSide = -standSide;
  }
  const standLat = standSide * (w + STAND_OFF);
  const standX = sf.cx + sf.lx * standLat;
  const standZ = sf.cz + sf.lz * standLat;
  const stand = buildGrandstand(matFn, furnNext);
  stand.position.set(standX, 0, standZ);
  stand.rotation.y = Math.atan2(sf.cx - standX, sf.cz - standZ); // face the track
  statics.add(stand);
  avoid.push({ x: standX, z: standZ, r: 12 });

  // brake boards: 3-2-1 markers on the outside of each corner approach, at
  // BRAKE_BOARD_M metres before the apex (a 3-board is a braking distance, not
  // a sample count). No apexes => no boards, which is fine.
  const brakeDists = BRAKE_BOARD_M.map(s);
  for (const apex of apexes.slice(0, 8)) {
    const outSide = -apex.side;
    for (let b = 0; b < brakeDists.length; b++) {
      const i = (apex.index - brakeDists[b]! + n) % n;
      const f = frames[i]!;
      const lat = outSide * (w + BOARD_OFF);
      const x = f.cx + f.lx * lat;
      const z = f.cz + f.lz * lat;
      const board = buildBrakeBoard(matFn, String(3 - b));
      board.position.set(x, 0, z);
      const [tx, tz] = frameTangent(f);
      board.rotation.y = Math.atan2(-tx, -tz); // face the approaching traffic
      statics.add(board);
      avoid.push({ x, z, r: 1.2 });
    }
  }

  ph('furniture');
  // ground scatter: low flowers/bushes/pebbles along both track edges (baked,
  // non-collidable — everything sits outside the kart's max reach of ~6.2m)
  const gsNext = rng(decoSeed(seed, 17));
  const FLOWERS = [P.kartYellow, P.kartRed, P.curbWhite, P.kartPink];
  for (let i = 0; i < n; i += 2) {
    for (const side of [1, -1]) {
      if (gsNext() < 0.55) continue;
      const f = frames[i]!;
      const lat = side * (w + rngRange(gsNext, 2.6, 8.5));
      const x = f.cx + f.lx * lat + rngRange(gsNext, -0.6, 0.6);
      const z = f.cz + f.lz * lat + rngRange(gsNext, -0.6, 0.6);
      if (inAvoid(x, z, avoid)) continue;
      const pick = gsNext();
      if (pick < 0.45) {
        // flower tuft: dark stem cube + palette bloom cube
        const fl = new THREE.Group();
        fl.add(at(sbox(matFn, 0.26, PAD_H, 0.26, P.grassDeep), 0, PAD_H / 2, 0));
        fl.add(at(sbox(matFn, 0.07, 0.22, 0.07, P.grassDark), 0, 0.13, 0));
        fl.add(at(sbox(matFn, 0.17, 0.12, 0.17, FLOWERS[rngInt(gsNext, 0, FLOWERS.length - 1)]!), 0, 0.29, 0));
        fl.position.set(x, 0, z);
        statics.add(fl);
      } else if (pick < 0.8) {
        // low bush: squashed leaf-tone blob over its own deep underside
        const bg = new THREE.Group();
        const br = rngRange(gsNext, 0.28, 0.55);
        const sx = rngRange(gsNext, 0.9, 1.3);
        const sz = rngRange(gsNext, 0.9, 1.3);
        const skirt = ssphere(matFn, br * 1.06, 6, P.treeLeafDeep);
        skirt.scale.set(sx, 0.34, sz);
        bg.add(at(skirt, 0, 0.08, 0));
        const bush = ssphere(matFn, br, 6, leafTone(gsNext));
        bush.scale.set(sx, rngRange(gsNext, 0.5, 0.7), sz);
        bg.add(at(bush, 0, 0.21, 0));
        bg.rotation.y = gsNext() * Math.PI;
        bg.position.set(x, 0, z);
        statics.add(bg);
      } else {
        // pebble: small squashed rock
        const r = rngRange(gsNext, 0.14, 0.3);
        const pebble = ssphere(matFn, r, 5, P.rock);
        pebble.scale.set(rngRange(gsNext, 0.9, 1.3), 0.55, rngRange(gsNext, 0.9, 1.3));
        pebble.position.set(x, r * 0.3, z);
        statics.add(pebble);
      }
    }
  }

  ph('groundScatter');
  // seeded scatter: CLUSTERED trees (bare gaps between groves) + sparse rocks,
  // never on the road (|lateral| > halfW + 4). The rect is centred on the
  // CIRCUIT and its counts scale with the apron area, so a big circuit is not
  // decorated with Greenvale's worth of trees stretched thin (or, worse, with
  // trees dropped around the world origin somewhere off in the distance).
  const next = rng(decoSeed(seed, 0));
  const treeCount = scaled(TREE_COUNT, world.density);
  const rockCount = scaled(ROCK_COUNT, world.density);
  const clusterCount = scaled(CLUSTER_COUNT, world.density);
  const scatX = (): number => rngRange(next, world.cx - world.scatterX, world.cx + world.scatterX);
  const scatZ = (): number => rngRange(next, world.cz - world.scatterZ, world.cz + world.scatterZ);
  let trees = 0;
  const clusters: Array<{ x: number; z: number }> = [];
  for (
    let attempt = 0;
    attempt < clusterCount * 30 && clusters.length < clusterCount && trees < treeCount;
    attempt++
  ) {
    const cx = scatX();
    const cz = scatZ();
    if (absLateral(cx, cz) <= w + 6) continue;
    if (inAvoid(cx, cz, avoid)) continue;
    let clusterClash = false;
    for (const cl of clusters) {
      const dx = cl.x - cx;
      const dz = cl.z - cz;
      if (dx * dx + dz * dz < CLUSTER_SPACING * CLUSTER_SPACING) {
        clusterClash = true;
        break;
      }
    }
    if (clusterClash) continue;
    clusters.push({ x: cx, z: cz });
    const inCluster = Math.min(rngInt(next, 3, 10), treeCount - trees);
    for (let t = 0; t < inCluster; t++) {
      const ang = next() * Math.PI * 2;
      const rr = rngRange(next, 1.5, CLUSTER_R) * (0.5 + next()); // uneven grove density
      const x = cx + Math.cos(ang) * rr;
      const z = cz + Math.sin(ang) * rr;
      if (absLateral(x, z) <= w + PROP_CLEARANCE) continue;
      if (inAvoid(x, z, avoid)) continue;
      const tree = buildAnyTree(matFn, next);
      tree.position.set(x, 0, z);
      statics.add(tree);
      trees++;
    }
  }
  // top-up: a few lone stragglers if the groves undershot the count
  const placed = new SpacedPoints(PROP_SPACING);
  for (let attempt = 0; attempt < treeCount * 30 && trees < treeCount; attempt++) {
    const x = scatX();
    const z = scatZ();
    if (absLateral(x, z) <= w + PROP_CLEARANCE) continue;
    if (placed.has(x, z)) continue;
    if (inAvoid(x, z, avoid)) continue;
    placed.add(x, z);
    const tree = buildAnyTree(matFn, next);
    tree.position.set(x, 0, z);
    statics.add(tree);
    trees++;
  }
  // rocks: sparse and even, contrast with the clustered trees
  let rocks = 0;
  for (let attempt = 0; attempt < rockCount * 30 && rocks < rockCount; attempt++) {
    const x = scatX();
    const z = scatZ();
    if (absLateral(x, z) <= w + PROP_CLEARANCE) continue;
    if (placed.has(x, z)) continue;
    if (inAvoid(x, z, avoid)) continue;
    placed.add(x, z);
    const rock = buildRock(matFn, next);
    rock.position.set(x, 0, z);
    statics.add(rock);
    rocks++;
  }

  ph('scatterTreesRocks');
  // tree line: a mid-distance band of trees ringing the CIRCUIT (not the world
  // origin), just outside its bounding radius and well inside the near ridge
  const lineNext = rng(decoSeed(seed, 14));
  const lineCount = scaled(TREELINE_COUNT, world.density);
  let lineTrees = 0;
  const linePlaced = new SpacedPoints(PROP_SPACING);
  for (let attempt = 0; attempt < lineCount * 20 && lineTrees < lineCount; attempt++) {
    const ang = lineNext() * Math.PI * 2;
    const r = rngRange(lineNext, world.treelineMin, world.treelineMax);
    const x = world.cx + Math.cos(ang) * r;
    const z = world.cz + Math.sin(ang) * r * TREELINE_SQUASH; // slight ellipse, never a clean circle
    if (absLateral(x, z) <= w + 6) continue;
    if (linePlaced.has(x, z)) continue;
    if (inAvoid(x, z, avoid)) continue;
    linePlaced.add(x, z);
    const tree = buildAnyTree(matFn, lineNext);
    tree.position.set(x, 0, z);
    statics.add(tree);
    lineTrees++;
  }

  ph('treeline');
  // horizon: THREE ridgeline layers on a distance ladder — a dark green near
  // ridge, a ridgeNear->ridgeFar mid ridge, and a tall far ridge faded toward
  // the fog with mix() (the one sanctioned use: atmospheric perspective, §0.7).
  // Vertex-color gradients + fog do the depth; no cone hills.
  // (the three radii are margins outward from the circuit's bounding radius, so
  // a wide circuit is never built INSIDE its own horizon)
  const ridgeNext = rng(decoSeed(seed, 15));
  const ridgeFar = new THREE.Mesh(
    ridgelineGeometry(
      world.cx,
      world.cz,
      world.ridgeFarR,
      RIDGE_FAR_PEAK,
      ridgeNext,
      P.ridgeFar,
      mix(P.ridgeFar, P.fog, 0.55),
    ),
    vertexPaintMaterial(),
  );
  root.add(ridgeFar);
  const ridgeMid = new THREE.Mesh(
    ridgelineGeometry(world.cx, world.cz, world.ridgeMidR, RIDGE_MID_PEAK, ridgeNext, P.ridgeNear, P.ridgeFar),
    vertexPaintMaterial(),
  );
  root.add(ridgeMid);
  const ridgeNear = new THREE.Mesh(
    ridgelineGeometry(world.cx, world.cz, world.ridgeNearR, RIDGE_NEAR_PEAK, ridgeNext, P.grassDeep, P.ridgeNear),
    vertexPaintMaterial(),
  );
  root.add(ridgeNear);

  ph('ridgelines');
  root.add(bake(statics)); // one merged mesh per material, shadows on
  ph('bake');
  return root;
}
