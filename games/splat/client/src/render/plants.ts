// ============================================================================
// SKI SPLAT — PlantField (task R2, CONTRACT §7). The in-piste gameplay plants:
// ONE InstancedMesh per kind (pine/bush/thorn), each instancing a baked
// vertex-coloured archetype built from the STYLE_BIBLE model sheets:
//   pine  = 5 tiers (pineDark -> pine -> pineLit) on a stub bark trunk — the
//           LOWEST tier sags outward (the weight-of-snow droop), every tier
//           carries TWO snow caps (flat + a smaller nested mid-shoulder one)
//           plus the apex tip and a base dust ring, and every instance leans
//           slightly (deterministic rot.z) so no two plants stand bolt-upright;
//   bush  = 5 squashed foliage blobs (shrub/shrubDark/shrubLit) incl. a
//           trailing shadow-side blob + top highlight, layered snow caps on
//           each, and bare shrubDark twig tips poking through the snow;
//   thorn = 9 bare angular branch cylinders radiating low (thorn/thornLit —
//           the warm "danger" read) with kinked twigs and snowLit spheres
//           caught in the branch crotches.
// An InstancedMesh carries exactly one material, so each archetype is merged
// into a single vertex-coloured geometry (all colours traced from SPAL) and
// drawn with one shared vertexColors Lambert: 3 draw calls for every plant on
// the mountain. Per-instance colour rides the SAME instanced draw: each plant
// picks one of its kind's frozen SPAL entries (pine/pineDark/pineLit for
// pines, the shrub tiers, the thorn tiers) via the seeded rng and the shared
// Lambert multiplies a mix of that entry with snowLit-white (the contract's
// "two SPAL entries" colour path) — so the green field is less uniform and no
// two plants read identical. The snowLit dust caps stay PURE white under the
// tint: a baked per-vertex `snowFlag` (1.0 on snowLit vertices) makes the
// shader skip the instanceColor multiply for exactly those vertices.
//
// hitPlant(plantIx) squashes/shakes that one instance for ~0.4 s (plants are
// NOT consumed — the sim re-arms them). update(dt, camZ) advances hit anims
// and distance-culls per PLANT_BAND_M z-band: bands farther than CULL_M from
// the camera get their instances scaled to zero, restored when they re-enter.
// Per-frame cost is O(activeHits + bands); matrices are only rewritten when a
// band flips or a hit animates. Zero per-frame allocation.
// ============================================================================

import * as THREE from 'three';
import { box, cone, cyl, sphere, at, bake, type MatFn } from '../contract/visual.js';
import { PLANT_BAND_M, SPAL } from '@splat/shared';
import type { PlantKind, SlopeDef } from '@splat/shared';
import { rng, rngInt, rngRange } from '@platform/shared';

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

// Per-instance SPAL tint (F3): keep the built-in vertex-colour × instance-colour
// multiply for foliage, then mix BACK to the baked colour where snowFlag is set
// — so snowLit dust stays bright white while each plant's green varies. GLSL3:
// three's prefix `#define attribute in` converts the attribute declaration.
plantMat.onBeforeCompile = (shader) => {
  shader.vertexShader =
    'attribute float snowFlag;\n' +
    shader.vertexShader.replace(
      '#include <color_vertex>',
      `#include <color_vertex>
      #ifdef USE_INSTANCING_COLOR
        vColor.rgb = mix(vColor.rgb * instanceColor.rgb, vColor.rgb, snowFlag);
      #endif`,
    );
};

const KINDS: readonly PlantKind[] = ['pine', 'bush', 'thorn'];
const CULL_M = 150; // contract: instances beyond 150 m scaled to zero
const HIT_S = 0.4; // squash/shake duration (s)
const HIT_CAP = 64; // max concurrent hit anims (ring, never allocated at runtime)
const TAU = Math.PI * 2;

// Scratch objects for matrix composition (no per-frame allocation).
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
// Scratch colours for the per-instance SPAL tint mix (build-time only).
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

// ---------------------------------------------------------------------------
// Archetype prototypes (feet at y=0, facing arbitrary — instanced yaw varies).
// ---------------------------------------------------------------------------

/** Pine: leaner + taller — 5 tiers, the LOWEST sagging under snow; every tier
 *  gets TWO snow caps (flat + a smaller nested one at the mid-shoulder) plus
 *  the apex tip and a base dust ring. ~2.3 m tall. */
function pineProto(): THREE.Group {
  const g = new THREE.Group();
  g.add(at(cyl(mat, 0.04, 0.07, 0.46, 6, SPAL.bark), 0, 0.23, 0));
  // [radius, height, yBase, hex] bottom -> top; hue lightens with height so the
  // sun-lit tip reads against the darker base even before shadows land. Radii
  // are ~12% leaner than R1, heights stretched so the tree reads taller.
  const tiers: ReadonlyArray<readonly [number, number, number, string]> = [
    [0.55, 0.6, 0.36, SPAL.pineDark],
    [0.42, 0.58, 0.82, SPAL.pine],
    [0.3, 0.54, 1.26, SPAL.pineLit],
    [0.19, 0.48, 1.66, SPAL.pineLit],
  ];
  for (const [r, h, y, hex] of tiers) {
    g.add(at(cone(mat, r, h, 7, hex), 0, y + h / 2, 0));
    // Flat snow dust cap on the tier's shoulder — BIGGER lip and taller than R1
    // so the caps read as deep powder even at a distance (F3).
    g.add(at(cone(mat, r * 0.5 + 0.09, 0.12, 6, SPAL.snowLit), 0, y + h * 0.55, 0));
    // Nested cap at the tier's mid-shoulder: smaller and snugger against the
    // taper, so the snow reads DEEP on every tier.
    g.add(at(cone(mat, r * 0.38 + 0.04, 0.07, 6, SPAL.snowLit), 0, y + h * 0.68, 0));
  }
  // LOWEST tier: two drooping skirt cones — tilted ~0.25 rad outward and with
  // their bases dropped below the first upright tier, the weight-of-snow read.
  const droop: ReadonlyArray<readonly [number, number, number, string]> = [
    [0.0, 0.52, 0.6, SPAL.pineDark],
    [Math.PI * 0.92, 0.46, 0.54, SPAL.pineDark],
  ];
  for (const [yaw, r, h, hex] of droop) {
    const pivot = new THREE.Group();
    pivot.position.set(0, 0.27, 0);
    pivot.rotation.set(0, yaw, 0);
    const arm = new THREE.Group();
    arm.rotation.x = 0.25; // the droop: sag outward from the trunk
    arm.add(at(cone(mat, r, h, 7, hex), 0, h / 2, 0));
    arm.add(at(cone(mat, r * 0.5 + 0.09, 0.12, 6, SPAL.snowLit), 0, h * 0.55, 0));
    arm.add(at(cone(mat, r * 0.38 + 0.04, 0.07, 6, SPAL.snowLit), 0, h * 0.68, 0));
    pivot.add(arm);
    g.add(pivot);
  }
  // Snow tip on the apex + a dust ring where the skirt meets the ground (both
  // upsized so the crown and the base contact read at distance — F3).
  g.add(at(cone(mat, 0.09, 0.22, 5, SPAL.snowLit), 0, 1.66 + 0.48 - 0.02, 0));
  g.add(at(cone(mat, 0.6, 0.11, 6, SPAL.snowLit), 0, 0.15, 0));
  return g;
}

/** Powder bush: 5 squashed foliage blobs (main + side dark/lit + a trailing
 *  shadow-side blob and a top highlight), layered snow caps on each, and bare
 *  twig tips poking through the snow on the shadow side. */
function bushProto(): THREE.Group {
  const g = new THREE.Group();
  const blob = (r: number, hex: string, x: number, y: number, z: number, sy: number): THREE.Mesh => {
    const m = sphere(mat, r, 8, hex);
    m.scale.set(1, sy, 1);
    return at(m, x, y, z);
  };
  g.add(blob(0.55, SPAL.shrub, 0, 0.26, 0, 0.58)); // main
  g.add(blob(0.4, SPAL.shrubDark, 0.38, 0.18, 0.16, 0.52)); // side dark
  g.add(blob(0.38, SPAL.shrubLit, -0.33, 0.22, -0.18, 0.58)); // side lit
  g.add(blob(0.34, SPAL.shrubDark, -0.55, 0.12, -0.24, 0.5)); // trailing shadow-side
  g.add(blob(0.3, SPAL.shrubLit, 0.08, 0.5, -0.22, 0.62)); // top highlight
  // Layered snow caps on every blob: a flat cap on the blob top + a smaller
  // nested tuft — the deep-dust read (caps sit slightly proud of the foliage).
  const caps: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 0, 0.579, 0.38], // main
    [0.38, 0.16, 0.388, 0.28], // side dark
    [-0.33, -0.18, 0.44, 0.26], // side lit
    [-0.55, -0.24, 0.29, 0.23], // trailing
    [0.08, -0.22, 0.686, 0.21], // top highlight
  ];
  for (const [x, z, top, cr] of caps) {
    g.add(blob(cr, SPAL.snowLit, x, top - 0.02, z, 0.32));
    g.add(blob(cr * 0.6, SPAL.snowLit, x, top - 0.02 + cr * 0.32, z, 0.3));
  }
  // Exposed twig tips on the shadow side, poking through the snow.
  const twig = (x: number, y: number, z: number, rx: number, rz: number): THREE.Mesh => {
    const t = at(cyl(mat, 0.015, 0.03, 0.2, 4, SPAL.shrubDark), x, y, z);
    t.rotation.set(rx, 0, rz);
    return t;
  };
  g.add(twig(-0.52, 0.28, -0.24, 0.4, -0.45));
  g.add(twig(-0.34, 0.36, -0.12, -0.35, 0.4));
  g.add(twig(0.34, 0.26, 0.18, 0.5, 0.35));
  return g;
}

/** Thorn thicket: 9 bare angular branches radiating low (warm danger hue),
 *  each with a kinked twig, and snowLit spheres caught in the branch crotches. */
function thornProto(): THREE.Group {
  const g = new THREE.Group();
  g.add(at(cyl(mat, 0.06, 0.1, 0.2, 6, SPAL.bark), 0, 0.1, 0));
  // [yaw, outward tilt (rad), length, hex, twig bend (rad)] — a fixed
  // asymmetric fan; per-instance yaw rotation gives each thicket its own
  // silhouette. Twig bends alternate so no two branches kink alike.
  const branches: ReadonlyArray<readonly [number, number, number, string, number]> = [
    [0.0, 0.5, 1.15, SPAL.thorn, -0.7],
    [0.9, 0.85, 0.95, SPAL.thornLit, -0.45],
    [1.8, 0.62, 1.25, SPAL.thorn, 0.6],
    [2.7, 0.95, 0.85, SPAL.thorn, -0.8],
    [3.6, 0.55, 1.1, SPAL.thornLit, 0.5],
    [4.5, 0.8, 1.0, SPAL.thorn, -0.55],
    [5.4, 0.42, 1.3, SPAL.thornLit, 0.65],
    [0.55, 0.68, 1.05, SPAL.thorn, -0.6],
    [2.15, 0.5, 1.2, SPAL.thornLit, 0.45],
  ];
  for (const [yaw, tilt, len, hex, bend] of branches) {
    const pivot = new THREE.Group();
    pivot.rotation.set(0, yaw, 0);
    const arm = new THREE.Group();
    arm.rotation.x = tilt;
    arm.add(at(cyl(mat, 0.03, 0.08, len, 5, hex), 0, len / 2, 0));
    // One kinked twig near the tip — the angular "nasty" read.
    const twig = at(cyl(mat, 0.02, 0.05, len * 0.45, 4, hex), 0, len * 0.86, 0);
    twig.rotation.x = bend;
    arm.add(twig);
    pivot.add(arm);
    g.add(pivot);
  }
  // Snow caught in the branch crotches: tiny spheres where branches fork —
  // two in twig crotches (matching branches 0 and 3), one at the base fan.
  const forks: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.0, 0.5, 1.15, 0.8],
    [2.7, 0.95, 0.85, 0.8],
  ];
  for (const [yaw, tilt, len, f] of forks) {
    const pivot = new THREE.Group();
    pivot.rotation.set(0, yaw, 0);
    const arm = new THREE.Group();
    arm.rotation.x = tilt;
    arm.add(at(sphere(mat, 0.075, 6, SPAL.snowLit), 0, len * f, 0));
    pivot.add(arm);
    g.add(pivot);
  }
  g.add(at(sphere(mat, 0.085, 6, SPAL.snowLit), 0.13, 0.06, 0.09));
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
  const snow = new Float32Array(vCount); // 1.0 on snowLit-white vertices (F3 shader)
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
      snow[vOff + i] = color.r >= 0.999 && color.g >= 0.999 && color.b >= 0.999 ? 1 : 0;
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
  out.setAttribute('snowFlag', new THREE.BufferAttribute(snow, 1));
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
  readonly lean: Float32Array; // base tilt per instance (rot.z, all kinds)
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
    // Wider scale ranges (F3): dwarf to oversized reads so the field never
    // reads uniform — the sim's hit radii are untouched, so gameplay is exact.
    const scaleLo: Record<PlantKind, number> = { pine: 0.55, bush: 0.6, thorn: 0.65 };
    const scaleHi: Record<PlantKind, number> = { pine: 1.35, bush: 1.3, thorn: 1.4 };
    // Per-kind rot.z lean amplitude (F3): every plant leans its own way.
    const leanAmt: Record<PlantKind, number> = { pine: 0.09, bush: 0.14, thorn: 0.12 };
    // Per-instance SPAL tint (F3): the frozen entries each kind may lean toward
    // (weighted — the mid tone is most common), mixed with snowLit-white by a
    // seeded strength so the hue/value jitter stays SLIGHT and never a new hex.
    const tintSet: Record<PlantKind, readonly string[]> = {
      pine: [SPAL.pine, SPAL.pineDark, SPAL.pineLit],
      bush: [SPAL.shrub, SPAL.shrubDark, SPAL.shrubLit],
      thorn: [SPAL.thorn, SPAL.thornLit],
    };
    const tintW: Record<PlantKind, readonly number[]> = {
      pine: [0.45, 0.3, 0.25],
      bush: [0.5, 0.25, 0.25],
      thorn: [0.55, 0.45],
    };

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
      // Shadow discipline (e2e draw-call budget < 80): in-piste plants are
      // small — their shadows vanish into the snow — and every caster doubles
      // its calls in the shadow pass. The LONG tree shadows the style bible
      // calls for come from the forest walls, which keep casting.
      mesh.castShadow = false;
      mesh.receiveShadow = true;

      const px = new Float32Array(count);
      const py = new Float32Array(count);
      const pz = new Float32Array(count);
      const rot = new Float32Array(count);
      const lean = new Float32Array(count);
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
        // Every plant leans its own way (deterministic rot.z) — wind-bent pines,
        // squat-drunk bushes, kicked thorns.
        lean[i] = (next() * 2 - 1) * leanAmt[kind];
        scl[i] = scaleLo[kind] + next() * (scaleHi[kind] - scaleLo[kind]);
        // Pick one of the kind's frozen SPAL entries (weighted via the seeded
        // rng), then mix toward snowLit-white by a seeded strength so the jitter
        // is slight; the snowFlag shader keeps the snowLit caps pure white.
        {
          const set = tintSet[kind];
          const w = tintW[kind];
          let u = next();
          let pick = 0;
          for (let j = 0; j < (set?.length ?? 1); j++) {
            u -= w?.[j] ?? 0;
            if (u <= 0) {
              pick = j;
              break;
            }
          }
          const strength = 0.25 + next() * 0.2; // 0.25–0.45
          const tint = _c1.set(set?.[pick] ?? SPAL.pine).lerp(_c2.set(SPAL.snowLit), 1 - strength);
          mesh.setColorAt(i, tint);
        }
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
        lean,
        scl,
        band,
        bandStart,
        bandCount,
        bandVis: new Uint8Array(bandN).fill(1), // everything visible until first update
        bandN,
      };
      for (let i = 0; i < count; i++) this.compose(field, i, 1, 0, false);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      this.fields.push(field);
      world.add(mesh);
    }
  }

  /** Write instance i's matrix: base transform, optional squash/jitter, or zero-scale hide. */
  private compose(f: KindField, i: number, squashY: number, jitter: number, hide: boolean): void {
    if (hide) {
      _m.makeScale(0, 0, 0);
    } else {
      _e.set(jitter, f.rot[i] ?? 0, (f.lean[i] ?? 0) + jitter * 0.7);
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

// ============================================================================
// §V3.4 MID-DISTANCE DRESSING (task W3, CONTRACT_V3 §12.3/§12.3b, STYLE_BIBLE_V3
// §V3.4). Purely cosmetic off-piste dressing at |x| in [DRESS_X_MIN, DRESS_X_MAX)
// -- clear of DRESSING_X_MIN=24.5 (terrain.ts's corridor law) and stopping
// before the forest wall at halfW+FOREST_IN=29.5. NEVER a collider, NEVER
// green or plant-shaped (three archetypes, ROCK/BARK/SNOW only -- the
// PlantField above is the only "verb" on the mountain; dressing that mimics
// it would be a lie). Uses its OWN isolated rng stream, rng(slope.seed ^
// DRESS_SALT) -- constructed here, never touching genSlope's sequential
// stream (§12.3c) or the gameplay `slope.plants` array PlantField reads.
// Placement is split into a pure, THREE-free function (buildDressingPlacements)
// so it is unit-testable without a renderer, mirroring how slope.ts separates
// generation from rendering.
// ============================================================================

export type DressArchetype = 'stone' | 'log' | 'twig';

export interface DressingInstance {
  readonly x: number;
  readonly z: number;
  readonly rot: number;
  readonly scale: number;
  readonly archetype: DressArchetype;
}

const DRESS_X_MIN = 27; // §V3.4 placement law: off-piste dressing band starts here
const DRESS_X_MAX = 29.5; // stop before the forest wall (halfW 28 + FOREST_IN 1.5)
const DRESS_Z_PAD = 60; // dressing continues into the runout, matching the forest wall
// Poisson slice thickness + per-slice lambda (art-director round: judge found
// the 15-60 m mid-distance band "reads almost empty" on a 5 m/lambda=1 grid --
// Poisson at that coarse a grain leaves ~37%-empty-slice gaps big enough to
// read as bare patches). Halving the slice and lambda together holds the SAME
// long-run rate (STYLE_BIBLE_V3 §V3.4 "lambda ~= 1 per 5 m") while sampling it
// twice as often, which shrinks the largest gap a seed can roll without
// changing the expected instance total (still bounded by DRESS_CAP below).
const DRESS_SLICE_DZ = 2.5;
const DRESS_CLUSTER_LAMBDA = 0.5;
const DRESS_CLUSTER_R = 7; // cluster scatter radius (m), STYLE_BIBLE_V3 §V3.4
// MIN raised 3 -> 4: a 3-member cluster reads as "two small blobs" per the
// judge note; 4-7 members reads as an actual cluster at the ~1-per-5m rate
// above. This is a mild (~+10%) rise in expected raw draws, still absorbed by
// the unchanged DRESS_CAP totals below (caps bind a little earlier into the
// run's tail, not before it -- the per-seed floor asserted at
// plants.test.ts:74 stays comfortably clear).
const DRESS_CLUSTER_MIN = 4;
const DRESS_CLUSTER_MAX = 7;
const DRESS_SALT = 0xa17d; // isolated client rng stream (distinct from terrain.ts's salts)
const DRESS_CULL_M = 120; // §V3.4 cull distance
const DRESS_BAND_M = PLANT_BAND_M; // reuse the existing 10 m spatial band for culling

// Target instance counts (approximate, STYLE_BIBLE_V3 §V3.4: ~400/~250/~250).
// Frozen totals -- plants.test.ts:69-71 asserts these exact ceilings, and
// CONTRACT_V3 §12.3e's "1900 + ~150 plants + ~900 dressing <= 3000" arithmetic
// is keyed to this total. Do not raise them; density fixes above operate on
// distribution evenness and per-instance legibility instead.
const DRESS_CAP: Readonly<Record<DressArchetype, number>> = { stone: 400, log: 250, twig: 250 };
const DRESS_WEIGHT: Readonly<Record<DressArchetype, number>> = { stone: 0.444, log: 0.278, twig: 0.278 };
// Nominal prototype size (see stoneProto/logProto/twigProto) x this range hits
// the STYLE_BIBLE_V3 §V3.4 size band per archetype: stone 0.4-1.2 m,
// log 1.5-3 m, twig 0.5-1 m. Floors raised (art-director round: distant
// low-end instances were "unresolvable smudges" / sub-pixel scratches) so
// every instance still lands inside its frozen size band but skews toward the
// legible upper half of it -- ceilings untouched, band never exceeded.
const DRESS_SCALE_RANGE: Readonly<Record<DressArchetype, readonly [number, number]>> = {
  stone: [0.9, 1.9],
  log: [0.9, 1.43],
  twig: [0.85, 1.33],
};

function dressPoisson(next: () => number, lambda: number): number {
  // Same Knuth algorithm as slope.ts's poisson (duplicated here -- shared/
  // slope.ts does not export it, and this stays a pure client-side scatter
  // with its own isolated rng stream, never touching genSlope's).
  if (lambda <= 0) return 0;
  const cut = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= next();
  } while (p > cut);
  return k - 1;
}

function gaussDress(next: () => number): number {
  // Box-Muller; local to this section (terrain.ts's gauss() is not exported).
  const u1 = Math.max(1e-9, next());
  const u2 = next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(TAU * u2);
}

function pickArchetype(next: () => number): DressArchetype {
  const u = next();
  if (u < DRESS_WEIGHT.stone) return 'stone';
  if (u < DRESS_WEIGHT.stone + DRESS_WEIGHT.log) return 'log';
  return 'twig';
}

// A gameplay plant's contact disc (centre + r) can reach past its centre's
// |x| < PLANT_X = 27 bound -- thorn's r is 0.9 m (config.ts PLANT_RADIUS), so
// a plant centred at x=26.9 reaches x=27.8, INTO the dressing band. Disjoint-
// ness therefore needs a real per-candidate clearance check, not just the
// band split. DRESS_PLANT_CLEAR adds a small margin beyond the bare radius
// (mirrors terrain.ts's DEBRIS_PLANT_CLEAR/BANK_CLEAR pattern).
const DRESS_PLANT_CLEAR = 0.05;

function clearOfPlants(slope: SlopeDef, x: number, z: number): boolean {
  for (const p of slope.plants) {
    const dx = p.x - x;
    const dz = p.z - z;
    const need = p.r + DRESS_PLANT_CLEAR;
    if (dx * dx + dz * dz < need * need) return false;
  }
  return true;
}

/**
 * Pure placement generator -- no THREE dependency, unit-testable. Seeded
 * Poisson-cluster scatter (lambda ~1 cluster / 5 m slice, 3-7 members per
 * cluster, radius ~7 m, organic clearings from Poisson(1)'s ~37% empty-slice
 * rate) restricted to |x| in [DRESS_X_MIN, DRESS_X_MAX) on both sides, with
 * every candidate clearance-checked against `slope.plants` (clearOfPlants) so
 * dressing is disjoint from gameplay plants even where a plant's contact disc
 * reaches into the dressing band.
 */
export function buildDressingPlacements(slope: SlopeDef): DressingInstance[] {
  const next = rng(slope.seed ^ DRESS_SALT);
  const z1 = slope.finishZ + DRESS_Z_PAD;
  const sliceCount = Math.ceil(z1 / DRESS_SLICE_DZ);
  const counts: Record<DressArchetype, number> = { stone: 0, log: 0, twig: 0 };
  const out: DressingInstance[] = [];

  for (let i = 0; i < sliceCount; i++) {
    const sliceZ0 = i * DRESS_SLICE_DZ;
    const nClusters = dressPoisson(next, DRESS_CLUSTER_LAMBDA);
    for (let c = 0; c < nClusters; c++) {
      const side = next() < 0.5 ? -1 : 1;
      const bandAbsX = DRESS_X_MIN + rngRange(next, 0, DRESS_X_MAX - DRESS_X_MIN);
      const cz = rngRange(next, sliceZ0, sliceZ0 + DRESS_SLICE_DZ);
      const size = rngInt(next, DRESS_CLUSTER_MIN, DRESS_CLUSTER_MAX);
      for (let m = 0; m < size; m++) {
        const archetype = pickArchetype(next);
        if ((counts[archetype] ?? 0) >= (DRESS_CAP[archetype] ?? 0)) continue; // budget honoured, never exceeded
        // Lateral jitter is small and CLAMPED to the band (it must never cross
        // DRESS_X_MIN back toward the piste, nor DRESS_X_MAX past the forest
        // wall); z jitter gets the full cluster radius -- the band is only
        // 2.5 m wide, so "organic" scatter reads along z, not across x.
        const absX = Math.min(
          DRESS_X_MAX,
          Math.max(DRESS_X_MIN, bandAbsX + gaussDress(next) * DRESS_CLUSTER_R * 0.18),
        );
        const z = cz + gaussDress(next) * DRESS_CLUSTER_R * 0.55;
        if (z < 0) continue; // stay downhill of the summit shoulder
        const x = side * absX;
        if (!clearOfPlants(slope, x, z)) continue; // never overlap a gameplay plant's disc
        const [lo, hi] = DRESS_SCALE_RANGE[archetype];
        out.push({
          x,
          z,
          rot: next() * TAU,
          scale: lo + next() * (hi - lo),
          archetype,
        });
        counts[archetype] = (counts[archetype] ?? 0) + 1;
      }
    }
  }
  return out;
}

// ---- archetype prototypes (feet/ground-contact at y=0) ----------------------

/** Snow-crusted stone: an angular rock body + rockLit facet + a snowLit dust
 *  cap. Nominal ~0.62 m; per-instance scale spans the STYLE_BIBLE_V3
 *  0.4-1.2 m range (DRESS_SCALE_RANGE.stone). */
function stoneProto(): THREE.Group {
  const g = new THREE.Group();
  const body = box(mat, 0.62, 0.42, 0.54, SPAL.rock);
  body.rotation.y = 0.35;
  g.add(at(body, 0, 0.21, 0));
  const facet = sphere(mat, 0.26, 6, SPAL.rockLit);
  g.add(at(facet, 0.18, 0.32, 0.1));
  const cap = sphere(mat, 0.28, 6, SPAL.snowLit);
  cap.scale.set(1, 0.36, 1);
  g.add(at(cap, -0.02, 0.42, -0.03));
  return g;
}

/** Half-buried log: a bark cylinder lying on its side with a flattened
 *  snowLit cap along the top ridge -- only the upper half reads above the
 *  snow line (MountainDressing sinks it further at placement). Nominal
 *  ~2.1 m; per-instance scale spans 1.5-3 m (DRESS_SCALE_RANGE.log). */
function logProto(): THREE.Group {
  const g = new THREE.Group();
  const body = cyl(mat, 0.22, 0.24, 2.1, 7, SPAL.bark);
  body.rotation.z = Math.PI / 2;
  g.add(at(body, 0, 0.22, 0));
  const cap = cyl(mat, 0.15, 0.16, 1.95, 6, SPAL.snowLit);
  cap.rotation.z = Math.PI / 2;
  cap.scale.set(1, 1, 0.55);
  g.add(at(cap, 0, 0.36, 0));
  return g;
}

/** Exposed twig cluster: bare bark branches radiating from a buried stub --
 *  NO foliage, no snow cap (STYLE_BIBLE_V3 §V3.4: bark only, nothing green).
 *  Nominal ~0.75 m; per-instance scale spans 0.5-1 m (DRESS_SCALE_RANGE.twig).
 *
 *  Rebuilt (art-director round): the prior version was 0.02-0.045 m radius
 *  cylinders on 4-segment rings -- at mid-distance those alias to 1-2 px
 *  lines that read as lens scratches, and next to the chunky faceted pine/
 *  thorn archetypes it read as a different, thinner asset. Radii are ~2x
 *  heavier and segment counts match thornProto's (5-6 sides, not 4) for the
 *  same low-poly facet density as the rest of the plant kit; each main branch
 *  gets a kinked sub-twig (thornProto's silhouette trick) and the two tiers
 *  alternate `bark`/`lodge` for the "brown ramp" two-tone read the judge asked
 *  for -- both already-frozen SPAL entries, no new hex. */
function twigProto(): THREE.Group {
  const g = new THREE.Group();
  g.add(at(cyl(mat, 0.06, 0.09, 0.22, 6, SPAL.bark), 0, 0.11, 0));
  // [yaw, outward tilt, length, hex, twig bend] -- fixed asymmetric fan, per-
  // instance yaw rotation gives each cluster its own silhouette.
  const branches: ReadonlyArray<readonly [number, number, number, string, number]> = [
    [0.0, 0.4, 0.62, SPAL.bark, -0.55],
    [1.15, 0.62, 0.48, SPAL.lodge, 0.4],
    [2.3, 0.35, 0.68, SPAL.bark, -0.5],
    [3.45, 0.68, 0.44, SPAL.lodge, 0.55],
    [4.6, 0.5, 0.58, SPAL.bark, -0.4],
    [5.75, 0.58, 0.5, SPAL.lodge, 0.5],
  ];
  for (const [yaw, tilt, len, hex, bend] of branches) {
    const pivot = new THREE.Group();
    pivot.rotation.y = yaw;
    const arm = new THREE.Group();
    arm.rotation.x = tilt;
    arm.add(at(cyl(mat, 0.038, 0.07, len, 6, hex), 0, len / 2, 0));
    const twig = at(cyl(mat, 0.022, 0.045, len * 0.4, 5, hex), 0, len * 0.88, 0);
    twig.rotation.x = bend;
    arm.add(twig);
    // Bark knuckle at the fork -- a small faceted node, matching the chunky
    // low-poly read of the pine tier joins, never snow (twig stays bark-only).
    arm.add(at(sphere(mat, 0.05, 6, SPAL.bark), 0, len * 0.84, 0));
    pivot.add(arm);
    g.add(pivot);
  }
  return g;
}

const DRESS_ARCHETYPES: readonly DressArchetype[] = ['stone', 'log', 'twig'];
// One shared vertex-coloured material for all dressing archetypes -- NOT
// `plantMat` above, which carries the snowFlag/instanceColor tint shader that
// only the gameplay foliage needs. No per-instance tint here.
const dressMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
// Per-archetype ground sink (m): logs read "half-buried", stones/twigs just
// grounded, never floating.
const DRESS_SINK: Readonly<Record<DressArchetype, number>> = { stone: 0.08, log: 0.32, twig: 0.03 };

// Scratch objects for matrix composition (module-level, zero per-frame
// allocation; distinct from PlantField's _m/_e/_v so the two classes never
// alias mutable state).
const _dm = new THREE.Matrix4();
const _de = new THREE.Euler();
const _dv = new THREE.Vector3();

interface DressField {
  readonly mesh: THREE.InstancedMesh;
  readonly count: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly rot: Float32Array;
  readonly scl: Float32Array;
  readonly band: Int32Array;
  readonly bandStart: Int32Array;
  readonly bandCount: Int32Array;
  readonly bandVis: Uint8Array;
  readonly bandN: number;
}

/**
 * §V3.4 mid-distance dressing: <=3 InstancedMeshes (one per archetype),
 * `castShadow = false` (a shadow caster costs two draw calls -- the same
 * discipline PlantField applies above), distance-culled at DRESS_CULL_M via
 * the same per-band-flip-only cost model PlantField uses (O(bands touched),
 * zero per-frame allocation). Purely cosmetic: no collider, never reads or
 * writes `slope.plants`, never touches the sim.
 */
export class MountainDressing {
  private readonly world: THREE.Scene;
  private readonly fields: DressField[] = [];

  constructor(world: THREE.Scene, slope: SlopeDef) {
    this.world = world;
    const placements = buildDressingPlacements(slope);
    const protos: Record<DressArchetype, () => THREE.Group> = {
      stone: stoneProto,
      log: logProto,
      twig: twigProto,
    };

    for (const archetype of DRESS_ARCHETYPES) {
      const ixs: number[] = [];
      for (let i = 0; i < placements.length; i++) {
        if (placements[i]?.archetype === archetype) ixs.push(i);
      }
      ixs.sort((a, b) => (placements[a]?.z ?? 0) - (placements[b]?.z ?? 0));
      const count = ixs.length;
      if (count === 0) continue; // a tiny/synthetic slope may draw zero of an archetype

      const proto = protos[archetype]();
      const baked = bake(proto);
      const geo = mergeVertexColored(baked);
      disposeGeometries(proto);
      disposeGeometries(baked);

      const mesh = new THREE.InstancedMesh(geo, dressMat, count);
      mesh.castShadow = false; // §12.3e: a caster costs two draw calls -- budget is +7, not +14
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // spans the whole run; per-band culling below owns visibility

      const px = new Float32Array(count);
      const py = new Float32Array(count);
      const pz = new Float32Array(count);
      const rot = new Float32Array(count);
      const scl = new Float32Array(count);
      const band = new Int32Array(count);
      let maxBand = 0;
      for (let i = 0; i < count; i++) {
        const ix = ixs[i];
        const p = ix === undefined ? undefined : placements[ix];
        if (p === undefined) continue;
        px[i] = p.x;
        pz[i] = p.z;
        py[i] = slope.height(p.x, p.z) - (DRESS_SINK[archetype] ?? 0);
        rot[i] = p.rot;
        scl[i] = p.scale;
        const b = Math.max(0, Math.floor(p.z / DRESS_BAND_M));
        band[i] = b;
        if (b > maxBand) maxBand = b;
      }
      const bandN = maxBand + 1;
      const bandStart = new Int32Array(bandN).fill(-1);
      const bandCount = new Int32Array(bandN);
      for (let i = 0; i < count; i++) {
        const b = band[i] ?? 0;
        bandCount[b] = (bandCount[b] ?? 0) + 1;
        if (bandStart[b] === -1) bandStart[b] = i;
      }
      const field: DressField = {
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
        bandVis: new Uint8Array(bandN).fill(1), // everything visible until first update()
        bandN,
      };
      for (let i = 0; i < count; i++) this.compose(field, i, false);
      mesh.instanceMatrix.needsUpdate = true;
      this.fields.push(field);
      world.add(mesh);
    }
  }

  /** Write instance i's matrix: base transform, or zero-scale (culled/hidden). */
  private compose(f: DressField, i: number, hide: boolean): void {
    if (hide) {
      _dm.makeScale(0, 0, 0);
    } else {
      _de.set(0, f.rot[i] ?? 0, 0);
      _dm.makeRotationFromEuler(_de);
      const s = f.scl[i] ?? 1;
      _dm.scale(_dv.set(s, s, s));
    }
    _dm.setPosition(f.px[i] ?? 0, f.py[i] ?? 0, f.pz[i] ?? 0);
    _dm.toArray(f.mesh.instanceMatrix.array as Float32Array, i * 16);
  }

  /** Distance-cull per DRESS_BAND_M band at DRESS_CULL_M (§V3.4): matrices are
   *  only rewritten when a band flips visibility, matching PlantField's cost
   *  model above. Call once per frame with the camera's world z. */
  update(camZ: number): void {
    for (const f of this.fields) {
      for (let b = 0; b < f.bandN; b++) {
        if ((f.bandCount[b] ?? 0) === 0) continue;
        const z0 = b * DRESS_BAND_M;
        const z1 = z0 + DRESS_BAND_M;
        const vis = camZ - z1 <= DRESS_CULL_M && z0 - camZ <= DRESS_CULL_M ? 1 : 0;
        if (f.bandVis[b] === vis) continue;
        f.bandVis[b] = vis;
        const start = f.bandStart[b] ?? 0;
        const n = f.bandCount[b] ?? 0;
        for (let i = start; i < start + n; i++) this.compose(f, i, vis === 0);
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
  }
}
