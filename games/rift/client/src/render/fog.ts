// ============================================================================
// ANCIENTS (rift) — FOG OF WAR (GRAPHICS_CONTRACT §1/§5/§6, STYLE_BIBLE §10).
//
// The client owns the PIXELS of fog; the SERVER owns the truth. This module
// presents `snap`, it does not re-derive it — it mirrors `sim/vision.ts` arm by
// arm so the mask it paints and the units the server sent agree on screen:
//
//   * SOURCES ARE THIS PLAYER'S TEAM ONLY (own mobiles, own wards, own living
//     structures). Camp creeps carry NEUTRAL_TEAM and are therefore never a
//     source for either player team — `vision.ts` says so in as many words, so
//     their entries in VISION below are 0 rather than a radius that no code
//     path can reach.
//   * NIGHT shrinks the radius of everything with living eyes — heroes, creeps,
//     summons — and leaves wards, towers, guards and ancients at full radius
//     (DESIGN_DELTA §5). The ramp is `nightVisionScale` IMPORTED FROM
//     shared/src/config.ts: AMENDMENT_1 §B.1 made that the single definition of
//     the cycle precisely so a second copy could not drift, and a local copy
//     here was the divergence AMENDMENT_3 §F rejected by name.
//   * VISION DOES NOT TRAVEL UPHILL (DESIGN_DELTA §1). A low viewer's disc is
//     punched by a boot-baked ELEV_HIGH stencil in both the live pass and the
//     explored accumulation, so a plateau you have never climbed stays dark.
//   * OWN-TEAM ENTITIES ARE NEVER VETOED. `vision.ts` returns own-team mobiles
//     before any of the three tests run. `isVisible(x, z)` carries no team, so
//     it mirrors that bypass POSITIONALLY: the module remembers which of THIS
//     TEAM'S sources were in the previous snapshot and are gone from this one,
//     and answers `true` within GHOST_R of each. The disc list is own-team by
//     construction, so a vanished source is by definition an own-team entity —
//     which is exactly the set the server never vetoes, and exactly what
//     game.ts's creep-death-burst test asks about. Without it a friendly creep
//     that died on a plateau while every surviving ally stood low got no death
//     burst at all.
//   Concealment (foliage) is deliberately NOT mirrored: it hides an ENTITY from
//   a distant enemy, not the ground, and `isVisible(x,z)` has no viewer to test
//   it against — applying it would hide things the server says are visible.
//
// THE OVERLAY IS TERRAIN-CONFORMAL, not a plane. Two sheets whose every inner
// vertex sits on a `TerrainGrid` CELL CENTRE — the exact positions
// `SceneHandle.heightAt` interpolates between — so the LOW sheet is an exact
// parallel offset of the ground rather than a resampling of it. Each quad is
// split along the diagonal whose endpoints sum HIGHER, which makes the
// triangulated surface an upper bound on the bilinear ground it is offset from
// (worst case +|a-b-c+d|/4 = +0.65 m, at the single interior point of a cliff
// CORNER cell). That replaces the previous round's fixed ±0.6 m five-tap MAX
// filter, which was a NO-OP on the 3 m HIGH sheet and, on the 1 m LOW sheet,
// floated a 1 m band of fog 2.6 m over the ground at every cliff foot — 1.82 m
// of apparent lateral offset at the 55° camera.
//   * LOW  (+0.55 m): the visibility mask — darkens explored-not-visible ground
//     toward `shroud` at DIM_ALPHA, clears where visible. Unit bodies poke
//     through and stay readable on fog-darkened ground (the ladder law:
//     valueLadder.test.ts asserts team colours against composite(moss, shroud,
//     0.55), so DIM_ALPHA is contract data, not a tuning dial).
//   * HIGH (+6.0 m): opaque only where never explored, so what stands in
//     unexplored jungle is occluded by the shroud instead of poking out of it.
//     Its sample grid is 3 m and every vertex takes the MAX of the height field
//     over its own ±1.5 m cell, so the lid is a true upper envelope of the
//     terrain at its own resolution — the ridge-safe filter done at the scale
//     the sheet actually samples at.
//
// WHY +6.0 AND NOT +7.5. Measured, against the terrain relief in scene.ts and
// `CAM_MIN_H = 11` (BUILD_SPECS §R_WIRE item 3):
//     highest ground  = ELEV_STEP 2.6 + UNDULATION_HIGH 0.18   =  2.78 m
//     lowest ground   = -(RIVER_DIP 0.4 + UNDULATION_RIVER .06) = -0.46 m
//     camera y        = heightAt(target) + camHeight, camHeight >= 11
//                     => lowest camera y = 10.54 m
//     lid over the highest ground = 2.78 + 6.0                 =  8.78 m
//     worst-case clearance        = 10.54 - 8.78               =  1.76 m
// At +7.5 that clearance was 0.26 m and the lid could rise THROUGH the camera;
// because a `shroud` material is FrontSide with +Y normals, the occluder was
// then backface-culled and silently vanished instead of filling the frame. Two
// things fix it: the lower lift, and the HIGH sheet emitting every quad in BOTH
// windings (+6050 triangles) so a camera that does get under it still meets an
// occluder. `SurfaceDef` has no `side` field, so double winding is the only
// legal way to say DoubleSide — see the CONTRACT_GAP notes in the report.
// The lid clears every hero (1.9 m), creep, ward and camp prop outright, and
// the two squat tree archetypes (MOSSY ~6 m, DEAD ~6.5 m) to within half a
// metre. It does NOT clear the 8-11.5 m trees, the 9.4 m towers or the 14.0 m
// ancient: no lid can, because the camera itself sits 11 m up.
//
// MATERIAL (AMENDMENT_3 §C, AMENDMENT_4 §A). Both sheets take
// `instanceSurface('shroud', { map })` — the frozen transparent overlay family,
// through the ONE sanctioned uncached path, because the two sheets genuinely
// carry different masks and one cached material cannot hold two. Nothing is
// cloned and nothing is overridden: `transparent`, `depthWrite`, `blending`,
// `fog` and `castShadow` all come from the surface table, the albedo is
// `APAL.shroud`, and this file constructs no material of its own. Zero Lambert.
//
// THE MASK'S RGB IS A MULTIPLIER, NOT A COLOUR. `material.map` multiplies
// `material.color`, so the sheet's texture is painted at MASK_UNIT (white) and
// the shroud colour comes from the surface family. The canvas the minimap reads
// is derived from it with one `source-in` fill of `APAL.shroud`, so
// `maskCanvas` keeps the palette colour R_MINIMAP composites.
//
// ATMOSPHERE, NOT A UI LID (§10, §10a.5). Three things do this work:
//   (a) the sheets follow the ground;
//   (b) the explored/shroud boundary is a wide gaussian ramp (metres, not
//       texels) over blobs whose rims wobble with the noise field, so a
//       corridor never unions into a ruler-straight edge, and the live vision
//       edge is a 3.9 m alpha falloff rather than a step;
//   (c) a seamless three-octave noise sheet DRIFTS across the explored
//       coverage, so the dim layer breathes between alpha 0.471 and 0.629 about
//       a mean of exactly DIM_ALPHA instead of sitting under a flat wash.
// Two things §10 asks for are NOT here, both for the same reason and both
// reported as contract gaps rather than faked: the never-explored mass carries
// no visible mist, and there is no warm cast at the visibility falloff.
// `SURFACES.shroud.emissive` is `null`, so the only channel this file can
// modulate is a MULTIPLIER on a #07090c albedo — 12 units of 8-bit range, in
// which neither a mist nor a hue rotation survives quantisation. The previous
// round faked both by cloning `cloth` and writing `emissive`, and its "warm"
// falloff `mix(APAL.shroud, APAL.dirtLit, 0.1)` computed to #141414: exactly
// zero hue (r and b cross at t = 0.1 and land on the same integer) at 2.9x
// shroud's red.
//
// COLD LOAD (GRAPHICS_CONTRACT §5, AMENDMENT_3 §E). §5 allots this module none
// of the 400 ms, so nothing heavy may run synchronously in `createFog`.
// Everything expensive — the noise field, the mist sheets, the ELEV_HIGH
// stencil, the map-edge feather and both sheets' geometry — is a list of
// bounded units stepped from the frame hook under BOOT_SLICE_MS. `createFog`
// itself allocates canvases, bakes the 128-square vision sprite and returns.
// `update` is safe from the first snapshot: it always refreshes the disc window
// (so `isVisible` is live immediately) and holds the snapshot until the raster
// stages exist, then composes it. The HIGH sheet is built FIRST and its canvas
// boots fully opaque, so the lid occludes from the frame it appears on.
//
// PERF. Snapshot work runs at ~5 Hz (game.ts throttles). Zero getImageData
// anywhere, so no canvas asks for a CPU-backed context; every per-source stamp
// is a pre-baked sprite blitted with drawImage; ONE half-res gaussian per
// update; `isVisible` is a JS distance test over a POOLED disc list plus one
// O(1) terrain lookup. The frame hook advances two mist phases and steps the
// boot list. Two draw calls, both out of the shadow pass.
// ============================================================================
import * as THREE from 'three';
import {
  ANCIENT,
  APAL,
  CREEP_MELEE,
  CREEP_RANGED,
  CREEP_SIEGE,
  ELEV_HIGH,
  GUARD_TOWER,
  HERO_VISION,
  SUMMON_SHADE,
  TOWER,
  WARD_VISION,
  elevationAt,
  isPlayerTeam,
  nightVisionScale,
} from '@rift/shared';
import type { EntKind, MapDef, TeamId, TerrainDef } from '@rift/shared';
import type { FogHandle, SceneHandle, SnapMsg } from '../contract.js';
import { sceneCore, whiteVertexColors } from './core.js';
import { instanceSurface } from './kit.js';

// ---- mask rasters -----------------------------------------------------------
/** Mask/explored/scratch resolution. At side 96 that is 5.3 texels/m, so the
 *  blurred explored ramp below spans ~25 texels and 8-bit alpha quantisation
 *  stays far under the perceptual banding threshold. */
const RES = 512;
/** The gaussian runs at half res — same world-space sigma, a quarter of the
 *  pixels — and `drawImage` upscales it into both composites. */
const BLUR_RES = RES / 2;
/** Canvas `filter: blur(Npx)` is a gaussian of sigma ~N/2, so the 10-90% ramp
 *  is ~1.28*N half-res texels — about 6.8 m at side 96. Metres, not texels:
 *  that is the difference between atmosphere and a UI lid. */
const EDGE_BLUR = 14;
/** Explored blob rim wobble (fraction of radius), sampled from the noise field
 *  so a corridor of overlapping blobs never unions into a straight seam. */
const RIM_WOBBLE = 0.09;
const RIM_SEGMENTS = 28;
/** Map-edge feather band width in RES texels, plus its noise wobble. */
const FEATHER = 20;
const FEATHER_WOBBLE = 8;
/** Per-source stamp resolution. Vision radii are 6-11 m, i.e. 32-59 texels at
 *  RES/side, so 128 is a downscale at every real size. */
const SPRITE_RES = 128;
/** Extra softening on the ELEV_HIGH stencil, in RES texels. The stencil is
 *  rasterised at the TERRAIN's own 1 cell/m grid and upscaled, so bilinear
 *  filtering already spreads its edge over ~RES/dim texels; this only takes the
 *  last of the stair-step off. */
const STENCIL_BLUR = 1;

// ---- overlay geometry -------------------------------------------------------
/** Overlay span as a multiple of the map side. The visible ground disc reaches
 *  side*1.6 from the centre, so the sheet must span >= side*3.2 to cover it. */
const PLANE_SPAN = 3.4;
/** Inner sample spacing in metres, per sheet. `TerrainGrid.res` is frozen at
 *  1 cell/metre, so the LOW sheet samples the height field at ITS OWN grid and
 *  its vertices land on the cell centres `heightAt` interpolates between. The
 *  HIGH sheet is an occluding lid whose parallax is already 4.2 m at the 55°
 *  camera, so it follows gross elevation at 3 m and costs a ninth as many
 *  quads (§5: the triangle budget is a gate, not an aspiration). */
const LOW_CELL_M = 1;
const HIGH_CELL_M = 3;
/** Rings of skirt quads outside the map square, spaced quadratically so they
 *  densify toward the map edge where the height still varies. */
const SKIRT_RINGS = 6;
/** Lift of each sheet above the local ground, in metres. See the header for the
 *  arithmetic behind 6.0 — it is bounded above by the camera, not by taste. */
const LOW_LIFT = 0.55;
const HIGH_LIFT = 6;
const LOW_ORDER = 60;
const HIGH_ORDER = 61;
/** Vertices per boot unit when a sheet is built. The LOW sheet is 140x140 and
 *  one `heightAt` costs ~25 ns, so this is well under a millisecond of taps;
 *  the bound exists for the attribute writes around them. */
const SHEET_UNIT_VERTS = 4096;

// ---- shroud look ------------------------------------------------------------
/** Explored-not-visible ground composites toward `shroud` by this alpha.
 *  CONTRACT DATA, not a dial: valueLadder.test.ts asserts team readability
 *  against `composite(moss, shroud, 0.55)`. */
const DIM_ALPHA = 0.55;
/** The mask's RGB. `material.map` MULTIPLIES `material.color`, so this is a
 *  multiplier and 1.0 is the only value that leaves `SURFACES.shroud`'s palette
 *  albedo intact. It is deliberately not an APAL entry, because it is not a
 *  colour; the canvas the minimap reads is re-coloured to `APAL.shroud` at the
 *  end of every compose. */
const MASK_UNIT = '#ffffff';
/** Noise tile resolution. Seamless (the octave grids wrap), so it repeats. */
const NOISE_RES = 256;
/** Whole mist tiles across one RES sheet. Two different counts so the two
 *  sheets carry two different mist scales, and both divide RES exactly so the
 *  sheet wraps seamlessly when it is blitted at a drifting offset. */
const MIST_TILES_LOW = 4;
const MIST_TILES_HIGH = 2;
/** Mist drift in metres per second, per sheet. Two directions, two scales: the
 *  mist layers, and neither repeat ever lines up with the other. */
const MIST_LOW_X = 0.34;
const MIST_LOW_Z = 0.13;
const MIST_HIGH_X = -0.19;
const MIST_HIGH_Z = 0.22;
/** How far the mist may thin the explored coverage, and the punch that keeps
 *  its MEAN on the contract value.
 *
 *  The mist erodes the explored coverage, so a thicker mist means a smaller
 *  punch and a DARKER dim layer. Left alone that would bias the whole layer off
 *  `DIM_ALPHA`, so the punch is divided by the mist's own mean: the noise field
 *  is three octaves of U(0,1) lattices with weights summing to 1, so its
 *  expectation is exactly 0.5 and `DIM_PUNCH = (1-DIM_ALPHA)/(1-MIST_AMP/2)`
 *  puts the dim layer at DIM_ALPHA on average.
 *
 *  The arithmetic over the mist's full amplitude is alpha 0.471 (mist absent)
 *  to 0.629 (mist at full strength), mean 0.550 — i.e. `composite(moss, shroud,
 *  0.55)`, the composite valueLadder.test.ts asserts, plus or minus 0.08,
 *  against the previous round's 12x texel spread. Measured on the rendered mask
 *  over a fully-explored interior, a 5.25 m patch spans 0.525 to 0.596 with a
 *  mean of 0.562. Both team colours are far LIGHTER than moss (L* ~58 against
 *  ~22), so the darker half of that excursion raises their contrast and the
 *  lighter half moves toward bare moss, which the same test also asserts. */
const MIST_AMP = 0.3;
const DIM_PUNCH = (1 - DIM_ALPHA) / (1 - MIST_AMP / 2);
/** `isVisible` radius threshold: the disc stamp holds full alpha to 0.65r and
 *  ramps to 0 at r, so the >40/255 alpha cutoff lands at 0.945r. */
const VIS_R_FRACTION = 0.945;
/** Tolerance matching `snap.you` against its own hero entity, in metres. Both
 *  come from the same `Ent` on the same tick, so this only absorbs a JSON
 *  round-trip. */
const SELF_EPS = 0.01;
/** Radius, in metres, around the last position of an own-team source that has
 *  just left the snapshot, inside which `isVisible` mirrors the server's
 *  own-team bypass. Wide enough to absorb one dropped snapshot of movement at
 *  the fastest hero speed (8 m/s over a 5 Hz window is 1.6 m, but game.ts hands
 *  back the exact `prev` coordinate this module already consumed, so the real
 *  requirement is float equality); narrow enough that it cannot answer for a
 *  neighbouring unit. */
const GHOST_R = 0.25;
const GHOST_R2 = GHOST_R * GHOST_R;
/** Milliseconds of a frame the boot pipeline may take. Three modules chunk
 *  concurrently against one 16 ms frame (AMENDMENT_3 §E.2: a budget means NO
 *  frame exceeds it), so this module takes a third and no more. */
const BOOT_SLICE_MS = 5;

/** Vision radius by kind, and whether night shrinks it — the client mirror of
 *  `sim/vision.ts`'s `visionRadius` + `scalesAtNight`. Exhaustive over
 *  `EntKind` by type, so a new kind cannot be forgotten.
 *
 *  The three camp kinds are `r: 0` because a camp is NEVER a vision source for
 *  a player team: camp creeps carry `NEUTRAL_TEAM`, `computeTeamVisible` takes
 *  a `TeamId`, and the source loop below keeps only `e.team === selfTeam`. The
 *  previous round gave them real radii and a `true` night arm, which no call
 *  path could reach. `night` is written `false` for them for the same reason —
 *  an unreachable `true` claims a behaviour this file never exercises. */
interface KindVision {
  readonly r: number;
  readonly night: boolean;
}
const VISION: Record<EntKind, KindVision> = {
  hero: { r: HERO_VISION, night: true },
  melee: { r: CREEP_MELEE.vision, night: true },
  ranged: { r: CREEP_RANGED.vision, night: true },
  siege: { r: CREEP_SIEGE.vision, night: true },
  shade: { r: SUMMON_SHADE.vision, night: true },
  // "structures and wards are lit" — DESIGN_DELTA §5.
  ward: { r: WARD_VISION, night: false },
  tower: { r: TOWER.vision, night: false },
  guard: { r: GUARD_TOWER.vision, night: false },
  ancient: { r: ANCIENT.vision, night: false },
  // never a source for a player team (see above)
  campPack: { r: 0, night: false },
  campBrute: { r: 0, night: false },
  campHive: { r: 0, night: false },
  // a projectile has no eyes
  proj: { r: 0, night: false },
};

/** rgba() string from an APAL hex. Every colour literal in this file stays
 *  palette-traceable even where only the alpha channel is ever read. */
function rgbaOf(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${String(r)},${String(g)},${String(b)},${String(alpha)})`;
}

/** A 2D canvas. NO `willReadFrequently`: this module never calls
 *  `getImageData`, and the flag forces a CPU-backed backing store, which is
 *  paid back on every `drawImage`, `fill` and `filter` in the compose path. */
function makeCanvas(res: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement('canvas');
  cv.width = res;
  cv.height = res;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('rift fog: 2d canvas context unavailable');
  return [cv, ctx];
}

/** One live vision source, flattened to numbers and POOLED: `update` refills
 *  the window every snapshot and `isVisible` reads it on the audio and FX hot
 *  paths, so neither may allocate. */
interface Disc {
  /** Entity id, so a source that leaves the snapshot can be identified. */
  id: number;
  x: number;
  z: number;
  /** Full vision radius in metres, night scale already applied. */
  r: number;
  /** `(r * VIS_R_FRACTION)²`, the `isVisible` test. */
  r2: number;
  /** Viewer stands on ELEV_LOW, so it sees no ELEV_HIGH ground. */
  low: boolean;
}

/** The last position of an own-team source that has left the snapshot. */
interface Ghost {
  x: number;
  z: number;
}

export function createFog(scene: SceneHandle, map: MapDef): FogHandle {
  const core = sceneCore(scene);
  const terrain: TerrainDef = map.terrain;
  const side = map.side;
  /** RES texels per world metre. */
  const scale = RES / side;
  /** The height field's own sample spacing in metres. `TerrainGrid.res` is
   *  frozen at 1 cell/m, so this is 1 — derived rather than assumed, because
   *  the sheets' whole conformality argument rests on it. */
  const gridM = side / terrain.grid.dim;

  // Every canvas is allocated here (cheap — a backing store, no pixels touched)
  // so `update` has somewhere to draw the moment the raster stages finish.
  const [visNow, vctx] = makeCanvas(RES);
  const [explored, ectx] = makeCanvas(RES);
  const [scratch, sctx] = makeCanvas(RES);
  const [blurBuf, bctx] = makeCanvas(BLUR_RES);
  /** The LOW sheet's texture source: RGB is MASK_UNIT, alpha is the mask. */
  const [maskSrc, msctx] = makeCanvas(RES);
  /** The HIGH sheet's texture source. Same convention. */
  const [hardSrc, hsrcctx] = makeCanvas(RES);
  /** What `FogHandle.maskCanvas` exposes: the same alpha, re-coloured to
   *  `APAL.shroud`, because R_MINIMAP composites this canvas directly and must
   *  see the palette colour rather than the multiplier. */
  const [mask, mctx] = makeCanvas(RES);
  const [highStencil, hsctx] = makeCanvas(RES);
  const [featherErase, fectx] = makeCanvas(RES);
  const [featherDim, fdctx] = makeCanvas(RES);
  const [grainTile, gctx] = makeCanvas(NOISE_RES);
  const [mistLow, mlctx] = makeCanvas(RES);
  const [mistHigh, mhctx] = makeCanvas(RES);

  // ---- per-source stamp -----------------------------------------------------
  // Baked once and blitted with drawImage: full alpha to 0.65r, soft to nothing
  // at r — 3.9 m of falloff on a hero's 11 m radius, which is §10's "soft edge
  // of vision" and the reason VIS_R_FRACTION is 0.945 rather than 1. Cheap
  // enough (128²) to stay in the synchronous constructor.
  const [discSprite, dpctx] = makeCanvas(SPRITE_RES);
  {
    const c = SPRITE_RES / 2;
    const g = dpctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, rgbaOf(APAL.paper, 1));
    g.addColorStop(0.65, rgbaOf(APAL.paper, 1));
    g.addColorStop(1, rgbaOf(APAL.paper, 0));
    dpctx.fillStyle = g;
    dpctx.fillRect(0, 0, SPRITE_RES, SPRITE_RES);
  }

  // Boot state: fully opaque everywhere, so the instant a sheet reaches the
  // scene it occludes. The feather and the mist refine this later; neither can
  // make it wrong, only softer.
  msctx.fillStyle = MASK_UNIT;
  msctx.fillRect(0, 0, RES, RES);
  hsrcctx.fillStyle = MASK_UNIT;
  hsrcctx.fillRect(0, 0, RES, RES);
  mctx.fillStyle = APAL.shroud;
  mctx.fillRect(0, 0, RES, RES);

  // ---- textures + materials -------------------------------------------------
  const maskTex = new THREE.CanvasTexture(maskSrc);
  maskTex.colorSpace = THREE.SRGBColorSpace;
  const hardTex = new THREE.CanvasTexture(hardSrc);
  hardTex.colorSpace = THREE.SRGBColorSpace;
  // AMENDMENT_4 §A: the one legal uncached path, taken for the one reason it
  // exists — two sheets, two different masks, and a cached material can hold
  // only one. Nothing outside `map` is overridden; `transparent`, `depthWrite`,
  // `blending`, `fog`, `castShadow`, roughness, metalness and the shroud albedo
  // all come from the frozen `SURFACES.shroud` entry. Two instances, made once
  // per match, never per frame and never per entity.
  const lowMat = instanceSurface('shroud', { map: maskTex });
  lowMat.name = 'rift:fogLow';
  const highMat = instanceSurface('shroud', { map: hardTex });
  highMat.name = 'rift:fogHigh';

  // ---- procedural value noise (deterministic — mulberry32, never Math.random)
  // NOISE_RES² field in [0,1]: three octaves (large soft drift + mid blotches +
  // fine grain) so the mist reads as organic darkness rather than static. The
  // octave grids index with `% n`, so the field TILES seamlessly. Filled by the
  // boot pipeline, a quarter of the rows at a time — at module scope it was
  // 7.8 ms of unattributed import cost.
  const noiseField = new Float32Array(NOISE_RES * NOISE_RES);
  const octaves: { grid: Float32Array; n: number; w: number }[] = [];
  {
    let seed = 0x9e3779b9;
    const rnd = (): number => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (const [n, w] of [
      [4, 0.35],
      [16, 0.35],
      [64, 0.3],
    ] as const) {
      const g = new Float32Array(n * n);
      for (let i = 0; i < g.length; i++) g[i] = rnd();
      octaves.push({ grid: g, n, w });
    }
  }

  /** Smooth bilinear sample of one wrapping octave grid at uv in [0,1). */
  function octaveAt(g: Float32Array, n: number, u: number, v: number): number {
    const x = u * n;
    const y = v * n;
    const x0 = Math.floor(x) % n;
    const y0 = Math.floor(y) % n;
    const x1 = (x0 + 1) % n;
    const y1 = (y0 + 1) % n;
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = g[y0 * n + x0] ?? 0;
    const b = g[y0 * n + x1] ?? 0;
    const c = g[y1 * n + x0] ?? 0;
    const d = g[y1 * n + x1] ?? 0;
    const lo = a + (b - a) * sx;
    const hi = c + (d - c) * sx;
    return lo + (hi - lo) * sy;
  }

  /** Fill noise rows [y0, y1). */
  function fillNoiseRows(y0: number, y1: number): void {
    for (let y = y0; y < y1; y++) {
      const v = y / NOISE_RES;
      for (let x = 0; x < NOISE_RES; x++) {
        const u = x / NOISE_RES;
        let s = 0;
        for (const o of octaves) s += o.w * octaveAt(o.grid, o.n, u, v);
        noiseField[y * NOISE_RES + x] = s;
      }
    }
  }

  /** Noise sample at RES-space canvas coordinates, wrapped (the field tiles).
   *  Used by the explored-rim wobble and the map-edge feather, whose samples
   *  sit between texels. */
  function noiseAtRes(x: number, y: number): number {
    const xi = (((Math.round(x * (NOISE_RES / RES)) % NOISE_RES) + NOISE_RES) % NOISE_RES) | 0;
    const yi = (((Math.round(y * (NOISE_RES / RES)) % NOISE_RES) + NOISE_RES) % NOISE_RES) | 0;
    return noiseField[yi * NOISE_RES + xi] ?? 0.5;
  }

  // ---- boot raster stages ---------------------------------------------------
  /** The mist tile: alpha carries the noise, so `destination-out` erodes by it.
   *  RGB is never sampled — the tile is only ever an alpha source. */
  function bakeGrainTile(): void {
    const img = gctx.createImageData(NOISE_RES, NOISE_RES);
    for (let i = 0; i < NOISE_RES * NOISE_RES; i++) {
      const a = Math.max(0, Math.min(255, Math.round((noiseField[i] ?? 0.5) * 255)));
      img.data[i * 4] = 255;
      img.data[i * 4 + 1] = 255;
      img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = a;
    }
    gctx.putImageData(img, 0, 0);
  }

  /** Tile the mist across a whole RES sheet. `tiles` divides RES exactly, so
   *  the sheet is itself seamless and can be blitted 2x2 at any drifting offset
   *  without a join. */
  function bakeMistSheet(ctx: CanvasRenderingContext2D, tiles: number): void {
    const t = RES / tiles;
    ctx.clearRect(0, 0, RES, RES);
    for (let ty = 0; ty < tiles; ty++) {
      for (let tx = 0; tx < tiles; tx++) ctx.drawImage(grainTile, tx * t, ty * t, t, t);
    }
  }

  /** Alpha 1 over every cell a low viewer may not see into — the uphill veto,
   *  baked once. Rasterised at the terrain grid's OWN resolution (one texel per
   *  cell, so the loop is dim² frozen-query lookups rather than RES² and
   *  carries exactly the same information), then upscaled and blurred so the
   *  punched boundary is a soft pixel edge, never a stair-step. */
  function bakeHighStencil(): void {
    const dim = terrain.grid.dim;
    const [cells, cctx] = makeCanvas(dim);
    const img = cctx.createImageData(dim, dim);
    const cellM = side / dim;
    for (let cz = 0; cz < dim; cz++) {
      const wz = (cz + 0.5) * cellM;
      for (let cx = 0; cx < dim; cx++) {
        if (elevationAt(terrain, (cx + 0.5) * cellM, wz) !== ELEV_HIGH) continue;
        img.data[(cz * dim + cx) * 4 + 3] = 255;
      }
    }
    cctx.putImageData(img, 0, 0);
    hsctx.clearRect(0, 0, RES, RES);
    hsctx.filter = `blur(${String(STENCIL_BLUR)}px)`;
    hsctx.drawImage(cells, 0, 0, RES, RES);
    hsctx.filter = 'none';
  }

  /** The sheets are far larger than the map square and the mask is ClampToEdge,
   *  so the border texels stretch over every out-of-bounds metre of ground.
   *  `featherErase` ramps alpha 1 at the outermost texel to 0 across a wobbling
   *  ~FEATHER band; `featherDim` lays DIM_ALPHA back underneath it. Result:
   *  the mask ends at exactly DIM_ALPHA (dim dusk outskirts — never
   *  transparent, or lit ground ghosts through; never opaque, or the world ends
   *  as a pitch island) and the lid dissolves to clear instead of stopping on a
   *  straight line. `dim` selects which of the two is being baked. */
  function bakeFeather(dim: boolean): void {
    const ctx = dim ? fdctx : fectx;
    const band = FEATHER + FEATHER_WOBBLE + 1;
    const img = ctx.createImageData(RES, RES);
    const strips: readonly (readonly [number, number, number, number])[] = [
      [0, 0, RES, band],
      [0, RES - band, RES, band],
      [0, band, band, RES - 2 * band],
      [RES - band, band, band, RES - 2 * band],
    ];
    for (const [sx, sy, w, h] of strips) {
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const x = sx + xx;
          const y = sy + yy;
          const edge = Math.min(x, RES - 1 - x, y, RES - 1 - y);
          const b = FEATHER + (noiseAtRes(x, y) - 0.5) * 2 * FEATHER_WOBBLE;
          if (edge >= b) continue;
          const s = 1 - edge / b;
          const p = s * s * (3 - 2 * s);
          const i = (y * RES + x) * 4;
          if (dim) {
            // MASK_UNIT: the multiplier, exactly as the rest of the mask.
            img.data[i] = 255;
            img.data[i + 1] = 255;
            img.data[i + 2] = 255;
            img.data[i + 3] = Math.round(p * DIM_ALPHA * 255);
          } else {
            img.data[i + 3] = Math.round(p * 255);
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /** Apply the baked feather — always the LAST alpha step on a canvas.
   *  `withDim`: the mask (border -> DIM_ALPHA) vs the lid (border -> clear). */
  function feather(ctx: CanvasRenderingContext2D, withDim: boolean): void {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.drawImage(featherErase, 0, 0);
    if (withDim) {
      ctx.globalCompositeOperation = 'destination-over';
      ctx.drawImage(featherDim, 0, 0);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---- terrain-conformal overlay sheets -------------------------------------
  /**
   * One overlay sheet in WORLD coordinates, built incrementally.
   *
   * The inner grid sits on `TerrainGrid` CELL CENTRES at `cellM` spacing —
   * `heightAt` is bilinear across those centres, so a sheet sampled there and
   * lifted is an exact parallel offset of the ground rather than a resampling
   * of it. Outside the map square sit SKIRT_RINGS of quadratically expanding
   * quads out to PLANE_SPAN, so the sheet covers the whole visible ground disc;
   * their vertices sample `heightAt` too, and out of bounds that clamps to the
   * nearest in-bounds cell, so the sheet leaves the map at the height the map
   * ends at instead of dropping to y=0 and tearing away from the ground.
   *
   * `envelopeM > 0` makes each vertex the MAX of the height field over its own
   * ±envelopeM cell — a true upper envelope at the sheet's OWN resolution,
   * which is what "ridge-safe" has to mean for a lid sampled every 3 m. The
   * LOW sheet passes 0: it samples at the field's own grid, so there is nothing
   * between its vertices to miss, and a filter there is what floated a band of
   * fog 2.6 m over the ground at every cliff foot.
   *
   * `uv` maps the map square onto [0,1] of the mask — computed in GEOMETRY
   * SPACE, which is why no texture in this module sets `repeat` (the UV law).
   * v is flipped because a CanvasTexture uploads with flipY, so v=1 is canvas
   * row 0, which is world z=0.
   *
   * Normals are written flat +Y rather than computed. The shroud is atmosphere:
   * shading it with the terrain's slope reads as cloth, and `computeVertexNormals`
   * over 45 k triangles is the single largest thing this module could do in one
   * synchronous unit. Back faces get their normal flipped by the shader, so the
   * doubly-wound HIGH sheet shades identically from below.
   */
  interface SheetBuild {
    readonly geo: THREE.BufferGeometry;
    readonly n: number;
    readonly axis: Float64Array;
    readonly pos: Float32Array;
    readonly uv: Float32Array;
    readonly lift: number;
    readonly envelopeM: number;
    readonly twoSided: boolean;
    row: number;
  }

  function beginSheet(lift: number, cellM: number, envelopeM: number, twoSided: boolean): SheetBuild {
    const inner = Math.max(8, Math.floor(side / cellM));
    const margin = (side * (PLANE_SPAN - 1)) / 2;
    const n = SKIRT_RINGS * 2 + inner;
    const axis = new Float64Array(n);
    for (let k = 0; k < SKIRT_RINGS; k++) {
      const t = (SKIRT_RINGS - k) / SKIRT_RINGS;
      const d = margin * t * t;
      axis[k] = -d;
      axis[n - 1 - k] = side + d;
    }
    // cell centres: (i + 0.5) * cellM, i.e. exactly where `heightAt` samples.
    for (let i = 0; i < inner; i++) axis[SKIRT_RINGS + i] = (i + 0.5) * cellM;
    return {
      geo: new THREE.BufferGeometry(),
      n,
      axis,
      pos: new Float32Array(n * n * 3),
      uv: new Float32Array(n * n * 2),
      lift,
      envelopeM,
      twoSided,
      row: 0,
    };
  }

  /** Height the sheet must clear at (x,z): the local sample, or the MAX over
   *  the sheet's own cell when it samples coarser than the height field.
   *
   *  The taps sit on the HEIGHT FIELD's own lattice, not on the box corners.
   *  `heightAt` is bilinear across cell centres, so a tap halfway between two
   *  of them reads an interpolated value and systematically UNDER-reads the
   *  peak: measured, box-corner taps left the lid up to 0.28 m below the ground
   *  it is supposed to cap. Sampling the lattice cannot miss a cell. */
  function sheetHeight(x: number, z: number, envelopeM: number): number {
    if (envelopeM <= 0) return core.heightAt(x, z);
    const k = Math.max(1, Math.round(envelopeM / gridM));
    let h = -Infinity;
    for (let j = -k; j <= k; j++) {
      const zz = z + j * gridM;
      for (let i = -k; i <= k; i++) {
        const v = core.heightAt(x + i * gridM, zz);
        if (v > h) h = v;
      }
    }
    return h;
  }

  /** Rows one boot unit fills, and how many units the whole sheet needs. */
  function rowsPerUnit(sb: SheetBuild): number {
    return Math.max(1, Math.floor(SHEET_UNIT_VERTS / sb.n));
  }
  function sheetUnitCount(sb: SheetBuild): number {
    return Math.ceil(sb.n / rowsPerUnit(sb));
  }

  /** Fill the next band of vertex rows. Returns true while rows remain. */
  function stepSheetRows(sb: SheetBuild): boolean {
    const end = Math.min(sb.n, sb.row + rowsPerUnit(sb));
    for (let r = sb.row; r < end; r++) {
      const z = sb.axis[r] ?? 0;
      let p = r * sb.n * 3;
      let q = r * sb.n * 2;
      for (let c = 0; c < sb.n; c++) {
        const x = sb.axis[c] ?? 0;
        sb.pos[p] = x;
        sb.pos[p + 1] = sheetHeight(x, z, sb.envelopeM) + sb.lift;
        sb.pos[p + 2] = z;
        p += 3;
        sb.uv[q] = x / side;
        sb.uv[q + 1] = 1 - z / side;
        q += 2;
      }
    }
    sb.row = end;
    return sb.row < sb.n;
  }

  /** Index, attribute and close the sheet. Runs once, after every row is in. */
  function finishSheet(sb: SheetBuild): THREE.BufferGeometry {
    const n = sb.n;
    const quads = (n - 1) * (n - 1);
    const idx = new Uint32Array(quads * (sb.twoSided ? 12 : 6));
    const pos = sb.pos;
    let t = 0;
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const a = r * n + c;
        const b = a + 1;
        const d = a + n;
        const e = d + 1;
        // Split along the diagonal whose endpoints sum HIGHER. Writing the
        // corner heights as a, b, c, d over the unit cell, the triangulated
        // surface exceeds the bilinear one by (a-b-c+d)*v*(1-u) on the a-d
        // split and by its negative on the b-c split, so this choice makes the
        // sheet an UPPER bound on the ground it is offset from — it can float
        // (worst case a quarter of the corner step) but it can never sink into
        // a cliff face.
        const ya = pos[a * 3 + 1] ?? 0;
        const yb = pos[b * 3 + 1] ?? 0;
        const yd = pos[d * 3 + 1] ?? 0;
        const ye = pos[e * 3 + 1] ?? 0;
        // Both windings below were checked by hand: cross((p1-p0),(p2-p0)) is
        // (0, dx*dz, 0) for all four triangles, i.e. counter-clockwise seen
        // from above, which is the front face.
        if (ya + ye >= yb + yd) {
          idx[t] = a; idx[t + 1] = d; idx[t + 2] = e;
          idx[t + 3] = a; idx[t + 4] = e; idx[t + 5] = b;
        } else {
          idx[t] = a; idx[t + 1] = d; idx[t + 2] = b;
          idx[t + 3] = b; idx[t + 4] = d; idx[t + 5] = e;
        }
        if (sb.twoSided) {
          // The same two triangles, reversed. `SurfaceDef` cannot say
          // DoubleSide, and a lid that vanishes when the camera slips under it
          // reveals the whole unexplored map.
          idx[t + 6] = idx[t + 2] ?? 0;
          idx[t + 7] = idx[t + 1] ?? 0;
          idx[t + 8] = idx[t] ?? 0;
          idx[t + 9] = idx[t + 5] ?? 0;
          idx[t + 10] = idx[t + 4] ?? 0;
          idx[t + 11] = idx[t + 3] ?? 0;
          t += 12;
        } else {
          t += 6;
        }
      }
    }

    const normals = new Float32Array(n * n * 3);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;

    const geo = sb.geo;
    geo.setAttribute('position', new THREE.BufferAttribute(sb.pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(sb.uv, 2));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    // VERTEX-COLOUR LAW (GRAPHICS_CONTRACT §2): this geometry never passes
    // through the kit's bake(), and every kit material is vertexColors:true —
    // without the neutral white attribute both sheets render black.
    whiteVertexColors(geo);
    geo.computeBoundingSphere();
    return geo;
  }

  function addSheet(geo: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial, order: number): void {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = order === HIGH_ORDER ? 'rift:fogHigh' : 'rift:fogLow';
    mesh.renderOrder = order;
    // `SURFACES.shroud.castShadow` is false (AMENDMENT_4 §C), but that is
    // honoured by `bake()` and these meshes are hand-built: a map-sized sheet
    // in the shadow pass is the worst caster the build could have, and the
    // shadow pass is counted against the 700-draw gate.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Emissive-free and deliberately NOT markBloom()'d: the shroud is darkness,
    // not a light source, and hazing the frame with it is the amateur bloom
    // tell STYLE_BIBLE §6 bans.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    core.three.add(mesh);
  }

  // ---- the boot pipeline ----------------------------------------------------
  // Every unit below is bounded and independent: one failing unit degrades one
  // feature (a missing feather is a hard map edge; a missing stencil is a fog
  // that does not respect cliffs) and never stops the rest, because the one
  // outcome that must not happen is a fog that never appears at all.
  const highBuild = beginSheet(HIGH_LIFT, HIGH_CELL_M, HIGH_CELL_M / 2, true);
  const lowBuild = beginSheet(LOW_LIFT, LOW_CELL_M, 0, false);
  let ready = false;
  let pendingSnap: SnapMsg | null = null;

  const bootUnits: (() => void)[] = [];
  for (let k = 0; k < 4; k++) {
    const y0 = (k * NOISE_RES) / 4;
    bootUnits.push(() => {
      fillNoiseRows(y0, y0 + NOISE_RES / 4);
    });
  }
  // The lid first, and the lid's canvas already boots fully opaque, so the
  // first frame that shows a sheet is already occluding.
  for (let k = sheetUnitCount(highBuild); k > 0; k--) {
    bootUnits.push(() => {
      stepSheetRows(highBuild);
    });
  }
  bootUnits.push(() => {
    addSheet(finishSheet(highBuild), highMat, HIGH_ORDER);
  });
  for (let k = sheetUnitCount(lowBuild); k > 0; k--) {
    bootUnits.push(() => {
      stepSheetRows(lowBuild);
    });
  }
  bootUnits.push(() => {
    addSheet(finishSheet(lowBuild), lowMat, LOW_ORDER);
  });
  bootUnits.push(bakeHighStencil);
  bootUnits.push(() => {
    bakeFeather(false);
  });
  bootUnits.push(() => {
    bakeFeather(true);
  });
  bootUnits.push(bakeGrainTile);
  bootUnits.push(() => {
    bakeMistSheet(mlctx, MIST_TILES_LOW);
  });
  bootUnits.push(() => {
    bakeMistSheet(mhctx, MIST_TILES_HIGH);
  });

  let bootAt = 0;
  let warned = false;
  function warnOnce(where: string, err: unknown): void {
    if (warned) return;
    warned = true;
    console.warn(`rift fog: ${where} failed`, err);
  }

  // ---- mist phase, in RES texels --------------------------------------------
  let mistLowX = 0;
  let mistLowY = 0;
  let mistHighX = 0;
  let mistHighY = 0;
  function wrapPhase(v: number): number {
    const m = v % RES;
    return m < 0 ? m + RES : m;
  }

  /** Blit a seamless mist sheet over the whole canvas at its drifting phase,
   *  eroding destination alpha by MIST_AMP * mist. Four clipped drawImages,
   *  covering the canvas exactly once between them; no allocation. */
  function erodeByMist(
    ctx: CanvasRenderingContext2D,
    sheet: HTMLCanvasElement,
    px: number,
    py: number,
  ): void {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = MIST_AMP;
    ctx.drawImage(sheet, px - RES, py - RES);
    ctx.drawImage(sheet, px, py - RES);
    ctx.drawImage(sheet, px - RES, py);
    ctx.drawImage(sheet, px, py);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  core.addFrameHook((dtMs: number) => {
    // GRAPHICS_CONTRACT §6: "a hook that throws takes the frame down with it;
    // guard your own entry point."
    try {
      const dt = dtMs * 0.001;
      mistLowX = wrapPhase(mistLowX + dt * MIST_LOW_X * scale);
      mistLowY = wrapPhase(mistLowY + dt * MIST_LOW_Z * scale);
      mistHighX = wrapPhase(mistHighX + dt * MIST_HIGH_X * scale);
      mistHighY = wrapPhase(mistHighY + dt * MIST_HIGH_Z * scale);
      if (ready) return;
      const t0 = performance.now();
      while (bootAt < bootUnits.length) {
        const unit = bootUnits[bootAt];
        bootAt++;
        if (unit === undefined) continue;
        try {
          unit();
        } catch (err) {
          warnOnce('boot step', err);
        }
        if (performance.now() - t0 >= BOOT_SLICE_MS) break;
      }
      if (bootAt < bootUnits.length) return;
      ready = true;
      const held = pendingSnap;
      pendingSnap = null;
      if (held !== null) compose(held);
    } catch (err) {
      warnOnce('frame hook', err);
    }
  });

  // ---- live vision ----------------------------------------------------------
  const discPool: Disc[] = [];
  let discCount = 0;
  /** The previous snapshot's window, copied field by field so the comparison
   *  below costs nothing at steady state. */
  const prevPool: Disc[] = [];
  let prevCount = 0;
  const ghostPool: Ghost[] = [];
  let ghostCount = 0;

  function pushDisc(): Disc {
    const held = discPool[discCount];
    discCount++;
    if (held !== undefined) return held;
    const fresh: Disc = { id: -1, x: 0, z: 0, r: 0, r2: 0, low: false };
    discPool.push(fresh);
    return fresh;
  }

  /** Which team's eyes we are drawing. Resolved once and then fixed for the
   *  match. `YouSnap` carries no team, so it is recovered from the snapshot by
   *  three independent tells, cheapest and most certain first:
   *    1. a `ward` in the snapshot is ALWAYS ours — the sim drops enemy wards
   *       unconditionally, at any range;
   *    2. the hero entity standing exactly where `snap.you` says we are;
   *    3. a DEAD mobile — the sim sends its own team's mobiles alive or dead
   *       and drops dead enemies, so a corpse on the wire is one of ours.
   *  Until one fires every source in the snapshot counts, which is generous by
   *  one snapshot for the LIVE pass and is deliberately not written into the
   *  explored memory (see `compose`). */
  let selfTeam: TeamId | null = null;
  function resolveSelfTeam(snap: SnapMsg): void {
    if (selfTeam !== null) return;
    for (const e of snap.ents) {
      if (e.k === 'ward' && isPlayerTeam(e.team)) {
        selfTeam = e.team;
        return;
      }
    }
    const you = snap.you;
    if (you !== null) {
      for (const e of snap.ents) {
        if (e.k !== 'hero' || e.hero !== you.hero || !isPlayerTeam(e.team)) continue;
        if (Math.abs(e.x - you.x) > SELF_EPS || Math.abs(e.z - you.z) > SELF_EPS) continue;
        selfTeam = e.team;
        return;
      }
    }
    for (const e of snap.ents) {
      if (e.hp > 0 || !isPlayerTeam(e.team)) continue;
      if (e.k === 'tower' || e.k === 'guard' || e.k === 'ancient' || e.k === 'proj') continue;
      selfTeam = e.team;
      return;
    }
  }

  /** Refill the disc window from a snapshot, and record which of the previous
   *  window's sources are gone. Never allocates after the first few frames. */
  function buildDiscs(snap: SnapMsg): void {
    const night = nightVisionScale(snap.dayPhase);
    discCount = 0;
    for (const e of snap.ents) {
      if (e.hp <= 0) continue;
      if (selfTeam !== null && e.team !== selfTeam) continue;
      const kv = VISION[e.k];
      if (kv.r <= 0) continue;
      const r = kv.night ? kv.r * night : kv.r;
      const d = pushDisc();
      d.id = e.id;
      d.x = e.x;
      d.z = e.z;
      d.r = r;
      const vr = r * VIS_R_FRACTION;
      d.r2 = vr * vr;
      d.low = elevationAt(terrain, e.x, e.z) !== ELEV_HIGH;
    }

    // Own-team sources that were here last snapshot and are not here now. The
    // window is own-team by construction, so this IS the set `vision.ts` never
    // vetoes, and it is exactly the set game.ts asks `isVisible` about.
    ghostCount = 0;
    for (let i = 0; i < prevCount; i++) {
      const p = prevPool[i];
      if (p === undefined) continue;
      let stillHere = false;
      for (let j = 0; j < discCount; j++) {
        if (discPool[j]?.id === p.id) {
          stillHere = true;
          break;
        }
      }
      if (stillHere) continue;
      let g = ghostPool[ghostCount];
      if (g === undefined) {
        g = { x: 0, z: 0 };
        ghostPool.push(g);
      }
      g.x = p.x;
      g.z = p.z;
      ghostCount++;
    }

    prevCount = 0;
    for (let i = 0; i < discCount; i++) {
      const d = discPool[i];
      if (d === undefined) continue;
      let p = prevPool[prevCount];
      if (p === undefined) {
        p = { id: -1, x: 0, z: 0, r: 0, r2: 0, low: false };
        prevPool.push(p);
      }
      p.id = d.id;
      p.x = d.x;
      p.z = d.z;
      p.r = d.r;
      p.r2 = d.r2;
      p.low = d.low;
      prevCount++;
    }
  }

  /** Stamp `sprite` centred on a world point at a world radius. */
  function blit(
    ctx: CanvasRenderingContext2D,
    sprite: HTMLCanvasElement,
    x: number,
    z: number,
    r: number,
  ): void {
    const pr = r * scale;
    ctx.drawImage(sprite, x * scale - pr, z * scale - pr, pr * 2, pr * 2);
  }

  /** Solid explored blob with a noise-wobbled rim, so overlapping blobs along a
   *  lane never union into a ruler-straight boundary. Solid (alpha 1) on
   *  purpose: a gradient re-stamped at 5 Hz has its falloff band ratcheted to
   *  binary by source-over alpha within seconds. The soft edge is applied once,
   *  at compose time, by the gaussian below. */
  function blob(ctx: CanvasRenderingContext2D, x: number, z: number, r: number): void {
    const px = x * scale;
    const py = z * scale;
    const pr = r * scale;
    ctx.beginPath();
    for (let s = 0; s <= RIM_SEGMENTS; s++) {
      const ang = (s / RIM_SEGMENTS) * Math.PI * 2;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      const rr = pr * (1 + RIM_WOBBLE * 2 * (noiseAtRes(px + cs * pr, py + sn * pr) - 0.5));
      const bx = px + cs * rr;
      const by = py + sn * rr;
      if (s === 0) ctx.moveTo(bx, by);
      else ctx.lineTo(bx, by);
    }
    ctx.closePath();
    ctx.fill();
  }

  /** Punch every ELEV_HIGH cell out of `scratch`, then merge it into `dst`.
   *  This is the uphill veto: a low viewer's disc is drawn into `scratch`, and
   *  what survives is only the low ground it can actually see. */
  function mergeLowLayer(dst: CanvasRenderingContext2D): void {
    sctx.globalCompositeOperation = 'destination-out';
    sctx.globalAlpha = 1;
    sctx.drawImage(highStencil, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    dst.globalCompositeOperation = 'source-over';
    dst.globalAlpha = 1;
    dst.drawImage(scratch, 0, 0);
  }

  function compose(snap: SnapMsg): void {
    // --- pass A: what is visible RIGHT NOW -----------------------------------
    vctx.globalCompositeOperation = 'source-over';
    vctx.globalAlpha = 1;
    vctx.clearRect(0, 0, RES, RES);
    sctx.clearRect(0, 0, RES, RES);
    for (let i = 0; i < discCount; i++) {
      const d = discPool[i];
      if (d === undefined) continue;
      blit(d.low ? sctx : vctx, discSprite, d.x, d.z, d.r);
    }
    mergeLowLayer(vctx);

    // --- pass B: persistent explored memory ----------------------------------
    // Skipped entirely while the team is still unresolved. `explored` never
    // forgets, so burning one frame of every-source-counts into it would leave
    // the enemy jungle permanently revealed for the rest of the match, whereas
    // skipping costs at most one snapshot of memory the very next update
    // re-covers. Both composites below punch by the LIVE pass as well as by
    // this one, so an unresolved team never darkens the frame.
    if (selfTeam !== null) {
      ectx.globalCompositeOperation = 'source-over';
      ectx.globalAlpha = 1;
      ectx.fillStyle = rgbaOf(APAL.paper, 1);
      sctx.clearRect(0, 0, RES, RES);
      sctx.fillStyle = rgbaOf(APAL.paper, 1);
      for (let i = 0; i < discCount; i++) {
        const d = discPool[i];
        if (d === undefined) continue;
        blob(d.low ? sctx : ectx, d.x, d.z, d.r);
      }
      mergeLowLayer(ectx);
    }

    // --- the soft edge, paid ONCE -------------------------------------------
    // gaussian-blur the binary explored mask into the half-res buffer (same
    // world-space sigma, a quarter of the pixels); drawImage upscales it
    // smoothly into both composites below.
    bctx.globalCompositeOperation = 'source-over';
    bctx.globalAlpha = 1;
    bctx.clearRect(0, 0, BLUR_RES, BLUR_RES);
    bctx.filter = `blur(${String(EDGE_BLUR)}px)`;
    bctx.drawImage(explored, 0, 0, BLUR_RES, BLUR_RES);
    bctx.filter = 'none';

    // --- the drifting mist, carried on the EXPLORED coverage ----------------
    // `scratch` is free from here on. Eroding the coverage rather than the
    // finished alpha is what keeps the mist out of two places it must never
    // reach: the never-explored mass, whose coverage is 0 and which must stay
    // fully occluding, and the lid, which reads the unmodulated buffer.
    sctx.globalCompositeOperation = 'source-over';
    sctx.globalAlpha = 1;
    sctx.clearRect(0, 0, RES, RES);
    sctx.drawImage(blurBuf, 0, 0, RES, RES);
    erodeByMist(sctx, mistLow, mistLowX, mistLowY);

    // --- the shared mask -----------------------------------------------------
    // shroud everywhere, punched to DIM_ALPHA by the misted explored memory and
    // to 0 by live vision — both ramps span many texels, never a cliff.
    msctx.globalCompositeOperation = 'source-over';
    msctx.globalAlpha = 1;
    msctx.fillStyle = MASK_UNIT;
    msctx.fillRect(0, 0, RES, RES);
    msctx.globalCompositeOperation = 'destination-out';
    msctx.globalAlpha = DIM_PUNCH;
    msctx.drawImage(scratch, 0, 0);
    msctx.globalAlpha = 1;
    msctx.drawImage(visNow, 0, 0);
    msctx.globalCompositeOperation = 'source-over';

    // --- the high lid: opaque only where never explored ----------------------
    // It punches by LIVE VISION as well as by memory. Ground you can see right
    // now is explored by definition, and while `selfTeam` is unresolved the
    // memory pass above has not run at all — without this the lid stayed fully
    // opaque and a client whose `snap.you` is null rendered a BLACK FRAME for
    // as long as no ward and no corpse ever reached it.
    hsrcctx.globalCompositeOperation = 'source-over';
    hsrcctx.globalAlpha = 1;
    hsrcctx.fillStyle = MASK_UNIT;
    hsrcctx.fillRect(0, 0, RES, RES);
    hsrcctx.globalCompositeOperation = 'destination-out';
    hsrcctx.drawImage(blurBuf, 0, 0, RES, RES);
    hsrcctx.drawImage(visNow, 0, 0);
    hsrcctx.globalCompositeOperation = 'source-over';

    // finishing pass, LAST on both: the baked wobbling map-edge feather
    feather(msctx, true);
    feather(hsrcctx, false);

    // --- the minimap's copy --------------------------------------------------
    // Same alpha, `APAL.shroud` instead of the multiplier: R_MINIMAP draws this
    // canvas straight onto its own composite and must see the palette colour.
    mctx.globalCompositeOperation = 'source-over';
    mctx.globalAlpha = 1;
    mctx.clearRect(0, 0, RES, RES);
    mctx.drawImage(maskSrc, 0, 0);
    mctx.globalCompositeOperation = 'source-in';
    mctx.fillStyle = APAL.shroud;
    mctx.fillRect(0, 0, RES, RES);
    mctx.globalCompositeOperation = 'source-over';

    maskTex.needsUpdate = true;
    hardTex.needsUpdate = true;
  }

  function update(snap: SnapMsg): void {
    // Guarded for the same reason the frame hook is: this is called from
    // game.ts's snapshot path, and a throw here would take the match with it.
    try {
      resolveSelfTeam(snap);
      // Always refreshed, ready or not: `isVisible` runs on the FX and audio
      // paths from the first snapshot, long before the rasters exist.
      buildDiscs(snap);
      if (!ready) {
        pendingSnap = snap;
        return;
      }
      compose(snap);
    } catch (err) {
      warnOnce('update', err);
    }
  }

  /** Is this world point inside the team's live vision?
   *
   *  Radius plus the uphill veto — the only one of the sim's three tests that
   *  is a function of POSITION alone — and then the own-team bypass, carried by
   *  the ghost list (see the header). Concealment is not applied: it hides an
   *  entity from a distant enemy, and answering `false` here for an ally
   *  standing in a bush would hide something the server considers visible.
   *  Allocation-free, and guarded: a throw here would silence every death
   *  burst and every positional sound in the frame. */
  function isVisible(x: number, z: number): boolean {
    try {
      for (let i = 0; i < ghostCount; i++) {
        const g = ghostPool[i];
        if (g === undefined) continue;
        const gx = x - g.x;
        const gz = z - g.z;
        if (gx * gx + gz * gz <= GHOST_R2) return true;
      }
      let high = -1;
      for (let i = 0; i < discCount; i++) {
        const d = discPool[i];
        if (d === undefined) continue;
        const dx = x - d.x;
        const dz = z - d.z;
        if (dx * dx + dz * dz > d.r2) continue;
        if (!d.low) return true;
        if (high < 0) high = elevationAt(terrain, x, z) === ELEV_HIGH ? 1 : 0;
        if (high === 0) return true;
      }
      return false;
    } catch (err) {
      // wire.ts answers `true` when there is no fog at all; matching it keeps a
      // failure loud in the log and invisible in the frame.
      warnOnce('isVisible', err);
      return true;
    }
  }

  return { maskCanvas: mask, update, isVisible };
}
