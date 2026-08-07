// ============================================================================
// ANCIENTS (rift) — FOG OF WAR (GRAPHICS_CONTRACT §1/§6, STYLE_BIBLE §10).
//
// The client owns the PIXELS of fog; the SERVER owns the truth. This module
// presents `snap`, it does not re-derive it — but it mirrors the sim's vision
// rules (sim/vision.ts) closely enough that the mask it paints and the units
// the server sent agree on screen:
//
//   * sources are THIS PLAYER'S team only (own mobiles, own wards, own living
//     structures). The old build lit a disc around every ent IN the snapshot,
//     including visible enemies, which revealed ground the server considers
//     hidden and made `isVisible` return true beside an enemy hero;
//   * night shrinks the radius of everything with living eyes — heroes, creeps,
//     summons, camps — by `NIGHT_VISION_MULT`, ramped by `snap.dayPhase` with
//     the SAME formula the sim uses (`1 - (1-mult)*phase`). Wards, towers,
//     guards and ancients are lit and unaffected (DESIGN_DELTA §5);
//   * vision does not travel uphill (DESIGN_DELTA §1: "a unit on low ground
//     cannot see units OR TERRAIN on high ground"). A low viewer's disc is
//     punched by a boot-baked ELEV_HIGH stencil, in BOTH the live pass and the
//     explored accumulation, so a plateau you have never climbed stays dark.
//     This is a per-position rule, so `isVisible` applies it too.
//   Concealment (foliage) is deliberately NOT mirrored: it hides an ENTITY from
//   a distant enemy, not the ground, and `isVisible(x,z)` has no viewer to test
//   it against — applying it would hide things the server says are visible.
//
// THE OVERLAY IS TERRAIN-CONFORMAL, not a plane. Two sheets whose every vertex
// is `SceneCore.heightAt` plus a lift, so fog sits ON the ground instead of
// floating over valleys and cutting into ridges (the immediate tell §10 names).
// Each vertex takes the MAX of five height taps over ±0.6 m, which makes the
// sheet step UP at a cliff line one quad early rather than slicing the face.
//   * LOW  (+0.55 m): the `mask` texture — darkens explored-not-visible ground
//     toward `shroud` at DIM_ALPHA, clears where visible. Unit bodies poke
//     through and stay readable on fog-darkened ground (the ladder law:
//     valueLadder.test.ts asserts team colours against composite(moss, shroud,
//     0.55), so DIM_ALPHA is contract data, not a tuning dial).
//   * HIGH (+7.5 m, above the 6 m Ancient): the `hard` texture — opaque only
//     where never explored, so trees, towers and camps in unexplored jungle are
//     occluded by the shroud instead of poking out of it.
//
// MATERIAL (GRAPHICS_CONTRACT §1a, STYLE_BIBLE §11). No Lambert anywhere: both
// sheets take `surface('cloth', APAL.shroud)` — the shroud IS a veil, and cloth
// is the roughest, most matte, metal-free family in the frozen table — CLONED
// so the overlay's own state (its alpha mask, its drifting grain, transparency)
// never touches the kit's cached instance that every banner in the game shares.
// The clone sets only what an overlay must own and the surface table does not
// speak to: `map`, `emissiveMap`, `transparent`, `depthWrite`, `fog`,
// `envMapIntensity` (0 — a 4% Fresnel sheen off the IBL across a map-sized
// sheet would grey the shroud out of "fully occluding"), and `normalMap = null`
// (a weave relief on atmosphere is the UI-lid read §10a.5 files as a defect;
// the drifting grain carries all of the structure). Roughness, metalness and
// albedo are the table's and are untouched.
//
// SHROUD LEVEL IS SOLVED, NOT TUNED. `map`'s shroud RGB crushes the lit term to
// ~0, exactly as before, so the emissive carries the whole read. Emissive is
// `APAL.shroud` at `1 / (exposure * GRAIN_MEAN)`: the grain map's mean is
// GRAIN_MEAN and the renderer multiplies by `toneMappingExposure`, so the two
// cancel and the unexplored shroud renders at PALETTE-EXACT `APAL.shroud` —
// in both lighting states, since a frame hook re-solves it whenever R_SCENE
// ramps exposure (2.75 day -> 1.9 night). This replaces the previous round's
// hand-fitted lift/trim constants, which were calibrated against ACES and stop
// meaning anything under NeutralToneMapping. NeutralToneMapping is effectively
// identity this far below its compression knee, so the solve is exact.
//
// ATMOSPHERE, NOT A UI LID (§10, §10a.5). Four things do this work and none of
// them costs a per-frame allocation:
//   (a) the sheets follow the ground;
//   (b) the shroud's RGB is a seamless three-octave grain tile carried on a
//       SECOND UV set in metres — the two sheets tile it at different scales
//       and DRIFT it in different directions, so the mist visibly moves and the
//       repeat never lines up (a still frame of a MOBA should never look still);
//   (c) the explored/shroud boundary is a wide gaussian ramp (several metres,
//       not texels) over blobs whose rims wobble with the noise field, so a
//       corridor never unions into a ruler-straight edge, and the live vision
//       edge is a 3.9 m alpha falloff rather than a step;
//   (d) the DIM layer's shroud is warmed 10% toward the palette's warm neutral
//       while the unexplored layer above it stays exactly `APAL.shroud` — §10's
//       "slightly warm visibility falloff", carried on the emissive because the
//       albedo is crushed (see below) and a warm mask texel would be invisible.
//
// PERF. Everything above is snapshot work at ~5 Hz (game.ts throttles). Zero
// getImageData outside boot; every per-source stamp is a pre-baked sprite
// blitted with drawImage (no CanvasGradient churn); ONE half-res gaussian per
// update; `isVisible` is a JS distance test over a POOLED disc list plus one
// O(1) terrain lookup. The frame hook writes two texture offsets and, only when
// exposure actually moves, two floats. Two draw calls total.
// ============================================================================
import * as THREE from 'three';
import {
  ANCIENT,
  APAL,
  CAMP_BRUTE,
  CAMP_HIVE,
  CAMP_PACK,
  CREEP_MELEE,
  CREEP_RANGED,
  CREEP_SIEGE,
  ELEV_HIGH,
  GUARD_TOWER,
  HERO_VISION,
  NIGHT_VISION_MULT,
  SUMMON_SHADE,
  TOWER,
  WARD_VISION,
  elevationAt,
  isPlayerTeam,
} from '@rift/shared';
import type { EntKind, MapDef, TeamId, TerrainDef } from '@rift/shared';
import { mix } from '@platform/shared';
import type { FogHandle, SceneHandle, SnapMsg } from '../contract.js';
import { sceneCore, whiteVertexColors } from './core.js';
import { surface } from './kit.js';

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
 *  last of the stair-step off. A vision boundary that follows a cliff should
 *  read as a hard rule with a soft pixel edge, never as aliasing. */
const STENCIL_BLUR = 1;

// ---- overlay geometry -------------------------------------------------------
/** Overlay span as a multiple of the map side. The visible ground disc reaches
 *  side*1.6 from the centre, so the sheet must span >= side*3.2 to cover it. */
const PLANE_SPAN = 3.4;
/** Inner sample spacing in metres, per sheet. The terrain grid is frozen at
 *  1 cell/metre (TerrainGrid.res), so the LOW sheet samples the height field at
 *  its own resolution and cannot miss a step — it is the one the player reads
 *  against the ground. The HIGH sheet is a lid 7.5 m up whose only job is to
 *  occlude, so it follows gross elevation at 3 m and costs a sixth as many
 *  triangles (§5: the triangle budget is a gate, not an aspiration). */
const LOW_CELL_M = 1;
const HIGH_CELL_M = 3;
/** Rings of skirt quads outside the map square, spaced quadratically so they
 *  densify toward the map edge where the height still varies. */
const SKIRT_RINGS = 6;
/** Half-width of the ridge-safe height filter, in metres. Five taps, MAX: the
 *  sheet steps up one quad BEFORE a cliff instead of slicing through its face. */
const H_TAP = 0.6;
/** Lift of each sheet above the local ground, in metres. HIGH clears the 6 m
 *  Ancient and its heart. */
const LOW_LIFT = 0.55;
const HIGH_LIFT = 7.5;
const LOW_ORDER = 60;
const HIGH_ORDER = 61;

// ---- shroud look ------------------------------------------------------------
/** Explored-not-visible ground composites toward `shroud` by this alpha.
 *  CONTRACT DATA, not a dial: valueLadder.test.ts asserts team readability
 *  against `composite(moss, shroud, 0.55)`. */
const DIM_ALPHA = 0.55;
/** Grain multiplier range written into the shroud tile. Near-full range so the
 *  absolute amplitude reads as living darkness at 1080p; the valley floor is
 *  0.08 rather than 0 so no patch is ever a dead #000. */
const GRAIN_LO = 0.08;
const GRAIN_SPAN = 0.92;
/** Mean of the multiplier. The value-noise field averages 0.5, so this is the
 *  map's mean, and the emissive solve divides it back out. */
const GRAIN_MEAN = GRAIN_LO + GRAIN_SPAN / 2;
/** Noise tile resolution. Seamless (the octave grids wrap), so it repeats. */
const NOISE_RES = 256;
/** Metres per grain tile on each sheet, and the drift of each in m/s. Two
 *  different scales moving in two different directions: the mist layers, and
 *  the repeat of a 256² tile never lines up with itself on screen. */
const LOW_TILE_M = 34;
const HIGH_TILE_M = 53;
const LOW_DRIFT_X = 0.34;
const LOW_DRIFT_Z = 0.13;
const HIGH_DRIFT_X = -0.19;
const HIGH_DRIFT_Z = 0.22;
/** How far the DIM layer's shroud is warmed toward the palette's warm neutral.
 *  This is §10's "soft, slightly warm visibility falloff at the edge of
 *  vision", and it is carried by the emissive rather than by the mask's RGB:
 *  the mask multiplies an albedo that is already crushed to ~0, so a warm tint
 *  painted into the canvas would be mathematically invisible.
 *
 *  It applies to the LOW sheet only. Explored-but-not-visible ground therefore
 *  carries a faint warm cast that fades out exactly as the vision falloff ramps
 *  its alpha away, while the never-explored mass above it stays cold and dead —
 *  warm toward what you have seen, cold toward what you have not. The
 *  unexplored shroud, which is the surface valueLadder.test.ts names, stays
 *  PALETTE-EXACT `APAL.shroud`: the HIGH sheet draws after the LOW one
 *  (renderOrder) and is opaque wherever nothing has ever been explored, so it
 *  covers the warm layer completely there. Both endpoints are APAL entries, so
 *  `mix` stays legal (STYLE_BIBLE §3). */
const WARM_DIM = 0.1;
/** `isVisible` radius threshold: the disc stamp holds full alpha to 0.65r and
 *  ramps to 0 at r, so the >40/255 alpha cutoff lands at 0.945r. */
const VIS_R_FRACTION = 0.945;
/** Tolerance matching `snap.you` against its own hero entity, in metres. Both
 *  come from the same `Ent` on the same tick, so this only absorbs a JSON
 *  round-trip. */
const SELF_EPS = 0.01;

/** Vision radius by kind — the client mirror of sim/vision.ts's `visionRadius`.
 *  Exhaustive over `EntKind` by type, so a new kind cannot be forgotten here. */
const VISION: Record<EntKind, number> = {
  hero: HERO_VISION,
  melee: CREEP_MELEE.vision,
  ranged: CREEP_RANGED.vision,
  siege: CREEP_SIEGE.vision,
  shade: SUMMON_SHADE.vision,
  tower: TOWER.vision,
  guard: GUARD_TOWER.vision,
  ancient: ANCIENT.vision,
  ward: WARD_VISION,
  campPack: CAMP_PACK.vision,
  campBrute: CAMP_BRUTE.vision,
  campHive: CAMP_HIVE.vision,
  proj: 0,
};

/** Does night shrink this kind's radius? Transcribed from sim/vision.ts's
 *  `scalesAtNight`: the FALSE arm is the closed list (ward, tower, guard,
 *  ancient — "structures and wards are lit", DESIGN_DELTA §5) and everything
 *  with living eyes scales. Diverging from the sim here is exactly how a client
 *  starts drawing a unit the server has already hidden. */
function scalesAtNight(kind: EntKind): boolean {
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

/** Multiplier on a living source's radius: 1 at full day, NIGHT_VISION_MULT at
 *  full night, LINEAR between — the sim ramps rather than snapping, and a step
 *  here would put a vision cliff in the middle of a dusk the renderer is
 *  drawing as a gradient. `dayPhase` is contractually [0,1]; it is clamped
 *  anyway so a malformed frame cannot grow anybody's vision. */
function nightVisionScale(dayPhase: number): number {
  const p = dayPhase > 0 ? (dayPhase < 1 ? dayPhase : 1) : 0;
  return 1 - (1 - NIGHT_VISION_MULT) * p;
}

/** rgba() string from an APAL hex. Every colour literal in this file stays
 *  palette-traceable even where only the alpha channel is ever read. */
function rgbaOf(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${String(r)},${String(g)},${String(b)},${String(alpha)})`;
}

function makeCanvas(res: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement('canvas');
  cv.width = res;
  cv.height = res;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('rift fog: 2d canvas context unavailable');
  return [cv, ctx];
}

// ---- procedural value noise (deterministic — mulberry32, never Math.random) --
/** NOISE_RES² field in [0,1]: three octaves (large soft drift + mid blotches +
 *  fine grain) so the shroud reads as organic darkness rather than static. The
 *  octave grids index with `% n`, so the field TILES seamlessly and can be
 *  repeat-wrapped across the whole overlay. */
const noiseField = ((): Float32Array => {
  let seed = 0x9e3779b9;
  const rnd: () => number = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const grid = (n: number): Float32Array => {
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    return g;
  };
  const sample = (g: Float32Array, n: number, u: number, v: number): number => {
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
  };
  const g4 = grid(4);
  const g16 = grid(16);
  const g64 = grid(64);
  const field = new Float32Array(NOISE_RES * NOISE_RES);
  for (let y = 0; y < NOISE_RES; y++) {
    for (let x = 0; x < NOISE_RES; x++) {
      const u = x / NOISE_RES;
      const v = y / NOISE_RES;
      field[y * NOISE_RES + x] =
        0.35 * sample(g4, 4, u, v) + 0.35 * sample(g16, 16, u, v) + 0.3 * sample(g64, 64, u, v);
    }
  }
  return field;
})();

/** Noise sample at RES-space canvas coordinates, wrapped (the field tiles).
 *  Used by the explored-rim wobble and the map-edge feather, whose samples sit
 *  between texels. */
function noiseAtRes(x: number, y: number): number {
  const xi = (((Math.round(x * (NOISE_RES / RES)) % NOISE_RES) + NOISE_RES) % NOISE_RES) | 0;
  const yi = (((Math.round(y * (NOISE_RES / RES)) % NOISE_RES) + NOISE_RES) % NOISE_RES) | 0;
  return noiseField[yi * NOISE_RES + xi] ?? 0.5;
}

/** One live vision source, flattened to numbers and POOLED: `update` refills
 *  the window every snapshot and `isVisible` reads it on the audio and FX hot
 *  paths, so neither may allocate. */
interface Disc {
  x: number;
  z: number;
  /** Full vision radius in metres, night scale already applied. */
  r: number;
  /** `(r * VIS_R_FRACTION)²`, the `isVisible` test. */
  r2: number;
  /** Viewer stands on ELEV_LOW, so it sees no ELEV_HIGH ground. */
  low: boolean;
}

export function createFog(scene: SceneHandle, map: MapDef): FogHandle {
  const core = sceneCore(scene);
  const terrain: TerrainDef = map.terrain;
  const side = map.side;
  /** RES texels per world metre. */
  const scale = RES / side;

  const [visNow, vctx] = makeCanvas(RES);
  const [explored, ectx] = makeCanvas(RES);
  const [scratch, sctx] = makeCanvas(RES);
  const [blurBuf, bctx] = makeCanvas(BLUR_RES);
  const [mask, mctx] = makeCanvas(RES);
  const [hard, hctx] = makeCanvas(RES);

  // ---- the shroud grain tile ------------------------------------------------
  // Greyscale multiplier GRAIN_LO..GRAIN_LO+GRAIN_SPAN, painted once from the
  // noise field. It rides the sheets' SECOND uv set in metres, so it repeats
  // across the whole overlay at a fixed world density and drifts (see the frame
  // hook) — the mask's own ClampToEdge border can never do that, which is why
  // the previous build's outskirts measured a dead flat fill.
  const [grainTile, gctx] = makeCanvas(NOISE_RES);
  {
    const img = gctx.createImageData(NOISE_RES, NOISE_RES);
    for (let i = 0; i < NOISE_RES * NOISE_RES; i++) {
      const m = GRAIN_LO + (noiseField[i] ?? 0.5) * GRAIN_SPAN;
      const g = Math.max(0, Math.min(255, Math.round(m * 255)));
      img.data[i * 4] = g;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = g;
      img.data[i * 4 + 3] = 255;
    }
    gctx.putImageData(img, 0, 0);
  }

  // ---- per-source stamps ----------------------------------------------------
  // Baked once and blitted with drawImage. A CanvasGradient built per source
  // per update was the previous build's only allocating path in `update`.
  const [discSprite, dpctx] = makeCanvas(SPRITE_RES);
  {
    // live vision: full alpha to 0.65r, soft to nothing at r — 3.9 m of falloff
    // on a hero's 11 m radius, which is the "soft edge of vision" of §10 and
    // the reason VIS_R_FRACTION below is 0.945 rather than 1.
    const c = SPRITE_RES / 2;
    const g = dpctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, rgbaOf(APAL.paper, 1));
    g.addColorStop(0.65, rgbaOf(APAL.paper, 1));
    g.addColorStop(1, rgbaOf(APAL.paper, 0));
    dpctx.fillStyle = g;
    dpctx.fillRect(0, 0, SPRITE_RES, SPRITE_RES);
  }

  // ---- the ELEV_HIGH stencil ------------------------------------------------
  // Alpha 1 over every cell a low viewer may not see into — the uphill veto,
  // baked once. Rasterised at the terrain grid's OWN resolution (one texel per
  // cell, so the loop is dim² frozen-query lookups rather than RES² and carries
  // exactly the same information), then upscaled and blurred into the full-res
  // stencil so the punched boundary is a soft pixel edge, never a stair-step.
  // `scratch` is free at boot, so neither step costs an extra canvas.
  const [highStencil, hsctx] = makeCanvas(RES);
  {
    const dim = terrain.grid.dim;
    const [cells, cctx] = makeCanvas(dim);
    const img = cctx.createImageData(dim, dim);
    for (let cz = 0; cz < dim; cz++) {
      const wz = (cz + 0.5) * (side / dim);
      for (let cx = 0; cx < dim; cx++) {
        if (elevationAt(terrain, (cx + 0.5) * (side / dim), wz) !== ELEV_HIGH) continue;
        img.data[(cz * dim + cx) * 4 + 3] = 255;
      }
    }
    cctx.putImageData(img, 0, 0);
    sctx.clearRect(0, 0, RES, RES);
    sctx.filter = `blur(${String(STENCIL_BLUR)}px)`;
    sctx.drawImage(cells, 0, 0, RES, RES);
    sctx.filter = 'none';
    hsctx.clearRect(0, 0, RES, RES);
    hsctx.drawImage(scratch, 0, 0);
  }

  // ---- boot-baked map-edge feather -----------------------------------------
  // The sheets are far larger than the map square and the mask is ClampToEdge,
  // so the border texels stretch over every out-of-bounds metre of ground.
  // featherErase ramps alpha 1 at the outermost texel to 0 across a wobbling
  // ~FEATHER band; featherDim lays DIM_ALPHA back underneath it. Result: `mask`
  // ends at exactly DIM_ALPHA (dim dusk outskirts — never transparent, or lit
  // ground ghosts through; never opaque, or the world ends as a pitch island)
  // and `hard` dissolves to clear instead of stopping on a straight line.
  // Baked ONCE: a per-update ImageData pass at 512² dominated the 5 Hz cost.
  const [featherErase, fectx] = makeCanvas(RES);
  const [featherDim, fdctx] = makeCanvas(RES);
  {
    const band = FEATHER + FEATHER_WOBBLE + 1;
    const eraseImg = fectx.createImageData(RES, RES);
    const dimImg = fdctx.createImageData(RES, RES);
    const sr = parseInt(APAL.shroud.slice(1, 3), 16);
    const sg = parseInt(APAL.shroud.slice(3, 5), 16);
    const sb = parseInt(APAL.shroud.slice(5, 7), 16);
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
          eraseImg.data[i + 3] = Math.round(p * 255);
          dimImg.data[i] = sr;
          dimImg.data[i + 1] = sg;
          dimImg.data[i + 2] = sb;
          dimImg.data[i + 3] = Math.round(p * DIM_ALPHA * 255);
        }
      }
    }
    fectx.putImageData(eraseImg, 0, 0);
    fdctx.putImageData(dimImg, 0, 0);
  }

  /** Apply the baked feather — always the LAST compose step on a canvas.
   *  `withDim`: `mask` (border -> DIM_ALPHA) vs `hard` (border -> clear). */
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

  // boot state: nothing explored anywhere (outskirts dim per the feather law)
  mctx.fillStyle = APAL.shroud;
  mctx.fillRect(0, 0, RES, RES);
  feather(mctx, true);
  hctx.fillStyle = APAL.shroud;
  hctx.fillRect(0, 0, RES, RES);
  feather(hctx, false);

  // ---- terrain-conformal overlay sheets -------------------------------------
  /** Height the sheet must clear at (x,z): the MAX of five taps over ±H_TAP.
   *  A plain sample interpolates straight through a cliff face; the max makes
   *  the sheet take the step one quad early and ride the ridge instead. */
  function ridgeSafeHeight(x: number, z: number): number {
    let h = core.heightAt(x, z);
    const a = core.heightAt(x - H_TAP, z);
    if (a > h) h = a;
    const b = core.heightAt(x + H_TAP, z);
    if (b > h) h = b;
    const c = core.heightAt(x, z - H_TAP);
    if (c > h) h = c;
    const d = core.heightAt(x, z + H_TAP);
    if (d > h) h = d;
    return h;
  }

  /**
   * One overlay sheet in WORLD coordinates: the map square sampled every
   * `cellM` metres, plus SKIRT_RINGS of quadratically expanding quads out to
   * PLANE_SPAN so the sheet covers the entire visible ground disc. The skirt
   * densifies toward the map edge, where the height still varies, and its
   * vertices sample `heightAt` too — out of bounds that clamps to the nearest
   * in-bounds cell, so the sheet leaves the map at the height the map ends at
   * instead of dropping to y=0 and tearing away from the ground.
   *
   * `uv` maps the map square onto [0,1] of the mask — computed in GEOMETRY
   * SPACE, which is why no texture in this module sets `repeat` (the UV law).
   * v is flipped because a CanvasTexture uploads with flipY, so v=1 is canvas
   * row 0, which is world z=0. `uv1` carries the grain tile, in metres/tile.
   */
  function buildSheet(lift: number, tileM: number, cellM: number): THREE.BufferGeometry {
    const inner = Math.max(8, Math.round(side / cellM));
    const margin = (side * (PLANE_SPAN - 1)) / 2;
    const n = SKIRT_RINGS * 2 + inner + 1;
    const axis = new Float64Array(n);
    for (let k = 0; k < SKIRT_RINGS; k++) {
      const t = (SKIRT_RINGS - k) / SKIRT_RINGS;
      const d = margin * t * t;
      axis[k] = -d;
      axis[n - 1 - k] = side + d;
    }
    for (let i = 0; i <= inner; i++) axis[SKIRT_RINGS + i] = (i * side) / inner;

    const vertCount = n * n;
    const pos = new Float32Array(vertCount * 3);
    const uv = new Float32Array(vertCount * 2);
    const uv1 = new Float32Array(vertCount * 2);
    let p = 0;
    let q = 0;
    for (let r = 0; r < n; r++) {
      const z = axis[r] ?? 0;
      for (let c = 0; c < n; c++) {
        const x = axis[c] ?? 0;
        pos[p] = x;
        pos[p + 1] = ridgeSafeHeight(x, z) + lift;
        pos[p + 2] = z;
        p += 3;
        uv[q] = x / side;
        uv[q + 1] = 1 - z / side;
        uv1[q] = x / tileM;
        uv1[q + 1] = z / tileM;
        q += 2;
      }
    }

    const quads = (n - 1) * (n - 1);
    const idx = new Uint32Array(quads * 6);
    let t = 0;
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const a = r * n + c;
        const b = a + 1;
        const d = a + n;
        const e = d + 1;
        // winding chosen so computeVertexNormals yields +Y (checked by hand:
        // cross(pC-pB, pA-pB) = (0, dx*dz, 0) for both triangles)
        idx[t] = a;
        idx[t + 1] = d;
        idx[t + 2] = b;
        idx[t + 3] = b;
        idx[t + 4] = d;
        idx[t + 5] = e;
        t += 6;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    // VERTEX-COLOUR LAW (GRAPHICS_CONTRACT §2): this geometry never passes
    // through the kit's bake(), and every kit material is vertexColors:true —
    // without the neutral white attribute both sheets render black.
    whiteVertexColors(geo);
    geo.computeBoundingSphere();
    return geo;
  }

  // ---- textures -------------------------------------------------------------
  const maskTex = new THREE.CanvasTexture(mask);
  maskTex.colorSpace = THREE.SRGBColorSpace;
  const hardTex = new THREE.CanvasTexture(hard);
  hardTex.colorSpace = THREE.SRGBColorSpace;
  /** Two independent textures over the ONE grain canvas, so each sheet can
   *  drift its own offset. LINEAR (`NoColorSpace`): the painted greyscale is a
   *  raw multiplier on the emissive, and an sRGB decode would skew it dark and
   *  break the mean the emissive solve divides out. Channel 1 = the `uv1`
   *  attribute built above; the UV law is satisfied in geometry space, so
   *  neither texture touches `repeat`. */
  function grainTexture(): THREE.CanvasTexture {
    const tex = new THREE.CanvasTexture(grainTile);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.channel = 1;
    return tex;
  }
  const lowGrain = grainTexture();
  const highGrain = grainTexture();

  // ---- materials ------------------------------------------------------------
  /** The overlay material: a CLONE of the kit's cloth-in-shroud surface. Cloned
   *  because `surface()` caches per (id, tint) and every banner and tabard in
   *  the game shares that instance — mutating it here would drag them all into
   *  transparency. The clone sets only overlay state the surface table does not
   *  describe; roughness, metalness and albedo remain the table's.
   *
   *  `normalMap = null` is not a preference, it is forced: the kit caches its
   *  generated maps, so the weave texture on this material is the SAME object
   *  every banner samples, and the only way to give it a sane world density
   *  here would be to move it onto channel 1 — mutating shared state. A weave
   *  relief on atmosphere is the UI-lid read anyway; the drifting grain carries
   *  all of this surface's structure. */
  function overlayMaterial(
    mapTex: THREE.CanvasTexture,
    grain: THREE.CanvasTexture,
    shroudHex: string,
  ): THREE.MeshStandardMaterial {
    const m = surface('cloth', APAL.shroud).clone();
    m.name = 'rift:fogOverlay';
    m.map = mapTex;
    m.normalMap = null;
    m.envMapIntensity = 0;
    m.emissive.set(shroudHex);
    m.emissiveMap = grain;
    m.emissiveIntensity = 1 / GRAIN_MEAN; // re-solved against exposure below
    m.transparent = true;
    m.depthWrite = false;
    m.fog = false;
    m.needsUpdate = true;
    return m;
  }
  const lowMat = overlayMaterial(maskTex, lowGrain, mix(APAL.shroud, APAL.dirtLit, WARM_DIM));
  const highMat = overlayMaterial(hardTex, highGrain, APAL.shroud);

  function addSheet(
    geo: THREE.BufferGeometry,
    mat: THREE.MeshStandardMaterial,
    order: number,
  ): void {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = order;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Emissive, and deliberately NOT markBloom()'d: the shroud is darkness, not
    // a light source, and hazing the frame with it is the amateur bloom tell
    // STYLE_BIBLE §6 bans.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    core.three.add(mesh);
  }
  addSheet(buildSheet(LOW_LIFT, LOW_TILE_M, LOW_CELL_M), lowMat, LOW_ORDER);
  addSheet(buildSheet(HIGH_LIFT, HIGH_TILE_M, HIGH_CELL_M), highMat, HIGH_ORDER);

  // ---- frame hook: mist drift + the exposure solve --------------------------
  // Allocation-free by construction: four float adds, two texture offsets, and
  // two writes that only happen on the frames where R_SCENE actually moves the
  // exposure ramp (setTimeOfDay, 2.75 day -> 1.9 night).
  let lastExposure = -1;
  core.addFrameHook((dtMs: number) => {
    const exposure = core.renderer.toneMappingExposure;
    if (exposure > 0 && exposure !== lastExposure) {
      lastExposure = exposure;
      // emissive * intensity * grainMean * exposure == linear(APAL.shroud)
      const k = 1 / (exposure * GRAIN_MEAN);
      lowMat.emissiveIntensity = k;
      highMat.emissiveIntensity = k;
    }
    const dt = dtMs * 0.001;
    let lu = lowGrain.offset.x + (dt * LOW_DRIFT_X) / LOW_TILE_M;
    let lv = lowGrain.offset.y + (dt * LOW_DRIFT_Z) / LOW_TILE_M;
    let hu = highGrain.offset.x + (dt * HIGH_DRIFT_X) / HIGH_TILE_M;
    let hv = highGrain.offset.y + (dt * HIGH_DRIFT_Z) / HIGH_TILE_M;
    // keep the offsets inside one tile forever — an unbounded accumulator loses
    // float precision over a 30-minute match and the mist starts stepping
    if (lu > 1) lu -= 1;
    else if (lu < 0) lu += 1;
    if (lv > 1) lv -= 1;
    else if (lv < 0) lv += 1;
    if (hu > 1) hu -= 1;
    else if (hu < 0) hu += 1;
    if (hv > 1) hv -= 1;
    else if (hv < 0) hv += 1;
    lowGrain.offset.set(lu, lv);
    highGrain.offset.set(hu, hv);
  });

  // ---- live vision ----------------------------------------------------------
  const discPool: Disc[] = [];
  let discCount = 0;

  /** Next pooled Disc, growing the pool at most once per peak source count. */
  function pushDisc(): Disc {
    const held = discPool[discCount];
    discCount++;
    if (held !== undefined) return held;
    const fresh: Disc = { x: 0, z: 0, r: 0, r2: 0, low: false };
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
   *  Until one fires, every source in the snapshot counts, which is the
   *  behaviour of the previous build: over-generous for one frame, never a
   *  crash, and never a black screen. */
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

  function update(snap: SnapMsg): void {
    resolveSelfTeam(snap);
    const night = nightVisionScale(snap.dayPhase);

    // --- this team's living eyes, night-scaled, elevation resolved once ------
    discCount = 0;
    for (const e of snap.ents) {
      if (e.hp <= 0) continue;
      if (selfTeam !== null && e.team !== selfTeam) continue;
      const base = VISION[e.k];
      if (base <= 0) continue;
      const r = scalesAtNight(e.k) ? base * night : base;
      const d = pushDisc();
      d.x = e.x;
      d.z = e.z;
      d.r = r;
      const vr = r * VIS_R_FRACTION;
      d.r2 = vr * vr;
      d.low = elevationAt(terrain, e.x, e.z) !== ELEV_HIGH;
    }

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
    // re-covers. The LIVE pass above deliberately does NOT skip: a player who
    // can see nothing is a worse failure than a player who explored 200 ms late.
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

    // --- the shared mask (the minimap reads this canvas) ---------------------
    // shroud everywhere, punched to DIM_ALPHA by the blurred explored memory
    // and to 0 by live vision — both ramps span many texels, never a cliff.
    mctx.globalCompositeOperation = 'source-over';
    mctx.globalAlpha = 1;
    mctx.fillStyle = APAL.shroud;
    mctx.fillRect(0, 0, RES, RES);
    mctx.globalCompositeOperation = 'destination-out';
    mctx.globalAlpha = 1 - DIM_ALPHA;
    mctx.drawImage(blurBuf, 0, 0, RES, RES);
    mctx.globalAlpha = 1;
    mctx.drawImage(visNow, 0, 0);
    mctx.globalCompositeOperation = 'source-over';

    // --- the high shroud: opaque only where never explored -------------------
    hctx.globalCompositeOperation = 'source-over';
    hctx.globalAlpha = 1;
    hctx.fillStyle = APAL.shroud;
    hctx.fillRect(0, 0, RES, RES);
    hctx.globalCompositeOperation = 'destination-out';
    hctx.drawImage(blurBuf, 0, 0, RES, RES);
    hctx.globalCompositeOperation = 'source-over';

    // finishing pass, LAST on both: the baked wobbling map-edge feather
    feather(mctx, true);
    feather(hctx, false);

    maskTex.needsUpdate = true;
    hardTex.needsUpdate = true;
  }

  /** Is this world point inside the team's live vision? Radius plus the uphill
   *  veto, which is the only one of the sim's three rules that is a function of
   *  POSITION alone. Concealment is not applied: it hides an entity from a
   *  distant enemy, and answering `false` here for an ally standing in a bush
   *  would hide something the server considers visible. Allocation-free — this
   *  runs on the FX and audio paths. */
  function isVisible(x: number, z: number): boolean {
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
  }

  return { maskCanvas: mask, update, isVisible };
}
