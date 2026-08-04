// ============================================================================
// ANCIENTS (rift) — SCENE (CONTRACT §6 render/scene.ts). One WebGLRenderer:
// NeutralToneMapping, sRGB out, antialias, PCFSoftShadowMap 2048,
// pixelRatio <= 2. Hemisphere light (cool sky / warm ground) + one shadow-
// casting directional sun whose ortho frustum is fitted to the map bounds in
// fitMap(). FogExp2 sits exactly on APAL.fog (sky law S2: fog IS the horizon
// stop). The sky is a BANDED dome — 3 flat bands skyHigh -> horizon, no
// vertex colors, no custom shader.
//
// MATERIAL MODEL (binding): the ONLY world material is a flat-shaded
// MeshLambertMaterial minted by the cached mat() factory below — no PBR, no
// post-processing, no TextureLoader, no image assets. The two deliberate
// exceptions, both still MeshLambertMaterial:
//   1. the shared vertex-paint material (palette hexes baked into a color
//      attribute — kart trackMesh.ts precedent) so a whole unit merges into
//      ONE draw call incl. team trim;
//   2. emissive-locked Lambert for the sky bands / fog overlay planes, where
//      the palette hex must render EXACTLY (an unlit read), never lit.
// Generated CanvasTexture is used ONLY for the fog-of-war overlay (and the
// minimap reads the same canvas) — the rift §0 amendment.
//
// This module also owns the SceneCore seam: the internal surface the other
// T7 render modules (mapMesh/units/fog/fx) reach through, since the frozen
// create-function signatures pass only the SceneHandle.
// ============================================================================
import * as THREE from 'three';
import { APAL } from '@rift/shared';
import type { MapDef } from '@rift/shared';
import { mix } from '@platform/shared';
import type { SceneHandle } from '../contract.js';

/** Fixed-angle MOBA camera (CONTRACT §6 input.ts: pitch ~55deg, yaw fixed). */
export const CAMERA_PITCH_DEG = 55;
const CAMERA_PITCH = THREE.MathUtils.degToRad(CAMERA_PITCH_DEG);
const CAMERA_FOV = 50;
const SUN_MAP_SIZE = 2048;
const MAX_PIXEL_RATIO = 2;
const FOG_DENSITY = 0.003;
/** Sun direction (dusk, low, desaturated gold) — elevation/azimuth in degrees. */
const SUN_ELEVATION_DEG = 38;
const SUN_AZIMUTH_DEG = 225;

// ---- cached material factory (the ONE material source for the rift client) ---
const matCache = new Map<string, THREE.MeshLambertMaterial>();

/**
 * Shared, cached flat-shaded Lambert. hex MUST be an APAL entry or a
 * mix()/composite() of APAL entries — an ad-hoc literal here is a palette
 * violation and there is no second material path to hide it in. Keyed by hex:
 * one colour is exactly one draw-call bucket.
 */
function matFactory(hex: string): THREE.MeshLambertMaterial {
  let m = matCache.get(hex);
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color: hex,
      flatShading: true, // the flat-shaded look — do not remove
    });
    matCache.set(hex, m);
  }
  return m;
}

/** The shared vertex-paint material: palette hexes baked into geometry color
 *  attributes render through this single Lambert, so a merged unit (body +
 *  team trim + accent) is ONE draw call. */
let sharedVertexMat: THREE.MeshLambertMaterial | null = null;
function vertexMatFactory(): THREE.MeshLambertMaterial {
  if (!sharedVertexMat) {
    sharedVertexMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
    });
  }
  return sharedVertexMat;
}

/** Bake a palette hex into a geometry color attribute (linearised by
 *  THREE.Color under default ColorManagement). Returns the same geometry. */
export function paintGeo(geom: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = geom.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geom;
}

/** Emissive-locked Lambert: renders `hex` exactly (unlit read) while staying
 *  inside the Lambert-only material law. Used for the sky bands and the fog
 *  overlay planes, where scene light must not shift the palette value. */
function emissiveMat(hex: string, fog: boolean): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    color: APAL.inkDeep, // lit contribution ≈ black; emissive carries the read
    emissive: hex,
    flatShading: true,
    fog,
    side: THREE.BackSide,
  });
}

// ---- SceneCore: the internal seam shared with the other T7 render modules ----
export interface SceneCore {
  readonly three: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Absolutely-positioned DOM layer over the canvas (fx damage numbers). */
  readonly overlay: HTMLElement;
  /** Map side length; valid after fitMap (defaults to a 3-lane map). */
  mapSide(): number;
  mat(hex: string): THREE.MeshLambertMaterial;
  vertexMat(): THREE.MeshLambertMaterial;
  /** Per-render-frame hook (animated carve-out parts, marker pings). */
  addFrameHook(fn: (dtMs: number) => void): void;
  /** Fit the sun shadow frustum + sky dome to the map bounds. */
  fitMap(map: MapDef): void;
  /** Camera shake offset in world metres, applied around the camera target. */
  setShake(x: number, z: number): void;
  /** Register/unregister a mesh as pickable (userData.entId, -1 = not). */
  registerPick(mesh: THREE.Object3D): void;
  unregisterPick(mesh: THREE.Object3D): void;
  /** Project a world point to overlay pixel coordinates. */
  worldToScreen(x: number, y: number, z: number, out: { x: number; y: number }): boolean;
}

interface SceneHandleInternal extends SceneHandle {
  readonly core: SceneCore;
}

/** Recover the internal core from a SceneHandle produced by createScene. */
export function sceneCore(scene: SceneHandle): SceneCore {
  return (scene as SceneHandleInternal).core;
}

/** Normal toward the camera from any map point (fixed yaw+pitch): bars and
 *  markers tilt to face it. */
export function cameraNormalY(): number {
  return Math.sin(CAMERA_PITCH);
}
export function cameraNormalZ(): number {
  return -Math.cos(CAMERA_PITCH);
}

// ---- createScene ----------------------------------------------------------------
export function createScene(parent: HTMLElement): SceneHandle {
  if (getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    // §10: WebGL failure -> a readable error div, never a white screen.
    const div = document.createElement('div');
    div.className = 'error-banner';
    div.textContent = 'ANCIENTS needs WebGL, which this browser refused to provide.';
    parent.appendChild(div);
    throw err instanceof Error ? err : new Error(String(err));
  }
  // Round-4 art-judge amendment (recorded per §11): ACESFilmic was swapped for
  // NeutralToneMapping. ACES compresses mid-tones and shifts hue, so sun-lit
  // moss measured ~#141a10 (L*≈8) against palette #2e3827 (L*≈22) no matter
  // how high the exposure went — the dark end never recovered. Khronos Neutral
  // is near-identity through the dark/mid range, so palette values survive to
  // the framebuffer; the exposure below is calibrated so sun-lit moss measures
  // within ±10 L* of palette moss on the live-hud capture.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 2.75; // dusk, never moonless-night: calibrated so sun-lit moss measures ~palette L* and the 0.55 fog dim still clears 8 L* over the shroud (measured on live-hud/fog-edge captures)
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const canvas = renderer.domElement;
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  parent.appendChild(canvas);

  const overlay = document.createElement('div');
  overlay.style.position = 'absolute';
  overlay.style.inset = '0';
  overlay.style.pointerEvents = 'none';
  overlay.style.overflow = 'hidden';
  parent.appendChild(overlay);

  const three = new THREE.Scene();
  three.background = new THREE.Color(APAL.fog);
  three.fog = new THREE.FogExp2(APAL.fog, FOG_DENSITY);

  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.5, 1400);

  // Cool sky over warm ground bounce — dusk, but bright enough that moss
  // reads at its palette value at gameplay zoom (the ladder laws assume it).
  // Skewed toward azureLit on purpose: Neutral tone mapping's desaturation
  // offset crushes the blue channel of dark albedos, so the sky fill carries
  // extra blue to hold moss at its grey-green palette hue.
  const hemi = new THREE.HemisphereLight(
    mix(APAL.horizon, APAL.azureLit, 0.62),
    mix(APAL.trunk, APAL.ember, 0.35),
    2.45,
  );
  three.add(hemi);

  // Sun cooled toward desaturated goldLit so monument stone stays grey-stone
  // (a saturated warm sun reads brown on the monument tier).
  const sun = new THREE.DirectionalLight(mix(APAL.goldLit, APAL.paper, 0.35), 3.15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SUN_MAP_SIZE, SUN_MAP_SIZE);
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.03;
  three.add(sun);
  three.add(sun.target);

  // ---- banded sky dome: 3 flat bands skyHigh -> horizon ---------------------
  const dome = new THREE.Group();
  {
    const bands: readonly [number, number, string][] = [
      [0.0, 0.6, APAL.skyHigh],
      [0.6, 1.15, mix(APAL.skyHigh, APAL.horizon, 0.5)],
      [1.15, 1.68, APAL.horizon],
    ];
    for (const [t0, t1, hex] of bands) {
      const g = new THREE.SphereGeometry(1, 48, 4, 0, Math.PI * 2, t0, t1 - t0);
      const m = new THREE.Mesh(g, emissiveMat(hex, false));
      dome.add(m);
    }
  }
  three.add(dome);

  // ---- mutable scene state ---------------------------------------------------
  let mapSide = 128;
  let targetX = mapSide / 2;
  let targetZ = mapSide / 2;
  let camHeight = 40;
  let shakeX = 0;
  let shakeZ = 0;
  const frameHooks: ((dtMs: number) => void)[] = [];
  const pickMeshes: THREE.Object3D[] = [];
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const projTmp = new THREE.Vector3();
  let renderWarned = false;

  function applyCamera(): void {
    const back = camHeight / Math.tan(CAMERA_PITCH);
    camera.position.set(targetX + shakeX, camHeight, targetZ - back + shakeZ);
    camera.lookAt(targetX + shakeX, 0, targetZ + shakeZ);
  }

  const core: SceneCore = {
    three,
    camera,
    overlay,
    mapSide: () => mapSide,
    mat: matFactory,
    vertexMat: vertexMatFactory,
    addFrameHook(fn) {
      frameHooks.push(fn);
    },
    fitMap(map) {
      mapSide = map.side;
      const cx = map.side / 2;
      const cz = map.side / 2;
      // Sun shadow frustum fitted to the map bounds (ortho box covers the
      // whole square from the sun's raking angle, plus margin).
      const el = THREE.MathUtils.degToRad(SUN_ELEVATION_DEG);
      const az = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
      const dist = map.side * 1.5;
      sun.position.set(
        cx + Math.cos(el) * Math.cos(az) * dist,
        Math.sin(el) * dist,
        cz + Math.cos(el) * Math.sin(az) * dist,
      );
      sun.target.position.set(cx, 0, cz);
      const extent = map.side * 0.72 + 8;
      const sc = sun.shadow.camera;
      sc.left = -extent;
      sc.right = extent;
      sc.top = extent;
      sc.bottom = -extent;
      sc.near = 1;
      sc.far = dist * 2.5;
      sc.updateProjectionMatrix();
      // Sky dome wraps the map; the camera never leaves it at legal zooms.
      const radius = Math.max(280, map.side * 2.6);
      dome.position.set(cx, 0, cz);
      dome.scale.setScalar(radius);
    },
    setShake(x, z) {
      shakeX = x;
      shakeZ = z;
    },
    registerPick(mesh) {
      pickMeshes.push(mesh);
    },
    unregisterPick(mesh) {
      const i = pickMeshes.indexOf(mesh);
      if (i >= 0) pickMeshes.splice(i, 1);
    },
    worldToScreen(x, y, z, out) {
      projTmp.set(x, y, z).project(camera);
      if (projTmp.z < -1 || projTmp.z > 1) return false;
      out.x = (projTmp.x * 0.5 + 0.5) * canvas.clientWidth;
      out.y = (-projTmp.y * 0.5 + 0.5) * canvas.clientHeight;
      return true;
    },
  };

  function resize(): void {
    const w = parent.clientWidth || 1;
    const h = parent.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  applyCamera();

  const handle: SceneHandleInternal = {
    core,
    canvas,
    setCamera(x, z, height) {
      targetX = x;
      targetZ = z;
      camHeight = height;
      applyCamera();
    },
    screenToGround(sx, sy, out) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      ndc.set(((sx - rect.left) / rect.width) * 2 - 1, -((sy - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const ray = raycaster.ray;
      if (ray.direction.y > -1e-6) return false; // parallel or pointing at sky
      const t = -ray.origin.y / ray.direction.y;
      if (t <= 0) return false;
      out.x = ray.origin.x + ray.direction.x * t;
      out.z = ray.origin.z + ray.direction.z * t;
      return out.x >= 0 && out.x <= mapSide && out.z >= 0 && out.z <= mapSide;
    },
    pickUnit(sx, sy) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return -1;
      ndc.set(((sx - rect.left) / rect.width) * 2 - 1, -((sy - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(pickMeshes, false);
      for (const hit of hits) {
        const id = hit.object.userData['entId'] as number | undefined;
        if (id !== undefined && id >= 0) return id;
      }
      return -1;
    },
    resize,
    render(dtMs) {
      for (const fn of frameHooks) fn(dtMs);
      applyCamera(); // shake offsets may move every frame
      try {
        renderer.render(three, camera);
      } catch (err) {
        // §10: one render exception must never white-screen the loop.
        if (!renderWarned) {
          renderWarned = true;
          console.error('rift render failed', err);
        }
      }
    },
    drawCalls() {
      return renderer.info.render.calls;
    },
  };
  return handle;
}
