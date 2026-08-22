// ============================================================================
// GHOSTRUN RENDER — sunset world built ONLY on @platform/engine + three
// (docs/PLATFORM.md §4.6). Vertex-color sky dome, amber decks over ink
// bodies (baked static via prims.bake), three dynamic ferry blocks, the
// translucent teal ghost capsule interpolated from replay samples, a white
// finish flag, a pulsing ring on the next checkpoint, pooled speed-line
// tracers/dust/confetti, and long shadows from the rig's low sun.
//
// Camera law (spec): applyFpsCam while running; OrbitCam on the menu.
// ============================================================================

import {
  OrbitCam,
  ParticlePool,
  SceneRig,
  TracerPool,
  applyFpsCam,
  bake,
  box as primBox,
  cyl,
  mat,
} from '@platform/engine';
import * as THREE from 'three';
import { PHYS } from './sim.js';
import type { GhostSamples, GhostPose } from './sim.js';
import { sampleGhost } from './sim.js';
import type { Track } from './track.js';
import { movingBlockPose } from './track.js';

// palette (house: CSS hex strings everywhere)
const AMBER = '#f2a65a';
const AMBER_HI = '#ffc98a';
const INK = '#1d1626';
const INK_BLOCK = '#241f30';
const TEAL = '#35d0c5';
const WHITE = '#f4f7fa';
const DUSK_FOG = '#3a2b45';

const DOME_RADIUS = 420;
const CONFETTI_COLORS = ['#ffd166', '#ef6f6c', '#59c3ff', '#8ce99a'] as const;

export interface RenderView {
  mode: 'menu' | 'run';
  px: number;
  py: number;
  pz: number;
  camYaw: number;
  pitch: number;
  airTime: number;
  vx: number;
  vz: number;
  timeMs: number;
  /** Platform index of the next unclaimed checkpoint (-1 → hide beacon). */
  nextCpIndex: number;
}

export class GameRenderer {
  readonly rig: SceneRig;

  private readonly particles: ParticlePool;
  private readonly tracers: TracerPool;
  private orbit: OrbitCam | null = null;
  private readonly orbitCenter = new THREE.Vector3();

  private readonly blocks: THREE.Group[] = [];
  private ghost: THREE.Mesh | null = null;
  private beacon: THREE.Mesh | null = null;
  private dome: THREE.Mesh | null = null;
  private ghostSamples: GhostSamples | null = null;
  private lineTimer = 0;
  private track: Track | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.rig = new SceneRig({
      canvas,
      fovDeg: 72,
      far: 900,
      skyColor: '#191225',
      fogColor: DUSK_FOG,
      fogDensity: 0.0055,
      shadowMapSize: 2048,
      exposure: 1.05,
    });
    // low sun → the long shadows the spec asks for
    this.rig.setSun({
      dir: { x: -0.55, y: 0.38, z: 0.74 },
      color: '#ffb36b',
      intensity: 2.4,
      groundColor: '#3a2c46',
      hemiIntensity: 0.65,
      shadowExtent: 26,
    });

    this.particles = new ParticlePool(this.rig.scene, { particles: 512 });
    this.tracers = new TracerPool(this.rig.scene, { tracers: 96 });
  }

  // ---- world ------------------------------------------------------------------

  /** Build every mesh for this track. Call once per loaded track. */
  buildWorld(track: Track): void {
    this.track = track;
    const scene = this.rig.scene;
    const root = new THREE.Group();
    scene.add(root);

    // -- sky dome: vertex-color sunset gradient --
    const domeGeo = new THREE.SphereGeometry(DOME_RADIUS, 32, 24);
    const posAttr = domeGeo.getAttribute('position') as THREE.BufferAttribute;
    const colors = new Float32Array(posAttr.count * 3);
    const horizon = new THREE.Color('#ff9d6a');
    const zenith = new THREE.Color('#2b2350');
    const below = new THREE.Color('#191225');
    const c = new THREE.Color();
    for (let i = 0; i < posAttr.count; i++) {
      const ny = (posAttr.getY(i) as number) / DOME_RADIUS;
      if (ny >= 0) c.copy(horizon).lerp(zenith, Math.pow(ny, 0.75));
      else c.copy(horizon).lerp(below, Math.pow(-ny, 0.6));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    domeGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const dome = new THREE.Mesh(
      domeGeo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    dome.renderOrder = -10;
    this.dome = dome;
    scene.add(dome);

    // -- platforms: ink body + amber deck (ramps get rotated slabs) --
    for (const p of track.platforms) {
      const bottom = Math.min(p.y0, p.y1) - p.thick;
      if (p.rampAxis === 0) {
        const bodyTop = p.y0 - 0.16;
        root.add(
          primBox({
            x: p.cx,
            y: (bottom + bodyTop) / 2,
            z: p.cz,
            w: p.hw * 2,
            h: Math.max(0.16, bodyTop - bottom),
            d: p.hd * 2,
            mat: { color: INK },
          }),
        );
        root.add(
          primBox({
            x: p.cx,
            y: p.y0 - 0.08,
            z: p.cz,
            w: p.hw * 2,
            h: 0.16,
            d: p.hd * 2,
            mat: { color: AMBER, roughness: 0.8 },
          }),
        );
        if (p.kind === 'start' || p.kind === 'finish') {
          root.add(
            primBox({
              x: p.cx,
              y: p.y0 + 0.02,
              z: p.cz,
              w: p.hw * 2 - 0.7,
              h: 0.05,
              d: p.hd * 2 - 0.7,
              mat: { color: TEAL, roughness: 0.6, emissive: 0.35 },
            }),
          );
        }
      } else {
        const alongZ = p.rampAxis === 2;
        const run = (alongZ ? p.hd : p.hw) * 2;
        const rise = p.y1 - p.y0;
        const len = Math.hypot(run, rise);
        // slab center rides the midpoint of the sloped top line
        const midY = (p.y0 + p.y1) / 2 - 0.08 + 0.06;
        const geo = alongZ
          ? new THREE.BoxGeometry(p.hw * 2, 0.16, len)
          : new THREE.BoxGeometry(len, 0.16, p.hd * 2);
        const slab = new THREE.Mesh(geo, mat({ color: AMBER, roughness: 0.8 }));
        slab.position.set(p.cx, midY, p.cz);
        const halfDelta = (rise / 2) * p.rampDir; // height of the +axis end vs center
        if (alongZ) slab.rotation.x = Math.atan2(-halfDelta, run / 2);
        else slab.rotation.z = Math.atan2(halfDelta, run / 2);
        slab.castShadow = true;
        slab.receiveShadow = true;
        root.add(slab);
        root.add(
          primBox({
            x: p.cx,
            y: (bottom + Math.min(p.y0, p.y1)) / 2 + 0.03,
            z: p.cz,
            w: p.hw * 2,
            h: Math.min(p.y0, p.y1) - bottom + 0.06,
            d: p.hd * 2,
            mat: { color: INK },
          }),
        );
      }
    }

    // -- checkpoint posts --
    for (const cp of track.checkpoints) {
      root.add(
        primBox({
          x: cp.pos.x,
          y: cp.pos.y + 0.85,
          z: cp.pos.z,
          w: 0.14,
          h: 1.7,
          d: 0.14,
          mat: { color: TEAL, roughness: 0.5, emissive: 0.9 },
        }),
      );
    }

    // -- finish flag (white, per spec) --
    const f = track.finishPos;
    root.add(cyl({ x: f.x, y: f.y + 1.6, z: f.z, rTop: 0.06, rBot: 0.06, h: 3.2, mat: { color: WHITE, roughness: 0.5 } }));
    root.add(
      primBox({
        x: f.x + 0.58,
        y: f.y + 2.85,
        z: f.z,
        w: 1.05,
        h: 0.62,
        d: 0.05,
        mat: { color: WHITE, roughness: 0.55, emissive: 0.75 },
      }),
    );

    bake(root); // house rule: static geometry bakes

    // -- ferry blocks (dynamic, never baked) --
    for (let bi = 0; bi < track.movingBlocks.length; bi++) {
      const b = track.movingBlocks[bi] as (typeof track.movingBlocks)[number];
      const g = new THREE.Group();
      g.add(
        primBox({ x: 0, y: 0, z: 0, w: b.hw * 2, h: b.hh * 2, d: b.hd * 2, mat: { color: INK_BLOCK, roughness: 0.85 } }),
      );
      g.add(
        primBox({
          x: 0,
          y: b.hh + 0.03,
          z: 0,
          w: b.hw * 2 - 0.12,
          h: 0.07,
          d: b.hd * 2 - 0.12,
          mat: { color: TEAL, roughness: 0.5, emissive: 0.85 },
        }),
      );
      g.position.set(b.bx, b.by, b.bz);
      scene.add(g);
      this.blocks.push(g);
    }

    // -- next-checkpoint beacon --
    const beacon = new THREE.Mesh(
      new THREE.TorusGeometry(1.15, 0.055, 8, 40),
      new THREE.MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0.85 }),
    );
    beacon.rotation.x = -Math.PI / 2;
    this.beacon = beacon;
    scene.add(beacon);

    // -- the ghost --
    const ghost = new THREE.Mesh(
      new THREE.CapsuleGeometry(PHYS.radius, PHYS.height - PHYS.radius * 2, 6, 14),
      new THREE.MeshStandardMaterial({
        color: TEAL,
        transparent: true,
        opacity: 0.42,
        roughness: 0.35,
        emissive: '#0e6e66',
        emissiveIntensity: 0.55,
        depthWrite: false,
      }),
    );
    ghost.visible = false;
    this.ghost = ghost;
    scene.add(ghost);

    // -- menu orbit target: mid-course, a little above the average deck --
    const s = track.startPos;
    this.orbitCenter.set((s.x + f.x) / 2, (s.y + f.y) / 2 + 5, (s.z + f.z) / 2);
    this.orbit = new OrbitCam(this.rig.camera, { radius: 46, height: 27, rotSpeed: 0.22 });
    this.orbit.center(this.orbitCenter);
  }

  // ---- per-frame -----------------------------------------------------------------

  setGhost(samples: GhostSamples | null): void {
    this.ghostSamples = samples;
    if (this.ghost !== null) this.ghost.visible = samples !== null && samples.t.length > 1;
  }

  sync(v: RenderView, dtFrame: number): void {
    // cameras first (the dome trails whichever camera is live)
    if (v.mode === 'menu') {
      this.orbit?.update(dtFrame);
    } else {
      applyFpsCam(
        this.rig.camera,
        { x: v.px, y: v.py, z: v.pz },
        v.camYaw,
        v.pitch,
        PHYS.eyeHeight,
      );
    }
    if (this.dome !== null) {
      this.dome.position.set(this.rig.camera.position.x, 0, this.rig.camera.position.z);
    }

    // ferries
    if (this.track !== null && this.blocks.length > 0) {
      const poses = movingBlockPose(this.track, v.timeMs / 1000);
      for (let i = 0; i < this.blocks.length; i++) {
        const pose = poses[i];
        const g = this.blocks[i];
        if (pose !== undefined && g !== undefined) g.position.set(pose.x, pose.y, pose.z);
      }
    }

    // ghost replay
    if (this.ghost !== null && this.ghost.visible && this.ghostSamples !== null) {
      const pose: GhostPose | null = sampleGhost(this.ghostSamples, v.timeMs);
      if (pose !== null) {
        this.ghost.position.set(pose.x, pose.y + PHYS.height / 2, pose.z);
        this.ghost.rotation.y = pose.yaw;
      }
    }

    // next-checkpoint ring
    if (this.beacon !== null) {
      if (v.nextCpIndex >= 0 && this.track !== null) {
        const cp = this.track.checkpoints[v.nextCpIndex];
        if (cp !== undefined) {
          this.beacon.visible = true;
          const pulse = 1 + Math.sin(v.timeMs / 1000 * 5) * 0.12;
          this.beacon.scale.setScalar(pulse);
          this.beacon.position.set(cp.pos.x, cp.pos.y + 0.25, cp.pos.z);
        }
      } else {
        this.beacon.visible = false;
      }
    }

    // speed lines while airborne past the grace window
    const hSpeed = Math.hypot(v.vx, v.vz);
    if (v.mode === 'run' && v.airTime > 0.5 && hSpeed > 4) {
      this.lineTimer += dtFrame;
      while (this.lineTimer >= 0.045) {
        this.lineTimer -= 0.045;
        const inv = 1 / hSpeed;
        const dx = v.vx * inv;
        const dz = v.vz * inv;
        const jx = (Math.random() - 0.5) * 1.6;
        const jy = Math.random() * 1.3 + 0.2;
        const jz = (Math.random() - 0.5) * 1.6;
        this.tracers.spawn(
          { x: v.px + jx - dx * 1.1, y: v.py + jy, z: v.pz + jz - dz * 1.1 },
          { x: v.px + jx - dx * 2.9, y: v.py + jy, z: v.pz + jz - dz * 2.9 },
          '#ffffff',
        );
      }
    } else {
      this.lineTimer = 0;
    }

    this.particles.update(dtFrame);
    this.tracers.update(dtFrame);
    this.rig.focus(v.px, v.py, v.pz);
  }

  render(): void {
    this.rig.render();
  }

  resize(): void {
    this.rig.resize();
  }

  // ---- fx -----------------------------------------------------------------------

  landDust(x: number, y: number, z: number): void {
    this.particles.burst({ x, y: y + 0.06, z, count: 12, color: '#d9b38c', speed: [1.2, 3], lifeSec: 0.45, gravity: -7 });
  }

  jumpPuff(x: number, y: number, z: number): void {
    this.particles.burst({ x, y: y + 0.06, z, count: 6, color: '#e8cba4', speed: [0.8, 2], lifeSec: 0.35, gravity: -4 });
  }

  confetti(x: number, y: number, z: number): void {
    for (const color of CONFETTI_COLORS) {
      this.particles.burst({ x, y: y + 1, z, count: 30, color, speed: [3, 7.5], lifeSec: 1.1, gravity: -9 });
    }
  }

  dispose(): void {
    this.particles.dispose();
    this.tracers.dispose();
    this.rig.renderer.dispose();
  }
}
