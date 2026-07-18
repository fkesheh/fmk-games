// ============================================================================
// C6 — combat effects (pooled): tracers + particle bursts.
// Pools are fully preallocated in the constructor; spawn/update/clear perform
// ZERO allocation. Tracer meshes come from the contract box() factory (one
// cloned material per slot, built once — additive blending explicitly allowed
// for tracers); particles are the single allowed raw THREE.Points material.
// ALL colors trace to PALETTE; jitter comes from a seeded rng (never
// Math.random). Invariant: `root` stays at identity so lookAt() math is world.
// ============================================================================
import * as THREE from 'three';
import { PALETTE, rng, rngRange, type Team, type Vec3 } from '@fps/shared';
import { box } from '../contract/visual.js';

// ---- pool sizes (frozen by CONTRACT: ≤64 tracers, ≤256 particles) -----------
const TRACER_POOL = 64;
const PARTICLE_POOL = 256;

// ---- tracer tuning -----------------------------------------------------------
const TRACER_LIFE = 0.06; // s — spec: 60ms fading line
const TRACER_WIDTH = 0.025; // thin stretched box cross-section

// ---- particle tuning ---------------------------------------------------------
const PARTICLE_SIZE = 0.06; // spec: size ~0.06, sizeAttenuation
const PARK_Y = -10000; // dead slots park far below the map (alpha is also 0)

export class Effects {
  private readonly root = new THREE.Group();

  // ---- tracer pool: box meshes + per-slot remaining life ---------------------
  private readonly tracers: THREE.Mesh[] = [];
  private readonly tracerLife = new Float32Array(TRACER_POOL);
  private tracerCursor = 0;

  // ---- particle pool: one Points, attribute arrays double as sim state -------
  private readonly points: THREE.Points;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly pVel = new Float32Array(PARTICLE_POOL * 3);
  private readonly pLife = new Float32Array(PARTICLE_POOL); // remaining, s
  private readonly pMaxLife = new Float32Array(PARTICLE_POOL);
  private readonly pGrav = new Float32Array(PARTICLE_POOL); // downward accel m/s²
  private pCursor = 0;
  private pActive = 0;
  private pDirty = false; // forces one final attribute upload after clear()

  // cosmetic rng — seeded, deterministic, never Math.random
  private readonly next = rng(0xc6f1);

  // recipe colors as linear-work-space rgb (same conversion as mat())
  private readonly colDust = new THREE.Color(PALETTE.concrete);
  private readonly colSpark = new THREE.Color(PALETTE.muzzle);
  private readonly colBlood = new THREE.Color(PALETTE.blood);
  private readonly colTeamT = new THREE.Color(PALETTE.tAmber);
  private readonly colTeamCT = new THREE.Color(PALETTE.ctBlue);

  constructor(scene: THREE.Scene) {
    // tracers: 64 thin unit-depth boxes, stretched along the ray per spawn.
    // Materials are cloned once here (not per call) so opacity fades per slot.
    for (let i = 0; i < TRACER_POOL; i++) {
      const m = box(TRACER_WIDTH, TRACER_WIDTH, 1, PALETTE.tracer, {
        emissive: PALETTE.tracer,
        transparent: true,
      });
      const tmat = (m.material as THREE.MeshLambertMaterial).clone();
      tmat.blending = THREE.AdditiveBlending; // allowed for tracers per spec
      tmat.depthWrite = false;
      m.material = tmat;
      m.visible = false;
      this.tracers.push(m);
      this.root.add(m);
    }

    // particles: single Points draw call. itemSize-4 color attribute gives
    // per-particle alpha (three defines USE_COLOR_ALPHA) — dead slots hide by
    // zeroed alpha + parked position, per spec.
    const pos = new Float32Array(PARTICLE_POOL * 3);
    const col = new Float32Array(PARTICLE_POOL * 4);
    for (let i = 0; i < PARTICLE_POOL; i++) pos[i * 3 + 1] = PARK_Y;
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    const pmat = new THREE.PointsMaterial({
      size: PARTICLE_SIZE,
      vertexColors: true,
      sizeAttenuation: true,
      depthWrite: false, // spec
      transparent: true,
    });
    this.points = new THREE.Points(geo, pmat);
    this.points.frustumCulled = false; // positions mutate; bounding sphere stale
    this.root.add(this.points);

    scene.add(this.root);
  }

  /** 60ms additive streak along from→to. */
  tracer(from: Vec3, to: Vec3): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const lenSq = dx * dx + dy * dy + dz * dz;
    if (lenSq < 1e-6) return; // degenerate ray — nothing to show

    const i = this.tracerCursor;
    this.tracerCursor = (i + 1) % TRACER_POOL;
    const m = this.tracers[i]!; // pool is fully populated in the constructor
    m.position.set((from.x + to.x) * 0.5, (from.y + to.y) * 0.5, (from.z + to.z) * 0.5);
    m.lookAt(to.x, to.y, to.z); // +Z of the box aligns with the ray
    m.scale.set(1, 1, Math.sqrt(lenSq));
    m.visible = true;
    (m.material as THREE.MeshLambertMaterial).opacity = 1;
    this.tracerLife[i] = TRACER_LIFE;
  }

  /** Bullet hit on world geometry: 6 concrete dust + 2 muzzle sparks. */
  impact(p: Vec3): void {
    const c = this.colDust;
    this.burst(p, 6, c.r, c.g, c.b, 0.8, 1.8, 0.6, 0.3, 0.45, 3.5);
    const s = this.colSpark;
    this.burst(p, 2, s.r, s.g, s.b, 3.5, 5.5, 0.2, 0.1, 0.16, 9.8);
  }

  /** Flesh hit: 6 blood-red splash particles. */
  blood(p: Vec3): void {
    const b = this.colBlood;
    this.burst(p, 6, b.r, b.g, b.b, 1.5, 2.8, 0.5, 0.28, 0.42, 9);
  }

  /** Player death: 12 team-colored radial burst particles. */
  death(p: Vec3, team: Team): void {
    const t = team === 'CT' ? this.colTeamCT : this.colTeamT;
    this.burst(p, 12, t.r, t.g, t.b, 2.2, 4.0, 0.8, 0.5, 0.7, 5);
  }

  /** Advance both pools. Zero allocation; uploads attributes only when live. */
  update(dt: number): void {
    // tracers: fade opacity + shrink cross-section over 60ms, then hide
    for (let i = 0; i < TRACER_POOL; i++) {
      const life = this.tracerLife[i]!;
      if (life <= 0) continue;
      const m = this.tracers[i]!;
      const next = life - dt;
      if (next <= 0) {
        this.tracerLife[i] = 0;
        m.visible = false;
        continue;
      }
      this.tracerLife[i] = next;
      const k = next / TRACER_LIFE;
      (m.material as THREE.MeshLambertMaterial).opacity = k;
      m.scale.set(k, k, m.scale.z); // length persists, streak thins out
    }

    if (this.pActive === 0) {
      if (this.pDirty) {
        this.posAttr.needsUpdate = true;
        this.colAttr.needsUpdate = true;
        this.pDirty = false;
      }
      return;
    }

    // particles: gravity, integrate, linear alpha fade; park on death
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    for (let i = 0; i < PARTICLE_POOL; i++) {
      const life = this.pLife[i]!;
      if (life <= 0) continue;
      const i3 = i * 3;
      const i4 = i * 4;
      const next = life - dt;
      if (next <= 0) {
        this.pLife[i] = 0;
        col[i4 + 3] = 0;
        pos[i3 + 1] = PARK_Y;
        this.pActive--;
        continue;
      }
      this.pLife[i] = next;
      this.pVel[i3 + 1] = this.pVel[i3 + 1]! - this.pGrav[i]! * dt;
      pos[i3] = pos[i3]! + this.pVel[i3]! * dt;
      pos[i3 + 1] = pos[i3 + 1]! + this.pVel[i3 + 1]! * dt;
      pos[i3 + 2] = pos[i3 + 2]! + this.pVel[i3 + 2]! * dt;
      col[i4 + 3] = next / this.pMaxLife[i]!;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  /** Kill every live tracer and particle immediately. */
  clear(): void {
    for (let i = 0; i < TRACER_POOL; i++) {
      this.tracerLife[i] = 0;
      this.tracers[i]!.visible = false;
    }
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    for (let i = 0; i < PARTICLE_POOL; i++) {
      this.pLife[i] = 0;
      col[i * 4 + 3] = 0;
      pos[i * 3 + 1] = PARK_Y;
    }
    this.pActive = 0;
    this.pDirty = true; // upload the wiped state on the next update()
  }

  // ---- private helpers ---------------------------------------------------------

  /**
   * Spawn `count` particles at `p` into dead pool slots: random directions
   * (up-biased), speed/life in [min,max), per-particle gravity, slight
   * brightness jitter around the given PALETTE-derived rgb.
   */
  private burst(
    p: Vec3,
    count: number,
    r: number,
    g: number,
    b: number,
    speedMin: number,
    speedMax: number,
    upBias: number,
    lifeMin: number,
    lifeMax: number,
    grav: number,
  ): void {
    for (let n = 0; n < count; n++) {
      let dx = rngRange(this.next, -1, 1);
      let dy = rngRange(this.next, -1, 1) + upBias;
      let dz = rngRange(this.next, -1, 1);
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-4) {
        dx = 0;
        dy = 1;
        dz = 0;
      } else {
        const inv = 1 / len;
        dx *= inv;
        dy *= inv;
        dz *= inv;
      }
      const speed = rngRange(this.next, speedMin, speedMax);
      const shade = rngRange(this.next, 0.8, 1.0); // subtle value jitter
      this.spawn(
        p.x + rngRange(this.next, -0.05, 0.05),
        p.y + rngRange(this.next, -0.05, 0.05),
        p.z + rngRange(this.next, -0.05, 0.05),
        dx * speed,
        dy * speed,
        dz * speed,
        r * shade,
        g * shade,
        b * shade,
        rngRange(this.next, lifeMin, lifeMax),
        grav,
      );
    }
  }

  /** Write one particle into a dead slot (ring scan; falls back to overwrite). */
  private spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    r: number,
    g: number,
    b: number,
    life: number,
    grav: number,
  ): void {
    let idx = -1;
    for (let i = 0; i < PARTICLE_POOL; i++) {
      const j = (this.pCursor + i) % PARTICLE_POOL;
      if (this.pLife[j]! <= 0) {
        idx = j;
        break;
      }
    }
    if (idx === -1) idx = this.pCursor; // pool full: recycle oldest-ish slot
    this.pCursor = (idx + 1) % PARTICLE_POOL;

    // Count only genuinely-new activations: recycling a live slot must not
    // inflate pActive (else the pActive===0 early-out in update() never fires).
    const wasDead = this.pLife[idx]! <= 0;

    const i3 = idx * 3;
    const i4 = idx * 4;
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    pos[i3] = x;
    pos[i3 + 1] = y;
    pos[i3 + 2] = z;
    col[i4] = r;
    col[i4 + 1] = g;
    col[i4 + 2] = b;
    col[i4 + 3] = 1;
    this.pVel[i3] = vx;
    this.pVel[i3 + 1] = vy;
    this.pVel[i3 + 2] = vz;
    this.pLife[idx] = life;
    this.pMaxLife[idx] = life;
    this.pGrav[idx] = grav;
    if (wasDead) this.pActive++;
  }

  /**
   * Release all GPU resources owned by this pool: the 64 cloned tracer
   * materials + tracer box geometries, and the Points geometry + its
   * PointsMaterial. Called by ClientGame.teardownWorld() on room teardown.
   * The shared mat() cache is untouched — only per-instance clones die here.
   */
  dispose(): void {
    for (const m of this.tracers) {
      m.geometry.dispose();
      (m.material as THREE.MeshLambertMaterial).dispose();
    }
    this.points.geometry.dispose();
    (this.points.material as THREE.PointsMaterial).dispose();
  }
}
