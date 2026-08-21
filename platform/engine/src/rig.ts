// ============================================================================
// SCENE RIG — renderer/camera/lights/fog/shadows/resize (docs/PLATFORM.md
// §4.6). Generalized from STRICKEN's proven SceneRig.
// Owner: P5_ENGINE — implement; RigOpts/SunSpec live in types.ts.
// ============================================================================

import * as THREE from 'three';
import type { RigOpts, SunSpec } from './types.js';

export class SceneRig {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  constructor(_opts: RigOpts) {
    void _opts;
    // P5_ENGINE: not implemented — construct real objects in the final body.
    throw new Error('P5_ENGINE: not implemented');
  }

  /** (Re)configure sun + hemisphere + shadow frustum; follows focus(). */
  setSun(spec: SunSpec): void {
    void spec;
  }

  /** Shadow camera tracks this world-space point (player, kart, …). */
  focus(x: number, y: number, z: number): void {
    void x;
    void y;
    void z;
  }

  resize(): void {}
  render(): void {}
  dispose(): void {}
}
