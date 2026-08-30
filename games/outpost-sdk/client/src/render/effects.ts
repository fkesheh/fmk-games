// ============================================================================
// render/effects.ts — ART 6/6: FX & JUICE.
//
// Every transient visual effect in the game, pooled and preallocated: nothing
// in spawn/update/clear allocates. This is half of how OUTPOST feels — a
// screenshot cannot catch its absence — so every effect the brief lists is
// built: muzzle flash + smoke, tracers, blood spray with pooling decals,
// distinct per-kind zombie death bursts, fence splinter/break bursts, a
// spitter acid arc with a glowing trail and a lingering zeye-tinted pool, the
// through-geometry revive beacon, scrap pickup sparkle with a floating
// amount, brazier embers, floodlight dust motes and foot dust in the mud.
//
// Pooling discipline ported from games/fps/client/src/render/effects.ts:
// - tracers: fixed-size pool of cloned, additive-blended box meshes.
// - general bursts (blood, gore, splinters, embers, acid, spark motes): ONE
//   shared THREE.Points system, ring-buffer recycled, exactly as STRICKEN's.
// - smoke/dust volume puffs: a small pool of camera-facing quads that bloom,
//   drift and fade.
// - the acid pool and the revive beacon need to read EITHER as a persisted
//   ground mark or as visible-through-geometry, neither of which the flat-
//   shaded Lambert `mat()` factory can express — STYLE_BIBLE's material model
//   explicitly excepts `MeshBasicMaterial` for exactly this ("light-pool
//   decals and emissive quads"), so those two systems build their own raw
//   geometry/material once per pool slot, mirroring the exact idiom the
//   frozen `contactShadow()` in contract/visual.ts already uses (a raw
//   `THREE.CircleGeometry` rotated flat).
// - the scrap pickup's floating amount is a billboard THREE.Sprite backed by
//   a small, PERMANENT per-slot canvas texture that is repainted (never
//   reallocated) on each pop() — the canvas/texture pair is created once in
//   the constructor and lives for the module's lifetime, so "pooled, never
//   allocated per burst" holds here too.
//
// CONTRACT GAP (reported to the orchestrator): brazier and floodlight
// FIXTURE positions are not exposed anywhere in the frozen contract —
// `OutpostBuild` (render/outpost.ts) exposes only `segmentAnchor(id)` for the
// fence, and `@outpost/shared` exposes map FEATURE POINTS (camera framing
// targets) but no light-fixture points. The two ambient systems below
// (brazier embers, floodlight dust motes) therefore anchor themselves to
// positions DERIVED from frozen map constants (the 'gate' feature point,
// `TOWER_HALF`, `DECK1_Y`, `DECK2_Y`) that approximate — but are not
// guaranteed to exactly coincide with — wherever render/outpost.ts places its
// actual brazier and floodlight meshes. This is a best-effort implementation
// of a STYLE_BIBLE requirement the contract does not wire a channel for.
// ============================================================================
import * as THREE from 'three';

import { PALETTE, box } from '../contract/visual.js';
import { rng, rngRange } from '@platform/shared';
import { DECK1_Y, DECK2_Y, FEATURES, TOWER_HALF } from '@outpost/shared';
import type { PlayerId, Vec3W, ZombieKind } from '@outpost/shared';

// ---------------------------------------------------------------------------
// Pool sizes
// ---------------------------------------------------------------------------
const TRACER_POOL = 48;
const PARTICLE_POOL = 384;
const SMOKE_POOL = 32;
const ACID_POOL = 10;
const SCRAP_POOL = 10;

const PARK_Y = -9000; // dead particle slots park far below the map

// ---------------------------------------------------------------------------
// Tracer tuning
// ---------------------------------------------------------------------------
const TRACER_LIFE = 0.06;
const TRACER_WIDTH = 0.02;
const TRACER_HEAD_LEN = 3.2;
const TRACER_HEAD_OFF = 0.85;
const TRACER_TAIL_WIDTH = 0.045;
const TRACER_TAIL_OPACITY = 0.28;
const TRACER_HOLD = 1.5;

// ---------------------------------------------------------------------------
// Particle tuning
// ---------------------------------------------------------------------------
const PARTICLE_SIZE = 0.07;

// ---------------------------------------------------------------------------
// Smoke/dust puff tuning
// ---------------------------------------------------------------------------
const SMOKE_DEPTH = 0.008;
const SMOKE_FADE_IN = 0.08;
const SMOKE_DAMP = 2.4;
const SMOKE_RISE = 0.42;

// ---------------------------------------------------------------------------
// Acid pool (lingering spitter-splash mark) tuning
// ---------------------------------------------------------------------------
const ACID_RADIUS = 0.42; // metres
const ACID_LIFE = 7.5; // s — a genuinely lingering pool, not a splat
const ACID_FADE = 2.2; // s — final ease-out
const ACID_HOT = 0.22; // s — the brief oversized flare on landing
const ACID_HOT_GROW = 0.55;
const ACID_PEAK = 0.62;

// ---------------------------------------------------------------------------
// Scrap popup tuning
// ---------------------------------------------------------------------------
const SCRAP_LIFE = 1.15; // s: float + fade
const SCRAP_RISE = 0.85; // m/s upward drift
const SCRAP_CANVAS_W = 128;
const SCRAP_CANVAS_H = 56;
const SCRAP_SPRITE_W = 0.6; // metres
const SCRAP_SPRITE_H = SCRAP_SPRITE_W * (SCRAP_CANVAS_H / SCRAP_CANVAS_W);

// ---------------------------------------------------------------------------
// Revive beacon tuning
// ---------------------------------------------------------------------------
const BEACON_HEIGHT = 3.2;
const BEACON_RADIUS = 0.06;
const BEACON_PULSE_HZ = 1.6;

// ---------------------------------------------------------------------------
// Ambient (brazier embers / floodlight dust motes) tuning + anchors.
// See the CONTRACT GAP note in the file header for why these are derived,
// not authoritative.
// ---------------------------------------------------------------------------
const EMBER_INTERVAL = 0.24; // s between embers, PER brazier
const DUST_MOTE_INTERVAL = 0.55; // s between motes, PER floodlight

function findFeature(key: string): Vec3W {
  const f = FEATURES.find((ft) => ft.key === key);
  return f !== undefined ? { x: f.x, y: f.y, z: f.z } : { x: 0, y: 0, z: 0 };
}

const GATE_FEATURE = findFeature('gate');
/** Just inside the gate piers, brazier height off the ground. */
const BRAZIER_GATE: Vec3W = { x: GATE_FEATURE.x, y: 0.85, z: GATE_FEATURE.z + 1.6 };
/** A deck-1 corner, clear of the stair run — STYLE_BIBLE: "braziers at the gate and on deck 1". */
const BRAZIER_DECK1: Vec3W = { x: TOWER_HALF - 1.4, y: DECK1_Y + 0.75, z: TOWER_HALF - 1.4 };
const BRAZIER_ANCHORS: readonly Vec3W[] = [BRAZIER_GATE, BRAZIER_DECK1];

/** Four floodlights on the top deck, one per side, aimed outward-and-down. */
const FLOODLIGHT_ANCHORS: readonly Vec3W[] = [
  { x: 0, y: DECK2_Y + 1.3, z: -TOWER_HALF },
  { x: TOWER_HALF, y: DECK2_Y + 1.3, z: 0 },
  { x: 0, y: DECK2_Y + 1.3, z: TOWER_HALF },
  { x: -TOWER_HALF, y: DECK2_Y + 1.3, z: 0 },
];
/** Outward horizontal unit vector for each floodlight anchor (points away from the tower core). */
const FLOODLIGHT_OUT: readonly { x: number; z: number }[] = FLOODLIGHT_ANCHORS.map((a) => {
  const len = Math.hypot(a.x, a.z) || 1;
  return { x: a.x / len, z: a.z / len };
});

// ---------------------------------------------------------------------------
// Small pool-slot shapes
// ---------------------------------------------------------------------------
interface AcidSlot {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  scale: number;
}

interface ScrapSlot {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture;
  ctx: CanvasRenderingContext2D | null;
}

interface BeaconSlot {
  column: THREE.Mesh;
  cap: THREE.Mesh;
  on: boolean;
}

/** Paint "+amount" into a scrap popup slot's canvas. Called on pop(), never per-frame. */
function paintScrapCanvas(ctx: CanvasRenderingContext2D | null, amount: number): void {
  if (ctx === null) return;
  ctx.clearRect(0, 0, SCRAP_CANVAS_W, SCRAP_CANVAS_H);
  ctx.font = '700 32px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = `+${Math.max(0, Math.round(amount))}`;
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(20,14,4,0.88)';
  ctx.strokeText(text, SCRAP_CANVAS_W / 2, SCRAP_CANVAS_H / 2);
  ctx.fillStyle = PALETTE.scrapGold;
  ctx.fillText(text, SCRAP_CANVAS_W / 2, SCRAP_CANVAS_H / 2);
}

export class Effects {
  private readonly root = new THREE.Group();
  private readonly scene: THREE.Scene;
  private cam: THREE.Object3D | null = null; // resolved lazily; the camera joins the graph after construction
  private readonly scratchCamPos = new THREE.Vector3();
  private time = 0;

  // cosmetic rng — seeded, deterministic, never Math.random
  private readonly next = rng(0x0b57a1);

  // ---- tracer pool: bright core + fading warm tail per slot -----------------
  private readonly tracers: THREE.Mesh[] = [];
  private readonly tracerGlow: THREE.Mesh[] = [];
  private readonly tracerLife = new Float32Array(TRACER_POOL);
  private tracerCursor = 0;

  // ---- particle pool: one Points draw call, attribute arrays double as state
  private readonly points: THREE.Points;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly pVel = new Float32Array(PARTICLE_POOL * 3);
  private readonly pLife = new Float32Array(PARTICLE_POOL);
  private readonly pMaxLife = new Float32Array(PARTICLE_POOL);
  private readonly pGrav = new Float32Array(PARTICLE_POOL);
  private pCursor = 0;
  private pActive = 0;
  private pDirty = false;

  // ---- smoke/dust pool: camera-facing quads that bloom, drift and fade ------
  private readonly smokes: THREE.Mesh[] = [];
  private readonly smokeLife = new Float32Array(SMOKE_POOL);
  private readonly smokeMax = new Float32Array(SMOKE_POOL);
  private readonly smokeVel = new Float32Array(SMOKE_POOL * 3);
  private readonly smokeGrow = new Float32Array(SMOKE_POOL * 2);
  private readonly smokeSpin = new Float32Array(SMOKE_POOL);
  private readonly smokeRoll = new Float32Array(SMOKE_POOL);
  private readonly smokePeak = new Float32Array(SMOKE_POOL);
  private readonly smokeIn = new Float32Array(SMOKE_POOL);
  private readonly smokeAspect = new Float32Array(SMOKE_POOL);
  private smokeCursor = 0;

  // ---- acid pool: lingering zeye-tinted ground marks (spitter splash) -------
  private readonly acids: AcidSlot[] = [];
  private readonly acidLife = new Float32Array(ACID_POOL);
  private acidCursor = 0;

  // ---- scrap popup pool: billboard sprites with a repainted canvas texture --
  private readonly scraps: ScrapSlot[] = [];
  private readonly scrapLife = new Float32Array(SCRAP_POOL);
  private readonly scrapMax = new Float32Array(SCRAP_POOL);
  private scrapCursor = 0;

  // ---- revive beacons: one persistent slot per player id, created on first use
  private readonly beacons = new Map<PlayerId, BeaconSlot>();
  private readonly beaconGeo = new THREE.CylinderGeometry(BEACON_RADIUS, BEACON_RADIUS, BEACON_HEIGHT, 8, 1, true);
  private readonly beaconCapGeo = new THREE.SphereGeometry(0.12, 8, 6);

  // ---- ambient timers (brazier embers, floodlight dust motes) ---------------
  private emberTimer = EMBER_INTERVAL;
  private dustTimer = DUST_MOTE_INTERVAL;

  // ---- precomputed PALETTE colours, linear-space THREE.Color instances ------
  private readonly colTracer = new THREE.Color(PALETTE.tracer);
  private readonly colFire = new THREE.Color(PALETTE.fire);
  private readonly colSmoke = new THREE.Color(PALETTE.concrete);
  private readonly colBlood = new THREE.Color(PALETTE.blood);
  private readonly colBloodBright = new THREE.Color(PALETTE.danger);
  private readonly colRotPale = new THREE.Color(PALETTE.rotPale);
  private readonly colRotFlesh = new THREE.Color(PALETTE.rotFlesh);
  private readonly colRotDark = new THREE.Color(PALETTE.rotDark);
  private readonly colRotDeep = new THREE.Color(PALETTE.rotDeep);
  private readonly colGore = new THREE.Color(PALETTE.gore);
  private readonly colZeye = new THREE.Color(PALETTE.zeye);
  private readonly colWoodLit = new THREE.Color(PALETTE.woodLit);
  private readonly colWoodDark = new THREE.Color(PALETTE.woodDark);
  private readonly colRust = new THREE.Color(PALETTE.rust);
  private readonly colSandbagLit = new THREE.Color(PALETTE.sandbagLit);
  private readonly colMudLit = new THREE.Color(PALETTE.mudLit);
  private readonly colMudDark = new THREE.Color(PALETTE.mudDark);
  private readonly colScrapGold = new THREE.Color(PALETTE.scrapGold);
  private readonly colEmberGlow = new THREE.Color(PALETTE.emberGlow);
  private readonly colTorchCore = new THREE.Color(PALETTE.torchCore);
  private readonly colFloodBeam = new THREE.Color(PALETTE.floodBeam);
  private readonly scratchCol = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    // --- tracers: TRACER_POOL slots x (short bright head + full-length tail) -
    for (let i = 0; i < TRACER_POOL; i++) {
      const core = box(TRACER_WIDTH, TRACER_WIDTH, 1, PALETTE.tracer, {
        emissive: PALETTE.tracer,
        transparent: true,
      });
      const cmat = (core.material as THREE.MeshLambertMaterial).clone();
      cmat.blending = THREE.AdditiveBlending; // additive tracers explicitly allowed
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

    // --- particles: single Points draw call, RGBA per-particle -----------------
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
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(geo, pmat);
    this.points.frustumCulled = false; // positions mutate every frame; bounding sphere would go stale
    this.root.add(this.points);

    // --- smoke/dust: SMOKE_POOL camera-facing quads, cloned materials ----------
    for (let i = 0; i < SMOKE_POOL; i++) {
      const m = box(1, 1, SMOKE_DEPTH, PALETTE.concrete, { transparent: true });
      m.material = (m.material as THREE.MeshLambertMaterial).clone();
      m.visible = false;
      this.smokes.push(m);
      this.root.add(m);
    }

    // --- acid pool: ACID_POOL flat glowing circles, one shared geometry --------
    // MeshBasicMaterial per STYLE_BIBLE's explicit "light-pool decals" exception:
    // a lingering acid mark reads as a glow, which flat-shaded Lambert cannot do.
    const acidGeo = new THREE.CircleGeometry(ACID_RADIUS, 14);
    for (let i = 0; i < ACID_POOL; i++) {
      const am = new THREE.MeshBasicMaterial({
        color: PALETTE.zeye,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(acidGeo, am);
      mesh.rotation.x = -Math.PI / 2; // lie flat, same idiom as contactShadow()
      mesh.visible = false;
      this.acids.push({ mesh, material: am, scale: 1 });
      this.root.add(mesh);
    }

    // --- scrap popups: SCRAP_POOL billboard sprites, permanent canvas textures -
    for (let i = 0; i < SCRAP_POOL; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = SCRAP_CANVAS_W;
      canvas.height = SCRAP_CANVAS_H;
      const ctx = canvas.getContext('2d');
      const texture = new THREE.CanvasTexture(canvas);
      const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0 });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(SCRAP_SPRITE_W, SCRAP_SPRITE_H, 1);
      sprite.visible = false;
      this.scraps.push({ sprite, material, texture, ctx });
      this.root.add(sprite);
    }

    scene.add(this.root);
  }

  // -------------------------------------------------------------------------
  // Combat FX
  // -------------------------------------------------------------------------

  /** 60ms shot streak: a short bright head plus a full-length warm halo. */
  tracer(from: Vec3W, to: Vec3W): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const lenSq = dx * dx + dy * dy + dz * dz;
    if (lenSq < 1e-6) return; // degenerate ray — nothing to show

    const i = this.tracerCursor;
    this.tracerCursor = (i + 1) % TRACER_POOL;
    const len = Math.sqrt(lenSq);
    const core = this.tracers[i];
    const glow = this.tracerGlow[i];
    if (core === undefined || glow === undefined) return; // pool fully populated in constructor; defensive only

    glow.position.set((from.x + to.x) * 0.5, (from.y + to.y) * 0.5, (from.z + to.z) * 0.5);
    glow.lookAt(to.x, to.y, to.z);
    glow.scale.set(1, 1, len);
    glow.visible = true;
    (glow.material as THREE.MeshLambertMaterial).opacity = TRACER_TAIL_OPACITY;

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

  /** Flesh hit on a SURVIVOR: dark spray + bright droplets, bigger on a headshot. */
  bloodHit(p: Vec3W, headshot: boolean): void {
    const b = this.colBlood;
    this.burst(p, 6, b.r, b.g, b.b, 1.5, 2.8, 0.5, 0.28, 0.42, 9);
    const h = this.colBloodBright;
    const hitCount = headshot ? 4 : 2;
    const spMin = headshot ? 3.0 : 2.4;
    const spMax = headshot ? 5.2 : 4.2;
    this.burst(p, hitCount, h.r, h.g, h.b, spMin, spMax, 0.55, 0.2, 0.34, 9);
    this.puff(p, this.colBlood, 0.07, headshot ? 0.32 : 0.24, headshot ? 0.36 : 0.28, 0.5, 0.3, 0.6, 0.35, 0.32);
  }

  /**
   * Zombie death: a DISTINCT burst per kind, per STYLE_BIBLE's silhouette
   * table — shambler chunky/slow, runner lean/fast, brute big/heavy, spitter
   * with an acidic zeye-tinted accent.
   */
  zombieDeath(p: Vec3W, kind: ZombieKind): void {
    switch (kind) {
      case 'shambler': {
        const f = this.colRotFlesh;
        const d = this.colRotDark;
        const g = this.colGore;
        this.burst(p, 6, f.r, f.g, f.b, 1.4, 2.6, 0.55, 0.3, 0.5, 8.5);
        this.burst(p, 3, d.r, d.g, d.b, 1.0, 2.0, 0.5, 0.28, 0.46, 8.5);
        this.burst(p, 2, g.r, g.g, g.b, 1.6, 2.8, 0.5, 0.24, 0.4, 9);
        this.puff(p, this.colMudLit, 0.08, 0.34, 0.4, 0.42, 0.3, 0.55, 0.4, 0.28);
        break;
      }
      case 'runner': {
        const pa = this.colRotPale;
        const f = this.colRotFlesh;
        this.burst(p, 5, pa.r, pa.g, pa.b, 2.0, 3.6, 0.6, 0.24, 0.4, 8);
        this.burst(p, 3, f.r, f.g, f.b, 1.6, 3.0, 0.55, 0.22, 0.36, 8);
        this.puff(p, this.colMudLit, 0.06, 0.26, 0.32, 0.36, 0.4, 0.7, 0.4, 0.24);
        break;
      }
      case 'brute': {
        const d = this.colRotDark;
        const dp = this.colRotDeep;
        const g = this.colGore;
        this.burst(p, 10, d.r, d.g, d.b, 1.6, 3.2, 0.6, 0.35, 0.6, 8);
        this.burst(p, 5, dp.r, dp.g, dp.b, 1.2, 2.4, 0.5, 0.32, 0.55, 8);
        this.burst(p, 4, g.r, g.g, g.b, 1.8, 3.4, 0.55, 0.3, 0.5, 9);
        this.puff(p, this.colMudLit, 0.12, 0.5, 0.55, 0.5, 0.35, 0.6, 0.45, 0.32);
        this.puff(p, this.colMudDark, 0.1, 0.42, 0.5, 0.44, 0.25, 0.5, 0.4, 0.28);
        break;
      }
      case 'spitter': {
        const f = this.colRotFlesh;
        const z = this.colZeye;
        const g = this.colGore;
        this.burst(p, 5, f.r, f.g, f.b, 1.4, 2.6, 0.55, 0.3, 0.5, 8.5);
        this.burst(p, 3, z.r, z.g, z.b, 1.8, 3.2, 0.6, 0.26, 0.44, 7.5);
        this.burst(p, 2, g.r, g.g, g.b, 1.5, 2.6, 0.5, 0.26, 0.42, 9);
        this.puff(p, this.colZeye, 0.06, 0.26, 0.34, 0.4, 0.3, 0.55, 0.4, 0.3);
        break;
      }
    }
  }

  /** A segment absorbs a melee hit: wood chips + a little dust. */
  fenceHit(p: Vec3W): void {
    const t = this.colWoodLit;
    const d = this.colWoodDark;
    this.burst(p, 5, t.r, t.g, t.b, 1.6, 3.0, 0.5, 0.18, 0.32, 8.5);
    this.burst(p, 3, d.r, d.g, d.b, 1.2, 2.4, 0.45, 0.16, 0.28, 8.5);
    this.puff(p, this.colWoodDark, 0.05, 0.22, 0.3, 0.32, 0.3, 0.6, 0.35, 0.26);
  }

  /** A segment breaches: a big scatter of timber, rust sheet and spilled sandbag grit. */
  fenceBreak(p: Vec3W): void {
    const t = this.colWoodLit;
    const d = this.colWoodDark;
    const r = this.colRust;
    const s = this.colSandbagLit;
    this.burst(p, 9, t.r, t.g, t.b, 2.0, 3.8, 0.55, 0.28, 0.48, 8.5);
    this.burst(p, 5, d.r, d.g, d.b, 1.6, 3.0, 0.5, 0.26, 0.44, 8.5);
    this.burst(p, 4, r.r, r.g, r.b, 1.8, 3.2, 0.5, 0.3, 0.5, 8.5);
    this.burst(p, 4, s.r, s.g, s.b, 1.2, 2.4, 0.6, 0.3, 0.5, 7.5);
    this.puff(p, this.colWoodDark, 0.14, 0.56, 0.6, 0.5, 0.35, 0.65, 0.45, 0.3);
    this.puff(p, this.colMudLit, 0.1, 0.44, 0.5, 0.42, 0.25, 0.5, 0.4, 0.26);
  }

  /**
   * Spitter glob mid-flight: one small glowing zeye-tinted particle per call.
   * Called every render frame the projectile is airborne — the trail is the
   * accumulation of short-lived particles over successive calls, not a
   * single persistent mesh, so multiple simultaneous spits never fight over
   * one slot.
   */
  spitTrail(p: Vec3W): void {
    const z = this.colZeye;
    const shade = rngRange(this.next, 0.72, 1.0);
    this.spawn(
      p.x + rngRange(this.next, -0.04, 0.04),
      p.y + rngRange(this.next, -0.04, 0.04),
      p.z + rngRange(this.next, -0.04, 0.04),
      rngRange(this.next, -0.2, 0.2),
      rngRange(this.next, -0.1, 0.1),
      rngRange(this.next, -0.2, 0.2),
      z.r * shade,
      z.g * shade,
      z.b * shade,
      0.22,
      0.6,
    );
  }

  /** Spitter glob impact: a splash burst plus a LINGERING zeye-tinted pool. */
  spitLand(p: Vec3W): void {
    const z = this.colZeye;
    const d = this.colRotDeep;
    this.burst(p, 5, z.r, z.g, z.b, 1.4, 2.6, 0.6, 0.3, 0.5, 7.5);
    this.burst(p, 3, d.r, d.g, d.b, 1.0, 2.0, 0.5, 0.26, 0.42, 8);
    this.puff(p, this.colZeye, 0.1, 0.42, 0.4, 0.4, 0.3, 0.55, 0.45, 0.36);

    const i = this.acidCursor;
    this.acidCursor = (i + 1) % ACID_POOL;
    const slot = this.acids[i];
    if (slot === undefined) return;
    slot.mesh.position.set(p.x, 0.02, p.z);
    const s = rngRange(this.next, 0.75, 1.2);
    slot.scale = s;
    const hot = s * (1 + ACID_HOT_GROW);
    slot.mesh.scale.set(hot, hot, 1);
    slot.mesh.visible = true;
    slot.material.opacity = ACID_PEAK;
    this.acidLife[i] = ACID_LIFE;
  }

  /**
   * Muzzle blast: a hot flash core plus two grey puffs drifting along the
   * shot direction. Called for own AND remote shots.
   */
  muzzleSmoke(p: Vec3W, dir: Vec3W): void {
    this.puffAt(
      p.x + dir.x * 0.06,
      p.y + dir.y * 0.06,
      p.z + dir.z * 0.06,
      dir.x * rngRange(this.next, 0.5, 0.9),
      dir.y * rngRange(this.next, 0.5, 0.9),
      dir.z * rngRange(this.next, 0.5, 0.9),
      0.1,
      rngRange(this.next, 0.34, 0.44),
      rngRange(this.next, 0.06, 0.085),
      0.95,
      this.colFire,
      1,
    );
    for (let n = 0; n < 2; n++) {
      const k = 0.07 + n * 0.11;
      this.puffAt(
        p.x + dir.x * k,
        p.y + dir.y * k,
        p.z + dir.z * k,
        dir.x * rngRange(this.next, 0.35, 0.8),
        dir.y * rngRange(this.next, 0.35, 0.8) + rngRange(this.next, 0.25, 0.5),
        dir.z * rngRange(this.next, 0.35, 0.8),
        0.11 + n * 0.03,
        rngRange(this.next, 0.5, 0.68),
        rngRange(this.next, 0.55, 0.85),
        rngRange(this.next, 0.42, 0.52),
        this.colSmoke,
        0.28,
      );
    }
  }

  /** A footstep kicks a small puff of mud. */
  footDust(p: Vec3W): void {
    this.puffAt(
      p.x + rngRange(this.next, -0.08, 0.08),
      p.y + 0.06,
      p.z + rngRange(this.next, -0.08, 0.08),
      rngRange(this.next, -0.3, 0.3),
      rngRange(this.next, 0.2, 0.45),
      rngRange(this.next, -0.3, 0.3),
      rngRange(this.next, 0.07, 0.1),
      rngRange(this.next, 0.26, 0.36),
      rngRange(this.next, 0.35, 0.5),
      rngRange(this.next, 0.32, 0.42),
      this.colMudLit,
      0.3,
    );
  }

  /**
   * Downed teammate's revive beacon: a through-geometry column (depthTest
   * disabled) with a pulsing bright cap, per player id. The slot is created
   * once for a given id and reused for the rest of the run.
   */
  reviveBeacon(id: PlayerId, p: Vec3W, on: boolean): void {
    let slot = this.beacons.get(id);
    if (slot === undefined) {
      slot = this.makeBeaconSlot();
      this.beacons.set(id, slot);
    }
    slot.on = on;
    slot.column.visible = on;
    slot.cap.visible = on;
    if (on) {
      slot.column.position.set(p.x, p.y + BEACON_HEIGHT / 2, p.z);
      slot.cap.position.set(p.x, p.y + BEACON_HEIGHT, p.z);
    }
  }

  /** Scrap pickup: a gold sparkle burst plus a floating "+amount" popup. */
  scrapPop(p: Vec3W, amount: number): void {
    const g = this.colScrapGold;
    this.burst(p, 5, g.r, g.g, g.b, 0.6, 1.4, 0.7, 0.35, 0.55, 3.2);

    const i = this.scrapCursor;
    this.scrapCursor = (i + 1) % SCRAP_POOL;
    const slot = this.scraps[i];
    if (slot === undefined) return;
    paintScrapCanvas(slot.ctx, amount);
    slot.texture.needsUpdate = true;
    slot.sprite.position.set(p.x, p.y + 0.4, p.z);
    slot.sprite.visible = true;
    slot.material.opacity = 1;
    this.scrapLife[i] = SCRAP_LIFE;
    this.scrapMax[i] = SCRAP_LIFE;
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(dt: number): void {
    this.time += dt;

    // tracers: the bright head holds hot then collapses; the tail fades quadratically
    for (let i = 0; i < TRACER_POOL; i++) {
      const life = this.tracerLife[i] ?? 0;
      if (life <= 0) continue;
      const core = this.tracers[i];
      const glow = this.tracerGlow[i];
      if (core === undefined || glow === undefined) continue;
      const next = life - dt;
      if (next <= 0) {
        this.tracerLife[i] = 0;
        core.visible = false;
        glow.visible = false;
        continue;
      }
      this.tracerLife[i] = next;
      const k = next / TRACER_LIFE;
      (core.material as THREE.MeshLambertMaterial).opacity = Math.min(1, k * TRACER_HOLD);
      const ck = 0.55 + 0.45 * k;
      core.scale.set(ck, ck, core.scale.z);
      (glow.material as THREE.MeshLambertMaterial).opacity = TRACER_TAIL_OPACITY * k * k;
      const gk = 0.6 + 0.4 * k;
      glow.scale.set(gk, gk, glow.scale.z);
    }

    // acid pool: a brief hot flare on landing, then a long, slow ease-out
    for (let i = 0; i < ACID_POOL; i++) {
      const life = this.acidLife[i] ?? 0;
      if (life <= 0) continue;
      const slot = this.acids[i];
      if (slot === undefined) continue;
      const next = life - dt;
      if (next <= 0) {
        this.acidLife[i] = 0;
        slot.mesh.visible = false;
        continue;
      }
      this.acidLife[i] = next;
      const elapsed = ACID_LIFE - next;
      const base = slot.scale;
      if (elapsed < ACID_HOT) {
        const e = elapsed / ACID_HOT;
        const back = (1 - e) * (1 - e);
        slot.material.opacity = ACID_PEAK * (0.6 + 0.4 * e);
        const s = base * (1 + ACID_HOT_GROW * back);
        slot.mesh.scale.set(s, s, 1);
      } else {
        if (slot.mesh.scale.x !== base) slot.mesh.scale.set(base, base, 1);
        if (next < ACID_FADE) {
          const t = next / ACID_FADE;
          slot.material.opacity = ACID_PEAK * t * t * (3 - 2 * t);
        } else {
          slot.material.opacity = ACID_PEAK;
        }
      }
    }

    // smoke/dust: billboard toward the camera, bloom, damp drift, gentle climb
    const cam = this.ensureCam();
    if (cam !== null) cam.getWorldPosition(this.scratchCamPos);
    for (let i = 0; i < SMOKE_POOL; i++) {
      const life = this.smokeLife[i] ?? 0;
      if (life <= 0) continue;
      const m = this.smokes[i];
      if (m === undefined) continue;
      const next = life - dt;
      if (next <= 0) {
        this.smokeLife[i] = 0;
        m.visible = false;
        continue;
      }
      this.smokeLife[i] = next;
      const i3 = i * 3;
      const damp = Math.max(0, 1 - SMOKE_DAMP * dt);
      const vx = (this.smokeVel[i3] ?? 0) * damp;
      const vy = (this.smokeVel[i3 + 1] ?? 0) * damp + SMOKE_RISE * dt;
      const vz = (this.smokeVel[i3 + 2] ?? 0) * damp;
      this.smokeVel[i3] = vx;
      this.smokeVel[i3 + 1] = vy;
      this.smokeVel[i3 + 2] = vz;
      m.position.x += vx * dt;
      m.position.y += vy * dt;
      m.position.z += vz * dt;
      const max = this.smokeMax[i] ?? next;
      const k = next / max;
      const elapsed = max - next;
      const inT = this.smokeIn[i] ?? 0;
      const fadeIn = elapsed >= inT ? 1 : elapsed / Math.max(inT, 1e-4);
      const shape = k * k * (3 - 2 * k);
      (m.material as THREE.MeshLambertMaterial).opacity = (this.smokePeak[i] ?? 1) * fadeIn * shape;
      const g0 = this.smokeGrow[i * 2] ?? 0;
      const g1 = this.smokeGrow[i * 2 + 1] ?? g0;
      const u = 1 - k;
      const s = g0 + (g1 - g0) * u * (2 - u);
      m.scale.set(s, s * (this.smokeAspect[i] ?? 1), 1);
      if (cam !== null) {
        m.lookAt(this.scratchCamPos);
        const roll = (this.smokeRoll[i] ?? 0) + (this.smokeSpin[i] ?? 0) * dt;
        this.smokeRoll[i] = roll;
        m.rotateZ(roll);
      }
    }

    // revive beacons: pulse opacity + cap scale
    for (const slot of this.beacons.values()) {
      if (!slot.on) continue;
      const phase = Math.sin(this.time * BEACON_PULSE_HZ * Math.PI * 2) * 0.5 + 0.5;
      (slot.column.material as THREE.MeshBasicMaterial).opacity = 0.32 + phase * 0.24;
      (slot.cap.material as THREE.MeshBasicMaterial).opacity = 0.5 + phase * 0.4;
      const s = 1 + phase * 0.22;
      slot.cap.scale.set(s, s, s);
    }

    // scrap popups: float up, fade near the end of life
    for (let i = 0; i < SCRAP_POOL; i++) {
      const life = this.scrapLife[i] ?? 0;
      if (life <= 0) continue;
      const slot = this.scraps[i];
      if (slot === undefined) continue;
      const next = life - dt;
      if (next <= 0) {
        this.scrapLife[i] = 0;
        slot.sprite.visible = false;
        continue;
      }
      this.scrapLife[i] = next;
      slot.sprite.position.y += SCRAP_RISE * dt;
      const maxLife = this.scrapMax[i] ?? SCRAP_LIFE;
      const k = next / maxLife;
      slot.material.opacity = k > 0.4 ? 1 : k / 0.4;
    }

    // ambient: brazier embers rise from fixed anchors, floodlight motes drift
    // outward-and-down through the beam cones
    this.emberTimer -= dt;
    if (this.emberTimer <= 0) {
      this.emberTimer += EMBER_INTERVAL;
      for (const a of BRAZIER_ANCHORS) this.spawnEmber(a);
    }
    this.dustTimer -= dt;
    if (this.dustTimer <= 0) {
      this.dustTimer += DUST_MOTE_INTERVAL;
      for (let i = 0; i < FLOODLIGHT_ANCHORS.length; i++) {
        const a = FLOODLIGHT_ANCHORS[i];
        const out = FLOODLIGHT_OUT[i];
        if (a === undefined || out === undefined) continue;
        this.spawnDustMote(a, out);
      }
    }

    // particles: gravity, integrate, eased alpha fade; park on death
    if (this.pActive === 0) {
      if (this.pDirty) {
        this.posAttr.needsUpdate = true;
        this.colAttr.needsUpdate = true;
        this.pDirty = false;
      }
      return;
    }
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    for (let i = 0; i < PARTICLE_POOL; i++) {
      const life = this.pLife[i] ?? 0;
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
      const grav = this.pGrav[i] ?? 0;
      const vy = (this.pVel[i3 + 1] ?? 0) - grav * dt;
      this.pVel[i3 + 1] = vy;
      pos[i3] = (pos[i3] ?? 0) + (this.pVel[i3] ?? 0) * dt;
      pos[i3 + 1] = (pos[i3 + 1] ?? 0) + vy * dt;
      pos[i3 + 2] = (pos[i3 + 2] ?? 0) + (this.pVel[i3 + 2] ?? 0) * dt;
      const t = next / (this.pMaxLife[i] ?? next);
      col[i4 + 3] = t * t * (3 - 2 * t);
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  /** Kill every live tracer, acid mark, smoke puff, scrap popup and particle immediately. */
  clear(): void {
    for (let i = 0; i < TRACER_POOL; i++) {
      this.tracerLife[i] = 0;
      const core = this.tracers[i];
      const glow = this.tracerGlow[i];
      if (core !== undefined) core.visible = false;
      if (glow !== undefined) glow.visible = false;
    }
    for (let i = 0; i < ACID_POOL; i++) {
      this.acidLife[i] = 0;
      const slot = this.acids[i];
      if (slot !== undefined) slot.mesh.visible = false;
    }
    for (let i = 0; i < SMOKE_POOL; i++) {
      this.smokeLife[i] = 0;
      const m = this.smokes[i];
      if (m !== undefined) m.visible = false;
    }
    for (let i = 0; i < SCRAP_POOL; i++) {
      this.scrapLife[i] = 0;
      const slot = this.scraps[i];
      if (slot !== undefined) slot.sprite.visible = false;
    }
    for (const slot of this.beacons.values()) {
      slot.on = false;
      slot.column.visible = false;
      slot.cap.visible = false;
    }
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    for (let i = 0; i < PARTICLE_POOL; i++) {
      this.pLife[i] = 0;
      col[i * 4 + 3] = 0;
      pos[i * 3 + 1] = PARK_Y;
    }
    this.pActive = 0;
    this.pDirty = true;
    this.emberTimer = EMBER_INTERVAL;
    this.dustTimer = DUST_MOTE_INTERVAL;
  }

  /** Release every GPU resource this pool owns. */
  dispose(): void {
    for (const m of this.tracers) {
      m.geometry.dispose();
      (m.material as THREE.MeshLambertMaterial).dispose();
    }
    for (const m of this.tracerGlow) {
      m.geometry.dispose();
      (m.material as THREE.MeshLambertMaterial).dispose();
    }
    let acidGeoDisposed = false;
    for (const a of this.acids) {
      if (!acidGeoDisposed) {
        a.mesh.geometry.dispose(); // shared geometry — dispose exactly once
        acidGeoDisposed = true;
      }
      a.material.dispose();
    }
    for (const m of this.smokes) {
      m.geometry.dispose();
      (m.material as THREE.MeshLambertMaterial).dispose();
    }
    for (const s of this.scraps) {
      s.material.dispose();
      s.texture.dispose();
    }
    for (const slot of this.beacons.values()) {
      (slot.column.material as THREE.MeshBasicMaterial).dispose();
      (slot.cap.material as THREE.MeshBasicMaterial).dispose();
    }
    this.beacons.clear();
    this.beaconGeo.dispose();
    this.beaconCapGeo.dispose();
    this.points.geometry.dispose();
    (this.points.material as THREE.PointsMaterial).dispose();
    this.scene.remove(this.root);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private ensureCam(): THREE.Object3D | null {
    if (this.cam === null) {
      this.cam = this.scene.getObjectByProperty('isPerspectiveCamera', true) ?? null;
    }
    return this.cam;
  }

  private makeBeaconSlot(): BeaconSlot {
    const colMat = new THREE.MeshBasicMaterial({
      color: PALETTE.reviveCyan,
      transparent: true,
      opacity: 0.4,
      depthTest: false, // through-geometry, per UX_BIBLE
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const column = new THREE.Mesh(this.beaconGeo, colMat);
    column.renderOrder = 999;
    column.visible = false;
    this.root.add(column);

    const capMat = new THREE.MeshBasicMaterial({
      color: PALETTE.reviveCyan,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const cap = new THREE.Mesh(this.beaconCapGeo, capMat);
    cap.renderOrder = 999;
    cap.visible = false;
    this.root.add(cap);

    return { column, cap, on: false };
  }

  /** One warm ember rising from a brazier anchor, into a dead particle slot. */
  private spawnEmber(a: Vec3W): void {
    const warm = rngRange(this.next, 0, 1) < 0.6 ? this.colEmberGlow : this.colTorchCore;
    const shade = rngRange(this.next, 0.8, 1.05);
    this.spawn(
      a.x + rngRange(this.next, -0.18, 0.18),
      a.y + rngRange(this.next, -0.05, 0.1),
      a.z + rngRange(this.next, -0.18, 0.18),
      rngRange(this.next, -0.15, 0.15),
      rngRange(this.next, 0.35, 0.7),
      rngRange(this.next, -0.15, 0.15),
      warm.r * shade,
      warm.g * shade,
      warm.b * shade,
      rngRange(this.next, 1.1, 1.8),
      -0.7, // negative "gravity": the plume accelerates upward as it heats
    );
  }

  /** One faint dust mote drifting outward-and-down through a floodlight cone. */
  private spawnDustMote(a: Vec3W, out: { x: number; z: number }): void {
    const dim = rngRange(this.next, 0.28, 0.5); // faint — ambient, not a hero effect
    const speed = rngRange(this.next, 0.15, 0.35);
    this.spawn(
      a.x + rngRange(this.next, -0.4, 0.4),
      a.y + rngRange(this.next, -0.3, 0.3),
      a.z + rngRange(this.next, -0.4, 0.4),
      out.x * speed,
      -rngRange(this.next, 0.1, 0.25),
      out.z * speed,
      this.colFloodBeam.r * dim,
      this.colFloodBeam.g * dim,
      this.colFloodBeam.b * dim,
      rngRange(this.next, 3.0, 4.2),
      0,
    );
  }

  /** One smoke puff AT an already-jittered position; `glow` scales its emissive. */
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
    glow: number,
  ): void {
    const i = this.smokeCursor;
    this.smokeCursor = (i + 1) % SMOKE_POOL;
    const m = this.smokes[i];
    if (m === undefined) return;
    m.position.set(x, y, z);
    const aspect = rngRange(this.next, 0.78, 1.02);
    this.smokeAspect[i] = aspect;
    m.scale.set(growFrom, growFrom * aspect, 1);
    m.visible = true;
    const smat = m.material as THREE.MeshLambertMaterial;
    const shade = rngRange(this.next, 0.6, 0.95);
    smat.color.copy(col).multiplyScalar(shade);
    smat.emissive.copy(col).multiplyScalar(shade * glow);
    smat.opacity = 0; // ramps in over smokeIn during update()
    const i3 = i * 3;
    this.smokeVel[i3] = vx;
    this.smokeVel[i3 + 1] = vy;
    this.smokeVel[i3 + 2] = vz;
    this.smokeGrow[i * 2] = growFrom;
    this.smokeGrow[i * 2 + 1] = growTo;
    this.smokeLife[i] = life;
    this.smokeMax[i] = life;
    this.smokePeak[i] = peak;
    this.smokeIn[i] = Math.min(SMOKE_FADE_IN, life * 0.3);
    this.smokeRoll[i] = rngRange(this.next, 0, Math.PI * 2);
    this.smokeSpin[i] = rngRange(this.next, -2.4, 2.4);
  }

  /** One smoke puff at `p` with position jitter + up-biased drift (impacts). */
  private puff(
    p: Vec3W,
    tint: THREE.Color,
    growFrom: number,
    growTo: number,
    life: number,
    peak: number,
    speedMin: number,
    speedMax: number,
    upBias: number,
    glow: number,
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
      tint,
      glow,
    );
  }

  /** Spawn `count` particles at `p`: random up-biased directions, per-particle gravity. */
  private burst(
    p: Vec3W,
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
      const shade = rngRange(this.next, 0.82, 1.06);
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
      if ((this.pLife[j] ?? 0) <= 0) {
        idx = j;
        break;
      }
    }
    if (idx === -1) idx = this.pCursor; // pool full: recycle oldest-ish slot
    this.pCursor = (idx + 1) % PARTICLE_POOL;

    const wasDead = (this.pLife[idx] ?? 0) <= 0;

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
}
