// ============================================================================
// ANCIENTS (rift) — FX (CONTRACT §6 render/fx.ts). Pooled, zero per-frame
// allocation, zero Math.random (deterministic golden-angle scatter patterns):
//   - particle bursts: ONE InstancedMesh pool (last-hit gold spark, death
//     puff, tower collapse debris, cast flashes per school: physical `paper`,
//     magic `arcane`, heal `heal`);
//   - attack tracers: a small pool of stretched-box beams with per-slot
//     fade materials, driven by game.ts from InterpEnt.atk transitions;
//   - screen shake: decaying sinusoid fed into the scene's camera rig;
//   - damage numbers: pooled `.dmg-number` DOM nodes on the scene overlay
//     (`gold` bounty / `danger` taken / `paper` dealt — inline APAL hexes;
//     the base class styling lives in T8's style.css).
// ============================================================================
import * as THREE from 'three';
import { APAL } from '@rift/shared';
import type { FxHandle, SceneHandle } from '../contract.js';
import { sceneCore } from './scene.js';

const PARTICLE_CAP = 240;
const TRACER_CAP = 24;
const NUMBER_CAP = 26;
const TRACER_LIFE_S = 0.26; // long enough to read at 20Hz snap cadence
const NUMBER_LIFE_S = 0.9;
/** Golden angle — deterministic scatter, no rng stream needed for pure fx. */
const GOLDEN_ANGLE = 2.399963229728653;

type BurstKind = 'gold' | 'death' | 'tower' | 'phys' | 'magic' | 'heal';

interface BurstSpec {
  readonly count: number;
  readonly a: string;
  readonly b: string;
  readonly speed: number;
  readonly up: number;
  readonly size: number;
  readonly life: number;
  readonly y0: number;
  readonly y1: number;
}

const BURSTS: Record<BurstKind, BurstSpec> = {
  gold: { count: 10, a: APAL.gold, b: APAL.goldLit, speed: 2.2, up: 3.4, size: 1.0, life: 0.55, y0: 0.5, y1: 1.2 },
  death: { count: 12, a: APAL.paperDim, b: APAL.inkLit, speed: 2.6, up: 2.6, size: 1.3, life: 0.6, y0: 0.3, y1: 1.0 },
  tower: { count: 22, a: APAL.monumentLit, b: APAL.stoneDeep, speed: 4.2, up: 4.6, size: 2.0, life: 0.9, y0: 0.4, y1: 3.2 },
  phys: { count: 8, a: APAL.paper, b: APAL.goldLit, speed: 2.4, up: 2.2, size: 0.8, life: 0.4, y0: 0.7, y1: 1.4 },
  magic: { count: 10, a: APAL.arcane, b: APAL.void, speed: 2.6, up: 2.6, size: 1.0, life: 0.5, y0: 0.7, y1: 1.6 },
  heal: { count: 10, a: APAL.heal, b: APAL.goldLit, speed: 1.6, up: 2.8, size: 0.9, life: 0.6, y0: 0.4, y1: 1.2 },
};

interface TracerSlot {
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial;
  life: number;
}

interface NumberSlot {
  el: HTMLDivElement;
  active: boolean;
  x: number;
  z: number;
  age: number;
}

export function createFx(scene: SceneHandle): FxHandle {
  const core = sceneCore(scene);

  // ---- particle pool (one InstancedMesh) ----------------------------------------
  const pMesh = new THREE.InstancedMesh(
    new THREE.OctahedronGeometry(0.09),
    core.mat(APAL.paper),
    PARTICLE_CAP,
  );
  pMesh.frustumCulled = false;
  pMesh.count = PARTICLE_CAP;
  core.three.add(pMesh);
  const px = new Float32Array(PARTICLE_CAP);
  const py = new Float32Array(PARTICLE_CAP);
  const pz = new Float32Array(PARTICLE_CAP);
  const vx = new Float32Array(PARTICLE_CAP);
  const vy = new Float32Array(PARTICLE_CAP);
  const vz = new Float32Array(PARTICLE_CAP);
  const life = new Float32Array(PARTICLE_CAP);
  const maxLife = new Float32Array(PARTICLE_CAP);
  const size = new Float32Array(PARTICLE_CAP);
  let pCursor = 0;
  const pM = new THREE.Matrix4();
  const pC = new THREE.Color();
  // park every instance at zero scale once
  pM.makeScale(0, 0, 0);
  for (let i = 0; i < PARTICLE_CAP; i++) {
    pMesh.setMatrixAt(i, pM);
    pMesh.setColorAt(i, pC.set(APAL.paper));
  }
  pMesh.instanceMatrix.needsUpdate = true;
  if (pMesh.instanceColor) pMesh.instanceColor.needsUpdate = true;

  // ---- tracer pool ------------------------------------------------------------------
  // 0.12m-square beam cross-section: readable at default gameplay zoom (36m).
  const tracerGeo = new THREE.BoxGeometry(1, 0.12, 0.12);
  const tracers: TracerSlot[] = [];
  for (let i = 0; i < TRACER_CAP; i++) {
    const mat = new THREE.MeshLambertMaterial({
      color: APAL.paper,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(tracerGeo, mat);
    mesh.visible = false;
    core.three.add(mesh);
    tracers.push({ mesh, mat, life: 0 });
  }
  let tCursor = 0;

  // ---- shake ---------------------------------------------------------------------------
  let shakeAmp = 0;
  let shakePhase = 0;

  // ---- damage numbers (DOM pool) ---------------------------------------------------------
  const numbers: NumberSlot[] = [];
  for (let i = 0; i < NUMBER_CAP; i++) {
    const el = document.createElement('div');
    el.className = 'dmg-number';
    el.style.position = 'absolute';
    el.style.pointerEvents = 'none';
    el.style.display = 'none';
    el.style.willChange = 'transform, opacity';
    core.overlay.appendChild(el);
    numbers.push({ el, active: false, x: 0, z: 0, age: 0 });
  }
  let nCursor = 0;
  const screenPt = { x: 0, y: 0 };

  // ---- API --------------------------------------------------------------------------------
  function burst(x: number, z: number, kind: BurstKind): void {
    const spec = BURSTS[kind];
    for (let n = 0; n < spec.count; n++) {
      const i = pCursor;
      pCursor = (pCursor + 1) % PARTICLE_CAP;
      const a = n * GOLDEN_ANGLE;
      const speed = spec.speed * (0.6 + ((n % 5) / 5) * 0.8);
      px[i] = x;
      pz[i] = z;
      py[i] = spec.y0 + ((n % 7) / 7) * (spec.y1 - spec.y0);
      vx[i] = Math.cos(a) * speed;
      vz[i] = Math.sin(a) * speed;
      vy[i] = spec.up * (0.7 + ((n % 4) / 4) * 0.6);
      maxLife[i] = spec.life * (0.75 + ((n % 3) / 3) * 0.5);
      life[i] = maxLife[i] ?? spec.life;
      size[i] = spec.size * (0.7 + ((n % 3) / 3) * 0.6);
      pMesh.setColorAt(i, pC.set(n % 2 === 0 ? spec.a : spec.b));
    }
    if (pMesh.instanceColor) pMesh.instanceColor.needsUpdate = true;
  }

  function tracer(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    kind: 'phys' | 'magic' | 'tower',
  ): void {
    const slot = tracers[tCursor];
    tCursor = (tCursor + 1) % TRACER_CAP;
    if (!slot) return;
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    const y1 = kind === 'tower' ? 3.4 : 1.05;
    slot.mat.color.set(kind === 'phys' ? APAL.paper : kind === 'magic' ? APAL.arcane : APAL.goldLit);
    slot.mesh.position.set((x1 + x2) / 2, (y1 + 1.0) / 2, (z1 + z2) / 2);
    slot.mesh.scale.set(len, 1, 1);
    slot.mesh.rotation.y = Math.atan2(-dz, dx);
    slot.life = TRACER_LIFE_S;
    slot.mesh.visible = true;
  }

  function shake(amount: number): void {
    shakeAmp = Math.min(1.6, shakeAmp + Math.max(0, amount));
  }

  function damageNumber(x: number, z: number, text: string, cls: 'gold' | 'danger' | 'paper'): void {
    const slot = numbers[nCursor];
    nCursor = (nCursor + 1) % NUMBER_CAP;
    if (!slot) return;
    slot.active = true;
    slot.x = x;
    slot.z = z;
    slot.age = 0;
    slot.el.textContent = text;
    slot.el.style.color =
      cls === 'gold' ? APAL.gold : cls === 'danger' ? APAL.danger : APAL.paper;
    slot.el.style.display = 'block';
  }

  function tick(dtMs: number): void {
    const dt = dtMs / 1000;

    // particles
    let anyAlive = false;
    for (let i = 0; i < PARTICLE_CAP; i++) {
      const l = life[i] ?? 0;
      if (l <= 0) continue;
      anyAlive = true;
      const nl = l - dt;
      life[i] = nl;
      if (nl <= 0) {
        pM.makeScale(0, 0, 0);
        pMesh.setMatrixAt(i, pM);
        continue;
      }
      vy[i] = (vy[i] ?? 0) - 11 * dt;
      px[i] = (px[i] ?? 0) + (vx[i] ?? 0) * dt;
      py[i] = Math.max(0.04, (py[i] ?? 0) + (vy[i] ?? 0) * dt);
      pz[i] = (pz[i] ?? 0) + (vz[i] ?? 0) * dt;
      const ml = maxLife[i] ?? 1;
      const s = (size[i] ?? 1) * (nl / ml);
      pM.makeScale(s, s, s);
      pM.setPosition(px[i] ?? 0, py[i] ?? 0, pz[i] ?? 0);
      pMesh.setMatrixAt(i, pM);
    }
    if (anyAlive) pMesh.instanceMatrix.needsUpdate = true;

    // tracers
    for (const t of tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.mesh.visible = false;
        t.mat.opacity = 0;
      } else {
        t.mat.opacity = 0.9 * (t.life / TRACER_LIFE_S);
      }
    }

    // shake: decaying sinusoid, fed to the camera rig
    if (shakeAmp > 0.005) {
      shakePhase += dt * 34;
      shakeAmp *= Math.max(0, 1 - 5.2 * dt);
      core.setShake(
        Math.sin(shakePhase) * shakeAmp * 0.35,
        Math.cos(shakePhase * 1.31) * shakeAmp * 0.35,
      );
    } else if (shakeAmp !== 0) {
      shakeAmp = 0;
      core.setShake(0, 0);
    }

    // damage numbers
    for (const n of numbers) {
      if (!n.active) continue;
      n.age += dt;
      if (n.age >= NUMBER_LIFE_S) {
        n.active = false;
        n.el.style.display = 'none';
        continue;
      }
      if (!core.worldToScreen(n.x, 1.6, n.z, screenPt)) {
        n.el.style.display = 'none';
        continue;
      }
      n.el.style.display = 'block';
      const rise = n.age * 42;
      n.el.style.transform = `translate(-50%, -50%) translate(${screenPt.x.toFixed(1)}px, ${(screenPt.y - rise).toFixed(1)}px)`;
      n.el.style.opacity = (1 - n.age / NUMBER_LIFE_S).toFixed(3);
    }
  }

  return { burst, tracer, shake, damageNumber, tick };
}
