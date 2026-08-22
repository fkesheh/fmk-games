// ============================================================================
// ORBIT RENDER — deep-space tunnel built ONLY on @platform/engine + three
// (docs/PLATFORM.md §4.6). Seeded starfield + recycled corridor ribs, pooled
// amber rocks / magenta laser hoops / cyan shield pickups (id-keyed mesh maps
// with free lists — zero per-frame allocation), neon cyan ship trail through
// the engine ParticlePool, ChaseCam with steer roll + boost FOV kick.
//
// Camera law: OrbitCam on the menu; ChaseCam (yaw locked down-tunnel) while
// running, with a roll about the view axis proportional to lateral steer.
// ============================================================================

import {
  OrbitCam,
  ParticlePool,
  SceneRig,
  ChaseCam,
} from '@platform/engine';
import * as THREE from 'three';
import { SIM } from './run.js';
import type { Obstacle, Pickup, RunState } from './run.js';

// palette (house rule: CSS hex strings everywhere)
const INK = '#0b0e14';
const FOG = '#131c2e';
const CYAN = '#35e0ff';
const AMBER = '#ffb454';
const MAGENTA = '#ff4fd8';
const STAR = '#cfe8ff';
const RIB = '#1d3a55';

/** Starfield/rib recycle span and spacing. */
const RIB_COUNT = 14;
const RIB_SPACING = 24;
const STAR_COUNT = 700;
const STAR_SEED = 0x0a2b17;

export interface SyncView {
  /** Lateral steer actually fed to the sim this tick (drives ship tilt/roll). */
  ax: number;
  ay: number;
}

interface BoundMesh {
  mesh: THREE.Mesh;
  kind: 'rock' | 'hoop' | 'pickup';
}

class MeshPool {
  private readonly free: THREE.Mesh[] = [];
  constructor(
    private readonly make: () => THREE.Mesh,
    private readonly parent: THREE.Object3D,
  ) {}

  acquire(): THREE.Mesh {
    const m = this.free.pop() ?? this.make();
    if (m.parent !== this.parent) this.parent.add(m);
    m.visible = true;
    return m;
  }

  release(m: THREE.Mesh): void {
    m.visible = false;
    this.free.push(m);
  }
}

export class GameRenderer {
  readonly rig: SceneRig;

  private readonly particles: ParticlePool;
  private readonly chase: ChaseCam;
  private orbit: OrbitCam | null = null;

  private readonly ship: THREE.Group;
  private readonly starGroup: THREE.Group;
  private readonly ribs: THREE.Mesh[] = [];

  private readonly rockPool: MeshPool;
  private readonly hoopPool: MeshPool;
  private readonly pickupPool: MeshPool;
  private readonly bound = new Map<number, BoundMesh>();

  private roll = 0;
  private fov = 68;
  private trailAcc = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.rig = new SceneRig({
      canvas,
      fovDeg: this.fov,
      far: 340,
      skyColor: INK,
      fogColor: FOG,
      fogDensity: 0.02,
      shadowMapSize: 0, // deep space: no shadows, all emissive
    });
    this.rig.setSun({
      dir: { x: 0.35, y: 0.8, z: 0.5 },
      color: '#9fd8ff',
      intensity: 1.7,
      groundColor: INK,
      hemiIntensity: 0.5,
    });

    const scene = this.rig.scene;

    // ---- starfield: seeded annulus of points that rides with the ship ----
    this.starGroup = new THREE.Group();
    const next = ((): (() => number) => {
      let a = STAR_SEED >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    const starPos = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const ang = next() * Math.PI * 2;
      const rad = 12 + Math.sqrt(next()) * 70;
      starPos[i * 3] = Math.cos(ang) * rad;
      starPos[i * 3 + 1] = Math.sin(ang) * rad;
      starPos[i * 3 + 2] = -260 + next() * 300;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: STAR, size: 0.55, sizeAttenuation: true, fog: false }),
    );
    stars.frustumCulled = false;
    this.starGroup.add(stars);
    scene.add(this.starGroup);

    // ---- corridor ribs (recycled decorative rings) ----
    const ribGeo = new THREE.TorusGeometry(SIM.tunnelR + 0.45, 0.07, 6, 42);
    const ribMat = new THREE.MeshBasicMaterial({ color: RIB });
    for (let i = 0; i < RIB_COUNT; i++) {
      const rib = new THREE.Mesh(ribGeo, ribMat);
      rib.position.z = -i * RIB_SPACING;
      this.ribs.push(rib);
      scene.add(rib);
    }

    // ---- the ship: cyan dart pointing down −Z ----
    this.ship = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({
      color: CYAN,
      roughness: 0.35,
      flatShading: true,
      emissive: new THREE.Color(CYAN),
      emissiveIntensity: 0.55,
    });
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.7, 6), bodyMat);
    body.rotation.x = -Math.PI / 2; // tip → −Z
    this.ship.add(body);
    const wingMat = new THREE.MeshStandardMaterial({
      color: AMBER,
      roughness: 0.5,
      flatShading: true,
      emissive: new THREE.Color(AMBER),
      emissiveIntensity: 0.3,
    });
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.55), wingMat);
      wing.position.set(side * 0.55, 0, 0.35);
      wing.rotation.z = side * 0.28;
      this.ship.add(wing);
    }
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 10, 8),
      new THREE.MeshBasicMaterial({ color: CYAN }),
    );
    glow.position.z = 0.95;
    this.ship.add(glow);
    scene.add(this.ship);

    // ---- entity pools ----
    const rockMat = new THREE.MeshStandardMaterial({
      color: AMBER,
      roughness: 0.78,
      flatShading: true,
      emissive: new THREE.Color('#3a230a'),
      emissiveIntensity: 0.4,
    });
    this.rockPool = new MeshPool(
      () => new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), rockMat),
      scene,
    );
    const hoopMat = new THREE.MeshStandardMaterial({
      color: MAGENTA,
      roughness: 0.4,
      emissive: new THREE.Color(MAGENTA),
      emissiveIntensity: 1.15,
    });
    this.hoopPool = new MeshPool(
      () => new THREE.Mesh(new THREE.TorusGeometry(1, SIM.hoopTube, 8, 32), hoopMat),
      scene,
    );
    const pickupMat = new THREE.MeshStandardMaterial({
      color: CYAN,
      roughness: 0.3,
      emissive: new THREE.Color(CYAN),
      emissiveIntensity: 1.2,
    });
    this.pickupPool = new MeshPool(
      () => new THREE.Mesh(new THREE.OctahedronGeometry(SIM.pickupR * 0.85), pickupMat),
      scene,
    );

    // ---- fx + cameras ----
    this.particles = new ParticlePool(scene, { particles: 512 });
    this.chase = new ChaseCam(this.rig.camera, { dist: 9.5, height: 2.6, lag: 6, lookHeight: 0 });
    this.orbit = new OrbitCam(this.rig.camera, { radius: 24, height: 7, rotSpeed: 0.25 });
  }

  // ---- per-frame ----------------------------------------------------------------

  /**
   * Mirror one RunState into meshes/camera. `st === null` renders the menu:
   * idle ship bobbing at the tunnel mouth under the slow orbit cam.
   */
  sync(st: RunState | null, dtFrame: number, v: SyncView): void {
    if (st === null) {
      this.syncMenu(dtFrame);
      return;
    }

    // ship pose + tilt
    this.ship.position.set(st.x, st.y, st.z);
    const blink = st.invulnT > 0 && Math.floor(st.invulnT * 14) % 2 === 0;
    this.ship.visible = st.alive && !blink;
    this.ship.rotation.z += (-v.ax * 0.5 - this.ship.rotation.z) * Math.min(1, dtFrame * 10);
    this.ship.rotation.x += (v.ay * 0.22 - this.ship.rotation.x) * Math.min(1, dtFrame * 10);

    // chase cam + roll on steer + boost FOV kick
    this.chase.track({ x: st.x, y: st.y, z: st.z }, 0);
    this.chase.update(dtFrame);
    const targetRoll = -v.ax * 0.24;
    this.roll += (targetRoll - this.roll) * Math.min(1, dtFrame * 7);
    if (this.roll !== 0) this.rig.camera.rotateZ(this.roll);
    const boosting = st.boostT > 0;
    const targetFov = boosting ? 78 : 68;
    if (Math.abs(targetFov - this.fov) > 0.05) {
      this.fov += (targetFov - this.fov) * Math.min(1, dtFrame * 6);
      this.rig.camera.fov = this.fov;
      this.rig.camera.updateProjectionMatrix();
    }

    // infinite-corridor illusion: stars + ribs ride/recycle along z
    this.starGroup.position.z = st.z;
    for (const rib of this.ribs) {
      while (rib.position.z > st.z + 20) rib.position.z -= RIB_COUNT * RIB_SPACING;
    }

    // entities: reconcile id-keyed meshes against the live sim arrays
    this.reconcile(st.obstacles, st.pickups, dtFrame);

    // trail: continuous neon exhaust; hotter while boosting
    this.trailAcc += dtFrame;
    const tailZ = st.z + 1.0;
    while (this.trailAcc >= 0.028) {
      this.trailAcc -= 0.028;
      this.particles.burst({
        x: st.x,
        y: st.y,
        z: tailZ,
        count: 2,
        color: boosting ? AMBER : CYAN,
        speed: [0.4, 1.4],
        lifeSec: 0.32,
        gravity: 0,
      });
      if (boosting) {
        this.particles.burst({
          x: st.x,
          y: st.y,
          z: tailZ,
          count: 1,
          color: '#ffffff',
          speed: [1, 2.4],
          lifeSec: 0.18,
          gravity: 0,
        });
      }
    }

    this.particles.update(dtFrame);
    this.rig.focus(st.x, st.y, st.z);
  }

  private syncMenu(dtFrame: number): void {
    this.ship.visible = true;
    this.ship.position.set(0, Math.sin(performance.now() / 900) * 0.6, 0);
    this.ship.rotation.set(0, 0, 0);
    this.orbit?.update(dtFrame);
    this.starGroup.position.z = 0;
    this.trailAcc += dtFrame;
    while (this.trailAcc >= 0.06) {
      this.trailAcc -= 0.06;
      this.particles.burst({
        x: 0,
        y: this.ship.position.y,
        z: 1,
        count: 1,
        color: CYAN,
        speed: [0.3, 1],
        lifeSec: 0.4,
        gravity: 0,
      });
    }
    this.particles.update(dtFrame);
  }

  /** Bind/unbind pooled meshes so every live obstacle/pickup has exactly one. */
  private reconcile(obstacles: readonly Obstacle[], pickups: readonly Pickup[], dtFrame: number): void {
    const seen = new Set<number>();
    for (const o of obstacles) {
      seen.add(o.id);
      let b = this.bound.get(o.id);
      if (o.dead) {
        // absorbed by a shield save — gone in a burst, never rendered again
        if (b !== undefined) {
          this.releaseBound(b);
          this.bound.delete(o.id);
        }
        continue;
      }
      if (b === undefined) {
        b = { mesh: o.kind === 'rock' ? this.rockPool.acquire() : this.hoopPool.acquire(), kind: o.kind };
        this.bound.set(o.id, b);
      }
      b.mesh.position.set(o.x, o.y, o.z);
      o.phase += o.spin * dtFrame;
      b.mesh.rotation.z = o.phase;
      b.mesh.scale.setScalar(o.r); // rock icosphere + hoop torus both built at radius 1
    }
    for (const p of pickups) {
      seen.add(p.id);
      let b = this.bound.get(p.id);
      if (p.taken) {
        if (b !== undefined) {
          this.releaseBound(b);
          this.bound.delete(p.id);
        }
        continue;
      }
      if (b === undefined) {
        b = { mesh: this.pickupPool.acquire(), kind: 'pickup' };
        this.bound.set(p.id, b);
      }
      p.phase += dtFrame * 2.4;
      b.mesh.position.set(p.x, p.y, p.z);
      b.mesh.rotation.set(p.phase, p.phase * 0.7, 0);
    }
    for (const [id, b] of this.bound) {
      if (!seen.has(id)) {
        this.releaseBound(b);
        this.bound.delete(id);
      }
    }
  }

  private releaseBound(b: BoundMesh): void {
    if (b.kind === 'rock') this.rockPool.release(b.mesh);
    else if (b.kind === 'hoop') this.hoopPool.release(b.mesh);
    else this.pickupPool.release(b.mesh);
  }

  render(): void {
    this.rig.render();
  }

  resize(): void {
    this.rig.resize();
  }

  // ---- fx -----------------------------------------------------------------------

  explosion(x: number, y: number, z: number): void {
    this.particles.burst({ x, y, z, count: 44, color: AMBER, speed: [4, 13], lifeSec: 0.8, gravity: 0 });
    this.particles.burst({ x, y, z, count: 26, color: CYAN, speed: [3, 10], lifeSec: 0.65, gravity: 0 });
    this.particles.burst({ x, y, z, count: 16, color: '#ffffff', speed: [6, 16], lifeSec: 0.4, gravity: 0 });
  }

  shieldBurst(x: number, y: number, z: number): void {
    this.particles.burst({ x, y, z, count: 20, color: '#ffffff', speed: [2, 7], lifeSec: 0.5, gravity: 0 });
  }

  nearPing(x: number, y: number, z: number): void {
    this.particles.burst({ x, y, z, count: 8, color: CYAN, speed: [1, 4], lifeSec: 0.35, gravity: 0 });
  }

  pickupFx(x: number, y: number, z: number): void {
    this.particles.burst({ x, y, z, count: 14, color: CYAN, speed: [1.5, 5], lifeSec: 0.5, gravity: 0 });
  }

  dispose(): void {
    this.particles.dispose();
    for (const [, b] of this.bound) b.mesh.geometry.dispose();
    this.bound.clear();
    this.rig.dispose();
  }
}
