// ============================================================================
// KART GP — juice/particle layer (app-owned; wired from the frame loop in
// app.ts). Pooled, zero-alloc-per-frame: every pool slot (mesh + material +
// its two colour endpoints) is allocated ONCE at construction and recycled
// ring-buffer style; the per-frame update only writes transforms/opacity/colour
// into live slots. Spawn-time colour is `.copy()`d from module-level THREE.Color
// constants — never `.set(hexString)`, which re-parses a string per spawn.
// All randomness is seeded (@platform/shared rng — Math.random is a contract
// violation). KPAL colors only, by name. Effects:
//   skid   — persistent rubber decals on the road (drift / hard braking): an
//            `ink` core over a wider, lower-alpha `ink` feather, seeded width/
//            length/yaw jitter so a streak wanders instead of reading as a
//            stamped ruler line. Holds near full for the first half of
//            SKID_FADE_S. The feather is alpha-feathered, NOT pigment-feathered:
//            the only KPAL tier dark enough to still read where a mark crosses
//            the `asphaltDeep` shoulder is `ink` itself (see SKID_HALO_OPACITY).
//   smoke  — drift puffs that start hot and pale (`lineWhite`) at the contact
//            patch and cool to `steel` as they billow, so the plume reads over
//            the dark road AND against the bright sky. Density tracks the
//            drift-heat envelope: a long slide smokes visibly harder.
//   dust   — off-road puffs: `dirt` at the wheel (hue-split against every
//            grass tier) brightening to `lineWhite` as the plume lifts and
//            catches sun. Heavier and wider than smoke, and it settles.
//   sparks — two voices off one pool: a wide `gold`->`kartOrange` burst on a
//            barrier hit, and small low drift sparks that escalate with the
//            drift-heat envelope (warm orange -> white-gold) so grip loss is
//            legible at a glance without any new API surface. The envelope is
//            PER SLIDING KART (see HEAT_STREAMS): `smoke()` is called for every
//            remote kart too, so a single global envelope would let a rival
//            drifting on the far side of the circuit pin your own smoke density
//            and spark stage at maximum — the exact opposite of "legible".
//   trail  — nitro streaks that stretch as they are left behind and grade
//            `curbWhite` -> `gold` -> `kartOrange` while they cool.
//   speed lines — DOM overlay streaks in two side fans, sweeping outward and
//            stretching with speed above SPEEDLINE_MIN m/s. This module writes
//            ONLY left/top/transform/opacity on `.fx-speedline` (transform and
//            opacity are the only per-frame writes, and transform is written
//            only when the eased speed level actually moves).
// The module attaches its pools to the scene graph via KartFx.sceneRoot():
// KartScene's public API is frozen (docs/KART.md) with no scene-graph
// accessor, so the fx root is read structurally — render.ts is never modified.
// If the root is unavailable the 3D pools are simply never built and every
// emitter is a safe no-op (juice must never crash a race).
// ============================================================================
import * as THREE from 'three';
import { KPAL, MAX_PLAYERS } from '@kart/shared';
import { decoSeed, rng, rngRange } from '@platform/shared';
import type { KartScene } from './render.js';

// ---- pool sizes (fixed at construction; reused forever) ---------------------
const SKID_POOL = 128; // spec: ~128 persistent marks
const PUFF_POOL = 56; // smoke + dust share one pool (kind per spawn)
const SPARK_POOL = 32; // impact bursts + drift sparks share one pool
const TRAIL_POOL = 28;
const SPEEDLINE_COUNT = 8;

// ---- tuning ------------------------------------------------------------------
const SKID_FADE_S = 20; // spec: marks fade over ~20s
const SKID_MAX_OPACITY = 0.92;
// Feather alpha relative to the core. The feather uses the SAME `ink` pigment as
// the core — measured with composite()/L() from @platform/shared, every lighter
// KPAL ink tier dies on the retuned shoulder: `charcoal` (L 15.90) over
// `asphaltDeep` (L 15.87) composites to dL 0.0 at EVERY alpha, and `tire`
// (L 12.54) only reaches dL 1.0-1.9. `ink` (L 7.64) at the effective alpha this
// constant produces (0.55 x the 0.68-0.92 per-mark jitter => 0.37-0.51) darkens
// asphaltDeep by 2.5-3.5 L and asphalt by 5.0-6.9 L, while the core (0.68-0.92)
// still sits a further 2.7-3.7 L / 4.1-9.3 L below it — so the two-step
// core->feather->road ramp survives on every road tier including the shoulder.
const SKID_HALO_OPACITY = 0.55;
const SKID_HOLD = 2.15; // fade multiplier: full for ~54% of life, then ramps out
const SKID_Y = 0.019; // above ALL baked road detail (trackMesh grime 0.013,
// baked apex skids 0.016, patches 0.017), below the dashes (0.02)
const SKID_W = 0.26; // tire-contact width
const SKID_LEN = 0.75; // quad length (app spaces marks ~0.5m — slight overlap)
const SKID_HALO_W = 1.9; // feather width relative to the core
const SKID_HALO_LEN = 1.2;
const SKID_YAW_JITTER = 0.05; // rad — the streak wanders like real scrubbed rubber
const PUFF_RISE = 0.14; // life fraction spent blooming in (soft emerge, no pop)
const SPARK_GRAVITY = 16; // m/s² — heavier than earth reads snappier at this scale
const DRIFT_GRAVITY = 12; // drift sparks are lighter and hug the road
const TRAIL_LIFE_S = 0.3;
const TRAIL_LEN = 1.5;
const TRAIL_PEAK = 0.85;
const TRAIL_STRETCH = 0.8; // z growth over life — a streak left behind reads fast
const SPEEDLINE_MIN = 30; // m/s — spec: only above 30
const SPEEDLINE_MAX_OPACITY = 0.5;
const SPEEDLINE_RADIUS = 44; // % of viewport, horizontal anchor spread
const SPEEDLINE_RISE = 34; // % of viewport, vertical anchor spread
const SPEEDLINE_FAN = 0.62; // rad between the lines of one side fan
const SPEEDLINE_PUSH = 30; // px of outward sweep at full speed
const SPEEDLINE_QUANT = 50; // level quantisation for the transform write gate
// drift-heat envelope: rises while a kart is smoking (drift only — braking never
// calls smoke()), decays as soon as it stops. Drives smoke density and the
// two-stage drift sparks. ONE ENVELOPE PER SLIDING KART — see HEAT_STREAMS.
const DRIFT_HEAT_GAIN = 0.11; // per smoke puff (~22/s while drifting)
const DRIFT_HEAT_DECAY = 1.7; // per second
const DRIFT_SPARK_ON = 0.35; // heat at which warm sparks appear
const DRIFT_SPARK_HOT = 0.75; // heat at which they go white-gold
// Per-kart heat streams. app.ts calls smoke() for the local kart AND for every
// drifting remote, and the emitter API carries no kart id, so a stream is
// identified geometrically: each puff joins the nearest live stream within
// HEAT_STREAM_R, else it opens its own. The radius is derived, not guessed —
// one kart's consecutive puffs are at most one puff of travel (TOP_SPEED 36 m/s
// x SMOKE_EVERY_S 0.045 = 1.62 m) plus its wheel track (2 x WHEEL_HALF 0.66 =
// 1.32 m) apart, i.e. <= 2.94 m, so a single slide can never split into two
// streams. Two karts closer than that are inside 1.7 collision diameters
// (KART_RADIUS 0.9) — wheel-to-wheel, plumes already overlapping on screen, so
// sharing an envelope there reads correctly; anywhere else on the circuit a
// rival's slide can no longer touch yours. Single-kart rate math is unchanged:
// 22.2 puffs/s x 0.11 = 2.44/s gain vs 1.7/s decay => ~1.0 s ramp to white-gold.
// Derived, never a literal: one envelope per kart, so every kart in a full room
// can slide at once. Hard-coding this is what let it drift out of step with the
// player cap before — the import IS the coupling.
const HEAT_STREAMS = MAX_PLAYERS;
const HEAT_STREAM_R2 = 3 * 3; // squared match radius (m²)
const FX_SEED_SALT = 0xf3;

// ---- palette-derived colour constants (allocated once; spawns `.copy()`) -----
// Every endpoint is a literal KPAL entry, so every pixel traces to the palette.
const C_SMOKE_HOT = new THREE.Color(KPAL.lineWhite); // L 85 — hot rubber at the patch
const C_SMOKE_COOL = new THREE.Color(KPAL.steel); //     L 65 — reads against the L 85 sky
const C_DUST_HOT = new THREE.Color(KPAL.dirt); //        L 42 — earth, hue-split from grass
const C_DUST_COOL = new THREE.Color(KPAL.lineWhite); //  L 85 — sunlit plume over grassLit
const C_IMPACT_HOT = new THREE.Color(KPAL.gold);
const C_IMPACT_COOL = new THREE.Color(KPAL.kartOrange);
const C_DRIFT_WARM_HOT = new THREE.Color(KPAL.kartOrange);
const C_DRIFT_WARM_COOL = new THREE.Color(KPAL.curbRed);
const C_DRIFT_HOT_HOT = new THREE.Color(KPAL.curbWhite);
const C_DRIFT_HOT_COOL = new THREE.Color(KPAL.gold);
const C_TRAIL_HOT = new THREE.Color(KPAL.curbWhite);
const C_TRAIL_MID = new THREE.Color(KPAL.gold);
const C_TRAIL_COOL = new THREE.Color(KPAL.kartOrange);
const TRAIL_KNEE = 0.35; // life fraction at which the streak passes through gold

/** Spawn recipe for one puff voice. Module-level singletons — never allocated. */
interface PuffKind {
  from: THREE.Color;
  to: THREE.Color;
  peak: number; // peak opacity
  lifeLo: number;
  lifeHi: number;
  baseLo: number; // spawn scale (m)
  baseHi: number;
  growLo: number; // scale added over the life
  growHi: number;
  spread: number; // lateral spawn velocity (m/s)
  riseLo: number;
  riseHi: number;
  buoy: number; // vertical accel (m/s²): + billows, − settles
  drag: number; // lateral velocity decay per second
}

const SMOKE_KIND: PuffKind = {
  from: C_SMOKE_HOT,
  to: C_SMOKE_COOL,
  peak: 0.58,
  lifeLo: 0.48,
  lifeHi: 0.68,
  baseLo: 0.6,
  baseHi: 0.95,
  growLo: 1.9,
  growHi: 2.8,
  spread: 0.9,
  riseLo: 1.7,
  riseHi: 2.8,
  buoy: 0.9, // tyre smoke keeps climbing
  drag: 1.1,
};

const DUST_KIND: PuffKind = {
  from: C_DUST_HOT,
  to: C_DUST_COOL,
  peak: 0.72,
  lifeLo: 0.6,
  lifeHi: 0.85,
  baseLo: 0.8,
  baseHi: 1.3,
  growLo: 2.5,
  growHi: 3.6,
  spread: 1.5, // a rooster tail is wider than a smoke puff
  riseLo: 1.1,
  riseHi: 2.0,
  buoy: -1.9, // heavy: the plume settles back toward the verge
  drag: 0.7,
};

/** Spawn recipe for one spark voice. Module-level singletons — never allocated. */
interface SparkKind {
  hot: THREE.Color;
  cool: THREE.Color;
  count: number;
  peak: number;
  lifeLo: number;
  lifeHi: number;
  outLo: number; // lateral speed (m/s)
  outHi: number;
  upLo: number;
  upHi: number;
  grav: number;
  w: number; // cross-section scale
  len: number; // length scale
}

const SPARK_IMPACT: SparkKind = {
  hot: C_IMPACT_HOT,
  cool: C_IMPACT_COOL,
  count: 7,
  peak: 0.95,
  lifeLo: 0.24,
  lifeHi: 0.4,
  outLo: 2.5,
  outHi: 7,
  upLo: 2.5,
  upHi: 6.5,
  grav: SPARK_GRAVITY,
  w: 1,
  len: 1,
};

const SPARK_DRIFT_WARM: SparkKind = {
  hot: C_DRIFT_WARM_HOT,
  cool: C_DRIFT_WARM_COOL,
  count: 1,
  peak: 0.85,
  lifeLo: 0.18,
  lifeHi: 0.28,
  outLo: 1.6,
  outHi: 4.2,
  upLo: 1.2,
  upHi: 3.0,
  grav: DRIFT_GRAVITY,
  w: 0.8,
  len: 0.5,
};

const SPARK_DRIFT_HOT: SparkKind = {
  hot: C_DRIFT_HOT_HOT,
  cool: C_DRIFT_HOT_COOL,
  count: 2, // the hot stage throws a visibly denser shower
  peak: 1,
  lifeLo: 0.2,
  lifeHi: 0.32,
  outLo: 2.0,
  outHi: 5.0,
  upLo: 1.6,
  upHi: 3.6,
  grav: DRIFT_GRAVITY,
  w: 0.9,
  len: 0.62,
};

interface SkidSlot {
  mesh: THREE.Mesh; // ink core streak
  mat: THREE.MeshBasicMaterial; // unlit decal — readable in sun or shadow
  halo: THREE.Mesh; // wider, lower-alpha `ink` feather under the core
  haloMat: THREE.MeshBasicMaterial;
  age: number; // seconds since laid; >= SKID_FADE_S => free
  maxOp: number; // per-mark peak opacity (seeded jitter — kills the stamped look)
}

interface PuffSlot {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  from: THREE.Color; // per-slot endpoints, copied from a PuffKind at spawn
  to: THREE.Color;
  age: number;
  life: number;
  vx: number;
  vy: number;
  vz: number;
  buoy: number;
  drag: number;
  base: number; // spawn scale (m) — seeded per puff
  grow: number; // scale added over the life
  spin: number; // material rotation rate
  maxOp: number; // peak opacity
}

interface SparkSlot {
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial;
  hot: THREE.Color; // per-slot endpoints, copied from a SparkKind at spawn
  cool: THREE.Color;
  age: number;
  life: number;
  vx: number;
  vy: number;
  vz: number;
  grav: number;
  peak: number;
  w: number;
  len: number;
}

/**
 * One sliding kart's grip-loss envelope. Allocated once (HEAT_STREAMS of them)
 * and recycled: `heat <= 0` means the slot is free. Tracked by last puff
 * position because `smoke()` carries no kart id — see HEAT_STREAM_R2.
 */
interface HeatStream {
  x: number; // last puff position — the stream's tracking anchor
  z: number;
  heat: number; // 0..1 grip-loss envelope for THIS kart alone
  tick: number; // puffs emitted by this stream — paces its own drift sparks
}

interface TrailSlot {
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial;
  age: number;
  life: number;
  roll: number; // seeded barrel roll — the ribbon flickers instead of laddering
  girth: number; // seeded cross-section
}

/** Soft radial-gradient disc texture (procedural — no assets), shared by all puffs. */
function puffTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  if (ctx !== null) {
    // denser core + a longer soft falloff: puffs read as volume, not as a ring
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.72)');
    g.addColorStop(0.68, 'rgba(255,255,255,0.28)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(c);
}

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
  private readonly speedSpin: string[] = []; // per-line `rotate(...)` prefix (constant)
  private speedLevel = 0; // eased 0..1 speed-line intensity
  private speedQuant = -1; // last level bucket written to transform (write gate)
  // one grip-loss envelope per sliding kart, fed by smoke(); allocated once
  private readonly heat: HeatStream[] = [];
  private t = 0; // accumulated fx clock (deterministic — dt-driven only)

  constructor(root: THREE.Object3D | null, overlay: HTMLElement) {
    this.root = root;
    // plain data, no scene graph: built even when the 3D pools are not
    for (let i = 0; i < HEAT_STREAMS; i++) this.heat.push({ x: 0, z: 0, heat: 0, tick: 0 });
    if (root !== null) {
      // ---- skid marks: unit quad pre-rotated flat (+y facing), scaled per slot.
      // UNLIT basic materials: decal overlays whose read must not depend on the
      // sun/shadow rig. Two quads per mark, both `ink` (L 7.6): an opaque-ish
      // core over a wider, lower-alpha feather. Measured composites against the
      // retuned road tiers (asphaltLit L 41.3 / asphaltLight L 33.8 / asphalt
      // L 26.4 / asphaltDeep L 15.9) — core at its 0.68-0.92 jittered alpha
      // drops them by 16.2-27.3 / 13.2-21.7 / 10.0-16.2 / 5.2-7.2 L, feather by
      // 2.5-3.5 L even on the shoulder. It is deliberately NOT `charcoal`:
      // charcoal is L 15.90 against asphaltDeep's L 15.87, a dead value match
      // that made the feather vanish on the one tier it exists to serve.
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
          color: KPAL.ink, // same pigment as the core; SKID_HALO_OPACITY feathers it
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });
        const halo = new THREE.Mesh(skidGeo, haloMat);
        halo.scale.set(SKID_W * SKID_HALO_W, 1, SKID_LEN * SKID_HALO_LEN);
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
        this.puffs.push({
          sprite,
          mat,
          from: new THREE.Color(KPAL.curbWhite),
          to: new THREE.Color(KPAL.curbWhite),
          age: 0,
          life: 0,
          vx: 0,
          vy: 0,
          vz: 0,
          buoy: 0,
          drag: 0,
          base: 0.8,
          grow: 1,
          spin: 0,
          maxOp: 0,
        });
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
        this.sparksPool.push({
          mesh,
          mat,
          hot: new THREE.Color(KPAL.gold),
          cool: new THREE.Color(KPAL.kartOrange),
          age: 0,
          life: 0,
          vx: 0,
          vy: 0,
          vz: 0,
          grav: SPARK_GRAVITY,
          peak: 0.95,
          w: 1,
          len: 1,
        });
      }

      // ---- nitro trail: hot speed-line streaks, world-locked behind the kart.
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
        this.trails.push({ mesh, mat, age: 0, life: 0, roll: 0, girth: 1 });
      }
    }

    // ---- camera speed lines: DOM streaks in two side fans. left/top are written
    // ONCE here; only transform + opacity move per frame (§9 seam rule — K5's
    // stylesheet must not touch left/top/transform/opacity on .fx-speedline).
    const wrap = document.createElement('div');
    wrap.className = 'fx-speedlines';
    const perSide = SPEEDLINE_COUNT / 2;
    for (let i = 0; i < SPEEDLINE_COUNT; i++) {
      // two fans hugging the left and right screen edges, where real motion
      // parallax lives — a full rim ring puts bars over the sky and the HUD.
      const j = i % perSide;
      const rightSide = i < perSide;
      const fan = (j - (perSide - 1) / 2) * SPEEDLINE_FAN + rngRange(this.next, -0.08, 0.08);
      const a = rightSide ? fan : Math.PI - fan;
      const rad = SPEEDLINE_RADIUS + rngRange(this.next, -3, 3);
      const line = document.createElement('div');
      line.className = 'fx-speedline';
      line.style.left = `${(50 + rad * Math.cos(a)).toFixed(2)}%`;
      line.style.top = `${(50 + SPEEDLINE_RISE * Math.sin(a)).toFixed(2)}%`;
      line.style.transform = `rotate(${a.toFixed(3)}rad)`;
      line.style.opacity = '0';
      wrap.appendChild(line);
      this.speedLines.push(line);
      this.speedSpin.push(`rotate(${a.toFixed(3)}rad) `);
    }
    overlay.appendChild(wrap);
  }

  /** Lay one skid quad at (x,z), its length axis along (dirX,dirZ). */
  skid(x: number, z: number, dirX: number, dirZ: number): void {
    if (this.root === null) return;
    const slot = this.skids[this.skidCursor]!;
    this.skidCursor = (this.skidCursor + 1) % this.skids.length;
    slot.age = 0;
    // seeded per-mark alpha/size/heading jitter: breaks the stamped-decal read
    slot.maxOp = SKID_MAX_OPACITY * rngRange(this.next, 0.74, 1);
    const wj = rngRange(this.next, 0.86, 1.18);
    const lj = rngRange(this.next, 0.9, 1.3);
    const yaw =
      Math.atan2(dirX, dirZ) + rngRange(this.next, -SKID_YAW_JITTER, SKID_YAW_JITTER);
    slot.mat.opacity = slot.maxOp;
    slot.mesh.position.set(x, SKID_Y, z);
    slot.mesh.rotation.y = yaw; // local +z -> dir
    slot.mesh.scale.set(SKID_W * wj, 1, SKID_LEN * lj);
    slot.mesh.visible = true;
    slot.haloMat.opacity = slot.maxOp * SKID_HALO_OPACITY;
    slot.halo.position.set(x, SKID_Y - 0.001, z);
    slot.halo.rotation.y = yaw;
    slot.halo.scale.set(SKID_W * SKID_HALO_W * wj, 1, SKID_LEN * SKID_HALO_LEN * lj);
    slot.halo.visible = true;
  }

  /**
   * Drift smoke puff at (x,y,z). Also drives the grip-loss envelope: a sustained
   * slide smokes harder and starts throwing drift sparks off the same call, so
   * app.ts feeds no extra facts and the emitter API stays frozen. The envelope
   * belongs to the ONE kart this puff came from (streams resolved by position —
   * HEAT_STREAM_R2), so density and spark stage read that kart's own slide and
   * nothing else on the circuit.
   */
  smoke(x: number, y: number, z: number): void {
    if (this.root === null) return;
    const s = this.stream(x, z);
    s.x = x;
    s.z = z;
    s.heat = Math.min(1, s.heat + DRIFT_HEAT_GAIN);
    s.tick++;
    this.puff(x, y, z, SMOKE_KIND, 0.72 + 0.38 * s.heat);
    if (s.heat >= DRIFT_SPARK_HOT) {
      if (s.tick % 2 === 0) this.emitSparks(x, y - 0.12, z, SPARK_DRIFT_HOT);
    } else if (s.heat >= DRIFT_SPARK_ON) {
      if (s.tick % 3 === 0) this.emitSparks(x, y - 0.12, z, SPARK_DRIFT_WARM);
    }
  }

  /** Off-road dust plume at (x,y,z): earth at the wheel, sunlit as it lifts. */
  dust(x: number, y: number, z: number): void {
    this.puff(x, y, z, DUST_KIND, 1);
  }

  /** Brief spark burst at (x,y,z) — a barrier hit. */
  sparks(x: number, y: number, z: number): void {
    this.emitSparks(x, y, z, SPARK_IMPACT);
  }

  /** One nitro streak at (x,y,z), aligned to (dirX,dirZ). */
  trail(x: number, y: number, z: number, dirX: number, dirZ: number): void {
    if (this.root === null) return;
    const slot = this.trails[this.trailCursor]!;
    this.trailCursor = (this.trailCursor + 1) % this.trails.length;
    slot.age = 0;
    slot.life = TRAIL_LIFE_S;
    slot.roll = rngRange(this.next, -Math.PI, Math.PI);
    slot.girth = rngRange(this.next, 0.9, 1.5);
    slot.mat.opacity = TRAIL_PEAK;
    slot.mat.color.copy(C_TRAIL_HOT);
    slot.mat.emissive.copy(C_TRAIL_HOT);
    slot.mesh.position.set(x, y, z);
    slot.mesh.rotation.set(0, Math.atan2(dirX, dirZ), slot.roll);
    slot.mesh.scale.set(slot.girth, slot.girth, 1);
    slot.mesh.visible = true;
  }

  /** Advance every pool + the speed-line overlay. speedMps drives the lines. */
  update(dt: number, speedMps: number): void {
    this.t += dt;
    // every live envelope decays on its own — a kart that stops sliding cools
    // out and frees its stream (~0.6s from full) without touching the others
    for (const s of this.heat) {
      if (s.heat <= 0) continue;
      s.heat -= DRIFT_HEAT_DECAY * dt;
      if (s.heat <= 0) {
        s.heat = 0;
        s.tick = 0;
      }
    }

    for (const s of this.skids) {
      if (s.age >= SKID_FADE_S) continue;
      s.age += dt;
      if (s.age >= SKID_FADE_S) {
        s.mesh.visible = false;
        s.mat.opacity = 0;
        s.halo.visible = false;
        s.haloMat.opacity = 0;
      } else {
        // hold near full for the first half of the life, then ramp out: a fresh
        // slide has to still be legible several corners later.
        const fade = Math.min(1, SKID_HOLD * (1 - s.age / SKID_FADE_S));
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
      p.vy += p.buoy * dt;
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vx *= damp;
      p.vz *= damp;
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.position.z += p.vz * dt;
      const scale = p.base + p.grow * k;
      p.sprite.scale.set(scale, scale, 1);
      // quick bloom in, long dissolve out: a puff emerges instead of popping
      const rise = Math.min(1, k / PUFF_RISE);
      p.mat.opacity = p.maxOp * rise * (1 - k) * (1 - k * 0.35);
      p.mat.color.copy(p.from).lerp(p.to, k);
      p.mat.rotation += p.spin * dt;
    }

    for (const s of this.sparksPool) {
      if (s.age >= s.life) continue;
      s.age += dt;
      s.vy -= s.grav * dt;
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
      // orient along the velocity (tracer read), cool + shrink out
      m.rotation.y = Math.atan2(s.vx, s.vz);
      m.rotation.x = -Math.atan2(s.vy, Math.hypot(s.vx, s.vz));
      const k = s.age / s.life;
      s.mat.opacity = s.peak * (1 - k);
      s.mat.color.copy(s.hot).lerp(s.cool, k);
      s.mat.emissive.copy(s.mat.color);
      const sh = 1 - k * 0.45;
      m.scale.set(s.w * sh, s.w * sh, s.len * (1 + k * 0.5));
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
      tr.mat.opacity = TRAIL_PEAK * (1 - k) * (1 - k);
      // three-stop cool-down: white-hot at the pipe, gold, then orange embers
      if (k < TRAIL_KNEE) {
        tr.mat.color.copy(C_TRAIL_HOT).lerp(C_TRAIL_MID, k / TRAIL_KNEE);
      } else {
        tr.mat.color.copy(C_TRAIL_MID).lerp(C_TRAIL_COOL, (k - TRAIL_KNEE) / (1 - TRAIL_KNEE));
      }
      tr.mat.emissive.copy(tr.mat.color);
      // stretch along the axis while thinning: reads as motion, not as a shrinking bar
      const thin = tr.girth * (1 - k * 0.7);
      tr.mesh.scale.set(thin, thin, 1 + k * TRAIL_STRETCH);
    }

    // camera speed lines: eased intensity, per-line phase flicker (deterministic).
    // opacity moves every frame; transform only when the eased level actually
    // changes bucket, so a steady-speed straight costs zero transform writes.
    const target = Math.min(1, Math.max(0, (speedMps - SPEEDLINE_MIN) / 8));
    this.speedLevel += (target - this.speedLevel) * Math.min(1, 8 * dt);
    const level = this.speedLevel;
    if (level < 0.02) {
      if (this.speedQuant !== -1) {
        this.speedQuant = -1;
        for (const line of this.speedLines) line.style.opacity = '0';
      }
      return;
    }
    const q = Math.round(level * SPEEDLINE_QUANT);
    const moved = q !== this.speedQuant;
    if (moved) this.speedQuant = q;
    const lq = q / SPEEDLINE_QUANT;
    const push = (SPEEDLINE_PUSH * lq).toFixed(1);
    const stretch = (0.5 + 1.05 * lq).toFixed(2);
    for (let i = 0; i < this.speedLines.length; i++) {
      const line = this.speedLines[i]!;
      const flicker = 0.62 + 0.38 * Math.sin(this.t * 14 + i * 1.7);
      line.style.opacity = (SPEEDLINE_MAX_OPACITY * level * flicker).toFixed(3);
      if (moved) {
        line.style.transform = `${this.speedSpin[i]!}translateX(${push}px) scaleX(${stretch})`;
      }
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
    for (const s of this.heat) {
      s.heat = 0;
      s.tick = 0;
      s.x = 0;
      s.z = 0;
    }
    this.speedLevel = 0;
    this.speedQuant = -1;
    for (const line of this.speedLines) line.style.opacity = '0';
  }

  // ---- internals --------------------------------------------------------------

  /**
   * The grip-loss envelope this puff belongs to: the nearest live stream within
   * HEAT_STREAM_R2, else a fresh one. Allocation-free (fixed pool, linear scan
   * over <= HEAT_STREAMS) and fully deterministic — no rng, no clock. When the
   * pool is saturated the coldest stream is recycled: it is the one closest to
   * expiring anyway, so no active slide loses its envelope.
   */
  private stream(x: number, z: number): HeatStream {
    let best: HeatStream | null = null;
    let bestD2 = HEAT_STREAM_R2;
    let free: HeatStream | null = null;
    let coldest = this.heat[0]!;
    for (const s of this.heat) {
      if (s.heat <= 0) {
        if (free === null) free = s;
        continue;
      }
      const dx = x - s.x;
      const dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = s;
      }
      if (s.heat < coldest.heat) coldest = s;
    }
    if (best !== null) return best;
    const slot = free ?? coldest; // free slots first; else evict the coldest
    slot.heat = 0;
    slot.tick = 0;
    return slot;
  }

  private puff(x: number, y: number, z: number, k: PuffKind, opScale: number): void {
    if (this.root === null) return;
    const slot = this.puffs[this.puffCursor]!;
    this.puffCursor = (this.puffCursor + 1) % this.puffs.length;
    slot.age = 0;
    slot.life = rngRange(this.next, k.lifeLo, k.lifeHi);
    slot.vx = rngRange(this.next, -k.spread, k.spread);
    slot.vz = rngRange(this.next, -k.spread, k.spread);
    slot.vy = rngRange(this.next, k.riseLo, k.riseHi);
    slot.buoy = k.buoy;
    slot.drag = k.drag;
    slot.base = rngRange(this.next, k.baseLo, k.baseHi); // size variation per puff
    slot.grow = rngRange(this.next, k.growLo, k.growHi);
    slot.spin = rngRange(this.next, -1.4, 1.4);
    slot.from.copy(k.from);
    slot.to.copy(k.to);
    slot.maxOp = Math.min(1, k.peak * opScale * rngRange(this.next, 0.82, 1)); // alpha variation
    slot.mat.color.copy(k.from);
    slot.mat.opacity = slot.maxOp;
    slot.sprite.position.set(x, y, z);
    slot.sprite.scale.set(slot.base, slot.base, 1);
    slot.sprite.visible = true;
  }

  private emitSparks(x: number, y: number, z: number, k: SparkKind): void {
    if (this.root === null) return;
    for (let n = 0; n < k.count; n++) {
      const slot = this.sparksPool[this.sparkCursor]!;
      this.sparkCursor = (this.sparkCursor + 1) % this.sparksPool.length;
      const ang = this.next() * Math.PI * 2;
      const out = rngRange(this.next, k.outLo, k.outHi);
      slot.age = 0;
      slot.life = rngRange(this.next, k.lifeLo, k.lifeHi);
      slot.vx = Math.cos(ang) * out;
      slot.vz = Math.sin(ang) * out;
      slot.vy = rngRange(this.next, k.upLo, k.upHi);
      slot.grav = k.grav;
      slot.peak = k.peak;
      slot.w = k.w;
      slot.len = k.len;
      slot.hot.copy(k.hot);
      slot.cool.copy(k.cool);
      slot.mat.color.copy(k.hot);
      slot.mat.emissive.copy(k.hot);
      slot.mat.opacity = k.peak;
      slot.mesh.position.set(x, y, z);
      slot.mesh.scale.set(k.w, k.w, k.len);
      slot.mesh.visible = true;
    }
  }
}
