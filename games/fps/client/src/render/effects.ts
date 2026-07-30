// ============================================================================
// C6 — combat effects (pooled): tracers + particle bursts + decals + smoke.
// Pools are fully preallocated in the constructor; spawn/update/clear perform
// ZERO allocation. Tracer meshes come from the contract box() factory (one
// cloned material per slot, built once — additive blending explicitly allowed
// for tracers); particles are the single allowed raw THREE.Points material;
// smoke/dust puffs are small quad meshes (allowed alongside Points per
// CONTRACT). ALL colors trace to PALETTE; jitter comes from a seeded rng
// (never Math.random). Invariant: `root` stays at identity so lookAt() math
// is world.
// ============================================================================
import * as THREE from 'three';
import { IMPACT_MAT, PALETTE, rng, rngRange, type MatId, type Team, type Vec3 } from '@fps/shared';
import { box } from '../contract/visual.js';
import { MAT_COLORS } from './mapRenderer.js';

// ---- pool sizes (frozen by CONTRACT: ≤64 tracers, ≤256 particles, 64 decals) -
const TRACER_POOL = 64;
const PARTICLE_POOL = 256;
const DECAL_POOL = 64;
const SMOKE_POOL = 24; // small quad meshes (contract allows quads next to Points)

// ---- tracer tuning -----------------------------------------------------------
const TRACER_LIFE = 0.06; // s — spec: 60ms fading line
const TRACER_WIDTH = 0.013; // bright head segment cross-section
const TRACER_HEAD_LEN = 2.6; // m — only the leading segment runs bright
const TRACER_HEAD_OFF = 0.9; // m — head starts just past the muzzle
const TRACER_TAIL_WIDTH = 0.03; // hairline tail cross-section
const TRACER_TAIL_OPACITY = 0.2; // low, and dies fast (quadratic fade)

// ---- particle tuning ---------------------------------------------------------
const PARTICLE_SIZE = 0.06; // spec: size ~0.06, sizeAttenuation
const PARK_Y = -10000; // dead slots park far below the map (alpha is also 0)

// ---- decal tuning ------------------------------------------------------------
const DECAL_SIZE = 0.09; // ~0.09u splat quad per spec
const DECAL_DEPTH = 0.004; // paper-thin box — reads as a flat quad
const DECAL_LIFE = 45; // s — splat persists, then fades out
const DECAL_FADE = 5; // s — opacity ramps to 0 over the final stretch
const DECAL_OFFSET = 0.02; // nudge toward the camera so it doesn't z-fight

// ---- smoke/dust tuning -------------------------------------------------------
const SMOKE_DEPTH = 0.008; // paper-thin quad
const SMOKE_FADE_IN = 0.09; // s of initial opacity ramp (avoids a hard pop)
const SMOKE_DAMP = 2.6; // 1/s velocity damping — puffs bloom then hang
const SMOKE_RISE = 0.5; // m/s² upward drift — hot smoke climbs

/** Material impact families: dust clouds, metal sparks, snow puffs, wood
 *  chips, foliage hits. Frozen visual mapping (STYLE_BIBLE per-map reads). */
// The mapping moved to the shared contract (@fps/shared) as IMPACT_MAT so that
// adding a MatId cannot silently break this file — the tiered palette added 26
// materials at once. Aliased to the old local name to keep call sites stable.
const MAT_KIND = IMPACT_MAT;

// per-material tint as linear-work-space rgb (same conversion as mat()),
// derived from C3's frozen MatId -> PALETTE table so impacts match the walls
interface Rgb { r: number; g: number; b: number }
const MAT_TINT = ((): Record<MatId, Rgb> => {
  const out = {} as Record<MatId, Rgb>;
  for (const [id, hex] of Object.entries(MAT_COLORS) as Array<[MatId, string]>) {
    const c = new THREE.Color(hex);
    out[id] = { r: c.r, g: c.g, b: c.b };
  }
  return out;
})();

export class Effects {
  private readonly root = new THREE.Group();

  // ---- tracer pool: bright core + fading glow tail per slot -------------------
  private readonly tracers: THREE.Mesh[] = [];
  private readonly tracerGlow: THREE.Mesh[] = [];
  private readonly tracerLife = new Float32Array(TRACER_POOL);
  private tracerCursor = 0;

  // ---- particle pool: one Points, attribute arrays double as sim state -------
  private readonly points: THREE.Points;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly pVel = new Float32Array(PARTICLE_POOL * 3);
  private readonly pLife = new Float32Array(PARTICLE_POOL); // remaining, s
  private readonly pMaxLife = new Float32Array(PARTICLE_POOL);
  private readonly pGrav = new Float32Array(PARTICLE_POOL); // downward accel m/s²
  private pCursor = 0;
  private pActive = 0;
  private pDirty = false; // forces one final attribute upload after clear()

  // ---- decal pool: flat splat quads, billboarded at spawn, then static -------
  private readonly decals: THREE.Mesh[] = [];
  private readonly decalLife = new Float32Array(DECAL_POOL);
  private decalCursor = 0;

  // ---- smoke/dust pool: camera-facing quads that bloom, drift and fade -------
  private readonly smokes: THREE.Mesh[] = [];
  private readonly smokeLife = new Float32Array(SMOKE_POOL); // remaining, s
  private readonly smokeMax = new Float32Array(SMOKE_POOL);
  private readonly smokeVel = new Float32Array(SMOKE_POOL * 3);
  private readonly smokeGrow = new Float32Array(SMOKE_POOL * 2); // scale from,to
  private readonly smokeSpin = new Float32Array(SMOKE_POOL); // rad/s roll
  private readonly smokeRoll = new Float32Array(SMOKE_POOL); // accumulated roll
  private readonly smokePeak = new Float32Array(SMOKE_POOL); // peak opacity
  private smokeCursor = 0;

  private readonly scene: THREE.Scene;
  private cam: THREE.Object3D | null = null; // resolved lazily on first billboard
  private readonly scratchCamPos = new THREE.Vector3();

  // cosmetic rng — seeded, deterministic, never Math.random
  private readonly next = rng(0xc6f1);

  // recipe colors as linear-work-space rgb (same conversion as mat())
  private readonly colDust = new THREE.Color(PALETTE.concrete);
  private readonly colSpark = new THREE.Color(PALETTE.muzzle);
  private readonly colFire = new THREE.Color(PALETTE.fire);
  private readonly colBlood = new THREE.Color(PALETTE.blood);
  private readonly colTeamT = new THREE.Color(PALETTE.tAmber);
  private readonly colTeamCT = new THREE.Color(PALETTE.ctBlue);
  private readonly colSmoke = new THREE.Color(PALETTE.concreteDark); // dark core — clouds silhouette against bright sky
  private readonly colFootDust = new THREE.Color(PALETTE.dust);
  private readonly colSnow = new THREE.Color(PALETTE.snow);
  private readonly scratchCol = new THREE.Color(); // per-spawn shade jitter

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    // tracers: 64 slots × (short bright head segment + full-length hairline
    // tail). Materials are cloned once here (not per call) so opacity fades
    // per slot.
    for (let i = 0; i < TRACER_POOL; i++) {
      const core = box(TRACER_WIDTH, TRACER_WIDTH, 1, PALETTE.tracer, {
        emissive: PALETTE.tracer,
        transparent: true,
      });
      const cmat = (core.material as THREE.MeshLambertMaterial).clone();
      cmat.blending = THREE.AdditiveBlending; // allowed for tracers per spec
      cmat.depthWrite = false;
      core.material = cmat;
      core.visible = false;
      this.tracers.push(core);
      this.root.add(core);

      const glow = box(TRACER_TAIL_WIDTH, TRACER_TAIL_WIDTH, 1, PALETTE.fire, {
        emissive: PALETTE.fire,
        transparent: true,
      });
      const gmat = (glow.material as THREE.MeshLambertMaterial).clone();
      gmat.blending = THREE.AdditiveBlending;
      gmat.depthWrite = false;
      glow.material = gmat;
      glow.visible = false;
      this.tracerGlow.push(glow);
      this.root.add(glow);
    }

    // particles: single Points draw call. itemSize-4 color attribute gives
    // per-particle alpha (three defines USE_COLOR_ALPHA) — dead slots hide by
    // zeroed alpha + parked position, per spec.
    const pos = new Float32Array(PARTICLE_POOL * 3);
    const col = new Float32Array(PARTICLE_POOL * 4);
    for (let i = 0; i < PARTICLE_POOL; i++) pos[i * 3 + 1] = PARK_Y;
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    const pmat = new THREE.PointsMaterial({
      size: PARTICLE_SIZE,
      vertexColors: true,
      sizeAttenuation: true,
      depthWrite: false, // spec
      transparent: true,
    });
    this.points = new THREE.Points(geo, pmat);
    this.points.frustumCulled = false; // positions mutate; bounding sphere stale
    this.root.add(this.points);

    // decals: 64 flat splat quads (alternating ink/charcoal), one cloned
    // material per slot so opacity fades independently. Orientation and the
    // anti-z-fight offset are fixed once at spawn (billboard toward camera).
    for (let i = 0; i < DECAL_POOL; i++) {
      const m = box(
        DECAL_SIZE,
        DECAL_SIZE,
        DECAL_DEPTH,
        i % 2 === 0 ? PALETTE.ink : PALETTE.charcoal,
        { transparent: true },
      );
      m.material = (m.material as THREE.MeshLambertMaterial).clone();
      m.visible = false;
      this.decals.push(m);
      this.root.add(m);
    }

    // smoke/dust: 24 camera-facing quads, one cloned material per slot so
    // tint + opacity are independent (muzzle smoke is concrete grey, foot
    // dust takes the floor tint, snow puffs are snow white).
    for (let i = 0; i < SMOKE_POOL; i++) {
      const m = box(1, 1, SMOKE_DEPTH, PALETTE.concrete, { transparent: true });
      m.material = (m.material as THREE.MeshLambertMaterial).clone();
      m.visible = false;
      this.smokes.push(m);
      this.root.add(m);
    }

    scene.add(this.root);
  }

  /**
   * 60ms shot streak along from→to: a short bright head segment just past
   * the muzzle plus a hairline warm tail for the full ray — reads as a shot,
   * not a muzzle-to-impact laser rail.
   */
  tracer(from: Vec3, to: Vec3): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const lenSq = dx * dx + dy * dy + dz * dz;
    if (lenSq < 1e-6) return; // degenerate ray — nothing to show

    const i = this.tracerCursor;
    this.tracerCursor = (i + 1) % TRACER_POOL;
    const len = Math.sqrt(lenSq);
    const core = this.tracers[i]!; // pool is fully populated in the constructor
    const glow = this.tracerGlow[i]!;
    // tail: the full-length hairline, oriented along the ray
    glow.position.set((from.x + to.x) * 0.5, (from.y + to.y) * 0.5, (from.z + to.z) * 0.5);
    glow.lookAt(to.x, to.y, to.z); // +Z of the box aligns with the ray
    glow.scale.set(1, 1, len);
    glow.visible = true;
    (glow.material as THREE.MeshLambertMaterial).opacity = TRACER_TAIL_OPACITY;
    // head: short bright segment just past the muzzle
    const headLen = Math.min(TRACER_HEAD_LEN, Math.max(0.4, len - TRACER_HEAD_OFF));
    const hc = Math.min(len, TRACER_HEAD_OFF + headLen * 0.5);
    const inv = 1 / len;
    core.position.set(from.x + dx * inv * hc, from.y + dy * inv * hc, from.z + dz * inv * hc);
    core.lookAt(to.x, to.y, to.z);
    core.scale.set(1, 1, headLen);
    core.visible = true;
    (core.material as THREE.MeshLambertMaterial).opacity = 1;
    this.tracerLife[i] = TRACER_LIFE;
  }

  /**
   * Bullet hit on world geometry, classified by the struck material (wired in
   * by ClientGame from the map's BoxDef mats): sand/plaster/masonry puffs up
   * tinted dust, metal throws a spark fan, frostbite snow bursts white, wood
   * throws chips, foliage sheds green. No mat (legacy callers) = concrete
   * dust + sparks as before.
   */
  impact(p: Vec3, mat?: MatId): void {
    if (mat === undefined) {
      const c = this.colDust;
      this.burst(p, 6, c.r, c.g, c.b, 0.8, 1.8, 0.6, 0.3, 0.45, 3.5);
      const s = this.colSpark;
      this.burst(p, 2, s.r, s.g, s.b, 3.5, 5.5, 0.2, 0.1, 0.16, 9.8);
      return;
    }
    const kind = MAT_KIND[mat];
    const t = MAT_TINT[mat];
    switch (kind) {
      case 'spark': {
        // metal: hot spark fan (muzzle yellow + fire orange), little dust
        const s = this.colSpark;
        this.burst(p, 5, s.r, s.g, s.b, 3.5, 6.0, 0.25, 0.1, 0.2, 9.8);
        const f = this.colFire;
        this.burst(p, 3, f.r, f.g, f.b, 3.0, 5.0, 0.2, 0.08, 0.16, 9.8);
        this.burst(p, 2, t.r, t.g, t.b, 0.8, 1.6, 0.5, 0.25, 0.4, 3.5);
        this.puff(p, 0.06, 0.24, 0.3, 0.4, t, 0.4, 0.7, 0.35);
        break;
      }
      case 'snow': {
        // frostbite: soft white burst + lingering powder puffs
        const w = this.colSnow;
        this.burst(p, 7, w.r, w.g, w.b, 0.7, 1.7, 0.7, 0.35, 0.55, 3.0);
        this.burst(p, 2, t.r, t.g, t.b, 0.5, 1.2, 0.6, 0.3, 0.5, 2.5);
        this.puff(p, 0.08, 0.34, 0.45, 0.5, this.colSnow, 0.15, 0.45, 0.5);
        this.puff(p, 0.06, 0.26, 0.55, 0.36, this.colSnow, 0.1, 0.4, 0.6);
        break;
      }
      case 'chip': {
        // wood/crate: fast chunky chips + a little dust
        this.burst(p, 6, t.r, t.g, t.b, 1.8, 3.4, 0.5, 0.2, 0.35, 8);
        const d = this.colDust;
        this.burst(p, 2, d.r, d.g, d.b, 0.7, 1.5, 0.6, 0.3, 0.45, 3.5);
        break;
      }
      case 'leaf': {
        // foliage: green shed, slow fall
        this.burst(p, 6, t.r, t.g, t.b, 1.0, 2.2, 0.7, 0.35, 0.6, 4.5);
        break;
      }
      default: {
        // dust: sand/plaster/masonry — tinted dust cloud + a soft puff that
        // lingers a beat longer than the particles (reads as a real impact)
        this.burst(p, 7, t.r, t.g, t.b, 0.8, 1.9, 0.65, 0.3, 0.5, 3.5);
        const s = this.colSpark;
        this.burst(p, 1, s.r, s.g, s.b, 3.5, 5.0, 0.2, 0.1, 0.14, 9.8);
        this.puff(p, 0.07, 0.3, 0.4, 0.45, t, 0.2, 0.55, 0.45);
        break;
      }
    }
  }

  /**
   * Muzzle smoke: 3 grey puffs just past the muzzle after any shot (own or
   * remote — ClientGame wires it from the 'shot' event). Drifts along the
   * shot direction, blooms, climbs and fades.
   */
  muzzleSmoke(p: Vec3, dir: Vec3): void {
    for (let n = 0; n < 3; n++) {
      const k = 0.05 + n * 0.09; // stagger the puffs along the barrel line
      this.puffAt(
        p.x + dir.x * k,
        p.y + dir.y * k,
        p.z + dir.z * k,
        dir.x * rngRange(this.next, 0.35, 0.8),
        dir.y * rngRange(this.next, 0.35, 0.8) + rngRange(this.next, 0.25, 0.5),
        dir.z * rngRange(this.next, 0.35, 0.8),
        0.1 + n * 0.025,
        rngRange(this.next, 0.44, 0.58),
        rngRange(this.next, 0.55, 0.85),
        rngRange(this.next, 0.45, 0.55),
        this.colSmoke,
      );
    }
  }

  /**
   * Sprint footstep dust: 1 small low puff at the feet, tinted by the map
   * floor material (sand on dustbowl, snow on frostbite, concrete indoors).
   */
  footDust(p: Vec3, floorMat?: MatId): void {
    const t = floorMat !== undefined ? MAT_TINT[floorMat] : undefined;
    const col = t !== undefined ? this.scratchCol.setRGB(t.r, t.g, t.b) : this.colFootDust;
    this.puffAt(
      p.x + rngRange(this.next, -0.08, 0.08),
      p.y + 0.06,
      p.z + rngRange(this.next, -0.08, 0.08),
      rngRange(this.next, -0.3, 0.3),
      rngRange(this.next, 0.2, 0.45),
      rngRange(this.next, -0.3, 0.3),
      rngRange(this.next, 0.07, 0.1),
      rngRange(this.next, 0.2, 0.28),
      rngRange(this.next, 0.35, 0.5),
      rngRange(this.next, 0.34, 0.44),
      col,
    );
  }

  /** Flesh hit: 6 blood-red splash particles. */
  blood(p: Vec3): void {
    const b = this.colBlood;
    this.burst(p, 6, b.r, b.g, b.b, 1.5, 2.8, 0.5, 0.28, 0.42, 9);
  }

  /**
   * Bullet mark on world geometry: small dark splat quad. Billboarded toward
   * the camera and nudged slightly along (camera - p) at spawn so it never
   * z-fights the wall, then static; fades out after 45s; oldest recycled.
   */
  decal(p: Vec3): void {
    const cam = this.ensureCam();

    // Ring order == age order (uniform life), so the cursor slot is the oldest.
    const i = this.decalCursor;
    this.decalCursor = (i + 1) % DECAL_POOL;
    const m = this.decals[i]!; // pool is fully populated in the constructor

    m.position.set(p.x, p.y, p.z);
    if (cam !== null) {
      cam.getWorldPosition(this.scratchCamPos);
      const dx = this.scratchCamPos.x - p.x;
      const dy = this.scratchCamPos.y - p.y;
      const dz = this.scratchCamPos.z - p.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len > 1e-4) {
        const k = DECAL_OFFSET / len;
        m.position.set(p.x + dx * k, p.y + dy * k, p.z + dz * k);
      }
      m.lookAt(this.scratchCamPos); // +Z of the quad faces the camera
    }
    m.rotateZ(rngRange(this.next, 0, Math.PI * 2)); // splat rotation jitter
    const s = rngRange(this.next, 0.8, 1.3); // scale jitter
    m.scale.set(s, s, 1);
    m.visible = true;
    (m.material as THREE.MeshLambertMaterial).opacity = 1;
    this.decalLife[i] = DECAL_LIFE;
  }

  /** Player death: 12 team-colored radial burst particles. */
  death(p: Vec3, team: Team): void {
    const t = team === 'CT' ? this.colTeamCT : this.colTeamT;
    this.burst(p, 12, t.r, t.g, t.b, 2.2, 4.0, 0.8, 0.5, 0.7, 5);
  }

  /** Advance all pools. Zero allocation; uploads attributes only when live. */
  update(dt: number): void {
    // tracers: the bright head thins/fades over 60ms; the hairline tail dies
    // quadratically so the streak collapses fast instead of lingering as a rail
    for (let i = 0; i < TRACER_POOL; i++) {
      const life = this.tracerLife[i]!;
      if (life <= 0) continue;
      const core = this.tracers[i]!;
      const glow = this.tracerGlow[i]!;
      const next = life - dt;
      if (next <= 0) {
        this.tracerLife[i] = 0;
        core.visible = false;
        glow.visible = false;
        continue;
      }
      this.tracerLife[i] = next;
      const k = next / TRACER_LIFE;
      (core.material as THREE.MeshLambertMaterial).opacity = k;
      core.scale.set(k, k, core.scale.z); // head length persists, cross-section thins
      (glow.material as THREE.MeshLambertMaterial).opacity = TRACER_TAIL_OPACITY * k * k;
      const gk = 0.6 + 0.4 * k; // tail collapses toward nothing as it dies
      glow.scale.set(gk, gk, glow.scale.z);
    }

    // decals: static splats; fade opacity out over the final DECAL_FADE
    // seconds, then hide. Must run before the particle early-out below.
    for (let i = 0; i < DECAL_POOL; i++) {
      const life = this.decalLife[i]!;
      if (life <= 0) continue;
      const next = life - dt;
      if (next <= 0) {
        this.decalLife[i] = 0;
        this.decals[i]!.visible = false;
        continue;
      }
      this.decalLife[i] = next;
      if (next < DECAL_FADE) {
        (this.decals[i]!.material as THREE.MeshLambertMaterial).opacity = next / DECAL_FADE;
      }
    }

    // smoke/dust: billboard toward the camera, bloom (grow), damp drift,
    // gentle climb; opacity ramps in over SMOKE_FADE_IN then out with life
    const cam = this.ensureCam();
    if (cam !== null) cam.getWorldPosition(this.scratchCamPos);
    for (let i = 0; i < SMOKE_POOL; i++) {
      const life = this.smokeLife[i]!;
      if (life <= 0) continue;
      const m = this.smokes[i]!;
      const next = life - dt;
      if (next <= 0) {
        this.smokeLife[i] = 0;
        m.visible = false;
        continue;
      }
      this.smokeLife[i] = next;
      const i3 = i * 3;
      const damp = Math.max(0, 1 - SMOKE_DAMP * dt);
      this.smokeVel[i3] = this.smokeVel[i3]! * damp;
      this.smokeVel[i3 + 1] = this.smokeVel[i3 + 1]! * damp + SMOKE_RISE * dt;
      this.smokeVel[i3 + 2] = this.smokeVel[i3 + 2]! * damp;
      m.position.x += this.smokeVel[i3]! * dt;
      m.position.y += this.smokeVel[i3 + 1]! * dt;
      m.position.z += this.smokeVel[i3 + 2]! * dt;
      const max = this.smokeMax[i]!;
      const k = next / max; // 1 -> 0 over life
      const elapsed = max - next;
      const fadeIn = elapsed >= SMOKE_FADE_IN ? 1 : elapsed / SMOKE_FADE_IN;
      (m.material as THREE.MeshLambertMaterial).opacity = this.smokePeak[i]! * fadeIn * k;
      const g0 = this.smokeGrow[i * 2]!;
      const g1 = this.smokeGrow[i * 2 + 1]!;
      const s = g0 + (g1 - g0) * (1 - k);
      m.scale.set(s, s, 1);
      if (cam !== null) m.lookAt(this.scratchCamPos);
      this.smokeRoll[i] = this.smokeRoll[i]! + this.smokeSpin[i]! * dt;
      m.rotateZ(this.smokeRoll[i]!);
    }

    if (this.pActive === 0) {
      if (this.pDirty) {
        this.posAttr.needsUpdate = true;
        this.colAttr.needsUpdate = true;
        this.pDirty = false;
      }
      return;
    }

    // particles: gravity, integrate, linear alpha fade; park on death
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    for (let i = 0; i < PARTICLE_POOL; i++) {
      const life = this.pLife[i]!;
      if (life <= 0) continue;
      const i3 = i * 3;
      const i4 = i * 4;
      const next = life - dt;
      if (next <= 0) {
        this.pLife[i] = 0;
        col[i4 + 3] = 0;
        pos[i3 + 1] = PARK_Y;
        this.pActive--;
        continue;
      }
      this.pLife[i] = next;
      this.pVel[i3 + 1] = this.pVel[i3 + 1]! - this.pGrav[i]! * dt;
      pos[i3] = pos[i3]! + this.pVel[i3]! * dt;
      pos[i3 + 1] = pos[i3 + 1]! + this.pVel[i3 + 1]! * dt;
      pos[i3 + 2] = pos[i3 + 2]! + this.pVel[i3 + 2]! * dt;
      col[i4 + 3] = next / this.pMaxLife[i]!;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  /** Kill every live tracer, decal, smoke quad and particle immediately. */
  clear(): void {
    for (let i = 0; i < TRACER_POOL; i++) {
      this.tracerLife[i] = 0;
      this.tracers[i]!.visible = false;
      this.tracerGlow[i]!.visible = false;
    }
    for (let i = 0; i < DECAL_POOL; i++) {
      this.decalLife[i] = 0;
      this.decals[i]!.visible = false;
    }
    for (let i = 0; i < SMOKE_POOL; i++) {
      this.smokeLife[i] = 0;
      this.smokes[i]!.visible = false;
    }
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    for (let i = 0; i < PARTICLE_POOL; i++) {
      this.pLife[i] = 0;
      col[i * 4 + 3] = 0;
      pos[i * 3 + 1] = PARK_Y;
    }
    this.pActive = 0;
    this.pDirty = true; // upload the wiped state on the next update()
  }

  // ---- private helpers ---------------------------------------------------------

  /** The camera joins the graph after construction (ClientGame adds it for the
   *  viewmodel) — resolve it once, share between decals and smoke billboards. */
  private ensureCam(): THREE.Object3D | null {
    if (this.cam === null) {
      this.cam = this.scene.getObjectByProperty('isPerspectiveCamera', true) ?? null;
    }
    return this.cam;
  }

  /** Convenience: one smoke puff AT an already-jittered position. */
  private puffAt(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    growFrom: number,
    growTo: number,
    life: number,
    peak: number,
    col: THREE.Color,
  ): void {
    const i = this.smokeCursor;
    this.smokeCursor = (i + 1) % SMOKE_POOL;
    const m = this.smokes[i]!; // pool is fully populated in the constructor
    m.position.set(x, y, z);
    m.scale.set(growFrom, growFrom, 1);
    m.visible = true;
    const mat = m.material as THREE.MeshLambertMaterial;
    // darker-core shade range + restrained emissive: clouds silhouette against
    // bright sky instead of glowing like a smudge; slight alpha stays high
    const shade = rngRange(this.next, 0.62, 0.88);
    mat.color.copy(col).multiplyScalar(shade);
    mat.emissive.copy(col).multiplyScalar(shade * 0.32);
    mat.opacity = 0; // ramps in over SMOKE_FADE_IN during update()
    const i3 = i * 3;
    this.smokeVel[i3] = vx;
    this.smokeVel[i3 + 1] = vy;
    this.smokeVel[i3 + 2] = vz;
    this.smokeGrow[i * 2] = growFrom;
    this.smokeGrow[i * 2 + 1] = growTo;
    this.smokeLife[i] = life;
    this.smokeMax[i] = life;
    this.smokePeak[i] = peak;
    this.smokeRoll[i] = rngRange(this.next, 0, Math.PI * 2);
    this.smokeSpin[i] = rngRange(this.next, -2.4, 2.4);
  }

  /** One smoke puff at `p` with position jitter + up-biased drift (impacts). */
  private puff(
    p: Vec3,
    growFrom: number,
    growTo: number,
    life: number,
    peak: number,
    tint: Rgb,
    speedMin: number,
    speedMax: number,
    upBias: number,
  ): void {
    let dx = rngRange(this.next, -1, 1);
    let dy = rngRange(this.next, -1, 1) + upBias;
    let dz = rngRange(this.next, -1, 1);
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) {
      dx = 0;
      dy = 1;
      dz = 0;
    } else {
      const inv = 1 / len;
      dx *= inv;
      dy *= inv;
      dz *= inv;
    }
    const speed = rngRange(this.next, speedMin, speedMax);
    const col = this.scratchCol.setRGB(tint.r, tint.g, tint.b);
    this.puffAt(
      p.x + rngRange(this.next, -0.04, 0.04),
      p.y + rngRange(this.next, -0.04, 0.04),
      p.z + rngRange(this.next, -0.04, 0.04),
      dx * speed,
      dy * speed,
      dz * speed,
      growFrom,
      growTo,
      life,
      peak,
      col,
    );
  }

  /**
   * Spawn `count` particles at `p` into dead pool slots: random directions
   * (up-biased), speed/life in [min,max), per-particle gravity, slight
   * brightness jitter around the given PALETTE-derived rgb.
   */
  private burst(
    p: Vec3,
    count: number,
    r: number,
    g: number,
    b: number,
    speedMin: number,
    speedMax: number,
    upBias: number,
    lifeMin: number,
    lifeMax: number,
    grav: number,
  ): void {
    for (let n = 0; n < count; n++) {
      let dx = rngRange(this.next, -1, 1);
      let dy = rngRange(this.next, -1, 1) + upBias;
      let dz = rngRange(this.next, -1, 1);
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-4) {
        dx = 0;
        dy = 1;
        dz = 0;
      } else {
        const inv = 1 / len;
        dx *= inv;
        dy *= inv;
        dz *= inv;
      }
      const speed = rngRange(this.next, speedMin, speedMax);
      const shade = rngRange(this.next, 0.8, 1.0); // subtle value jitter
      this.spawn(
        p.x + rngRange(this.next, -0.05, 0.05),
        p.y + rngRange(this.next, -0.05, 0.05),
        p.z + rngRange(this.next, -0.05, 0.05),
        dx * speed,
        dy * speed,
        dz * speed,
        r * shade,
        g * shade,
        b * shade,
        rngRange(this.next, lifeMin, lifeMax),
        grav,
      );
    }
  }

  /** Write one particle into a dead slot (ring scan; falls back to overwrite). */
  private spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    r: number,
    g: number,
    b: number,
    life: number,
    grav: number,
  ): void {
    let idx = -1;
    for (let i = 0; i < PARTICLE_POOL; i++) {
      const j = (this.pCursor + i) % PARTICLE_POOL;
      if (this.pLife[j]! <= 0) {
        idx = j;
        break;
      }
    }
    if (idx === -1) idx = this.pCursor; // pool full: recycle oldest-ish slot
    this.pCursor = (idx + 1) % PARTICLE_POOL;

    // Count only genuinely-new activations: recycling a live slot must not
    // inflate pActive (else the pActive===0 early-out in update() never fires).
    const wasDead = this.pLife[idx]! <= 0;

    const i3 = idx * 3;
    const i4 = idx * 4;
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    pos[i3] = x;
    pos[i3 + 1] = y;
    pos[i3 + 2] = z;
    col[i4] = r;
    col[i4 + 1] = g;
    col[i4 + 2] = b;
    col[i4 + 3] = 1;
    this.pVel[i3] = vx;
    this.pVel[i3 + 1] = vy;
    this.pVel[i3 + 2] = vz;
    this.pLife[idx] = life;
    this.pMaxLife[idx] = life;
    this.pGrav[idx] = grav;
    if (wasDead) this.pActive++;
  }

  /**
   * Release all GPU resources owned by this pool: the 128 cloned tracer
   * materials + tracer box geometries (core + glow per slot), the 64 cloned
   * decal materials + decal quad geometries, the 24 cloned smoke materials +
   * smoke quad geometries, and the Points geometry + its PointsMaterial.
   * Called by ClientGame.teardownWorld() on room teardown. The shared mat()
   * cache is untouched — only per-instance clones die here.
   */
  dispose(): void {
    for (const m of this.tracers) {
      m.geometry.dispose();
      (m.material as THREE.MeshLambertMaterial).dispose();
    }
    for (const m of this.tracerGlow) {
      m.geometry.dispose();
      (m.material as THREE.MeshLambertMaterial).dispose();
    }
    for (const m of this.decals) {
      m.geometry.dispose();
      (m.material as THREE.MeshLambertMaterial).dispose();
    }
    for (const m of this.smokes) {
      m.geometry.dispose();
      (m.material as THREE.MeshLambertMaterial).dispose();
    }
    this.points.geometry.dispose();
    (this.points.material as THREE.PointsMaterial).dispose();
  }
}
