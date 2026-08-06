// ============================================================================
// ANCIENTS (rift) — THE KIT'S GATE (GRAPHICS_CONTRACT §2).
//
// kit.ts is Layer-1 and is imported by every visual module in the game, so its
// laws have to be machine-checked rather than reviewed. What is asserted here
// is exactly what breaks silently if it regresses:
//
//   * DETERMINISM — rng() is the only randomness in the game; a drift here
//     makes two judge rounds of the same shot incomparable and the whole
//     screenshot loop meaningless.
//   * THE VERTEX-COLOUR LAW — every material has vertexColors: true, so a
//     geometry without a `color` attribute renders BLACK, and an AO pass that
//     replaces instead of multiplying silently does nothing. Both failures
//     have been seen in practice; both are asserted below.
//   * BUCKETING — one geometry per surface id is the entire draw-call budget
//     strategy (§5, <= 700 calls).
//   * SPACING — a Poisson-disc guarantee that degrades to uniform random is
//     invisible in code review and unmistakable on screen.
//   * NON-DEGENERACY — lathe/ribbon are the two factories that build geometry
//     from caller data rather than from a THREE primitive, so they are the two
//     that can emit zero-area triangles.
//
// This suite runs HEADLESS (node, no DOM). The texture generators therefore
// take their no-canvas branch, which is deliberate: material construction,
// baking and scatter must all stay exercisable without a browser.
// ============================================================================
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { APAL } from '@rift/shared/palette.js';
import { SURFACES, SURFACE_IDS } from '@rift/shared/surfaces.js';
import {
  BLOOM_LAYER,
  bake,
  bakeChunked,
  bakeVertexAO,
  box,
  cyl,
  emissiveSurface,
  gradientTexture,
  ico,
  lathe,
  markBloom,
  noiseTexture,
  normalFromHeight,
  ribbon,
  rng,
  roughnessTexture,
  scatter,
  surface,
} from './kit.js';
import type { InstanceXform, Part } from './kit.js';

/** Every position of a geometry, as a flat array — the only way to inspect a
 *  merged buffer without trusting the code that produced it. */
function positions(geo: THREE.BufferGeometry): readonly number[] {
  const a = geo.getAttribute('position');
  if (a === undefined) throw new Error('no position attribute');
  const out: number[] = [];
  for (let i = 0; i < a.count; i++) out.push(a.getX(i), a.getY(i), a.getZ(i));
  return out;
}

/** Sum of triangle areas — 0 means every triangle is degenerate. */
function surfaceArea(geo: THREE.BufferGeometry): number {
  const p = geo.getAttribute('position');
  if (p === undefined) return 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let area = 0;
  for (let t = 0; t + 2 < p.count; t += 3) {
    a.set(p.getX(t), p.getY(t), p.getZ(t));
    b.set(p.getX(t + 1), p.getY(t + 1), p.getZ(t + 1));
    c.set(p.getX(t + 2), p.getY(t + 2), p.getZ(t + 2));
    b.sub(a);
    c.sub(a);
    area += b.cross(c).length() * 0.5;
  }
  return area;
}

// ---- determinism ------------------------------------------------------------

describe('rng — the only randomness in the game', () => {
  it('is bit-identical for a fixed seed', () => {
    const a = rng('rift:jungle');
    const b = rng('rift:jungle');
    const first: number[] = [];
    for (let i = 0; i < 64; i++) first.push(a.next());
    for (const v of first) expect(b.next()).toBe(v);
  });

  it('gives different streams for different seeds, and accepts number seeds', () => {
    const a = rng('rift:jungle');
    const b = rng('rift:river');
    const n = rng(1234);
    const m = rng(1234);
    const sa: number[] = [];
    const sb: number[] = [];
    for (let i = 0; i < 16; i++) {
      sa.push(a.next());
      sb.push(b.next());
      expect(n.next()).toBe(m.next());
    }
    expect(sa).not.toEqual(sb);
  });

  it('keeps range/pick/sign inside their contracts', () => {
    const r = rng('rift:bounds');
    const xs = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 200; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      const g = r.range(-3, 7);
      expect(g).toBeGreaterThanOrEqual(-3);
      expect(g).toBeLessThan(7);
      expect(xs).toContain(r.pick(xs));
      expect(Math.abs(r.sign())).toBe(1);
    }
    expect(() => rng('x').pick([])).toThrow();
  });

  it('replays a whole scatter identically — the judge-loop guarantee', () => {
    const mk = (): readonly InstanceXform[] =>
      scatter({
        seed: 'rift:veg:0',
        minX: 0,
        maxX: 40,
        minZ: 0,
        maxZ: 40,
        spacing: 2.5,
        density: 12,
        tints: [APAL.canopy, APAL.canopyLit, APAL.canopyDeep],
        archetypes: 6,
      });
    expect(mk()).toEqual(mk());
  });
});

// ---- materials --------------------------------------------------------------

describe('surface() — the only material constructor', () => {
  it('caches per (id, tint) so one surface is one draw-call bucket', () => {
    expect(surface('groundMoss')).toBe(surface('groundMoss'));
    expect(surface('cloth', APAL.azure)).toBe(surface('cloth', APAL.azure));
    expect(surface('cloth', APAL.azure)).not.toBe(surface('cloth', APAL.ember));
    expect(surface('cloth', APAL.azure)).not.toBe(surface('cloth'));
  });

  it('obeys the vertex-colour law and the surface table', () => {
    const m = surface('cliffRock');
    expect(m.vertexColors).toBe(true);
    expect(m.roughness).toBe(0.85);
    expect(m.metalness).toBe(0);
    expect(m.flatShading).toBe(true);
    const iron = surface('iron');
    expect(iron.metalness).toBe(1);
    expect(iron.vertexColors).toBe(true);
  });

  it('renders a tint as the family albedo, leaving the physics alone', () => {
    const tinted = surface('cloth', APAL.ember);
    expect(tinted.color.getHexString()).toBe(APAL.ember.slice(1));
    expect(tinted.roughness).toBe(surface('cloth').roughness);
  });

  it('builds every family in the frozen table, exactly as the table says', () => {
    for (const id of SURFACE_IDS) {
      const def = SURFACES[id];
      const m = surface(id);
      expect(m.vertexColors, id).toBe(true);
      expect(m.roughness, id).toBe(def.roughness);
      expect(m.metalness, id).toBe(def.metalness);
      expect(m.flatShading, id).toBe(def.flatShading);
      expect(m.transparent, id).toBe(def.transparent);
      expect(m.opacity, id).toBe(def.opacity);
      expect(m.color.getHexString(), id).toBe(APAL[def.albedo].slice(1));
      if (def.normal === null) {
        expect(m.normalMap, id).toBeNull();
      } else {
        expect(m.normalMap, id).not.toBeNull();
        expect(m.normalScale.x, id).toBe(def.normal.strength);
        expect(m.normalScale.y, id).toBe(def.normal.strength);
      }
      expect(m.roughnessMap === null, id).toBe(!def.roughnessMap);
      if (def.emissive !== null) {
        expect(m.emissiveIntensity, id).toBe(def.emissive.intensity);
        expect(m.emissive.getHexString(), id).toBe(APAL[def.emissive.color].slice(1));
      }
    }
  });

  it('emissiveSurface drives bloom from an APAL key', () => {
    const m = emissiveSurface('crystal', 'azure', 3.5);
    expect(m.emissive.getHexString()).toBe(APAL.azure.slice(1));
    expect(m.emissiveIntensity).toBe(3.5);
    expect(m.vertexColors).toBe(true);
    // An unknown key must fall back, never throw: a builder that throws
    // white-screens the game (GRAPHICS_CONTRACT §7.7).
    expect(() => emissiveSurface('crystal', 'notAPaletteKey', 1)).not.toThrow();
  });
});

// ---- generated textures -----------------------------------------------------

describe('procedural textures — cached, tiling, never scaled by hand', () => {
  it('generates every NormalPattern in the frozen table without throwing', () => {
    const seen = new Set<string>();
    for (const id of SURFACE_IDS) {
      const n = SURFACES[id].normal;
      if (n === null) continue;
      seen.add(n.pattern);
      const height = noiseTexture({ pattern: n.pattern });
      expect(noiseTexture({ pattern: n.pattern })).toBe(height); // cached
      expect(height.wrapS).toBe(THREE.RepeatWrapping);
      expect(height.wrapT).toBe(THREE.RepeatWrapping);
      expect(height.colorSpace).toBe(THREE.NoColorSpace);
      const normal = normalFromHeight(height, 1);
      expect(normalFromHeight(height, 1)).toBe(normal); // cached per (src, scale)
      expect(normal.wrapS).toBe(THREE.RepeatWrapping);
      const rough = roughnessTexture({ pattern: n.pattern });
      expect(roughnessTexture({ pattern: n.pattern })).toBe(rough);
      expect(rough.colorSpace).toBe(THREE.NoColorSpace);
    }
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });

  it('ramps a gradient in sRGB, clamped vertically, cached by its stops', () => {
    const stops = [
      { at: 0, color: APAL.skyHigh },
      { at: 1, color: APAL.horizon },
    ];
    const tex = gradientTexture(stops);
    expect(gradientTexture(stops)).toBe(tex);
    expect(tex.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(tex.wrapT).toBe(THREE.ClampToEdgeWrapping);
    expect(() => gradientTexture([])).toThrow();
  });

  it('never sets texture.repeat — the UV law owns texel density', () => {
    for (const t of [
      noiseTexture({ pattern: 'strata' }),
      roughnessTexture({ pattern: 'strata' }),
      normalFromHeight(noiseTexture({ pattern: 'strata' }), 1),
      gradientTexture([{ at: 0, color: APAL.fog }]),
    ]) {
      expect(t.repeat.x).toBe(1);
      expect(t.repeat.y).toBe(1);
    }
  });
});

// ---- baking -----------------------------------------------------------------

function demoParts(): Part[] {
  return [
    { geo: box(2, 1, 2, { y: 0.5 }), surface: 'groundMoss' },
    { geo: box(1, 3, 1, { x: 4, y: 1.5 }), surface: 'cliffRock' },
    { geo: cyl(0.4, 0.6, 4, 8, { x: -3, y: 2 }), surface: 'bark' },
    { geo: ico(1.2, 1, { x: -3, y: 4.6 }), surface: 'canopy' },
    { geo: box(0.5, 0.5, 0.5, { x: 6, y: 0.25 }), surface: 'cliffRock' },
  ];
}

describe('bake() — one geometry per surface id', () => {
  it('buckets by surface id, not by part', () => {
    const baked = bake(demoParts());
    expect(baked.parts).toHaveLength(4); // moss, cliff, bark, canopy
    expect(baked.group.children).toHaveLength(4);
    const mats = new Set(baked.parts.map((p) => p.material));
    expect(mats.size).toBe(4);
    expect(mats.has(surface('cliffRock'))).toBe(true);
  });

  it('splits a tinted family into its own bucket', () => {
    const baked = bake([
      { geo: box(1, 1, 1), surface: 'canopy' },
      { geo: box(1, 1, 1, { x: 3 }), surface: 'canopy', tint: APAL.canopyLit },
    ]);
    expect(baked.parts).toHaveLength(2);
  });

  it('emits a color attribute on EVERY output geometry, white by default', () => {
    const baked = bake(demoParts());
    for (const p of baked.parts) {
      const col = p.geo.getAttribute('color');
      expect(col, 'every baked geometry must carry a color attribute').toBeDefined();
      if (col === undefined) continue;
      expect(col.itemSize).toBe(3);
      expect(col.count).toBe(p.geo.getAttribute('position')?.count);
      for (let i = 0; i < col.count; i++) {
        expect(col.getX(i)).toBe(1);
        expect(col.getY(i)).toBe(1);
        expect(col.getZ(i)).toBe(1);
      }
    }
  });

  it('rewrites UVs into world space at 1 unit = 1 metre', () => {
    // A 10 m slab spans 10 UV units, not 1 — that is the whole UV law.
    const baked = bake([{ geo: box(10, 0.2, 10, { y: -0.1 }), surface: 'groundMoss' }]);
    const first = baked.parts[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const uv = first.geo.getAttribute('uv');
    expect(uv).toBeDefined();
    if (uv === undefined) return;
    let span = 0;
    for (let i = 0; i < uv.count; i++) span = Math.max(span, Math.abs(uv.getX(i)));
    expect(span).toBeCloseTo(5, 5); // +/-5 m about the slab's own centre
  });

  it('preserves per-part UVs where uvLocal is set', () => {
    const baked = bake([
      { geo: box(8, 8, 8, { uvLocal: true }), surface: 'monumentStone' },
    ]);
    const first = baked.parts[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const uv = first.geo.getAttribute('uv');
    expect(uv).toBeDefined();
    if (uv === undefined) return;
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(1);
    }
  });

  it('produces meshes that cast and receive shadow', () => {
    const baked = bake(demoParts());
    for (const child of baked.group.children) {
      expect(child.castShadow).toBe(true);
      expect(child.receiveShadow).toBe(true);
    }
  });
});

describe('bakeVertexAO() — multiplies, never replaces', () => {
  it('scales an existing attribute in place and keeps the same buffer', () => {
    const baked = bake([
      { geo: box(4, 0.2, 4, { y: -0.1 }), surface: 'groundMoss' },
      { geo: box(1, 2, 1, { y: 1 }), surface: 'groundMoss' },
    ]);
    const part = baked.parts[0];
    expect(part).toBeDefined();
    if (part === undefined) return;
    const before = part.geo.getAttribute('color');
    expect(before).toBeDefined();
    if (before === undefined) return;
    // Pre-tint the attribute to a non-white value: a "replace" implementation
    // would come back at 1.0 and this is the assertion that catches it.
    for (let i = 0; i < before.count; i++) before.setXYZ(i, 0.5, 0.5, 0.5);

    bakeVertexAO(part.geo, 1);

    const after = part.geo.getAttribute('color');
    expect(after).toBe(before); // same attribute object — nothing was created
    if (after === undefined) return;
    let darkened = 0;
    for (let i = 0; i < after.count; i++) {
      const r = after.getX(i);
      expect(r).toBeLessThanOrEqual(0.5 + 1e-6); // never brightened
      expect(r).toBeGreaterThanOrEqual(0);
      expect(after.getY(i)).toBeCloseTo(r, 6); // stays neutral grey
      expect(after.getZ(i)).toBeCloseTo(r, 6);
      if (r < 0.5 - 1e-6) darkened++;
    }
    expect(darkened, 'AO must actually darken something').toBeGreaterThan(0);
  });

  it('refuses a geometry that never went through bake()', () => {
    const raw = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    expect(() => bakeVertexAO(raw, 0.5)).toThrow(/color attribute/);
  });

  it('leaves open flat ground alone — AO is contact darkening, not a dimmer', () => {
    const baked = bake([{ geo: box(20, 0.2, 20, { y: -0.1 }), surface: 'groundMoss' }]);
    const part = baked.parts[0];
    expect(part).toBeDefined();
    if (part === undefined) return;
    bakeVertexAO(part.geo, 1);
    const col = part.geo.getAttribute('color');
    expect(col).toBeDefined();
    if (col === undefined) return;
    // The up-facing top surface — the walkable ground itself — must survive
    // untouched: nothing stands above it and it faces the sky.
    const pos = part.geo.getAttribute('position');
    const nrm = part.geo.getAttribute('normal');
    expect(pos).toBeDefined();
    expect(nrm).toBeDefined();
    if (pos === undefined || nrm === undefined) return;
    let checked = 0;
    for (let i = 0; i < pos.count; i++) {
      if (nrm.getY(i) < 0.99 || pos.getY(i) < -0.05) continue;
      expect(col.getX(i)).toBeCloseTo(1, 5);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('bakeChunked() — the cold-load scheduler', () => {
  it('finishes, and lands on exactly what bake() produces', () => {
    const job = bakeChunked(demoParts(), 0);
    let steps = 0;
    while (job.step()) {
      steps++;
      expect(steps).toBeLessThan(1000); // step() must make progress
    }
    expect(job.step()).toBe(false); // idempotent once finished

    const direct = bake(demoParts());
    expect(job.mesh.parts).toHaveLength(direct.parts.length);
    expect(job.mesh.group.children).toHaveLength(direct.group.children.length);
    for (let i = 0; i < direct.parts.length; i++) {
      const a = job.mesh.parts[i];
      const b = direct.parts[i];
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      if (a === undefined || b === undefined) continue;
      expect(a.material).toBe(b.material);
      expect(positions(a.geo)).toEqual(positions(b.geo));
      expect(a.geo.getAttribute('color')).toBeDefined();
    }
  });

  it('yields — a zero budget does not bake the world in one call', () => {
    const job = bakeChunked(demoParts(), 0);
    job.step();
    expect(job.mesh.parts.length).toBe(0); // still normalising parts
  });
});

// ---- bloom ------------------------------------------------------------------

describe('markBloom()', () => {
  it('enables the bloom layer on a whole build without leaving the beauty pass', () => {
    const baked = bake([{ geo: box(1, 1, 1), surface: 'crystal' }]);
    markBloom(baked.group);
    for (const child of baked.group.children) {
      expect(child.layers.isEnabled(BLOOM_LAYER)).toBe(true);
      expect(child.layers.isEnabled(0)).toBe(true);
    }
  });
});

// ---- primitives -------------------------------------------------------------

describe('lathe() and ribbon() — the two data-driven factories', () => {
  it('lathes a non-degenerate solid of revolution', () => {
    const geo = lathe(
      [
        { r: 0, y: 0 },
        { r: 0.9, y: 0.15 },
        { r: 0.55, y: 0.9 },
        { r: 0.8, y: 1.4 },
        { r: 0, y: 1.6 },
      ],
      16,
    );
    const p = geo.getAttribute('position');
    expect(p).toBeDefined();
    if (p === undefined) return;
    expect(p.count).toBeGreaterThan(64);
    expect(geo.index).toBeNull(); // non-indexed, so it is always mergeable
    expect(surfaceArea(geo)).toBeGreaterThan(1);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    expect(bb).not.toBeNull();
    if (bb === null) return;
    expect(bb.max.y - bb.min.y).toBeCloseTo(1.6, 5);
    expect(bb.max.x - bb.min.x).toBeGreaterThan(1.4);
    for (const v of positions(geo)) expect(Number.isFinite(v)).toBe(true);
    expect(() => lathe([{ r: 1, y: 0 }], 8)).toThrow();
  });

  it('ribbons a path at the requested width, following its height', () => {
    const geo = ribbon(
      [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 20, y: 2, z: 6 },
      ],
      3,
    );
    const p = geo.getAttribute('position');
    expect(p).toBeDefined();
    if (p === undefined) return;
    expect(p.count).toBe(12); // 2 quads, 6 vertices each, non-indexed
    expect(surfaceArea(geo)).toBeGreaterThan(30); // ~ length 21 m x width 3 m
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    expect(bb).not.toBeNull();
    if (bb === null) return;
    expect(bb.max.z - bb.min.z).toBeGreaterThan(3);
    expect(bb.max.y - bb.min.y).toBeCloseTo(2, 5);
    for (const v of positions(geo)) expect(Number.isFinite(v)).toBe(true);
    expect(() => ribbon([{ x: 0, y: 0, z: 0 }], 2)).toThrow();
  });
});

// ---- scatter ----------------------------------------------------------------

describe('scatter() — Poisson-disc with the §8 variation law', () => {
  const opts = {
    seed: 'rift:jungle:2',
    minX: 0,
    maxX: 60,
    minZ: 0,
    maxZ: 60,
    spacing: 3,
    density: 10,
    tints: [APAL.canopy, APAL.canopyLit, APAL.canopyDeep],
    archetypes: 6,
  } as const;

  it('never places two instances closer than the spacing guarantee', () => {
    const xs = scatter(opts);
    expect(xs.length).toBeGreaterThan(20);
    for (let i = 0; i < xs.length; i++) {
      for (let j = i + 1; j < xs.length; j++) {
        const a = xs[i];
        const b = xs[j];
        if (a === undefined || b === undefined) continue;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        expect(d).toBeGreaterThanOrEqual(opts.spacing - 1e-9);
      }
    }
  });

  it('stays inside its zone and honours the density target as a ceiling', () => {
    const xs = scatter(opts);
    // 60 x 60 m at 10 per 100 m² = 360 instances, subject to spacing.
    expect(xs.length).toBeLessThanOrEqual(360);
    for (const x of xs) {
      expect(x.x).toBeGreaterThanOrEqual(opts.minX);
      expect(x.x).toBeLessThan(opts.maxX);
      expect(x.z).toBeGreaterThanOrEqual(opts.minZ);
      expect(x.z).toBeLessThan(opts.maxZ);
    }
  });

  it('varies every instance: scale +/-30%, full yaw, lean <= 12 deg, >= 3 tints', () => {
    const xs = scatter(opts);
    const tints = new Set<string>();
    const variants = new Set<number>();
    let maxLean = 0;
    let minScale = 9;
    let maxScale = 0;
    for (const x of xs) {
      tints.add(x.tint);
      variants.add(x.variant);
      maxLean = Math.max(maxLean, Math.hypot(x.leanX, x.leanZ));
      minScale = Math.min(minScale, x.scale);
      maxScale = Math.max(maxScale, x.scale);
      expect(x.rotY).toBeGreaterThanOrEqual(0);
      expect(x.rotY).toBeLessThan(Math.PI * 2 + 1e-9);
      expect(x.y).toBe(0);
    }
    expect(tints.size).toBeGreaterThanOrEqual(3);
    expect(variants.size).toBeGreaterThan(1);
    expect(maxLean).toBeLessThanOrEqual((12 * Math.PI) / 180 + 1e-9);
    expect(minScale).toBeGreaterThanOrEqual(0.7 - 1e-9);
    expect(maxScale).toBeLessThanOrEqual(1.3 + 1e-9);
    expect(maxScale - minScale).toBeGreaterThan(0.2); // actually varied
  });

  it('respects the accept test and the height sampler', () => {
    const xs = scatter({
      ...opts,
      accept: (x) => x < 30,
      heightAt: (x, z) => (x + z) * 0.01,
    });
    expect(xs.length).toBeGreaterThan(5);
    for (const x of xs) {
      expect(x.x).toBeLessThan(30);
      expect(x.y).toBeCloseTo((x.x + x.z) * 0.01, 9);
    }
  });

  it('refuses fewer than three tint steps — the variation law is not optional', () => {
    expect(() => scatter({ ...opts, tints: [APAL.canopy, APAL.canopyLit] })).toThrow(
      /tint steps/,
    );
  });

  it('returns nothing for a degenerate or fully rejected zone', () => {
    expect(scatter({ ...opts, maxX: opts.minX })).toHaveLength(0);
    expect(scatter({ ...opts, accept: () => false })).toHaveLength(0);
  });
});
