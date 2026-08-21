// ============================================================================
// CAMERA RIGS — fps / chase / orbit (docs/PLATFORM.md §4.6).
// Owner: P5_ENGINE — implement; ChaseOpts/OrbitOpts live in types.ts.
// ============================================================================

import type * as THREE from 'three';
import type { ChaseOpts, OrbitOpts } from './types.js';
import type { Vec3Like } from './pools.js';

/** First-person: position = feet pos + eyeHeight; yaw/pitch radians. */
export function applyFpsCam(
  cam: THREE.PerspectiveCamera,
  pos: Vec3Like,
  yaw: number,
  pitch: number,
  eyeHeight: number,
): void {
  void cam;
  void pos;
  void yaw;
  void pitch;
  void eyeHeight;
}

/** Smoothed third-person follow. track() every tick; update(dt) per frame. */
export class ChaseCam {
  constructor(cam: THREE.PerspectiveCamera, opts: ChaseOpts) {
    void cam;
    void opts;
  }

  track(pos: Vec3Like, yaw: number): void {
    void pos;
    void yaw;
  }

  /** Teleport the camera behind the tracked pose (no smoothing). */
  snap(): void {}

  update(dt: number): void {
    void dt;
  }
}

/** Slow auto-orbit around a center (menus/spectate). */
export class OrbitCam {
  constructor(cam: THREE.PerspectiveCamera, opts: OrbitOpts) {
    void cam;
    void opts;
  }

  center(pos: Vec3Like): void {
    void pos;
  }

  update(dt: number): void {
    void dt;
  }
}
