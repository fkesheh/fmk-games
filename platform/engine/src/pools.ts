// ============================================================================
// POOLED FX — particles + tracers, zero allocation after warmup (docs/
// PLATFORM.md §4.6).
// Owner: P5_ENGINE — implement; BurstSpec/PoolCaps live in types.ts.
// ============================================================================

import type * as THREE from 'three';
import type { BurstSpec, PoolCaps } from './types.js';

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export class ParticlePool {
  constructor(scene: THREE.Scene, caps?: PoolCaps) {
    void scene;
    void caps;
  }

  burst(spec: BurstSpec): void {
    void spec;
  }

  update(dt: number): void {
    void dt;
  }

  dispose(): void {}
}

export class TracerPool {
  constructor(scene: THREE.Scene, caps?: PoolCaps) {
    void scene;
    void caps;
  }

  /** 60ms fading line from → to. */
  spawn(from: Vec3Like, to: Vec3Like, color: string): void {
    void from;
    void to;
    void color;
  }

  update(dt: number): void {
    void dt;
  }

  dispose(): void {}
}
