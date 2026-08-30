// ============================================================================
// ACES render3d/scene — WebGL shell + chase-cam rig (GRAPHICS_3D.md §1–§5).
//
// Owns THE renderer (antialias, PCFSoft shadow map, DPR cap 2), the
// atmosphere, and the C_APP camera rig per §2. Coordinate law (§1): scene
// X = map x, Z = map y, Y = altitude; heading h (0 = +x east, clockwise-
// positive) renders as yaw −h on models authored facing +X; the forward
// vector is (cos h, 0, sin h) — velocity maps identically (vx→VX, vy→VZ).
// The pure helpers below ARE that law in code; scene.test.ts pins them
// headlessly and the rig itself drives nothing else.
//
// Camera law (§2, integrator-corrected): forward comes FROM HEADING ONLY —
// model faces +X under yaw −h ⇒ scene forward = (cos h, 0, sin h) — never
// from velocity magnitude or direction. Position eases toward plane −
// forward·CAM_DIST·zoomMult + UP·CAM_HEIGHT while looking at plane +
// forward·(|vel|·LOOKAHEAD_S) + UP·LOOK_LIFT (idle frames keep looking along
// the nose instead of drifting with velocity noise), with k =
// 1 − exp(−8·dt). The whole pose is the exported PURE camPoseFor() below;
// the rig merely eases toward it. The gimbal stays LEVEL: it carries only a
// slight roll lag
// (roll = bankZ·0.25, eased) plus a speed FOV (55→62 over the fleet speed
// band). shake(m) accumulates impulse magnitude that decays exp(−7·dt) into
// deterministic two-sine positional jitter applied POST-ease in render().
// After own death orbitDeath(t) holds the last focus and slow-orbits the
// wreck until follow() resumes.
//
// Atmosphere (§3): HemisphereLight(dawnHi, seaDark, 0.9) fill + one warm low
// western DirectionalLight(sunGlare) whose ~700u ortho shadow box follows the
// rig look point each frame, snapped to a 4u grid to stop texel swim; sky =
// scene.background CanvasTexture vertical gradient whose horizon stop EQUALS
// the FogExp2 colour so terrain melts into sky with no hard horizon line.
//
// DEVIATIONS (reported to the orchestrator):
//  · shared/config.ts CAMERA carries LOOKAHEAD_S but not CAM_DIST/CAM_HEIGHT,
//    and no PLANE_Y exists anywhere in shared — all three are pinned here at
//    the GRAPHICS_3D.md values (12 / 24 / 10) until config is amended. No
//    other number was invented: every tunable cites §1–§3 or mirrors an
//    existing 2D-module constant.
//  · §2's prose "LOOKAHEAD vector vel*0.35" conflicts with frozen config
//    CAMERA.LOOKAHEAD_S = 0.26 s; the FROZEN Layer-1 constant wins.
//  · Sky uses scene.background = baked gradient texture (the §3-sanctioned
//    "canvas texture" form) rather than an inverted dome: any dome material
//    needs map/side/fog parameters the frozen materials factory does not
//    expose, and factory law forbids constructing THREE materials outside
//    render3d/materials.ts.
//  · pitchX is accepted per the frozen signature but intentionally unused by
//    the camera — the gimbal law keeps the rig level ("slight roll lag"
//    only); pitch belongs to planeModels (W2). bankZ drives the roll lag.
// ============================================================================

import * as THREE from 'three';
import { CAMERA, CLASSES, WORLD } from '@aces/shared/config.js';
import type { ScreenPoint } from '../contract/seams.js';
import { PAL, mixA, shadeA } from '../contract/visual.js';

// ---- contract-pinned numbers (see header deviations) ------------------------

/** §1 cruise altitude, u — planes bob around this; the rig focuses here. */
export const PLANE_Y = 12;
/** §2 chase distance behind the plane, u (scaled by setZoomMult). */
export const CAM_DIST = 24;
/** §2 chase height above the plane, u. */
export const CAM_HEIGHT = 10;
/** Chase look-point lift above cruise altitude, u — keeps framing stable
 *  when |vel|≈0 collapses the lookahead onto the plane itself. */
export const LOOK_LIFT = 1.5;

// ---- feel constants (each cites its law; nothing ad-hoc) --------------------

const EASE_RATE = 8; //        §2 exponential approach k ≈ 1 − exp(−8·dt)
const ROLL_LAG = 0.25; //      brief: camera roll = bankZ·0.25
const ROLL_RATE = 6; //        roll-lag approach rate /s
const FOV_MIN = 55; //         §4 PerspectiveCamera(55)
const FOV_GAIN = 7; //         §2 FOV eases 55→62 with speedFrac
const FOV_RATE = 3; //         FOV approach rate /s
const SHAKE_DECAY = 7; //      brief: amp *= exp(−7·dt)
const SHAKE_CAP = 27.5; //     SHAKE.LARGE·1.25 — the 2D app's ceiling, carried
const SHAKE_CUTOFF = 0.05; //  2D app cutoff, carried over
const SHAKE_FQ_A = 37.7; //    incommensurate sines — the 2D app's jitter feel,
const SHAKE_FQ_B = 29.3; //    deterministic (no Math.random), carried over
const SHAKE_FQ_C = 41.9;
const SHAKE_Y_BIAS = 0.83; //  vertical component softer, as in 2D
const SHAKE_GAIN = 0.25; //    2D map-frame (~1600u wide) → chase-frame
                              //  (~400u wide) proportionality for the same
                              //  on-screen kick from the same SHAKE constants
const ZOOM_MIN = 0.5; //       setZoomMult clamp (§2 zoomTo pin)
const ZOOM_MAX = 6;

const FOG_DENSITY = 0.0011; // §3 FogExp2
const HEMI_INTENSITY = 0.9; // §3 HemisphereLight(..., ~0.9)
const SUN_INTENSITY = 1.25; // warm key riding over the hemi fill
const SUN_DISTANCE = 900; //   light throw along SUN_DIR from the snapped focus
const SHADOW_EXTENT = 350; //  brief: ~700u ortho frustum half-size
const SHADOW_MAP = 1024; //    §3 castShadow 1024 map
const SHADOW_SNAP = 4; //      brief: snap focus to a 4u grid vs texel swim
const SHADOW_NEAR = 60;
const SHADOW_FAR = 2600;
const SHADOW_BIAS = -0.00035;
const SHADOW_NORMAL_BIAS = 1.5;

/** Sun from WEST, ~35° elevation (asin(0.56/|v|) ≈ 34°), still nudged north
 *  of west so shadows fall east-south per the world brief. Raised off the old
 *  21° pin: at cruise altitude a 21° sun threw plane shadows ~31u away — out
 *  of the read in every play frame — while ~35° lands them ~17u off the
 *  airframe, visibly beneath/behind it, keeping the warm western light.
 *  Never moves (STYLE_BIBLE §3). */
const SUN_DIR = new THREE.Vector3(-0.8, 0.56, -0.22).normalize();

const ORBIT_RATE = 0.4; //     death orbit, rad/s — "slow orbit around wreck"
const ORBIT_RADIUS = 30; //    just outside CAM_DIST so the wreck stays framed
const ORBIT_HEIGHT = 14;
const ORBIT_ROLL_DECAY = 0.08; // per-call decay toward level during orbit

// ---------------------------------------------------------------------------
// Pure helpers — the shipped coordinate/easing math, exported for the
// headless unit gates (scene.test.ts) and for HUD-side sanity math.
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Wrap an angle into (−π, π]. */
export function wrapPi(a: number): number {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}

/**
 * §1 mapping: server ground coords → scene XZ. X = x and Z = y IDENTICALLY
 * (velocity maps the same way); altitude rides Y separately (default cruise).
 */
export function worldToScene(
  x: number,
  y: number,
  alt: number = PLANE_Y,
): { x: number; y: number; z: number } {
  return { x, y: alt, z: y };
}

/**
 * §1 yaw law: rotation.y = −h (clockwise map-turn = negative yaw). Wrapped
 * into (−π, π] so eased rotations always take the short way round.
 */
export function yawOf(h: number): number {
  // `+ 0` normalises −0 → +0 so strict equality tests read naturally.
  return wrapPi(-h) + 0;
}

/**
 * Forward unit vector for heading h in scene XZ: h = 0 faces +X (east);
 * clockwise-positive means h = π/2 faces +Z (map +y). Composes EXACTLY with
 * yawOf: a model authored facing +X rotated by yawOf(h) points along this.
 */
export function forwardXZ(h: number): { x: number; z: number } {
  return { x: Math.cos(h), z: Math.sin(h) };
}

/** Chase-cam pose snapshot — camera position + look target in scene space. */
export interface CamPose {
  camX: number;
  camY: number;
  camZ: number;
  lookX: number;
  lookY: number;
  lookZ: number;
}

/**
 * THE chase-cam law as ONE pure function (§2, integrator-corrected). Forward
 * is derived FROM HEADING ONLY (model faces +X under yaw −h ⇒ scene forward
 * = (cos h, 0, sin h)) — never from velocity magnitude or direction. Camera
 * = plane − forward·CAM_DIST·zoomMult + UP·CAM_HEIGHT; look =
 * plane + forward·(|vel|·LOOKAHEAD_S) + UP·LOOK_LIFT, so idle frames (|vel|
 * ≈0) keep looking ALONG THE NOSE instead of drifting with velocity noise.
 * zoomMult scales CHASE DISTANCE ONLY (re-clamped 0.5–6). Pass `out` to
 * reuse a pose record — the per-frame rig path allocates nothing.
 */
export function camPoseFor(
  pos: { x: number; y: number },
  h: number,
  vel: { x: number; y: number },
  zoomMult: number,
  out?: CamPose,
): CamPose {
  const fx = Math.cos(h);
  const fz = Math.sin(h);
  const dist = CAM_DIST * clampZoom(zoomMult);
  const ahead = Math.hypot(vel.x, vel.y) * CAMERA.LOOKAHEAD_S;
  const p = out ?? { camX: 0, camY: 0, camZ: 0, lookX: 0, lookY: 0, lookZ: 0 };
  p.camX = pos.x - fx * dist;
  p.camY = PLANE_Y + CAM_HEIGHT;
  p.camZ = pos.y - fz * dist;
  p.lookX = pos.x + fx * ahead;
  p.lookY = PLANE_Y + LOOK_LIFT;
  p.lookZ = pos.y + fz * ahead;
  return p;
}

/** Frame-rate-independent exponential-approach factor for rate/s. */
export function easeFactor(dt: number, rate: number): number {
  return dt <= 0 ? 0 : 1 - Math.exp(-rate * dt);
}

/** Shake envelope decay: amp *= exp(−7·dt) — the brief's "existing feel". */
export function shakeDecay(amp: number, dt: number): number {
  return amp > 0 ? amp * Math.exp(-SHAKE_DECAY * Math.max(dt, 0)) : 0;
}

/** zoomTo pin clamp (§2): 0.5–6, 1 = default chase distance. */
export function clampZoom(z: number): number {
  return z < ZOOM_MIN ? ZOOM_MIN : z > ZOOM_MAX ? ZOOM_MAX : z;
}

/**
 * Speed fraction over the fleet band [gunship.speedMin .. scout.speedMax]
 * (both frozen CLASSES values — no invented reference speed), driving the
 * §2 FOV ease.
 */
export function speedFrac(speed: number): number {
  const lo = CLASSES.gunship.speedMin;
  const hi = CLASSES.scout.speedMax;
  return clamp01((speed - lo) / (hi - lo));
}

/** §2: FOV eases 55→62 with speedFrac. */
export function fovFor(frac: number): number {
  return FOV_MIN + FOV_GAIN * clamp01(frac);
}

/** §2: the camera stays level except a slight roll lag of bankZ·0.25. */
export function rollFromBank(bankZ: number): number {
  return bankZ * ROLL_LAG;
}

/** World-space snap used by the sun's shadow box (texel-swim guard). */
export function snapToGrid(v: number, grid: number = SHADOW_SNAP): number {
  return Math.round(v / grid) * grid;
}

/** Sun shadow-box placement for one rig focus point (scene XZ). */
export interface ShadowPose {
  px: number;
  py: number;
  pz: number;
  tx: number;
  ty: number;
  tz: number;
}

/**
 * THE shadow-frustum law as ONE pure function: the ~700u ortho box tracks the
 * rig focus (snapped to the 4u texel-swim grid), with the sun parked
 * SUN_DISTANCE away along SUN_DIR so the light never moves relative to the
 * focus. Exported for the headless gates; the rig feeds it the eased look
 * point each frame via an out-param (zero allocation).
 */
export function shadowFrustumFor(focusX: number, focusZ: number, out?: ShadowPose): ShadowPose {
  const sx = snapToGrid(focusX);
  const sz = snapToGrid(focusZ);
  const p = out ?? { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 };
  p.px = sx + SUN_DIR.x * SUN_DISTANCE;
  p.py = SUN_DIR.y * SUN_DISTANCE;
  p.pz = sz + SUN_DIR.z * SUN_DISTANCE;
  p.tx = sx;
  p.ty = 0;
  p.tz = sz;
  return p;
}

// ---------------------------------------------------------------------------
// Sky backdrop — the sanctioned sky-band exception (GRAPHICS_3D §3): one
// CanvasTexture vertical gradient, dawnHi top → fog-coloured horizon, painted
// as HARD-ish stops (STYLE_BIBLE §2: "3–4 hard-ish stops, not smooth ramps").
// The gimbal stays LEVEL by law, so the 3D horizon sits at screen-middle —
// the gradient reaches the FogExp2 colour at v≈0.52 and HOLDS it below, so
// fogged terrain meets the backdrop with no seam. Above that, three wide
// translucent dawnLo/haze strips band the wash into readable dawn strata.
// ---------------------------------------------------------------------------

function buildSkyTexture(horizonHex: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 256;
  const g = c.getContext('2d');
  if (!g) throw new Error('aces/scene: 2D context unavailable for sky bake');
  const horizon = new THREE.Color(horizonHex); // == mixA('haze','dawnLo',0.5)
  const hi = new THREE.Color(PAL.dawnHi);
  const midA = '#' + hi.clone().lerp(horizon, 0.35).getHexString();
  const stops: ReadonlyArray<readonly [number, string]> = [
    [0, '#' + hi.getHexString()],
    [0.3, midA],
    [0.52, '#' + horizon.getHexString()], // reached AT the visible 3D horizon
    [1, '#' + horizon.getHexString()], //  …and held (never visible below it)
  ];
  let y0 = 0;
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i] as readonly [number, string];
    const next = stops[i + 1] as readonly [number, string] | undefined;
    const y1 = next ? Math.round(next[0] * c.height) : c.height;
    g.fillStyle = stop[1];
    g.fillRect(0, y0, c.width, y1 - y0);
    y0 = y1;
  }
  // Sky value ladder (F3): ONE subtle darker blue-gray band high in the dome
  // gives the top a first rung, and three wide translucent dawnLo/haze strips
  // (+0.08 alpha each over A3) deepen the horizon rungs — the uniform cream
  // wash reads as a top→horizon ladder instead of a two-stop wash, without
  // breaking the horizon melt (all bands stay above the fog-matched stop).
  const strips: ReadonlyArray<readonly [number, number, string, number]> = [
    [0.08, 0.24, shadeA('seaDark', 0.55), 0.1], // high-dome blue-gray rung (F3)
    [0.545, 0.6, PAL.dawnLo, 0.46],
    [0.635, 0.71, PAL.haze, 0.38],
    [0.76, 0.86, PAL.dawnLo, 0.28],
  ];
  for (const s of strips) {
    const [a, b, hex, alpha] = s as readonly [number, number, string, number];
    g.globalAlpha = alpha;
    g.fillStyle = hex;
    g.fillRect(0, Math.round(a * c.height), c.width, Math.round((b - a) * c.height));
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Public surface (frozen, GRAPHICS_3D §4)
// ---------------------------------------------------------------------------

export interface AcesRig {
  follow(
    pos: { x: number; y: number },
    vel: { x: number; y: number },
    heading: number,
    bankZ: number,
    pitchX: number,
    dt: number,
  ): void;
  /** Slow orbit around the last focus after own death; t = absolute time. */
  orbitDeath(t: number): void;
  /** Add impulse magnitude (u); decays exp(−7·dt) into post-ease jitter. */
  shake(m: number): void;
  /**
   * Project server-world coords (wz defaults to cruise altitude) through the
   * live camera into CSS pixels. RETURNS A SHARED SCRATCH RECORD — consume
   * immediately (HUD pattern: read fields, never stash the object).
   */
  project(wx: number, wy: number, wz?: number): ScreenPoint;
  getCam(): THREE.PerspectiveCamera;
  /** Module extension (brief-sanctioned): the __ACES.zoomTo pin, clamped 0.5–6. */
  setZoomMult(z: number): void;
}

export interface AcesScene {
  renderer: THREE.WebGLRenderer;
  setViewport(wCss: number, hCss: number): void; // DPR capped at 2 internally
  render(dtS: number, tS: number): void;
  rig: AcesRig;
  setQuality(level: 'high' | 'low'): void; // low: DPR→1, shadows off
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Rig implementation
// ---------------------------------------------------------------------------

class RigImpl implements AcesRig {
  constructor(private readonly host: AcesSceneImpl) {}

  follow(
    pos: { x: number; y: number },
    vel: { x: number; y: number },
    heading: number,
    bankZ: number,
    pitchX: number,
    dt: number,
  ): void {
    void pitchX; // see header deviation: gimbal stays level by law
    this.host.follow(pos, vel, heading, bankZ, dt);
  }

  orbitDeath(t: number): void {
    this.host.orbitDeath(t);
  }

  shake(m: number): void {
    this.host.shake(m);
  }

  project(wx: number, wy: number, wz?: number): ScreenPoint {
    return this.host.project(wx, wy, wz);
  }

  getCam(): THREE.PerspectiveCamera {
    return this.host.getCam();
  }

  setZoomMult(z: number): void {
    this.host.setZoomMult(z);
  }
}

// ---------------------------------------------------------------------------
// Scene implementation
// ---------------------------------------------------------------------------

class AcesSceneImpl implements AcesScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly rig: AcesRig;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV_MIN, 16 / 9, 0.5, 6000);
  private readonly sun: THREE.DirectionalLight;
  private readonly skyTex: THREE.CanvasTexture;

  private cssW = 1280;
  private cssH = 720;
  private quality: 'high' | 'low' = 'high';

  // Rig feel state — written by follow()/orbitDeath(), consumed by render().
  // Initialised to the map centre so a death before first spawn still orbits.
  private readonly posEased = new THREE.Vector3(WORLD.W / 2, PLANE_Y + CAM_HEIGHT, WORLD.H / 2);
  private readonly lookEased = new THREE.Vector3(WORLD.W / 2, PLANE_Y, WORLD.H / 2);
  private readonly lastFocus = new THREE.Vector3(WORLD.W / 2, PLANE_Y, WORLD.H / 2);
  private roll = 0;
  private fovCur = FOV_MIN;
  private shakeAmp = 0;
  private zoomMult = 1;
  private camReady = false;

  // Scratch — zero-per-frame-allocation law (STYLE_BIBLE §9).
  private readonly planeScratch = new THREE.Vector3();
  private readonly poseScratch: CamPose = { camX: 0, camY: 0, camZ: 0, lookX: 0, lookY: 0, lookZ: 0 };
  private readonly desiredScratch = new THREE.Vector3();
  private readonly lookTgtScratch = new THREE.Vector3();
  private readonly pvScratch = new THREE.Vector3();
  private readonly screenScratch: ScreenPoint = { sx: 0, sy: 0, visible: false };
  private readonly shadowScratch: ShadowPose = { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // outputColorSpace intentionally left at three's default (BUILD LAW).

    const fogHex = mixA('haze', 'dawnLo', 0.5);
    this.scene.fog = new THREE.FogExp2(new THREE.Color(fogHex), FOG_DENSITY);
    this.skyTex = buildSkyTexture(fogHex);
    this.scene.background = this.skyTex;

    // Mount point for W-world: the app adds world.group via getCam().parent.
    this.scene.add(this.camera);

    // §3 fill: hemisphere dawnHi-over-seaDark at ~0.9.
    this.scene.add(new THREE.HemisphereLight(PAL.dawnHi, PAL.seaDark, HEMI_INTENSITY));

    // §3 key: warm low western sun, PCFSoft shadows, ~700u ortho box that
    // follows the rig look point (re-aimed every render() on a 4u grid).
    const sun = new THREE.DirectionalLight(PAL.sunGlare, SUN_INTENSITY);
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    const sc = sun.shadow.camera;
    sc.left = -SHADOW_EXTENT;
    sc.right = SHADOW_EXTENT;
    sc.top = SHADOW_EXTENT;
    sc.bottom = -SHADOW_EXTENT;
    sc.near = SHADOW_NEAR;
    sc.far = SHADOW_FAR;
    sc.updateProjectionMatrix();
    sun.shadow.bias = SHADOW_BIAS;
    sun.shadow.normalBias = SHADOW_NORMAL_BIAS;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    this.rig = new RigImpl(this);
    this.applyViewport();
  }

  // ---- rig internals -------------------------------------------------------

  follow(
    pos: { x: number; y: number },
    vel: { x: number; y: number },
    heading: number,
    bankZ: number,
    dt: number,
  ): void {
    const dtc = Math.max(0, Math.min(0.1, dt));
    this.planeScratch.set(pos.x, PLANE_Y, pos.y);
    this.lastFocus.copy(this.planeScratch);

    // THE pose law via the exported pure function (out-param → zero alloc):
    // forward FROM HEADING, chase behind it, lookahead ALONG it by true
    // speed. vel MUST be true velocity (app feeds vx/vy) — feeding position
    // here made the look point position-proportional and swung the gimbal
    // around the plane (nose toward lens on west headings).
    const pose = camPoseFor(pos, heading, vel, this.zoomMult, this.poseScratch);
    this.desiredScratch.set(pose.camX, pose.camY, pose.camZ);
    this.lookTgtScratch.set(pose.lookX, pose.lookY, pose.lookZ);

    if (!this.camReady) {
      this.camReady = true;
      this.posEased.copy(this.desiredScratch);
      this.lookEased.copy(this.lookTgtScratch);
      this.fovCur = fovFor(speedFrac(Math.hypot(vel.x, vel.y)));
    } else {
      const k = easeFactor(dtc, EASE_RATE);
      this.posEased.lerp(this.desiredScratch, k);
      this.lookEased.lerp(this.lookTgtScratch, k);
    }

    // Slight roll lag toward bankZ·0.25; everything else stays level.
    this.roll += (rollFromBank(bankZ) - this.roll) * easeFactor(dtc, ROLL_RATE);

    // §2 speed feel: FOV eases 55→62 with speedFrac.
    const fovT = fovFor(speedFrac(Math.hypot(vel.x, vel.y)));
    if (Math.abs(this.fovCur - fovT) > 0.01) {
      this.fovCur += (fovT - this.fovCur) * easeFactor(dtc, FOV_RATE);
      if (Math.abs(this.camera.fov - this.fovCur) > 0.01) {
        this.camera.fov = this.fovCur;
        this.camera.updateProjectionMatrix();
      }
    }
  }

  orbitDeath(t: number): void {
    const a = t * ORBIT_RATE;
    this.posEased.set(
      this.lastFocus.x + Math.sin(a) * ORBIT_RADIUS,
      ORBIT_HEIGHT,
      this.lastFocus.z + Math.cos(a) * ORBIT_RADIUS,
    );
    this.lookEased.copy(this.lastFocus);
    this.roll *= 1 - ORBIT_ROLL_DECAY;
  }

  shake(m: number): void {
    this.shakeAmp = Math.min(SHAKE_CAP, this.shakeAmp + m);
  }

  project(wx: number, wy: number, wz?: number): ScreenPoint {
    // §2 seam contract: SERVER-world coords in, optional ALTITUDE third.
    // Scene mapping per §1 law: X = wx · Z = wy · Y = wz ?? PLANE_Y. The
    // original implementation fed (wx, wy, wz) straight into the scene
    // vector — server-y became altitude and altitude became Z — so every
    // three-arg HUD projection (crosshair / lead pip) landed kilometres
    // off-screen while the two-arg edge arrows clamped garbage into view.
    this.pvScratch.set(wx, wz ?? PLANE_Y, wy);
    this.camera.updateMatrixWorld();
    this.pvScratch.project(this.camera);
    const s = this.screenScratch;
    s.sx = (this.pvScratch.x * 0.5 + 0.5) * this.cssW;
    s.sy = (-this.pvScratch.y * 0.5 + 0.5) * this.cssH;
    s.visible =
      this.pvScratch.z < 1 &&
      this.pvScratch.x >= -1 &&
      this.pvScratch.x <= 1 &&
      this.pvScratch.y >= -1 &&
      this.pvScratch.y <= 1;
    return s;
  }

  getCam(): THREE.PerspectiveCamera {
    return this.camera;
  }

  setZoomMult(z: number): void {
    this.zoomMult = clampZoom(z);
  }

  // ---- frame -----------------------------------------------------------------

  render(dtS: number, tS: number): void {
    const dt = Math.max(0, Math.min(0.1, dtS));
    this.shakeAmp = shakeDecay(this.shakeAmp, dt);
    if (this.shakeAmp < SHAKE_CUTOFF) this.shakeAmp = 0;

    // Shadow box follows the eased look point via THE pure law (snapped to
    // the 4u grid inside shadowFrustumFor — texel-swim guard).
    const sp = shadowFrustumFor(this.lookEased.x, this.lookEased.z, this.shadowScratch);
    this.sun.position.set(sp.px, sp.py, sp.pz);
    this.sun.target.position.set(sp.tx, sp.ty, sp.tz);
    this.sun.target.updateMatrixWorld();

    // Camera = eased pose + post-ease deterministic jitter.
    this.camera.position.copy(this.posEased);
    if (this.shakeAmp > 0) {
      const j = this.shakeAmp * SHAKE_GAIN;
      this.camera.position.x += Math.sin(tS * SHAKE_FQ_A) * j;
      this.camera.position.y += Math.cos(tS * SHAKE_FQ_B) * j * SHAKE_Y_BIAS;
      this.camera.position.z += Math.sin(tS * SHAKE_FQ_C + 1.7) * j;
    }
    this.camera.lookAt(this.lookEased);
    if (this.roll !== 0) this.camera.rotateZ(this.roll);

    this.renderer.render(this.scene, this.camera);
  }

  // ---- plumbing ----------------------------------------------------------------

  setViewport(wCss: number, hCss: number): void {
    this.cssW = wCss;
    this.cssH = hCss;
    this.applyViewport();
  }

  setQuality(level: 'high' | 'low'): void {
    this.quality = level;
    const want = level === 'high';
    if (this.renderer.shadowMap.enabled !== want) {
      this.renderer.shadowMap.enabled = want;
      // Toggling the shadow map invalidates every material program.
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) m.forEach((mm) => (mm.needsUpdate = true));
        else if (m) m.needsUpdate = true;
      });
    }
    this.applyViewport();
  }

  dispose(): void {
    this.skyTex.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }

  private applyViewport(): void {
    const dpr = this.quality === 'low' ? 1 : Math.min(2, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.cssW, this.cssH, false); // CSS size owned by app shell
    this.camera.aspect = this.cssW / this.cssH;
    this.camera.updateProjectionMatrix();
  }
}

/** Build THE ACES 3D scene on the app-owned canvas (GRAPHICS_3D §4). */
export function createScene(canvas: HTMLCanvasElement): AcesScene {
  return new AcesSceneImpl(canvas);
}
