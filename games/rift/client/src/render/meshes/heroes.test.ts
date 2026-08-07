// ============================================================================
// R_MESH_HERO — the two defect classes that typecheck perfectly and still ship
// broken, plus the §7 gates that do not survive `bake()`.
//
// AMENDMENT_3 §G.5: "it must assert the vertex-colour attribute and the bloom
// bucket, which are exactly the defects that typecheck clean and render black."
// Both are here first, per archetype and per team.
//
// The rest of the file pins measurements. Every number below was measured off
// the shipped geometry, not chosen: where a threshold has slack it is stated as
// slack, and the measured value is in the comment beside it. A test whose
// threshold is so loose that reverting the behaviour keeps it green is not a
// test (AMENDMENT_2 §E), so each threshold sits between the current value and
// the value the reverted code produced.
// ============================================================================
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { APAL } from '@rift/shared/palette.js';
import { HERO_LIST, heroById, type HeroId } from '@rift/shared/hero.js';
import { isPlayerTeam, type EntTeam } from '@rift/shared/types.js';
import { BLOOM_LAYER, emissiveSurface, partMaterial, surface, type Part } from '../kit.js';
import { buildHero, heroParts } from './heroes.js';

const IDS: readonly HeroId[] = HERO_LIST.map((h) => h.id);
const TEAMS: readonly EntTeam[] = [0, 1];

/** STYLE_BIBLE §7's closing line, in metres, at the default camera's 21 px/m.
 *  Kept as a literal rather than imported so a change to the module's own
 *  constant cannot silently move the bar this file is guarding. */
const AA_MIN_M = 0.095;

function teamKeyOf(team: EntTeam): string {
  return !isPlayerTeam(team) ? 'neutral' : team === 0 ? 'azure' : 'ember';
}

function hex(c: THREE.Color): string {
  return `#${c.getHexString()}`;
}

function meshesOf(g: THREE.Group): THREE.Mesh[] {
  return g.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
}

function matOf(m: THREE.Mesh): THREE.MeshStandardMaterial {
  if (Array.isArray(m.material)) throw new Error('hero bucket has a material array');
  return m.material as THREE.MeshStandardMaterial;
}

function boxOf(p: Part): THREE.Box3 {
  p.geo.computeBoundingBox();
  return p.geo.boundingBox as THREE.Box3;
}

function sizeOf(p: Part): THREE.Vector3 {
  return boxOf(p).getSize(new THREE.Vector3());
}

function centreOf(p: Part): THREE.Vector3 {
  return boxOf(p).getCenter(new THREE.Vector3());
}

/**
 * Mean cross-section, 4V/A. Exact for the two shapes this file has to police:
 * a long rod (4V/A = its diameter) and a torus (4V/A = its tube diameter,
 * because V = 2*pi^2*R*t^2 and A = 4*pi^2*R*t). It is the quantity the reviewer
 * quoted — bow string 0.030 m = 0.63 px, orbit-ring cord 0.048-0.056 m =
 * 1.01-1.18 px, chain cord 0.036 m = 0.76 px — so the numbers here are directly
 * comparable to the defect report.
 *
 * It deliberately UNDER-rates a flat plate (it returns twice the thickness, not
 * the face size), which is why it is applied only to the free-standing rod and
 * ring props below and never to cloth panels or armour plate.
 */
function meanCrossSection(p: Part): number {
  const pos = p.geo.getAttribute('position');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cr = new THREE.Vector3();
  let vol = 0;
  let area = 0;
  for (let t = 0; t < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    cr.crossVectors(ab, ac);
    area += cr.length() * 0.5;
    vol += a.dot(cr.copy(b).cross(c)) / 6;
  }
  return area === 0 ? 0 : (4 * Math.abs(vol)) / area;
}

// ---- plan-view raster -------------------------------------------------------

const CELL = 0.01;
const HALF = 1.4;
const N = Math.round((HALF * 2) / CELL);

/** Rasterise a hero's whole baked body into an XZ occupancy grid — the pure
 *  black cutout STYLE_BIBLE §7 says a player must be able to identify. */
function planView(id: HeroId): Uint8Array {
  const build = buildHero(id, 0);
  const grid = new Uint8Array(N * N);
  for (const bucket of build.body.parts) {
    const pos = bucket.geo.getAttribute('position');
    for (let t = 0; t < pos.count; t += 3) {
      const ax = pos.getX(t);
      const az = pos.getZ(t);
      const bx = pos.getX(t + 1);
      const bz = pos.getZ(t + 1);
      const cx = pos.getX(t + 2);
      const cz = pos.getZ(t + 2);
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-12) continue;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) + HALF) / CELL));
      const i1 = Math.min(N - 1, Math.ceil((Math.max(ax, bx, cx) + HALF) / CELL));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) + HALF) / CELL));
      const j1 = Math.min(N - 1, Math.ceil((Math.max(az, bz, cz) + HALF) / CELL));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const px = -HALF + (i + 0.5) * CELL;
          const pz = -HALF + (j + 0.5) * CELL;
          const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det;
          const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det;
          if (l1 >= -1e-6 && l2 >= -1e-6 && l1 + l2 <= 1 + 1e-6) grid[j * N + i] = 1;
        }
      }
    }
  }
  return grid;
}

function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let uni = 0;
  for (let k = 0; k < a.length; k++) {
    const x = a[k] as number;
    const y = b[k] as number;
    if (x === 1 && y === 1) inter++;
    if (x === 1 || y === 1) uni++;
  }
  return uni === 0 ? 0 : inter / uni;
}

// ---- the §7 silhouette-breakers, as measured reach -------------------------
//
// STYLE_BIBLE §7 requires "at least two silhouette-breaking elements that
// extend beyond the body envelope" per hero. `reach` is how far the hero's
// geometry gets in that direction; the comment gives the measured value and the
// value the same axis had before the prop existed. Three of these props did not
// break anything before this pass: LONGBOW's quiver sat at x 0.435 / z -0.29,
// REAVER's chain at z 0.265, MENDER's stoles at x 0.30 / z 0.31.

interface Breaker {
  readonly name: string;
  readonly axis: 'x' | 'z';
  readonly dir: 1 | -1;
  readonly reach: number;
}

const BREAKERS: Record<HeroId, readonly Breaker[]> = {
  bullwark: [
    { name: 'tower shield', axis: 'x', dir: -1, reach: 0.85 }, // measured 0.918, rest of body 0.76
    { name: 'back banner', axis: 'z', dir: -1, reach: 0.42 }, // measured 0.468, rest of body 0.36
  ],
  longbow: [
    { name: 'recurve bow', axis: 'x', dir: -1, reach: 0.65 }, // measured 0.708
    { name: 'quiver fletchings', axis: 'x', dir: 1, reach: 0.62 }, // measured 0.666, was 0.510
    { name: 'quiver behind', axis: 'z', dir: -1, reach: 0.6 }, // measured 0.658, was 0.480
  ],
  reaver: [
    { name: 'greatsword crossguard', axis: 'z', dir: -1, reach: 0.7 }, // measured 0.760
    { name: 'trophy chain', axis: 'z', dir: 1, reach: 0.65 }, // measured 0.724, was 0.338
  ],
  hex: [
    // The ring cage is one breaker that works in every direction at once, which
    // is the whole reason his plan view is a circle and nobody else's is.
    { name: 'orbit rings +x', axis: 'x', dir: 1, reach: 0.66 }, // measured 0.718
    { name: 'orbit rings -x', axis: 'x', dir: -1, reach: 0.66 }, // measured 0.718
    { name: 'orbit rings +z', axis: 'z', dir: 1, reach: 0.64 }, // measured 0.702
    { name: 'orbit rings -z', axis: 'z', dir: -1, reach: 0.64 }, // measured 0.702
  ],
  mender: [
    { name: 'antler staff', axis: 'x', dir: 1, reach: 0.68 }, // measured 0.726
    { name: 'herb creel out', axis: 'x', dir: -1, reach: 0.7 }, // measured 0.781, was 0.487
    { name: 'herb creel behind', axis: 'z', dir: -1, reach: 0.62 }, // measured 0.690, was 0.452
  ],
  shade: [
    { name: 'twin daggers', axis: 'x', dir: 1, reach: 0.56 }, // measured 0.608
    { name: 'forked scarf', axis: 'z', dir: -1, reach: 0.75 }, // measured 0.819
  ],
};

/** The free-standing rod and ring props, by region. Each region was chosen to
 *  contain exactly its prop and nothing else; the test asserts that too, so a
 *  selector that quietly stops matching cannot pass by matching nothing. */
interface AaRegion {
  readonly id: HeroId;
  readonly name: string;
  readonly pick: (p: Part) => boolean;
  /** `rod` measures the smallest bounding-box extent, which is exact for a bar
   *  or a cylinder rotated about one axis. `ring` measures 4V/A, which is exact
   *  for a torus and is what a bounding box cannot see. */
  readonly measure: 'rod' | 'ring';
  readonly count: number;
}

const AA_REGIONS: readonly AaRegion[] = [
  {
    id: 'longbow',
    name: 'the bow arm: forearm, hand, grip, six limbs, two nocks, string, nocked arrow',
    pick: (p) => centreOf(p).x <= -0.4 && p.surface !== 'crystal',
    measure: 'rod',
    count: 14,
  },
  {
    id: 'hex',
    name: 'the halo and the three orbit rings',
    pick: (p) => p.surface === 'bronze' && Math.max(...sizeOf(p).toArray()) >= 0.5,
    measure: 'ring',
    count: 4,
  },
  {
    id: 'reaver',
    name: 'the trophy chain and its skull',
    pick: (p) => p.surface === 'bronze' && centreOf(p).z >= 0.1,
    measure: 'ring',
    count: 8,
  },
];

// ============================================================================

describe('R_MESH_HERO — the defects that typecheck clean and render black', () => {
  it.each(IDS)('%s: every baked bucket carries a vertex-colour attribute', (id) => {
    for (const team of TEAMS) {
      const build = buildHero(id, team);
      expect(build.body.parts.length).toBeGreaterThan(0);
      for (const bucket of build.body.parts) {
        const colour = bucket.geo.getAttribute('color');
        expect(colour, `${id}/${team}: bucket has no color attribute`).toBeDefined();
        expect(colour.itemSize).toBe(3);
        expect(colour.count).toBe(bucket.geo.getAttribute('position').count);
        // Every kit material is vertexColors:true, so a zero here is black.
        let min = Infinity;
        for (let i = 0; i < colour.count * 3; i++) min = Math.min(min, colour.array[i] as number);
        expect(min).toBeGreaterThan(0);
      }
    }
  });

  it.each(IDS)('%s: the anim part is a whiteVertexColors-ed AnimPart, not a bare geometry', (id) => {
    for (const team of TEAMS) {
      const anim = buildHero(id, team).anim;
      expect(anim, `${id}: every hero has an anim carve-out`).not.toBeNull();
      if (anim === null) return;
      // The geometry never passes through bake(), so this module owns the law.
      const colour = anim.geo.getAttribute('color');
      expect(colour, `${id}: anim geometry has no color attribute — it renders black`).toBeDefined();
      expect(colour.itemSize).toBe(3);
      expect(colour.count).toBe(anim.geo.getAttribute('position').count);
      for (let i = 0; i < colour.count * 3; i++) expect(colour.array[i]).toBe(1);
      // ...and the material travels IN THE TYPE (AMENDMENT_3 §B): no
      // userData.rift* side-channel, and R_UNITS never guesses from animKind.
      expect(typeof anim.surfaceId).toBe('string');
      expect(anim.bloom).toBe(true);
      expect(anim.geo.userData).not.toHaveProperty('riftMaterial');
      expect(anim.geo.userData).not.toHaveProperty('riftSurface');
      expect(anim.geo.userData).not.toHaveProperty('riftBloom');
      // R_UNITS mounts it through the one resolver; that must not throw and
      // must give a real kit material.
      const mat = partMaterial(anim.surfaceId, anim.tint, anim.emissive);
      expect(mat).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect(mat.vertexColors).toBe(true);
    }
  });

  it.each(IDS)('%s: exactly the light sources are on BLOOM_LAYER', (id) => {
    // Two crystal buckets on everyone; REAVER also carries real `gold`, which
    // SURFACES documents as "marked into BLOOM_LAYER by its builder".
    const expected = id === 'reaver' ? 3 : 2;
    for (const team of TEAMS) {
      const build = buildHero(id, team);
      const meshes = meshesOf(build.body.group);
      expect(meshes.length).toBe(build.body.parts.length);
      const bloomed = meshes.filter((m) => m.layers.isEnabled(BLOOM_LAYER));
      expect(bloomed.length, `${id}/${team}: wrong number of bloom buckets`).toBe(expected);
      for (const m of bloomed) {
        // enable(), not set(): a bloom bucket must stay in the beauty pass too.
        expect(m.layers.isEnabled(0)).toBe(true);
        const mat = matOf(m);
        const isGold = mat === surface('gold');
        expect(isGold || mat.emissiveIntensity > 1).toBe(true);
      }
      // Armour and cloth must NOT bloom — that is the amateur tell §6 names.
      for (const m of meshes.filter((x) => !x.layers.isEnabled(BLOOM_LAYER))) {
        expect(matOf(m).emissiveIntensity).toBe(1);
      }
    }
  });
});

describe('R_MESH_HERO — the emissive path (AMENDMENT_3 §A)', () => {
  it.each(IDS)('%s: the team crystal keeps its team tint instead of rendering cream', (id) => {
    const seen: string[] = [];
    for (const team of TEAMS) {
      const key = teamKeyOf(team);
      const want = APAL[key as keyof typeof APAL] as string;
      const build = buildHero(id, team);
      const mats = meshesOf(build.body.group).map(matOf);
      const teamCrystal = mats.filter((m) => m.emissiveIntensity > 1 && hex(m.color) === want);
      expect(teamCrystal.length, `${id}/${team}: no team-tinted crystal bucket`).toBe(1);
      const m = teamCrystal[0] as THREE.MeshStandardMaterial;
      // The regression this replaces: the re-point-after-bake workaround left
      // every crystal at the family's own pale `ward` albedo.
      expect(hex(m.color)).not.toBe(APAL.ward);
      expect(hex(m.emissive)).toBe(want);
      // It is EXACTLY what the kit's cached emissive path returns for the
      // declared triple — so bake() built it, and nothing re-pointed it.
      expect(m).toBe(partMaterial('crystal', want, { colorKey: key, intensity: m.emissiveIntensity }));
      // ...and it is NOT the flat material the workaround used to mint.
      expect(m).not.toBe(surface('crystal', want));
      seen.push(hex(m.color));
    }
    expect(seen[0]).not.toBe(seen[1]);
  });

  it.each(IDS)('%s: the accent crystal is a second, distinct bucket', (id) => {
    const accentKey = heroById(id).visual.accent;
    const want = APAL[accentKey as keyof typeof APAL] as string;
    for (const team of TEAMS) {
      const build = buildHero(id, team);
      const mats = meshesOf(build.body.group).map(matOf);
      const accent = mats.filter((m) => m.emissiveIntensity > 1 && hex(m.color) === want);
      expect(accent.length, `${id}/${team}: no accent-tinted crystal bucket`).toBe(1);
      const m = accent[0] as THREE.MeshStandardMaterial;
      expect(hex(m.emissive)).toBe(want);
      expect(m).toBe(partMaterial('crystal', want, { colorKey: accentKey, intensity: m.emissiveIntensity }));
      const teamMat = mats.filter(
        (x) => x.emissiveIntensity > 1 && hex(x.color) === (APAL[teamKeyOf(team) as keyof typeof APAL] as string),
      )[0];
      expect(m).not.toBe(teamMat);
    }
  });

  it('the material cache cannot merge a tint with an emissive key', () => {
    // AMENDMENT_3 §A / K_AMEND: under the old `${id}|${tint}` vs
    // `${id}|e|${key}|${intensity}` scheme a tint containing the separator could
    // take an emissive material's slot, and this file's two crystal buckets
    // would silently become one — team identity gone, with a clean typecheck.
    //
    // The class is now closed twice over, and this pins both halves.
    //
    // 1. A tint that could imitate a key field cannot even be built: `mix()`
    //    validates hex, so the separator-bearing tint never reaches the cache.
    expect(() => surface('crystal', 'e|azure|2.200')).toThrow(/bad hex/);
    // 2. Everything that DOES reach the cache is length-prefixed, so no two
    //    distinct (tint, colorKey, intensity) triples can share a slot — and a
    //    `colorKey` that looks exactly like a tint stays distinct from one.
    expect(surface('crystal', APAL.azure)).not.toBe(emissiveSurface('crystal', 'azure', 2.2, APAL.azure));
    expect(emissiveSurface('crystal', APAL.azure, 2.2)).not.toBe(surface('crystal', APAL.azure));
    expect(emissiveSurface('crystal', 'azure', 1.8, APAL.azure)).not.toBe(
      emissiveSurface('crystal', 'azure', 2.3, APAL.azure),
    );
    expect(emissiveSurface('crystal', 'azure', 2.3, APAL.azure)).not.toBe(
      emissiveSurface('crystal', 'azure', 2.3, APAL.ember),
    );
    expect(emissiveSurface('crystal', 'azure', 2.3)).not.toBe(emissiveSurface('crystal', 'azure', 2.3, APAL.azure));
  });
});

describe('R_MESH_HERO — the §7 budgets and the roster', () => {
  it.each(IDS)('%s: part count is inside the 45-70 band', (id) => {
    const n = heroParts(id, 0).length;
    expect(n).toBeGreaterThanOrEqual(45);
    expect(n).toBeLessThanOrEqual(70);
  });

  it.each(IDS)('%s: at most seven draw-call buckets', (id) => {
    for (const team of TEAMS) expect(buildHero(id, team).body.parts.length).toBeLessThanOrEqual(7);
  });

  it.each(IDS)('%s: barH and barW are read off the frozen roster', (id) => {
    const visual = heroById(id).visual;
    const build = buildHero(id, 0);
    // barH is a pure, strictly increasing function of visual.height...
    for (const other of IDS) {
      const ov = heroById(other).visual;
      const ob = buildHero(other, 0);
      if (ov.height === visual.height) expect(ob.barH).toBeCloseTo(build.barH, 6);
      if (ov.height > visual.height) expect(ob.barH).toBeGreaterThan(build.barH);
    }
    // ...and barW is a pure function of visual.build, ordered by mass.
    for (const other of IDS) {
      const ov = heroById(other).visual;
      if (ov.build === visual.build) expect(buildHero(other, 0).barW).toBeCloseTo(build.barW, 6);
    }
    const width: Record<string, number> = { bulky: 0, standard: 0, lithe: 0 };
    for (const h of IDS) width[heroById(h).visual.build] = buildHero(h, 0).barW;
    expect(width['bulky']).toBeGreaterThan(width['standard'] as number);
    expect(width['standard']).toBeGreaterThan(width['lithe'] as number);
    // The bar clears the HEAD, so it must sit above the roster height it is
    // derived from and below anything that would read as detached.
    expect(build.barH).toBeGreaterThan(visual.height);
    expect(build.barH - visual.height).toBeLessThan(0.45);
  });

  it('HEX floats and everyone else stands on the ground', () => {
    for (const id of IDS) {
      const bounds = new THREE.Box3();
      for (const bucket of buildHero(id, 0).body.parts) {
        bucket.geo.computeBoundingBox();
        bounds.union(bucket.geo.boundingBox as THREE.Box3);
      }
      if (id === 'hex') {
        // The comment, the constant and the geometry now agree; before this
        // pass the hem spikes measured minY = 0.000 under a 10 cm claim.
        expect(bounds.min.y).toBeCloseTo(0.1, 3);
      } else {
        expect(bounds.min.y).toBeCloseTo(0, 3);
      }
    }
  });
});

describe('R_MESH_HERO — STYLE_BIBLE §7 silhouette', () => {
  it.each(IDS)('%s: has at least two silhouette-breakers, at their measured reach', (id) => {
    const parts = heroParts(id, 0);
    const breakers = BREAKERS[id];
    expect(breakers.length).toBeGreaterThanOrEqual(2);
    for (const b of breakers) {
      let best = -Infinity;
      for (const p of parts) {
        const box = boxOf(p);
        const v = b.dir === 1 ? (b.axis === 'x' ? box.max.x : box.max.z) : b.axis === 'x' ? -box.min.x : -box.min.z;
        best = Math.max(best, v);
      }
      expect(best, `${id}: ${b.name} does not reach ${b.reach} m`).toBeGreaterThanOrEqual(b.reach);
    }
  });

  it('no two heroes share a plan-view silhouette', () => {
    const grids = new Map<HeroId, Uint8Array>(IDS.map((id) => [id, planView(id)]));
    let worst = { pair: '', v: 0 };
    for (let i = 0; i < IDS.length; i++) {
      for (let j = i + 1; j < IDS.length; j++) {
        const a = IDS[i] as HeroId;
        const b = IDS[j] as HeroId;
        const v = iou(grids.get(a) as Uint8Array, grids.get(b) as Uint8Array);
        if (v > worst.v) worst = { pair: `${a}/${b}`, v };
      }
    }
    // Baseline before this pass: 0.603 (reaver/mender). Now 0.573 (reaver/hex),
    // and reaver/mender is 0.476. Every one of the fifteen pairs improved.
    expect(worst.v, `worst plan-view IoU is ${worst.pair} at ${worst.v.toFixed(3)}`).toBeLessThan(0.6);
  });
});

describe('R_MESH_HERO — the anti-aliasing floor (STYLE_BIBLE §7, last line)', () => {
  it.each(AA_REGIONS)('$id: $name is at least 2 px across', (region) => {
    const picked = heroParts(region.id, 0).filter(region.pick);
    // A selector that matches nothing would pass vacuously.
    expect(picked.length, `${region.id}: selector matched ${picked.length} parts`).toBe(region.count);
    for (const p of picked) {
      const v = region.measure === 'rod' ? Math.min(...sizeOf(p).toArray()) : meanCrossSection(p);
      expect(v, `${region.id}/${region.name}: ${(v * 21).toFixed(2)} px`).toBeGreaterThanOrEqual(AA_MIN_M);
    }
  });
});

describe('R_MESH_HERO — material law', () => {
  it.each(IDS)('%s: every bucket material is a kit MeshStandardMaterial', (id) => {
    for (const team of TEAMS) {
      for (const m of meshesOf(buildHero(id, team).body.group)) {
        const mat = matOf(m);
        expect(mat).toBeInstanceOf(THREE.MeshStandardMaterial);
        expect(mat).not.toBeInstanceOf(THREE.MeshLambertMaterial);
        expect(mat.vertexColors).toBe(true);
        expect(mat.name.startsWith('rift:')).toBe(true);
        // No texture.repeat, ever (UV law): the kit scales UVs in geometry
        // space and every generated map is left at repeat (1,1).
        for (const tex of [mat.map, mat.normalMap, mat.roughnessMap, mat.emissiveMap]) {
          if (tex !== null && tex !== undefined) {
            expect(tex.repeat.x).toBe(1);
            expect(tex.repeat.y).toBe(1);
          }
        }
      }
    }
  });

  it.each(IDS)('%s: every part declares a tint that is an APAL entry', (id) => {
    const palette = new Set<string>(Object.values(APAL));
    for (const team of TEAMS) {
      for (const p of heroParts(id, team)) {
        if (p.tint !== undefined) expect(palette.has(p.tint), `${id}: ad-hoc hex ${p.tint}`).toBe(true);
        if (p.emissive !== undefined) {
          expect(p.surface).toBe('crystal');
          expect(p.tint).toBeDefined();
          expect(p.emissive.intensity).toBeGreaterThan(0);
        }
      }
    }
  });
});
