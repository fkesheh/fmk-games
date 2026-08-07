// ============================================================================
// ANCIENTS (rift) — R_MESH_STRUCT's GATE (AMENDMENT_3 §G.5).
//
// Every case here is a defect a reviewer actually measured on the shipped
// module, pinned so it cannot come back. All of them typecheck clean, and most
// of them are invisible in code review:
//
//   * a geometry with no `color` attribute renders BLACK under the kit's
//     unconditional `vertexColors: true`. `bake()` supplies the attribute; the
//     anim part never goes through `bake()`, so it is the one geometry in the
//     module that can be wrong;
//   * an `emissiveSurface()` bucket that is never `markBloom`ed glows without
//     blooming, and a bloom-marked bucket that carries no emissive hazes the
//     frame;
//   * both team banners were placed on the +Z half, which is the face the fixed
//     -Z camera NEVER sees: 2 of the tower's 48 banner triangles reached the
//     frame and 0 of the guard's;
//   * the Ancient's heart, pinned to local z = 0 because `UnitBuild` has no
//     `animZ`, sat behind the figure's own torso and was occluded at 60 of 60
//     sample points;
//   * the crystal bucket was re-pointed at `emissiveSurface()` AFTER `bake()`,
//     which discarded the team tint and rendered every crystal cream #c9c2ae;
//   * the guard measured 9.58 m against the tower's 9.41 m under a comment
//     saying it was lower, and both carried an identical orbiting crystal;
//   * rough stone that is meant to cling to dressed stone floated: 3 of the
//     Ancient's 8 torso cracks by up to 0.0610 m, and all 4 lane-tower crown
//     finials by exactly 0.2500 m, because the lintels under them ran radially
//     instead of spanning post to post.
//
// It runs HEADLESS (node, no DOM), exactly as `kit.test.ts` and
// `creeps.test.ts` do: the kit's texture generators take their no-canvas branch
// and material construction, bucketing and baking all stay exercisable without
// a browser. Draw calls and cold-load timings are NOT asserted here — both need
// a real WebGL2 context and a real canvas, and a node number for either would
// be a fiction. They are measured in headless Chrome and quoted above
// `buildStructure`.
// ============================================================================
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { APAL } from '@rift/shared/palette.js';
import type { StructureKind, TeamId } from '@rift/shared/types.js';
import { BLOOM_LAYER, partMaterial } from '../kit.js';
import type { AnimPart, UnitBuild } from '../kit.js';
import { buildStructure } from './structures.js';

const KINDS: readonly StructureKind[] = ['tower', 'guard', 'ancient'];

/** The camera is fixed at 55 deg pitch and looks down +Z (`scene.ts` parks it
 *  at `gz - back` and `lookAt`s `gz`; `units.ts` never yaws a structure). This
 *  is the unit vector FROM any point in the build TOWARD that camera. */
const PITCH = THREE.MathUtils.degToRad(55);
const TO_CAM = new THREE.Vector3(0, Math.sin(PITCH), -Math.cos(PITCH)).normalize();

function meshes(b: UnitBuild): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  b.body.group.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}
const visible = (b: UnitBuild): THREE.Mesh[] => meshes(b).filter((m) => m.visible);
const hidden = (b: UnitBuild): THREE.Mesh[] => meshes(b).filter((m) => !m.visible);

function matOf(m: THREE.Mesh): THREE.MeshStandardMaterial {
  const mat = m.material;
  if (Array.isArray(mat) || !(mat instanceof THREE.MeshStandardMaterial)) {
    throw new Error('expected a single MeshStandardMaterial');
  }
  return mat;
}

function bucketFor(b: UnitBuild, name: string, albedoHex?: string): THREE.Mesh {
  const hit = visible(b).find(
    (m) =>
      matOf(m).name === name &&
      (albedoHex === undefined || `#${matOf(m).color.getHexString()}` === albedoHex),
  );
  if (hit === undefined) throw new Error(`no visible ${name} bucket${albedoHex ?? ''}`);
  return hit;
}

function animOf(b: UnitBuild): AnimPart {
  const a = b.anim;
  if (a === null) throw new Error('expected an anim part');
  return a;
}

function boxOf(ms: readonly THREE.Mesh[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const m of ms) {
    m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox;
    if (bb !== null) box.union(bb);
  }
  return box;
}

/** Triangles of `target` that face the camera AND are not blocked by any other
 *  mesh in the build, plus how many face it at all. */
function reachesCamera(target: THREE.Mesh, all: readonly THREE.Mesh[]): [number, number] {
  const pos = target.geometry.getAttribute('position');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const others = all.filter((m) => m !== target && m.visible);
  let seen = 0;
  let front = 0;
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    nrm.crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
    if (nrm.dot(TO_CAM) <= 0.02) continue;
    front++;
    mid.copy(a).add(b).add(c).multiplyScalar(1 / 3).addScaledVector(nrm, 1e-3);
    const rc = new THREE.Raycaster(mid, TO_CAM, 0, 60);
    if (others.every((m) => rc.intersectObject(m, false).length === 0)) seen++;
  }
  return [seen, front];
}

/** Sample points of the anim part, mounted at (0, animY + bob, 0), that the
 *  body occludes from the camera. */
function animBlocked(b: UnitBuild, bob: number): [number, number] {
  const geo = animOf(b).geo;
  const pos = geo.getAttribute('position');
  const all = visible(b);
  const v = new THREE.Vector3();
  let blocked = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(pos.count / 60));
  for (let i = 0; i < pos.count; i += step) {
    v.fromBufferAttribute(pos, i);
    v.y += b.animY + bob;
    n++;
    const rc = new THREE.Raycaster(v.clone().addScaledVector(TO_CAM, 1e-3), TO_CAM, 0, 60);
    if (all.some((m) => rc.intersectObject(m, false).length > 0)) blocked++;
  }
  return [blocked, n];
}

// ---- surface-to-surface contact --------------------------------------------
// "Does it float" is only meaningful as: do the two SURFACES intersect? A
// nearest-vertex distance under-reports (two boxes can cross without any vertex
// of one being near a face of the other) and an inside/outside parity test is
// unsound here, because half a tower is an open lathe SHELL — SHAFT_PROFILE
// never returns to r = 0 — and parity against an open shell means nothing.

interface Lump {
  readonly tris: readonly number[];
  readonly centroid: THREE.Vector3;
}

/** Split a merged bucket back into the separate solids that were baked into it,
 *  by connectivity over exactly-shared vertex positions. Kit primitives never
 *  share a vertex with each other, so one component is one part. */
function lumps(geo: THREE.BufferGeometry): Lump[] {
  const pos = geo.getAttribute('position');
  const nTri = pos.count / 3;
  const parent = new Int32Array(nTri).fill(-1);
  const find = (i: number): number => {
    let x = i;
    while (parent[x]! >= 0) x = parent[x]!;
    return x;
  };
  const byKey = new Map<string, number>();
  const v = new THREE.Vector3();
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(pos, t * 3 + k);
      const key = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
      const prev = byKey.get(key);
      if (prev === undefined) byKey.set(key, t);
      else {
        const ra = find(prev);
        const rb = find(t);
        if (ra !== rb) parent[rb] = ra;
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < nTri; t++) {
    const root = find(t);
    let g = groups.get(root);
    if (g === undefined) {
      g = [];
      groups.set(root, g);
    }
    g.push(t);
  }
  const out: Lump[] = [];
  for (const g of groups.values()) {
    const c = new THREE.Vector3();
    for (const t of g) {
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, t * 3 + k);
        c.add(v);
      }
    }
    out.push({ tris: g, centroid: c.multiplyScalar(1 / (g.length * 3)) });
  }
  return out;
}

function trianglesOf(geo: THREE.BufferGeometry, skip?: ReadonlySet<number>): THREE.Triangle[] {
  const pos = geo.getAttribute('position');
  const out: THREE.Triangle[] = [];
  for (let t = 0; t < pos.count / 3; t++) {
    if (skip?.has(t) === true) continue;
    out.push(
      new THREE.Triangle(
        new THREE.Vector3().fromBufferAttribute(pos, t * 3),
        new THREE.Vector3().fromBufferAttribute(pos, t * 3 + 1),
        new THREE.Vector3().fromBufferAttribute(pos, t * 3 + 2),
      ),
    );
  }
  return out;
}

const ray = new THREE.Ray();
const hit = new THREE.Vector3();
function segmentHits(a: THREE.Vector3, b: THREE.Vector3, tris: readonly THREE.Triangle[]): boolean {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-9) return false;
  ray.set(a, dir.multiplyScalar(1 / len));
  for (const t of tris) {
    const h = ray.intersectTriangle(t.a, t.b, t.c, false, hit);
    if (h !== null && a.distanceTo(h) <= len) return true;
  }
  return false;
}

const near = new THREE.Vector3();
function pointToTris(p: THREE.Vector3, tris: readonly THREE.Triangle[]): number {
  let min = Infinity;
  for (const t of tris) {
    t.closestPointToPoint(p, near);
    const d = p.distanceTo(near);
    if (d < min) min = d;
    if (min <= 1e-6) return min;
  }
  return min;
}

/** 0 when the lump's surface touches or crosses the host's, otherwise the
 *  distance between them. */
function contactGap(
  geo: THREE.BufferGeometry,
  l: Lump,
  hostGeo: THREE.BufferGeometry,
  skip?: ReadonlySet<number>,
): number {
  const host = trianglesOf(hostGeo, skip);
  const pos = geo.getAttribute('position');
  const mine: THREE.Triangle[] = [];
  for (const t of l.tris) {
    const a = new THREE.Vector3().fromBufferAttribute(pos, t * 3);
    const b = new THREE.Vector3().fromBufferAttribute(pos, t * 3 + 1);
    const c = new THREE.Vector3().fromBufferAttribute(pos, t * 3 + 2);
    if (segmentHits(a, b, host) || segmentHits(b, c, host) || segmentHits(c, a, host)) return 0;
    mine.push(new THREE.Triangle(a, b, c));
  }
  const hp = hostGeo.getAttribute('position');
  for (let t = 0; t < hp.count / 3; t++) {
    if (skip?.has(t) === true) continue;
    const a = new THREE.Vector3().fromBufferAttribute(hp, t * 3);
    if (a.distanceTo(l.centroid) > 6) continue;
    const b = new THREE.Vector3().fromBufferAttribute(hp, t * 3 + 1);
    const c = new THREE.Vector3().fromBufferAttribute(hp, t * 3 + 2);
    if (segmentHits(a, b, mine) || segmentHits(b, c, mine) || segmentHits(c, a, mine)) return 0;
  }
  let best = Infinity;
  for (const t of mine) {
    for (const p of [t.a, t.b, t.c]) best = Math.min(best, pointToTris(p, host));
    if (best <= 1e-6) break;
  }
  return best;
}

// ============================================================================

describe('buildStructure — the contract every archetype meets', () => {
  it.each(KINDS)('%s: every material comes from the kit, none is Lambert', (kind) => {
    const b = buildStructure(kind, 0);
    for (const m of meshes(b)) {
      const mat = matOf(m);
      expect(mat).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect(mat.vertexColors).toBe(true);
      expect(mat.name.startsWith('rift:')).toBe(true);
    }
  });

  it.each(KINDS)('%s: every baked bucket carries a white-or-AO colour attribute', (kind) => {
    const b = buildStructure(kind, 0);
    for (const m of meshes(b)) {
      const col = m.geometry.getAttribute('color');
      expect(col).toBeDefined();
      expect(col.itemSize).toBe(3);
      expect(col.count).toBe(m.geometry.getAttribute('position').count);
    }
  });

  it.each(KINDS)('%s: BakedMesh.parts matches the meshes that render', (kind) => {
    const b = buildStructure(kind, 0);
    expect(b.body.parts.length).toBe(meshes(b).length);
    for (const p of b.body.parts) {
      const m = meshes(b).find((x) => x.geometry === p.geo);
      expect(m).toBeDefined();
      // The re-point workaround made `parts` claim a material the scene was not
      // drawing with. Nothing is re-pointed now, so these are the same object.
      expect(m === undefined ? null : m.material).toBe(p.material);
    }
  });

  it.each(KINDS)('%s: two calls return independent groups', (kind) => {
    const a = buildStructure(kind, 0);
    const b = buildStructure(kind, 0);
    expect(a.body.group).not.toBe(b.body.group);
    expect(a.body.group.parent).toBeNull();
  });

  it.each(KINDS)('%s: the hidden damage bucket is flagged and invisible', (kind) => {
    const b = buildStructure(kind, 0);
    const h = hidden(b);
    expect(h.length).toBe(1);
    expect(h[0]?.name).toBe('rift:structDamage');
    expect(h[0]?.userData['riftDamage']).toBe(true);
    expect(`#${matOf(h[0]!).color.getHexString()}`).not.toBe(
      `#${matOf(bucketFor(b, 'rift:cliffRock', '#6d737b')).color.getHexString()}`,
    );
  });

  it.each(KINDS)('%s: the part budget is met by the SHIPPED geometry', (kind) => {
    const b = buildStructure(kind, 0);
    const body = b.body.group.userData['riftBodyParts'];
    const dmg = b.body.group.userData['riftDamageParts'];
    expect(typeof body).toBe('number');
    expect(typeof dmg).toBe('number');
    const [lo, hi] = kind === 'ancient' ? [110, 160] : [55, 80];
    expect(body as number).toBeGreaterThanOrEqual(lo);
    expect(body as number).toBeLessThanOrEqual(hi);
    // Damage geometry is NEVER drawn on a healthy structure, so it must not be
    // what gets the archetype into the band.
    expect((body as number) + (dmg as number)).toBeGreaterThan(body as number);
  });
});

describe('bloom is layer-masked, and only the right things carry it', () => {
  it.each(KINDS)('%s: exactly the emissive and gold buckets are marked', (kind) => {
    const b = buildStructure(kind, 0);
    for (const m of meshes(b)) {
      const mat = matOf(m);
      const shouldGlow = mat.emissiveIntensity > 1.5 || mat.name === 'rift:gold';
      expect(m.layers.isEnabled(BLOOM_LAYER)).toBe(shouldGlow);
    }
    // and something IS marked — a build with no bloom target at all would pass
    // the loop above vacuously.
    expect(meshes(b).filter((m) => m.layers.isEnabled(BLOOM_LAYER)).length).toBeGreaterThan(0);
  });

  it('the whole group is never marked — stone and cloth stay out of the pass', () => {
    const b = buildStructure('ancient', 0);
    expect(b.body.group.layers.isEnabled(BLOOM_LAYER)).toBe(false);
    expect(matOf(bucketFor(b, 'rift:cloth')).name).toBe('rift:cloth');
    expect(bucketFor(b, 'rift:cloth').layers.isEnabled(BLOOM_LAYER)).toBe(false);
  });
});

describe('the team crystal keeps its team colour (AMENDMENT_3 §A)', () => {
  it.each([0, 1] as const)('team %i: the emissive bucket is tinted, not cream', (team: TeamId) => {
    const want = team === 0 ? APAL.azure : APAL.ember;
    for (const kind of KINDS) {
      const b = buildStructure(kind, team);
      const glow = visible(b).find((m) => matOf(m).emissiveIntensity > 1.5);
      expect(glow).toBeDefined();
      const mat = matOf(glow!);
      // The albedo carries the team tint. The re-point workaround left it at
      // the crystal family's own #c9c2ae for BOTH teams.
      expect(`#${mat.color.getHexString()}`).toBe(want);
      expect(`#${mat.color.getHexString()}`).not.toBe('#c9c2ae');
      // and the glow carries the team hue as well
      expect(`#${mat.emissive.getHexString()}`).toBe(want);
    }
  });

  it('the two teams get DIFFERENT crystal materials', () => {
    const a = buildStructure('tower', 0);
    const e = buildStructure('tower', 1);
    const ga = visible(a).find((m) => matOf(m).emissiveIntensity > 1.5)!;
    const ge = visible(e).find((m) => matOf(m).emissiveIntensity > 1.5)!;
    expect(matOf(ga).color.getHex()).not.toBe(matOf(ge).color.getHex());
  });
});

describe('the anim part is typed, coloured, and free of side-channels', () => {
  it.each(['tower', 'ancient'] as const)('%s: AnimPart is fully populated', (kind) => {
    const a = animOf(buildStructure(kind, 0));
    expect(a.surfaceId).toBe('crystal');
    expect(a.tint).toBe(APAL.azure);
    expect(a.emissive?.colorKey).toBe('azure');
    expect(a.emissive?.intensity).toBeGreaterThan(0);
    expect(a.bloom).toBe(true);
    // WITHOUT THIS IT RENDERS BLACK AND TYPECHECKS PERFECTLY.
    const col = a.geo.getAttribute('color');
    expect(col).toBeDefined();
    expect(col.itemSize).toBe(3);
    expect(col.count).toBe(a.geo.getAttribute('position').count);
    for (let i = 0; i < col.count * 3; i++) expect(col.array[i]).toBe(1);
  });

  it.each(['tower', 'ancient'] as const)('%s: no userData.rift* side-channel', (kind) => {
    const a = animOf(buildStructure(kind, 0));
    for (const k of Object.keys(a.geo.userData)) expect(k.startsWith('rift')).toBe(false);
  });

  it('the resolver builds the same material the AnimPart describes', () => {
    const a = animOf(buildStructure('ancient', 1));
    const mat = partMaterial(a.surfaceId, a.tint, a.emissive);
    expect(`#${mat.color.getHexString()}`).toBe(APAL.ember);
    expect(`#${mat.emissive.getHexString()}`).toBe(APAL.ember);
    expect(mat.emissiveIntensity).toBe(a.emissive?.intensity);
  });

  it('the two anim parts are DIFFERENT — the ward-eye bug was one shared material', () => {
    const tower = animOf(buildStructure('tower', 0));
    const ancient = animOf(buildStructure('ancient', 0));
    expect(tower.emissive?.intensity).not.toBe(ancient.emissive?.intensity);
    expect(partMaterial(tower.surfaceId, tower.tint, tower.emissive)).not.toBe(
      partMaterial(ancient.surfaceId, ancient.tint, ancient.emissive),
    );
  });
});

describe('the fixed -Z camera can actually see the team identity', () => {
  it.each(KINDS)('%s: the banner bucket reaches the frame', (kind) => {
    const b = buildStructure(kind, 0);
    const cloth = bucketFor(b, 'rift:cloth');
    const [seen, front] = reachesCamera(cloth, meshes(b));
    // Shipped: 2 of 48 on the tower and 0 of 48 on the guard, because both
    // banners hung on the +Z half.
    expect(front).toBeGreaterThan(0);
    expect(seen).toBeGreaterThanOrEqual(12);
    expect(seen / front).toBeGreaterThan(0.75);
  });

  it.each(KINDS)('%s: banner geometry sits on the NEAR half', (kind) => {
    const b = buildStructure(kind, 0);
    const box = boxOf([bucketFor(b, 'rift:cloth')]);
    const centre = box.getCenter(new THREE.Vector3());
    expect(centre.z).toBeLessThan(0);
  });

  it("the Ancient's heart is not buried behind its own torso", () => {
    const b = buildStructure('ancient', 0);
    // Shipped: 60 of 60 sample points blocked, at every point of the bob.
    for (const bob of [-0.3, 0, 0.3]) {
      const [blocked, n] = animBlocked(b, bob);
      expect(n).toBeGreaterThan(0);
      expect(blocked / n).toBeLessThan(0.2);
    }
  });

  it('the lane tower arcade is open — the fire is what you see from above', () => {
    const b = buildStructure('tower', 0);
    const down = new THREE.Raycaster(new THREE.Vector3(0, 40, 0), new THREE.Vector3(0, -1, 0));
    let best = Infinity;
    let name = 'nothing';
    for (const m of visible(b)) {
      for (const h of down.intersectObject(m, false)) {
        if (h.distance < best) {
          best = h.distance;
          name = matOf(m).name;
        }
      }
    }
    // With the lintels running radially they crossed over the middle and this
    // was `rift:monumentStone`.
    expect(name).toContain('crystal');
  });
});

describe('the guard is not a lane tower', () => {
  it('it is measurably LOWER, not taller', () => {
    const tower = boxOf(visible(buildStructure('tower', 0)));
    const guard = boxOf(visible(buildStructure('guard', 0)));
    // Shipped: guard 9.58 against tower 9.41 — taller, under a comment saying
    // "a shade lower".
    expect(guard.max.y).toBeLessThan(tower.max.y - 0.2);
  });

  it('it is measurably BROADER', () => {
    const tower = boxOf(visible(buildStructure('tower', 0)));
    const guard = boxOf(visible(buildStructure('guard', 0)));
    const w = (b: THREE.Box3): number => b.max.x - b.min.x;
    expect(w(guard) / w(tower)).toBeGreaterThan(1.12);
  });

  it('it carries NO orbiting crystal, and the lane tower does', () => {
    expect(buildStructure('guard', 0).anim).toBeNull();
    expect(buildStructure('guard', 0).animKind).toBeNull();
    expect(buildStructure('tower', 0).anim).not.toBeNull();
    expect(buildStructure('tower', 0).animKind).toBe('orbit');
  });
});

describe('the hp bar is hung off the measured mesh, not off a typed number', () => {
  it.each(KINDS)('%s: barH clears the stone by a small constant', (kind) => {
    const b = buildStructure(kind, 0);
    const top = boxOf(visible(b)).max.y;
    expect(b.barH - top).toBeGreaterThan(0.2);
    expect(b.barH - top).toBeLessThan(0.6);
  });
});

describe('nothing that should be sitting on stone is floating off it', () => {
  it.each(['tower', 'guard'] as const)('%s: weathering lumps cross the shaft', (kind) => {
    const b = buildStructure(kind, 0);
    const rough = bucketFor(b, 'rift:cliffRock', '#6d737b');
    const dressed = bucketFor(b, 'rift:monumentStone');
    for (const l of lumps(rough.geometry).filter((x) => x.centroid.y > 1.2)) {
      expect(contactGap(rough.geometry, l, dressed.geometry)).toBeLessThan(1e-4);
    }
  });

  it('ancient: every torso crack crosses the torso', () => {
    const b = buildStructure('ancient', 0);
    const rough = bucketFor(b, 'rift:cliffRock', '#6d737b');
    const dressed = bucketFor(b, 'rift:monumentStone');
    const cracks = lumps(rough.geometry).filter((x) => x.centroid.y > 3.5);
    // 6 flank scars + 2 chest scars. Shipped: 3 of these stood up to 0.0610 m
    // clear of the stone.
    expect(cracks.length).toBe(8);
    for (const l of cracks) {
      expect(contactGap(rough.geometry, l, dressed.geometry)).toBeLessThan(1e-4);
    }
  });

  it('tower: every crown finial is seated on the arcade', () => {
    const b = buildStructure('tower', 0);
    const dressed = bucketFor(b, 'rift:monumentStone');
    const finials = lumps(dressed.geometry).filter((x) => x.centroid.y > 9.0);
    expect(finials.length).toBe(4);
    for (const l of finials) {
      // Shipped: exactly 0.2500 m of air under all four.
      expect(contactGap(dressed.geometry, l, dressed.geometry, new Set(l.tris))).toBeLessThan(1e-4);
    }
  });
});

describe('the draw-call budget (AMENDMENT_3 §D)', () => {
  // renderer.info needs a real context, so what is pinned here is the input the
  // draw count is a function of: buckets per archetype and casters per
  // archetype. The measured frame is quoted above `buildStructure`.
  it.each([
    ['tower', 4, 2],
    ['guard', 4, 2],
    ['ancient', 7, 4],
  ] as const)('%s: %i visible buckets, %i of them shadow casters', (kind, buckets, casters) => {
    const b = buildStructure(kind, 0);
    expect(visible(b).length).toBe(buckets);
    expect(visible(b).filter((m) => m.castShadow).length).toBe(casters);
  });

  it('banners, ferns and flames stay out of the shadow pass (§D.2)', () => {
    for (const kind of KINDS) {
      const b = buildStructure(kind, 0);
      for (const m of visible(b)) {
        const n = matOf(m).name;
        if (n === 'rift:cloth' || n === 'rift:fern' || matOf(m).emissiveIntensity > 1.5) {
          expect(m.castShadow).toBe(false);
        }
      }
    }
  });

  it('the hidden damage bucket costs nothing in either pass', () => {
    for (const kind of KINDS) {
      for (const m of hidden(buildStructure(kind, 0))) expect(m.visible).toBe(false);
    }
  });
});

describe('determinism', () => {
  it.each(KINDS)('%s: the same arguments produce the same geometry', (kind) => {
    const a = buildStructure(kind, 0);
    const b = buildStructure(kind, 0);
    const pa = a.body.parts.map((p) => p.geo.getAttribute('position').array);
    const pb = b.body.parts.map((p) => p.geo.getAttribute('position').array);
    expect(pa.length).toBe(pb.length);
    for (let i = 0; i < pa.length; i++) expect(Array.from(pa[i]!)).toEqual(Array.from(pb[i]!));
  });
});
