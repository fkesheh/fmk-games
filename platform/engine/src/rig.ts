// ============================================================================
// SCENE RIG — renderer/camera/lights/fog/shadows/resize (docs/PLATFORM.md
// §4.6). Generalized from STRICKEN's proven SceneRig.
// Owner: P5_ENGINE — implement; RigOpts/SunSpec live in types.ts.
//
// One WebGLRenderer per rig (ACES filmic tonemapping, sRGB output, antialias,
// pixel ratio capped at 2), one PerspectiveCamera, hemisphere + directional
// sun whose shadow frustum follows focus(). Shadow map size 0 disables
// shadows entirely; fog only appears when fogColor is provided. Colors are
// CSS hex strings passed by games — nothing palette-bound here.
// ============================================================================

import * as THREE from 'three';
import type { RigOpts, SunSpec } from './types.js';

const DEFAULT_FOV = 60;
const DEFAULT_NEAR = 0.1;
const DEFAULT_FAR = 400;
const DEFAULT_SHADOW_MAP_SIZE = 1024;
const DEFAULT_EXPOSURE = 1;
const DEFAULT_HEMI_INTENSITY = 0.6;
const DEFAULT_SHADOW_EXTENT = 40;
/** The sun parks at dir*100 from the focus point (frozen vocabulary). */
const SUN_DISTANCE = 100;
/** Ortho depth range: sun sits SUN_DISTANCE away, keep generous slack behind. */
const SHADOW_NEAR = 0.5;
const SHADOW_FAR = SUN_DISTANCE * 3;

export class SceneRig {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private readonly canvas: HTMLCanvasElement;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;

  constructor(opts: RigOpts) {
    this.canvas = opts.canvas;

    const shadowMapSize = opts.shadowMapSize ?? DEFAULT_SHADOW_MAP_SIZE;
    const shadowsEnabled = shadowMapSize > 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = opts.exposure ?? DEFAULT_EXPOSURE;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = shadowsEnabled;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    if (opts.skyColor !== undefined) {
      this.scene.background = new THREE.Color(opts.skyColor);
    }
    if (opts.fogColor !== undefined) {
      this.scene.fog = new THREE.FogExp2(opts.fogColor, opts.fogDensity ?? 0.02);
    }

    this.camera = new THREE.PerspectiveCamera(
      opts.fovDeg ?? DEFAULT_FOV,
      1,
      opts.near ?? DEFAULT_NEAR,
      opts.far ?? DEFAULT_FAR,
    );
    this.camera.rotation.order = 'YXZ'; // yaw about Y, then pitch about local X

    // Lights are created once and re-tinted by setSun — no add/remove churn.
    this.hemi = new THREE.HemisphereLight('#ffffff', '#444444', DEFAULT_HEMI_INTENSITY);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight('#ffffff', 1);
    this.sun.castShadow = shadowsEnabled;
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.sun.shadow.bias = -0.00012;
    this.setShadowBox(DEFAULT_SHADOW_EXTENT); // safe default until setSun()
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.resize();
  }

  /** (Re)configure sun + hemisphere + shadow frustum; follows focus(). */
  setSun(spec: SunSpec): void {
    const lenSq = spec.dir.x * spec.dir.x + spec.dir.y * spec.dir.y + spec.dir.z * spec.dir.z;
    const inv = lenSq > 0 ? 1 / Math.sqrt(lenSq) : 0;
    this.sun.position.set(spec.dir.x * inv * SUN_DISTANCE, spec.dir.y * inv * SUN_DISTANCE, spec.dir.z * inv * SUN_DISTANCE);
    this.sun.color.set(spec.color);
    this.sun.intensity = spec.intensity;

    this.hemi.color.set(spec.color);
    this.hemi.groundColor.set(spec.groundColor);
    this.hemi.intensity = spec.hemiIntensity ?? DEFAULT_HEMI_INTENSITY;

    this.setShadowBox(spec.shadowExtent ?? DEFAULT_SHADOW_EXTENT);
    this.sun.target.updateMatrixWorld();
  }

  /** Shadow camera tracks this world-space point (player, kart, …). */
  focus(x: number, y: number, z: number): void {
    this.sun.target.position.set(x, y, z);
    this.sun.target.updateMatrixWorld();
  }

  resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false); // canvas CSS size owned by the app shell
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
  }

  /** Ortho shadow box ±extent around the light axis; call after moving the sun. */
  private setShadowBox(extent: number): void {
    const sc = this.sun.shadow.camera;
    sc.left = -extent;
    sc.right = extent;
    sc.bottom = -extent;
    sc.top = extent;
    sc.near = SHADOW_NEAR;
    sc.far = SHADOW_FAR + extent;
    sc.updateProjectionMatrix();
  }
}
