// ============================================================================
// SKI SPLAT — PlantField (task R2, CONTRACT §7). The in-piste gameplay plants:
// ONE InstancedMesh per kind (pine/bush/thorn), each instancing a baked
// vertex-coloured archetype built from the STYLE_BIBLE model sheets:
//   pine  = 3-4 stacked cones (pineDark -> pine -> pineLit) on a stub bark
//           trunk, snowLit dust-cap cones on every tier;
//   bush  = 2-3 squashed foliage spheres (shrub/shrubDark/shrubLit),
//           half-buried, snowLit cap;
//   thorn = bare angular branch cylinders radiating low (thorn/thornLit —
//           the warm "danger" read).
// An InstancedMesh carries exactly one material, so each archetype is merged
// into a single vertex-coloured geometry (all colours traced from SPAL) and
// drawn with one shared vertexColors Lambert: 3 draw calls for every plant on
// the mountain.
//
// hitPlant(plantIx) squashes/shakes that one instance for ~0.4 s (plants are
// NOT consumed — the sim re-arms them). update(dt, camZ) advances hit anims
// and distance-culls per PLANT_BAND_M z-band: bands farther than CULL_M from
// the camera get their instances scaled to zero, restored when they re-enter.
// Per-frame cost is O(activeHits + bands); matrices are only rewritten when a
// band flips or a hit animates. Zero per-frame allocation.
// ============================================================================

import * as THREE from 'three';
import { cone, cyl, sphere, at, bake, type MatFn } from '../contract/visual.js';
import { PLANT_BAND_M, SPAL } from '@splat/shared';
import type { PlantKind, SlopeDef } from '@splat/shared';
import { rng } from '@platform/shared';

// ---- local material factory (visual.ts MatFn seam; hex only from SPAL) -----
const matCache = new Map<string, THREE.MeshLambertMaterial>();
const mat: MatFn = (hex: string) => {
  let m = matCache.get(hex);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color: hex, flatShading: true });
    matCache.set(hex, m);
  }
  return m;
};

/** One material for every plant instance on the mountain (vertex colours). */
const plantMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

const KINDS: readonly PlantKind[] = ['pine', 'bush', 'thorn'];
const CULL_M = 150; // contract: instances beyond 150 m scaled to zero
const HIT_S = 0.4; // squash/shake duration (s)
const HIT_CAP = 64; // max concurrent hit anims (ring, never allocated at runtime)
const TAU = Math.PI * 2;

// Scratch objects for matrix composition (no per-frame allocation).
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Archetype prototypes (feet at y=0, facing arbitrary — instanced yaw varies).
// ---------------------------------------------------------------------------

/** Pine sapling: stub trunk + 4 stacked cones + snow dust caps, ~1.9 m tall. */
function pineProto(): THREE.Group {
  const g = new THREE.Group();
  g.add(at(cyl(mat, 0.05, 0.085, 0.42, 6, SPAL.bark), 0, 0.21, 0));
  // [radius, height, yBase, hex] bottom -> top; hue lightens with height so the
  // sun-lit tip reads against the darker base even before shadows land.
  const tiers: ReadonlyArray<readonly [number, number, number, string]> = [
    [0.62, 0.62, 0.3, SPAL.pineDark],
    [0.48, 0.58, 0.72, SPAL.pine],
    [0.34, 0.52, 1.1, SPAL.pineLit],
    [0.21, 0.44, 1.44, SPAL.pineLit],
  ];
  for (const [r, h, y, hex] of tiers) {
    g.add(at(cone(mat, r, h, 7, hex), 0, y + h / 2, 0));
    // Snow dust cap: a flat snowLit cone sitting on the sloped shoulder of the
    // tier (radius matched to the cone's taper at that height, plus a lip).
    const f = 0.55;
    g.add(at(cone(mat, r * (1 - f) + 0.07, 0.1, 6, SPAL.snowLit), 0, y + h * f, 0));
  }
  // Snow tip on the apex.
  g.add(at(cone(mat, 0.09, 0.16, 5, SPAL.snowLit), 0, 1.44 + 0.44 - 0.03, 0));
  return g;
}

/** Powder bush: 3 squashed foliage spheres, half-buried, snow caps. */
function bushProto(): THREE.Group {
  const g = new THREE.Group();
  const blob = (r: number, hex: string, x: number, y: number, z: number, sy: number): THREE.Mesh => {
    const m = sphere(mat, r, 8, hex);
    m.scale.set(1, sy, 1);
    return at(m, x, y, z);
  };
  g.add(blob(0.55, SPAL.shrub, 0, 0.26, 0, 0.58));
  g.add(blob(0.42, SPAL.shrubDark, 0.38, 0.18, 0.16, 0.52));
  g.add(blob(0.38, SPAL.shrubLit, -0.33, 0.22, -0.18, 0.58));
  // Snow caps hugging the top of each blob.
  g.add(blob(0.34, SPAL.snowLit, 0, 0.5, 0, 0.2));
  g.add(blob(0.24, SPAL.snowLit, 0.38, 0.36, 0.16, 0.18));
  g.add(blob(0.2, SPAL.snowLit, -0.33, 0.4, -0.18, 0.18));
  return g;
}

/** Thorn thicket: bare angular branches radiating low, warm danger hue. */
function thornProto(): THREE.Group {
  const g = new THREE.Group();
  g.add(at(cyl(mat, 0.06, 0.1, 0.2, 6, SPAL.bark), 0, 0.1, 0));
  // [yaw, outward tilt (rad), length, hex] — fixed asymmetric fan; per-instance
  // yaw rotation at build time gives each thicket its own silhouette.
  const branches: ReadonlyArray<readonly [number, number, number, string]> = [
    [0.0, 0.5, 1.15, SPAL.thorn],
    [0.9, 0.85, 0.95, SPAL.thornLit],
    [1.8, 0.62, 1.25, SPAL.thorn],
    [2.7, 0.95, 0.85, SPAL.thorn],
    [3.6, 0.55, 1.1, SPAL.thornLit],
    [4.5, 0.8, 1.0, SPAL.thorn],
    [5.4, 0.42, 1.3, SPAL.thornLit],
  ];
  for (const [yaw, tilt, len, hex] of branches) {
    const pivot = new THREE.Group();
    pivot.rotation.set(0, yaw, 0);
    const arm = new THREE.Group();
    arm.rotation.x = tilt;
    arm.add(at(cyl(mat, 0.016, 0.05, len, 5, hex), 0, len / 2, 0));
    // One kinked twig near the tip — the angular "nasty" read.
    const twig = at(cyl(mat, 0.01, 0.026, len * 0.45, 4, hex), 0, len * 0.86, 0);
    twig.rotation.x = -0.7;
    arm.add(twig);
    pivot.add(arm);
    g.add(pivot);
  }
  // A little caught snow at the branch bases.
  g.add(at(sphere(mat, 0.09, 6, SPAL.snowLit), 0.14, 0.06, 0.1));
  g.add(at(sphere(mat, 0.07, 6, SPAL.snowLit), -0.12, 0.05, -0.08));
  return g;
}

// ---------------------------------------------------------------------------
// Vertex-colour merge: an InstancedMesh has ONE material, so the baked
// per-material archetype is flattened into a single geometry with a `color`
// attribute per vertex (the material's SPAL colour). Colours still trace 1:1
// to SPAL — this is the same vertex-colour path R1's terrain uses.
// ---------------------------------------------------------------------------
function mergeVertexColored(root: THREE.Group): THREE.BufferGeometry {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((c) => {
    if (c instanceof THREE.Mesh) meshes.push(c);
  });
  let vCount = 0;
  let iCount = 0;
  for (const m of meshes) {
    const geo = m.geometry;
    const posAttr = geo.getAttribute('position');
    if (posAttr === undefined) continue;
    vCount += posAttr.count;
    const idx = geo.getIndex();
    iCount += idx === null ? posAttr.count : idx.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const ind = new Uint32Array(iCount);
  let vOff = 0;
  let iOff = 0;
  const nm = new THREE.Matrix3();
  const p = new THREE.Vector3();
  for (const m of meshes) {
    const geo = m.geometry;
    const posAttr = geo.getAttribute('position');
    if (posAttr === undefined) continue;
    const norAttr = geo.getAttribute('normal');
    const color = (m.material as THREE.MeshLambertMaterial).color;
    nm.getNormalMatrix(m.matrixWorld);
    const n = posAttr.count;
    for (let i = 0; i < n; i++) {
      p.fromBufferAttribute(posAttr, i).applyMatrix4(m.matrixWorld);
      pos[(vOff + i) * 3] = p.x;
      pos[(vOff + i) * 3 + 1] = p.y;
      pos[(vOff + i) * 3 + 2] = p.z;
      if (norAttr !== undefined) {
        p.fromBufferAttribute(norAttr, i).applyMatrix3(nm).normalize();
        nor[(vOff + i) * 3] = p.x;
        nor[(vOff + i) * 3 + 1] = p.y;
        nor[(vOff + i) * 3 + 2] = p.z;
      }
      col[(vOff + i) * 3] = color.r;
      col[(vOff + i) * 3 + 1] = color.g;
      col[(vOff + i) * 3 + 2] = color.b;
    }
    const idx = geo.getIndex();
    if (idx === null) {
      for (let i = 0; i < n; i++) ind[iOff + i] = vOff + i;
      iOff += n;
    } else {
      for (let i = 0; i < idx.count; i++) ind[iOff + i] = vOff + idx.getX(i);
      iOff += idx.count;
    }
    vOff += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(ind, 1));
  return out;
}

/** Free every geometry under a group (factory-built prototypes are per-field). */
function disposeGeometries(root: THREE.Object3D): void {
  root.traverse((c) => {
    if (c instanceof THREE.Mesh) c.geometry.dispose();
  });
}

// ---------------------------------------------------------------------------
// Per-kind instanced field.
// ---------------------------------------------------------------------------
interface KindField {
  readonly mesh: THREE.InstancedMesh;
  readonly count: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly rot: Float32Array; // base yaw per instance
  readonly scl: Float32Array; // base uniform scale per instance
  readonly band: Int32Array; // instance -> z band
  readonly bandStart: Int32Array; // band -> first instance (instances z-sorted)
  readonly bandCount: Int32Array; // band -> instance count
  readonly bandVis: Uint8Array; // band -> currently visible
  readonly bandN: number;
}

export class PlantField {
  private readonly world: THREE.Scene;
  private readonly fields: KindField[] = [];
  /** slope.plants index -> (kind, instance) remap (contract: precomputed). */
  private readonly plantKind: Int8Array;
  private readonly plantInst: Int32Array;
  /** Active hit anims: fixed-capacity ring, swap-remove on completion. */
  private readonly hitK = new Int8Array(HIT_CAP);
  private readonly hitI = new Int32Array(HIT_CAP);
  private readonly hitT = new Float32Array(HIT_CAP);
  private hitN = 0;

  constructor(world: THREE.Scene, slope: SlopeDef) {
    this.world = world;
    const plants = slope.plants;
    this.plantKind = new Int8Array(plants.length).fill(-1);
    this.plantInst = new Int32Array(plants.length).fill(-1);

    const protos: Record<PlantKind, () => THREE.Group> = {
      pine: pineProto,
      bush: bushProto,
      thorn: thornProto,
    };
    const sink: Record<PlantKind, number> = { pine: 0.05, bush: 0.22, thorn: 0.06 };
    const scaleLo: Record<PlantKind, number> = { pine: 0.65, bush: 0.7, thorn: 0.8 };
    const scaleHi: Record<PlantKind, number> = { pine: 1.15, bush: 1.2, thorn: 1.25 };

    for (let k = 0; k < KINDS.length; k++) {
      const kind = KINDS[k];
      if (kind === undefined) continue;
      // Instances sorted by z so each band owns one contiguous run.
      const ixs: number[] = [];
      for (let i = 0; i < plants.length; i++) {
        if (plants[i]?.kind === kind) ixs.push(i);
      }
      ixs.sort((a, b) => (plants[a]?.z ?? 0) - (plants[b]?.z ?? 0));
      const count = ixs.length;

      const proto = protos[kind]();
      const baked = bake(proto);
      const geo = mergeVertexColored(baked);
      disposeGeometries(proto);
      disposeGeometries(baked);

      const mesh = new THREE.InstancedMesh(geo, plantMat, count);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const px = new Float32Array(count);
      const py = new Float32Array(count);
      const pz = new Float32Array(count);
      const rot = new Float32Array(count);
      const scl = new Float32Array(count);
      const band = new Int32Array(count);
      let maxBand = 0;
      const next = rng(slope.seed + (k + 1) * 1009);
      for (let i = 0; i < count; i++) {
        const plantIx = ixs[i];
        const p = plantIx === undefined ? undefined : plants[plantIx];
        if (plantIx === undefined || p === undefined) continue;
        px[i] = p.x;
        pz[i] = p.z;
        py[i] = slope.height(p.x, p.z) - sink[kind];
        rot[i] = next() * TAU;
        scl[i] = scaleLo[kind] + next() * (scaleHi[kind] - scaleLo[kind]);
        const b = Math.floor(p.z / PLANT_BAND_M);
        band[i] = b;
        if (b > maxBand) maxBand = b;
        this.plantKind[plantIx] = k;
        this.plantInst[plantIx] = i;
      }
      const bandN = maxBand + 1;
      const bandStart = new Int32Array(bandN).fill(-1);
      const bandCount = new Int32Array(bandN);
      for (let i = 0; i < count; i++) {
        const b = band[i] ?? 0;
        bandCount[b] = (bandCount[b] ?? 0) + 1;
        if (bandStart[b] === -1) bandStart[b] = i;
      }
      const field: KindField = {
        mesh,
        count,
        px,
        py,
        pz,
        rot,
        scl,
        band,
        bandStart,
        bandCount,
        bandVis: new Uint8Array(bandN).fill(1), // everything visible until first update
        bandN,
      };
      for (let i = 0; i < count; i++) this.compose(field, i, 1, 0, false);
      mesh.instanceMatrix.needsUpdate = true;
      this.fields.push(field);
      world.add(mesh);
    }
  }

  /** Write instance i's matrix: base transform, optional squash/jitter, or zero-scale hide. */
  private compose(f: KindField, i: number, squashY: number, jitter: number, hide: boolean): void {
    if (hide) {
      _m.makeScale(0, 0, 0);
    } else {
      _e.set(jitter, f.rot[i] ?? 0, jitter * 0.7);
      _m.makeRotationFromEuler(_e);
      const s = f.scl[i] ?? 1;
      _v.set(s, s * squashY, s);
      _m.scale(_v);
    }
    _m.setPosition(f.px[i] ?? 0, f.py[i] ?? 0, f.pz[i] ?? 0);
    _m.toArray(f.mesh.instanceMatrix.array as Float32Array, i * 16);
  }

  /** Current squash/jitter for an instance with a live hit anim (0 = none). */
  private hitState(k: number, inst: number): { squash: number; jitter: number } {
    for (let s = 0; s < this.hitN; s++) {
      if (this.hitK[s] === k && this.hitI[s] === inst) {
        const t = Math.min(this.hitT[s] ?? 0, HIT_S) / HIT_S;
        return {
          squash: 1 - 0.5 * Math.sin(Math.PI * t),
          jitter: Math.sin((this.hitT[s] ?? 0) * 55) * 0.12 * (1 - t),
        };
      }
    }
    return { squash: 1, jitter: 0 };
  }

  /** Squash/shake one plant briefly. Plants are NOT consumed (sim re-arms). */
  hitPlant(plantIx: number): void {
    const k = this.plantKind[plantIx];
    const inst = this.plantInst[plantIx];
    if (k === undefined || k < 0 || inst === undefined || inst < 0) return;
    let slot: number;
    if (this.hitN < HIT_CAP) {
      slot = this.hitN;
      this.hitN++;
    } else {
      // Ring full: recycle the oldest anim (largest t).
      slot = 0;
      for (let s = 1; s < HIT_CAP; s++) {
        if ((this.hitT[s] ?? 0) > (this.hitT[slot] ?? 0)) slot = s;
      }
    }
    this.hitK[slot] = k;
    this.hitI[slot] = inst;
    this.hitT[slot] = 0;
  }

  update(dt: number, camZ: number): void {
    // --- advance hit anims (swap-remove finished) ---
    let s = 0;
    while (s < this.hitN) {
      const t = (this.hitT[s] ?? 0) + dt;
      this.hitT[s] = t;
      const k = this.hitK[s] ?? 0;
      const inst = this.hitI[s] ?? 0;
      const field = this.fields[k];
      if (field !== undefined && (field.bandVis[field.band[inst] ?? 0] ?? 0) === 1) {
        if (t >= HIT_S) {
          this.compose(field, inst, 1, 0, false);
        } else {
          const st = this.hitState(k, inst);
          this.compose(field, inst, st.squash, st.jitter, false);
        }
        field.mesh.instanceMatrix.needsUpdate = true;
      }
      if (t >= HIT_S) {
        // Swap-remove: move the last live anim into this slot.
        this.hitN--;
        this.hitK[s] = this.hitK[this.hitN] ?? 0;
        this.hitI[s] = this.hitI[this.hitN] ?? 0;
        this.hitT[s] = this.hitT[this.hitN] ?? 0;
      } else {
        s++;
      }
    }

    // --- per-band distance culling (touch matrices only when a band flips) ---
    for (const f of this.fields) {
      for (let b = 0; b < f.bandN; b++) {
        if ((f.bandCount[b] ?? 0) === 0) continue;
        const z0 = b * PLANT_BAND_M;
        const z1 = z0 + PLANT_BAND_M;
        const vis = camZ - z1 <= CULL_M && z0 - camZ <= CULL_M ? 1 : 0;
        if (f.bandVis[b] === vis) continue;
        f.bandVis[b] = vis;
        const start = f.bandStart[b] ?? 0;
        const n = f.bandCount[b] ?? 0;
        for (let i = start; i < start + n; i++) {
          if (vis === 0) {
            this.compose(f, i, 1, 0, true);
          } else {
            const st = this.hitState(this.fields.indexOf(f), i);
            this.compose(f, i, st.squash, st.jitter, false);
          }
        }
        f.mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Remove all instanced meshes and free their geometries (slope rebuild). */
  dispose(): void {
    for (const f of this.fields) {
      this.world.remove(f.mesh);
      f.mesh.geometry.dispose();
      f.mesh.dispose(); // frees the instanceMatrix attribute
    }
    this.fields.length = 0;
    this.hitN = 0;
  }
}
