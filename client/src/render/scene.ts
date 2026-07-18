// ============================================================================
// C3 — scene rig: renderer + camera + per-map lighting/fog theme.
// One WebGLRenderer (ACES, sRGB out, PCFSoft shadows, pixelRatio <= 2), one
// PerspectiveCamera(BASE_FOV) driven in YXZ order (yaw then pitch) to match the
// shared aim convention. Screen shake is cosmetic only: trauma^2-scaled
// rotational noise, capped at 0.02 rad, decaying ~2.5/s — never positional,
// never rolls while strafing beyond the shake cap (STYLE_BIBLE).
// ============================================================================
import * as THREE from 'three';
import { BASE_FOV, PALETTE, type MapTheme, type Vec3 } from '@fps/shared';

// ---- shake tuning (frozen feel: "small and rare") ---------------------------
const SHAKE_MAX_RAD = 0.02; // hard cap per axis
const SHAKE_DECAY = 2.5; // trauma per second
const SHAKE_SPEED = 18; // noise clock rate (rad/s of noise input)

// ---- shadow rig (frozen: one 2048 cascade, ortho frustum fitted to ±40m) ----
const SHADOW_EXTENT = 40;
const SUN_DISTANCE = 60; // sun sits at -sunDir x 60

export class SceneRig {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private readonly canvas: HTMLCanvasElement;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;

  private trauma = 0; // 0..1 shake energy
  private shakeT = 0; // accumulated noise clock
  private lastMs = -1; // last applyCamera timestamp (performance.now), -1 = unset

  constructor(canvas: HTMLCanvasElement) {
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
      SceneRig.showContextError();
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.renderer = renderer;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 500); // far covers the r=400 dome
    this.camera.rotation.order = 'YXZ'; // yaw about Y, then pitch about local X

    // lights are created once and re-tinted per theme — no add/remove churn
    this.hemi = new THREE.HemisphereLight(PALETTE.skyDay, PALETTE.dust, 0.6);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(PALETTE.muzzle, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -SHADOW_EXTENT;
    sc.right = SHADOW_EXTENT;
    sc.top = SHADOW_EXTENT;
    sc.bottom = -SHADOW_EXTENT;
    sc.near = 1;
    sc.far = SUN_DISTANCE * 3;
    sc.updateProjectionMatrix();
    this.sun.shadow.normalBias = 0.03; // tame acne on flat-shaded Lambert
    this.scene.add(this.sun);
    this.scene.add(this.sun.target); // target defaults to origin

    this.resize();
  }

  /** Re-tint lights/fog/clear color from the map theme. Idempotent. */
  setTheme(theme: MapTheme): void {
    this.hemi.color.set(theme.sky);
    this.hemi.groundColor.set(theme.ground);
    this.hemi.intensity = theme.hemiIntensity;

    this.sun.color.set(theme.sunColor);
    this.sun.intensity = theme.sunIntensity;
    // sunDir points TOWARDS the scene, so the light sits opposite it
    this.sun.position.set(
      -theme.sunDir[0] * SUN_DISTANCE,
      -theme.sunDir[1] * SUN_DISTANCE,
      -theme.sunDir[2] * SUN_DISTANCE,
    );
    this.sun.target.position.set(0, 0, 0);
    this.sun.target.updateMatrixWorld();

    this.scene.fog = new THREE.FogExp2(theme.fog, theme.fogDensity);
    this.renderer.setClearColor(theme.sky);
  }

  /**
   * Position/aim the camera for this frame and advance shake. fovDeg is only
   * pushed to the projection matrix when it changes. Shake decays by wall
   * clock here (applyCamera runs exactly once per rendered frame).
   */
  applyCamera(pos: Vec3, yaw: number, pitch: number, fovDeg: number): void {
    const nowMs = performance.now();
    const dt = this.lastMs < 0 ? 0 : Math.min((nowMs - this.lastMs) / 1000, 0.1);
    this.lastMs = nowMs;
    this.trauma = Math.max(0, this.trauma - dt * SHAKE_DECAY);
    this.shakeT += dt * SHAKE_SPEED;

    this.camera.position.set(pos.x, pos.y, pos.z);
    let rx = pitch;
    let ry = yaw;
    let rz = 0;
    if (this.trauma > 0) {
      const mag = SHAKE_MAX_RAD * this.trauma * this.trauma; // trauma^2 scaled
      rx += mag * this.noise(0);
      ry += mag * this.noise(1);
      rz += mag * this.noise(2);
    }
    this.camera.rotation.set(rx, ry, rz);

    if (this.camera.fov !== fovDeg) {
      this.camera.fov = fovDeg;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Add shake energy (clamped 0..1). Callers: own fire kick, damage taken. */
  shake(amount: number): void {
    this.trauma = Math.min(1, Math.max(0, this.trauma + amount));
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
    this.renderer.render(this.scene, this.camera);
  }

  /** Release GPU resources. Materials are shared via the mat() cache — not disposed here. */
  dispose(): void {
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points || obj instanceof THREE.Line) {
        obj.geometry.dispose();
      }
    });
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
  }

  // ---- private helpers --------------------------------------------------------

  /** Smooth pseudo-noise in [-1, 1]: layered sines, allocation-free. */
  private noise(axis: number): number {
    const t = this.shakeT + axis * 37.7;
    return Math.sin(t) * 0.55 + Math.sin(t * 1.93 + 1.3) * 0.3 + Math.sin(t * 3.71 + 2.1) * 0.15;
  }

  /** Full-viewport readable failure message (PALETTE colors), shown once. */
  private static showContextError(): void {
    const div = document.createElement('div');
    div.textContent = 'WebGL is not available in this browser — STRICKEN needs GPU rendering to run.';
    const s = div.style;
    s.position = 'fixed';
    s.inset = '0';
    s.display = 'flex';
    s.alignItems = 'center';
    s.justifyContent = 'center';
    s.padding = '24px';
    s.textAlign = 'center';
    s.background = PALETTE.ink;
    s.color = PALETTE.hudText;
    s.font = '16px/1.5 system-ui, sans-serif';
    s.zIndex = '1000';
    document.body.appendChild(div);
  }
}
