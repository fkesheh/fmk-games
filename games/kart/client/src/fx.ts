// ============================================================================
// KART GP — juice/particle layer (app-owned; wired from the frame loop in
// app.ts). Pooled, zero-alloc-per-frame: every pool slot (mesh + material) is
// allocated ONCE at construction and recycled ring-buffer style; the per-frame
// update only writes transforms/opacity into live slots. All randomness is
// seeded (@platform/shared rng — Math.random is a contract violation). KPAL
// colors only. Effects:
//   skid   — persistent dark streak decals on the road (drift / hard braking),
//            pool of SKID_POOL quads laid flat, fading over SKID_FADE_S.
//   smoke  — small gray-white drift puffs (billboarded soft sprites).
//   dust   — tan off-road puffs (same puff pool, KPAL.dirt tint).
//   sparks — brief orange burst on a barrier hit.
//   trail  — short gold speed-line streaks left behind a nitro-boosting kart.
//   speed lines — DOM overlay streaks at the screen edges above SPEEDLINE_MIN
//            m/s (no WebGL, opacity-only per-frame writes).
// The module attaches its pools to the scene graph via KartFx.sceneRoot():
// KartScene's public API is frozen (docs/KART.md) with no scene-graph
// accessor, so the fx root is read structurally — render.ts is never modified.
// If the root is unavailable the 3D pools are simply never built and every
// emitter is a safe no-op (juice must never crash a race).
// ============================================================================
import * as THREE from 'three';
import { KPAL } from '@kart/shared';
import { decoSeed, rng, rngRange } from '@platform/shared';
import type { KartScene } from './render.js';

// ---- pool sizes (fixed at construction; reused forever) ---------------------
const SKID_POOL = 128; // spec: ~128 persistent marks
const PUFF_POOL = 56; // smoke + dust share one pool (tint per spawn)
const SPARK_POOL = 32;
const TRAIL_POOL = 28;
const SPEEDLINE_COUNT = 8;

// ---- tuning ------------------------------------------------------------------
const SKID_FADE_S = 20; // spec: marks fade over ~20s
const SKID_MAX_OPACITY = 0.9;
const SKID_HALO_OPACITY = 0.5; // charcoal feather strength relative to the core
const SKID_Y = 0.019; // above ALL baked road detail (trackMesh grime 0.013,
// baked apex skids 0.016, patches 0.017), below the dashes (0.02)
const SKID_W = 0.26; // tire-contact width
const SKID_LEN = 0.75; // quad length (app spaces marks ~0.5m — slight overlap)
const PUFF_LIFE_S = 0.65; // short persistence: discrete puffs, road shows through
const SPARK_LIFE_S = 0.4;
const SPARK_BURST = 7;
const SPARK_GRAVITY = 16; // m/s² — heavier than earth reads snappier at this scale
const TRAIL_LIFE_S = 0.3;
const TRAIL_LEN = 1.4;
const SPEEDLINE_MIN = 30; // m/s — spec: only above 30
const SPEEDLINE_MAX_OPACITY = 0.4;
const FX_SEED_SALT = 0xf3;

interface SkidSlot {
  mesh: THREE.Mesh; // ink core streak
  mat: THREE.MeshBasicMaterial; // unlit decal — readable in sun or shadow
  halo: THREE.Mesh; // wider charcoal feather under the core
  haloMat: THREE.MeshBasicMaterial;
  age: number; // seconds since laid; >= SKID_FADE_S => free
  maxOp: number; // per-mark peak opacity (seeded jitter — kills the stamped look)
}

interface PuffSlot {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  age: number;
  life: number;
  vx: number;
  vy: number;
  vz: number;
  base: number; // spawn scale (m) — seeded per puff
  grow: number; // final scale multiplier over the life
  spin: number; // material rotation rate
  maxOp: number; // peak opacity (smoke vs dust tint strength)
  grade: boolean; // smoke: warm tint at the kart cooling to scene-gray over life
}

interface SparkSlot {
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial;
  age: number;
  life: number;
  vx: number;
  vy: number;
  vz: number;
}

interface TrailSlot {
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial;
  age: number;
  life: number;
}

/** Soft radial-gradient disc texture (procedural — no assets), shared by all puffs. */
function puffTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  if (ctx !== null) {
    const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(c);
}

// smoke color grade: faint warm tint right at the kart cooling to scene-gray.
// Palette-derived constants, precomputed once (never allocated per frame).
const PUFF_WARM = new THREE.Color(KPAL.dirt).lerp(new THREE.Color(KPAL.curbWhite), 0.6);
const PUFF_COOL = new THREE.Color(KPAL.curbWhite);

export class KartFx {
  /**
   * Structural read of the KartScene graph root. KartScene's export surface is
   * frozen without a scene accessor; the fx pools attach to the same scene
   * graph through this one narrow cast (render.ts stays untouched). Returns
   * null when the handle is absent — the fx layer then runs DOM-only.
   */
  static sceneRoot(scene: KartScene): THREE.Object3D | null {
    const root = (scene as unknown as { scene?: unknown }).scene;
    return root instanceof THREE.Scene ? root : null;
  }

  private readonly root: THREE.Object3D | null;
  private readonly next = rng(decoSeed('kart-fx', FX_SEED_SALT));

  private readonly skids: SkidSlot[] = [];
  private skidCursor = 0;
  private readonly puffs: PuffSlot[] = [];
  private puffCursor = 0;
  private readonly sparksPool: SparkSlot[] = [];
  private sparkCursor = 0;
  private readonly trails: TrailSlot[] = [];
  private trailCursor = 0;

  private readonly speedLines: HTMLDivElement[] = [];
  private speedLevel = 0; // eased 0..1 speed-line intensity
  private t = 0; // accumulated fx clock (deterministic — dt-driven only)

  constructor(root: THREE.Object3D | null, overlay: HTMLElement) {
    this.root = root;
    if (root !== null) {
      // ---- skid marks: unit quad pre-rotated flat (+y facing), scaled per slot.
      // UNLIT basic materials: decal overlays whose read must not depend on the
      // sun/shadow rig. Two quads per mark: an ink core (rubber on bright
      // asphalt) over a wider charcoal feather (lifts the streak on dark roads).
      const skidGeo = new THREE.PlaneGeometry(1, 1);
      skidGeo.rotateX(-Math.PI / 2); // length axis now lies along local z
      for (let i = 0; i < SKID_POOL; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: KPAL.ink, // near-black rubber read over the asphalt
          transparent: true,
          opacity: 0,
          depthWrite: false, // decal: never punch holes in the road's depth
        });
        const mesh = new THREE.Mesh(skidGeo, mat);
        mesh.scale.set(SKID_W, 1, SKID_LEN);
        mesh.visible = false;
        root.add(mesh);
        const haloMat = new THREE.MeshBasicMaterial({
          color: KPAL.charcoal, // feathered edge — reads on near-black asphalt
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });
        const halo = new THREE.Mesh(skidGeo, haloMat);
        halo.scale.set(SKID_W * 1.7, 1, SKID_LEN * 1.15);
        halo.visible = false;
        root.add(halo);
        this.skids.push({ mesh, mat, halo, haloMat, age: SKID_FADE_S, maxOp: SKID_MAX_OPACITY });
      }

      // ---- puffs: billboarded soft sprites, one material per slot (opacity).
      const tex = puffTexture();
      for (let i = 0; i < PUFF_POOL; i++) {
        const mat = new THREE.SpriteMaterial({
          map: tex,
          color: KPAL.curbWhite,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.visible = false;
        root.add(sprite);
        this.puffs.push({ sprite, mat, age: 0, life: 0, vx: 0, vy: 0, vz: 0, base: 0.8, grow: 1, spin: 0, maxOp: 0, grade: false });
      }

      // ---- sparks: thin emissive boxes that fly along their velocity.
      const sparkGeo = new THREE.BoxGeometry(0.05, 0.05, 0.45);
      for (let i = 0; i < SPARK_POOL; i++) {
        const mat = new THREE.MeshLambertMaterial({
          color: KPAL.kartOrange,
          emissive: KPAL.kartOrange, // fx precedent: kartMesh nitro flame
          flatShading: true,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(sparkGeo, mat);
        mesh.visible = false;
        mesh.castShadow = false;
        root.add(mesh);
        this.sparksPool.push({ mesh, mat, age: 0, life: 0, vx: 0, vy: 0, vz: 0 });
      }

      // ---- nitro trail: gold speed-line streaks, world-locked behind the kart.
      const trailGeo = new THREE.BoxGeometry(0.05, 0.05, TRAIL_LEN);
      for (let i = 0; i < TRAIL_POOL; i++) {
        const mat = new THREE.MeshLambertMaterial({
          color: KPAL.gold,
          emissive: KPAL.gold,
          flatShading: true,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(trailGeo, mat);
        mesh.visible = false;
        mesh.castShadow = false;
        root.add(mesh);
        this.trails.push({ mesh, mat, age: 0, life: 0 });
      }
    }

    // ---- camera speed lines: DOM streaks at the screen rim (opacity-only writes).
    const wrap = document.createElement('div');
    wrap.className = 'fx-speedlines';
    for (let i = 0; i < SPEEDLINE_COUNT; i++) {
      // scattered rim anchors; each bar points radially outward (motion blur read)
      const a = 0.3 + (i / SPEEDLINE_COUNT) * Math.PI * 2 + (i % 2) * 0.22;
      const line = document.createElement('div');
      line.className = 'fx-speedline';
      line.style.left = `${50 + 46 * Math.cos(a)}%`;
      line.style.top = `${50 + 44 * Math.sin(a)}%`;
      line.style.transform = `rotate(${a}rad)`;
      line.style.opacity = '0';
      wrap.appendChild(line);
      this.speedLines.push(line);
    }
    overlay.appendChild(wrap);
  }

  /** Lay one skid quad at (x,z), its length axis along (dirX,dirZ). */
  skid(x: number, z: number, dirX: number, dirZ: number): void {
    if (this.root === null) return;
    const slot = this.skids[this.skidCursor]!;
    this.skidCursor = (this.skidCursor + 1) % this.skids.length;
    slot.age = 0;
    // seeded per-mark alpha jitter: breaks the uniform stamped-decal read
    slot.maxOp = SKID_MAX_OPACITY * rngRange(this.next, 0.78, 1);
    slot.mat.opacity = slot.maxOp;
    slot.mesh.position.set(x, SKID_Y, z);
    slot.mesh.rotation.y = Math.atan2(dirX, dirZ); // local +z -> dir
    slot.mesh.visible = true;
    slot.haloMat.opacity = slot.maxOp * SKID_HALO_OPACITY;
    slot.halo.position.set(x, SKID_Y - 0.001, z);
    slot.halo.rotation.y = slot.mesh.rotation.y;
    slot.halo.visible = true;
  }

  /** Drift smoke puff at (x,y,z): warm tint at the kart, cooling to scene-gray. */
  smoke(x: number, y: number, z: number): void {
    this.puff(x, y, z, KPAL.curbWhite, 0.5, true);
  }

  /** Tan grass dust puff at (x,y,z). */
  dust(x: number, y: number, z: number): void {
    this.puff(x, y, z, KPAL.dirt, 0.6, false);
  }

  /** Brief orange spark burst at (x,y,z) — a barrier hit. */
  sparks(x: number, y: number, z: number): void {
    if (this.root === null) return;
    for (let n = 0; n < SPARK_BURST; n++) {
      const slot = this.sparksPool[this.sparkCursor]!;
      this.sparkCursor = (this.sparkCursor + 1) % this.sparksPool.length;
      const ang = this.next() * Math.PI * 2;
      const out = rngRange(this.next, 2.5, 7);
      slot.age = 0;
      slot.life = rngRange(this.next, SPARK_LIFE_S * 0.6, SPARK_LIFE_S);
      slot.vx = Math.cos(ang) * out;
      slot.vz = Math.sin(ang) * out;
      slot.vy = rngRange(this.next, 2.5, 6.5);
      slot.mat.opacity = 0.95;
      slot.mesh.position.set(x, y, z);
      slot.mesh.scale.setScalar(1);
      slot.mesh.visible = true;
    }
  }

  /** One gold speed-line streak at (x,y,z), aligned to (dirX,dirZ) (nitro). */
  trail(x: number, y: number, z: number, dirX: number, dirZ: number): void {
    if (this.root === null) return;
    const slot = this.trails[this.trailCursor]!;
    this.trailCursor = (this.trailCursor + 1) % this.trails.length;
    slot.age = 0;
    slot.life = TRAIL_LIFE_S;
    slot.mat.opacity = 0.7;
    slot.mesh.position.set(x, y, z);
    slot.mesh.rotation.y = Math.atan2(dirX, dirZ);
    slot.mesh.scale.set(1, 1, 1);
    slot.mesh.visible = true;
  }

  /** Advance every pool + the speed-line overlay. speedMps drives the lines. */
  update(dt: number, speedMps: number): void {
    this.t += dt;

    for (const s of this.skids) {
      if (s.age >= SKID_FADE_S) continue;
      s.age += dt;
      if (s.age >= SKID_FADE_S) {
        s.mesh.visible = false;
        s.mat.opacity = 0;
        s.halo.visible = false;
        s.haloMat.opacity = 0;
      } else {
        const fade = 1 - s.age / SKID_FADE_S;
        s.mat.opacity = s.maxOp * fade;
        s.haloMat.opacity = s.maxOp * SKID_HALO_OPACITY * fade;
      }
    }

    for (const p of this.puffs) {
      if (p.age >= p.life) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.sprite.visible = false;
        p.mat.opacity = 0;
        continue;
      }
      const k = p.age / p.life;
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.position.z += p.vz * dt;
      const scale = p.base + p.grow * k;
      p.sprite.scale.set(scale, scale, 1);
      p.mat.opacity = p.maxOp * (1 - k) * (1 - k * 0.35);
      if (p.grade) p.mat.color.copy(PUFF_WARM).lerp(PUFF_COOL, k); // cool to scene-gray
      p.mat.rotation += p.spin * dt;
    }

    for (const s of this.sparksPool) {
      if (s.age >= s.life) continue;
      s.age += dt;
      s.vy -= SPARK_GRAVITY * dt;
      const m = s.mesh;
      m.position.x += s.vx * dt;
      m.position.y += s.vy * dt;
      m.position.z += s.vz * dt;
      if (s.age >= s.life || m.position.y < 0.02) {
        s.age = s.life;
        m.visible = false;
        s.mat.opacity = 0;
        continue;
      }
      // orient along the velocity (tracer read), fade + shrink out
      m.rotation.y = Math.atan2(s.vx, s.vz);
      m.rotation.x = -Math.atan2(s.vy, Math.hypot(s.vx, s.vz));
      const k = s.age / s.life;
      s.mat.opacity = 0.95 * (1 - k);
      m.scale.setScalar(1 - k * 0.5);
    }

    for (const tr of this.trails) {
      if (tr.age >= tr.life) continue;
      tr.age += dt;
      if (tr.age >= tr.life) {
        tr.mesh.visible = false;
        tr.mat.opacity = 0;
        continue;
      }
      const k = tr.age / tr.life;
      tr.mat.opacity = 0.7 * (1 - k);
      tr.mesh.scale.z = 1 - k * 0.7;
    }

    // camera speed lines: eased intensity, per-line phase flicker (deterministic)
    const target = Math.min(1, Math.max(0, (speedMps - SPEEDLINE_MIN) / 8));
    this.speedLevel += (target - this.speedLevel) * Math.min(1, 8 * dt);
    const level = this.speedLevel;
    for (let i = 0; i < this.speedLines.length; i++) {
      const line = this.speedLines[i]!;
      if (level < 0.02) {
        if (line.style.opacity !== '0') line.style.opacity = '0';
        continue;
      }
      const flicker = 0.65 + 0.35 * Math.sin(this.t * 14 + i * 1.7);
      line.style.opacity = (SPEEDLINE_MAX_OPACITY * level * flicker).toFixed(3);
    }
  }

  /** Instantly retire every pool (room leave / fresh race reset). */
  clear(): void {
    for (const s of this.skids) {
      s.age = SKID_FADE_S;
      s.mat.opacity = 0;
      s.mesh.visible = false;
      s.haloMat.opacity = 0;
      s.halo.visible = false;
    }
    for (const p of this.puffs) {
      p.age = p.life;
      p.mat.opacity = 0;
      p.sprite.visible = false;
    }
    for (const s of this.sparksPool) {
      s.age = s.life;
      s.mat.opacity = 0;
      s.mesh.visible = false;
    }
    for (const tr of this.trails) {
      tr.age = tr.life;
      tr.mat.opacity = 0;
      tr.mesh.visible = false;
    }
    this.speedLevel = 0;
    for (const line of this.speedLines) line.style.opacity = '0';
  }

  // ---- internals --------------------------------------------------------------

  private puff(x: number, y: number, z: number, hex: string, opacity: number, grade: boolean): void {
    if (this.root === null) return;
    const slot = this.puffs[this.puffCursor]!;
    this.puffCursor = (this.puffCursor + 1) % this.puffs.length;
    slot.age = 0;
    slot.life = rngRange(this.next, PUFF_LIFE_S * 0.75, PUFF_LIFE_S);
    slot.vx = rngRange(this.next, -0.8, 0.8);
    slot.vz = rngRange(this.next, -0.8, 0.8);
    slot.vy = rngRange(this.next, 1.6, 2.6); // slight upward drift
    slot.base = rngRange(this.next, 0.7, 1.1); // size variation per puff
    slot.grow = rngRange(this.next, 1.6, 2.3);
    slot.spin = rngRange(this.next, -1.2, 1.2);
    slot.grade = grade;
    slot.mat.color.set(grade ? PUFF_WARM : hex);
    slot.mat.opacity = opacity;
    slot.maxOp = opacity * rngRange(this.next, 0.8, 1); // alpha variation
    slot.sprite.position.set(x, y, z);
    slot.sprite.scale.set(slot.base, slot.base, 1);
    slot.sprite.visible = true;
  }
}
