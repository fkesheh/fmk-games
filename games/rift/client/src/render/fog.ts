// ============================================================================
// ANCIENTS (rift) — FOG OF WAR (CONTRACT §6 render/fog.ts + §7 fog look).
// The client owns the PIXELS of fog: a generated CanvasTexture visibility
// mask (the §0 amendment permits CanvasTexture for fog + minimap ONLY),
// rebuilt from each snapshot (game.ts throttles to ~5Hz).
//
// Canvases (all 256², all generated — no image assets):
//   visNow   — this update's visible discs (white, soft radial falloff)
//   explored — persistent 'lighten' accumulation of every visNow so far
//   mask     — THE shared maskCanvas (the minimap reads this one): opaque
//              `shroud` unexplored, DIM_ALPHA explored (terrain composites
//              toward shroud), clear where visible; alpha feathered to zero
//              across a soft band at the map bounds so the overlay planes
//              fall off radially, never on a straight rectangular edge
//   hard     — unexplored-only shroud, for the high plane that hides props
//              (same bounds feather)
//
// World overlay = two transparent Lambert planes (the material law holds —
// emissive-locked so the shroud hex renders exactly): a LOW one at y=0.55
// using `mask` (darkens terrain; unit bodies poke through and stay readable
// on fog-darkened ground — the ladder law) and a HIGH one at y=7.5 using
// `hard` (unexplored is a full shroud over everything below the sky).
// ============================================================================
import * as THREE from 'three';
import {
  ANCIENT,
  APAL,
  CREEP_MELEE,
  CREEP_RANGED,
  CREEP_SIEGE,
  GUARD_TOWER,
  HERO_VISION,
  SUMMON_SHADE,
  TOWER,
  WARD_VISION,
} from '@rift/shared';
import type { EntKind, MapDef } from '@rift/shared';
import type { FogHandle, SceneHandle, SnapMsg } from '../contract.js';
import { sceneCore } from './scene.js';

const RES = 256;
/** World height of the low (terrain-dimming) fog plane. */
const LOW_Y = 0.55;
/** World height of the hard-shroud plane (above the 6 m Ancient + heart). */
const HIGH_Y = 7.5;
/** Explored-not-visible terrain darkens toward shroud by this alpha (CONTRACT
 *  §6/§7: composites toward `shroud` 0.55). The scene exposure is tuned so
 *  explored ground at 0.55 still reads plainly lighter than the opaque shroud. */
const DIM_ALPHA = 0.55;
/** Width of the soft alpha falloff at the map bounds (fraction of the mask
 *  resolution) — the shroud must feather out, never end on a straight edge. */
const BOUNDS_FEATHER = 0.12;

const VISION: Record<EntKind, number> = {
  hero: HERO_VISION,
  melee: CREEP_MELEE.vision,
  ranged: CREEP_RANGED.vision,
  siege: CREEP_SIEGE.vision,
  shade: SUMMON_SHADE.vision,
  tower: TOWER.vision,
  guard: GUARD_TOWER.vision,
  ancient: ANCIENT.vision,
  ward: WARD_VISION,
  proj: 0,
};

/** rgba() string from an APAL hex (the visibility mask's RGB is irrelevant —
 *  only its alpha is read — but every colour literal stays palette-traceable). */
function rgbaOf(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${String(r)},${String(g)},${String(b)},${String(alpha)})`;
}

function makeCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement('canvas');
  cv.width = RES;
  cv.height = RES;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('rift fog: 2d canvas context unavailable');
  return [cv, ctx];
}

/** Feather a mask's alpha to zero across a soft band at the canvas edges (=
 *  the map bounds), so the world overlay planes fade out radially instead of
 *  ending on a hard rectangular edge. Runs LAST on every compose. */
function featherBounds(ctx: CanvasRenderingContext2D): void {
  const f = RES * BOUNDS_FEATHER;
  const edges: readonly [number, number, number, number][] = [
    [0, 0, 0, f], // top
    [0, RES, 0, RES - f], // bottom
    [0, 0, f, 0], // left
    [RES, 0, RES - f, 0], // right
  ];
  ctx.globalCompositeOperation = 'destination-out';
  for (const [x0, y0, x1, y1] of edges) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, rgbaOf(APAL.paper, 1));
    g.addColorStop(1, rgbaOf(APAL.paper, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, RES, RES);
  }
  ctx.globalCompositeOperation = 'source-over';
}

export function createFog(scene: SceneHandle, map: MapDef): FogHandle {
  const core = sceneCore(scene);
  const scale = RES / map.side;

  const [visNow, vctx] = makeCanvas();
  const [explored, ectx] = makeCanvas();
  const [mask, mctx] = makeCanvas();
  const [hard, hctx] = makeCanvas();
  // boot state: everything unexplored (feathered so the overlay planes never
  // show a straight edge at the map bounds before the first snapshot)
  mctx.fillStyle = APAL.shroud;
  mctx.fillRect(0, 0, RES, RES);
  hctx.fillStyle = APAL.shroud;
  hctx.fillRect(0, 0, RES, RES);
  featherBounds(mctx);
  featherBounds(hctx);
  let visData: ImageData = vctx.getImageData(0, 0, RES, RES);

  // ---- world overlay planes ----------------------------------------------------
  const maskTex = new THREE.CanvasTexture(mask);
  maskTex.colorSpace = THREE.SRGBColorSpace;
  const hardTex = new THREE.CanvasTexture(hard);
  hardTex.colorSpace = THREE.SRGBColorSpace;

  const mkPlane = (tex: THREE.CanvasTexture, y: number, order: number): THREE.Mesh => {
    const m = new THREE.MeshLambertMaterial({
      color: APAL.inkDeep, // lit contribution ≈ black; emissive carries it
      emissive: APAL.shroud,
      map: tex,
      transparent: true,
      depthWrite: false,
      fog: false,
      flatShading: true,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(map.side, map.side), m);
    plane.geometry.rotateX(-Math.PI / 2);
    plane.position.set(map.side / 2, y, map.side / 2);
    plane.renderOrder = order;
    return plane;
  };
  core.three.add(mkPlane(maskTex, LOW_Y, 60));
  core.three.add(mkPlane(hardTex, HIGH_Y, 61));

  function update(snap: SnapMsg): void {
    // this update's visible discs, soft radial edges
    vctx.clearRect(0, 0, RES, RES);
    for (const e of snap.ents) {
      const r = VISION[e.k];
      if (r <= 0 || e.hp <= 0) continue;
      const px = e.x * scale;
      const py = e.z * scale;
      const pr = r * scale;
      const grad = vctx.createRadialGradient(px, py, 0, px, py, pr);
      grad.addColorStop(0, rgbaOf(APAL.paper, 1));
      grad.addColorStop(0.65, rgbaOf(APAL.paper, 1));
      grad.addColorStop(1, rgbaOf(APAL.paper, 0));
      vctx.fillStyle = grad;
      vctx.beginPath();
      vctx.arc(px, py, pr, 0, Math.PI * 2);
      vctx.fill();
    }
    // persistent explored memory (max-blend accumulation)
    ectx.globalCompositeOperation = 'lighten';
    ectx.drawImage(visNow, 0, 0);
    ectx.globalCompositeOperation = 'source-over';

    // shared mask: shroud, punched to DIM_ALPHA by explored, to 0 by visible
    mctx.globalCompositeOperation = 'source-over';
    mctx.globalAlpha = 1;
    mctx.fillStyle = APAL.shroud;
    mctx.fillRect(0, 0, RES, RES);
    mctx.globalCompositeOperation = 'destination-out';
    mctx.globalAlpha = 1 - DIM_ALPHA;
    mctx.drawImage(explored, 0, 0);
    mctx.globalAlpha = 1;
    mctx.drawImage(visNow, 0, 0);
    mctx.globalCompositeOperation = 'source-over';
    featherBounds(mctx);

    // hard shroud: opaque only where never explored
    hctx.globalCompositeOperation = 'source-over';
    hctx.globalAlpha = 1;
    hctx.fillStyle = APAL.shroud;
    hctx.fillRect(0, 0, RES, RES);
    hctx.globalCompositeOperation = 'destination-out';
    hctx.drawImage(explored, 0, 0);
    hctx.globalCompositeOperation = 'source-over';
    featherBounds(hctx);

    visData = vctx.getImageData(0, 0, RES, RES);
    maskTex.needsUpdate = true;
    hardTex.needsUpdate = true;
  }

  function isVisible(x: number, z: number): boolean {
    const px = Math.max(0, Math.min(RES - 1, Math.floor(x * scale)));
    const py = Math.max(0, Math.min(RES - 1, Math.floor(z * scale)));
    return (visData.data[(py * RES + px) * 4 + 3] ?? 0) > 40;
  }

  return { maskCanvas: mask, update, isVisible };
}
