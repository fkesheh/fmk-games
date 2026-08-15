// The stage — one renderer, one scene, per-species rebuild. House renderer
// settings (STYLE_BIBLE): ACES tone mapping, sRGB, PCFSoft shadows, hemi +
// one shadow-casting sun, gradient sky + matched fog, ground disc.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ASSET_MATERIAL, setWind, TREE_PALETTE } from '@assets/library';
import type { BuiltAsset } from '@assets/library';

export type AngleName = 'front' | 'three-quarter' | 'high' | 'closeup';

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private readonly sun: THREE.DirectionalLight;
  private asset: BuiltAsset | null = null;
  private readonly groundDisc: THREE.Mesh;
  private clock = new THREE.Clock();

  constructor(host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(host.clientWidth, host.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, host.clientWidth / host.clientHeight, 0.1, 300);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 1.1;
    this.controls.maxPolarAngle = Math.PI * 0.52;

    // sky + matched fog — the neutral biome stage
    this.scene.background = new THREE.Color(TREE_PALETTE.stageSky);
    this.scene.fog = new THREE.Fog(TREE_PALETTE.stageSky, 60, 160);

    const hemi = new THREE.HemisphereLight(0xdfeaf2, 0x54604a, 0.85);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.1);
    this.sun.position.set(14, 22, 10);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = 16;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 70 });
    this.scene.add(this.sun);

    // ground: muted disc that receives the contact shadow
    this.groundDisc = new THREE.Mesh(
      new THREE.CylinderGeometry(30, 30, 0.4, 48),
      new THREE.MeshLambertMaterial({ color: TREE_PALETTE.stageGround }),
    );
    this.groundDisc.position.y = -0.22;
    this.groundDisc.receiveShadow = true;
    this.scene.add(this.groundDisc);

    window.addEventListener('resize', () => this.resize(host));
  }

  show(asset: BuiltAsset, angle: AngleName): void {
    if (this.asset) {
      this.scene.remove(this.asset.root);
      this.asset.mesh.geometry.dispose();
    }
    this.asset = asset;
    this.scene.add(asset.root);

    // frame: hero at ~65% of frame height
    const size = new THREE.Vector3();
    asset.bbox.getSize(size);
    const centre = new THREE.Vector3();
    asset.bbox.getCenter(centre);
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = (maxDim / 2 / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.5;

    const presets: Record<AngleName, [number, number, number, THREE.Vector3]> = {
      'front': [dist, maxDim * 0.38, dist * 0.15, centre],
      'three-quarter': [dist * 0.72, maxDim * 0.42, dist * 0.72, centre],
      'high': [dist * 0.5, dist * 0.95, dist * 0.5, centre],
      'closeup': [dist * 0.24, maxDim * 0.30, dist * 0.2, new THREE.Vector3(centre.x, centre.y + maxDim * 0.18, centre.z)],
    };
    const [x, y, z, target] = presets[angle];
    this.camera.position.set(x, y, z);
    this.controls.target.copy(target);
    this.controls.update();
  }

  setWireframe(on: boolean): void {
    ASSET_MATERIAL.wireframe = on;
  }

  setAutoRotate(on: boolean): void {
    this.controls.autoRotate = on;
  }

  /** renders offscreen thumbnails for the gallery (reuses the same renderer) */
  thumbnail(asset: BuiltAsset, px: number): string {
    this.show(asset, 'three-quarter');
    const host = this.renderer.domElement;
    const prevW = host.width, prevH = host.height;
    const prevPR = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(px, px, false);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    this.renderer.setPixelRatio(prevPR);
    this.renderer.setSize(prevW / prevPR, prevH / prevPR, false);
    return url;
  }

  resize(host: HTMLElement): void {
    this.camera.aspect = host.clientWidth / host.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(host.clientWidth, host.clientHeight);
  }

  tick(windStrength: number): void {
    const dt = this.clock.getDelta();
    const t = this.clock.elapsedTime;
    setWind(t, windStrength);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    void dt;
  }
}
