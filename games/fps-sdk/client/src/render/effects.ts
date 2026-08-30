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
//
// VISUAL_UPGRADE.md §1 pass: the palette retune dropped every GROUND material
// (dust 63->50, carpet 34->29, tarmac is new at 34, snowShadow 66->58) and
// lifted every main WALL (sand 73->80, brick 47->57, snow -> 89). FX that tint
// themselves with the struck surface's own hex therefore became invisible on
// contact — debris the same value as the thing it came off reads as nothing.
// Every surface-derived FX colour here is now a LADDER PARTNER of the struck
// material (TRIM_MAT / CONTACT_MAT / DARK_MAT from the frozen tables), chosen
// per material so the debris always clears the surface it is seen against.
// No colour in this file is eyeballed and none is a literal hex.
// ============================================================================
import * as THREE from 'three';
import {
  CONTACT_MAT,
  DARK_MAT,
  IMPACT_MAT,
  PALETTE,
  TRIM_MAT,
  rng,
  rngRange,
  type MatId,
  type Team,
  type Vec3,
} from '@fps/shared';
import { L } from '@platform/shared';
import { box } from '../contract/visual.js';
import { MAT_COLORS } from './mapRenderer.js';

// ---- pool sizes (frozen by CONTRACT: ≤64 tracers, ≤256 particles, 64 decals) -
const TRACER_POOL = 64;
const PARTICLE_POOL = 256;
const DECAL_POOL = 64;
const SMOKE_POOL = 24; // small quad meshes (contract allows quads next to Points)

// ---- tracer tuning -----------------------------------------------------------
// The walls got LIGHTER this round (sand L80, plaster L83, snow L89), so an
// additive streak clips to white against them and loses its edge. Two answers,
// both inside the envelope: a wider bright core so the streak survives at
// distance, and a distinctly wider warm `fire` halo around it — against the
// neutral-to-warm new walls the halo is a HUE break even where value saturates.
const TRACER_LIFE = 0.06; // s — spec: 60ms fading line
const TRACER_WIDTH = 0.019; // bright head segment cross-section (was 0.013)
const TRACER_HEAD_LEN = 3.4; // m — only the leading segment runs bright
const TRACER_HEAD_OFF = 0.9; // m — head starts just past the muzzle
const TRACER_TAIL_WIDTH = 0.05; // warm halo cross-section (was 0.03)
const TRACER_TAIL_OPACITY = 0.26; // low, and dies fast (quadratic fade)
const TRACER_HOLD = 1.55; // opacity multiplier: the head holds hot, then drops

// ---- particle tuning ---------------------------------------------------------
const PARTICLE_SIZE = 0.065; // spec: size ~0.06, sizeAttenuation
const PARK_Y = -10000; // dead slots park far below the map (alpha is also 0)

// ---- decal tuning ------------------------------------------------------------
const DECAL_SIZE = 0.09; // ~0.09u splat quad per spec
const DECAL_DEPTH = 0.004; // paper-thin box — reads as a flat quad
const DECAL_LIFE = 45; // s — splat persists, then fades out
const DECAL_FADE = 5; // s — opacity ramps to 0 over the final stretch
const DECAL_OFFSET = 0.02; // nudge toward the camera so it doesn't z-fight
const DECAL_HOT = 0.16; // s — fresh mark blooms down to its settled size
const DECAL_HOT_GROW = 0.5; // extra scale at the instant of the hit
const DECAL_PEAK = 0.86; // settled opacity — a scar, not an opaque sticker

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

// ---- per-material FX colour resolution (VISUAL_UPGRADE.md §1) ----------------
// Above this L* a surface is bright enough that debris must go DARK to read;
// below it, debris goes LIGHT. 62 is deliberately above `snowShadow` (L58) so
// Frostbite's ground still throws white powder, and below `sandDark` (L62) so
// Dustbowl's lifted walls throw shadowed grit.
const BRIGHT_L = 62;
// A ladder partner closer than this to its parent is not a readable break, so
// we take a second step along the ladder instead of shipping a mush hit.
const MIN_STEP_L = 14;
// A decal is a dark scar wherever the surface can carry one; below this the
// surface is too dark for any scar and the mark becomes bright spall instead
// (chipped asphalt, bare metal, torn carpet backing — all genuinely lighter).
const DECAL_DARK_L = 40;

interface Rgb { r: number; g: number; b: number }

/** hex -> linear working-space rgb, the same conversion mat() performs. */
function linRgb(hex: string): Rgb {
  const c = new THREE.Color(hex);
  return { r: c.r, g: c.g, b: c.b };
}

/** One step DOWN the frozen ladder, or null at the bottom of the family. */
function stepDown(m: MatId): MatId | null {
  const c = CONTACT_MAT[m];
  if (c !== null) return c;
  const d = DARK_MAT[m];
  return d === m ? null : d;
}

/**
 * The colour debris off `m` must be so it reads AGAINST `m`. Bright surfaces
 * get their contact band, dark surfaces get their trim tier (twice over when
 * one step is not a real break). Same family throughout, so the hit still
 * reads as that material — only the value flips.
 */
function contrastHex(m: MatId): string {
  const self = MAT_COLORS[m];
  const l = L(self);
  const up = TRIM_MAT[m];
  if (l >= BRIGHT_L || up === null) {
    const down = stepDown(m);
    return down === null ? PALETTE.charcoal : MAT_COLORS[down];
  }
  let lift: MatId = up;
  if (L(MAT_COLORS[lift]) - l < MIN_STEP_L) lift = TRIM_MAT[lift] ?? lift;
  const hex = MAT_COLORS[lift];
  return L(hex) - l < 4 ? PALETTE.concreteLit : hex;
}

/** Bullet-mark colour for a hit on `m` — dark scar, or bright spall if `m` is
 *  already too dark to show one. Every branch is a frozen ladder partner. */
function decalHex(m: MatId): string {
  const self = MAT_COLORS[m];
  const l = L(self);
  if (l >= DECAL_DARK_L) {
    const down = stepDown(m);
    if (down === null) return PALETTE.ink;
    const hex = MAT_COLORS[down];
    return l - L(hex) < MIN_STEP_L ? PALETTE.ink : hex;
  }
  const up = TRIM_MAT[m];
  if (up === null) return PALETTE.paper;
  let lift: MatId = up;
  if (L(MAT_COLORS[lift]) - l < MIN_STEP_L) lift = TRIM_MAT[lift] ?? lift;
  return MAT_COLORS[lift];
}

/** Precomputed once at module load: three linear rgbs per MatId, zero runtime
 *  cost and zero per-spawn allocation (Color.setRGB from these, never .set()). */
interface MatFx {
  /** The struck surface's own colour — carries material identity. */
  base: Rgb;
  /** Ladder partner that READS against the surface — the debris body. */
  contrast: Rgb;
  /** Bullet-mark colour for this surface. */
  decal: Rgb;
}
const MAT_FX = ((): Record<MatId, MatFx> => {
  const out = {} as Record<MatId, MatFx>;
  for (const id of Object.keys(MAT_COLORS) as MatId[]) {
    out[id] = {
      base: linRgb(MAT_COLORS[id]),
      contrast: linRgb(contrastHex(id)),
      decal: linRgb(decalHex(id)),
    };
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
  private readonly decalScale = new Float32Array(DECAL_POOL); // settled size
  private decalCursor = 0;
  // The material of the wall the current hit landed on, published by impact()
  // and CONSUMED (cleared) by the decal() that immediately follows it in
  // ClientGame's hit handler. Single-use, so a stale value can never leak into
  // a later mark; when it is absent the decal falls back to the neutral pair.
  private pendingDecalMat: MatId | undefined = undefined;

  // ---- smoke/dust pool: camera-facing quads that bloom, drift and fade -------
  private readonly smokes: THREE.Mesh[] = [];
  private readonly smokeLife = new Float32Array(SMOKE_POOL); // remaining, s
  private readonly smokeMax = new Float32Array(SMOKE_POOL);
  private readonly smokeVel = new Float32Array(SMOKE_POOL * 3);
  private readonly smokeGrow = new Float32Array(SMOKE_POOL * 2); // scale from,to
  private readonly smokeSpin = new Float32Array(SMOKE_POOL); // rad/s roll
  private readonly smokeRoll = new Float32Array(SMOKE_POOL); // accumulated roll
  private readonly smokePeak = new Float32Array(SMOKE_POOL); // peak opacity
  private readonly smokeIn = new Float32Array(SMOKE_POOL); // per-slot fade-in, s
  private readonly smokeAspect = new Float32Array(SMOKE_POOL); // height/width
  private smokeCursor = 0;

  private readonly scene: THREE.Scene;
  private cam: THREE.Object3D | null = null; // resolved lazily on first billboard
  private readonly scratchCamPos = new THREE.Vector3();

  // cosmetic rng — seeded, deterministic, never Math.random
  private readonly next = rng(0xc6f1);

  // recipe colors as linear-work-space rgb (same conversion as mat())
  // concreteLit, not concrete: the legacy no-material impact has to read on the
  // newly darkened grounds (tarmac L34, carpet L29, dust L50) as well as indoors.
  private readonly colDust = new THREE.Color(PALETTE.concreteLit);
  private readonly colSpark = new THREE.Color(PALETTE.muzzle);
  private readonly colFire = new THREE.Color(PALETTE.fire);
  private readonly colBlood = new THREE.Color(PALETTE.blood);
  private readonly colBloodLit = new THREE.Color(PALETTE.danger); // brighter spray
  private readonly colTeamT = new THREE.Color(PALETTE.tAmber);
  private readonly colTeamCT = new THREE.Color(PALETTE.ctBlue);
  private readonly colTeamTLit = new THREE.Color(PALETTE.tLit);
  private readonly colTeamCTLit = new THREE.Color(PALETTE.ctLit);
  // mid grey, not concreteDark: muzzle smoke hangs in front of the camera over
  // whatever the map happens to be, so it needs headroom in BOTH directions —
  // the per-puff shade jitter below carries it down to ~L40 against bright sky
  // and leaves it light enough to survive Bunker's near-black interior.
  private readonly colSmoke = new THREE.Color(PALETTE.concrete);
  private readonly colFootDust = new THREE.Color(PALETTE.concreteLit);
  private readonly scratchCol = new THREE.Color(); // per-spawn shade jitter
  // neutral fallback marks when a decal arrives without a known material
  private readonly decalInk = linRgb(PALETTE.ink);
  private readonly decalCharcoal = linRgb(PALETTE.charcoal);

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

    // decals: 64 flat splat quads, one cloned material per slot so colour and
    // opacity are independent. The colour is re-derived per hit from the struck
    // material's ladder partner (see decalHex) — the constructor tint is only
    // the fallback used when a mark arrives with no material.
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
    // tint + opacity are independent (muzzle smoke is grey, impact puffs take
    // the struck material's readable ladder partner, the muzzle flash core is
    // hot fire with its emissive driven near full).
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
   * the muzzle plus a warm halo for the full ray — reads as a shot, not a
   * muzzle-to-impact laser rail. The head holds near full brightness for the
   * first half of its life (TRACER_HOLD) so it registers against the lightened
   * walls instead of being a one-frame smear.
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
    // tail: the full-length warm halo, oriented along the ray
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
   * dust, metal throws a spark fan, snow bursts powder, wood throws chips,
   * foliage sheds green. Every tint is the struck material's readable ladder
   * partner (`contrast`) with its own colour (`base`) as the minority accent,
   * so the burst carries the material's hue while always clearing its value.
   * No mat (legacy callers) = neutral dust + sparks as before.
   */
  impact(p: Vec3, mat?: MatId): void {
    this.pendingDecalMat = mat; // consumed by the decal() that follows this hit
    if (mat === undefined) {
      const c = this.colDust;
      this.burst(p, 6, c.r, c.g, c.b, 0.8, 1.8, 0.6, 0.3, 0.45, 3.5);
      const s = this.colSpark;
      this.burst(p, 2, s.r, s.g, s.b, 3.5, 5.5, 0.2, 0.1, 0.16, 9.8);
      return;
    }
    const kind = MAT_KIND[mat];
    const fx = MAT_FX[mat];
    const t = fx.contrast;
    const b = fx.base;
    switch (kind) {
      case 'spark': {
        // metal: hot spark fan (muzzle yellow + fire orange), little dust
        const s = this.colSpark;
        this.burst(p, 5, s.r, s.g, s.b, 3.5, 6.0, 0.25, 0.1, 0.2, 9.8);
        const f = this.colFire;
        this.burst(p, 3, f.r, f.g, f.b, 3.0, 5.0, 0.2, 0.08, 0.16, 9.8);
        this.burst(p, 2, t.r, t.g, t.b, 0.8, 1.6, 0.5, 0.25, 0.4, 3.5);
        this.puff(p, 0.06, 0.3, 0.34, 0.42, t, 0.4, 0.7, 0.35, 0.42);
        break;
      }
      case 'snow': {
        // powder burst + lingering suspended puffs. `contrast` resolves to the
        // bright `snow` tier over Frostbite's snowShadow ground and to a grey
        // rock tier over rock, so the same branch stops throwing white powder
        // off a cliff face.
        this.burst(p, 7, t.r, t.g, t.b, 0.7, 1.7, 0.7, 0.35, 0.55, 3.0);
        this.burst(p, 2, b.r, b.g, b.b, 0.5, 1.2, 0.6, 0.3, 0.5, 2.5);
        this.puff(p, 0.08, 0.42, 0.5, 0.5, t, 0.15, 0.45, 0.5, 0.3);
        this.puff(p, 0.06, 0.3, 0.6, 0.36, t, 0.1, 0.4, 0.6, 0.3);
        break;
      }
      case 'chip': {
        // wood/crate: fast chunky chips + a little dust
        this.burst(p, 6, t.r, t.g, t.b, 1.8, 3.4, 0.5, 0.2, 0.35, 8);
        this.burst(p, 2, b.r, b.g, b.b, 0.7, 1.5, 0.6, 0.3, 0.45, 3.5);
        break;
      }
      case 'leaf': {
        // foliage: shed leaves, slow fall
        this.burst(p, 5, t.r, t.g, t.b, 1.0, 2.2, 0.7, 0.35, 0.6, 4.5);
        this.burst(p, 2, b.r, b.g, b.b, 0.8, 1.8, 0.7, 0.35, 0.6, 4.0);
        break;
      }
      default: {
        // dust: sand/plaster/masonry/tarmac/carpet — a cloud that clears the
        // surface in value, plus a soft puff that lingers a beat longer than
        // the particles (reads as a real impact, not a sprinkle)
        this.burst(p, 6, t.r, t.g, t.b, 0.8, 1.9, 0.65, 0.3, 0.5, 3.5);
        this.burst(p, 2, b.r, b.g, b.b, 0.6, 1.4, 0.55, 0.25, 0.4, 3.2);
        const s = this.colSpark;
        this.burst(p, 1, s.r, s.g, s.b, 3.5, 5.0, 0.2, 0.1, 0.14, 9.8);
        this.puff(p, 0.07, 0.4, 0.48, 0.48, t, 0.2, 0.55, 0.45, 0.34);
        break;
      }
    }
  }

  /**
   * Muzzle blast: a hot flash core that blooms and dies in ~70ms, followed by
   * two grey puffs drifting along the shot direction. Called for own AND remote
   * shots, so the flash core is what gives a distant shooter's position away —
   * the crossed emissive quads on the player model are only 2 flat cards, and
   * this gives them a volume that survives at range.
   */
  muzzleSmoke(p: Vec3, dir: Vec3): void {
    // flash core — fire tinted, emissive driven near full, gone almost at once
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
      const k = 0.07 + n * 0.11; // stagger the puffs along the barrel line
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

  /**
   * Sprint footstep dust: 1 small low puff at the feet. Tinted by the floor
   * material's readable ladder partner rather than the floor's own hex — every
   * map's ground dropped in value this round, so a puff tinted with the ground
   * itself would be invisible exactly where it spawns.
   */
  footDust(p: Vec3, floorMat?: MatId): void {
    const t = floorMat !== undefined ? MAT_FX[floorMat].contrast : undefined;
    const col = t !== undefined ? this.scratchCol.setRGB(t.r, t.g, t.b) : this.colFootDust;
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
      col,
      0.3,
    );
  }

  /**
   * Flesh hit: the single most important read in the game. 6 dark spray
   * particles carrying the `blood` body plus 2 brighter `danger` droplets that
   * survive against dark cover, and a short mist puff so a landed shot has a
   * silhouette and not just a sparkle. 8 particles — inside CONTRACT's 5-8.
   */
  blood(p: Vec3): void {
    const b = this.colBlood;
    this.burst(p, 6, b.r, b.g, b.b, 1.5, 2.8, 0.5, 0.28, 0.42, 9);
    const h = this.colBloodLit;
    this.burst(p, 2, h.r, h.g, h.b, 2.4, 4.2, 0.55, 0.2, 0.34, 9);
    this.puffAt(
      p.x,
      p.y,
      p.z,
      rngRange(this.next, -0.25, 0.25),
      rngRange(this.next, 0.15, 0.4),
      rngRange(this.next, -0.25, 0.25),
      0.07,
      rngRange(this.next, 0.24, 0.32),
      rngRange(this.next, 0.22, 0.3),
      0.5,
      this.colBlood,
      0.36,
    );
  }

  /**
   * Bullet mark on world geometry: small splat quad. Billboarded toward the
   * camera and nudged slightly along (camera - p) at spawn so it never
   * z-fights the wall, then static; fades out after 45s; oldest recycled.
   *
   * The mark's colour comes from the material `impact()` just reported for this
   * same hit: a dark scar where the surface can carry one, bright spall where
   * it cannot. Before the retune every mark was `ink`/`charcoal`, which meant
   * Bunker's metalDeep walls (L14) and Office's carpet took marks nobody could
   * see. It also opens with a brief oversized hot flare that settles to size —
   * that beat is what makes a hit feel landed.
   */
  decal(p: Vec3): void {
    const cam = this.ensureCam();

    // Ring order == age order (uniform life), so the cursor slot is the oldest.
    const i = this.decalCursor;
    this.decalCursor = (i + 1) % DECAL_POOL;
    const m = this.decals[i]!; // pool is fully populated in the constructor

    const mat = m.material as THREE.MeshLambertMaterial;
    const pending = this.pendingDecalMat;
    this.pendingDecalMat = undefined; // single use — never leaks to a later mark
    const tint =
      pending !== undefined
        ? MAT_FX[pending].decal
        : i % 2 === 0
          ? this.decalInk
          : this.decalCharcoal;
    mat.color.setRGB(tint.r, tint.g, tint.b);

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
    this.decalScale[i] = s;
    const hot = s * (1 + DECAL_HOT_GROW);
    m.scale.set(hot, hot, 1);
    m.visible = true;
    mat.opacity = 1;
    this.decalLife[i] = DECAL_LIFE;
  }

  /**
   * Player death: 12 team-colored burst particles — 8 in the team base, 4 in
   * the bright team tier so the burst still resolves at distance against a
   * lightened wall — plus two team-tinted puffs so a kill has a shape.
   */
  death(p: Vec3, team: Team): void {
    const t = team === 'CT' ? this.colTeamCT : this.colTeamT;
    const lit = team === 'CT' ? this.colTeamCTLit : this.colTeamTLit;
    this.burst(p, 8, t.r, t.g, t.b, 2.2, 4.0, 0.8, 0.5, 0.7, 5);
    this.burst(p, 4, lit.r, lit.g, lit.b, 3.0, 5.2, 0.85, 0.4, 0.62, 5);
    for (let n = 0; n < 2; n++) {
      this.puffAt(
        p.x + rngRange(this.next, -0.12, 0.12),
        p.y + rngRange(this.next, -0.1, 0.2),
        p.z + rngRange(this.next, -0.12, 0.12),
        rngRange(this.next, -0.5, 0.5),
        rngRange(this.next, 0.3, 0.7),
        rngRange(this.next, -0.5, 0.5),
        0.12,
        rngRange(this.next, 0.7, 0.95),
        rngRange(this.next, 0.4, 0.55),
        0.44,
        lit,
        0.4,
      );
    }
  }

  /** Advance all pools. Zero allocation; uploads attributes only when live. */
  update(dt: number): void {
    // tracers: the bright head holds hot then collapses over 60ms; the warm
    // halo dies quadratically so the streak does not linger as a rail
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
      (core.material as THREE.MeshLambertMaterial).opacity = Math.min(1, k * TRACER_HOLD);
      const ck = 0.55 + 0.45 * k; // thins, but never to a hairline before it dies
      core.scale.set(ck, ck, core.scale.z);
      (glow.material as THREE.MeshLambertMaterial).opacity = TRACER_TAIL_OPACITY * k * k;
      const gk = 0.6 + 0.4 * k; // tail collapses toward nothing as it dies
      glow.scale.set(gk, gk, glow.scale.z);
    }

    // decals: a brief oversized hot flare on spawn, then a static scar that
    // eases out over the final DECAL_FADE seconds (smoothstep, so it holds its
    // read and then goes — a linear ramp leaves a flat grey ghost for seconds).
    // Must run before the particle early-out below.
    for (let i = 0; i < DECAL_POOL; i++) {
      const life = this.decalLife[i]!;
      if (life <= 0) continue;
      const m = this.decals[i]!;
      const mat = m.material as THREE.MeshLambertMaterial;
      const next = life - dt;
      if (next <= 0) {
        this.decalLife[i] = 0;
        m.visible = false;
        continue;
      }
      this.decalLife[i] = next;
      const elapsed = DECAL_LIFE - next;
      const base = this.decalScale[i]!;
      if (elapsed < DECAL_HOT) {
        const e = elapsed / DECAL_HOT;
        const back = (1 - e) * (1 - e); // ease-out collapse to the settled size
        mat.opacity = 1 - (1 - DECAL_PEAK) * e;
        const s = base * (1 + DECAL_HOT_GROW * back);
        m.scale.set(s, s, 1);
      } else {
        if (m.scale.x !== base) m.scale.set(base, base, 1);
        if (next < DECAL_FADE) {
          const t = next / DECAL_FADE;
          mat.opacity = DECAL_PEAK * t * t * (3 - 2 * t); // smoothstep
        } else {
          mat.opacity = DECAL_PEAK;
        }
      }
    }

    // smoke/dust: billboard toward the camera, bloom (grow fast then slow),
    // damp drift, gentle climb; opacity ramps in over a per-slot fade-in (so a
    // 70ms muzzle flash still reaches full) then eases out with life.
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
      const inT = this.smokeIn[i]!;
      const fadeIn = elapsed >= inT ? 1 : elapsed / inT;
      // smoothstep hold-then-drop: a puff should stay opaque while it blooms
      // and thin out at the end, not bleed linearly from the first frame
      const shape = k * k * (3 - 2 * k);
      (m.material as THREE.MeshLambertMaterial).opacity = this.smokePeak[i]! * fadeIn * shape;
      const g0 = this.smokeGrow[i * 2]!;
      const g1 = this.smokeGrow[i * 2 + 1]!;
      const u = 1 - k;
      const s = g0 + (g1 - g0) * u * (2 - u); // ease-out bloom
      m.scale.set(s, s * this.smokeAspect[i]!, 1);
      if (cam !== null) {
        m.lookAt(this.scratchCamPos);
        this.smokeRoll[i] = this.smokeRoll[i]! + this.smokeSpin[i]! * dt;
        m.rotateZ(this.smokeRoll[i]!);
      }
    }

    if (this.pActive === 0) {
      if (this.pDirty) {
        this.posAttr.needsUpdate = true;
        this.colAttr.needsUpdate = true;
        this.pDirty = false;
      }
      return;
    }

    // particles: gravity, integrate, eased alpha fade; park on death
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
      // hold opaque through the useful part of the life, then drop — a linear
      // ramp spends most of a burst at 30% alpha, which is why hits read weak
      const t = next / this.pMaxLife[i]!;
      col[i4 + 3] = t * t * (3 - 2 * t);
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
    this.pendingDecalMat = undefined;
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

  /** Convenience: one smoke puff AT an already-jittered position. `glow` is the
   *  emissive fraction — ~0.3 for smoke, 1 for the muzzle flash core. */
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
    const m = this.smokes[i]!; // pool is fully populated in the constructor
    m.position.set(x, y, z);
    const aspect = rngRange(this.next, 0.78, 1.02); // puffs are not circles
    this.smokeAspect[i] = aspect;
    m.scale.set(growFrom, growFrom * aspect, 1);
    m.visible = true;
    const mat = m.material as THREE.MeshLambertMaterial;
    // shade range spans both sides of the tint so a cloud has internal value
    // variation instead of reading as one cut-out blob
    const shade = rngRange(this.next, 0.6, 0.95);
    mat.color.copy(col).multiplyScalar(shade);
    mat.emissive.copy(col).multiplyScalar(shade * glow);
    mat.opacity = 0; // ramps in over smokeIn during update()
    const i3 = i * 3;
    this.smokeVel[i3] = vx;
    this.smokeVel[i3 + 1] = vy;
    this.smokeVel[i3 + 2] = vz;
    this.smokeGrow[i * 2] = growFrom;
    this.smokeGrow[i * 2 + 1] = growTo;
    this.smokeLife[i] = life;
    this.smokeMax[i] = life;
    this.smokePeak[i] = peak;
    // short-lived puffs (the muzzle flash) must reach full opacity inside their
    // own life, so the ramp is a fraction of it rather than a fixed constant
    this.smokeIn[i] = Math.min(SMOKE_FADE_IN, life * 0.3);
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
      glow,
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
      const shade = rngRange(this.next, 0.82, 1.06); // subtle value jitter
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
