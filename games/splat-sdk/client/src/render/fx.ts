// ============================================================================
// SKI SPLAT — SplatFx (task R2, CONTRACT §7 + §7a seam). Pooled THREE.Points
// particle systems — the ONLY particle mechanism in the game (§2.5 exempts
// particle Points from the mesh-factory law; every colour still comes from
// SPAL / SKIER_COLORS):
//   spray    — carve snow spray: fast, heavy, short-lived snowLit grains.
//   puff     — plant-hit powder burst: slower billow, snowLit -> snowShade.
//   confetti — finish pennant burst: sunGold + the 8 skier colours, light
//              gravity, flutter on the way down.
//   land     — touchdown powder ring + billow: the biggest burst in the game
//              (snowLit -> snowShade, ring velocity, light gravity).
//   launch   — takeoff-lip spray kick: fast, short, directional pop.
//   sparkle  — subtle additive glint layer drifting near the camera (the
//              "glittering snow" of the STYLE_BIBLE); wraps around (camX,camZ).
//
// Budget law: pool capacities sum to <= 512 live particles (§8). Zero
// per-frame allocation: every pool is a fixed ring of typed-array slots
// allocated at construction; update() only writes into the live attribute
// arrays. Deterministic: all spawn randomness flows from ONE rng() stream
// with a fixed seed (@platform/shared); Math.random never appears.
// Dead particles are parked at PARK_Y (far under the world) — Points have no
// per-particle visibility, so parking is the free-slot mechanism.
// ============================================================================

import * as THREE from 'three';
import { SKIER_COLORS, SPAL } from '@splat/shared';
import { decoSeed, rng, rngInt, rngRange } from '@platform/shared';

export type FxKind = 'spray' | 'puff' | 'confetti' | 'land' | 'launch';

// ---- pool sizes (capacities sum to exactly 512 — the §8 particle budget) ----
const SPRAY_CAP = 120;
const PUFF_CAP = 112;
const CONFETTI_CAP = 160;
const LAND_CAP = 72;
const LAUNCH_CAP = 48;
const SPARKLE_N = 128; // glint layer — not a gameplay pool, separate Points

const PARK_Y = -10000; // dead-slot parking altitude
const FX_SEED_SALT = 0xf2;

// ---- per-kind spawn recipes (module-level, never allocated at runtime) ------
interface FxRecipe {
  count: number; // particles per burst
  lifeLo: number;
  lifeHi: number;
  outLo: number; // lateral speed m/s
  outHi: number;
  upLo: number; // initial vertical speed m/s
  upHi: number;
  grav: number; // m/s² (positive pulls down)
  drag: number; // lateral velocity decay per second
  flutter: number; // confetti sway amplitude (0 = ballistic)
  size: number; // PointsMaterial world size
  from: THREE.Color;
  to: THREE.Color;
  confettiColors: boolean; // per-particle pick from sunGold + SKIER_COLORS
}

const RECIPES: Record<FxKind, FxRecipe> = {
  spray: {
    count: 14,
    lifeLo: 0.28,
    lifeHi: 0.55,
    outLo: 1.2,
    outHi: 4.2,
    upLo: 1.4,
    upHi: 3.6,
    grav: 11,
    drag: 0.6,
    flutter: 0,
    size: 0.09,
    from: new THREE.Color(SPAL.snowLit),
    to: new THREE.Color(SPAL.snowShade),
    confettiColors: false,
  },
  puff: {
    count: 18,
    lifeLo: 0.5,
    lifeHi: 0.9,
    outLo: 0.7,
    outHi: 2.6,
    upLo: 0.9,
    upHi: 2.4,
    grav: 2.6, // powder hangs, then settles
    drag: 1.6,
    flutter: 0,
    size: 0.18,
    from: new THREE.Color(SPAL.snowLit),
    to: new THREE.Color(SPAL.snow),
    confettiColors: false,
  },
  confetti: {
    count: 48,
    lifeLo: 1.2,
    lifeHi: 2.0,
    outLo: 1.4,
    outHi: 5.2,
    upLo: 3.2,
    upHi: 7.0,
    grav: 3.4, // pennants are light
    drag: 0.9,
    flutter: 1.4,
    size: 0.12,
    from: new THREE.Color(SPAL.sunGold),
    to: new THREE.Color(SPAL.sunGold),
    confettiColors: true,
  },
  land: {
    count: 24,
    lifeLo: 0.4,
    lifeHi: 0.8,
    outLo: 3.5, // ring velocity — high lateral, the touchdown read
    outHi: 6.5,
    upLo: 2.5,
    upHi: 5.0,
    grav: 5, // light — powder billows, then settles
    drag: 1.0,
    flutter: 0,
    size: 0.2, // the weightiest grains in the game
    from: new THREE.Color(SPAL.snowLit),
    to: new THREE.Color(SPAL.snowShade),
    confettiColors: false,
  },
  launch: {
    count: 14,
    lifeLo: 0.25,
    lifeHi: 0.5,
    outLo: 2,
    outHi: 5,
    upLo: 1.5, // slight up bias — the pop read at the lip
    upHi: 3.5,
    grav: 9, // heavy — kicks out and drops fast
    drag: 0.8,
    flutter: 0,
    size: 0.1,
    from: new THREE.Color(SPAL.snowLit),
    to: new THREE.Color(SPAL.snowShade),
    confettiColors: false,
  },
};

// Confetti picks from sunGold + every skier colour (allocated once).
const CONFETTI_COLORS: readonly THREE.Color[] = [
  new THREE.Color(SPAL.sunGold),
  ...SKIER_COLORS.map((hex) => new THREE.Color(hex)),
];

/**
 * One pooled Points system. The position/colour typed arrays ARE the buffer
 * attribute storage, so per-frame writes land straight on the GPU upload path.
 */
interface PointPool {
  readonly points: THREE.Points;
  readonly pos: Float32Array; // 3*cap — attribute array
  readonly col: Float32Array; // 3*cap — attribute array
  readonly posAttr: THREE.BufferAttribute;
  readonly colAttr: THREE.BufferAttribute;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly seed: Float32Array; // per-particle flutter phase (confetti)
  readonly cap: number;
  cursor: number; // ring cursor
  live: number; // live particle count (needsUpdate gating)
}

function makePool(cap: number, size: number): PointPool {
  const pos = new Float32Array(cap * 3);
  for (let i = 0; i < cap; i++) pos[i * 3 + 1] = PARK_Y;
  const col = new Float32Array(cap * 3).fill(1);
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  const colAttr = new THREE.BufferAttribute(col, 3);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', colAttr);
  const material = new THREE.PointsMaterial({
    size,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false; // positions mutate; bounding sphere would stale
  return {
    points,
    pos,
    col,
    posAttr,
    colAttr,
    vx: new Float32Array(cap),
    vy: new Float32Array(cap),
    vz: new Float32Array(cap),
    age: new Float32Array(cap),
    life: new Float32Array(cap), // 0 = dead
    seed: new Float32Array(cap),
    cap,
    cursor: 0,
    live: 0,
  };
}

// ---- snow sparkle glint layer -------------------------------------------------
// Fixed base offsets in a wrapping torus around the camera; the y band rides
// on the analytic grade (SUMMIT_LIFT - GRADE_BASE*z) so glints hug the snow
// anywhere on the mountain without needing a terrain handle (the §7a seam
// hands update() only camX/camZ). Twinkle is one global opacity oscillator —
// subtle by design (STYLE_BIBLE: "subtle additive Points glints").
const SPARKLE_W = 44; // wrap width (m) around camX
const SPARKLE_D = 44; // wrap depth (m) around camZ
const SPARKLE_Y0 = 0.15; // band above the snow
const SPARKLE_Y1 = 2.6;
const GRADE_APPROX = 0.21; // GRADE_BASE — analytic mean fall
const SUMMIT_APPROX = 6; // slope.ts SUMMIT_LIFT

interface SparkleLayer {
  readonly points: THREE.Points;
  readonly pos: Float32Array;
  readonly posAttr: THREE.BufferAttribute;
  readonly bx: Float32Array; // base offsets inside the wrap torus
  readonly by: Float32Array;
  readonly bz: Float32Array;
  readonly mat: THREE.PointsMaterial;
}

export class SplatFx {
  private readonly world: THREE.Scene;
  private readonly next = rng(decoSeed('splat-fx', FX_SEED_SALT));
  private readonly pools: Record<FxKind, PointPool>;
  private readonly sparkle: SparkleLayer;
  private t = 0; // fx clock (dt-driven only)

  constructor(world: THREE.Scene) {
    this.world = world;
    this.pools = {
      spray: makePool(SPRAY_CAP, RECIPES.spray.size),
      puff: makePool(PUFF_CAP, RECIPES.puff.size),
      confetti: makePool(CONFETTI_CAP, RECIPES.confetti.size),
      land: makePool(LAND_CAP, RECIPES.land.size),
      launch: makePool(LAUNCH_CAP, RECIPES.launch.size),
    };
    for (const kind of ['spray', 'puff', 'confetti', 'land', 'launch'] as const) {
      world.add(this.pools[kind].points);
    }

    // ---- sparkle layer ----
    const pos = new Float32Array(SPARKLE_N * 3);
    const bx = new Float32Array(SPARKLE_N);
    const by = new Float32Array(SPARKLE_N);
    const bz = new Float32Array(SPARKLE_N);
    for (let i = 0; i < SPARKLE_N; i++) {
      bx[i] = this.next() * SPARKLE_W;
      by[i] = SPARKLE_Y0 + this.next() * (SPARKLE_Y1 - SPARKLE_Y0);
      bz[i] = this.next() * SPARKLE_D;
    }
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3);
    geo.setAttribute('position', posAttr);
    const mat = new THREE.PointsMaterial({
      color: SPAL.snowLit,
      size: 0.05,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    world.add(points);
    this.sparkle = { points, pos, posAttr, bx, by, bz, mat };
  }

  /** Spawn one burst of `kind` at world (x, y, z). Ring-recycles when full. */
  burst(kind: FxKind, x: number, y: number, z: number): void {
    const r = RECIPES[kind];
    const pool = this.pools[kind];
    for (let n = 0; n < r.count; n++) {
      const i = pool.cursor;
      pool.cursor = (pool.cursor + 1) % pool.cap;
      const ang = this.next() * Math.PI * 2;
      const out = rngRange(this.next, r.outLo, r.outHi);
      pool.vx[i] = Math.cos(ang) * out;
      pool.vz[i] = Math.sin(ang) * out;
      pool.vy[i] = rngRange(this.next, r.upLo, r.upHi);
      pool.age[i] = 0;
      pool.life[i] = rngRange(this.next, r.lifeLo, r.lifeHi);
      pool.seed[i] = this.next() * Math.PI * 2;
      pool.pos[i * 3] = x;
      pool.pos[i * 3 + 1] = y;
      pool.pos[i * 3 + 2] = z;
      if (r.confettiColors) {
        const c = CONFETTI_COLORS[rngInt(this.next, 0, CONFETTI_COLORS.length - 1)];
        if (c !== undefined) {
          pool.col[i * 3] = c.r;
          pool.col[i * 3 + 1] = c.g;
          pool.col[i * 3 + 2] = c.b;
        }
      } else {
        pool.col[i * 3] = r.from.r;
        pool.col[i * 3 + 1] = r.from.g;
        pool.col[i * 3 + 2] = r.from.b;
      }
    }
    pool.posAttr.needsUpdate = true;
    pool.colAttr.needsUpdate = true;
    if (pool.live === 0) pool.live = 1; // wake stepPool; it recomputes exactly
  }

  /** Advance every pool + the sparkle wrap. (camX, camZ) anchor the glints. */
  update(dt: number, camX: number, camZ: number): void {
    this.t += dt;
    for (const kind of ['spray', 'puff', 'confetti', 'land', 'launch'] as const) {
      this.stepPool(this.pools[kind], RECIPES[kind], dt);
    }

    // Sparkle: wrap base offsets into the torus around the camera. The y band
    // follows the mean grade so glints stay near the snow down the whole run.
    const s = this.sparkle;
    const groundY = SUMMIT_APPROX - GRADE_APPROX * camZ;
    for (let i = 0; i < SPARKLE_N; i++) {
      const bx = s.bx[i] ?? 0;
      const bz = s.bz[i] ?? 0;
      const dx = (((bx - camX) % SPARKLE_W) + SPARKLE_W) % SPARKLE_W - SPARKLE_W / 2;
      const dz = (((bz - camZ) % SPARKLE_D) + SPARKLE_D) % SPARKLE_D - SPARKLE_D / 2;
      s.pos[i * 3] = camX + dx;
      s.pos[i * 3 + 1] = groundY + (s.by[i] ?? 0);
      s.pos[i * 3 + 2] = camZ + dz;
    }
    s.posAttr.needsUpdate = true;
    // Slow global twinkle; deterministic (fx clock only).
    s.mat.opacity = 0.22 + 0.18 * (0.5 + 0.5 * Math.sin(this.t * 2.3));
  }

  /** Retire every particle instantly (room leave / rematch). */
  clear(): void {
    for (const kind of ['spray', 'puff', 'confetti', 'land', 'launch'] as const) {
      const pool = this.pools[kind];
      pool.life.fill(0);
      pool.live = 0;
      for (let i = 0; i < pool.cap; i++) pool.pos[i * 3 + 1] = PARK_Y;
      pool.posAttr.needsUpdate = true;
    }
  }

  /** Remove the Points from the world and free geometry + materials. */
  dispose(): void {
    for (const kind of ['spray', 'puff', 'confetti', 'land', 'launch'] as const) {
      const pool = this.pools[kind];
      this.world.remove(pool.points);
      pool.points.geometry.dispose();
      (pool.points.material as THREE.Material).dispose();
    }
    this.world.remove(this.sparkle.points);
    this.sparkle.points.geometry.dispose();
    this.sparkle.mat.dispose();
  }

  // ---- internals ---------------------------------------------------------------

  /** Integrate one pool: ballistic/gravity + drag + optional confetti flutter. */
  private stepPool(pool: PointPool, r: FxRecipe, dt: number): void {
    if (pool.live === 0) return; // fully parked — no attribute traffic at all
    let live = 0;
    for (let i = 0; i < pool.cap; i++) {
      if ((pool.life[i] ?? 0) <= 0) continue;
      const age = (pool.age[i] ?? 0) + dt;
      pool.age[i] = age;
      const life = pool.life[i] ?? 0;
      if (age >= life) {
        pool.life[i] = 0;
        pool.pos[i * 3 + 1] = PARK_Y;
        continue;
      }
      live++;
      pool.vy[i] = (pool.vy[i] ?? 0) - r.grav * dt;
      const damp = Math.max(0, 1 - r.drag * dt);
      pool.vx[i] = (pool.vx[i] ?? 0) * damp;
      pool.vz[i] = (pool.vz[i] ?? 0) * damp;
      let dx = (pool.vx[i] ?? 0) * dt;
      const dz = (pool.vz[i] ?? 0) * dt;
      if (r.flutter > 0) {
        // Pennant sway: a cheap lateral sine, phase-seeded per particle.
        dx += Math.sin(this.t * 7 + (pool.seed[i] ?? 0)) * r.flutter * dt;
      }
      pool.pos[i * 3] = (pool.pos[i * 3] ?? 0) + dx;
      pool.pos[i * 3 + 1] = (pool.pos[i * 3 + 1] ?? 0) + (pool.vy[i] ?? 0) * dt;
      pool.pos[i * 3 + 2] = (pool.pos[i * 3 + 2] ?? 0) + dz;
      // Cool the tint over the life (snow shades blue-violet as it settles).
      if (!r.confettiColors) {
        const k = age / life;
        pool.col[i * 3] = r.from.r + (r.to.r - r.from.r) * k;
        pool.col[i * 3 + 1] = r.from.g + (r.to.g - r.from.g) * k;
        pool.col[i * 3 + 2] = r.from.b + (r.to.b - r.from.b) * k;
      }
    }
    pool.live = live;
    pool.posAttr.needsUpdate = true;
    if (!r.confettiColors) pool.colAttr.needsUpdate = true;
  }
}
