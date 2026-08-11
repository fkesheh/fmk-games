// ============================================================================
// SKI SPLAT — SCENE SHELL + FIRST-PERSON CAMERA RIG (task R1, CONTRACT §7/§7a).
// One WebGLRenderer (ACESFilmic, sRGB out, PCFSoft shadows, DPR <= 2), a
// vertex-gradient sky dome (skyZenith -> skyHorizon — the ONE exempt unlit
// material), FogExp2 matched EXACTLY to skyHorizon so the world dissolves
// into the sky, a warm low morning sun whose shadow box follows the camera
// target, a hemisphere fill (morning-sky up / snow-bounce below), and the kart
// grade+vignette fullscreen post pass plus a plant-hit edge flash.
//
// The camera is FIRST PERSON, never third person: eye at (x, y+EYE_HEIGHT, z)
// looking along yaw, pitch following the terrain LOOK_AHEAD metres out so the
// horizon holds near the vertical third-line. Feel layers (all derived from
// the frozen setCamera input stream — deterministic, no Math.random):
//   * speed FOV: BASE_FOV + up to SPEED_FOV_MAX, applied past a small delta;
//   * carve roll: bank up to ~4° proportional to steer * v / MAX_SPEED, into
//     the turn (steer > 0 turns toward +x; rotateZ(+) leans the head toward
//     +x — see the note at rotateZ below);
//   * speed micro-shake: the kart formula, amplitude CAM_SHAKE_AMP, frequency
//     rising with speed;
//   * dip spring: plantHit() retriggered, kart landing-dip mechanism;
//   * teleport guard: a >12 m jump resets every camera derivative.
// V2 (R1v2, CONTRACT §11.4 + STYLE_BIBLE §V2.5): the sky carries a baked
// low-poly cloud layer (2 draw calls, fog:false, paper/snowShade) + a small
// warm sun disc on the SUN_DIR azimuth ringed by the dome glow, and the rig
// gains air feel — setAirborne() eases a FOV punch, a micro-shake fade and a
// ~-2° pitch bias while flying; land() retriggers the dip spring with a soft
// edge flash. Clouds + disc are camera-anchored (static for the session,
// never rebuilt with the terrain) and deterministic from fixed seeds.
// No per-frame allocation in setCamera/render — scratch vectors are fields.
// ============================================================================
import * as THREE from 'three';
import {
  BASE_FOV,
  CAM_SHAKE_AMP,
  EYE_HEIGHT,
  MAX_SPEED,
  SPEED_FOV_MAX,
  SPAL,
} from '@splat/shared';
import type { SlopeDef } from '@splat/shared';
import { mix, rng, rngRange } from '@platform/shared';
import { SUN_DIR, at, bake, sphere } from '../contract/visual.js';
import { buildTerrain } from './terrain.js';
import { buildGates } from './gates.js';

// ---- renderer / atmosphere -----------------------------------------------------
const EXPOSURE = 1.3; // tone-map lift — a BRIGHT winter morning, ACES stays
const FOG_DENSITY = 0.0045; // the finish fades in at ~150 m (STYLE_BIBLE)
const DOME_RADIUS = 620;
const CAM_FAR = 2400; // covers the horizon peak cards from anywhere on the run

// ---- lights ----------------------------------------------------------------------
const SUN_INTENSITY = 2.3; // the warm key carries the frame
const HEMI_INTENSITY = 0.8; // morning fill — shadows stay blue but BRIGHT blue
const SUN_DISTANCE = 120; // light sits at target + SUN_DIR x this
const SHADOW_EXTENT = 55; // ortho shadow box half-size, follows the camera
const SHADOW_MAP_SIZE = 2048;

// ---- post pass ----------------------------------------------------------------------
const GRADE_ALPHA = 0.07; // warm sunGold lift, weighted to the ground half
const VIGNETTE_ALPHA = 0.16; // cool ink corner darkening
const FLASH_S = 0.12; // plant-hit edge-flash decay (s)
const FLASH_PEAK = 0.5; // peak edge alpha on a plant hit

// ---- first-person rig ------------------------------------------------------------------
const LOOK_AHEAD = 14; // terrain pitch sample distance (m)
const PITCH_EASE = 7; // pitch approach rate /s
const ROLL_MAX = (4 * Math.PI) / 180; // ~4° carve bank (STYLE_BIBLE)
const SHAKE_START = 8; // m/s where the micro-shake fades in
const SHAKE_FULL = 20; // ...and reaches full (tiny) amplitude
const SHAKE_F0 = 15; // Hz base frequency
const SHAKE_F_PER = 0.6; // +Hz per m/s
const DIP_SPRING = 60; // dip spring ω² (kart landing dip)
const DIP_DAMP = 9; // dip spring 2ζω — one soft bounce
const DIP_HIT = 1.3; // plantHit impulse into the spring
const TELEPORT_DIST = 12; // m — a bigger jump resets every derivative
const FOV_DELTA = 0.05; // FOV is only pushed past this change

// ---- v2 air feel (R1v2, CONTRACT §11.4 + STYLE_BIBLE §V2.5) --------------------
const AIR_FOV_PUNCH = 4; // +4° FOV punch while airborne, eased back on landing
const AIR_PITCH_BIAS = (-2 * Math.PI) / 180; // rad — hold ~level in the air
const AIR_EASE = 8; // /s — airborneVis approach rate, both ways, no snaps
const LAND_DIP_HIT = 1.55; // land() impulse — a touch bigger than a plant hit
const LAND_FLASH_PEAK = 0.3; // land edge flash — softer than FLASH_PEAK (0.5)

// ---- v2 sky dressing (clouds + sun disc, STYLE_BIBLE §V2.5) --------------------
const CLOUD_SEED = 0x5c1d0d; // fixed — the cloud ring is deterministic (no rng seed from Date)
const CLOUD_PUFFS = 8; // 6–10 low-poly puffs
const CLOUD_RING_MIN = 450; // m out — parked IN the haze, past the finish fade
const CLOUD_RING_MAX = 520;
const CLOUD_A0 = -1.5; // rad from +Z — the downhill-facing arc (the mountain
const CLOUD_A1 = 0.35; // skirt walls off the sides; the sun sits at +1.05 rad)
const CLOUD_Y_MIN = 2; // m above the eye — the horizon band
const CLOUD_Y_MAX = 38;
const CLOUD_HALF_MIN = 22; // puff footprint half-width (m)
const CLOUD_HALF_MAX = 38;
const SUN_DISC_RADIUS = 32; // m — a small stylized sun, ~7° in frame
const SUN_DISC_DIST = DOME_RADIUS * 0.82; // just inside the dome, ringed by the glow

// ---- menu pre-warm -----------------------------------------------------------------------
const WARM_IDLE_FRAMES = 2; // rAF frames left alone before touching the driver

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smooth01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/** Raw sRGB components of a palette hex for the post shader (no color management). */
function srgbUniform(hex: string): THREE.Vector3 {
  const n = parseInt(hex.slice(1), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Dispose every Mesh geometry under root (shared cached materials excluded). */
function disposeGeometries(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.geometry.dispose();
  });
}

/**
 * fog:false Lambert for the cloud puffs — they live IN the haze, so the world
 * FogExp2 must not eat them. The frozen mat() cache cannot take fog:false, so
 * the cloud layer owns this two-entry cache; colours are still SPAL entries or
 * SPAL lerps (paper tops / snowShade undersides).
 */
const cloudMatCache = new Map<string, THREE.MeshLambertMaterial>();
function cloudMat(hex: string): THREE.MeshLambertMaterial {
  let m = cloudMatCache.get(hex);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color: hex, flatShading: true, fog: false });
    cloudMatCache.set(hex, m);
  }
  return m;
}

export class SplatScene {
  readonly world: THREE.Scene;
  /** First-person camera, exposed (§7a) so camera-space rigs (the own-skis
   *  Group from SkierVisuals) can be added as its children. It IS added to
   *  the world — three.js only renders an object's children when the object
   *  is in the rendered graph. */
  readonly camera: THREE.PerspectiveCamera;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sky: THREE.Mesh;
  /** Camera-anchored sky dressing (R1v2): the baked cloud layer + the sun
   *  disc. Positioned at the eye every setCamera, exactly like the dome — so
   *  the clouds and the sun stay on their fixed world azimuths. Static for
   *  the session: never rebuilt or disposed with the terrain. */
  private readonly skyRig = new THREE.Group();
  private readonly postScene = new THREE.Scene();
  private readonly postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly disposables: Array<{ dispose(): void }> = [];

  private terrainRoot: THREE.Group | null = null;
  private slope: SlopeDef | null = null;

  // menu pre-warm state (-1 == finished, never restarts)
  private warmStep = 0;

  // camera feel state (derived from the setCamera stream; no per-frame alloc)
  private camReady = false; // first setCamera snaps instead of easing
  private camTime = 0; // accumulated clamped dt — shake phase
  private pitch = 0; // eased terrain-following pitch (rad, negative downhill)
  private dip = 0; // plant-hit dip spring offset (<= 0 while bouncing)
  private dipV = 0;
  private flash = 0; // plant-hit edge flash, 1 -> 0 over FLASH_S
  // v2 air feel (R1v2): the raw (airborne, dt) stream + its eased visual flag.
  // airborneVis drives the FOV punch, the shake fade and the pitch bias; it
  // is eased in setCamera (deterministic, no rng), never snapped.
  private airborne = false; // last setAirborne() latch
  private airborneVis = 0; // 0 grounded -> 1 airborne
  private prevX = 0;
  private prevZ = 0;

  private readonly lookScratch = new THREE.Vector3();
  private readonly sunVec = new THREE.Vector3(SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]);
  /** Live uniform object for the hit-flash quad — mutated, never replaced. */
  private readonly flashAlpha = { value: 0 };

  constructor(parent: HTMLElement) {
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    parent.appendChild(canvas);
    this.canvas = canvas;

    // guard: no WebGL context => readable failure surface, then propagate
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: 'high-performance',
      });
    } catch (err) {
      SplatScene.showContextError();
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.renderer = renderer;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // drawCalls() telemetry must see the WHOLE frame: render() draws two
    // passes (world + post), so info is reset once per render() instead of
    // three's per-render() auto-reset (which would report the post pass only).
    renderer.info.autoReset = false;

    this.world = new THREE.Scene();
    const fogCol = new THREE.Color(SPAL.skyHorizon); // S2: exactly the horizon stop
    this.world.fog = new THREE.FogExp2(fogCol, FOG_DENSITY);
    renderer.setClearColor(fogCol);

    // near = 0.1 m: the own-skis rig rides at ~0.55 m ahead of the eye, so a
    // body-presence rig never clips; on an open snowfield the far/near ratio
    // costs no visible z-fighting
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, CAM_FAR);
    // the camera must be IN the rendered graph for its children (the
    // camera-space own-skis rig) to render
    this.world.add(this.camera);

    // warm key: low morning sun, SPAL.sunWarm tint, PCFSoft shadows; the
    // shadow box follows the camera target every setCamera
    this.sun = new THREE.DirectionalLight(SPAL.sunWarm, SUN_INTENSITY);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    const sc = this.sun.shadow.camera;
    sc.left = -SHADOW_EXTENT;
    sc.right = SHADOW_EXTENT;
    sc.top = SHADOW_EXTENT;
    sc.bottom = -SHADOW_EXTENT;
    sc.near = 1;
    sc.far = SUN_DISTANCE * 3;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 0.05; // the raking angle leans on this, kart-tuned
    this.world.add(this.sun);
    this.world.add(this.sun.target);

    // hemisphere fill: morning sky (skyZenith/skyHorizon 50-50) up / snow-bounce
    // below — shadows on snow go BLUE, never grey, but BRIGHT blue: the raw
    // zenith stop was saturating them to navy dusk
    this.hemi = new THREE.HemisphereLight(
      mix(SPAL.skyZenith, SPAL.skyHorizon, 0.5),
      SPAL.snow,
      HEMI_INTENSITY,
    );
    this.world.add(this.hemi);

    // sky dome: vertex-gradient skyHorizon -> skyZenith + warm blob around the
    // sun, fog:false, unlit — the ONE MeshBasicMaterial exemption (§2.5)
    const skyMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
    });
    this.disposables.push(skyMat);
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 48, 24), skyMat);
    this.sky.frustumCulled = false; // the dome always encloses the camera
    this.tintSky();
    this.world.add(this.sky);

    // v2 sky dressing rides the camera with the dome (clouds + sun disc)
    this.world.add(this.skyRig);
    this.buildSkyDressing();

    this.buildPost();
    this.aimSun(0, 0, 0);
    this.resize();
  }

  /**
   * (Re)build the whole mountain for a new slope: terrain + dressing +
   * gates + lodge. Idempotent — the previous build's geometries are disposed.
   * Called on join and again whenever the snapshot seed changes (rematch =
   * new mountain).
   */
  buildTerrain(slope: SlopeDef): void {
    if (this.terrainRoot) {
      this.world.remove(this.terrainRoot);
      disposeGeometries(this.terrainRoot);
      this.terrainRoot = null;
    }
    this.slope = slope;
    const root = new THREE.Group();
    root.add(buildTerrain(slope));
    root.add(buildGates(slope));
    this.terrainRoot = root;
    this.world.add(root);
  }

  /**
   * First-person rig. Eye at (x, y+EYE_HEIGHT+dip, z), looking along yaw with
   * pitch eased toward the terrain fall LOOK_AHEAD metres ahead — the horizon
   * holds near the vertical third-line and the fall line pulls the eye
   * downhill. Feel layers per the header; all deterministic in (x,y,z,yaw,v,
   * steer,dt). The sun's shadow box and the sky dome follow.
   */
  setCamera(x: number, y: number, z: number, yaw: number, v: number, steer: number, dt: number): void {
    if (this.warmStep >= 0) this.finishPrewarm(); // race frames render for real now
    const dtc = clamp(dt, 0, 0.1); // hitch clamp
    const first = !this.camReady;

    // terrain-following pitch target: eye-height point on the slope ahead
    let pitchTarget = this.pitch;
    const slope = this.slope;
    if (slope) {
      const aheadX = x + Math.sin(yaw) * LOOK_AHEAD;
      const aheadZ = z + Math.cos(yaw) * LOOK_AHEAD;
      pitchTarget = Math.atan2(slope.height(aheadX, aheadZ) - y, LOOK_AHEAD);
      // v2 air feel: while airborne the camera holds level — the terrain pitch
      // eases toward a ~-2° bias so the horizon stays put mid-flight
      pitchTarget += (AIR_PITCH_BIAS - pitchTarget) * this.airborneVis;
    }

    if (first) {
      this.camReady = true;
      this.pitch = pitchTarget;
      this.dip = 0;
      this.dipV = 0;
      this.airborneVis = this.airborne ? 1 : 0; // no history — snap the eased flag
      this.prevX = x;
      this.prevZ = z;
    } else if (dtc > 1e-5) {
      const dx = x - this.prevX;
      const dz = z - this.prevZ;
      this.prevX = x;
      this.prevZ = z;
      if (Math.hypot(dx, dz) > TELEPORT_DIST) {
        // teleport — drop every derivative (no phantom shake/dip)
        this.pitch = pitchTarget;
        this.dip = 0;
        this.dipV = 0;
      }
      // dip spring integrates every frame (decays to rest)
      const dipA = -DIP_SPRING * this.dip - DIP_DAMP * this.dipV;
      this.dipV += dipA * dtc;
      this.dip += this.dipV * dtc;
      // hit flash decays linearly over FLASH_S
      if (this.flash > 0) this.flash = Math.max(0, this.flash - dtc / FLASH_S);
      // pitch eases toward the terrain fall
      this.pitch += (pitchTarget - this.pitch) * (1 - Math.exp(-PITCH_EASE * dtc));
      // v2 air feel: the airborne visual flag eases toward its target — the
      // FOV punch, shake fade and pitch bias all ride it, so air is smooth and
      // a landing eases back instead of snapping (deterministic in (airborne, dt))
      this.airborneVis += ((this.airborne ? 1 : 0) - this.airborneVis) * (1 - Math.exp(-AIR_EASE * dtc));
      this.camTime += dtc;
    }

    const sp = Math.abs(v);
    const eyeY = y + EYE_HEIGHT + this.dip;
    this.camera.position.set(x, eyeY, z);
    const cp = Math.cos(this.pitch);
    this.camera.lookAt(
      this.lookScratch.set(
        x + Math.sin(yaw) * cp,
        eyeY + Math.sin(this.pitch),
        z + Math.cos(yaw) * cp,
      ),
    );

    // carve roll: bank INTO the turn, up to ~4°, proportional to steer*v.
    // steer > 0 turns toward +x (the skier's right, CONTRACT §4); rotateZ(+)
    // tilts the camera's up vector toward +x — a lean into the carve.
    const roll = clamp(steer, -1, 1) * (sp / MAX_SPEED) * ROLL_MAX;
    this.camera.rotateZ(roll);

    // speed micro-shake (kart formula): tiny, frequency rises with speed.
    // v2 air feel: air is smooth — the ground shake fades out while airborne
    const shakeAmp =
      smooth01((sp - SHAKE_START) / (SHAKE_FULL - SHAKE_START)) * CAM_SHAKE_AMP * (1 - this.airborneVis);
    if (shakeAmp > 1e-6) {
      const w = Math.PI * 2 * (SHAKE_F0 + sp * SHAKE_F_PER) * this.camTime;
      const shakeY = shakeAmp * (Math.sin(w) * 0.6 + Math.sin(w * 1.37 + 1.7) * 0.4);
      const shakeP = shakeAmp * 0.7 * (Math.sin(w * 0.83 + 0.9) * 0.6 + Math.sin(w * 1.61 + 2.6) * 0.4);
      this.camera.rotateX(shakeP + this.dip * 0.35);
      this.camera.rotateY(shakeY);
    } else if (this.dip !== 0) {
      this.camera.rotateX(this.dip * 0.35);
    }

    // speed FOV: BASE_FOV + up to SPEED_FOV_MAX, pushed only past a delta.
    // v2 air feel: while airborne the target is the FULL speed FOV + the +4°
    // punch, eased (not snapped) through airborneVis — it eases back on landing
    const speedFov = BASE_FOV + Math.min(SPEED_FOV_MAX, (sp / MAX_SPEED) * SPEED_FOV_MAX);
    const fov = speedFov + (BASE_FOV + SPEED_FOV_MAX + AIR_FOV_PUNCH - speedFov) * this.airborneVis;
    if (Math.abs(this.camera.fov - fov) > FOV_DELTA) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // the dome + sky dressing (clouds, sun disc) ride the camera; the shadow
    // box follows the look point ahead
    this.sky.position.set(x, eyeY, z);
    this.skyRig.position.set(x, eyeY, z);
    this.aimSun(
      x + Math.sin(yaw) * LOOK_AHEAD,
      y,
      z + Math.cos(yaw) * LOOK_AHEAD,
    );

    // push the hit-flash envelope to the post quad (scalar write, no alloc)
    this.flashAlpha.value = this.flash * FLASH_PEAK;
  }

  /** Plant contact: retrigger the dip spring (works mid-bounce) + flash. */
  plantHit(): void {
    this.dipV -= DIP_HIT;
    this.flash = 1;
  }

  /**
   * v2 (R1v2, CONTRACT §11.4): the sim's airborne flag, latched. setCamera
   * eases it into the feel (FOV punch, micro-shake fade, pitch bias) — air is
   * smooth, ground is bumpy. Deterministic in the (airborne, dt) stream.
   */
  setAirborne(on: boolean): void {
    this.airborne = on;
  }

  /**
   * v2 (R1v2): landing — retriggers the dip spring (a touch bigger than a
   * plant hit, works mid-bounce) and fires a soft snowLit->snowShade edge
   * flash through the same envelope as plantHit, at a lower peak.
   */
  land(): void {
    this.dipV -= LAND_DIP_HIT;
    this.flash = Math.max(this.flash, LAND_FLASH_PEAK / FLASH_PEAK);
  }

  /**
   * ONE step of the menu pre-warm; returns true while steps remain. Safe to
   * call every menu frame and safe to never call at all. Pays the whole
   * first-render bill (shader programs, post pipeline, driver uploads) a
   * slice per rAF while the menu is up, so joining never stalls on one giant
   * task (the kart render.ts pattern, trimmed to this scene's tiers).
   */
  prewarm(): boolean {
    if (this.warmStep < 0) return false;
    try {
      return this.warmStep_();
    } catch {
      // context lost / driver refusal: the race path is unchanged, so just stop
      this.finishPrewarm();
      return false;
    }
  }

  /** Fit renderer + camera to the canvas' laid-out size (DPR capped at 2). */
  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false); // canvas CSS size owned by the app shell
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.info.reset(); // autoReset is off: one accumulation per FRAME
    this.renderer.render(this.world, this.camera);
    // post pass: grade + vignette quads drawn over the frame (no deps)
    this.renderer.autoClear = false;
    this.renderer.render(this.postScene, this.postCam);
    this.renderer.autoClear = true;
  }

  /** Draw calls of the last render() — e2e telemetry (budget: < 80). */
  drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  // ---- private helpers -------------------------------------------------------------

  /** One pre-warm step (see prewarm()); returns true while steps remain. */
  private warmStep_(): boolean {
    const s = this.warmStep++;
    if (s < WARM_IDLE_FRAMES) return true; // let the menu paint before we stall it
    switch (s - WARM_IDLE_FRAMES) {
      case 0:
        this.renderer.compile(this.world, this.camera);
        return true;
      case 1:
        this.renderer.compile(this.postScene, this.postCam);
        return true;
      case 2:
      case 3:
        // throwaway frames into the (menu-hidden) canvas — the DRAW is what
        // makes the driver build pipeline state and run the shadow-map depth
        // programs (compile() does not touch them)
        this.render();
        return true;
      case 4:
        return true; // one frame of slack — let the driver drain on its own
      case 5:
        // LOAD-BEARING (kart render.ts): the menu canvas is display:none, so
        // without glFinish the draws above are only RECORDED and the join
        // still stalls. ~0 ms here after the slack frame.
        this.renderer.getContext().finish();
        return true;
      default:
        this.finishPrewarm();
        return false;
    }
  }

  /** Stop pre-warming for good and wipe the hidden canvas clear. */
  private finishPrewarm(): void {
    this.warmStep = -1;
    try {
      this.renderer.setRenderTarget(null);
      this.renderer.clear();
    } catch {
      // a lost context has nothing to clear — the race path is unaffected
    }
  }

  /**
   * Aim the shadow-casting sun AT (tx,ty,tz) FROM SUN_DIR — the light rides
   * the same vector the terrain vertex shading and the sky's warm blob use,
   * so painted shading, real shadows and sky always agree.
   */
  private aimSun(tx: number, ty: number, tz: number): void {
    this.sun.position.set(
      tx + this.sunVec.x * SUN_DISTANCE,
      ty + this.sunVec.y * SUN_DISTANCE,
      tz + this.sunVec.z * SUN_DISTANCE,
    );
    this.sun.target.position.set(tx, ty, tz);
    this.sun.target.updateMatrixWorld();
  }

  /**
   * v2 sky dressing (R1v2, STYLE_BIBLE §V2.5): the baked low-poly cloud layer
   * + the sun disc, anchored to the camera-following skyRig (the dome rides
   * the camera, so they do too — static for the session, never rebuilt with
   * the terrain and never in the terrain root's dispose list).
   *
   * Clouds: CLOUD_PUFFS puffs of 2–4 squashed spheres each, parked 450–520 m
   * out on the downhill-facing arc (clear of the sun blob and the mountain
   * skirt), fog:false Lambert — paper tops / snowShade undersides. ALL puffs
   * bake into ONE merged mesh per material via bake(): the whole layer is
   * exactly 2 draw calls. Deterministic from the fixed CLOUD_SEED.
   *
   * Sun disc: a small warm sunWarm octagon on the SUN_DIR azimuth at
   * ~0.82 × dome radius, just inside the dome so the painted warm glow rings
   * it. MeshBasicMaterial is the §2.5-exempt piece (fog:false, like the dome).
   * The disc faces the eye along a CONSTANT direction (both are anchored to
   * the rig), so its orientation is set once — no per-frame billboarding.
   */
  private buildSkyDressing(): void {
    // ---- clouds: one merged geometry per material (<= 2 draw calls) -------
    const next = rng(CLOUD_SEED);
    const scratch = new THREE.Group(); // source puffs — baked, never added to the scene
    for (let i = 0; i < CLOUD_PUFFS; i++) {
      const t = i / (CLOUD_PUFFS - 1); // evenly spread the arc (8 puffs, never 1)
      const a = clamp(
        CLOUD_A0 + (CLOUD_A1 - CLOUD_A0) * t + rngRange(next, -0.14, 0.14),
        CLOUD_A0,
        CLOUD_A1,
      );
      const dist = rngRange(next, CLOUD_RING_MIN, CLOUD_RING_MAX);
      const px = Math.sin(a) * dist;
      const pz = Math.cos(a) * dist;
      const py = rngRange(next, CLOUD_Y_MIN, CLOUD_Y_MAX);
      const half = rngRange(next, CLOUD_HALF_MIN, CLOUD_HALF_MAX);
      const blobs = 2 + Math.floor(next() * 3); // 2–4 squashed spheres per puff
      for (let b = 0; b < blobs; b++) {
        const bx = rngRange(next, -half * 0.55, half * 0.55);
        // underside blob sits at/below the puff centre; the lit tops rise above
        const by =
          b === 0 ? rngRange(next, -half * 0.16, 0) : rngRange(next, -half * 0.08, half * 0.16);
        const bz = rngRange(next, -half * 0.4, half * 0.4);
        const br = rngRange(next, half * 0.34, half * 0.62);
        // the first blob is the snowShade underside; the rest are the lit tops
        // (paper pulled toward skyHorizon so they sit IN the haze, not pop)
        const hex = b === 0 ? SPAL.snowShade : mix(SPAL.paper, SPAL.skyHorizon, 0.35);
        const puff = sphere(cloudMat, br, 7, hex);
        puff.position.set(px + bx, py + by, pz + bz);
        puff.scale.y = 0.42; // the squashed low-poly puff
        scratch.add(puff);
      }
    }
    const clouds = bake(scratch);
    for (const m of clouds.children) {
      if (!(m instanceof THREE.Mesh)) continue;
      m.frustumCulled = false; // huge puffs in world-space bounds — never cull
      m.castShadow = false; // 500 m out — outside the shadow box; shadows on
      m.receiveShadow = false; // clouds would read as dirt
      this.disposables.push(m.geometry);
      this.skyRig.add(m);
    }

    // ---- sun disc ---------------------------------------------------------
    const sunDiscMat = new THREE.MeshBasicMaterial({ color: SPAL.sunWarm, fog: false });
    const sunDisc = at(
      new THREE.Mesh(new THREE.CircleGeometry(SUN_DISC_RADIUS, 8), sunDiscMat),
      this.sunVec.x * SUN_DISC_DIST,
      this.sunVec.y * SUN_DISC_DIST,
      this.sunVec.z * SUN_DISC_DIST,
    );
    // the disc is anchored to the camera (skyRig follows the eye), so the
    // face direction toward the eye is CONSTANT: circle +Z normal -> -SUN_DIR
    const up = new THREE.Vector3(0, 0, 1);
    const towardCam = this.sunVec.clone().negate();
    sunDisc.quaternion.setFromUnitVectors(up, towardCam);
    sunDisc.frustumCulled = false;
    this.disposables.push(sunDiscMat, sunDisc.geometry);
    this.skyRig.add(sunDisc);
  }

  /**
   * Dome vertex colours: a thin pure skyHorizon rim the fog fuses into,
   * ramping to full skyZenith by mid-frame and deepening toward a zenith/ink
   * mix at the top (real blue presence overhead), distant snow land
   * (snowShade) below the horizon line, and a warm sunWarm blob around the
   * sun azimuth so the light reads directional. All stops are literal SPAL
   * entries or SPAL lerps.
   */
  private tintSky(): void {
    const geo = this.sky.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
    geo.setAttribute('color', colAttr);

    const horizon = new THREE.Color(SPAL.skyHorizon);
    const zenith = new THREE.Color(SPAL.skyZenith);
    // deeper top-of-frame blue: zenith pulled toward ink so the upper half of
    // the dome reads as SKY, not a washed-out extension of the snowfield
    const zenithDeep = new THREE.Color(mix(SPAL.skyZenith, SPAL.ink, 0.22));
    const below = new THREE.Color(SPAL.skyHorizon).lerp(new THREE.Color(SPAL.snowShade), 0.55);
    const warmGlow = new THREE.Color(SPAL.sunWarm);
    const c = new THREE.Color();
    const dir = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / DOME_RADIUS; // -1..1
      if (y <= 0) {
        c.copy(horizon).lerp(below, smooth01(-y * 2.5));
      } else if (y < 0.06) {
        c.copy(horizon); // flat rim — the fog has to disappear into it
      } else if (y < 0.38) {
        // full horizon -> zenith ramp low in the frame: blue presence arrives
        // fast above the fog-fused rim instead of topping out at 55%
        c.copy(horizon).lerp(zenith, smooth01((y - 0.06) / 0.32));
      } else if (y < 0.8) {
        c.copy(zenith).lerp(zenithDeep, smooth01((y - 0.38) / 0.42));
      } else {
        c.copy(zenithDeep);
      }
      // warm glow around the sun, kept out of the horizon rim
      dir.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
      const sunAmt =
        Math.pow(Math.max(0, dir.dot(this.sunVec)), 5) * (1 - smooth01(y / 0.7));
      if (sunAmt > 0.001) c.lerp(warmGlow, Math.min(0.6, sunAmt));
      colAttr.setXYZ(i, c.r, c.g, c.b);
    }
    colAttr.needsUpdate = true;
  }

  /**
   * Dependency-free post pass (the kart render.ts pattern): three fullscreen
   * quads — a subtle warm sunGold grade lift weighted to the GROUND half
   * (reinforcing the cool-sky / warm-ground split), an ink vignette, and a
   * plant-hit edge flash (snowLit->snowShade white-blue, strongest at the
   * frame edges, alpha driven by the flash envelope from plantHit()).
   * Shader outputs raw sRGB, so uniforms are hand-decoded sRGB components.
   */
  private buildPost(): void {
    const VERT =
      'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    const GRADE_FRAG =
      'varying vec2 vUv; uniform vec3 uColor; uniform float uAlpha;' +
      'void main() { gl_FragColor = vec4(uColor, uAlpha * (0.55 + 0.45 * (1.0 - vUv.y))); }';
    const VIGNETTE_FRAG =
      'varying vec2 vUv; uniform vec3 uColor; uniform float uAlpha;' +
      'void main() {' +
      '  vec2 p = (vUv - 0.5) * vec2(1.15, 1.0);' +
      '  float a = smoothstep(0.52, 1.05, length(p) * 1.4142) * uAlpha;' +
      '  gl_FragColor = vec4(uColor, a);' +
      '}';
    const FLASH_FRAG =
      'varying vec2 vUv; uniform vec3 uColor; uniform float uAlpha;' +
      'void main() {' +
      '  vec2 p = (vUv - 0.5) * vec2(1.15, 1.0);' +
      '  float edge = smoothstep(0.3, 0.95, length(p) * 1.4142);' +
      '  gl_FragColor = vec4(uColor, uAlpha * edge);' +
      '}';
    const gradeMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: GRADE_FRAG,
      uniforms: { uColor: { value: srgbUniform(SPAL.sunGold) }, uAlpha: { value: GRADE_ALPHA } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const vignetteMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: VIGNETTE_FRAG,
      uniforms: { uColor: { value: srgbUniform(SPAL.ink) }, uAlpha: { value: VIGNETTE_ALPHA } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const flashMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FLASH_FRAG,
      uniforms: {
        uColor: { value: srgbUniform(mix(SPAL.snowLit, SPAL.snowShade, 0.45)) },
        uAlpha: this.flashAlpha,
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.disposables.push(gradeMat, vignetteMat, flashMat);
    const grade = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), gradeMat);
    grade.frustumCulled = false;
    grade.renderOrder = 1;
    const vignette = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), vignetteMat);
    vignette.frustumCulled = false;
    vignette.renderOrder = 2;
    const flash = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), flashMat);
    flash.frustumCulled = false;
    flash.renderOrder = 3;
    this.disposables.push(grade.geometry, vignette.geometry, flash.geometry);
    this.postScene.add(grade);
    this.postScene.add(vignette);
    this.postScene.add(flash);
  }

  /** Tracked context-error overlay (single element; never duplicated). */
  private static contextErrorEl: HTMLDivElement | null = null;

  /** Full-viewport readable failure message; idempotent (§2.8). */
  private static showContextError(): void {
    if (SplatScene.contextErrorEl?.isConnected) return;
    const div = document.createElement('div');
    div.textContent = 'WebGL is not available in this browser — SKI SPLAT needs GPU rendering to run.';
    const s = div.style;
    s.position = 'fixed';
    s.inset = '0';
    s.display = 'flex';
    s.alignItems = 'center';
    s.justifyContent = 'center';
    s.padding = '24px';
    s.textAlign = 'center';
    s.background = SPAL.ink;
    s.color = SPAL.paper;
    s.font = '16px/1.5 system-ui, sans-serif';
    s.zIndex = '1000';
    document.body.appendChild(div);
    SplatScene.contextErrorEl = div;
  }
}
