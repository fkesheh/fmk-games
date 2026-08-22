// ============================================================================
// ACES render3d/materials — FROZEN (GRAPHICS_3D.md §3).
//
// The ONE material factory for the 3D layer: flat-shaded Lambert for lit
// surfaces, Basic for emissive/flat FX. Cached per color string — callers pass
// resolved palette strings from visual.ts helpers only (no ad-hoc hex). Also
// hosts THE puff model as a sprite texture: every soft mass in the 3D scene
// (clouds, smoke, blast bloom) samples this one canvas.
// ============================================================================

import * as THREE from 'three';
import { APAL, type PalKey } from '@aces/shared/palette';
import { softPuff } from '../contract/visual.js';

const lambertCache = new Map<string, THREE.MeshLambertMaterial>();
const basicCache = new Map<string, THREE.MeshBasicMaterial>();

/** Lit surface material — flatShading default true (low-poly law). */
export function matLambert(
  color: string,
  opts?: { flatShading?: boolean; side?: THREE.Side },
): THREE.MeshLambertMaterial {
  const flat = opts?.flatShading ?? true;
  const key = `${color}|${flat}|${opts?.side ?? 0}`;
  let m = lambertCache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color: new THREE.Color(color),
      flatShading: flat,
      side: opts?.side,
    });
    lambertCache.set(key, m);
  }
  return m;
}

/** Unlit/emissive material (tracers, flashes, sky dome). */
export function matBasic(
  color: string,
  opts?: { transparent?: boolean; opacity?: number; depthWrite?: boolean },
): THREE.MeshBasicMaterial {
  const key = `${color}|${opts?.transparent ?? false}|${opts?.opacity ?? 1}|${opts?.depthWrite ?? true}`;
  let m = basicCache.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: opts?.transparent ?? false,
      opacity: opts?.opacity ?? 1,
      depthWrite: opts?.depthWrite ?? true,
    });
    basicCache.set(key, m);
  }
  return m;
}

/** Palette-key convenience: APAL entry as a resolved hex string. */
export function pal(key: PalKey): string {
  return APAL[key];
}

let puffCanvas: HTMLCanvasElement | null = null;

/**
 * THE soft-mass texture: one radial puff (paper-cream core → transparent rim)
** baked once; every cloud/smoke/blast billboard samples it with per-sprite
 * color tinting done via sprite material color instead of repainting.
 */
export function puffTexture(): THREE.CanvasTexture {
  if (!puffCanvas) {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const g = c.getContext('2d');
    if (g) {
      g.clearRect(0, 0, 128, 128);
      softPuff(g, 64, 64, 60, 'rgba(255,255,255,0.95)', 'rgba(255,255,255,0)');
    }
    puffCanvas = c;
  }
  return new THREE.CanvasTexture(puffCanvas);
}
