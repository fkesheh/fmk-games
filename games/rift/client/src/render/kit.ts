// ============================================================================
// ANCIENTS (rift) — THE FROZEN RENDER KIT (GRAPHICS_CONTRACT §2, Layer-1).
//
// This file is the shared visual vocabulary of the game. Six independent art
// agents import it and nothing else, and it is what makes their output look
// like ONE art-directed game instead of six. It is authored before fan-out and
// frozen: nobody edits it, nobody reimplements any of it, and nobody adds a
// second path to anything it provides.
//
// THE FIVE LAWS THIS FILE ENFORCES (read these before using anything below):
//
//  1. MATERIAL LAW. `surface()` / `emissiveSurface()` are the ONLY material
//     constructors in the codebase. `new THREE.Mesh*Material(...)` in an
//     implementer file is a contract violation. Everything is
//     MeshStandardMaterial, built from the frozen SURFACES table in
//     @rift/shared, cached per (id, tint, emissive) so identical surfaces share
//     ONE instance and bucket into ONE draw call. That sharing is also why
//     `transparent`, `opacity`, `depthWrite`, `blending` and `polygonOffset`
//     are NOT call-site dials: mutating a cached material reaches every other
//     consumer of the family. A family that needs different blend state is a
//     different family in the table (AMENDMENT_3 §C added three).
//
//  2. VERTEX-COLOUR LAW. Every material here has `vertexColors: true`,
//     therefore every geometry that reaches the renderer MUST carry a `color`
//     attribute. `bake()` emits one unconditionally — white (1,1,1) where no
//     AO has been baked. `bakeVertexAO()` MULTIPLIES into an existing
//     attribute and never creates one. Any geometry path that does not go
//     through `bake()` (the terrain heightfield, `scatter()` instancing, FX
//     pooled meshes) must write the same default itself: attribute name
//     'color', Float32, itemSize 3, every component 1. Getting this wrong has
//     exactly two failure modes, both seen in practice — baked AO silently
//     does nothing, or every shared-family mesh renders black.
//
//  3. UV LAW. Every kit texture is RepeatWrapping at a fixed convention of
//     1 UV unit = 1 world metre. `bake()` rewrites UVs into world space at
//     that scale, so texel density is uniform across the whole map by
//     construction. NOBODY sets `texture.repeat`, and nobody applies a
//     per-object texture scale.
//
//  4. DETERMINISM LAW. `rng(seed)` is the ONLY source of randomness in the
//     game. `Math.random` anywhere under games/rift/ is a contract violation:
//     the judge loop compares successive rounds of the same shot, and a
//     non-deterministic world makes two rounds incomparable. There is no clock
//     input to any generator here (`bakeChunked` reads a clock to decide HOW
//     MUCH work to do per call, never WHAT work — its output is bit-identical
//     to `bake()`'s regardless of timing; the equivalence is asserted in
//     kit.test.ts).
//
//  5. ASSET LAW. Every pixel is generated in code. No image asset, no
//     TextureLoader, no font file, no network fetch. The bundle stays
//     asset-free.
//
// UV PROJECTION, per family (GRAPHICS_CONTRACT §2 "UV law"), applied by bake():
//
//   planar XZ  groundMoss groundDirt lanePaving cliffRock wetRock riverWater
//              monumentStone canopy fern cloth leather iron bronze gold crystal
//              fxAdditive fxDecal shroud
//   cylindrical bark  (and any part tinted/branched off it — trunk forms)
//   local       any part built with `PartOpts.uvLocal === true` (small props
//               and unit parts, where the primitive's own normalised UVs are
//               the intended layout)
//
//   The planar-XZ projection is applied PER TRIANGLE and carries one mandatory
//   refinement: a face whose normal is predominantly horizontal is projected on
//   the dominant vertical plane (XY or ZY) instead, at the same 1 m scale. A
//   strictly-XZ projection is degenerate on a vertical face — zero-area UVs —
//   and would render the cliff strata normal map as an infinite vertical smear
//   on exactly the surface this build exists to add. The law's promise is
//   uniform texel density; the refinement is what keeps that promise on every
//   face orientation, and up-facing ground/lane geometry (the overwhelming
//   majority of those families' area) still projects on exactly XZ.
//
// HEADLESS: the texture generators need a 2D canvas. Under vitest/CI there is
// no DOM, so they return a correctly-configured but image-less CanvasTexture
// instead of throwing, which keeps `surface()` and `bake()` — and therefore
// every art module's build function — unit-testable. In a browser that branch
// never runs.
//
// Imports reach the two Layer-1 data leaves (`palette`, `surfaces`) DIRECTLY
// rather than through the @rift/shared barrel. The kit is imported by every
// visual module and by headless unit tests, and the barrel drags in map.ts and
// the whole sim-side graph with it; the leaves are pure data and pull in
// nothing. Both paths resolve identically under vite and tsc.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { decoSeed, mix, rng as seededFloats } from '@platform/shared';
import { APAL } from '@rift/shared/palette.js';
import { SURFACES } from '@rift/shared/surfaces.js';
import type { NormalPattern, SurfaceDef, SurfaceId } from '@rift/shared/surfaces.js';

// ---- tuning constants -------------------------------------------------------
// Everything below is art direction transcribed from the contracts. None of it
// is a per-implementer dial: change it here or not at all.

/** Generated texture edge, in pixels. With the UV law (1 UV unit = 1 m) one
 *  texture covers exactly 1 m², so this is also the texel density: 256 px/m,
 *  ~4 mm per texel. "Fine" detail is centimetres (~4 px), "coarse" detail is
 *  decimetres (~26 px), exactly as the NormalPattern doc comments describe. */
const TEX_SIZE = 256;

/** Strength of the tint blend in `surface(id, tint)`, as the `t` of a
 *  @platform/shared `mix()` away from the family's own albedo. It is 1 — a
 *  total mix — deliberately: the tint ladder STYLE_BIBLE §8 requires of every
 *  scattered instance is the palette's own {base, Lit, Deep} triplet, and a
 *  partial blend would collapse those three steps back toward the base and
 *  make the rendered colour unpredictable for twenty-five implementers. The
 *  tint IS the rendered albedo; every other physical parameter (roughness,
 *  metalness, maps, flat shading) still comes from the family. */
const TINT_MIX = 1;

/** Roughness-map centre. A texel can only multiply the authored roughness
 *  DOWN (three multiplies `roughness * texel`), so the family's roughness in
 *  the surface table is its ceiling and the map is a WEAR map — which is the
 *  physically right direction: wear, wet and polish all reduce roughness. */
const ROUGH_CENTRE = 0.9;
/** Peak-to-trough spread of the wear map around ROUGH_CENTRE. */
const ROUGH_SPREAD = 0.22;

/** Vertex-AO: cell edge of the occupancy grid, in metres. Half a metre is the
 *  "contact scale" STYLE_BIBLE §6 asks the screen-space pass to tune to; the
 *  baked half of the AO story works at the same scale so the two agree. */
const AO_CELL = 0.5;
/** Hard ceiling on occupancy-grid cells, so a map-sized bake cannot allocate
 *  an unbounded grid; the cell edge grows instead. */
const AO_MAX_CELLS = 1 << 20;
/** Neighbourhood radius, in cells, sampled for the crowding term. */
const AO_RADIUS = 2;
/** Height (m) over which the contact term fades out above a geometry's floor. */
const AO_CONTACT_H = 0.6;
/** Weights of the two occlusion terms; both are clamped into 0..1 together. */
const AO_CROWD_W = 1.0;
const AO_CONTACT_W = 0.85;

/** STYLE_BIBLE §8 variation law, enforced here so no scattered instance can
 *  opt out of it: scale +/-30%, full 360 deg rotation, lean +/-12 deg, and at
 *  least three colour-tint steps drawn from the family's palette ladder. */
const SCATTER_SCALE_VAR = 0.3;
const SCATTER_LEAN_RAD = (12 * Math.PI) / 180;
const SCATTER_MIN_TINTS = 3;
/** Poisson-disc candidate attempts per active point (Bridson's `k`). */
const SCATTER_TRIES = 24;

/** Bloom is LAYER-masked, never threshold-masked (STYLE_BIBLE §6): a global
 *  luminance threshold cannot separate an emissive crystal from sun-lit metal.
 *  Layer 0 stays enabled on marked objects so they still render in the beauty
 *  pass; the bloom pass renders layer 1 alone. */
export const BLOOM_LAYER = 1;

// ============================================================================
// Types
// ============================================================================

/** A point in world space, in metres. `ribbon()`'s path type. (The shared
 *  `Vec2` is {x, z} — a ground point — and carries no height, which is exactly
 *  what a river bank or a road ribbon needs to vary.) */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A `lathe()` profile point: radius from the Y axis, and height. Deliberately
 *  NOT the shared `Vec2`, which is {x, z} in world space and would silently
 *  mean the wrong thing here (GRAPHICS_CONTRACT §2). */
export interface LatheVec {
  readonly r: number;
  readonly y: number;
}

/** Placement of one primitive, applied by the factory before it returns —
 *  every kit primitive comes back already transformed, so a build is a flat
 *  list of parts with no matrix bookkeeping.
 *
 *  Order of operations, matching the existing house idiom in units.ts:
 *  scale -> rotateX -> rotateZ -> rotateY -> translate. */
export interface PartOpts {
  /** Translation in metres (local to the build's origin). */
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  /** Rotation in radians. */
  readonly rx?: number;
  readonly ry?: number;
  readonly rz?: number;
  /** Non-uniform scale, applied before rotation. */
  readonly sx?: number;
  readonly sy?: number;
  readonly sz?: number;
  /** Keep the primitive's own normalised UVs instead of letting `bake()`
   *  reproject into world space. For small props and unit parts, where the
   *  primitive's layout IS the intended layout (UV law, GRAPHICS_CONTRACT §2).
   *  On anything the size of a wall it produces visible texel-density breaks —
   *  which is the whole reason the world-space projection is the default. */
  readonly uvLocal?: boolean;
}

/** An emissive override on one part or one anim part: the APAL key the glow
 *  takes and the intensity it burns at. Independent of `tint`, which is the
 *  ALBEDO — a team crystal is azure-tinted AND azure-glowing, and collapsing
 *  the two is exactly how the tint got swamped (AMENDMENT_3 §A).
 *
 *  `colorKey` is an APAL key NAME (`'azure'`, `'ember'`, a hero accent), not a
 *  hex — an unknown key falls back to the family's own emissive rather than
 *  throwing, because a builder must never white-screen the game. */
export interface EmissiveSpec {
  readonly colorKey: string;
  readonly intensity: number;
}

/** One piece of a build: a geometry plus the surface family it renders in.
 *
 *  `bake()` CONSUMES its parts — it rewrites their attributes in place and the
 *  caller must not reuse them afterwards. Every kit primitive returns a fresh
 *  geometry, so this costs nothing and saves a full copy of every build. */
export interface Part {
  readonly geo: THREE.BufferGeometry;
  readonly surface: SurfaceId;
  /** Optional albedo override: an APAL entry, or a `mix()`/`composite()` of
   *  two APAL entries. A tint mints its own material, and therefore its own
   *  draw-call bucket — use the family's {base, Lit, Deep} ladder rather than
   *  a continuum, or the bucket count grows without bound. */
  readonly tint?: string;
  /** Optional emissive override (AMENDMENT_3 §A). Present means `bake()` builds
   *  this part's bucket through `emissiveSurface(surface, colorKey, intensity,
   *  tint)` instead of `surface(surface, tint)` — so a glowing part keeps its
   *  team tint, and the bucket carries the right material from the start.
   *
   *  NEVER re-point a baked bucket at a different material afterwards:
   *  `BakedMesh.parts` is readonly, and the workaround that did it discarded
   *  every team tint in the game. Declare it here instead.
   *
   *  A part with an emissive is a bloom input: pass the bucket's mesh (or the
   *  whole `BakedMesh.group`) to `markBloom()`, or it glows without blooming. */
  readonly emissive?: EmissiveSpec;
}

/** One merged bucket of a bake: everything in the build that shares one
 *  material, in one geometry. */
export interface BakedPart {
  readonly geo: THREE.BufferGeometry;
  readonly material: THREE.MeshStandardMaterial;
}

/** The output of `bake()`: one geometry per (surface id, tint, emissive)
 *  triple — each of the three mints its own material and therefore its own
 *  bucket — and a single parent Group holding one Mesh per bucket. Add `group`
 *  to the scene; that is the whole integration.
 *
 *  `parts` is readonly and MEANS it. A bucket arrives carrying the material its
 *  parts asked for; if that is not the material you wanted, say so on the
 *  `Part` (`tint`, `emissive`) rather than re-pointing the bucket after the
 *  fact. Four modules re-pointed, and because the old `emissiveSurface()` took
 *  no tint, all four silently discarded team colour (AMENDMENT_3 §A). */
export interface BakedMesh {
  readonly group: THREE.Group;
  readonly parts: readonly BakedPart[];
}

/** The scheduler returned by `bakeChunked()`.
 *
 *  GRAPHICS_CONTRACT §2 froze `{ step(): boolean }`; `mesh` is the one member
 *  added to it, because a scheduler whose result is unreachable cannot be used
 *  at all. `mesh` is live from the moment `bakeChunked()` returns: its `group`
 *  is empty and fills in as steps complete, so an owner may add it to the
 *  scene immediately and watch the map appear. */
export interface ChunkedBake {
  /** Do up to `budgetMs` of work. Returns false when the bake is finished. */
  step(): boolean;
  /** The bake in progress; complete once `step()` has returned false. */
  readonly mesh: BakedMesh;
}

/** Parameters of a procedural greyscale field. The `pattern` is the surface
 *  table's own `NormalPattern`, so a family's height, normal and roughness
 *  maps all describe the SAME structure — which is what makes a family read as
 *  one material rather than three overlaid noises. */
export interface NoiseOpts {
  readonly pattern: NormalPattern;
  /** Texture edge in pixels. Defaults to 256 (= 1 texture per world metre). */
  readonly size?: number;
  /** Seed for the pattern's internal variation. Defaults to the pattern name,
   *  so every caller asking for `strata` gets the SAME strata. */
  readonly seed?: string | number;
  /** Contrast about mid-grey; 1 is the generator's natural range. */
  readonly contrast?: number;
}

/** One stop of a `gradientTexture()` ramp. `color` must be an APAL entry or a
 *  `mix()`/`composite()` of two APAL entries. */
export interface ColorStop {
  /** Position along the ramp, 0 (top, v=0) to 1 (bottom, v=1). */
  readonly at: number;
  readonly color: string;
}

/** The seeded generator. The ONLY source of randomness in the game. */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Float in [a, b). */
  range(a: number, b: number): number;
  /** One element of a non-empty array. Throws on an empty one — a silent
   *  `undefined` here would surface as a missing prop three modules away. */
  pick<T>(xs: readonly T[]): T;
  /** -1 or +1, with equal probability. */
  sign(): number;
}

/** A Poisson-disc scatter request over one rectangular zone.
 *
 *  Density targets come from STYLE_BIBLE §8 and are quoted per 100 m² of the
 *  relevant zone, which is the unit `density` is expressed in. */
export interface ScatterOpts {
  /** Anything stable and unique to this zone — "rift:jungle:0" and so on.
   *  Two zones sharing a seed produce visibly identical layouts. */
  readonly seed: string | number;
  /** The zone, in world metres. */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** Poisson-disc radius: the minimum centre-to-centre distance in metres
   *  between any two instances. This is what stops the visible clumping a
   *  uniform-random scatter produces. */
  readonly spacing: number;
  /** Instances per 100 m² of zone (STYLE_BIBLE §8). The scatter stops early if
   *  `spacing` cannot physically fit that many — density is a target, spacing
   *  is a guarantee. */
  readonly density: number;
  /** Rejection test: terrain kind, lane clearance, camp clearings, water. A
   *  candidate is only kept when this returns true. */
  readonly accept?: (x: number, z: number) => boolean;
  /** Ground height sampler; becomes the instance's `y`. Defaults to 0. */
  readonly heightAt?: (x: number, z: number) => number;
  /** Centre of the per-instance scale variation. Defaults to 1. */
  readonly scale?: number;
  /** The family's tint ladder — {base, Lit, Deep} from APAL, at least three
   *  steps (STYLE_BIBLE §8). Fewer is rejected: two identical adjacent
   *  instances is a defect a reviewer files, and this is where it is stopped. */
  readonly tints: readonly string[];
  /** Number of distinct archetypes the caller can build; each instance is
   *  assigned one in `variant`. Defaults to 1. */
  readonly archetypes?: number;
  /** Hard ceiling on instance count, for budget safety. */
  readonly max?: number;
}

/** One placed instance. The caller either bakes these into a chunk or feeds
 *  them to an InstancedMesh — both are sanctioned; §5 requires the second for
 *  anything repeated many times. */
export interface InstanceXform {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Uniform scale, already varied +/-30% about `ScatterOpts.scale`. */
  readonly scale: number;
  /** Yaw in radians, full 360. */
  readonly rotY: number;
  /** Lean in radians about X and Z; magnitude never exceeds 12 deg. */
  readonly leanX: number;
  readonly leanZ: number;
  /** One of `ScatterOpts.tints`; pass it straight to `surface(id, tint)`. */
  readonly tint: string;
  /** Archetype index in [0, archetypes). */
  readonly variant: number;
}

/** The one animated carve-out of a unit build: a geometry that does NOT go
 *  through `bake()` (it has to stay a separate object so it can be transformed
 *  every frame), plus everything the renderer needs to give it the right
 *  material and the right bloom state.
 *
 *  It carries its material description rather than a material because the mesh
 *  module and the renderer are different agents: before AMENDMENT_3 §B `anim`
 *  was a bare `BufferGeometry`, three modules smuggled the missing fields
 *  through `geo.userData.rift*`, a fourth did not, and `units.ts` fell back to
 *  picking a material by `animKind` — which is why the ward eye rendered with
 *  the ancient's heart material. Everything the renderer needs is now in the
 *  type, and `userData.rift*` is banned.
 *
 *  BECAUSE `geo` NEVER PASSES THROUGH `bake()`, THE MESH MODULE OWNS THE TWO
 *  THINGS `bake()` WOULD OTHERWISE DO FOR IT:
 *
 *   1. THE VERTEX-COLOUR LAW. Call `whiteVertexColors(geo)` before returning.
 *      Every kit material has `vertexColors: true`; a geometry with no `color`
 *      attribute renders BLACK, and it typechecks perfectly.
 *   2. UV SCALING. `bake()`'s world-space reprojection at 1 UV unit = 1 metre
 *      does not run here. An anim part is a small unit part, so its primitive's
 *      own normalised UVs are normally the intended layout (build it with
 *      `PartOpts.uvLocal`); if it needs the world-space density instead, scale
 *      the UVs in the module. */
export interface AnimPart {
  /** The geometry, already `whiteVertexColors`-ed and UV-scaled by its module. */
  readonly geo: THREE.BufferGeometry;
  /** The surface family it renders in. */
  readonly surfaceId: SurfaceId;
  /** Optional albedo override, same meaning as `Part.tint`. */
  readonly tint?: string;
  /** Optional emissive override, same meaning as `Part.emissive`. Present means
   *  the renderer builds the material through `emissiveSurface(surfaceId,
   *  colorKey, intensity, tint)`. */
  readonly emissive?: EmissiveSpec;
  /** Whether the renderer must pass this part's mesh to `markBloom()`. Not
   *  derived from `emissive`: gold blooms without being emissive (STYLE_BIBLE
   *  §6), and a dim emissive filler may deliberately stay out of the bloom
   *  pass. The module that built the part decides. */
  readonly bloom: boolean;
}

/** The frozen shape every unit builder returns (GRAPHICS_CONTRACT §2). */
export interface UnitBuild {
  /** SurfaceId-bucketed body; `body.group` is what the scene adds. */
  readonly body: BakedMesh;
  /** The one animated carve-out part, unbaked so it can be transformed per
   *  frame, or null when the build is entirely static. */
  readonly anim: AnimPart | null;
  readonly animKind: 'orbit' | 'bob' | 'spin' | null;
  /** Height in metres at which the animated part orbits/bobs/spins. */
  readonly animY: number;
  /** Height in metres at which this unit's HP bar floats. */
  readonly barH: number;
  /** Width in metres of this unit's HP bar. */
  readonly barW: number;
}

// ============================================================================
// Determinism — the only randomness in the game
// ============================================================================

/**
 * Seeded RNG. Deterministic for a given seed, on every machine, in every
 * replay, in every judge round. String seeds are hashed with the shared
 * `decoSeed` FNV-1a; number seeds are used directly. The stream itself is the
 * platform's mulberry32, so kit variation and every other seeded system in the
 * repo draw from the same well-tested generator.
 */
export function rng(seed: string | number): Rng {
  const s = typeof seed === 'number' ? seed >>> 0 : decoSeed(seed, 0);
  const next = seededFloats(s);
  return {
    next,
    range(a, b) {
      return a + next() * (b - a);
    },
    pick<T>(xs: readonly T[]): T {
      if (xs.length === 0) throw new Error('rift kit: rng.pick on an empty array');
      const i = Math.min(xs.length - 1, Math.floor(next() * xs.length));
      const chosen = xs[i];
      if (chosen === undefined) throw new Error('rift kit: rng.pick found a hole');
      return chosen;
    },
    sign() {
      return next() < 0.5 ? -1 : 1;
    },
  };
}

// ============================================================================
// Procedural textures — generated in code, cached, called at bake time
// ============================================================================

/** A drawable surface, or null where the platform has no 2D canvas. */
interface Surface2D {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
}

/** Allocate a 2D drawing surface, or null when there is none — a headless test
 *  run, or (in a browser) a context allocation the UA refused. Callers degrade
 *  to a blank texture rather than throwing: a builder must never white-screen
 *  the game (GRAPHICS_CONTRACT §7.7). */
function surface2d(w: number, h: number): Surface2D | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  return { canvas, ctx };
}

/** Apply the UV law to a freshly generated data texture (normal/roughness/
 *  height): tiling in both axes, non-colour data, no `repeat` — ever. */
function asDataTexture(tex: THREE.CanvasTexture): THREE.CanvasTexture {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---- tileable field generators ----------------------------------------------
// Every generator below wraps on integer cell counts, so a texture tiles
// seamlessly at the 1 m UV boundary. A visible tile seam every metre would be
// the single most damning artefact in a game whose whole ground is one family.

/** A value-noise lattice with independent cell counts per axis (the anisotropy
 *  is what makes vertical bark ridges and horizontal brushed scratches out of
 *  the same code). Values are random in [0,1) and wrap on both axes. */
interface Lattice {
  readonly cx: number;
  readonly cy: number;
  readonly v: Float32Array;
}

function lattice(r: Rng, cx: number, cy: number): Lattice {
  const v = new Float32Array(cx * cy);
  for (let i = 0; i < v.length; i++) v[i] = r.next();
  return { cx, cy, v };
}

/** Hermite smoothstep — the interpolation that keeps value noise from showing
 *  its lattice as diamond creases. */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function latAt(l: Lattice, x: number, y: number): number {
  const ix = ((x % l.cx) + l.cx) % l.cx;
  const iy = ((y % l.cy) + l.cy) % l.cy;
  return l.v[iy * l.cx + ix] ?? 0;
}

/** Sample a lattice at (u, v) in 0..1, bilinear with smoothstep weights. */
function sampleLattice(l: Lattice, u: number, v: number): number {
  const fx = u * l.cx;
  const fy = v * l.cy;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = smooth(fx - x0);
  const ty = smooth(fy - y0);
  const a = latAt(l, x0, y0);
  const b = latAt(l, x0 + 1, y0);
  const c = latAt(l, x0, y0 + 1);
  const d = latAt(l, x0 + 1, y0 + 1);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Fractional Brownian motion over `n` octaves, each doubling the cell count
 *  and halving the amplitude. Returns a normalised 0..1 field sampler. */
interface Fbm {
  readonly layers: readonly Lattice[];
  readonly amps: readonly number[];
  readonly norm: number;
}

function makeFbm(r: Rng, cx: number, cy: number, octaves: number): Fbm {
  const layers: Lattice[] = [];
  const amps: number[] = [];
  let amp = 1;
  let total = 0;
  for (let i = 0; i < octaves; i++) {
    layers.push(lattice(r, Math.max(1, cx << i), Math.max(1, cy << i)));
    amps.push(amp);
    total += amp;
    amp *= 0.5;
  }
  return { layers, amps, norm: total > 0 ? 1 / total : 1 };
}

function sampleFbm(f: Fbm, u: number, v: number): number {
  let sum = 0;
  for (let i = 0; i < f.layers.length; i++) {
    const l = f.layers[i];
    const a = f.amps[i];
    if (l === undefined || a === undefined) continue;
    sum += sampleLattice(l, u, v) * a;
  }
  return sum * f.norm;
}

/** A jittered feature-point grid, wrapped — the basis of the cellular
 *  (pebble / dimple) patterns. Two floats per cell: the point's offset inside
 *  its own cell. */
function featureGrid(r: Rng, cells: number): Float32Array {
  const g = new Float32Array(cells * cells * 2);
  for (let i = 0; i < g.length; i++) g[i] = r.next();
  return g;
}

/** Distance from (u,v) to the nearest feature point, normalised so ~1 is the
 *  far corner between four cells. Searches the 3x3 wrapped neighbourhood. */
function worley(g: Float32Array, cells: number, u: number, v: number): number {
  const fx = u * cells;
  const fy = v * cells;
  const cx = Math.floor(fx);
  const cy = Math.floor(fy);
  let best = 4;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox;
      const gy = cy + oy;
      const wx = ((gx % cells) + cells) % cells;
      const wy = ((gy % cells) + cells) % cells;
      const base = (wy * cells + wx) * 2;
      const px = gx + (g[base] ?? 0.5);
      const py = gy + (g[base + 1] ?? 0.5);
      const dx = px - fx;
      const dy = py - fy;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
  }
  return Math.min(1, Math.sqrt(best) * 1.4);
}

/** Deterministic 0..1 hash of two small integers — per-slab and per-band
 *  variation that needs no lattice. */
function hash2(a: number, b: number): number {
  let h = Math.imul(a + 0x9e37, 0x85eb) ^ Math.imul(b + 0x2f1b, 0xc2b2);
  h = Math.imul(h ^ (h >>> 13), 0x27d4);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The greyscale HEIGHT field for one surface family's structural pattern, in
 * 0..1, `size` x `size`, tiling seamlessly. This is the single source of every
 * generated map: the normal map is its gradient, the roughness map is its wear
 * curve. One structure per family, described three ways.
 */
function heightField(pattern: NormalPattern, size: number, r: Rng, contrast: number): Float32Array {
  const out = new Float32Array(size * size);
  const inv = 1 / size;

  // Pattern state is built once, outside the pixel loop: a lattice per octave,
  // a feature grid for the cellular patterns.
  const fine = makeFbm(r, 12, 12, 3);
  const coarse = makeFbm(r, 5, 5, 3);
  const broad = makeFbm(r, 3, 3, 2);
  const warp = makeFbm(r, 6, 6, 2);
  const streak = lattice(r, 2, 96);
  const ridge = lattice(r, 24, 3);
  const pebbles = featureGrid(r, 12);
  const dimples = featureGrid(r, 8);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv;
      let h: number;
      switch (pattern) {
        case 'fineNoise':
          // Dense isotropic grain — damp moss, silt. Centimetre scale.
          h = sampleFbm(fine, u, v);
          break;
        case 'coarseNoise':
          // Chunky isotropic grain — churned earth, gravel. Decimetre scale.
          h = 0.5 + (sampleFbm(coarse, u, v) - 0.5) * 1.35;
          break;
        case 'slabSeam': {
          // A rectilinear lattice of recessed joints between worn flagstones,
          // courses offset row to row so the seams never line up into a grid.
          const rows = 4;
          const cols = 3;
          const row = Math.floor(v * rows);
          const cu = u * cols + (row % 2) * 0.5;
          const col = Math.floor(cu);
          const fu = cu - col;
          const fv = v * rows - row;
          const edge = Math.min(fu, 1 - fu, fv, 1 - fv);
          const joint = 0.055;
          h =
            edge < joint
              ? 0.24 + (edge / joint) * 0.42
              : 0.82 + hash2(col, row) * 0.14 - sampleFbm(fine, u, v) * 0.1;
          break;
        }
        case 'strata': {
          // Horizontal bedding planes with hard breaks — a sedimentary face.
          // The band boundary is warped by low-frequency noise so the beds are
          // geological rather than ruled.
          const bands = 7;
          const warped = v + (sampleFbm(warp, u, v) - 0.5) * 0.14;
          const band = Math.floor(warped * bands);
          const within = warped * bands - band;
          const level = 0.35 + hash2(band, 17) * 0.5;
          // Each bed is undercut at its base — that hard break is what makes
          // a cliff read as strata rather than as noise.
          h = level - (within < 0.16 ? 0.22 : 0) + (sampleFbm(fine, u, v) - 0.5) * 0.16;
          break;
        }
        case 'barkStrata': {
          // Vertical fibrous ridges running up a trunk: the ridge phase is
          // pushed around by a lattice so no two ridges are parallel for long.
          const phase = u * 12 * Math.PI * 2 + sampleLattice(ridge, u, v) * 4.2;
          h = 0.5 + 0.32 * Math.cos(phase) + (sampleFbm(fine, u, v) - 0.5) * 0.38;
          break;
        }
        case 'ripple': {
          // Low-frequency directional waves — the only pattern the renderer
          // scrolls (the river). Integer frequencies keep it tiling.
          h =
            0.5 +
            0.22 * Math.sin(2 * Math.PI * (u * 3 + v)) +
            0.14 * Math.sin(2 * Math.PI * (u - v * 4) + 1.7) +
            0.08 * Math.sin(2 * Math.PI * (u * 5 + v * 2) + 0.9);
          break;
        }
        case 'carved': {
          // Tooled relief: quantised chisel facets, cut through by incised
          // channels on a coarse grid (the glyph courses of a monument).
          const facets = Math.round(sampleFbm(coarse, u, v) * 5) / 5;
          const chan = Math.min(
            Math.abs(((u * 4) % 1) - 0.5),
            Math.abs(((v * 4) % 1) - 0.5),
          );
          h = 0.55 + facets * 0.4 - (chan > 0.44 ? 0.34 : 0);
          break;
        }
        case 'soft':
          // Broad rounded undulation for leaf and frond masses: volume at
          // gameplay zoom, never per-leaf detail.
          h = 0.5 + (sampleFbm(broad, u, v) - 0.5) * 0.62;
          break;
        case 'weave': {
          // Crossed warp and weft, alternating over and under.
          const threads = 24;
          const cu = u * threads;
          const cv = v * threads;
          const over = (Math.floor(cu) + Math.floor(cv)) % 2 === 0;
          h = over
            ? 0.34 + 0.6 * (0.5 + 0.5 * Math.sin(cu * Math.PI * 2))
            : 0.34 + 0.6 * (0.5 + 0.5 * Math.sin(cv * Math.PI * 2));
          break;
        }
        case 'grain':
          // Irregular pebbled hide with soft creases.
          h = 0.32 + worley(pebbles, 12, u, v) * 0.5 + (sampleFbm(fine, u, v) - 0.5) * 0.3;
          break;
        case 'brushed':
          // Fine unidirectional scratches — machined or whetted metal. The
          // 2 x 96 lattice is the anisotropy: near-constant along u, busy
          // along v, so the scratches run.
          h = 0.5 + (sampleLattice(streak, u, v) - 0.5) * 0.75;
          break;
        case 'hammered': {
          // Shallow overlapping dimples — beaten metal. Concave, so the
          // dimple floors are the dark end.
          const d = worley(dimples, 8, u, v);
          h = 0.42 + Math.min(1, d * 2.1) * 0.5;
          break;
        }
        case 'polished':
          // Near-flat with only faint wear; a strong normal on a glossy
          // surface boils the specular highlight as the camera pans.
          h = 0.5 + (sampleFbm(fine, u, v) - 0.5) * 0.16;
          break;
      }
      const c = 0.5 + (h - 0.5) * contrast;
      out[y * size + x] = c < 0 ? 0 : c > 1 ? 1 : c;
    }
  }
  return out;
}

// ---- the four public generators ---------------------------------------------

const noiseCache = new Map<string, THREE.CanvasTexture>();
const normalCache = new Map<string, THREE.CanvasTexture>();
const roughCache = new Map<string, THREE.CanvasTexture>();
const gradientCache = new Map<string, THREE.CanvasTexture>();

/** The float height field behind each generated noise texture, kept by texture
 *  uuid so `normalFromHeight` can differentiate the ORIGINAL field instead of
 *  reading 8-bit pixels back off a canvas. Two reasons, both visible on
 *  screen: a canvas readback quantises the height to 1/255 before it is
 *  differentiated, which bands the normal map into terraces on exactly the
 *  low-contrast families (`polished`, `soft`) that can least afford it; and
 *  `getImageData` is a synchronous GPU-side readback in the middle of the
 *  cold-load budget. */
const fieldCache = new Map<string, { readonly size: number; readonly data: Float32Array }>();

function noiseKey(o: NoiseOpts): string {
  return `${o.pattern}|${o.size ?? TEX_SIZE}|${String(o.seed ?? o.pattern)}|${o.contrast ?? 1}`;
}

/**
 * The family's structural height field as a tiling greyscale texture. Cached
 * per (pattern, size, seed, contrast): two families asking for `fineNoise`
 * share one texture and therefore one GPU upload.
 *
 * Called at BAKE TIME, never per frame — generation is a full pixel loop.
 */
export function noiseTexture(opts: NoiseOpts): THREE.CanvasTexture {
  const key = noiseKey(opts);
  const hit = noiseCache.get(key);
  if (hit) return hit;

  const size = opts.size ?? TEX_SIZE;
  const field = heightField(
    opts.pattern,
    size,
    rng(opts.seed ?? `rift:${opts.pattern}`),
    opts.contrast ?? 1,
  );
  const s2d = surface2d(size, size);
  let tex: THREE.CanvasTexture;
  if (s2d === null) {
    tex = asDataTexture(new THREE.CanvasTexture());
  } else {
    const img = s2d.ctx.createImageData(size, size);
    const px = img.data;
    for (let i = 0; i < size * size; i++) {
      const g = Math.round((field[i] ?? 0.5) * 255);
      px[i * 4] = g;
      px[i * 4 + 1] = g;
      px[i * 4 + 2] = g;
      px[i * 4 + 3] = 255;
    }
    s2d.ctx.putImageData(img, 0, 0);
    tex = asDataTexture(new THREE.CanvasTexture(s2d.canvas));
  }
  fieldCache.set(tex.uuid, { size, data: field });
  noiseCache.set(key, tex);
  return tex;
}

/**
 * Tangent-space normal map from a greyscale height texture, by central
 * difference (a 3x3 Sobel would blur the hard bedding breaks `strata` depends
 * on). `scale` is the relief multiplier: 1 is the generator's natural depth,
 * and the per-family exaggeration lives in `material.normalScale` instead
 * (SURFACES[id].normal.strength), so one shared normal map serves every
 * family that wants the same structure at a different depth.
 *
 * Cached per (source texture, scale).
 */
export function normalFromHeight(height: THREE.CanvasTexture, scale: number): THREE.CanvasTexture {
  const key = `${height.uuid}|${scale}`;
  const hit = normalCache.get(key);
  if (hit) return hit;

  const src = fieldCache.get(height.uuid);
  if (src === undefined) {
    // A texture this module did not generate has no field behind it. Rather
    // than read pixels back off a canvas we may not even be able to touch, hand
    // back a flat normal map: a surface with no relief, never a crash.
    const flat = asDataTexture(new THREE.CanvasTexture());
    normalCache.set(key, flat);
    return flat;
  }
  const size = src.size;
  const data = src.data;
  const h = (x: number, y: number): number => {
    const wx = ((x % size) + size) % size;
    const wy = ((y % size) + size) % size;
    return data[wy * size + wx] ?? 0.5;
  };

  // One texel is 1/size of a world metre under the UV law, so the central
  // difference below is metres of height per metre of surface — a real slope,
  // which is why the same `scale` reads identically on a 256 px and a 512 px
  // texture. Differentiating the float field rather than an 8-bit readback is
  // what keeps the low-contrast families off a terraced normal map.
  const step = size * 0.5;
  const px = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * step * scale;
      const dy = (h(x, y + 1) - h(x, y - 1)) * step * scale;
      // Normal of the height surface: (-dh/dx, -dh/dy, 1), normalised and
      // packed into 0..1. Green is +Y — the OpenGL convention, which is what
      // MeshStandardMaterial expects.
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      px[i] = Math.round((-dx / len) * 127.5 + 127.5);
      px[i + 1] = Math.round((-dy / len) * 127.5 + 127.5);
      px[i + 2] = Math.round((1 / len) * 127.5 + 127.5);
      px[i + 3] = 255;
    }
  }
  const s2d = surface2d(size, size);
  if (s2d === null) {
    const blank = asDataTexture(new THREE.CanvasTexture());
    normalCache.set(key, blank);
    return blank;
  }
  const img = s2d.ctx.createImageData(size, size);
  img.data.set(px);
  s2d.ctx.putImageData(img, 0, 0);
  const tex = asDataTexture(new THREE.CanvasTexture(s2d.canvas));
  normalCache.set(key, tex);
  return tex;
}

/**
 * The family's WEAR map, from the same structural field as its normal map:
 * where the surface is proud it is polished, where it is recessed it is silted
 * and rough. Centred at ROUGH_CENTRE and spread by ROUGH_SPREAD.
 *
 * three multiplies `material.roughness` by this texel, so the map can only
 * make a surface glossier than its authored roughness — physically the right
 * direction (wear, wet and polish all reduce roughness) and the reason the
 * surface table's roughness is a ceiling, not an average.
 */
export function roughnessTexture(opts: NoiseOpts): THREE.CanvasTexture {
  const key = noiseKey(opts);
  const hit = roughCache.get(key);
  if (hit) return hit;

  // Derived from the SAME field as the family's height/normal map — which is
  // the point: a recess must read as both deeper and siltier under one light,
  // and two independently-seeded noises would read as two overlaid materials.
  // It also means the field is generated once per family, not twice.
  const src = fieldCache.get(noiseTexture(opts).uuid);
  const size = src !== undefined ? src.size : opts.size ?? TEX_SIZE;
  const s2d = src !== undefined ? surface2d(size, size) : null;
  if (src === undefined || s2d === null) {
    const blank = asDataTexture(new THREE.CanvasTexture());
    roughCache.set(key, blank);
    return blank;
  }
  const field = src.data;
  const img = s2d.ctx.createImageData(size, size);
  const px = img.data;
  for (let i = 0; i < size * size; i++) {
    // Proud (high) -> polished (low roughness); recessed -> rough.
    const wear = ROUGH_CENTRE - ((field[i] ?? 0.5) - 0.5) * 2 * ROUGH_SPREAD;
    const g = Math.round(Math.max(0, Math.min(1, wear)) * 255);
    px[i * 4] = g;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = g;
    px[i * 4 + 3] = 255;
  }
  s2d.ctx.putImageData(img, 0, 0);
  const tex = asDataTexture(new THREE.CanvasTexture(s2d.canvas));
  roughCache.set(key, tex);
  return tex;
}

/**
 * A vertical colour ramp — sky bands, water depth, fog falloff, banner
 * gradients. Stops run top (v = 0) to bottom (v = 1); every colour must be an
 * APAL entry or a `mix()`/`composite()` of two.
 *
 * The ramp is 4 px wide and 256 px tall: horizontally it tiles trivially
 * (RepeatWrapping, per the UV law), vertically it CLAMPS — wrapping a ramp
 * onto its own opposite end would put a hard colour break across the middle of
 * whatever it is applied to, and the law's purpose (uniform texel density)
 * does not apply to a ramp in the first place.
 */
export function gradientTexture(stops: readonly ColorStop[]): THREE.CanvasTexture {
  if (stops.length === 0) throw new Error('rift kit: gradientTexture needs at least one stop');
  const key = stops.map((s) => `${s.at.toFixed(4)}:${s.color}`).join(',');
  const hit = gradientCache.get(key);
  if (hit) return hit;

  const h = TEX_SIZE;
  const s2d = surface2d(4, h);
  if (s2d === null) {
    const blank = new THREE.CanvasTexture();
    blank.wrapS = THREE.RepeatWrapping;
    blank.wrapT = THREE.ClampToEdgeWrapping;
    blank.colorSpace = THREE.SRGBColorSpace;
    gradientCache.set(key, blank);
    return blank;
  }
  const grad = s2d.ctx.createLinearGradient(0, 0, 0, h);
  for (const s of stops) {
    grad.addColorStop(Math.max(0, Math.min(1, s.at)), s.color);
  }
  s2d.ctx.fillStyle = grad;
  s2d.ctx.fillRect(0, 0, 4, h);
  const tex = new THREE.CanvasTexture(s2d.canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  gradientCache.set(key, tex);
  return tex;
}

// ============================================================================
// Materials — the ONLY construction path in the codebase
// ============================================================================

const matCache = new Map<string, THREE.MeshStandardMaterial>();

/** Resolve an APAL key name to its hex. Unknown keys fall back rather than
 *  throw: a builder must never white-screen the game. Mirrors the existing
 *  `accentHex` idiom in units.ts. */
function apalHex(key: string, fallback: string): string {
  const v = (APAL as unknown as Record<string, string>)[key];
  return v ?? fallback;
}

/** One LENGTH-PREFIXED field of a cache key: `7:#5a8fd6`. */
function keyField(s: string): string {
  return `${s.length}:${s}`;
}

/**
 * The material cache key. It is the FULL identity of a material — surface id,
 * tint and emissive — because `matCache` is global and process-lifetime: two
 * calls that produce the same key get the SAME `MeshStandardMaterial` object,
 * and if the key omits a parameter the second caller silently receives the
 * first caller's colours. Every field that reaches `buildMaterial` or is
 * written onto the result afterwards must appear here.
 *
 * Every variable-length field is LENGTH-PREFIXED rather than joined with a
 * separator, and that is not decoration. `tint` and `colorKey` are free-form
 * `string`s (a tint may be any `mix()`/`composite()` output, and nothing stops
 * a caller passing a literal). Under the old `${id}|${tint}` and
 * `${id}|e|${colorKey}|${intensity}` schemes, a tint that happened to contain
 * the separator could produce a key already owned by a different, visually
 * distinct surface — `surface('crystal', 'e|azure|2.200')` collides with
 * `emissiveSurface('crystal', 'azure', 2.2)`. A length prefix makes the
 * decoding unambiguous, so no combination of field contents can collide.
 *
 * `intensity` is fixed to 3 decimals so 2.2 and 2.2000000000000002 share a
 * material instead of minting two buckets that render identically.
 */
function matKey(id: SurfaceId, tint: string | undefined, em: EmissiveSpec | undefined): string {
  const t = tint === undefined ? '-' : keyField(tint);
  const e = em === undefined ? '-' : `${keyField(em.colorKey)}${em.intensity.toFixed(3)}`;
  return `${keyField(id)}${t}${e}`;
}

/** Everything both material factories share: the vertex-colour law, the
 *  family's physical parameters, and the generated maps. */
function buildMaterial(id: SurfaceId, def: SurfaceDef, albedo: string): THREE.MeshStandardMaterial {
  const offset = def.polygonOffset ?? null;
  const m = new THREE.MeshStandardMaterial({
    color: albedo,
    roughness: def.roughness,
    metalness: def.metalness,
    flatShading: def.flatShading,
    transparent: def.transparent,
    opacity: def.opacity,
    // BLEND AND DEPTH STATE COMES FROM THE TABLE (AMENDMENT_3 §C), never from a
    // call site. `matCache` hands the same instance to every consumer of a
    // family, so a call-site `m.depthWrite = false` silently drags all of them
    // with it — which is why a family that must not occlude declares it here
    // and gets it on every instance by construction. The three defaults below
    // are THREE's own, so every family authored before the amendment renders
    // exactly as it did.
    depthWrite: def.depthWrite ?? true,
    blending: def.blending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
    polygonOffset: offset !== null,
    polygonOffsetFactor: offset?.factor ?? 0,
    polygonOffsetUnits: offset?.units ?? 0,
    // VERTEX-COLOUR LAW: unconditional, on every material, forever. Baked AO
    // rides in the geometry's `color` attribute and would otherwise be
    // silently ignored. It holds on the transparent families too — an additive
    // FX fades by writing its vertex colour, precisely because it may not
    // touch the shared material's opacity.
    vertexColors: true,
  });
  m.name = `rift:${id}`;
  if (def.normal !== null) {
    const height = noiseTexture({ pattern: def.normal.pattern });
    m.normalMap = normalFromHeight(height, 1);
    m.normalScale.set(def.normal.strength, def.normal.strength);
  }
  if (def.roughnessMap) {
    // The wear map describes the SAME structure as the normal map — that is
    // what makes a recess read as both deeper and siltier under one light.
    const pattern: NormalPattern = def.normal?.pattern ?? 'fineNoise';
    m.roughnessMap = roughnessTexture({ pattern });
  }
  if (def.emissive !== null) {
    m.emissive = new THREE.Color(APAL[def.emissive.color]);
    m.emissiveIntensity = def.emissive.intensity;
  }
  // No albedo `map`. A generated albedo texture MULTIPLIES the palette colour,
  // which would move every family off the value-ladder value it was measured
  // at while looking like a tuning problem. Surface variation comes from the
  // normal and wear maps, the baked vertex AO, and the {base, Lit, Deep} tint
  // ladder — all of which leave the ladder intact.
  return m;
}

/**
 * The ONLY way to obtain a material. Cached per (id, tint), so identical
 * surfaces share one instance and bucket into one draw call.
 *
 * `tint` overrides the family's albedo and must be an APAL entry or a
 * `mix()`/`composite()` of two APAL entries — the tint ladder of a family is
 * its {base, Lit, Deep} triplet. Every other property (roughness, metalness,
 * maps, flat shading) comes from the frozen surface table and is not
 * negotiable at the call site.
 */
export function surface(id: SurfaceId, tint?: string): THREE.MeshStandardMaterial {
  const key = matKey(id, tint, undefined);
  const hit = matCache.get(key);
  if (hit) return hit;
  const def = SURFACES[id];
  const albedo = tint === undefined ? APAL[def.albedo] : mix(APAL[def.albedo], tint, TINT_MIX);
  const m = buildMaterial(id, def, albedo);
  matCache.set(key, m);
  return m;
}

/**
 * Emissive variant for crystals, braziers, hearts and FX cores — the ONLY
 * inputs to selective bloom. `colorKey` is an APAL key name (`'azure'`,
 * `'ember'`, a hero accent); `intensity` is written to `emissiveIntensity` and
 * is tuned to be pleasant by day and dominant by night (STYLE_BIBLE §4).
 *
 * Every object built with this MUST be passed to `markBloom()`
 * (GRAPHICS_CONTRACT §7.9): unmarked emissives do not bloom, and the whole
 * night lighting state is emissive geometry acting as the primary light.
 *
 * `tint` is the ALBEDO, on exactly the same terms as `surface(id, tint)`, and
 * is a SEPARATE channel from `colorKey` — glow colour and diffuse colour are
 * two different reads and a team crystal needs both. Without it there was no
 * way to build a tinted glowing part at all: `surface('crystal', teamKey)` has
 * its tint swamped by the family's unconditional `ward` emissive and renders
 * cream, and this factory ignored the tint entirely, so the four mesh modules
 * that routed around the first defect hit the second and shipped a game with
 * no team colour on its primary glow surface (AMENDMENT_3 §A).
 */
export function emissiveSurface(
  id: SurfaceId,
  colorKey: string,
  intensity: number,
  tint?: string,
): THREE.MeshStandardMaterial {
  const key = matKey(id, tint, { colorKey, intensity });
  const hit = matCache.get(key);
  if (hit) return hit;
  const def = SURFACES[id];
  const fallback = def.emissive !== null ? APAL[def.emissive.color] : APAL.ward;
  const albedo = tint === undefined ? APAL[def.albedo] : mix(APAL[def.albedo], tint, TINT_MIX);
  const m = buildMaterial(id, def, albedo);
  m.emissive = new THREE.Color(apalHex(colorKey, fallback));
  m.emissiveIntensity = intensity;
  m.name = tint === undefined ? `rift:${id}:${colorKey}` : `rift:${id}:${colorKey}:${tint}`;
  matCache.set(key, m);
  return m;
}

/** The one place that turns a `Part` / `AnimPart` material description into a
 *  material. `bake()`, `bakeChunked()` and every renderer that mounts an
 *  `AnimPart` go through it, so a tinted emissive resolves identically
 *  everywhere and there is still exactly one construction path. */
export function partMaterial(
  id: SurfaceId,
  tint: string | undefined,
  emissive: EmissiveSpec | undefined,
): THREE.MeshStandardMaterial {
  return emissive === undefined
    ? surface(id, tint)
    : emissiveSurface(id, emissive.colorKey, emissive.intensity, tint);
}

// ============================================================================
// Primitive factories — geometry, already transformed
// ============================================================================
//
// Every primitive returns NON-INDEXED geometry. bake()'s world-space UV
// projection is per triangle and baked AO is per vertex; both need unshared
// vertices, flat-shaded families need them anyway, and it is what makes any
// two parts legal to merge with each other.

/** Apply a PartOpts to a fresh geometry: scale, rotate X/Z/Y, translate — the
 *  same order units.ts has always used, so a build ported into the kit lands
 *  in the same place. */
function shape(geo: THREE.BufferGeometry, o: PartOpts | undefined): THREE.BufferGeometry {
  let g = geo;
  if (g.index !== null) {
    const flat = g.toNonIndexed();
    g.dispose();
    g = flat;
  }
  if (o !== undefined) {
    if (o.sx !== undefined || o.sy !== undefined || o.sz !== undefined) {
      g.scale(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
    }
    if (o.rx !== undefined && o.rx !== 0) g.rotateX(o.rx);
    if (o.rz !== undefined && o.rz !== 0) g.rotateZ(o.rz);
    if (o.ry !== undefined && o.ry !== 0) g.rotateY(o.ry);
    if (o.x !== undefined || o.y !== undefined || o.z !== undefined) {
      g.translate(o.x ?? 0, o.y ?? 0, o.z ?? 0);
    }
    if (o.uvLocal === true) g.userData['uvLocal'] = true;
  }
  return g;
}

/** Axis-aligned box, centred on its own origin. */
export function box(w: number, h: number, d: number, o?: PartOpts): THREE.BufferGeometry {
  return shape(new THREE.BoxGeometry(w, h, d), o);
}

/** Cylinder or truncated cone, centred on its own origin, Y up. */
export function cyl(
  rTop: number,
  rBot: number,
  h: number,
  seg: number,
  o?: PartOpts,
): THREE.BufferGeometry {
  return shape(new THREE.CylinderGeometry(rTop, rBot, h, Math.max(3, Math.floor(seg))), o);
}

/** Cone, centred on its own origin, apex +Y. */
export function cone(r: number, h: number, seg: number, o?: PartOpts): THREE.BufferGeometry {
  return shape(new THREE.ConeGeometry(r, h, Math.max(3, Math.floor(seg))), o);
}

/** UV sphere. `seg` is the equatorial segment count; the ring count is half of
 *  it, which is the aspect that keeps quads roughly square. */
export function sphere(r: number, seg: number, o?: PartOpts): THREE.BufferGeometry {
  const s = Math.max(3, Math.floor(seg));
  return shape(new THREE.SphereGeometry(r, s, Math.max(2, s >> 1)), o);
}

/** Icosphere. `detail` 0 is a 20-face icosahedron (the faceted rock read),
 *  1-2 subdivide toward a sphere. */
export function ico(r: number, detail: number, o?: PartOpts): THREE.BufferGeometry {
  return shape(new THREE.IcosahedronGeometry(r, Math.max(0, Math.floor(detail))), o);
}

/** Capsule, Y up. `len` is the length of the cylindrical middle section, so
 *  the total height is `len + 2r` — limbs, torsos, logs, reeds. */
export function capsule(r: number, len: number, o?: PartOpts): THREE.BufferGeometry {
  return shape(new THREE.CapsuleGeometry(r, len, 6, 12), o);
}

/**
 * Lathe a profile about the Y axis — carved stone, cornices, urns, brazier
 * bowls, mushroom caps. The profile is {r, y} in metres, bottom to top; `r`
 * may be 0 at the ends to close the form into a point.
 *
 * Deliberately NOT the shared Vec2 ({x, z} in world space), which would
 * silently mean the wrong thing (GRAPHICS_CONTRACT §2).
 */
export function lathe(
  profile: readonly LatheVec[],
  seg: number,
  o?: PartOpts,
): THREE.BufferGeometry {
  if (profile.length < 2) {
    throw new Error('rift kit: lathe needs at least 2 profile points');
  }
  const pts = profile.map((p) => new THREE.Vector2(Math.max(0, p.r), p.y));
  return shape(new THREE.LatheGeometry(pts, Math.max(3, Math.floor(seg))), o);
}

/**
 * A flat ribbon of constant width following a world-space path — river
 * surfaces, lane paving, banners, roots, root flares, ability decals.
 *
 * The ribbon is horizontal: it is widened perpendicular to the path in the XZ
 * plane and keeps each point's own `y`, so it drapes over terrain relief
 * without twisting. Joints share their vertices along the averaged direction
 * of the two adjacent segments, so a bend has no gap and no overlap.
 *
 * Its local UVs run in METRES already (u = distance along the path,
 * v = distance across), so `uvLocal: true` on a ribbon is legal and lands at
 * exactly the same texel density as the world projection.
 */
export function ribbon(
  path: readonly Vec3[],
  width: number,
  o?: PartOpts,
): THREE.BufferGeometry {
  if (path.length < 2) throw new Error('rift kit: ribbon needs at least 2 path points');
  const n = path.length;
  const half = width * 0.5;
  // Per-point offset direction: perpendicular in XZ to the averaged tangent.
  const offX = new Float32Array(n);
  const offZ = new Float32Array(n);
  const dist = new Float32Array(n);
  let run = 0;
  for (let i = 0; i < n; i++) {
    const p = path[i];
    const prev = path[i > 0 ? i - 1 : 0];
    const next = path[i < n - 1 ? i + 1 : n - 1];
    if (p === undefined || prev === undefined || next === undefined) continue;
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-6) {
      tx = 1;
      tz = 0;
    } else {
      tx /= tl;
      tz /= tl;
    }
    // Left normal in XZ.
    offX[i] = -tz * half;
    offZ[i] = tx * half;
    if (i > 0) run += Math.hypot(p.x - prev.x, p.z - prev.z);
    dist[i] = run;
  }

  const quads = n - 1;
  const pos = new Float32Array(quads * 6 * 3);
  const nor = new Float32Array(quads * 6 * 3);
  const uv = new Float32Array(quads * 6 * 2);
  let vi = 0;
  for (let i = 0; i < quads; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a === undefined || b === undefined) continue;
    const ax = offX[i] ?? 0;
    const az = offZ[i] ?? 0;
    const bx = offX[i + 1] ?? 0;
    const bz = offZ[i + 1] ?? 0;
    const ua = dist[i] ?? 0;
    const ub = dist[i + 1] ?? 0;
    // Corners: aL, aR, bL, bR. Two triangles, counter-clockwise seen from +Y.
    const corners: readonly [number, number, number, number, number][] = [
      [a.x + ax, a.y, a.z + az, ua, 0],
      [b.x + bx, b.y, b.z + bz, ub, 0],
      [a.x - ax, a.y, a.z - az, ua, width],
      [a.x - ax, a.y, a.z - az, ua, width],
      [b.x + bx, b.y, b.z + bz, ub, 0],
      [b.x - bx, b.y, b.z - bz, ub, width],
    ];
    for (const c of corners) {
      pos[vi * 3] = c[0];
      pos[vi * 3 + 1] = c[1];
      pos[vi * 3 + 2] = c[2];
      nor[vi * 3] = 0;
      nor[vi * 3 + 1] = 1;
      nor[vi * 3 + 2] = 0;
      uv[vi * 2] = c[3];
      uv[vi * 2 + 1] = c[4];
      vi++;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  // Real normals where the path climbs: recomputing is cheaper than tracking
  // the slope per corner and cannot disagree with the triangles.
  g.computeVertexNormals();
  return shape(g, o);
}

// ============================================================================
// Baking
// ============================================================================

/** Which world-space projection a family's UVs are rewritten into (the UV law,
 *  GRAPHICS_CONTRACT §2). Module-private: no implementer chooses a projection,
 *  they choose a family and the projection follows. */
const UV_PROJECTION: Record<SurfaceId, 'planarXZ' | 'cylindrical'> = {
  groundMoss: 'planarXZ',
  groundDirt: 'planarXZ',
  lanePaving: 'planarXZ',
  cliffRock: 'planarXZ',
  wetRock: 'planarXZ',
  riverWater: 'planarXZ',
  monumentStone: 'planarXZ',
  bark: 'cylindrical',
  canopy: 'planarXZ',
  fern: 'planarXZ',
  cloth: 'planarXZ',
  leather: 'planarXZ',
  iron: 'planarXZ',
  bronze: 'planarXZ',
  gold: 'planarXZ',
  crystal: 'planarXZ',
  // The transparent families are flat quads, ground decals and overlay planes —
  // all of them broadly horizontal, all of them wanting the world-space ground
  // projection so a scar's texel density matches the terrain it lies on.
  fxAdditive: 'planarXZ',
  fxDecal: 'planarXZ',
  shroud: 'planarXZ',
};

/** Rewrite one triangle's UVs into world space at 1 UV unit = 1 metre, on the
 *  plane the face most faces. Up-facing geometry lands on exactly XZ; a
 *  vertical face lands on XY or ZY, which is what keeps texel density uniform
 *  instead of degenerate (see the header). */
function projectTriangleXZ(
  pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  uv: Float32Array,
  t: number,
): void {
  const i0 = t * 3;
  const ax = pos.getX(i0);
  const ay = pos.getY(i0);
  const az = pos.getZ(i0);
  const bx = pos.getX(i0 + 1);
  const by = pos.getY(i0 + 1);
  const bz = pos.getZ(i0 + 1);
  const cx = pos.getX(i0 + 2);
  const cy = pos.getY(i0 + 2);
  const cz = pos.getZ(i0 + 2);
  // Face normal by cross product of the two edges.
  const e1x = bx - ax;
  const e1y = by - ay;
  const e1z = bz - az;
  const e2x = cx - ax;
  const e2y = cy - ay;
  const e2z = cz - az;
  const nx = Math.abs(e1y * e2z - e1z * e2y);
  const ny = Math.abs(e1z * e2x - e1x * e2z);
  const nz = Math.abs(e1x * e2y - e1y * e2x);
  let us: readonly [number, number, number];
  let vs: readonly [number, number, number];
  if (ny >= nx && ny >= nz) {
    us = [ax, bx, cx];
    vs = [az, bz, cz];
  } else if (nx >= nz) {
    us = [az, bz, cz];
    vs = [ay, by, cy];
  } else {
    us = [ax, bx, cx];
    vs = [ay, by, cy];
  }
  for (let k = 0; k < 3; k++) {
    uv[(i0 + k) * 2] = us[k] ?? 0;
    uv[(i0 + k) * 2 + 1] = vs[k] ?? 0;
  }
}

/** Cylindrical projection about the part's own vertical axis — trunk forms.
 *  u is arc length in metres (so a fat trunk gets more texture around it, not
 *  a stretched one), v is height. The seam is unwrapped per triangle, so the
 *  triangle that straddles -pi/+pi does not smear the whole texture across
 *  itself. */
function projectTriangleCyl(
  pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  uv: Float32Array,
  t: number,
  cx: number,
  cz: number,
  radius: number,
): void {
  const i0 = t * 3;
  let base = 0;
  for (let k = 0; k < 3; k++) {
    const i = i0 + k;
    let a = Math.atan2(pos.getX(i) - cx, pos.getZ(i) - cz);
    if (k === 0) base = a;
    else {
      // Keep every vertex within half a turn of the first: that is the seam fix.
      while (a - base > Math.PI) a -= Math.PI * 2;
      while (a - base < -Math.PI) a += Math.PI * 2;
    }
    uv[i * 2] = a * radius;
    uv[i * 2 + 1] = pos.getY(i);
  }
}

/** Bring one part's geometry to the exact attribute set every other part will
 *  have — position, normal, uv, color, non-indexed — and rewrite its UVs
 *  per the UV law. Returns the geometry to merge (the input itself, unless it
 *  arrived indexed). */
function normalizePart(part: Part): THREE.BufferGeometry {
  let g = part.geo;
  if (g.index !== null) g = g.toNonIndexed();

  // 1. Nothing but the four attributes a merge is allowed to see. A stray
  //    attribute on one part and not another makes mergeGeometries return null.
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') {
      g.deleteAttribute(name);
    }
  }
  const pos = g.getAttribute('position');
  const count = pos.count;

  // 2. Normals.
  if (g.getAttribute('normal') === undefined) g.computeVertexNormals();

  // 3. UV LAW — world-space rewrite at 1 UV unit = 1 metre, unless the part
  //    asked to keep its own normalised layout.
  if (g.userData['uvLocal'] !== true) {
    const uv = new Float32Array(count * 2);
    const tris = Math.floor(count / 3);
    if (UV_PROJECTION[part.surface] === 'cylindrical') {
      g.computeBoundingBox();
      const bb = g.boundingBox;
      const cx = bb !== null ? (bb.min.x + bb.max.x) * 0.5 : 0;
      const cz = bb !== null ? (bb.min.z + bb.max.z) * 0.5 : 0;
      const radius =
        bb !== null ? Math.max(0.05, (bb.max.x - bb.min.x + (bb.max.z - bb.min.z)) * 0.25) : 1;
      for (let t = 0; t < tris; t++) projectTriangleCyl(pos, uv, t, cx, cz, radius);
    } else {
      for (let t = 0; t < tris; t++) projectTriangleXZ(pos, uv, t);
    }
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  } else if (g.getAttribute('uv') === undefined) {
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }

  // 4. VERTEX-COLOUR LAW — white where no AO has been baked. Unconditional:
  //    every material has vertexColors: true, so a missing attribute renders
  //    the whole bucket black.
  if (g.getAttribute('color') === undefined) {
    const col = new Float32Array(count * 3);
    col.fill(1);
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  }
  return g;
}

/** One merge bucket, keyed by material. */
interface Bucket {
  readonly material: THREE.MeshStandardMaterial;
  readonly geos: THREE.BufferGeometry[];
}

/** A bake bucket is keyed by the MATERIAL its parts resolve to — the same key
 *  `matCache` uses — so buckets and materials stay 1:1 by construction. Two
 *  parts share a draw call exactly when they share a material, and a part with
 *  an emissive gets its own bucket rather than inheriting the plain family's
 *  (AMENDMENT_3 §A). */
function bucketKey(p: Part): string {
  return matKey(p.surface, p.tint, p.emissive);
}

function mergeBucket(key: string, b: Bucket): THREE.BufferGeometry {
  const merged = mergeGeometries(b.geos, false);
  if (merged === null) throw new Error(`rift kit: bake merge failed for surface bucket ${key}`);
  for (const g of b.geos) g.dispose();
  merged.computeBoundingSphere();
  return merged;
}

function bakedMeshOf(geo: THREE.BufferGeometry, material: THREE.MeshStandardMaterial): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Merge parts into ONE geometry per surface id — per (id, tint, emissive)
 * triple, since each of the three mints its own material and therefore its own
 * draw-call bucket. The draw-call budget (GRAPHICS_CONTRACT §5, <= 700) depends
 * on this being used for every static build and every per-unit build.
 *
 * `bake()` CONSUMES its parts: it rewrites their attributes in place and
 * disposes them after the merge. Every kit primitive returns a fresh geometry,
 * so this is free — but do not hand the same geometry to two bakes.
 *
 * Scope discipline (§5): bake per 16x16 m spatial chunk for static world
 * geometry and per unit for unit builds. One map-wide merge is one draw call
 * with zero frustum culling, which is a different failure, not a win.
 */
export function bake(parts: readonly Part[]): BakedMesh {
  const buckets = new Map<string, Bucket>();
  for (const p of parts) {
    const key = bucketKey(p);
    let b = buckets.get(key);
    if (b === undefined) {
      b = { material: partMaterial(p.surface, p.tint, p.emissive), geos: [] };
      buckets.set(key, b);
    }
    b.geos.push(normalizePart(p));
  }
  const group = new THREE.Group();
  group.name = 'rift:baked';
  const out: BakedPart[] = [];
  for (const [key, b] of buckets) {
    if (b.geos.length === 0) continue;
    const geo = mergeBucket(key, b);
    group.add(bakedMeshOf(geo, b.material));
    out.push({ geo, material: b.material });
  }
  return { group, parts: out };
}

/**
 * Bake ambient occlusion into an EXISTING vertex-colour attribute, by
 * multiplication. Applied to all static world geometry; this is the cheap half
 * of the AO story and the screen-space pass in STYLE_BIBLE §6 is the other.
 *
 * It never creates the attribute — `bake()` already emitted one, and a
 * geometry arriving here without one did not come from `bake()`, which is
 * exactly the mistake that makes baked AO silently do nothing.
 *
 * Two terms, both computed from the geometry alone (there is no scene here):
 *   CROWDING  — an occupancy grid at AO_CELL, sampled over the hemisphere
 *               above each vertex's normal. Open ground sees nothing above it
 *               and stays white; a crevice, an overhang or the inside of an
 *               arch sees matter and darkens. This is real ambient occlusion,
 *               at O(triangles + vertices) cost.
 *   CONTACT   — darkening toward the geometry's own floor, weighted by how
 *               little the surface faces up. A flat ground plane is entirely
 *               up-facing and therefore untouched; the SIDE of a rock sitting
 *               on that plane, and the underside of anything, darkens fully.
 *               This is what puts a shadow where a prop meets the ground even
 *               though the ground is in a different material bucket.
 *
 * `strength` in 0..1 scales the whole effect. Returns the same geometry.
 */
export function bakeVertexAO(geo: THREE.BufferGeometry, strength: number): THREE.BufferGeometry {
  const color = geo.getAttribute('color');
  if (color === undefined) {
    throw new Error(
      'rift kit: bakeVertexAO needs an existing color attribute — bake() emits one; ' +
        'this geometry did not come from bake()',
    );
  }
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const count = pos.count;
  if (count === 0 || strength <= 0) return geo;

  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (bb === null) return geo;
  const minX = bb.min.x;
  const minY = bb.min.y;
  const minZ = bb.min.z;
  const spanX = Math.max(1e-3, bb.max.x - minX);
  const spanY = Math.max(1e-3, bb.max.y - minY);
  const spanZ = Math.max(1e-3, bb.max.z - minZ);

  // Grid resolution: AO_CELL, coarsened if the geometry is large enough that
  // the grid would blow the cell ceiling.
  let cell = AO_CELL;
  let nx = Math.ceil(spanX / cell) + 1;
  let ny = Math.ceil(spanY / cell) + 1;
  let nz = Math.ceil(spanZ / cell) + 1;
  while (nx * ny * nz > AO_MAX_CELLS) {
    cell *= 2;
    nx = Math.ceil(spanX / cell) + 1;
    ny = Math.ceil(spanY / cell) + 1;
    nz = Math.ceil(spanZ / cell) + 1;
  }
  const grid = new Uint8Array(nx * ny * nz);
  const cellOf = (x: number, y: number, z: number): number => {
    const ix = Math.min(nx - 1, Math.max(0, Math.floor((x - minX) / cell)));
    const iy = Math.min(ny - 1, Math.max(0, Math.floor((y - minY) / cell)));
    const iz = Math.min(nz - 1, Math.max(0, Math.floor((z - minZ) / cell)));
    return (iy * nz + iz) * nx + ix;
  };
  for (let i = 0; i < count; i++) {
    grid[cellOf(pos.getX(i), pos.getY(i), pos.getZ(i))] = 1;
  }

  // Precompute the sampling offsets once: everything within AO_RADIUS cells,
  // excluding the vertex's own cell, with a 1/distance weight.
  const offs: number[] = [];
  for (let oy = -AO_RADIUS; oy <= AO_RADIUS; oy++) {
    for (let oz = -AO_RADIUS; oz <= AO_RADIUS; oz++) {
      for (let ox = -AO_RADIUS; ox <= AO_RADIUS; ox++) {
        const d2 = ox * ox + oy * oy + oz * oz;
        if (d2 === 0 || d2 > AO_RADIUS * AO_RADIUS) continue;
        offs.push(ox, oy, oz, 1 / Math.sqrt(d2));
      }
    }
  }

  for (let i = 0; i < count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const nxv = nrm !== undefined ? nrm.getX(i) : 0;
    const nyv = nrm !== undefined ? nrm.getY(i) : 1;
    const nzv = nrm !== undefined ? nrm.getZ(i) : 0;
    const ix = Math.min(nx - 1, Math.max(0, Math.floor((px - minX) / cell)));
    const iy = Math.min(ny - 1, Math.max(0, Math.floor((py - minY) / cell)));
    const iz = Math.min(nz - 1, Math.max(0, Math.floor((pz - minZ) / cell)));

    let hit = 0;
    let total = 0;
    for (let k = 0; k < offs.length; k += 4) {
      const ox = offs[k] ?? 0;
      const oy = offs[k + 1] ?? 0;
      const oz = offs[k + 2] ?? 0;
      const w = offs[k + 3] ?? 0;
      // Hemisphere above the surface only: matter BEHIND a face does not
      // occlude it, and counting it would darken every flat plate uniformly.
      if (ox * nxv + oy * nyv + oz * nzv <= 0) continue;
      total += w;
      const gx = ix + ox;
      const gy = iy + oy;
      const gz = iz + oz;
      if (gx < 0 || gy < 0 || gz < 0 || gx >= nx || gy >= ny || gz >= nz) continue;
      if ((grid[(gy * nz + gz) * nx + gx] ?? 0) === 1) hit += w;
    }
    const crowd = total > 0 ? hit / total : 0;
    const upness = Math.max(0, nyv);
    const contact = Math.max(0, 1 - (py - minY) / AO_CONTACT_H) * (1 - upness);
    const occ = Math.min(1, crowd * AO_CROWD_W + contact * AO_CONTACT_W);
    const f = Math.max(0, 1 - strength * occ);
    // MULTIPLY into the existing attribute — never replace it.
    color.setXYZ(i, color.getX(i) * f, color.getY(i) * f, color.getZ(i) * f);
  }
  color.needsUpdate = true;
  return geo;
}

/**
 * Chunked bake scheduler for the cold-load budget (GRAPHICS_CONTRACT §5). A
 * synchronous factory cannot chunk itself, so this is the ONLY sanctioned way
 * to build a map without freezing the main thread on match start. (A prior
 * pass in this repo shipped a 1 s join freeze from exactly this; it is a known
 * trap.)
 *
 * `budgetMs` is the PER-STEP slice, not the total: one `step()` spends at most
 * that much main-thread time and then yields, and the owner's total budget
 * (150 ms R_TERRAIN / 150 ms R_VEG / 100 ms R_MAPMESH) is met by how many
 * frames it takes, not by this number. A sane slice is 4-8 ms — comfortably
 * inside one 60 fps frame.
 *
 * Drive it from the owner's frame hook:
 *
 *     const job = bakeChunked(parts, 6);
 *     scene.addFrameHook(() => { job.step(); });
 *     three.add(job.mesh.group);          // fills in as the bake proceeds
 *
 * `step()` always does at least one unit of work, so it terminates even with
 * `budgetMs` 0 and on a platform with no clock. Its output is bit-identical to
 * `bake()`'s — the clock decides how much, never what.
 */
export function bakeChunked(parts: readonly Part[], budgetMs: number): ChunkedBake {
  const clock =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? (): number => performance.now()
      : null;

  const buckets = new Map<string, Bucket>();
  const group = new THREE.Group();
  group.name = 'rift:baked';
  const out: BakedPart[] = [];
  const mesh: BakedMesh = { group, parts: out };

  let i = 0; // phase 1 cursor: parts normalised and bucketed
  let keys: string[] = [];
  let j = 0; // phase 2 cursor: buckets merged
  let phase = 0;

  /** One indivisible unit of work. Returns false once nothing is left. */
  function unit(): boolean {
    if (phase === 0) {
      const p = parts[i];
      if (p !== undefined) {
        const key = bucketKey(p);
        let b = buckets.get(key);
        if (b === undefined) {
          b = { material: partMaterial(p.surface, p.tint, p.emissive), geos: [] };
          buckets.set(key, b);
        }
        b.geos.push(normalizePart(p));
      }
      i++;
      if (i >= parts.length) {
        keys = [...buckets.keys()];
        phase = 1;
      }
      return true;
    }
    if (phase === 1) {
      const key = keys[j];
      const b = key !== undefined ? buckets.get(key) : undefined;
      if (key !== undefined && b !== undefined && b.geos.length > 0) {
        const geo = mergeBucket(key, b);
        group.add(bakedMeshOf(geo, b.material));
        out.push({ geo, material: b.material });
      }
      j++;
      if (j >= keys.length) phase = 2;
      return true;
    }
    return false;
  }

  return {
    mesh,
    step(): boolean {
      if (phase === 2) return false;
      const t0 = clock !== null ? clock() : 0;
      let more = true;
      do {
        more = unit();
      } while (more && clock !== null && clock() - t0 < budgetMs);
      return phase !== 2;
    },
  };
}

// ============================================================================
// Bloom masking
// ============================================================================

/**
 * Put an object — and everything under it — on BLOOM_LAYER. Selective bloom is
 * LAYER-masked, not threshold-masked (STYLE_BIBLE §6): the composer renders
 * this layer alone into a second target and adds it back, which is the only
 * way to separate an emissive crystal from sun-lit metal.
 *
 * `enable`, not `set`: the object must stay on layer 0 or it disappears from
 * the beauty pass. Every object built with `emissiveSurface()` MUST be passed
 * here (GRAPHICS_CONTRACT §7.9) — unmarked emissives do not bloom, and marked
 * non-emissives haze the frame.
 */
export function markBloom(o: THREE.Object3D): void {
  o.traverse((child) => {
    child.layers.enable(BLOOM_LAYER);
  });
}

// ============================================================================
// Scatter
// ============================================================================

/**
 * Poisson-disc scatter with per-instance seeded variation, honouring the
 * density targets and the variation law of STYLE_BIBLE §8. Returns instance
 * transforms; the caller bakes them into a chunk or feeds an InstancedMesh.
 *
 * Poisson-disc, not uniform random: uniform random clumps, and visible clumps
 * plus visible bare patches is what makes a procedural world read as
 * machine-made. `spacing` is a hard guarantee (no two instances are closer);
 * `density` is a target the scatter reaches only if `spacing` physically
 * allows it.
 *
 * Every instance gets scale +/-30%, a full 360 deg yaw, a lean up to 12 deg in
 * a random direction, one of the family's tint steps, and an archetype index.
 * None of that is optional and none of it is a call-site dial: "a visible
 * grid, a visible repeat, or two identical adjacent instances is a defect a
 * reviewer files", and this is where that is made impossible.
 */
export function scatter(opts: ScatterOpts): readonly InstanceXform[] {
  if (opts.tints.length < SCATTER_MIN_TINTS) {
    throw new Error(
      `rift kit: scatter needs at least ${SCATTER_MIN_TINTS} tint steps ` +
        '(STYLE_BIBLE §8 variation law) — pass the family {base, Lit, Deep} ladder',
    );
  }
  const w = opts.maxX - opts.minX;
  const d = opts.maxZ - opts.minZ;
  if (w <= 0 || d <= 0 || opts.spacing <= 0) return [];

  const r = rng(opts.seed);
  const target = Math.min(
    opts.max ?? Number.MAX_SAFE_INTEGER,
    Math.max(0, Math.round((opts.density * w * d) / 100)),
  );
  if (target === 0) return [];

  const accept = opts.accept;
  const spacing = opts.spacing;
  const cell = spacing / Math.SQRT2;
  const gw = Math.max(1, Math.ceil(w / cell));
  const gd = Math.max(1, Math.ceil(d / cell));
  const grid = new Int32Array(gw * gd).fill(-1);
  const px: number[] = [];
  const pz: number[] = [];
  const active: number[] = [];

  const gridIndex = (x: number, z: number): number => {
    const gx = Math.min(gw - 1, Math.max(0, Math.floor((x - opts.minX) / cell)));
    const gz = Math.min(gd - 1, Math.max(0, Math.floor((z - opts.minZ) / cell)));
    return gz * gw + gx;
  };
  const farEnough = (x: number, z: number): boolean => {
    const gx = Math.floor((x - opts.minX) / cell);
    const gz = Math.floor((z - opts.minZ) / cell);
    for (let oz = -2; oz <= 2; oz++) {
      for (let ox = -2; ox <= 2; ox++) {
        const cx = gx + ox;
        const cz = gz + oz;
        if (cx < 0 || cz < 0 || cx >= gw || cz >= gd) continue;
        const idx = grid[cz * gw + cx] ?? -1;
        if (idx < 0) continue;
        const dx = (px[idx] ?? 0) - x;
        const dz = (pz[idx] ?? 0) - z;
        if (dx * dx + dz * dz < spacing * spacing) return false;
      }
    }
    return true;
  };
  const place = (x: number, z: number): void => {
    const idx = px.length;
    px.push(x);
    pz.push(z);
    grid[gridIndex(x, z)] = idx;
    active.push(idx);
  };

  // Seed point: the first candidate the zone accepts. A zone that rejects
  // everything (all water, all lane) legitimately scatters nothing.
  for (let attempt = 0; attempt < 64 && px.length === 0; attempt++) {
    const x = opts.minX + r.next() * w;
    const z = opts.minZ + r.next() * d;
    if (accept === undefined || accept(x, z)) place(x, z);
  }

  while (active.length > 0 && px.length < target) {
    const ai = Math.min(active.length - 1, Math.floor(r.next() * active.length));
    const from = active[ai] ?? 0;
    const fx = px[from] ?? 0;
    const fz = pz[from] ?? 0;
    let placed = false;
    for (let k = 0; k < SCATTER_TRIES; k++) {
      const ang = r.next() * Math.PI * 2;
      // Bridson's annulus: [spacing, 2*spacing) from the active point.
      const rad = spacing * (1 + r.next());
      const x = fx + Math.cos(ang) * rad;
      const z = fz + Math.sin(ang) * rad;
      if (x < opts.minX || x >= opts.maxX || z < opts.minZ || z >= opts.maxZ) continue;
      if (accept !== undefined && !accept(x, z)) continue;
      if (!farEnough(x, z)) continue;
      place(x, z);
      placed = true;
      break;
    }
    if (!placed) active.splice(ai, 1);
  }

  const heightAt = opts.heightAt;
  const baseScale = opts.scale ?? 1;
  const archetypes = Math.max(1, Math.floor(opts.archetypes ?? 1));
  const out: InstanceXform[] = [];
  for (let i = 0; i < px.length; i++) {
    const x = px[i] ?? 0;
    const z = pz[i] ?? 0;
    const leanA = r.next() * Math.PI * 2;
    const leanM = r.next() * SCATTER_LEAN_RAD;
    out.push({
      x,
      y: heightAt !== undefined ? heightAt(x, z) : 0,
      z,
      scale: baseScale * (1 + (r.next() * 2 - 1) * SCATTER_SCALE_VAR),
      rotY: r.next() * Math.PI * 2,
      leanX: Math.cos(leanA) * leanM,
      leanZ: Math.sin(leanA) * leanM,
      tint: r.pick(opts.tints),
      variant: Math.min(archetypes - 1, Math.floor(r.next() * archetypes)),
    });
  }
  return out;
}
