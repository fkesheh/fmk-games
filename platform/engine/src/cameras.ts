// ============================================================================
// CAMERA RIGS — fps / chase / orbit (docs/PLATFORM.md §4.6).
// Owner: P5_ENGINE — implement; ChaseOpts/OrbitOpts live in types.ts.
//
// All three rigs use the house YXZ aim convention (yaw about world Y, then
// pitch about local X) and scratch Vector3s allocated once — update paths
// allocate nothing.
// ============================================================================

import * as THREE from 'three';
import type { ChaseOpts, OrbitOpts } from './types.js';
import type { Vec3Like } from './pools.js';

/** Frame-rate-independent exponential smoothing factor for this frame. */
function lagFactor(lag: number, dt: number): number {
  return 1 - Math.exp(-lag * Math.max(0, dt));
}

/**
 * First-person: position = feet pos + eyeHeight; yaw/pitch radians. Direct
 * assignment — the FPS camera never lags the player.
 */
export function applyFpsCam(
  cam: THREE.PerspectiveCamera,
  pos: Vec3Like,
  yaw: number,
  pitch: number,
  eyeHeight: number,
): void {
  cam.rotation.order = 'YXZ';
  cam.position.set(pos.x, pos.y + eyeHeight, pos.z);
  cam.rotation.set(pitch, yaw, 0);
}

/** Smoothed third-person follow. track() every tick; update(dt) per frame. */
export class ChaseCam {
  private readonly cam: THREE.PerspectiveCamera;
  private readonly dist: number;
  private readonly height: number;
  private readonly lag: number;
  private readonly lookHeight: number;

  // Desired pose from the last track(), and the smoothed pose actually applied.
  private readonly desiredPos = new THREE.Vector3();
  private readonly desiredLook = new THREE.Vector3();
  private readonly smoothPos = new THREE.Vector3();
  private readonly smoothLook = new THREE.Vector3();
  private readonly lookScratch = new THREE.Vector3();
  private tracked = false;

  constructor(cam: THREE.PerspectiveCamera, opts: ChaseOpts) {
    this.cam = cam;
    this.dist = opts.dist;
    this.height = opts.height;
    this.lag = opts.lag ?? 8;
    this.lookHeight = opts.lookHeight ?? 0;
  }

  /** Record the followed pose (feet position + facing yaw, radians). */
  track(pos: Vec3Like, yaw: number): void {
    // Forward is -z rotated by yaw (YXZ convention); park the camera behind it.
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    this.desiredPos.set(
      pos.x + sin * this.dist,
      pos.y + this.height,
      pos.z + cos * this.dist,
    );
    this.desiredLook.set(pos.x, pos.y + this.lookHeight, pos.z);
    if (!this.tracked) this.snap(); // first track starts exactly on the rig
  }

  /** Teleport the camera behind the tracked pose (no smoothing). */
  snap(): void {
    if (!this.tracked) return;
    this.smoothPos.copy(this.desiredPos);
    this.smoothLook.copy(this.desiredLook);
    this.apply();
  }

  /** Ease toward the tracked pose. Call once per rendered frame. */
  update(dt: number): void {
    if (!this.tracked || dt <= 0) return;
    const k = lagFactor(this.lag, dt);
    this.smoothPos.lerp(this.desiredPos, k);
    this.smoothLook.lerp(this.desiredLook, k);
    this.apply();
  }

  private apply(): void {
    this.cam.position.copy(this.smoothPos);
    this.cam.lookAt(this.lookScratch.copy(this.smoothLook));
  }
}

/** Slow auto-orbit around a center (menus/spectate). */
export class OrbitCam {
  private readonly cam: THREE.PerspectiveCamera;
  private readonly radius: number;
  private readonly height: number;
  private readonly rotSpeed: number;

  private readonly centerPoint = new THREE.Vector3();
  private angle = 0;

  constructor(cam: THREE.PerspectiveCamera, opts: OrbitOpts) {
    this.cam = cam;
    this.radius = opts.radius;
    this.height = opts.height;
    this.rotSpeed = opts.rotSpeed ?? 0.35;
    this.centerPoint.set(0, 0, 0);
    this.place();
  }

  center(pos: Vec3Like): void {
    this.centerPoint.set(pos.x, pos.y, pos.z);
    this.place();
  }

  /** Advance the auto-orbit. Call once per rendered frame. */
  update(dt: number): void {
    if (dt === 0) return;
    this.angle += this.rotSpeed * Math.max(0, dt);
    this.place();
  }

  private place(): void {
    this.cam.position.set(
      this.centerPoint.x + Math.cos(this.angle) * this.radius,
      this.centerPoint.y + this.height,
      this.centerPoint.z + Math.sin(this.angle) * this.radius,
    );
    this.cam.lookAt(this.centerPoint);
  }
}
