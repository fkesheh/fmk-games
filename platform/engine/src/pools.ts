// ============================================================================
// POOLED FX — particles + tracers, zero allocation after warmup (docs/
// PLATFORM.md §4.6).
// Owner: P5_ENGINE — implement; BurstSpec/PoolCaps live in types.ts.
//
// Both pools are fully preallocated in the constructor (one Points draw call
// for particles, one Line slot per tracer with its own cloned material so
// opacity fades per slot). Spawn recycles the OLDEST slot through a ring
// cursor when the pool is full; update(dt) advances state strictly in place —
// no object churn on any hot path.
// ============================================================================

import * as THREE from 'three';
import type { BurstSpec, PoolCaps } from './types.js';

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const PARTICLE_SIZE = 0.08;
/** Dead particle slots park far below any map (their alpha is also 0). */
const PARTICLE_PARK_Y = -10000;

const TRACER_LIFE = 0.06; // s — spec: 60ms fading line

// ---- ParticlePool --------------------------------------------------------------

export class ParticlePool {
  /** Total slots — bursts recycle the oldest live slot past this bound. */
  readonly capacity: number;

  private readonly root = new THREE.Group();
  private readonly points: THREE.Points;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  // Simulation state lives in flat typed arrays — the attribute arrays double
  // as position/color storage exactly like the reference Effects pool.
  private readonly vel: Float32Array;
  private readonly life: Float32Array; // remaining seconds
  private readonly maxLife: Float32Array;
  private readonly grav: Float32Array;
  private cursor = 0;
  private liveCount = 0;
  private dirty = false; // flush one final upload after the last particle dies

  private readonly tint = new THREE.Color(); // scratch — burst() only

  constructor(scene: THREE.Scene, caps?: PoolCaps) {
    this.capacity = caps?.particles ?? 256;
    const n = this.capacity;

    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      pos[i * 3 + 1] = PARTICLE_PARK_Y; // dead slots parked out of sight
      col[i * 4 + 3] = 0; // alpha 0
    }
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);

    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: PARTICLE_SIZE,
        vertexColors: true,
        sizeAttenuation: true,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.points.frustumCulled = false; // positions mutate; bounding sphere stays stale

    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.grav = new Float32Array(n);

    this.root.add(this.points);
    scene.add(this.root);
  }

  /** Particles currently alive (test seam for recycling bounds). */
  get live(): number {
    return this.liveCount;
  }

  /**
   * One-shot burst at a world point. When the pool is full the ring cursor
   * overwrites the oldest live particles — capacity is a hard bound, never a
   * leak and never an allocation.
   */
  burst(spec: BurstSpec): void {
    const [speedMin, speedMax] = spec.speed ?? [1, 3];
    const life = spec.lifeSec ?? 0.5;
    const gravity = spec.gravity ?? -6; // acceleration along -y
    this.tint.set(spec.color);

    for (let k = 0; k < spec.count; k++) {
      // Random direction, up-biased like every reference impact effect.
      let dx = Math.random() * 2 - 1;
      let dy = Math.random() * 2 - 1 + 0.35;
      let dz = Math.random() * 2 - 1;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const speed = speedMin + Math.random() * (speedMax - speedMin);
      const shade = 0.82 + Math.random() * 0.24; // subtle value jitter

      const i = this.cursor;
      this.cursor = (i + 1) % this.capacity;
      const wasDead = this.life[i]! <= 0;
      if (wasDead) this.liveCount++;

      const i3 = i * 3;
      const i4 = i * 4;
      const pos = this.posAttr.array as Float32Array;
      const col = this.colAttr.array as Float32Array;
      pos[i3] = spec.x;
      pos[i3 + 1] = spec.y;
      pos[i3 + 2] = spec.z;
      col[i4] = this.tint.r * shade;
      col[i4 + 1] = this.tint.g * shade;
      col[i4 + 2] = this.tint.b * shade;
      col[i4 + 3] = 1;
      this.vel[i3] = (dx / len) * speed;
      this.vel[i3 + 1] = (dy / len) * speed;
      this.vel[i3 + 2] = (dz / len) * speed;
      this.life[i] = life;
      this.maxLife[i] = life;
      this.grav[i] = gravity;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  /** Integrate every live particle in place. Zero allocation. */
  update(dt: number): void {
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    let alive = 0;
    for (let i = 0; i < this.capacity; i++) {
      const remaining = this.life[i]!;
      if (remaining <= 0) continue;
      const next = remaining - dt;
      const i3 = i * 3;
      if (next <= 0) {
        this.life[i] = 0;
        col[i * 4 + 3] = 0;
        pos[i3 + 1] = PARTICLE_PARK_Y;
        continue;
      }
      this.life[i] = next;
      alive++;

      // gravity is an ACCELERATION along -y: v += g*dt, then p += v*dt
      this.vel[i3 + 1] = this.vel[i3 + 1]! + this.grav[i]! * dt;
      pos[i3] = pos[i3]! + this.vel[i3]! * dt;
      pos[i3 + 1] = pos[i3 + 1]! + this.vel[i3 + 1]! * dt;
      pos[i3 + 2] = pos[i3 + 2]! + this.vel[i3 + 2]! * dt;

      const t = next / this.maxLife[i]!; // hold opaque, then ease out
      col[i * 4 + 3] = t * t * (3 - 2 * t);
    }
    this.liveCount = alive;
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.dirty = alive === 0; // one final upload already done above
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.PointsMaterial).dispose();
    this.root.removeFromParent();
  }
}

// ---- TracerPool ----------------------------------------------------------------

/**
 * Thin fading muzzle-to-impact lines. One preallocated THREE.Line per slot,
 * each with its own cloned LineBasicMaterial so opacity fades independently.
 */
export class TracerPool {
  /** Total slots — spawns recycle the oldest live line past this bound. */
  readonly capacity: number;

  private readonly root = new THREE.Group();
  private readonly lines: THREE.Line[] = [];
  private readonly materials: THREE.LineBasicMaterial[] = [];
  private readonly life: Float32Array;
  private cursor = 0;

  private readonly tint = new THREE.Color();

  constructor(scene: THREE.Scene, caps?: PoolCaps) {
    this.capacity = caps?.tracers ?? 64;
    this.life = new Float32Array(this.capacity);

    for (let i = 0; i < this.capacity; i++) {
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(6); // one segment: from -> to
      pos[1] = PARTICLE_PARK_Y;
      pos[4] = PARTICLE_PARK_Y;
      const attr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', attr);
      const material = new THREE.LineBasicMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const line = new THREE.Line(geo, material);
      line.frustumCulled = false;
      line.visible = false;
      this.lines.push(line);
      this.materials.push(material);
      this.root.add(line);
    }
    scene.add(this.root);
  }

  /** Lines currently fading (test seam for recycling bounds). */
  get live(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.life[i]! > 0) n++;
    return n;
  }

  /** 60ms fading line from → to. */
  spawn(from: Vec3Like, to: Vec3Like, color: string): void {
    const i = this.cursor;
    this.cursor = (i + 1) % this.capacity;

    const attr = this.lines[i]!.geometry.getAttribute('position') as THREE.BufferAttribute;
    const pos = attr.array as Float32Array;
    pos[0] = from.x;
    pos[1] = from.y;
    pos[2] = from.z;
    pos[3] = to.x;
    pos[4] = to.y;
    pos[5] = to.z;
    attr.needsUpdate = true;

    this.materials[i]!.color.set(color);
    this.materials[i]!.opacity = 1;
    this.lines[i]!.visible = true;
    this.life[i] = TRACER_LIFE;
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      const remaining = this.life[i]!;
      if (remaining <= 0) continue;
      const next = remaining - dt;
      if (next <= 0) {
        this.life[i] = 0;
        this.lines[i]!.visible = false;
        this.materials[i]!.opacity = 0;
        continue;
      }
      this.life[i] = next;
      this.materials[i]!.opacity = next / TRACER_LIFE;
    }
  }

  dispose(): void {
    for (let i = 0; i < this.capacity; i++) {
      this.lines[i]!.geometry.dispose();
      this.materials[i]!.dispose();
    }
    this.root.removeFromParent();
  }
}
