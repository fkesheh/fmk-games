// The stage — one renderer, one scene, per-species rebuild. House renderer
// settings (STYLE_BIBLE): ACES tone mapping, sRGB, PCFSoft shadows, hemi +
// one shadow-casting sun, gradient sky dome + matched fog, radial ground.
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
  private readonly contact: THREE.Mesh;
  private asset: BuiltAsset | null = null;
  private clock = new THREE.Clock();

  constructor(host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 1.1;
    this.controls.maxPolarAngle = Math.PI * 0.52;

    // gradient sky dome: 5 DISCRETE color bands — quantized hard so bands
    // read as bands (round-3 miss: smooth lerp wore a 'banded' claim)
    const skyMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false });
    const skyGeo = new THREE.SphereGeometry(180, 48, 36);
    this.paintSkyGradient(skyGeo);
    this.scene.add(new THREE.Mesh(skyGeo, skyMat));
    this.scene.fog = new THREE.Fog(TREE_PALETTE.stageSkyHorizon, 80, 240);

    const hemi = new THREE.HemisphereLight(0xe8f0f5, 0x6d7a58, 1.05);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.03; // kills stair-stepping without peter-panning
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // radial ground: DISCRETE tiers + darker rim, receives the cast shadow
    const groundGeo = new THREE.CircleGeometry(110, 64);
    groundGeo.rotateX(-Math.PI / 2);
    this.paintGroundGradient(groundGeo);
    const ground = new THREE.Mesh(
      groundGeo,
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    );
    ground.receiveShadow = true;
    this.scene.add(ground);

    // fake contact occlusion: unit disc in XY, tilted flat by the MESH (not
    // baked) so scale.y squashes it along world Z into an ellipse. Per-vertex
    // RGBA fades the rim to alpha 0 — no texture, no shadow map.
    const contactGeo = new THREE.CircleGeometry(1, 48);
    this.paintContactFalloff(contactGeo);
    this.contact = new THREE.Mesh(
      contactGeo,
      new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, depthWrite: false,
      }),
    );
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.castShadow = false;
    this.contact.receiveShadow = false;
    this.contact.renderOrder = 1; // composites over the ground (renderOrder 0)
    this.scene.add(this.contact);

    const fit = () => this.resize(host);
    window.addEventListener('resize', fit);
    new ResizeObserver(fit).observe(host);
    this.resize(host);
  }

  private paintSkyGradient(geo: THREE.SphereGeometry): void {
    const pos = geo.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const zen = new THREE.Color(TREE_PALETTE.stageSkyZenith);
    const hor = new THREE.Color(TREE_PALETTE.stageSkyHorizon);
    // 5-stop band ladder: warm glow -> warm -> mid -> cool-mid -> zenith
    const warm = hor.clone();
    const warmMid = hor.clone().lerp(zen, 0.22).offsetHSL(0.015, 0.04, 0);
    const mid = hor.clone().lerp(zen, 0.5);
    const coolMid = hor.clone().lerp(zen, 0.75);
    const stops = [warm, warmMid, mid, coolMid, zen];
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = THREE.MathUtils.clamp(pos.getY(i) / 180, 0, 1);
      const band = Math.min(4, Math.floor(t * 5));
      c.copy(stops[band]!);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  private paintGroundGradient(geo: THREE.CircleGeometry): void {
    const pos = geo.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const mid = new THREE.Color(TREE_PALETTE.stageGround);
    const edge = new THREE.Color(TREE_PALETTE.stageGroundDark);
    const sunlit = mid.clone().offsetHSL(0.01, 0.02, 0.045); // lighter sun-hit tier
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const d = Math.hypot(pos.getX(i), pos.getZ(i)) / 110;
      // 3 discrete tiers: sunlit core, base, dark rim (with the key from +x)
      const keySide = pos.getX(i) > Math.abs(pos.getZ(i)) * 0.4 ? sunlit : mid;
      c.copy(d < 0.22 ? keySide : d < 0.6 ? mid : edge);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  private paintContactFalloff(geo: THREE.CircleGeometry): void {
    const pos = geo.getAttribute('position');
    const colors = new Float32Array(pos.count * 4); // RGBA — alpha carries the falloff
    // darkened ground rim, never pure black: reads as occlusion, not a hole
    const c = new THREE.Color(TREE_PALETTE.stageGroundDark).multiplyScalar(0.42);
    const peak = 0.5;
    for (let i = 0; i < pos.count; i++) {
      const d = THREE.MathUtils.clamp(Math.hypot(pos.getX(i), pos.getY(i)), 0, 1);
      colors[i * 4] = c.r; colors[i * 4 + 1] = c.g; colors[i * 4 + 2] = c.b;
      colors[i * 4 + 3] = peak * Math.pow(1 - d, 1.6); // 0 at the rim
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  }

  show(asset: BuiltAsset, angle: AngleName): void {
    if (this.asset) {
      this.scene.remove(this.asset.root);
      this.asset.mesh.geometry.dispose();
    }
    this.asset = asset;
    this.scene.add(asset.root);

    // frame: subject at ~75% of frame height
    const size = new THREE.Vector3();
    asset.bbox.getSize(size);
    const centre = new THREE.Vector3();
    asset.bbox.getCenter(centre);
    const dist = (Math.max(size.y, size.x * 0.9) / 2 / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.18;

    // lock the SUN to the camera frame: key light always comes from
    // frame-right, world-azimuth adjusted per angle (consistent staging)
    const presets: Record<AngleName, [number, number, number, THREE.Vector3]> = {
      front: [dist, size.y * 0.34, dist * 0.12, centre],
      'three-quarter': [dist * 0.7, size.y * 0.38, dist * 0.7, centre],
      high: [dist * 0.5, dist * 0.9, dist * 0.5, centre],
      closeup: [dist * 0.24, size.y * 0.28, dist * 0.2, new THREE.Vector3(centre.x, centre.y + size.y * 0.18, centre.z)],
    };
    const [x, y, z, target] = presets[angle];
    this.camera.position.set(x, y, z);
    this.controls.target.copy(target);
    this.controls.update();

    // sun: fixed elevation, azimuth rotated so the key stays frame-right
    const camAz = Math.atan2(x, z);
    const sunAz = camAz + Math.PI * 0.32;
    const sunDist = Math.max(30, size.y * 2.4);
    this.sun.position.set(
      Math.sin(sunAz) * sunDist, size.y * 1.6 + 14, Math.cos(sunAz) * sunDist,
    );
    this.sun.target.position.copy(centre);
    this.sun.target.updateMatrixWorld();

    // contact ellipse sized to the footprint, under the trunk
    const footprint = Math.max(size.x, size.z) * 0.32 + 0.5;
    this.contact.position.set(centre.x, 0.015, centre.z);
    this.contact.scale.set(footprint, footprint * 0.7, 1);

    // fit the shadow frustum to THIS asset
    const s = Math.max(6, Math.max(size.x, size.z) * 0.75 + 1.5);
    const cam = this.sun.shadow.camera;
    cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s;
    cam.near = 1; cam.far = sunDist * 2.2;
    cam.updateProjectionMatrix();
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
    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  tick(windStrength: number): void {
    setWind(this.clock.elapsedTime, windStrength);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
