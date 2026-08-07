// ============================================================================
// ANCIENTS (rift) — FX (CONTRACT §6 render/fx.ts, rebuilt on PBR + selective
// bloom for GRAPHICS_CONTRACT §1 / STYLE_BIBLE §9).
//
// Every effect here has the four-part structure STYLE_BIBLE §9 demands —
// ANTICIPATION -> STRIKE -> AFTERMATH -> DECAL:
//   * a cast gathers motes inward for ~0.15 s before anything else happens;
//   * the strike is an emissive shockwave dome plus a school-shaped spark
//     scatter (phys a flat fast fan, magic a tall geyser, heal a soft rise);
//   * the aftermath is ballistic sparks/debris/dust settling under gravity;
//   * the decal is a scorched ground lens that OUTLIVES the effect by 1.6-2.2 s
//     (8 s for a tower collapse), which is what makes an ability read as having
//     happened to the world rather than in front of it.
// Ambient life runs unconditionally (§9 "a still frame of a MOBA should never
// look still"): a world-locked drift of emissive motes wrapped around the
// camera's ground focus, so every frame has something moving in it.
//
// ---- MATERIALS -------------------------------------------------------------
// Zero material constructors. Every pool draws through the frozen kit:
// `emissiveSurface('crystal', <APAL key>, i)` for anything that glows (and is
// therefore `markBloom`ed — emissive alone does not bloom), `surface(...)` for
// the debris, dust and scorch that must NOT glow.
//
// ---- WHY NOTHING FADES ON `opacity` ----------------------------------------
// Kit materials are cached per (id, tint) and shared by every consumer in the
// game, so writing `material.opacity` from a per-slot fade would fade every
// other user of that material too — including geometry owned by other modules.
// There is no per-instance alpha channel in three (`instanceColor` is vec3), so
// EVERY world-space fade in this file is geometric instead:
//   * points and debris shrink toward zero radius;
//   * beams retract toward their target and thin out;
//   * domes and decals SINK, and the opaque ground occludes them — the visible
//     cap of a squashed ellipsoid shrinks smoothly to nothing as it descends.
// Only the DOM damage numbers fade on opacity, because they are CSS, not a
// material.
//
// ---- VERTEX / INSTANCE COLOUR ----------------------------------------------
// Nothing here passes through `bake()`, so every pooled geometry gets
// `whiteVertexColors()` once at construction or it renders black (the vertex-
// colour law, core.ts). `setColorAt` is used ONLY for greyscale multiplicative
// variation in 0.82/0.99/1.16 steps — the sanctioned use of the colour
// attribute. A palette hex there would MULTIPLY into the family albedo and
// render a wrong, much darker hue; per-effect colour comes from the material.
//
// ---- ALLOCATION ------------------------------------------------------------
// Every pool, typed array, matrix, quaternion, euler, vector and colour is
// allocated once in `createFx`. `tick()` allocates nothing except the DOM style
// strings for active damage numbers, which no DOM API lets us avoid; those are
// written only when the rounded pixel position or the quantised opacity step
// actually changes.
// ============================================================================
import * as THREE from 'three';
import { APAL } from '@rift/shared';
import type { FxHandle, SceneHandle } from '../contract.js';
import { sceneCore, whiteVertexColors } from './core.js';
import { emissiveSurface, ico, markBloom, rng, sphere, surface } from './kit.js';

// ---- pool capacities (STYLE_BIBLE §9: the old 240 total "cannot express any
//      of the above"; 808 pooled instances across 11 InstancedMeshes, each of
//      which hides itself the moment its pool is idle) ------------------------
/** Per emissive-colour spark pool; four of them (paper/arcane/heal/gold). */
const SPARK_CAP = 96;
/** Hard stone chunks from a structure collapse. */
const DEBRIS_CAP = 144;
/** Soft dust and death motes. */
const MOTE_CAP = 192;
/** Ambient pollen / fireflies. Always live, always one draw call. */
const AMBIENT_CAP = 88;
/** Shockwave domes, per school; three of them. */
const GLOW_CAP = 6;
/** Ground scorch lenses, shared by every ability and by tower collapses. */
const DECAL_CAP = 12;
/** Pooled `.dmg-number` overlay nodes. */
const NUMBER_CAP = 26;

/** Short flash — long enough to read at the 20 Hz snapshot cadence, never long
 *  enough to occlude the attacker (round-5 judge: 0.12 m beams hid shooters). */
const TRACER_LIFE_S = 0.17;
const NUMBER_LIFE_S = 0.9;
/** Golden angle — deterministic radial scatter with no rng stream, so a capture
 *  replays identically without threading a seed through every event. */
const GOLDEN_ANGLE = 2.399963229728653;
const TAU = Math.PI * 2;
/** Frame delta ceiling. A tab-switch stall must not teleport a particle field
 *  through the ground. */
const MAX_DT = 0.1;

/** Emissive intensities (STYLE_BIBLE §4: pleasant by day, dominant by night). */
const SPARK_GLOW = 2.4;
const DOME_GLOW = 3.0;
const AMBIENT_GLOW = 1.1;

/** The three greyscale modulation steps every pooled instance draws from — the
 *  variation law expressed multiplicatively, since instance colour multiplies
 *  the family albedo and a palette hex there would be a double-multiply. */
const SHADE_STEPS = 3;
const SHADE_BASE = 0.82;
const SHADE_STEP = 0.17;

/** Ambient field half-extent in metres around the camera's ground focus. */
const AMBIENT_HALF = 26;

type BurstKind = 'gold' | 'death' | 'tower' | 'phys' | 'magic' | 'heal';
type TracerKind = 'phys' | 'magic' | 'tower';
type School = 'phys' | 'magic' | 'heal';
/** The four emissive FX colours, as APAL key names for `emissiveSurface`. */
type SparkKey = 'paper' | 'arcane' | 'heal' | 'gold';

const TRACER_SPARK: Record<TracerKind, SparkKey> = {
  phys: 'paper',
  magic: 'arcane',
  tower: 'gold',
};
const NUMBER_CLASS: Record<'gold' | 'danger' | 'paper', string> = {
  gold: 'dmg-number gold',
  danger: 'dmg-number danger',
  paper: 'dmg-number paper',
};

/**
 * A ballistic pool: point particles and beams share one InstancedMesh because
 * they share one material, and a beam is only a point whose instance matrix is
 * stretched and aimed.
 *
 * Structure-of-arrays, sized once. `ax/ay/az` is dual-use and that is the one
 * piece of cleverness in this file: for a POINT it is the velocity in m/s, for
 * a BEAM (`len > 0`) it is the target world point. `spin` is likewise the
 * tumble rate for a point and the beam's pitch in radians.
 */
interface ParticlePool {
  readonly mesh: THREE.InstancedMesh;
  readonly cap: number;
  /** Exponent of the size ramp: radius = base * life^fade. */
  readonly fade: number;
  cursor: number;
  colorDirty: boolean;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly ax: Float32Array;
  readonly ay: Float32Array;
  readonly az: Float32Array;
  readonly life: Float32Array;
  readonly maxLife: Float32Array;
  /** Point radius, or beam half-thickness, in metres. */
  readonly size: Float32Array;
  /** 0 for a point; the beam's full length in metres otherwise. */
  readonly len: Float32Array;
  /** Point: tumble rate rad/s. Beam: pitch in radians. */
  readonly spin: Float32Array;
  /** Beam yaw in radians; unused by points. */
  readonly yaw: Float32Array;
  /** Ground height under the spawn point — the floor a point settles onto. */
  readonly floor: Float32Array;
  readonly grav: Float32Array;
  readonly drag: Float32Array;
}

/**
 * A squashed-ellipsoid pool: shockwave domes and ground scorch decals. Both
 * fade by sinking into the ground, so both are the same shape with different
 * timing curves.
 */
interface DomePool {
  readonly mesh: THREE.InstancedMesh;
  readonly cap: number;
  cursor: number;
  colorDirty: boolean;
  readonly x: Float32Array;
  readonly gy: Float32Array;
  readonly z: Float32Array;
  readonly age: Float32Array;
  /** Total lifetime in seconds, delay included; <= 0 means the slot is free. */
  readonly ttl: Float32Array;
  /** Seconds of anticipation before the slot becomes visible. */
  readonly delay: Float32Array;
  readonly r0: Float32Array;
  readonly r1: Float32Array;
  /** Vertical semi-axis in metres — the lens thickness. */
  readonly hh: Float32Array;
  readonly yaw: Float32Array;
}

interface NumberSlot {
  readonly el: HTMLDivElement;
  active: boolean;
  x: number;
  z: number;
  age: number;
  lastX: number;
  lastY: number;
  lastStep: number;
}

// ---- shared scratch: allocated once, reused by every write below ------------
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _dir = new THREE.Vector3();

/** Hermite smoothstep, the only easing curve in this file. */
function ease(u: number): number {
  return u * u * (3 - 2 * u);
}

export function createFx(scene: SceneHandle): FxHandle {
  const core = sceneCore(scene);

  // ---- geometry (unit RADIUS, so every instance scale is metres) ------------
  // Nothing here goes through bake(), so the vertex-colour law is ours to
  // satisfy — once, at construction, never per frame.
  const blobGeo = whiteVertexColors(ico(1, 0)); // faceted: sparks, stone chunks
  const softGeo = whiteVertexColors(sphere(1, 8)); // smooth: dust, motes
  const domeGeo = whiteVertexColors(sphere(1, 20)); // shockwave lens, scorch

  /** One pooled InstancedMesh, parked at zero scale and hidden until something
   *  in it is alive. `visible = false` is what makes an idle pool cost zero
   *  draw calls instead of eleven (GRAPHICS_CONTRACT §5). */
  function makeInstanced(
    geo: THREE.BufferGeometry,
    material: THREE.MeshStandardMaterial,
    cap: number,
    bloom: boolean,
    name: string,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, material, cap);
    mesh.name = name;
    mesh.frustumCulled = false; // instance positions are not in the geo bounds
    mesh.count = cap;
    mesh.visible = false;
    if (bloom) markBloom(mesh);
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, _m);
    mesh.instanceMatrix.needsUpdate = true;
    core.three.add(mesh);
    return mesh;
  }

  function makeParticlePool(
    geo: THREE.BufferGeometry,
    material: THREE.MeshStandardMaterial,
    cap: number,
    fade: number,
    bloom: boolean,
    name: string,
  ): ParticlePool {
    return {
      mesh: makeInstanced(geo, material, cap, bloom, name),
      cap,
      fade,
      cursor: 0,
      colorDirty: false,
      px: new Float32Array(cap),
      py: new Float32Array(cap),
      pz: new Float32Array(cap),
      ax: new Float32Array(cap),
      ay: new Float32Array(cap),
      az: new Float32Array(cap),
      life: new Float32Array(cap),
      maxLife: new Float32Array(cap),
      size: new Float32Array(cap),
      len: new Float32Array(cap),
      spin: new Float32Array(cap),
      yaw: new Float32Array(cap),
      floor: new Float32Array(cap),
      grav: new Float32Array(cap),
      drag: new Float32Array(cap),
    };
  }

  function makeDomePool(
    material: THREE.MeshStandardMaterial,
    cap: number,
    bloom: boolean,
    name: string,
  ): DomePool {
    const mesh = makeInstanced(domeGeo, material, cap, bloom, name);
    mesh.receiveShadow = !bloom; // the scorch takes shadow; the glow does not
    return {
      mesh,
      cap,
      cursor: 0,
      colorDirty: false,
      x: new Float32Array(cap),
      gy: new Float32Array(cap),
      z: new Float32Array(cap),
      age: new Float32Array(cap),
      ttl: new Float32Array(cap),
      delay: new Float32Array(cap),
      r0: new Float32Array(cap),
      r1: new Float32Array(cap),
      hh: new Float32Array(cap),
      yaw: new Float32Array(cap),
    };
  }

  // ---- the pools ------------------------------------------------------------
  // Four emissive spark pools, one per FX colour: a material carries exactly one
  // emissive, so the colour of a glow IS its pool. Beams live in the same pools
  // as the sparks — same material, same mesh, one draw call for both.
  const sparks: Record<SparkKey, ParticlePool> = {
    paper: makeParticlePool(
      blobGeo,
      emissiveSurface('crystal', 'paper', SPARK_GLOW),
      SPARK_CAP,
      0.5,
      true,
      'rift:fx:spark:paper',
    ),
    arcane: makeParticlePool(
      blobGeo,
      emissiveSurface('crystal', 'arcane', SPARK_GLOW),
      SPARK_CAP,
      0.5,
      true,
      'rift:fx:spark:arcane',
    ),
    heal: makeParticlePool(
      blobGeo,
      emissiveSurface('crystal', 'heal', SPARK_GLOW),
      SPARK_CAP,
      0.5,
      true,
      'rift:fx:spark:heal',
    ),
    gold: makeParticlePool(
      blobGeo,
      emissiveSurface('crystal', 'gold', SPARK_GLOW),
      SPARK_CAP,
      0.5,
      true,
      'rift:fx:spark:gold',
    ),
  };
  /** Stone rubble from a collapsing structure. Never blooms — it is lit rock. */
  const debris = makeParticlePool(
    blobGeo,
    surface('monumentStone'),
    DEBRIS_CAP,
    1.3,
    false,
    'rift:fx:debris',
  );
  /** Dust plumes and death motes. Cloth: the softest, most matte family. */
  const motes = makeParticlePool(softGeo, surface('cloth'), MOTE_CAP, 0.85, false, 'rift:fx:motes');
  /** Ambient pollen by day / fireflies by night — the "never still" field. It
   *  has no lifetimes and no ballistics, so it is a bare mesh rather than a
   *  ParticlePool: `stepAmbient` drives it from its own drift arrays. */
  const ambientMesh = makeInstanced(
    softGeo,
    emissiveSurface('crystal', 'goldLit', AMBIENT_GLOW),
    AMBIENT_CAP,
    true,
    'rift:fx:ambient',
  );
  const glows: Record<School, DomePool> = {
    phys: makeDomePool(
      emissiveSurface('crystal', 'paper', DOME_GLOW),
      GLOW_CAP,
      true,
      'rift:fx:glow:phys',
    ),
    magic: makeDomePool(
      emissiveSurface('crystal', 'arcane', DOME_GLOW),
      GLOW_CAP,
      true,
      'rift:fx:glow:magic',
    ),
    heal: makeDomePool(
      emissiveSurface('crystal', 'heal', DOME_GLOW),
      GLOW_CAP,
      true,
      'rift:fx:glow:heal',
    ),
  };
  /** Scorched earth. A burnt-warm dirt against the cool moss ground. */
  const decals = makeDomePool(
    surface('groundDirt', APAL.dirtDeep),
    DECAL_CAP,
    false,
    'rift:fx:decal',
  );

  // ---- spawn ----------------------------------------------------------------
  /** Bumped once per burst so two bursts on the same tile never fan alike. */
  let burstSeq = 0;

  function shadeOf(n: number): number {
    return SHADE_BASE + (n % SHADE_STEPS) * SHADE_STEP;
  }

  function spawnPoint(
    p: ParticlePool,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    radius: number,
    life: number,
    grav: number,
    drag: number,
    floorY: number,
    shade: number,
  ): void {
    const i = p.cursor;
    p.cursor = (p.cursor + 1) % p.cap;
    p.px[i] = x;
    p.py[i] = y;
    p.pz[i] = z;
    p.ax[i] = vx;
    p.ay[i] = vy;
    p.az[i] = vz;
    p.life[i] = life;
    p.maxLife[i] = life;
    p.size[i] = radius;
    p.len[i] = 0;
    p.spin[i] = (i % 2 === 0 ? 1 : -1) * (2.2 + (i % 5) * 0.9);
    p.yaw[i] = 0;
    p.floor[i] = floorY;
    p.grav[i] = grav;
    p.drag[i] = drag;
    p.mesh.setColorAt(i, _c.setScalar(shade));
    p.colorDirty = true;
  }

  function spawnBeam(
    p: ParticlePool,
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    thickness: number,
    life: number,
    shade: number,
  ): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dz = z2 - z1;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.05) return;
    const i = p.cursor;
    p.cursor = (p.cursor + 1) % p.cap;
    p.px[i] = x1;
    p.py[i] = y1;
    p.pz[i] = z1;
    p.ax[i] = x2;
    p.ay[i] = y2;
    p.az[i] = z2;
    p.life[i] = life;
    p.maxLife[i] = life;
    p.size[i] = thickness;
    p.len[i] = len;
    // A +X-aligned blob is pitched about Z then yawed about Y (Euler order
    // 'YZX'), which maps local +X onto the flight vector exactly.
    p.yaw[i] = Math.atan2(-dz, dx);
    p.spin[i] = Math.asin(Math.max(-1, Math.min(1, dy / len)));
    p.floor[i] = 0;
    p.grav[i] = 0;
    p.drag[i] = 0;
    p.mesh.setColorAt(i, _c.setScalar(shade));
    p.colorDirty = true;
  }

  /** The radial fan every burst is built from — golden-angle spread, per-index
   *  speed/height/size/life variation, no rng stream and no allocation. */
  function emitRadial(
    p: ParticlePool,
    x: number,
    gy: number,
    z: number,
    count: number,
    speed: number,
    up: number,
    y0: number,
    y1: number,
    radius: number,
    life: number,
    grav: number,
    drag: number,
  ): void {
    for (let n = 0; n < count; n++) {
      const a = (burstSeq * 3 + n) * GOLDEN_ANGLE;
      const sp = speed * (0.6 + ((n % 5) / 5) * 0.8);
      spawnPoint(
        p,
        x,
        gy + y0 + ((n % 7) / 7) * (y1 - y0),
        z,
        Math.cos(a) * sp,
        up * (0.7 + ((n % 4) / 4) * 0.6),
        Math.sin(a) * sp,
        radius * (0.7 + ((n % 3) / 3) * 0.6),
        life * (0.75 + ((n % 3) / 3) * 0.5),
        grav,
        drag,
        gy,
        shadeOf(n),
      );
    }
  }

  /** ANTICIPATION: motes converging on the cast point, timed to land exactly
   *  when the strike dome opens. */
  function emitGather(
    p: ParticlePool,
    x: number,
    gy: number,
    z: number,
    count: number,
    delay: number,
  ): void {
    const r = 1.55;
    const h = 1.25;
    for (let n = 0; n < count; n++) {
      const a = (burstSeq * 5 + n) * GOLDEN_ANGLE;
      const sx = x + Math.cos(a) * r;
      const sz = z + Math.sin(a) * r;
      const sy = gy + h + (n % 3) * 0.18;
      spawnPoint(
        p,
        sx,
        sy,
        sz,
        (x - sx) / delay,
        (gy + 0.5 - sy) / delay,
        (z - sz) / delay,
        0.075,
        delay,
        0,
        0,
        gy,
        shadeOf(n + 1),
      );
    }
  }

  function spawnDome(
    d: DomePool,
    x: number,
    gy: number,
    z: number,
    r0: number,
    r1: number,
    hh: number,
    delay: number,
    ttl: number,
  ): void {
    const i = d.cursor;
    d.cursor = (d.cursor + 1) % d.cap;
    d.x[i] = x;
    d.gy[i] = gy;
    d.z[i] = z;
    d.age[i] = 0;
    d.ttl[i] = ttl;
    d.delay[i] = delay;
    d.r0[i] = r0;
    d.r1[i] = r1;
    d.hh[i] = hh;
    d.yaw[i] = (i % 7) * (TAU / 7);
    d.mesh.setColorAt(i, _c.setScalar(shadeOf(i)));
    d.colorDirty = true;
  }

  // ---- API: burst -----------------------------------------------------------
  function burst(x: number, z: number, kind: BurstKind): void {
    burstSeq = (burstSeq + 1) % 1024;
    const gy = core.heightAt(x, z);
    switch (kind) {
      case 'gold': {
        // Last hit: a tight, bright bounty pop. No decal — a creep kill must not
        // scar the lane it happened in.
        emitRadial(sparks.gold, x, gy, z, 12, 2.0, 3.4, 0.5, 1.2, 0.1, 0.55, 11, 1.2);
        emitRadial(motes, x, gy, z, 4, 0.9, 1.5, 0.4, 0.9, 0.09, 0.7, 2.4, 2.4);
        break;
      }
      case 'death': {
        // Dissolve into motes, with a handful of pale sparks rising out of them
        // — the "soul wisp" read, without the shared wraith ghost §9 rejects.
        emitRadial(motes, x, gy, z, 14, 1.1, 2.2, 0.3, 1.0, 0.14, 0.75, 3.0, 2.2);
        emitRadial(sparks.paper, x, gy, z, 5, 0.5, 3.4, 0.6, 1.4, 0.07, 0.9, 1.4, 1.8);
        break;
      }
      case 'tower': {
        // Crumble: heavy chunks on ballistic arcs, a slow dust plume that
        // outlasts them, and rubble scorch that stays for 8 s.
        emitRadial(debris, x, gy, z, 26, 4.2, 4.6, 0.4, 3.2, 0.15, 1.1, 13, 0.6);
        emitRadial(motes, x, gy, z, 18, 2.4, 1.6, 0.3, 2.4, 0.3, 1.5, 1.2, 2.6);
        spawnDome(decals, x, gy, z, 1.0, 3.4, 0.16, 0, 8);
        break;
      }
      case 'phys': {
        emitGather(sparks.paper, x, gy, z, 6, 0.13);
        spawnDome(glows.phys, x, gy, z, 0.5, 2.9, 0.5, 0.13, 0.47);
        emitRadial(sparks.paper, x, gy, z, 14, 3.4, 1.3, 0.6, 1.2, 0.085, 0.42, 12, 1.6);
        spawnDome(decals, x, gy, z, 0.7, 1.9, 0.13, 0.13, 1.7);
        break;
      }
      case 'magic': {
        emitGather(sparks.arcane, x, gy, z, 7, 0.16);
        spawnDome(glows.magic, x, gy, z, 0.4, 2.4, 0.85, 0.16, 0.56);
        emitRadial(sparks.arcane, x, gy, z, 16, 1.6, 4.6, 0.7, 1.8, 0.095, 0.6, 8.5, 0.9);
        spawnDome(decals, x, gy, z, 0.6, 2.2, 0.14, 0.16, 2.3);
        break;
      }
      case 'heal': {
        emitGather(sparks.heal, x, gy, z, 6, 0.18);
        spawnDome(glows.heal, x, gy, z, 0.6, 2.2, 0.62, 0.18, 0.68);
        emitRadial(sparks.heal, x, gy, z, 16, 1.0, 3.0, 0.4, 1.3, 0.09, 0.8, 2.0, 1.6);
        spawnDome(decals, x, gy, z, 0.6, 2.0, 0.12, 0.18, 1.9);
        break;
      }
    }
  }

  // ---- API: tracer ----------------------------------------------------------
  function tracer(x1: number, z1: number, x2: number, z2: number, kind: TracerKind): void {
    const pool = sparks[TRACER_SPARK[kind]];
    const y1 = core.heightAt(x1, z1) + (kind === 'tower' ? 3.4 : 1.05);
    const y2 = core.heightAt(x2, z2) + 1.0;
    const dx = x2 - x1;
    const dz = z2 - z1;
    if (Math.hypot(dx, dz) < 0.05) return;
    // Half-thickness: 0.084 m / 0.11 m across. Above the old 0.055 m box (which
    // aliased at gameplay zoom) and below the 0.12 m that hid its shooter.
    spawnBeam(pool, x1, y1, z1, x2, y2, z2, kind === 'tower' ? 0.055 : 0.042, TRACER_LIFE_S, 1);
    // IMPACT (STYLE_BIBLE §9): a directional spark cone thrown forward along the
    // flight vector at the point of contact, not an omnidirectional puff.
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-3) return;
    const gy = core.heightAt(x2, z2);
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;
    for (let n = 0; n < 3; n++) {
      const a = (burstSeq * 7 + n) * GOLDEN_ANGLE;
      const spread = 1.5;
      spawnPoint(
        pool,
        x2 - nx * 0.25,
        y2 - ny * 0.25,
        z2 - nz * 0.25,
        nx * 2.6 + Math.cos(a) * spread,
        ny * 2.6 + 1.5,
        nz * 2.6 + Math.sin(a) * spread,
        0.055,
        0.22 + (n % 3) * 0.05,
        13,
        1.4,
        gy,
        shadeOf(n),
      );
    }
    burstSeq = (burstSeq + 1) % 1024;
  }

  // ---- API: shake -----------------------------------------------------------
  let shakeAmp = 0;
  let shakePhase = 0;

  function shake(amount: number): void {
    shakeAmp = Math.min(1.6, shakeAmp + Math.max(0, amount));
  }

  // ---- API: damage numbers (DOM on the scene overlay) -----------------------
  const numbers: NumberSlot[] = [];
  for (let i = 0; i < NUMBER_CAP; i++) {
    const el = document.createElement('div');
    el.className = NUMBER_CLASS.paper;
    el.style.position = 'absolute'; // the class is position:fixed; we track the overlay
    el.style.left = '0';
    el.style.top = '0';
    el.style.animation = 'none'; // rise + fade are driven here, not by the keyframes
    el.style.pointerEvents = 'none';
    el.style.display = 'none';
    el.style.willChange = 'transform, opacity';
    core.overlay.appendChild(el);
    numbers.push({ el, active: false, x: 0, z: 0, age: 0, lastX: 0, lastY: 0, lastStep: -1 });
  }
  let nCursor = 0;
  const screenPt = { x: 0, y: 0 };

  function damageNumber(
    x: number,
    z: number,
    text: string,
    cls: 'gold' | 'danger' | 'paper',
  ): void {
    const slot = numbers[nCursor];
    nCursor = (nCursor + 1) % NUMBER_CAP;
    if (slot === undefined) return;
    slot.active = true;
    slot.x = x;
    slot.z = z;
    slot.age = 0;
    slot.lastX = Number.NaN;
    slot.lastY = Number.NaN;
    slot.lastStep = -1;
    slot.el.textContent = text;
    slot.el.className = NUMBER_CLASS[cls];
  }

  // ---- ambient life ---------------------------------------------------------
  // World-locked drift, wrapped into a box around the camera's ground focus, so
  // the field is dense where the player is looking and never repeats visibly.
  const ambRng = rng('rift:fx:ambient');
  const ambX = new Float32Array(AMBIENT_CAP);
  const ambZ = new Float32Array(AMBIENT_CAP);
  const ambVX = new Float32Array(AMBIENT_CAP);
  const ambVZ = new Float32Array(AMBIENT_CAP);
  const ambH = new Float32Array(AMBIENT_CAP);
  const ambPh = new Float32Array(AMBIENT_CAP);
  const ambRate = new Float32Array(AMBIENT_CAP);
  const ambR = new Float32Array(AMBIENT_CAP);
  for (let i = 0; i < AMBIENT_CAP; i++) {
    ambX[i] = ambRng.range(-AMBIENT_HALF, AMBIENT_HALF);
    ambZ[i] = ambRng.range(-AMBIENT_HALF, AMBIENT_HALF);
    ambVX[i] = ambRng.range(-0.34, 0.34);
    ambVZ[i] = ambRng.range(-0.34, 0.34);
    ambH[i] = ambRng.range(0.45, 4.3);
    ambPh[i] = ambRng.range(0, TAU);
    ambRate[i] = ambRng.range(0.5, 1.35);
    ambR[i] = ambRng.range(0.042, 0.082);
    ambientMesh.setColorAt(i, _c.setScalar(shadeOf(i)));
  }
  ambientMesh.visible = true;
  if (ambientMesh.instanceColor !== null) ambientMesh.instanceColor.needsUpdate = true;
  let ambClock = 0;

  // ---- per-frame steps ------------------------------------------------------
  function park(p: ParticlePool | DomePool, i: number): void {
    _m.makeScale(0, 0, 0);
    p.mesh.setMatrixAt(i, _m);
  }

  function stepParticles(p: ParticlePool, dt: number): void {
    let alive = 0;
    let touched = false;
    for (let i = 0; i < p.cap; i++) {
      const l = p.life[i] ?? 0;
      if (l <= 0) continue;
      touched = true;
      const nl = l - dt;
      p.life[i] = nl;
      if (nl <= 0) {
        park(p, i);
        continue;
      }
      alive++;
      const ml = p.maxLife[i] ?? 1;
      const t = nl / ml; // 1 at spawn -> 0 at death
      const beam = p.len[i] ?? 0;
      if (beam > 0) {
        // A beam retracts toward its target and thins out: the streak reads as a
        // projectile arriving rather than a bar switching off.
        const u = 1 - t;
        const ox = p.px[i] ?? 0;
        const oy = p.py[i] ?? 0;
        const oz = p.pz[i] ?? 0;
        const tx = p.ax[i] ?? 0;
        const ty = p.ay[i] ?? 0;
        const tz = p.az[i] ?? 0;
        const k = u * 0.7;
        const sx = ox + (tx - ox) * k;
        const sy = oy + (ty - oy) * k;
        const sz = oz + (tz - oz) * k;
        const thick = (p.size[i] ?? 0.04) * Math.pow(t, 0.8);
        _p.set((sx + tx) * 0.5, (sy + ty) * 0.5, (sz + tz) * 0.5);
        _e.set(0, p.yaw[i] ?? 0, p.spin[i] ?? 0, 'YZX');
        _q.setFromEuler(_e);
        _s.set(beam * (1 - k) * 0.5, thick, thick);
        _m.compose(_p, _q, _s);
        p.mesh.setMatrixAt(i, _m);
        continue;
      }
      // Ballistic point: gravity, linear drag, settle on the spawn-point floor.
      const drag = Math.max(0, 1 - (p.drag[i] ?? 0) * dt);
      const nvy = ((p.ay[i] ?? 0) - (p.grav[i] ?? 0) * dt) * drag;
      const nvx = (p.ax[i] ?? 0) * drag;
      const nvz = (p.az[i] ?? 0) * drag;
      p.ax[i] = nvx;
      p.ay[i] = nvy;
      p.az[i] = nvz;
      const floorY = (p.floor[i] ?? 0) + 0.05;
      const nx = (p.px[i] ?? 0) + nvx * dt;
      const ny = Math.max(floorY, (p.py[i] ?? 0) + nvy * dt);
      const nz = (p.pz[i] ?? 0) + nvz * dt;
      p.px[i] = nx;
      p.py[i] = ny;
      p.pz[i] = nz;
      const r = (p.size[i] ?? 0.1) * Math.pow(t, p.fade);
      const a = (ml - nl) * (p.spin[i] ?? 0);
      _p.set(nx, ny, nz);
      _e.set(a, a * 0.7, a * 1.3, 'XYZ');
      _q.setFromEuler(_e);
      _s.set(r, r, r);
      _m.compose(_p, _q, _s);
      p.mesh.setMatrixAt(i, _m);
    }
    if (touched) p.mesh.instanceMatrix.needsUpdate = true;
    if (p.colorDirty && p.mesh.instanceColor !== null) {
      p.mesh.instanceColor.needsUpdate = true;
      p.colorDirty = false;
    }
    p.mesh.visible = alive > 0;
  }

  /**
   * Domes and decals share one update because they share one fade: the lens
   * SINKS, and the opaque ground clips its rim inward until nothing is left.
   * `rise` is the height of the visible cap above the ground; the ellipsoid
   * centre sits at `gy + rise - hh`, so rise = 2*hh shows the whole lens and
   * rise = 0 buries it completely.
   */
  function stepDomes(d: DomePool, dt: number, glow: boolean): void {
    let alive = 0;
    let touched = false;
    for (let i = 0; i < d.cap; i++) {
      const ttl = d.ttl[i] ?? 0;
      if (ttl <= 0) continue;
      touched = true;
      const age = (d.age[i] ?? 0) + dt;
      d.age[i] = age;
      if (age >= ttl) {
        d.ttl[i] = 0;
        park(d, i);
        continue;
      }
      const delay = d.delay[i] ?? 0;
      if (age < delay) {
        park(d, i);
        continue;
      }
      alive++;
      const hh = d.hh[i] ?? 0.1;
      const r0 = d.r0[i] ?? 0.5;
      const r1 = d.r1[i] ?? 1;
      let r: number;
      let rise: number;
      if (glow) {
        // Strike: expands fast and sinks over its whole (short) life.
        const u = Math.min(1, (age - delay) / Math.max(1e-3, ttl - delay));
        r = r0 + (r1 - r0) * ease(Math.min(1, u * 1.35));
        rise = 2 * hh * (1 - u * u);
      } else {
        // Scorch: snaps to full size, holds, then settles into the ground over
        // the last 0.55 s — the 1-3 s afterlife STYLE_BIBLE §9 asks for.
        const live = ttl - delay;
        const grow = Math.min(1, (age - delay) / 0.14);
        r = r0 + (r1 - r0) * ease(grow);
        const tail = Math.max(0.12, Math.min(0.55, live * 0.35));
        const sink = Math.max(0, (age - delay - (live - tail)) / tail);
        rise = 1.6 * hh * (1 - ease(Math.min(1, sink)));
      }
      _p.set(d.x[i] ?? 0, (d.gy[i] ?? 0) + rise - hh, d.z[i] ?? 0);
      _e.set(0, d.yaw[i] ?? 0, 0, 'XYZ');
      _q.setFromEuler(_e);
      _s.set(r, hh, r);
      _m.compose(_p, _q, _s);
      d.mesh.setMatrixAt(i, _m);
    }
    if (touched) d.mesh.instanceMatrix.needsUpdate = true;
    if (d.colorDirty && d.mesh.instanceColor !== null) {
      d.mesh.instanceColor.needsUpdate = true;
      d.colorDirty = false;
    }
    d.mesh.visible = alive > 0;
  }

  function stepAmbient(dt: number): void {
    ambClock += dt;
    // The camera's ground focus: where the rig is actually looking, derived from
    // the camera itself so this cannot drift out of sync with the rig.
    const cam = core.camera;
    cam.getWorldDirection(_dir); // writes into the scratch vector; no allocation
    let fx = cam.position.x;
    let fz = cam.position.z;
    if (_dir.y < -1e-3) {
      const k = cam.position.y / -_dir.y;
      fx += _dir.x * k;
      fz += _dir.z * k;
    }
    const field = AMBIENT_HALF * 2;
    _q.identity();
    for (let i = 0; i < AMBIENT_CAP; i++) {
      const wx = (ambX[i] ?? 0) + (ambVX[i] ?? 0) * dt;
      const wz = (ambZ[i] ?? 0) + (ambVZ[i] ?? 0) * dt;
      ambX[i] = wx;
      ambZ[i] = wz;
      // Wrap the WORLD position into the box around the focus: the motes drift
      // in world space, but there are always some of them on screen.
      const ox = wx - fx;
      const oz = wz - fz;
      const px = fx + (ox - field * Math.round(ox / field));
      const pz = fz + (oz - field * Math.round(oz / field));
      const bob = Math.sin(ambClock * (ambRate[i] ?? 1) + (ambPh[i] ?? 0)) * 0.35;
      const r = ambR[i] ?? 0.05;
      _p.set(px, core.heightAt(px, pz) + (ambH[i] ?? 1) + bob, pz);
      _s.set(r, r, r);
      _m.compose(_p, _q, _s);
      ambientMesh.setMatrixAt(i, _m);
    }
    ambientMesh.instanceMatrix.needsUpdate = true;
  }

  function stepShake(dt: number): void {
    // setShake is STATE, not an impulse: the rig re-applies whatever was last
    // written every frame, so the (0, 0) on the way out is mandatory or the
    // camera keeps the final offset for the rest of the match.
    if (shakeAmp > 0.005) {
      shakePhase += dt * 34;
      shakeAmp *= Math.max(0, 1 - 5.2 * dt);
      core.setShake(
        Math.sin(shakePhase) * shakeAmp * 0.35,
        Math.cos(shakePhase * 1.31) * shakeAmp * 0.35,
      );
    } else if (shakeAmp !== 0) {
      shakeAmp = 0;
      shakePhase = 0;
      core.setShake(0, 0);
    }
  }

  function stepNumbers(dt: number): void {
    for (let i = 0; i < numbers.length; i++) {
      const n = numbers[i];
      if (n === undefined || !n.active) continue;
      n.age += dt;
      if (n.age >= NUMBER_LIFE_S) {
        n.active = false;
        n.el.style.display = 'none';
        continue;
      }
      // worldToScreen leaves `out` untouched and returns false behind the camera
      // or outside the depth range — drawing at the stale position would smear
      // the number across the frame, so the node is hidden instead.
      if (!core.worldToScreen(n.x, core.heightAt(n.x, n.z) + 1.9, n.z, screenPt)) {
        n.el.style.display = 'none';
        n.lastX = Number.NaN;
        continue;
      }
      const px = Math.round(screenPt.x);
      const py = Math.round(screenPt.y - n.age * 42);
      if (px !== n.lastX || py !== n.lastY) {
        n.lastX = px;
        n.lastY = py;
        n.el.style.display = 'block';
        n.el.style.transform = `translate(-50%, -50%) translate(${String(px)}px, ${String(py)}px)`;
      }
      // Opacity is written on 1/24 steps, not every frame: a DOM style write is
      // the one string allocation in this loop that no API lets us avoid.
      const step = Math.round((1 - n.age / NUMBER_LIFE_S) * 24);
      if (step !== n.lastStep) {
        n.lastStep = step;
        n.el.style.opacity = String(step / 24);
      }
    }
  }

  let warned = false;

  function tick(dtMs: number): void {
    const dt = Math.min(MAX_DT, Math.max(0, dtMs) / 1000);
    try {
      stepParticles(sparks.paper, dt);
      stepParticles(sparks.arcane, dt);
      stepParticles(sparks.heal, dt);
      stepParticles(sparks.gold, dt);
      stepParticles(debris, dt);
      stepParticles(motes, dt);
      stepDomes(glows.phys, dt, true);
      stepDomes(glows.magic, dt, true);
      stepDomes(glows.heal, dt, true);
      stepDomes(decals, dt, false);
      stepAmbient(dt);
      stepShake(dt);
      stepNumbers(dt);
    } catch (err) {
      // CONTRACT §10: one thrown exception must never white-screen the game, and
      // it must never spam a log line every frame either.
      if (!warned) {
        warned = true;
        console.warn('rift fx: tick failed, effects degraded', err);
      }
    }
  }

  return { burst, tracer, shake, damageNumber, tick };
}
