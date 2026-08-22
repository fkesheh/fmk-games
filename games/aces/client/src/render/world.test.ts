// ============================================================================
// ACES — C_WORLD tests (headless, PURE parts only — no canvas, no jsdom;
// mirrors games/splat/client/src/render/terrain.test.ts's approach of testing
// only the allocation-free geometry/layout layers and never touching DOM).
//
// Covered here:
//   · tile-grid coverage math on the real 4200×3000 map (grid shape,
//     viewport → tile indices incl. exact-multiple boundaries)
//   · empty-sea skipping: content tiles are a strict, deterministic subset
//   · cloud layout: seed determinism, corridor thinning (density ratio),
//     alpha caps (STYLE_BIBLE §6 ≤ 0.78), global coverage ≤ 35 %, parallax
//   · palette sanity: every APAL key this module renders with exists
// ============================================================================
import { describe, expect, it } from 'vitest';
import { WORLD } from '@aces/shared/config.js';
import { buildMap } from '@aces/shared/maps.js';
import { PAL, hashStr } from '../contract/visual.js';
import {
  TILE_U,
  buildCloudLayers,
  contentTileIndices,
  corridorStats,
  tileGrid,
  tileIndicesInRect,
  viewRect,
} from './world.js';

const GRID = tileGrid(WORLD.W, WORLD.H, TILE_U);

// ---------------------------------------------------------------------------
// Tile-grid coverage math
// ---------------------------------------------------------------------------
describe('tile-grid coverage math', () => {
  it('the 4200×3000 map cuts into a 5×3 grid of ~1024u squares', () => {
    expect(GRID.cols).toBe(5);
    expect(GRID.rows).toBe(3);
    expect(GRID.count).toBe(15);
    expect(GRID.tileU).toBe(TILE_U);
    // pitch really is ~1024u: the grid overshoots each axis by less than one tile
    expect(GRID.cols * TILE_U).toBeGreaterThanOrEqual(WORLD.W);
    expect((GRID.cols - 1) * TILE_U).toBeLessThan(WORLD.W);
    expect(GRID.rows * TILE_U).toBeGreaterThanOrEqual(WORLD.H);
    expect((GRID.rows - 1) * TILE_U).toBeLessThan(WORLD.H);
  });

  it('a centered 1600×1000 css viewport at zoom 1 sees exactly tiles [1,2,6,7]', () => {
    // cam at map center (2100, 1500); visible rect = [1300..2900]×[1000..2000]
    const cam = { x: WORLD.W / 2, y: WORLD.H / 2, zoom: 1 };
    const vr = viewRect(cam, 1600, 1000);
    expect(vr.x0).toBeCloseTo(1300, 6);
    expect(vr.y0).toBeCloseTo(1000, 6);
    expect(tileIndicesInRect(vr, GRID)).toEqual([1, 2, 6, 7]);
  });

  it('exact tile-multiple boundaries resolve by the half-open rule', () => {
    // rect starting exactly ON tile edges: [1024..3072]×[1024..2048]
    // → cols {1,2}, rows {1} → indices 6,7 (never bleeds into col/row 0)
    const vr = { x0: 1024, y0: 1024, x1: 3072, y1: 2048 };
    expect(tileIndicesInRect(vr, GRID)).toEqual([6, 7]);
  });

  it('viewport indices stay clamped when the camera hangs over the map rim', () => {
    const vr = { x0: -900, y0: -900, x1: 50, y1: 50 };
    expect(tileIndicesInRect(vr, GRID)).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// Content tiles vs skipped empty sea
// ---------------------------------------------------------------------------
describe('content-tile selection (skip empty-sea law)', () => {
  it('is deterministic for the frozen map seed', () => {
    expect(contentTileIndices(buildMap(), GRID)).toEqual(contentTileIndices(buildMap(), GRID));
  });

  it('covers both airfields (royal col0/row1, iron straddles cols3+4/row1)', () => {
    const idx = contentTileIndices(buildMap(), GRID);
    expect(idx).toContain(5); // royal field
    expect(idx).toContain(8); // iron field, west part
    expect(idx).toContain(9); // iron field spills past u=4096
  });

  it('is a strict subset of the grid — pure-sea tiles cost zero canvases', () => {
    const idx = contentTileIndices(buildMap(), GRID);
    expect(idx.length).toBeGreaterThan(0);
    expect(idx.length).toBeLessThan(GRID.count);
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]!).toBeGreaterThan(idx[i - 1]!); // sorted + unique
    }
    for (const i of idx) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(GRID.count);
    }
  });

  it('every island lands inside at least one selected tile (+surf margin)', () => {
    const map = buildMap();
    const idx = new Set(contentTileIndices(map, GRID));
    expect(map.islands.length).toBeGreaterThan(0);
    for (const isl of map.islands) {
      const m = isl.r * 1.32;
      const touched = tileIndicesInRect(
        { x0: isl.x - m, y0: isl.y - m, x1: isl.x + m, y1: isl.y + m },
        GRID,
      );
      expect(touched.length).toBeGreaterThan(0);
      for (const t of touched) expect(idx.has(t)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Cloud layout: determinism, thinning, caps, parallax
// ---------------------------------------------------------------------------
describe('cloud layout', () => {
  const CLOUDS_SEED = hashStr('clouds'); // the exact seed drawAbove uses
  const stack = buildCloudLayers(CLOUDS_SEED);
  const all = [...stack.far.puffs, ...stack.near.puffs];

  it('same seed ⇒ identical puff layout (positions, radii, colors)', () => {
    const a = buildCloudLayers(CLOUDS_SEED);
    const b = buildCloudLayers(CLOUDS_SEED);
    expect(a.far.puffs).toEqual(b.far.puffs);
    expect(a.near.puffs).toEqual(b.near.puffs);
  });

  it('a different seed moves puffs somewhere', () => {
    const other = buildCloudLayers(CLOUDS_SEED ^ 0x9e3779b9);
    expect(other.far.puffs).not.toEqual(stack.far.puffs);
  });

  it('parallax factors are exactly 0.85 (far) and 1.0 (near)', () => {
    expect(stack.far.par).toBe(0.85);
    expect(stack.near.par).toBe(1.0);
  });

  it(`every puff stays under the §6 alpha cap of 0.78 yet still occludes`, () => {
    expect(all.length).toBeGreaterThan(20);
    for (const p of all) {
      expect(p.alpha).toBeLessThanOrEqual(0.78);
      expect(p.alpha).toBeGreaterThanOrEqual(0.3); // visible occlusion, never a ghost
      expect(p.outer.endsWith('00')).toBe(true); // transparent rim — softPuff convention
    }
  });

  it('global cloud coverage stays within the 35 % viewport law with headroom', () => {
    let area = 0;
    for (const p of all) area += Math.PI * p.r * p.r;
    expect(area / (WORLD.W * WORLD.H)).toBeLessThanOrEqual(0.35);
    expect(area / (WORLD.W * WORLD.H)).toBeLessThan(0.33); // headroom for clustering
  });

  it('corridor thinning: |y−H/2|<340 is measurably sparser than open sea', () => {
    const stats = corridorStats(all);
    expect(stats.corridorDensity).toBeGreaterThan(0); // thinned, not emptied
    expect(stats.outerDensity).toBeGreaterThan(0);
    expect(stats.corridorDensity / stats.outerDensity).toBeLessThan(0.85);
  });
});

// ---------------------------------------------------------------------------
// Palette sanity — every key the renderer derives from must exist (compile-
// level guarantee backed by a runtime check on the frozen table).
// ---------------------------------------------------------------------------
describe('palette derivations are palette-typed', () => {
  it('all APAL keys used by world.ts exist and are hex strings', () => {
    const used = [
      'seaDeep',
      'seaLit',
      'seaDark',
      'foam',
      'sand',
      'scrub',
      'canopy',
      'rock',
      'dope',
      'wood',
      'paper',
      'dawnHi',
      'sunGlare',
      'haze',
      'flash',
      'royalNavy',
      'ironRed',
      'ink',
    ] as const;
    for (const k of used) {
      const v = (PAL as Record<string, unknown>)[k];
      expect(typeof v).toBe('string');
      expect(v as string).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
