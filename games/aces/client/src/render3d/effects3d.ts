// ============================================================================
// ACES render3d/effects3d — bounded FX pools for the 3D layer (GRAPHICS_3D §4).
//
// Same verbs as the retired 2D EffectsApi, 3D bodies. Coordinate law §1:
// server (x, y) → scene (X=x, Z=y); altitude implied PLANE_Y unless noted
// (rings/explosions ride the cruise line, splash foam sits on the sea plane);
// velocity maps identically (vx→VX, vy_server→VZ).
//
// POOL ARCHITECTURE (parity with render/effects.ts): ONE dense struct-of-
// arrays particle pool capped at FX_POOL_MAX (=600) with SWAP-REMOVE kills —
// flood emissions are silently dropped, the live set can NEVER exceed the cap.
// RNG rolls happen BEFORE spawn attempts so consumption is independent of pool
// pressure (same seed + same emit sequence ⇒ identical particles). Two seeded
// streams: explicit events vs trail emitters, exactly like the 2D system.
//
// RENDER PATHS (all instanced / pooled, zero per-frame allocation):
//   PUFF   soft billboard masses (smoke/blast/flash/foam/glare/core/fire) —
//          ONE shared puff texture (materials.puffTexture) drawn through six
//          InstancedMesh ALPHA BUCKETS (quantized opacity = house ladder
//          idiom; per-instance tint via instanceColor). Built lazily in
//          attach() because the texture needs a canvas — construction stays
//          headless-testable.
//   STREAK oriented fading boxes — tracer stubs + spark ticks (instanced).
//   SHARD  lit tetrahedra with gravity+spin; land on the sea plane then
//          shrink-fade (opaque lambert, so fade = scale).
//   RING   expanding flat rings at plane altitude / sea level — a small pool
//          of dedicated meshes stepping through quantized-opacity materials.
//   TRACER stateless instanced pair rebuilt straight from bullet data each
//          drawProjectiles call — bright flash-amber core + dim tail segment,
//          pool 256 each (GRAPHICS_3D §4).
//
// SHAKE LAW: hitSpark→SMALL · small blast→MEDIUM · large blast→LARGE;
// accumulate + consume-and-reset, C_APP adds proximity context.
// ============================================================================

import * as THREE from 'three';
import {
  CRATES_MAX,
  CRATE_FALL_S,
  CRATE_PICKUP_R,
  FX_POOL_MAX,
  SHAKE,
} from '@aces/shared/config.js';
import type { CrateState } from '@aces/shared/types.js';
import { hashStr, makeRng, mixA } from '../contract/visual.js';
import { matBasic, matLambert, pal, puffTexture } from './materials.js';

/** §1 frozen coordinate law: cruise altitude. (Not yet hoisted into config —
 * value is the contract constant; see report note.) */
const PLANE_Y = 12;

const TAU = Math.PI * 2;

// ---- pools ------------------------------------------------------------------

const TRACER_POOL = 256; //    §4: instanced tracer boxes
const TRACER_CORE_LEN = 10; // bright core segment, u
const TRACER_TAIL_LEN = 3; //  dim tail segment, u — total streak ≈13u
const STUB_LEN = 13; //        trigger-down cosmetic stub matches the streak
const STREAK_POOL = 64;
const DEBRIS_POOL = 96;
const RING_POOL = 10;
const PUFF_BUCKETS = 6;
/** Active crates ≤ CRATES_MAX plus the falling buffer. */
const CRATE_POOL = CRATES_MAX * 2 + 2;
const CRATE_DROP_Y = PLANE_Y + 16; // born inside the cloud band (§1 clouds 26–34)
const CRATE_LAND_Y = 1.5;
const MAX_TRAILS = 24;
const SMOKE_INT = 0.1;
const EMBER_INT = 0.055;
const SHARD_G = 110; //        u/s² gravity on debris
const SHARD_REST_Y = 0.4;

/** Particle kinds. */
const PUFF = 0;
const SHARD = 1;
const RING = 2;
const STREAK = 3;

/** Style variants (which palette family tints the particle). */
const V_SMOKE = 0;
const V_BLAST = 1;
const V_FLASH = 2;
const V_FOAM = 3;
const V_GLARE = 4;
const V_CORE = 5;
const V_FIRE = 6;
const V_TRACER = 7; // amber streak tint (STREAK kind)
const V_DEB = 8; // debris ink family (SHARD kind)

/** Kind/style indices as an introspection aid for tests (retired-2D FX mirror). */
export const FX3 = {
  PUFF,
  SHARD,
  RING,
  STREAK,
  V_SMOKE,
  V_BLAST,
  V_FLASH,
  V_FOAM,
  V_GLARE,
  V_CORE,
  V_FIRE,
} as const;

/** Per-second velocity drag by kind. */
const DRAG = new Float32Array([0.8, 2.2, 0, 0.4]);

// ---- quantized palettes (built once — never per-frame strings) ---------------

const COL = {
  flash: new THREE.Color(pal('flash')),
  blast: new THREE.Color(pal('blast')),
  foam: new THREE.Color(pal('foam')),
  glare: new THREE.Color(pal('sunGlare')),
  fireC: new THREE.Color(pal('fireCore')),
  fireE: new THREE.Color(pal('fireEdge')),
  /** Bright flash-amber tracer core — pal('flash') mixed toward pal('tracer'). */
  tracerCore: new THREE.Color(mixA('flash', 'tracer', 0.42)),
  /** Same tone shaded toward ink for the dim tail segment (F1 fade). */
  tracerTail: new THREE.Color(mixA('flash', 'tracer', 0.42)).lerp(
    new THREE.Color(pal('ink')),
    0.45,
  ),
  debHold: new THREE.Color(mixA('smokeDk', 'debris', 0.72)),
};
/** smokeLt→smokeDk mid-life ramp, quantized into 7 steps (house ladder). */
const SMOKE_RAMP: readonly THREE.Color[] = Array.from({ length: 7 }, (_, i) =>
  new THREE.Color(mixA('smokeLt', 'smokeDk', i / 6)),
);
/** Blast-ring / foam-ring opacity ladders — rings step through these. */
function ringLadder(key: Parameters<typeof pal>[0]): readonly THREE.MeshBasicMaterial[] {
  return Array.from({ length: 8 }, (_, i) =>
    matBasic(pal(key), { transparent: true, opacity: ((i + 1) / 8) * 0.92, depthWrite: false }),
  );
}
const RING_BLAST = ringLadder('blast');
const RING_FOAM = ringLadder('foam');

export interface P3 {
  x: number;
  y: number;
}

export interface EffectsApi3D {
  muzzleFlash(p: P3, h: number): void;
  tracerStub(p: P3, h: number): void;
  drawProjectiles(list: ReadonlyArray<{ x: number; y: number; vx: number; vy: number }>): void;
  hitSpark(p: P3): void;
  explosion(p: P3, size: 'small' | 'large', overWater: boolean): void;
  trail(id: string, p: P3, level: 'smoke' | 'fire' | null): void;
  crateFx(kind: 'land' | 'pickup', p: P3): void;
  syncCrates(crates: readonly CrateState[]): void;
  shake(m: number): void;
  consumeShake(): number;
  attach(scene: THREE.Scene): void;
  update(dtS: number, camPos: { x: number; y: number }): void;
  dispose(): void;
}

interface TrailEmitter {
  x: number;
  z: number;
  /** 1 = smoke, 2 = fire (fire implies smoke too). */
  lvl: 1 | 2;
  acc: number;
  cnt: number;
}

interface RingSlot {
  mesh: THREE.Mesh;
  active: boolean;
  gen: number;
  x: number;
  z: number;
  y: number;
  r0: number;
  r1: number;
  age: number;
  ttl: number;
  foam: boolean;
}

interface CrateSlot {
  root: THREE.Group;
  sway: THREE.Group;
  canopy: THREE.Mesh;
  ring: THREE.Mesh;
  id: number;
  gen: number;
  falling: boolean;
  ph: number;
  t: number;
  x: number;
  z: number;
}

/**
 * The C_FX 3D effects system. Constructed once per client via createEffects3D.
 * Steady-state work mutates typed arrays and a fixed transform set only.
 */
class EffectsSystem3D implements EffectsApi3D {
  /** Live particle count — dense [0..n). */
  get alive(): number {
    return this.n;
  }

  get emitterCount(): number {
    return this.trails.size;
  }

  /** Tracers drawn by the last drawProjectiles call (cap binds at 256). */
  get tracerCount(): number {
    return this.tracerDrawn;
  }

  /** Active shock/foam rings (rings live in their own pooled-slot system). */
  get activeRings(): number {
    let c = 0;
    for (let i = 0; i < this.rings.length; i++) if (this.rings[i]!.active) c++;
    return c;
  }

  get crateSlotCount(): number {
    let used = 0;
    for (let i = 0; i < this.crates.length; i++) if (this.crates[i]!.gen >= 0) used++;
    return used;
  }

  /** Test/introspection handle for the pooled scene subtree. */
  get sceneRoot(): THREE.Object3D {
    return this.root;
  }

  private readonly rng: () => number;
  private readonly trng: () => number;
  private n = 0;
  private shakeAcc = 0;
  private time = 0;
  private attached = false;
  private tracerDrawn = 0;
  private ringGen = 0;
  private syncGen = 0;

  // ---- pool columns -----------------------------------------------------
  private readonly kind = new Uint8Array(FX_POOL_MAX);
  private readonly sty = new Uint8Array(FX_POOL_MAX);
  private readonly px = new Float32Array(FX_POOL_MAX);
  private readonly py = new Float32Array(FX_POOL_MAX);
  private readonly pz = new Float32Array(FX_POOL_MAX);
  private readonly vx = new Float32Array(FX_POOL_MAX);
  private readonly vy = new Float32Array(FX_POOL_MAX);
  private readonly vz = new Float32Array(FX_POOL_MAX);
  private readonly age = new Float32Array(FX_POOL_MAX);
  private readonly ttl = new Float32Array(FX_POOL_MAX);
  private readonly dly = new Float32Array(FX_POOL_MAX);
  private readonly r0 = new Float32Array(FX_POOL_MAX);
  private readonly r1 = new Float32Array(FX_POOL_MAX);
  private readonly rot = new Float32Array(FX_POOL_MAX);
  private readonly vrt = new Float32Array(FX_POOL_MAX);
  private readonly ln = new Float32Array(FX_POOL_MAX);
  private readonly al = new Float32Array(FX_POOL_MAX);

  private readonly trails = new Map<string, TrailEmitter>();

  // ---- scene objects (created headless-safe; textures join at attach) ------
  private readonly root = new THREE.Group();
  private readonly tracersCore: THREE.InstancedMesh;
  private readonly tracersTail: THREE.InstancedMesh;
  private readonly streaks: THREE.InstancedMesh;
  private readonly shards: THREE.InstancedMesh;
  private readonly buckets: THREE.InstancedMesh[] = [];
  private readonly bucketCursor = new Int32Array(PUFF_BUCKETS);
  private readonly rings: RingSlot[] = [];
  private readonly crates: CrateSlot[] = [];

  // ---- scratch (zero-allocation frame path) --------------------------------
  private readonly dummy = new THREE.Object3D();
  private readonly euler = new THREE.Euler();
  private readonly quat = new THREE.Quaternion();
  private readonly col = new THREE.Color();

  constructor(seed: number) {
    this.rng = makeRng(seed >>> 0);
    this.trng = makeRng((seed ^ 0x9e3779b9) >>> 0);

    const dyn = THREE.DynamicDrawUsage;
    // F1: thin bright gunfire streaks — a flash-amber core (10u) stacked with
    // a dim tail segment (3u), cross-sections ≤0.4u. Two instanced meshes so
    // the fade is material-level (no per-instance color churn).
    this.tracersCore = this.makeInstanced(
      new THREE.BoxGeometry(1, 1, 1),
      matBasic(mixA('flash', 'tracer', 0.42), { transparent: true, opacity: 0.98, depthWrite: false }),
      TRACER_POOL,
      dyn,
    );
    this.tracersTail = this.makeInstanced(
      new THREE.BoxGeometry(1, 1, 1),
      matBasic(pal('tracer'), { transparent: true, opacity: 0.45, depthWrite: false }),
      TRACER_POOL,
      dyn,
    );
    this.streaks = this.makeInstanced(
      new THREE.BoxGeometry(1, 1, 1),
      matBasic(pal('tracer'), { transparent: true, opacity: 0.9, depthWrite: false }),
      STREAK_POOL,
      dyn,
    );
    this.shards = this.makeInstanced(
      new THREE.TetrahedronGeometry(1),
      matLambert(pal('debris')),
      DEBRIS_POOL,
      dyn,
    );
    this.root.add(this.tracersCore, this.tracersTail, this.streaks, this.shards);

    const ringGeo = new THREE.RingGeometry(0.86, 1, 40);
    ringGeo.rotateX(-Math.PI / 2); // lie flat at altitude / sea level
    for (let i = 0; i < RING_POOL; i++) {
      const mesh = new THREE.Mesh(ringGeo, RING_BLAST[0]!);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.rings.push({
        mesh,
        active: false,
        gen: 0,
        x: 0,
        z: 0,
        y: PLANE_Y,
        r0: 0,
        r1: 0,
        age: 0,
        ttl: 0,
        foam: false,
      });
    }

    for (let i = 0; i < CRATE_POOL; i++) {
      const slot = this.buildCrateModel(i);
      slot.root.visible = false;
      this.root.add(slot.root);
      this.crates.push(slot);
    }
  }

  private makeInstanced(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    cap: number,
    usage: THREE.Usage,
  ): THREE.InstancedMesh {
    const im = new THREE.InstancedMesh(geo, mat, cap);
    im.instanceMatrix.setUsage(usage);
    im.frustumCulled = false;
    im.count = 0;
    return im;
  }

  /** Wood box + rope rig + dope canopy cone + foam pulse ring, pivot at crown. */
  private buildCrateModel(idx: number): CrateSlot {
    const root = new THREE.Group();
    root.name = `crate-${idx}`;
    const sway = new THREE.Group(); // pendulum pivots at the canopy crown
    root.add(sway);
    const wood = matLambert(pal('wood'));
    const tire = matLambert(pal('tire'));
    const box = new THREE.Mesh(new THREE.BoxGeometry(7, 5, 7), wood);
    box.position.y = -11.5;
    sway.add(box);
    const strapA = new THREE.Mesh(new THREE.BoxGeometry(7.4, 5.4, 1.1), tire);
    strapA.position.y = -11.5;
    sway.add(strapA);
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(11, 6, 8), matLambert(pal('dope')));
    canopy.position.y = -3;
    canopy.name = 'canopy';
    sway.add(canopy);
    const ropeGeo = new THREE.CylinderGeometry(0.09, 0.09, 7.5, 4);
    for (let k = 0; k < 4; k++) {
      const rope = new THREE.Mesh(ropeGeo, wood);
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      rope.position.set(Math.cos(a) * 4.6, -7.2, Math.sin(a) * 4.6);
      rope.rotation.z = Math.cos(a) * 0.55;
      rope.rotation.x = -Math.sin(a) * 0.55;
      sway.add(rope);
    }
    const ringGeo = new THREE.RingGeometry(0.82, 1, 36);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, RING_FOAM[3]!);
    ring.position.y = -0.1; // sits on the ground once the root lands
    ring.scale.setScalar(14);
    ring.name = 'pulse-ring';
    root.add(ring);
    // F3: every crate body casts onto the sea (shadow law — traverse-set).
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh !== ring) mesh.castShadow = true;
    });
    return { root, sway, canopy, ring, id: -1, gen: -1, falling: false, ph: 0, t: 0, x: 0, z: 0 };
  }

  // ---- pool plumbing ------------------------------------------------------

  /** Append one particle; silently drops when full (bounded law). */
  private spawn(
    kind: number,
    sty: number,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    dly: number,
    ttl: number,
    r0: number,
    r1: number,
    rot: number,
    vrt: number,
    ln: number,
    al: number,
  ): void {
    if (this.n >= FX_POOL_MAX) return; // flood drop — never exceeds the cap
    const i = this.n++;
    this.kind[i] = kind;
    this.sty[i] = sty;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.age[i] = 0;
    this.ttl[i] = ttl;
    this.dly[i] = dly;
    this.r0[i] = r0;
    this.r1[i] = r1;
    this.rot[i] = rot;
    this.vrt[i] = vrt;
    this.ln[i] = ln;
    this.al[i] = al;
  }

  /** Swap-remove: move the last live entry into the dead slot. */
  private kill(i: number): void {
    const last = --this.n;
    if (i === last) return;
    this.kind[i] = this.kind[last]!;
    this.sty[i] = this.sty[last]!;
    this.px[i] = this.px[last]!;
    this.py[i] = this.py[last]!;
    this.pz[i] = this.pz[last]!;
    this.vx[i] = this.vx[last]!;
    this.vy[i] = this.vy[last]!;
    this.vz[i] = this.vz[last]!;
    this.age[i] = this.age[last]!;
    this.ttl[i] = this.ttl[last]!;
    this.dly[i] = this.dly[last]!;
    this.r0[i] = this.r0[last]!;
    this.r1[i] = this.r1[last]!;
    this.rot[i] = this.rot[last]!;
    this.vrt[i] = this.vrt[last]!;
    this.ln[i] = this.ln[last]!;
    this.al[i] = this.al[last]!;
  }

  // ---- events -----------------------------------------------------------------

  /** Flash sprite + short stub streak + smoke wisp, same-frame with trigger. */
  muzzleFlash(p: P3, h: number): void {
    const dx = Math.cos(h);
    const dz = Math.sin(h);
    this.spawn(PUFF, V_FLASH, p.x, PLANE_Y, p.y, dx * 30, 0, dz * 30, 0, 0.06, 3.4, 0.6, 0, 0, 0, 1);
    this.spawn(STREAK, V_FLASH, p.x, PLANE_Y, p.y, dx * 40, 0, dz * 40, 0, 0.09, 0, 0, h, 0, STUB_LEN, 1);
    this.spawn(PUFF, V_SMOKE, p.x, PLANE_Y, p.y, dx * 22, 1.5, dz * 22, 0, 0.38, 1, 3.4, 0, 0, 0, 0.3);
  }

  /** Cosmetic optimistic tracer at trigger-down (RULES 10). */
  tracerStub(p: P3, h: number): void {
    this.spawn(
      STREAK,
      V_TRACER,
      p.x,
      PLANE_Y,
      p.y,
      Math.cos(h) * 780,
      0,
      Math.sin(h) * 780,
      0,
      0.09,
      0,
      0,
      h,
      0,
      STUB_LEN,
      0.95,
    );
  }

  /** White-hot spark tick + ink chips where a bullet connected (§7). */
  hitSpark(p: P3): void {
    this.spawn(PUFF, V_FLASH, p.x, PLANE_Y, p.y, 0, 0, 0, 0, 0.05, 2.8, 0.4, 0, 0, 0, 1);
    this.spawn(STREAK, V_FLASH, p.x, PLANE_Y, p.y, 0, 0, 0, 0, 0.08, 0, 0, this.rng() * TAU, 0, 7, 1);
    const chips = 2 + (this.rng() < 0.5 ? 1 : 0);
    for (let i = 0; i < chips; i++) {
      const ang = this.rng() * TAU; // backsplash cone reads any which way in 3D
      const sp = 46 + this.rng() * 54;
      this.spawn(
        SHARD,
        V_DEB,
        p.x,
        PLANE_Y,
        p.y,
        Math.cos(ang) * sp,
        14 + this.rng() * 26,
        Math.sin(ang) * sp,
        0.01 + this.rng() * 0.03,
        0.22 + this.rng() * 0.16,
        0.9 + this.rng() * 0.6,
        0,
        this.rng() * TAU,
        (this.rng() * 2 - 1) * 14,
        0,
        0.95,
      );
    }
    this.shake(SHAKE.SMALL);
  }

  /**
   * Death blast (§7): solid flash-core strike → flash + blast blooms → ONE
   * expanding shock ring → tumbling debris batch → lingering east-drifting
   * smoke column that darkens late-life. Over water: foam ring on the sea
   * plane + white column + sun-glare sparkle. Shake MEDIUM/LARGE.
   */
  explosion(p: P3, size: 'small' | 'large', overWater: boolean): void {
    const big = size === 'large';
    this.shake(big ? SHAKE.LARGE : SHAKE.MEDIUM);

    // strike — the blast replaces the scene for its first frames (§3 law).
    this.spawn(PUFF, V_CORE, p.x, PLANE_Y, p.y, 0, 0, 0, 0, 0.06, big ? 16 : 12, big ? 16 : 12, 0, 0, 0, 1);
    this.spawn(PUFF, V_FLASH, p.x, PLANE_Y, p.y, 0, 2, 0, 0, big ? 0.2 : 0.15, big ? 10 : 6, big ? 46 : 28, 0, 0, 0, 1);
    this.spawn(PUFF, V_BLAST, p.x, PLANE_Y, p.y, 0, 3, 0, 0.02, big ? 0.3 : 0.22, big ? 12 : 8, big ? 60 : 38, 0, 0, 0, 1);
    // shock ring — born ~20u, dilating to 95/70u over 0.35 s (width taper is
    // carried by the ring ladder's fading opacity; geometry ratio is fixed).
    this.takeRing(p.x, p.y, PLANE_Y, 20, big ? 95 : 70, 0.02, 0.35, false);

    // debris — rolls happen BEFORE spawn attempts (pool-pressure independence)
    const shN = big ? 12 + ((this.rng() * 3) | 0) : 9 + ((this.rng() * 3) | 0); // 9–11 / 12–14
    for (let i = 0; i < shN; i++) {
      const ang = this.rng() * TAU;
      const sp = 70 + this.rng() * 140;
      this.spawn(
        SHARD,
        V_DEB,
        p.x,
        PLANE_Y,
        p.y,
        Math.cos(ang) * sp,
        20 + this.rng() * 45,
        Math.sin(ang) * sp,
        0.02 + this.rng() * 0.06,
        0.45 + this.rng() * 0.4,
        1.1 + this.rng() * 1.2,
        0,
        this.rng() * TAU,
        (this.rng() * 2 - 1) * 15,
        0,
        0.95,
      );
    }

    // lingering column — delayed, growing, rising + east-drifting dark puffs
    const smN = big ? 9 : 6;
    for (let i = 0; i < smN; i++) {
      this.spawn(
        PUFF,
        V_SMOKE,
        p.x + (this.rng() - 0.5) * 6,
        PLANE_Y + this.rng() * 2,
        p.y + (this.rng() - 0.5) * 6,
        12 + this.rng() * 16,
        6 + this.rng() * 9,
        (this.rng() - 0.5) * 10,
        0.08 + i * (big ? 0.07 : 0.09),
        1.1 + this.rng() * 0.9,
        3 + this.rng() * 3,
        14 + this.rng() * 12,
        0,
        0,
        0,
        0.68 + this.rng() * 0.16,
      );
    }

    if (overWater) {
      this.takeRing(p.x, p.y, 0.25, 6, 48, 0.04, 0.55, true);
      const colN = big ? 5 : 4;
      for (let i = 0; i < colN; i++) {
        const r = this.rng();
        const r2 = this.rng();
        this.spawn(
          PUFF,
          V_FOAM,
          p.x + (r - 0.5) * 8,
          1,
          p.y + (r2 - 0.5) * 8,
          (r - 0.5) * 14,
          10 + this.rng() * 8,
          (r2 - 0.5) * 14,
          0.05 + i * 0.04,
          0.35 + this.rng() * 0.2,
          2.5,
          8 + this.rng() * 4,
          0,
          0,
          0,
          0.9,
        );
      }
      this.spawn(PUFF, V_GLARE, p.x, 1, p.y, 0, 0, 0, 0.03, 0.14, 3.4, 0.8, this.rng() * TAU, 0, 0, 1);
    }
  }

  /** Crate moments (§7): landing dust / pickup sparkle + chime-ring. */
  crateFx(kind: 'land' | 'pickup', p: P3): void {
    if (kind === 'land') {
      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * TAU + this.rng() * 0.5;
        const sp = 24 + this.rng() * 18;
        this.spawn(
          PUFF,
          V_SMOKE,
          p.x,
          CRATE_LAND_Y + 1.5,
          p.y,
          Math.cos(ang) * sp,
          2,
          Math.sin(ang) * sp,
          i * 0.012,
          0.45,
          2.2,
          7.5,
          0,
          0,
          0,
          0.38,
        );
      }
      return;
    }
    this.takeRing(p.x, p.y, PLANE_Y, 4, CRATE_PICKUP_R * 0.65, 0, 0.38, true);
    for (let i = 0; i < 9; i++) {
      const ang = (i / 9) * TAU + this.rng() * 0.4;
      const sp = 55 + this.rng() * 65;
      this.spawn(
        PUFF,
        i % 2 === 0 ? V_FOAM : V_GLARE,
        p.x,
        PLANE_Y,
        p.y,
        Math.cos(ang) * sp,
        8 + this.rng() * 10,
        Math.sin(ang) * sp,
        i * 0.008,
        0.3 + this.rng() * 0.15,
        1.8,
        0.5,
        0,
        0,
        0,
        1,
      );
    }
  }

  // ---- smoke/fire trail emitters ------------------------------------------

  /**
   * Per-plane emitter hook driven every frame while SMOKE_BELOW/FIRE_BELOW
   * hold; null stops and forgets. Map is LRU: refresh on re-arm, evict oldest
   * past MAX_TRAILS. Emission is timed here so call order can't skew output.
   */
  trail(id: string, p: P3, level: 'smoke' | 'fire' | null): void {
    if (level === null) {
      this.trails.delete(id);
      return;
    }
    const e = this.trails.get(id);
    if (e) {
      e.x = p.x;
      e.z = p.y;
      e.lvl = level === 'fire' ? 2 : 1;
      this.trails.delete(id);
      this.trails.set(id, e);
      return;
    }
    if (this.trails.size >= MAX_TRAILS) {
      const oldest = this.trails.keys().next().value;
      if (oldest !== undefined) this.trails.delete(oldest);
    }
    this.trails.set(id, { x: p.x, z: p.y, lvl: level === 'fire' ? 2 : 1, acc: 0, cnt: 0 });
  }

  private advanceEmitters(dt: number): void {
    for (const e of this.trails.values()) {
      e.acc += dt;
      if (e.lvl === 1) {
        while (e.acc >= SMOKE_INT) {
          e.acc -= SMOKE_INT;
          this.spawnTrailSmoke(e.x, e.z, false);
        }
      } else {
        while (e.acc >= EMBER_INT) {
          e.acc -= EMBER_INT;
          e.cnt++;
          this.spawnTrailEmber(e.x, e.z);
          if (e.cnt % 3 === 0) this.spawnTrailSmoke(e.x, e.z, true);
        }
      }
    }
  }

  /** Growing gray-brown puff drifting EAST-downwind, lt→dk→ink late-life. */
  private spawnTrailSmoke(x: number, z: number, heavy: boolean): void {
    const r = this.trng();
    const r2 = this.trng();
    const r3 = this.trng();
    this.spawn(
      PUFF,
      V_SMOKE,
      x + (r - 0.5) * 4,
      PLANE_Y + (r2 - 0.5) * 2,
      z + (r3 - 0.5) * 4,
      13 + r3 * 10, // east drift (downwind §7)
      3 + r2 * 4,
      (this.trng() - 0.5) * 8,
      0,
      1.1 + r * 0.5,
      6.5 + r2 * 0.7, // 13→21 u growth (radius 6.5→10.5+)
      10.5 + r3 * 4,
      0,
      0,
      0,
      heavy ? 0.86 : 0.72,
    );
  }

  /** Flickering fireCore/fireEdge ember with violent short life. */
  private spawnTrailEmber(x: number, z: number): void {
    const r = this.trng();
    const r2 = this.trng();
    const r3 = this.trng();
    this.spawn(
      PUFF,
      V_FIRE,
      x + (r - 0.5) * 3,
      PLANE_Y + (r2 - 0.5) * 2,
      z + (r3 - 0.5) * 3,
      (r - 0.5) * 36,
      5 + r3 * 7,
      (r2 - 0.5) * 36,
      0,
      0.26 + r3 * 0.14,
      2.6,
      0.6,
      0,
      0,
      0,
      0.95,
    );
  }

  // ---- crates ---------------------------------------------------------------

  /**
   * Pooled crate models (≤ CRATES_MAX + falling buffer): parachute descent
   * with pendulum sway, landed foam pulse ring. Slots match by id; unseen ids
   * claim free slots; overflow beyond the pool is dropped (bounded law).
   */
  syncCrates(crates: readonly CrateState[]): void {
    this.syncGen++;
    const gen = this.syncGen;
    for (let c = 0; c < crates.length; c++) {
      const st = crates[c]!;
      let slot: CrateSlot | null = null;
      for (let i = 0; i < this.crates.length; i++) {
        if (this.crates[i]!.id === st.id) {
          slot = this.crates[i]!;
          break;
        }
      }
      if (!slot) {
        for (let i = 0; i < this.crates.length; i++) {
          if (this.crates[i]!.gen !== gen) {
            slot = this.crates[i]!;
            break;
          }
        }
      }
      if (!slot) break; // pool exhausted — bounded drop
      slot.gen = gen;
      slot.id = st.id;
      slot.falling = st.phase === 'fall';
      slot.t = st.t;
      slot.x = st.x;
      slot.z = st.y;
      slot.ph = ((hashStr(`crate:${st.id}`) % 1000) / 1000) * TAU;
      slot.root.visible = true;
    }
    for (let i = 0; i < this.crates.length; i++) {
      const s = this.crates[i]!;
      if (s.gen !== gen) {
        s.root.visible = false;
        s.id = -1;
        s.gen = -1;
      }
    }
  }

  private updateCrates(dt: number): void {
    for (let i = 0; i < this.crates.length; i++) {
      const s = this.crates[i]!;
      if (s.gen < 0 || !s.root.visible) continue;
      s.root.position.x = s.x;
      s.root.position.z = s.z;
      if (s.falling) {
        if (s.t > 0) s.t = Math.max(0, s.t - dt);
        const pr = 1 - Math.max(0, Math.min(1, s.t / CRATE_FALL_S));
        const y = CRATE_DROP_Y + (CRATE_LAND_Y - CRATE_DROP_Y) * pr;
        s.root.position.y = y;
        // pendulum sway grows as the chute nears the deck (drag stabilizes it)
        const sw = Math.sin(this.time * 1.7 + s.ph);
        s.sway.rotation.z = sw * (0.05 + pr * 0.09);
        s.sway.rotation.x = Math.cos(this.time * 1.43 + s.ph) * (0.03 + pr * 0.05);
        s.canopy.visible = true;
        s.ring.visible = false;
      } else {
        s.root.position.y = CRATE_LAND_Y;
        s.sway.rotation.set(0, 0, 0);
        s.canopy.visible = false;
        // foam pulse breathing out toward the pickup radius hint
        const cyc = (this.time * 0.87 + s.ph) % 1;
        s.ring.visible = true;
        s.ring.scale.setScalar(10 + cyc * CRATE_PICKUP_R * 0.55);
        const tier = Math.min(RING_FOAM.length - 1, Math.round((1 - cyc) * (RING_FOAM.length - 1)));
        s.ring.material = RING_FOAM[tier]!;
      }
    }
  }

  // ---- rings ------------------------------------------------------------------

  private takeRing(
    x: number,
    mapZ: number,
    y: number,
    r0: number,
    r1: number,
    dly: number,
    ttl: number,
    foam: boolean,
  ): void {
    this.ringGen++;
    let slot: RingSlot | null = null;
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i]!;
      if (!r.active) {
        slot = r;
        break;
      }
      if (!slot || r.gen < slot.gen) slot = r; // fall back to the oldest
    }
    if (!slot) return;
    slot.active = true;
    slot.gen = this.ringGen;
    slot.x = x;
    slot.z = mapZ;
    slot.y = y;
    slot.r0 = r0;
    slot.r1 = r1;
    slot.age = -dly;
    slot.ttl = ttl;
    slot.foam = foam;
    slot.mesh.visible = true;
    slot.mesh.position.set(x, y, mapZ);
  }

  private updateRings(dt: number): void {
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i]!;
      if (!r.active) continue;
      r.age += dt;
      if (r.age < 0) {
        r.mesh.visible = false;
        continue;
      }
      const p = r.age / r.ttl;
      if (p >= 1) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      const rad = r.r0 + (r.r1 - r.r0) * p;
      r.mesh.scale.set(rad, 1, rad);
      const lad = r.foam ? RING_FOAM : RING_BLAST;
      r.mesh.material = lad[Math.min(lad.length - 1, Math.round((1 - p) * (lad.length - 1)))]!;
    }
  }

  // ---- shake --------------------------------------------------------------

  shake(mag: number): void {
    this.shakeAcc += mag;
  }

  /** Accumulated magnitude since last call; resets to 0 (camera feed). */
  consumeShake(): number {
    const v = this.shakeAcc;
    this.shakeAcc = 0;
    return v;
  }

  // ---- tracers (stateless, straight off the snapshot) -----------------------

  drawProjectiles(list: ReadonlyArray<{ x: number; y: number; vx: number; vy: number }>): void {
    const count = Math.min(list.length, TRACER_POOL);
    this.tracerDrawn = count;
    this.tracersCore.count = count;
    this.tracersTail.count = count;
    if (count === 0) return;
    for (let i = 0; i < count; i++) {
      const b = list[i]!;
      const sp = Math.hypot(b.vx, b.vy);
      const ux = sp > 1 ? b.vx / sp : 1;
      const uz = sp > 1 ? b.vy / sp : 0;
      const yaw = Math.atan2(-uz, ux);
      // Bright core spans [head−10 .. head]; dim tail continues [head−13 ..
      // head−10]. Both trail BEHIND the bullet, cross-section ≤0.4u (F1).
      this.dummy.position.set(b.x - ux * (TRACER_CORE_LEN / 2), PLANE_Y, b.y - uz * (TRACER_CORE_LEN / 2));
      this.dummy.rotation.set(0, yaw, 0);
      this.dummy.scale.set(TRACER_CORE_LEN, 0.34, 0.4);
      this.dummy.updateMatrix();
      this.tracersCore.setMatrixAt(i, this.dummy.matrix);
      this.dummy.position.set(
        b.x - ux * (TRACER_CORE_LEN + TRACER_TAIL_LEN / 2),
        PLANE_Y,
        b.y - uz * (TRACER_CORE_LEN + TRACER_TAIL_LEN / 2),
      );
      this.dummy.scale.set(TRACER_TAIL_LEN, 0.22, 0.28);
      this.dummy.updateMatrix();
      this.tracersTail.setMatrixAt(i, this.dummy.matrix);
    }
    this.tracersCore.instanceMatrix.needsUpdate = true;
    this.tracersTail.instanceMatrix.needsUpdate = true;
  }

  // ---- attach / update / dispose ---------------------------------------------

  attach(scene: THREE.Scene): void {
    if (this.attached) return; // idempotent
    this.attached = true;
    if (this.buckets.length === 0) {
      const tex = puffTexture();
      const quad = new THREE.PlaneGeometry(1, 1);
      for (let b = 0; b < PUFF_BUCKETS; b++) {
        // The frozen factory has no textured-material path; puffTexture() IS
        // the sanctioned soft-mass source (materials.ts hosts it for this).
        const mat = new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          depthWrite: false,
          opacity: (b + 0.5) / (PUFF_BUCKETS - 0.5),
        });
        const im = new THREE.InstancedMesh(quad, mat, FX_POOL_MAX);
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.frustumCulled = false;
        im.count = 0;
        im.setColorAt(0, COL.flash); // allocate the instanceColor buffer up front
        this.buckets.push(im);
        this.root.add(im);
      }
    }
    scene.add(this.root);
  }

  update(dt: number, camPos: { x: number; y: number }): void {
    if (dt > 0) {
      const step = Math.min(dt, 0.12); // hitch clamp: tab-switch never teleports ink
      this.time += step;
      this.integrate(step);
      this.advanceEmitters(step);
      this.updateRings(step);
      this.updateCrates(step);
    }
    if (this.attached) {
      this.rebuildPuffs(camPos);
      this.rebuildStreaks();
      this.rebuildShards();
    }
  }

  private integrate(step: number): void {
    for (let i = 0; i < this.n; ) {
      if (this.dly[i]! > 0) {
        this.dly[i] = this.dly[i]! - step;
        i++;
        continue;
      }
      const age = this.age[i]! + step;
      if (age >= this.ttl[i]!) {
        this.kill(i);
        continue;
      }
      this.age[i] = age;
      const dr = DRAG[this.kind[i]!]! * step;
      const k = dr < 1 ? 1 - dr : 0;
      this.vx[i] = this.vx[i]! * k;
      this.vz[i] = this.vz[i]! * k;
      if (this.kind[i] === SHARD) {
        this.vy[i] = this.vy[i]! - SHARD_G * step;
        this.py[i] = this.py[i]! + this.vy[i]! * step;
        if (this.py[i]! <= SHARD_REST_Y && this.vy[i]! < 0) {
          this.py[i] = SHARD_REST_Y; // landed on the sea/island deck
          this.vy[i] = 0;
          this.vx[i] = 0; // horizontal drift dies on impact
          this.vz[i] = 0;
          this.vrt[i] = 0;
        }
      } else {
        this.vy[i] = this.vy[i]! * k;
        this.py[i] = this.py[i]! + this.vy[i]! * step;
      }
      this.px[i] = this.px[i]! + this.vx[i]! * step;
      this.pz[i] = this.pz[i]! + this.vz[i]! * step;
      this.rot[i] = this.rot[i]! + this.vrt[i]! * step;
      i++;
    }
  }

  /** Soft masses → alpha-bucket instanced quads, cylindrically billboarded. */
  private rebuildPuffs(camPos: { x: number; y: number }): void {
    this.bucketCursor.fill(0);
    for (let i = 0; i < this.n; i++) {
      if (this.kind[i] !== PUFF || this.dly[i]! > 0) continue;
      const prog = this.age[i]! / this.ttl[i]!;
      const a = this.al[i]! * (1 - prog);
      if (a <= 0.04) continue;
      const b = Math.min(PUFF_BUCKETS - 1, Math.round(a * (PUFF_BUCKETS - 1)));
      const slot = this.bucketCursor[b]!++;
      const mesh = this.buckets[b]!;
      const s = this.r0[i]! + (this.r1[i]! - this.r0[i]!) * prog;
      const x = this.px[i]!;
      const z = this.pz[i]!;
      this.dummy.position.set(x, this.py[i]!, z);
      this.dummy.rotation.set(0, Math.atan2(camPos.x - x, camPos.y - z), 0);
      this.dummy.scale.set(s, s, 1);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(slot, this.dummy.matrix);
      this.pickPuffColor(i, prog);
      mesh.setColorAt(slot, this.col);
    }
    for (let b = 0; b < PUFF_BUCKETS; b++) {
      const mesh = this.buckets[b]!;
      mesh.count = this.bucketCursor[b]!;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private pickPuffColor(i: number, prog: number): void {
    switch (this.sty[i]) {
      case V_SMOKE: {
        if (this.al[i]! >= 0.6 && prog >= 0.58) {
          // late-life darkening: held near-black ink tone until the release
          // sliver (mirrors the 2D trail law — death fades, never pops)
          this.col.copy(COL.debHold);
        } else {
          const tier = Math.min(6, Math.round(prog * 1.6 * 6));
          this.col.copy(SMOKE_RAMP[tier]!);
        }
        return;
      }
      case V_FIRE: {
        const flick = ((this.age[i]! * 28 + i) | 0) & 1;
        this.col.copy(flick ? COL.fireC : COL.fireE);
        return;
      }
      case V_BLAST:
        this.col.copy(COL.blast);
        return;
      case V_FOAM:
        this.col.copy(COL.foam);
        return;
      case V_GLARE:
        this.col.copy(COL.glare);
        return;
      default:
        this.col.copy(COL.flash); // V_FLASH + V_CORE share the white-hot core
    }
  }

  private rebuildStreaks(): void {
    let cur = 0;
    for (let i = 0; i < this.n && cur < STREAK_POOL; i++) {
      if (this.kind[i] !== STREAK || this.dly[i]! > 0) continue;
      const prog = this.age[i]! / this.ttl[i]!;
      const a = this.al[i]! * (1 - prog);
      if (a <= 0.04) continue;
      const h = this.rot[i]!;
      const dx = Math.cos(h);
      const dz = Math.sin(h);
      const L = this.ln[i]!;
      this.dummy.position.set(this.px[i]! - (dx * L) / 2, this.py[i]!, this.pz[i]! - (dz * L) / 2);
      this.dummy.rotation.set(0, -h, 0); // yaw −h maps local +X onto heading
      const th = Math.max(0.12, 0.38 * (1 - prog * 0.75)); // ≤0.4u cross-section (F1)
      this.dummy.scale.set(L, th, th * 1.05);
      this.dummy.updateMatrix();
      this.streaks.setMatrixAt(cur, this.dummy.matrix);
      this.streaks.setColorAt(
        cur,
        this.sty[i] === V_FLASH ? COL.flash : this.sty[i] === V_TRACER ? COL.tracerCore : COL.blast,
      );
      cur++;
    }
    this.streaks.count = cur;
    this.streaks.instanceMatrix.needsUpdate = true;
    if (this.streaks.instanceColor) this.streaks.instanceColor.needsUpdate = true;
  }

  private rebuildShards(): void {
    let cur = 0;
    for (let i = 0; i < this.n && cur < DEBRIS_POOL; i++) {
      if (this.kind[i] !== SHARD || this.dly[i]! > 0) continue;
      const prog = this.age[i]! / this.ttl[i]!;
      const fade = prog > 0.7 ? Math.max(0, 1 - (prog - 0.7) / 0.3) : 1;
      if (fade <= 0.02) continue;
      this.euler.set(this.rot[i]!, this.rot[i]! * 0.63, this.vrt[i]! * 0.1);
      this.quat.setFromEuler(this.euler);
      const s = this.r0[i]! * fade;
      this.dummy.position.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      this.dummy.quaternion.copy(this.quat);
      this.dummy.scale.setScalar(s);
      this.dummy.updateMatrix();
      this.shards.setMatrixAt(cur++, this.dummy.matrix);
    }
    this.shards.count = cur;
    this.shards.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    this.attached = false;
    // Geometries/materials live in process-wide caches (see materials.ts /
    // planeModels.ts) — bounded sets reused across systems, not disposed here.
  }

  // ---- test-only introspection (NOT part of the frozen surface; mirrors the
  // retired 2D EffectsSystem precedent). Allocation here never hits the frame.

  kindCount(kindWanted: number, styWanted = -1): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.kind[i] === kindWanted && (styWanted < 0 || this.sty[i] === styWanted)) c++;
    }
    return c;
  }

  /** Packed live-particle state — determinism probe. */
  debugDump(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) {
      out.push(this.kind[i]!, this.px[i]!, this.py[i]!, this.pz[i]!, this.age[i]!, this.rot[i]!, this.r0[i]!);
    }
    return out;
  }
}

/**
 * C_FX 3D creator. `seed` derives from the match seed so FX variation is
 * reproducible capture-to-capture (RULES 3).
 */
export function createEffects3D(seed: number): EffectsApi3D {
  return new EffectsSystem3D(seed);
}
