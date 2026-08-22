// ============================================================================
// SUMO RENDERER — flat-shaded candy arena on @platform/engine (specs/P10.md
// "Look"): slate platform with a vertex-color grid, starfield points backdrop,
// capsule players with canvas-sprite nameplates, pulsing shrink ring, pooled
// particles for dash afterimages and fall splashes.
//
// Camera: fixed 55° top-down-ish chase (dist 16 / height 22.5 => atan ≈ 54.6°)
// following YOUR interpolated position with a soft lag; yaw stays south so
// the arena reads like a board game.
// ============================================================================
import {
  FALL_Y,
  GRAVITY,
  PLATFORM_R_END,
  PLATFORM_R_START,
  SUMO_COLORS,
} from '@sumo/shared';
import { rng } from '@platform/shared';
import { ChaseCam, ParticlePool, SceneRig } from '@platform/engine';
import * as THREE from 'three';
import type { Sampled } from './net.js';

const GRID_STEP = 1.75; // u between grid lines at build time
const REBUILD_DELTA = 0.3; // rebuild the disc once the radius drifts this far
const CAPSULE_R = 0.6;
const CAPSULE_LEN = 0.8;
const CAM_DIST = 16;
const CAM_HEIGHT = 22.5; // atan(22.5/16) = 54.6deg ~= spec's 55

function smooth01(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

interface PlayerVisual {
  group: THREE.Group;
  capsule: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>;
  plate: THREE.Sprite;
  plateCanvas: HTMLCanvasElement;
  plateTex: THREE.CanvasTexture;
  lastName: string;
}

export interface RenderView {
  sampled: Sampled[];
  radius: number;
  phaseLive: boolean;
  dtFrame: number;
}

export class SumoRenderer {
  readonly rig: SceneRig;
  private readonly cam: ChaseCam;
  private readonly particles: ParticlePool;

  private readonly stars: THREE.Points;
  private readonly discGroup = new THREE.Group();
  private disc: THREE.Mesh | null = null;
  private builtRadius = -1;
  private readonly rim: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;

  private readonly players = new Map<string, PlayerVisual>();
  private clockS = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.rig = new SceneRig({
      canvas,
      skyColor: '#05070f',
      fovDeg: 60,
      shadowMapSize: 1024,
    });
    this.rig.setSun({
      dir: { x: -0.45, y: 1, z: 0.35 },
      color: '#cfe0ff',
      intensity: 1.15,
      groundColor: '#101726',
      hemiIntensity: 0.55,
      shadowExtent: 24,
    });

    // ---- starfield (seeded; Math.random is a repo violation) ---------------
    const next = rng(0x51eed + 7);
    const STAR_COUNT = 420;
    const pos = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      // shell 120..260u, biased away from straight down
      const u = next() * 2 - 1;
      const th = next() * Math.PI * 2;
      const r = 120 + next() * 140;
      pos[i * 3] = Math.cos(th) * Math.sqrt(1 - u * u) * r;
      pos[i * 3 + 1] = Math.abs(u) * r * 0.8 + 12;
      pos[i * 3 + 2] = Math.sin(th) * Math.sqrt(1 - u * u) * r;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: '#9fb4ff', size: 1.4, sizeAttenuation: false }),
    );
    this.stars.frustumCulled = false;
    this.rig.scene.add(this.stars);

    this.rig.scene.add(this.discGroup);

    // ---- shrink ring --------------------------------------------------------
    this.rim = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1.03, 96),
      new THREE.MeshBasicMaterial({
        color: '#ffb300',
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.rim.rotation.x = -Math.PI / 2;
    this.rim.position.y = 0.02;
    this.rig.scene.add(this.rim);

    this.particles = new ParticlePool(this.rig.scene, { particles: 256 });
    this.cam = new ChaseCam(this.rig.camera, { dist: CAM_DIST, height: CAM_HEIGHT, lag: 10 });
    this.cam.track({ x: 0, y: 0, z: 0 }, 0);
    this.cam.snap();
  }

  /** Per-frame sync + draw. */
  update(view: RenderView, youPos: { x: number; y: number; z: number } | null): void {
    this.clockS += view.dtFrame;

    // ---- platform -----------------------------------------------------------
    this.syncPlatform(view.radius, view.phaseLive);
    this.rim.scale.setScalar(Math.max(0.001, view.radius));
    // pulse quickens as the floor closes in
    const urgency = 1 - Math.min(1, (view.radius - PLATFORM_R_END) / (PLATFORM_R_START - PLATFORM_R_END));
    this.rim.material.opacity = 0.35 + 0.4 * urgency * (0.5 + 0.5 * Math.sin(this.clockS * (4 + urgency * 6)));
    this.rim.material.color.setStyle(urgency > 0.72 ? '#ff5d73' : '#ffb300');

    // ---- players ------------------------------------------------------------
    const seen = new Set<string>();
    for (const p of view.sampled) {
      seen.add(p.id);
      const vis = this.acquire(p);
      vis.group.visible = p.alive || p.y > FALL_Y;
      if (!vis.group.visible) continue;
      vis.group.position.set(p.x, p.y + CAPSULE_R + CAPSULE_LEN / 2, p.z);
      vis.group.rotation.y = p.yaw;
      // dash flash: emissive pop + afterimage trail
      const mat = vis.capsule.material;
      mat.emissiveIntensity = p.dashing ? 0.9 : 0;
      if (p.dashing && Math.random() < 0.5) {
        const col = SUMO_COLORS[p.color % SUMO_COLORS.length] ?? '#ffffff';
        this.particles.burst({
          x: p.x,
          y: p.y + 0.5,
          z: p.z,
          count: 2,
          color: col,
          speed: [0.2, 1],
          lifeSec: 0.28,
          gravity: 0,
        });
      }
      if (!p.alive) {
        // falling out: tumble + fade via scale
        const k = Math.max(0.25, 1 + p.y / Math.abs(FALL_Y));
        vis.group.scale.setScalar(k);
      } else {
        vis.group.scale.setScalar(1);
      }
    }
    for (const [id, vis] of this.players) {
      if (!seen.has(id)) {
        this.disposePlayer(vis);
        this.players.delete(id);
      }
    }

    this.particles.update(view.dtFrame);

    // ---- camera follows YOU (fixed south yaw -> constant 55deg top-down) ----
    const target =
      youPos ??
      (() => {
        let cx = 0;
        let cz = 0;
        let n = 0;
        for (const p of view.sampled) {
          if (!p.alive) continue;
          cx += p.x;
          cz += p.z;
          n++;
        }
        return n > 0 ? { x: cx / n, z: cz / n } : { x: 0, z: 0 };
      })();
    this.cam.track({ x: target.x, y: 0, z: target.z }, 0);
    this.cam.update(view.dtFrame);
    this.rig.focus(target.x, 0, target.z);
    this.rig.render();
  }

  /** One-shot FX helpers (audio lives in app.ts). */

  splash(x: number, y: number, z: number, colorIdx: number): void {
    this.particles.burst({
      x,
      y: Math.max(y, -2),
      z,
      count: 26,
      color: SUMO_COLORS[colorIdx % SUMO_COLORS.length] ?? '#ffffff',
      speed: [3, 8],
      lifeSec: 0.7,
      gravity: GRAVITY * 0.6,
    });
  }

  thud(x: number, y: number, z: number): void {
    this.particles.burst({ x, y: y + 0.4, z, count: 6, color: '#cfd8ea', speed: [1, 2.4], lifeSec: 0.25 });
  }

  resize(): void {
    this.rig.resize();
  }

  dispose(): void {
    for (const vis of this.players.values()) this.disposePlayer(vis);
    this.players.clear();
    this.disc?.geometry.dispose();
    this.rim.geometry.dispose();
    this.rim.material.dispose();
    this.stars.geometry.dispose();
    (this.stars.material as THREE.Material).dispose();
    this.particles.dispose();
    this.rig.dispose();
  }

  // ---- internals -------------------------------------------------------------

  private acquire(p: Sampled): PlayerVisual {
    let vis = this.players.get(p.id);
    if (vis === undefined) {
      vis = this.buildPlayer();
      this.players.set(p.id, vis);
    }
    if (vis.lastName !== p.name) {
      vis.lastName = p.name;
      const hex = SUMO_COLORS[p.color % SUMO_COLORS.length] ?? '#ffffff';
      this.paintPlate(vis, p.name, hex);
      vis.capsule.material.color.set(hex); // candy body tinted on first sight
      vis.capsule.material.emissive.set(hex);
    }
    return vis;
  }

  private buildPlayer(): PlayerVisual {
    const group = new THREE.Group();
    const capsule = new THREE.Mesh(
      new THREE.CapsuleGeometry(CAPSULE_R, CAPSULE_LEN, 6, 14),
      new THREE.MeshStandardMaterial({
        color: '#ffffff',
        roughness: 0.55,
        flatShading: true,
        emissive: new THREE.Color('#000000'),
        emissiveIntensity: 0,
      }),
    );
    capsule.castShadow = true;
    group.add(capsule);

    const plateCanvas = document.createElement('canvas');
    plateCanvas.width = 256;
    plateCanvas.height = 64;
    const plateTex = new THREE.CanvasTexture(plateCanvas);
    const plate = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: plateTex, transparent: true, depthWrite: false }),
    );
    plate.scale.set(2.4, 0.6, 1);
    plate.position.y = 1.75;
    group.add(plate);

    this.rig.scene.add(group);
    return { group, capsule, plate, plateCanvas, plateTex, lastName: '' };
  }

  private paintPlate(vis: PlayerVisual, name: string, colorHex: string): void {
    const ctx = vis.plateCanvas.getContext('2d');
    if (ctx === null) return;
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = '700 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(name, 128, 34);
    ctx.fillStyle = colorHex;
    ctx.fillText(name, 128, 34);
    vis.plateTex.needsUpdate = true;
  }

  private disposePlayer(vis: PlayerVisual): void {
    vis.capsule.geometry.dispose();
    vis.capsule.material.dispose();
    vis.plate.material.map?.dispose();
    vis.plate.material.dispose();
    vis.group.removeFromParent();
  }

  /**
   * Slate disc with a vertex-color grid. Rebuilt only when the live radius
   * drifts past REBUILD_DELTA from the built one; scaled in between so the
   * shrink reads continuously without re-tessellating every tick.
   */
  private syncPlatform(radius: number, _live: boolean): void {
    const clamped = Math.max(PLATFORM_R_END, Math.min(PLATFORM_R_START, radius));
    if (this.disc !== null && Math.abs(clamped - this.builtRadius) <= REBUILD_DELTA) {
      this.disc.scale.setScalar(clamped / Math.max(1e-4, this.builtRadius));
      return;
    }
    if (this.disc !== null) {
      this.discGroup.remove(this.disc);
      this.disc.geometry.dispose();
      (this.disc.material as THREE.Material).dispose();
      this.disc = null;
    }
    this.builtRadius = clamped;
    this.disc = this.buildDisc(clamped);
    this.discGroup.add(this.disc);
  }

  private buildDisc(radius: number): THREE.Mesh {
    const SEGMENTS = 96;
    const RINGS = Math.max(8, Math.round(radius / 1.1)); // ~1.1u ring spacing
    const base = new THREE.Color('#39435c');
    const line = new THREE.Color('#5b6a8f');
    const rimDark = new THREE.Color('#232b40');

    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const c = new THREE.Color();

    const pushVertex = (x: number, z: number, edgeT: number): number => {
      positions.push(x, 0, z);
      // grid proximity: distance to nearest lattice line on either axis
      const gx = Math.abs(x / GRID_STEP - Math.round(x / GRID_STEP)) * GRID_STEP;
      const gz = Math.abs(z / GRID_STEP - Math.round(z / GRID_STEP)) * GRID_STEP;
      const g = Math.min(gx, gz);
      c.copy(base).lerp(line, smooth01((0.09 - g) / 0.09) * 0.85);
      c.lerp(rimDark, edgeT); // darker toward the rim
      colors.push(c.r, c.g, c.b);
      return positions.length / 3 - 1;
    };

    pushVertex(0, 0, 0); // center = index 0
    for (let ring = 1; ring <= RINGS; ring++) {
      const rr = (ring / RINGS) * radius;
      const edgeT = smooth01((rr / radius - 0.86) / 0.14) * 0.65;
      for (let s = 0; s < SEGMENTS; s++) {
        const a = (s / SEGMENTS) * Math.PI * 2;
        pushVertex(Math.cos(a) * rr, Math.sin(a) * rr, edgeT);
      }
    }
    // Winding chosen so computeVertexNormals yields +Y normals (floor up).
    for (let s = 0; s < SEGMENTS; s++) {
      const s1 = (s + 1) % SEGMENTS;
      indices.push(0, 1 + s, 1 + s1);
    }
    for (let ring = 1; ring < RINGS; ring++) {
      const outerBase = 1 + (ring - 1) * SEGMENTS;
      const innerBase = 1 + ring * SEGMENTS;
      for (let s = 0; s < SEGMENTS; s++) {
        const s1 = (s + 1) % SEGMENTS;
        indices.push(outerBase + s, outerBase + s1, innerBase + s);
        indices.push(outerBase + s1, innerBase + s1, innerBase + s);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.92,
        metalness: 0.05,
        side: THREE.DoubleSide,
      }),
    );
    mesh.receiveShadow = true;
    return mesh;
  }
}
