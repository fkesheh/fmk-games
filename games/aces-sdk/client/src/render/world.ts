// ============================================================================
// ACES — C_WORLD: sea / islands / surf / cloud-shadow world renderer.
//
// Owns everything BELOW the planes (sea, islands, airfields, sun treatment,
// glint shimmer, drifting cloud shadows, surf pulses) and the OCCLUDING
// cloud puffs ABOVE them (STYLE_BIBLE §3/§6, CONTRACT §5 C_WORLD).
//
// Architecture:
//   LAZY TILED BAKE — static world art (islands, airfields) is baked once
//   into offscreen tiles on first drawBelow (and after resize), at native
//   device resolution (bake scale = dpr × CAMERA.ZOOM_MAX, capped). Tiles
//   cover a uniform TILE_U grid but ONLY tiles holding content get a canvas,
//   and each canvas is CROPPED to its content bounding box — empty sea costs
//   zero memory. Baked tiles have TRANSPARENT sea background, so the live
//   sea pass (flat seaDeep fillRect + precomputed mottling blobs) continues
//   seamlessly underneath them: no tile seams are possible.
//
//   Everything animated is drawn LIVE from precomputed, packed data — glint
//   streaks, cloud-shadow puffs, surf pulse rings, sun glare, cloud layers —
//   with ZERO per-frame allocation: every color string, point array and puff
//   record is built once at init; frame loops touch numbers and cached
//   strings only (RULES 4).
//
// Art-law compliance: all color flows through PAL / withAlpha / shadeA with
// palette endpoints; the only gradients are softPuff's (§2); terrain carries
// no ink outlines (§2); no Math.random — makeRng/hashStr only (§9); island
// silhouettes come from Island.blob (shapes from map data, no second truth).
// ============================================================================

import type { CameraView } from '../contract/seams.js';
import type { AcesMap, Airfield, Island } from '@aces/shared/maps.js';
import { CAMERA, WORLD } from '@aces/shared/config.js';
import {
  PAL,
  hashStr,
  makeRng,
  poly,
  shadeA,
  softPuff,
  star,
  withAlpha,
} from '../contract/visual.js';

// ---- tunables (module-private; the frozen config has no world-art knobs) ----

/** Bake grid pitch, world units (~1024u squares per the C_WORLD brief). */
export const TILE_U = 1024;

/** Central open corridor (mirrors maps.ts buildMap LANE) — clouds thin here. */
const CORRIDOR_HALF = 340;

/**
 * Hard cap on bake pixel density. Ideal is dpr × CAMERA.ZOOM_MAX (= 2.3 at
 * dpr 2); the cap exists only as a sanity ceiling and sits ABOVE that ideal
 * so tiles are never upscaled at any legal camera state (§9: no smooth
 * upscale). Memory stays bounded because tile canvases are cropped to their
 * content bounding boxes, not full 1024u squares.
 */
const BAKE_SCALE_MAX = 2.35;

/** Surf / shore ring scales relative to Island.r (sand ×1.06 per brief). */
const SAND_SCALE = 1.06;
const SURF_A_SCALE = 1.115;
const SURF_B_SCALE = 1.175;

type Pt = [number, number];

// ============================================================================
// PURE tile-grid math (unit-tested; also drives the bake address space)
// ============================================================================

export interface TileGrid {
  readonly cols: number;
  readonly rows: number;
  readonly tileU: number;
  /** cols × rows — the upper bound before empty-sea skipping. */
  readonly count: number;
}

export function tileGrid(w: number, h: number, tileU: number = TILE_U): TileGrid {
  const cols = Math.max(1, Math.ceil(w / tileU));
  const rows = Math.max(1, Math.ceil(h / tileU));
  return { cols, rows, tileU, count: cols * rows };
}

/** World-space rectangle the camera sees (ctx is already camera-transformed). */
export interface ViewRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export function viewRect(cam: CameraView, wCss: number, hCss: number): ViewRect {
  const hw = wCss / (2 * cam.zoom);
  const hh = hCss / (2 * cam.zoom);
  return { x0: cam.x - hw, y0: cam.y - hh, x1: cam.x + hw, y1: cam.y + hh };
}

/** Ascending tile indices touching [x0,x1)×[y0,y1), clipped to the grid. */
export function tileIndicesInRect(r: ViewRect, g: TileGrid): number[] {
  const c0 = clampCol(Math.floor(r.x0 / g.tileU), g);
  const c1 = clampCol(Math.floor((r.x1 - 1e-4) / g.tileU), g);
  const rw0 = clampRow(Math.floor(r.y0 / g.tileU), g);
  const rw1 = clampRow(Math.floor((r.y1 - 1e-4) / g.tileU), g);
  const out: number[] = [];
  for (let row = rw0; row <= rw1; row++) {
    for (let col = c0; col <= c1; col++) out.push(col + row * g.cols);
  }
  return out;
}

function clampCol(c: number, g: TileGrid): number {
  return Math.max(0, Math.min(g.cols - 1, c));
}
function clampRow(r: number, g: TileGrid): number {
  return Math.max(0, Math.min(g.rows - 1, r));
}

/**
 * Tile indices holding static content (islands + airfields), with margin for
 * surf rings and palm overhang. All OTHER tiles are empty sea — skipped by
 * the bake entirely (the brief's "skip empty-sea tiles").
 */
export function contentTileIndices(map: AcesMap, g: TileGrid): number[] {
  const found = new Set<number>();
  const acc = (x0: number, y0: number, x1: number, y1: number): void => {
    for (const i of tileIndicesInRect({ x0, y0, x1, y1 }, g)) found.add(i);
  };
  for (const isl of map.islands) {
    const m = isl.r * 1.32;
    acc(isl.x - m, isl.y - m, isl.x + m, isl.y + m);
  }
  for (const f of map.fields) {
    acc(f.x - 280, f.y - 280, f.x + 280, f.y + 280);
  }
  return [...found].sort((a, b) => a - b);
}

// ============================================================================
// PURE cloud-layout builder (unit-tested; consumed by drawAbove)
// ============================================================================

export interface Puff {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  /** Peak per-puff alpha — STYLE_BIBLE §6 caps cloud puffs at 0.78. */
  readonly alpha: number;
  readonly inner: string;
  readonly outer: string;
}

export interface CloudLayer {
  /** Parallax factor vs camera drift: offset = cam.x * (1 - par). */
  readonly par: number;
  /** Constant eastward drift, u/s. */
  readonly speed: number;
  /** Horizontal wrap span padding, u each side of the map. */
  readonly margin: number;
  readonly puffs: readonly Puff[];
}

export interface CloudStack {
  readonly far: CloudLayer;
  readonly near: CloudLayer;
}

const CLOUD_MARGIN = 700;
/** Deterministic global-coverage prune target (viewport law needs ≤0.35). */
const COVERAGE_TARGET = 0.3;

/**
 * Two parallax puff layers, deterministic from `seed` (production passes
 * hashStr('clouds')). Jittered-grid placement keeps coverage bounded;
 * the central corridor (|y − H/2| < 340) is thinned in both count and size
 * so head-on duels are never hidden (STYLE_BIBLE §6).
 */
export function buildCloudLayers(seed: number, mapW: number = WORLD.W, mapH: number = WORLD.H): CloudStack {
  const rng = makeRng(seed >>> 0);
  const far = buildLayer(rng, mapW, mapH, {
    cell: 560,
    keep: 0.4,
    rMin: 55,
    rMax: 105,
    aMin: 0.34,
    aMax: 0.5,
    par: 0.85,
    speed: 9,
  });
  const near = buildLayer(rng, mapW, mapH, {
    cell: 640,
    keep: 0.36,
    rMin: 85,
    rMax: 150,
    aMin: 0.45,
    aMax: 0.62,
    par: 1.0,
    speed: 14,
  });
  pruneToCoverage([...far.puffs, ...near.puffs], mapW, mapH);
  return { far, near };
}

interface LayerSpec {
  cell: number;
  keep: number;
  rMin: number;
  rMax: number;
  aMin: number;
  aMax: number;
  par: number;
  speed: number;
}

function buildLayer(rng: () => number, mapW: number, mapH: number, spec: LayerSpec): CloudLayer {
  const x0 = -CLOUD_MARGIN;
  const y0 = -CLOUD_MARGIN;
  const gw = mapW + CLOUD_MARGIN * 2;
  const gh = mapH + CLOUD_MARGIN * 2;
  const cols = Math.ceil(gw / spec.cell);
  const rows = Math.ceil(gh / spec.cell);
  const puffs: Puff[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = x0 + (col + 0.5) * spec.cell;
      const cy = y0 + (row + 0.5) * spec.cell;
      const inCorridor = Math.abs(cy - mapH / 2) < CORRIDOR_HALF;
      const keep = spec.keep * (inCorridor ? 0.62 : 1);
      if (rng() >= keep) continue;
      const rBase = spec.rMin + rng() * (spec.rMax - spec.rMin);
      const r = rBase * (inCorridor ? 0.72 : 1);
      const aBase = (spec.aMin + rng() * (spec.aMax - spec.aMin)) * (inCorridor ? 0.85 : 1);
      const px = cx + (rng() - 0.5) * spec.cell * 0.8;
      const py = cy + (rng() - 0.5) * spec.cell * 0.8;
      const sub = 2 + Math.floor(rng() * 3); // 2–4 overlapping masses per cloud
      for (let s = 0; s < sub; s++) {
        const ang = rng() * Math.PI * 2;
        const dist = Math.sqrt(rng()) * r * 0.55;
        const rr = r * (0.55 + rng() * 0.5);
        // clamp: thin enough to see through (§6 ≤0.78), strong enough to
        // visibly occlude what's beneath (D4)
        const alpha = Math.max(0.3, Math.min(0.62, aBase * (0.75 + rng() * 0.35)));
        // paper ↔ dawnHi mixes are expressed ACROSS puffs (which key a puff
        // uses), never as ad-hoc color math — kit law (RULES 2).
        const key = rng() < 0.6 ? 'paper' : 'dawnHi';
        puffs.push({
          x: px + Math.cos(ang) * dist,
          y: py + Math.sin(ang) * dist,
          r: rr,
          alpha,
          inner: withAlpha(key, alpha),
          outer: withAlpha(key, 0),
        });
      }
    }
  }
  return { par: spec.par, speed: spec.speed, margin: CLOUD_MARGIN, puffs };
}

/** Deterministic prune (highest-index first) until coverage fits the target. */
function pruneToCoverage(all: Puff[], mapW: number, mapH: number): void {
  let area = 0;
  for (const p of all) area += Math.PI * p.r * p.r;
  let limit = all.length;
  while (area / (mapW * mapH) > COVERAGE_TARGET && limit > 0) {
    limit--;
    area -= Math.PI * all[limit]!.r * all[limit]!.r;
  }
  all.length = limit;
}

/** Corridor-vs-open-sea puff density stats (test + debug surface). */
export function corridorStats(
  puffs: readonly Puff[],
  mapW: number = WORLD.W,
  mapH: number = WORLD.H,
): { corridorDensity: number; outerDensity: number } {
  let inCount = 0;
  let inArea = 0;
  let outCount = 0;
  let outArea = 0;
  for (const p of puffs) {
    const a = Math.PI * p.r * p.r;
    if (Math.abs(p.y - mapH / 2) < CORRIDOR_HALF) {
      inCount++;
      inArea += a;
    } else {
      outCount++;
      outArea += a;
    }
  }
  return {
    corridorDensity: inArea / Math.max(1, mapW * CORRIDOR_HALF * 2),
    outerDensity: outArea / Math.max(1, mapW * (mapH - CORRIDOR_HALF * 2)),
  };
}

// ============================================================================
// Renderer
// ============================================================================

interface BakeTile {
  x: number;
  y: number;
  w: number;
  h: number;
  canvas: HTMLCanvasElement;
}

interface MottlePatch {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  pts: Pt[];
  style: string;
}

interface GlintStreak {
  x: number;
  y: number;
  len: number;
  ang: number;
  phase: number;
  speed: number;
  w: number;
  aIdx: number; // peak-alpha bucket into GLINT_STYLES
}

interface ShadowBlob {
  bx: number;
  by: number;
  r: number;
  spd: number;
  ph: number;
}

interface PalmDeco {
  x: number;
  y: number;
  r: number;
  rot: number;
}

interface RockDeco {
  body: Pt[];
  east: Pt[];
  hi: Pt[];
}

interface IslandDeco {
  sand: Pt[];
  wet: Pt[];
  scrubOut: Pt[];
  scrubIn: Pt[];
  surfA: Pt[];
  surfB: Pt[];
  palms: PalmDeco[];
  rocks: RockDeco[];
}

/** Quantized animated alpha styles — built once, referenced by index. */
const GLINT_STYLES: string[] = [];
const SURF_STYLES: string[] = [];
const SHADOW_INNER = withAlpha('seaDark', 0.22);
const SHADOW_OUTER = withAlpha('seaDark', 0);
for (let i = 0; i < 10; i++) GLINT_STYLES.push(withAlpha('seaLit', 0.05 + (i / 9) * 0.25));
for (let i = 0; i < 12; i++) SURF_STYLES.push(withAlpha('foam', 0.25 + (i / 11) * 0.15));

/** West map-edge sun treatment (STYLE_BIBLE §3) — softPuff glow column. */
const GLARE_X1 = 720;
const GLARE_PUFFS: ReadonlyArray<{ x: number; y: number; r: number; c: string }> = (() => {
  const list: { x: number; y: number; r: number; c: string }[] = [];
  list.push({ x: 70, y: WORLD.H * 0.42, r: 250, c: withAlpha('sunGlare', 0.5) });
  list.push({ x: 70, y: WORLD.H * 0.42, r: 430, c: withAlpha('sunGlare', 0.2) });
  list.push({ x: 70, y: WORLD.H * 0.42, r: 120, c: withAlpha('flash', 0.28) });
  for (let i = 0; i < 4; i++) {
    list.push({
      x: 150,
      y: (WORLD.H / 4) * (i + 0.5),
      r: 320,
      c: withAlpha('haze', 0.1),
    });
  }
  return list;
})();

export function createWorldRenderer(canvas: HTMLCanvasElement, map: AcesMap): WorldRenderer {
  const doc = canvas.ownerDocument;

  // ---- screen state ---------------------------------------------------------
  let wCss = 0;
  let hCss = 0;
  let dpr = 1;
  let bakeDirty = true;
  let bakeScale = 1;
  let bakeTiles: BakeTile[] = [];

  // ---- precomputed world dressing (init-time, immutable afterwards) ----------
  const rng = makeRng(hashStr(`world:${map.seed}`));

  const islandDecos: IslandDeco[] = map.islands.map((isl) => ({
    sand: blobPts(isl, SAND_SCALE, 0, 0),
    wet: blobPts(isl, 1.02, 0.05, 1),
    scrubOut: blobPts(isl, 0.84, 0.1, 2),
    scrubIn: blobPts(isl, 0.6, -0.14, 3),
    surfA: blobPts(isl, SURF_A_SCALE, 0, 0),
    surfB: blobPts(isl, SURF_B_SCALE, 0, 0),
    palms: isl.palms.map((p) => ({
      x: isl.x + p.x,
      y: isl.y + p.y,
      // map scale × seeded ±30 % (STYLE_BIBLE §6 variation law)
      r: (9 + 10 * p.s) * (0.7 + rng() * 0.6),
      rot: rng() * Math.PI * 2,
    })),
    rocks: isl.rocks.map((rk) => rockPts(isl.x + rk.x, isl.y + rk.y, 20 * rk.s)),
  }));

  const mottles: MottlePatch[] = [];
  {
    const mrng = makeRng(hashStr(`sea:${map.seed}`));
    const tones = [
      withAlpha('seaLit', 0.15),
      withAlpha('seaDark', 0.18),
      withAlpha('seaLit', 0.1),
      withAlpha('seaDark', 0.13),
    ];
    for (let k = 0; k < 120; k++) {
      const cx = -400 + mrng() * (map.w + 800);
      const cy = -400 + mrng() * (map.h + 800);
      const rad = 160 + mrng() * 260;
      const squash = 0.55 + mrng() * 0.45;
      const rot = mrng() * Math.PI * 2;
      const pts = irregularBlob(cx, cy, rad, squash, rot, 8 + Math.floor(mrng() * 4), mrng, 0.35);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of pts) {
        if (p[0] < minX) minX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] > maxY) maxY = p[1];
      }
      mottles.push({ minX, minY, maxX, maxY, pts, style: tones[k % tones.length]! });
    }
  }

  // Sun-glint shimmer band, west half of the map (packed, culled per frame).
  const glints: GlintStreak[] = [];
  {
    const grng = makeRng(hashStr(`glint:${map.seed}`));
    for (let k = 0; k < 110; k++) {
      glints.push({
        x: 60 + grng() * (map.w / 2 - 60),
        y: grng() * map.h,
        len: 24 + grng() * 60,
        ang: (grng() - 0.5) * 0.12,
        phase: grng() * Math.PI * 2,
        speed: 0.6 + grng() * 1.1,
        w: 1.5 + grng() * 1.6,
        aIdx: Math.floor(grng() * GLINT_STYLES.length),
      });
    }
  }

  // Drifting cloud shadows on the sea (STYLE_BIBLE §3: seaDark, α ≤ 0.25).
  const shadows: ShadowBlob[] = [];
  {
    const srng = makeRng(hashStr(`shadow:${map.seed}`));
    const n = 5 + Math.floor(srng() * 3); // 5–7
    for (let k = 0; k < n; k++) {
      shadows.push({
        bx: srng() * map.w,
        by: srng() * map.h,
        r: 160 + srng() * 190,
        spd: 8 + srng() * 14,
        ph: srng() * Math.PI * 2,
      });
    }
  }

  const clouds = buildCloudLayers(hashStr('clouds'), map.w, map.h);

  // ---- bake -------------------------------------------------------------------

  function resize(w: number, h: number, newDpr: number): void {
    if (w === wCss && h === hCss && newDpr === dpr) return;
    wCss = w;
    hCss = h;
    dpr = newDpr;
    bakeDirty = true;
  }

  function rebuild(): void {
    bakeScale = Math.min(dpr * CAMERA.ZOOM_MAX, BAKE_SCALE_MAX);
    const grid = tileGrid(map.w, map.h, TILE_U);

    // Grow one cropped union-rect per touched tile, clamped to the tile.
    interface Union {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      islands: number[];
      fields: number[];
    }
    const unions = new Map<number, Union>();
    const grow = (
      key: number,
      col: number,
      row: number,
      bx0: number,
      by0: number,
      bx1: number,
      by1: number,
      kind: 'island' | 'field',
      idx: number,
    ): void => {
      const tx0 = col * TILE_U;
      const ty0 = row * TILE_U;
      let u = unions.get(key);
      if (!u) {
        u = { x0: tx0, y0: ty0, x1: tx0, y1: ty0, islands: [], fields: [] };
        unions.set(key, u);
      }
      u.x0 = Math.min(u.x0, Math.max(tx0, bx0));
      u.y0 = Math.min(u.y0, Math.max(ty0, by0));
      u.x1 = Math.max(u.x1, Math.min(tx0 + TILE_U, bx1));
      u.y1 = Math.max(u.y1, Math.min(ty0 + TILE_U, by1));
      if (kind === 'island') u.islands.push(idx);
      else u.fields.push(idx);
    };

    map.islands.forEach((isl, idx) => {
      const m = isl.r * SAND_SCALE + 90;
      const bx0 = isl.x - m;
      const by0 = isl.y - m;
      const bx1 = isl.x + m;
      const by1 = isl.y + m;
      const c0 = clampCol(Math.floor(bx0 / TILE_U), grid);
      const c1 = clampCol(Math.floor(bx1 / TILE_U), grid);
      const r0 = clampRow(Math.floor(by0 / TILE_U), grid);
      const r1 = clampRow(Math.floor(by1 / TILE_U), grid);
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          grow(col + row * grid.cols, col, row, bx0, by0, bx1, by1, 'island', idx);
        }
      }
    });

    map.fields.forEach((f, idx) => {
      const bx0 = f.x - 280;
      const by0 = f.y - 280;
      const bx1 = f.x + 280;
      const by1 = f.y + 280;
      const c0 = clampCol(Math.floor(bx0 / TILE_U), grid);
      const c1 = clampCol(Math.floor(bx1 / TILE_U), grid);
      const r0 = clampRow(Math.floor(by0 / TILE_U), grid);
      const r1 = clampRow(Math.floor(by1 / TILE_U), grid);
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          grow(col + row * grid.cols, col, row, bx0, by0, bx1, by1, 'field', idx);
        }
      }
    });

    bakeTiles = [];
    for (const u of unions.values()) {
      const cw = Math.max(1, Math.ceil((u.x1 - u.x0) * bakeScale));
      const ch = Math.max(1, Math.ceil((u.y1 - u.y0) * bakeScale));
      const cv = doc.createElement('canvas');
      cv.width = cw;
      cv.height = ch;
      const g = cv.getContext('2d');
      if (!g) continue;
      g.setTransform(bakeScale, 0, 0, bakeScale, -u.x0 * bakeScale, -u.y0 * bakeScale);
      for (const ii of u.islands) {
        const d = islandDecos[ii];
        if (d) paintIsland(g, d);
      }
      for (const fi of u.fields) {
        const f = map.fields[fi];
        if (f) paintField(g, f);
      }
      bakeTiles.push({ x: u.x0, y: u.y0, w: u.x1 - u.x0, h: u.y1 - u.y0, canvas: cv });
    }
    bakeDirty = false;
  }

  // ---- drawBelow ----------------------------------------------------------------

  function drawBelow(ctx: CanvasRenderingContext2D, cam: CameraView, t: number): void {
    if (wCss <= 0 || hCss <= 0) return;
    const vr = viewRect(cam, wCss, hCss);

    // 1. sea base — one flat fill, infinite beyond the map rim.
    ctx.fillStyle = PAL.seaDeep;
    ctx.fillRect(vr.x0, vr.y0, vr.x1 - vr.x0, vr.y1 - vr.y0);

    if (bakeDirty) rebuild();

    // 2. sea mottling — seeded irregular blobs, never rectangles (§6).
    for (let i = 0; i < mottles.length; i++) {
      const m = mottles[i]!;
      if (m.maxX < vr.x0 || m.minX > vr.x1 || m.maxY < vr.y0 || m.minY > vr.y1) continue;
      ctx.fillStyle = m.style;
      poly(ctx, m.pts);
      ctx.fill();
    }

    // 3. baked content tiles — native-res blit, NO smooth upscale (§9).
    const prevSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < bakeTiles.length; i++) {
      const b = bakeTiles[i]!;
      if (b.x + b.w < vr.x0 || b.x > vr.x1 || b.y + b.h < vr.y0 || b.y > vr.y1) continue;
      ctx.drawImage(b.canvas, b.x, b.y, b.w, b.h);
    }
    ctx.imageSmoothingEnabled = prevSmoothing;

    // 4. west-edge sun treatment (disc + haze wash), subtle (§3).
    if (vr.x0 < GLARE_X1) {
      for (let i = 0; i < GLARE_PUFFS.length; i++) {
        const p = GLARE_PUFFS[i]!;
        softPuff(ctx, p.x, p.y, p.r, p.c, SHADOW_OUTER);
      }
    }

    // 5. glint shimmer — thin seaLit streaks, alpha oscillating with t (§6).
    ctx.lineCap = 'round';
    for (let i = 0; i < glints.length; i++) {
      const s = glints[i]!;
      const osc = 0.5 + 0.5 * Math.sin(t * s.speed + s.phase);
      if (osc < 0.25) continue;
      if (s.y < vr.y0 - 40 || s.y > vr.y1 + 40) continue;
      if (s.x < vr.x0 - 90 || s.x > vr.x1 + 90) continue;
      const dx = Math.cos(s.ang) * s.len;
      const dy = Math.sin(s.ang) * s.len;
      ctx.strokeStyle = GLINT_STYLES[Math.min(GLINT_STYLES.length - 1, Math.round(s.aIdx * osc))]!;
      ctx.lineWidth = s.w;
      ctx.beginPath();
      ctx.moveTo(s.x - dx / 2, s.y - dy / 2);
      ctx.lineTo(s.x + dx / 2, s.y + dy / 2);
      ctx.stroke();
    }

    // 6. cloud shadows drifting east, faint high-altitude parallax (§3).
    const shadowSpan = map.w + 1200;
    const parX = (cam.x - map.w / 2) * 0.05;
    for (let i = 0; i < shadows.length; i++) {
      const s = shadows[i]!;
      let sx = (s.bx + t * s.spd + 600) % shadowSpan;
      if (sx < 0) sx += shadowSpan;
      sx -= 600;
      const sy = s.by + Math.sin(t * 0.11 + s.ph) * 40;
      if (sx + s.r < vr.x0 || sx - s.r > vr.x1 || sy + s.r < vr.y0 || sy - s.r > vr.y1) continue;
      softPuff(ctx, sx + parX, sy, s.r, SHADOW_INNER, SHADOW_OUTER);
    }

    // 7. surf pulse rings at every island rim (§6: foam, 0.25 + 0.15·sin).
    for (let i = 0; i < islandDecos.length; i++) {
      const d = islandDecos[i]!;
      const isl = map.islands[i]!;
      const reach = isl.r * SURF_B_SCALE + 14;
      if (isl.x + reach < vr.x0 || isl.x - reach > vr.x1) continue;
      if (isl.y + reach < vr.y0 || isl.y - reach > vr.y1) continue;
      const a1 = Math.round(((Math.sin(t * 1.3 + i * 1.7) + 1) / 2) * 11);
      const a2 = Math.round(((Math.sin(t * 1.3 + i * 1.7 + Math.PI) + 1) / 2) * 11);
      ctx.strokeStyle = SURF_STYLES[a1]!;
      ctx.lineWidth = 5;
      poly(ctx, d.surfA);
      ctx.stroke();
      ctx.strokeStyle = SURF_STYLES[a2]!;
      ctx.lineWidth = 3;
      poly(ctx, d.surfB);
      ctx.stroke();
    }
  }

  // ---- drawAbove ------------------------------------------------------------------

  function drawAbove(ctx: CanvasRenderingContext2D, cam: CameraView, t: number): void {
    if (wCss <= 0 || hCss <= 0) return;
    const vr = viewRect(cam, wCss, hCss);
    drawCloudLayer(ctx, clouds.far, cam, t, vr);
    drawCloudLayer(ctx, clouds.near, cam, t, vr);
  }

  function drawCloudLayer(
    ctx: CanvasRenderingContext2D,
    layer: CloudLayer,
    cam: CameraView,
    t: number,
    vr: ViewRect,
  ): void {
    const span = map.w + layer.margin * 2;
    const shift = cam.x * (1 - layer.par); // parallax vs camera drift
    const drift = t * layer.speed;
    const pad = 170; // max puff radius + slack
    const puffs = layer.puffs;
    for (let i = 0; i < puffs.length; i++) {
      const p = puffs[i]!;
      let px = (p.x + shift + drift + layer.margin) % span;
      if (px < 0) px += span;
      px -= layer.margin;
      if (px + p.r < vr.x0 - pad || px - p.r > vr.x1 + pad) continue;
      if (p.y + p.r < vr.y0 - pad || p.y - p.r > vr.y1 + pad) continue;
      softPuff(ctx, px, p.y, p.r, p.inner, p.outer);
    }
  }

  return { drawBelow, drawAbove, resize };
}

// ============================================================================
// Painters (used by the bake; world-unit space, palette-derived colors only)
// ============================================================================

function paintIsland(g: CanvasRenderingContext2D, d: IslandDeco): void {
  // static surf foot — a calm foam stroke just off the sand (pulse is live)
  g.strokeStyle = withAlpha('foam', 0.5);
  g.lineWidth = 6;
  poly(g, d.surfA);
  g.stroke();

  // sand ring ×1.06 with a wet-sand shadow tone at its inner edge (§2: one
  // shadow tone per object, terrain carries no ink outline)
  g.fillStyle = PAL.sand;
  poly(g, d.sand);
  g.fill();
  g.strokeStyle = shadeA('sand', -0.12);
  g.lineWidth = 4;
  poly(g, d.wet);
  g.stroke();

  // scrub fill — two tones of the same dry-grass mass
  g.fillStyle = PAL.scrub;
  poly(g, d.scrubOut);
  g.fill();
  g.fillStyle = shadeA('scrub', -0.1);
  poly(g, d.scrubIn);
  g.fill();

  // rock outcrops from Island.rocks — shaded polygons, sun west (§3)
  for (const rk of d.rocks) {
    g.fillStyle = shadeA('rock', -0.22); // east shadow facet
    poly(g, rk.east);
    g.fill();
    g.fillStyle = PAL.rock;
    poly(g, rk.body);
    g.fill();
    g.fillStyle = shadeA('rock', 0.14); // west highlight facet
    poly(g, rk.hi);
    g.fill();
  }

  // canopy palm clusters — star/circle marks, seeded scale ±30 % + rotation,
  // each with ONE shadow tone cast east (sun-west law)
  for (const p of d.palms) {
    g.fillStyle = shadeA('canopy', -0.28);
    g.beginPath();
    g.arc(p.x + p.r * 0.38, p.y + p.r * 0.28, p.r * 1.02, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = PAL.canopy;
    star(g, p.x, p.y, 6, p.r, p.r * 0.52, p.rot);
    g.fill();
    g.fillStyle = shadeA('canopy', 0.15);
    g.beginPath();
    g.arc(p.x - Math.cos(p.rot) * p.r * 0.2, p.y - Math.sin(p.rot) * p.r * 0.2, p.r * 0.3, 0, Math.PI * 2);
    g.fill();
  }
}

function paintField(g: CanvasRenderingContext2D, f: Airfield): void {
  const dirX = Math.cos(f.h);
  const dirY = Math.sin(f.h);
  const nx = -dirY;
  const ny = dirX;

  // graded strip — quiet landmark (§6), dope linen with grading tones
  const hl = 185;
  const hw = 26;
  const corners: Pt[] = [
    [f.x - dirX * hl - nx * hw, f.y - dirY * hl - ny * hw],
    [f.x + dirX * hl - nx * hw, f.y + dirY * hl - ny * hw],
    [f.x + dirX * hl + nx * hw, f.y + dirY * hl + ny * hw],
    [f.x - dirX * hl + nx * hw, f.y - dirY * hl + ny * hw],
  ];
  g.fillStyle = PAL.dope;
  poly(g, corners);
  g.fill();
  g.strokeStyle = shadeA('dope', -0.2);
  g.lineWidth = 3;
  poly(g, corners);
  g.stroke();
  g.strokeStyle = shadeA('dope', 0.16);
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(f.x - dirX * hl * 0.82, f.y - dirY * hl * 0.82);
  g.lineTo(f.x + dirX * hl * 0.82, f.y + dirY * hl * 0.82);
  g.stroke();

  // wind square — team color + letter R/I (identity never color alone, D4)
  const sq = 21;
  const wx = f.x + nx * -(hw + 48);
  const wy = f.y + ny * -(hw + 48);
  const sqPts: Pt[] = [
    [wx - dirX * sq - nx * sq, wy - dirY * sq - ny * sq],
    [wx + dirX * sq - nx * sq, wy + dirY * sq - ny * sq],
    [wx + dirX * sq + nx * sq, wy + dirY * sq + ny * sq],
    [wx - dirX * sq + nx * sq, wy - dirY * sq + ny * sq],
  ];
  g.fillStyle = f.team === 'royal' ? PAL.royalNavy : PAL.ironRed;
  poly(g, sqPts);
  g.fill();
  g.fillStyle = PAL.paper;
  g.font = '700 30px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(f.team === 'royal' ? 'R' : 'I', wx, wy + 2);

  // two parked dressing crates flanking the strip (map data positions)
  for (const c of f.parkedCrates) drawDressingCrate(g, c.x, c.y, f.h);
}

function drawDressingCrate(g: CanvasRenderingContext2D, x: number, y: number, h: number): void {
  const s = 10;
  const cs = Math.cos(h);
  const sn = Math.sin(h);
  const corner = (ox: number, oy: number): Pt => [x + cs * ox - sn * oy, y + sn * ox + cs * oy];
  const box: Pt[] = [corner(-s, -s), corner(s, -s), corner(s, s), corner(-s, s)];
  g.fillStyle = shadeA('wood', -0.22); // east shadow face
  poly(g, [corner(-s, -s), corner(s + 3, -s + 3), corner(s + 3, s + 3), corner(-s, s)]);
  g.fill();
  g.fillStyle = PAL.wood;
  poly(g, box);
  g.fill();
  g.strokeStyle = shadeA('wood', 0.18); // west-lit strap
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(x - cs * s, y - sn * s);
  g.lineTo(x + cs * s, y + sn * s);
  g.stroke();
  g.strokeStyle = shadeA('wood', -0.35); // rope cross
  g.beginPath();
  g.moveTo(x - sn * s, y + cs * s);
  g.lineTo(x + sn * s, y - cs * s);
  g.stroke();
}

// ============================================================================
// Seeded shape helpers (init-time only)
// ============================================================================

/** Island silhouette from its OWN blob data — no second source of truth. */
function blobPts(isl: Island, scale: number, rotOff: number, wobble: number): Pt[] {
  const n = isl.blob.length;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + rotOff;
    const spoke = isl.blob[((i % n) + n) % n] ?? 1;
    const wob = 1 + Math.sin(ang * 3 + wobble * 2.1) * 0.02 * wobble;
    const r = isl.r * scale * spoke * wob;
    pts.push([isl.x + Math.cos(ang) * r, isl.y + Math.sin(ang) * r]);
  }
  return pts;
}

function irregularBlob(
  cx: number,
  cy: number,
  r: number,
  squash: number,
  rot: number,
  n: number,
  rng: () => number,
  amp: number,
): Pt[] {
  const radii: number[] = [];
  for (let i = 0; i < n; i++) radii.push(1 - amp / 2 + rng() * amp);
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = radii[((i - 1 + n) % n)] ?? 1;
    const next = radii[(i + 1) % n] ?? 1;
    const rr = (((radii[i] ?? 1) + prev + next) / 3) * r;
    const a = rot + (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * squash]);
  }
  return pts;
}

function rockPts(cx: number, cy: number, r: number): RockDeco {
  const rng = makeRng(hashStr(`rock:${cx.toFixed(1)},${cy.toFixed(1)}`));
  const body: Pt[] = [];
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng() * 0.5;
    const rr = r * (0.72 + rng() * 0.5);
    body.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  const east: Pt[] = body.map((p) => [cx + (p[0] - cx) * 0.92 + r * 0.3, cy + (p[1] - cy) * 0.92 + r * 0.22]);
  const hi: Pt[] = body.map((p) => [cx + (p[0] - cx) * 0.45 - r * 0.22, cy + (p[1] - cy) * 0.45 - r * 0.16]);
  return { body, east, hi };
}

// ============================================================================
// Public surface (CONTRACT §5 C_WORLD / task brief — exact shape)
// ============================================================================

export interface WorldRenderer {
  drawBelow(ctx: CanvasRenderingContext2D, cam: CameraView, t: number): void;
  drawAbove(ctx: CanvasRenderingContext2D, cam: CameraView, t: number): void;
  resize(wCss: number, hCss: number, dpr: number): void;
}
