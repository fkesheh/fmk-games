// ============================================================================
// ACES — C_FX/effects: bounded particle pools, tracers, blasts, shake.
//
// Implements the FROZEN seams.EffectsApi for C_APP/C_NET consumption:
//   anticipation → strike → aftermath (§7): every event answers in ink.
//
// POOL ARCHITECTURE (RULES 4/11):
//   ONE dense pool of FX_POOL_MAX (=600) particles in STRUCT-OF-ARRAYS form —
//   every field column is a typed array allocated ONCE at construction.
//   Lifetimes are SWAP-REMOVE: killing particle i moves the last live entry
//   into slot i, so the live set stays [0..n) with zero holes, zero garbage,
//   and cache-friendly linear iteration. When the pool is FULL, emissions are
//   silently dropped — alive count can NEVER exceed FX_POOL_MAX (flood-tested).
//   RNG rolls happen BEFORE spawn attempts so rng consumption is independent
//   of pool pressure — same seed + same emit sequence ⇒ identical particles.
//
// COLOR LAW (§2/§9): every visible string comes from alpha LADDERS built once
// at init via withAlpha over APAL keys — quantized per-draw indices, never
// fresh strings, never Math.random, gradients ONLY through the shared
// softPuff (blast/smoke/foam cores).
//
// TRACERS: snapshot projectiles are drawn STATELESSLY straight from bullet
// data each frame (no pool, CONTRACT C_NET "rendered straight from newest
// snapshot"); tracerStub exists only to bridge trigger-down → server bullets
// (RULES 10). The subtle glow is TWO FLAT STROKES (wide low-alpha halo under a
// thin solid core) — softPuff-per-bullet would be 120 radial gradients/frame
// and break the ≤12 ms frame budget, so the allowed-but-costly path is skipped
// deliberately; flat layered ink IS the house look anyway.
//
// SHAKE LAW: hitSpark → SHAKE.SMALL (your hits), explosion 'small' →
// SHAKE.MEDIUM (nearby blast), 'large' → SHAKE.LARGE (own death scale) —
// C_APP adds proximity context when consuming via consumeShake().
// ============================================================================

import { FX_POOL_MAX, SHAKE } from '@aces/shared/config.js';
import type { ApalKey } from '@aces/shared/palette.js';
import type { CameraView, EffectsApi } from '../contract/seams.js';
import { makeRng, softPuff, star, withAlpha } from '../contract/visual.js';

const TAU = Math.PI * 2;

/** Particle kinds (kept numeric so the pool stays typed-array-only). */
export const FX = {
  /** flash-core starburst (muzzle, sparks, pickup motes) */
  STAR: 0,
  /** soft radial mass — smoke / blast / foam / glare puffs */
  PUFF: 1,
  /** tumbling ink debris shard */
  SHARD: 2,
  /** oriented fading streak — tracer stubs, spark ticks */
  STREAK: 3,
  /** expanding stroked ring — blast ring, foam splash */
  RING: 4,
  /** fire ember — fireCore/fireEdge flicker */
  EMBER: 5,
} as const;

/** Style variants select which init-time ladder a particle reads at draw. */
const V_SMOKE = 0; // special-cased: smokeLt → smokeDk as puffs grow
const V_BLAST = 1;
const V_FLASH = 2;
const V_FOAM = 3;
const V_GLARE = 4;
const V_FIRE = 5;
const V_DEB = 6;
const V_TRACER = 7;
/** Solid flash-core strike disc (§3: the blast replaces the scene). */
const V_CORE = 8;

/**
 * Quantized alpha ladder over one palette key — the ONLY way visible strings
 * are made here. n buckets ⇒ at most n distinct styles per key exist, ever.
 */
function ladder(key: ApalKey, maxA: number, n = 13): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(withAlpha(key, (maxA * i) / (n - 1)));
  return out;
}

const SMOKE_LT = ladder('smokeLt', 0.52);
// raised 0.78→0.85 (art round 2): late-mid trail life must sit at the dark
// end of the smokeDk ladder instead of mid-gray.
const SMOKE_DK = ladder('smokeDk', 0.85);
const BLAST_LAD = ladder('blast', 1);
const FLASH_LAD = ladder('flash', 1);
const FOAM_LAD = ladder('foam', 0.85);
const GLARE_LAD = ladder('sunGlare', 0.95);
const FIRE_C = ladder('fireCore', 0.9);
const FIRE_E = ladder('fireEdge', 0.85);
const DEB_LAD = ladder('debris', 0.92);
const TRACER_LAD = ladder('tracer', 0.95, 7);

/** Transparent rims for softPuff (its documented calling convention). */
const OUT_BLAST = withAlpha('blast', 0);
const OUT_FLASH = withAlpha('flash', 0);
const OUT_FOAM = withAlpha('foam', 0);
const OUT_GLARE = withAlpha('sunGlare', 0);
const OUT_FIRE = withAlpha('fireEdge', 0);
const OUT_SMOKE = withAlpha('smokeDk', 0);
/** Transparent rim for the late-life ink-smoke phase (V_SMOKE final third). */
const OUT_DEB = withAlpha('debris', 0);
/**
 * Late-life trail puffs hold this debris-ladder tier floor (art round 2):
 * tier ≥10 ⇒ alpha ≥0.767, i.e. the darkest existing ink-smoke tone kept
 * ≥0.72 until the release sliver of life.
 */
const DEB_HOLD = 10;

/** Per-second velocity drag by kind — debris tumbles down fast, smoke drifts. */
const DRAG = new Float32Array([0, 0.8, 2.2, 0, 0, 2.6]);

/** Trail-emitter tuning. 24 smokers × ~12 live puffs ≈ 290 ≤ 600 pool cap. */
const MAX_TRAILS = 24;
const SMOKE_INT = 0.1;
const EMBER_INT = 0.055;

interface TrailEmitter {
  x: number;
  y: number;
  /** 1 = smoke, 2 = fire (fire implies smoke too). */
  lvl: 1 | 2;
  acc: number;
  cnt: number;
}

/**
 * The C_FX effects system. Constructed exactly once per client by C_APP via
 * createEffects(seed). Everything below the constructor is allocation-free in
 * steady state; the only Map churn is trail-emitter insertion, which is event-
 * driven and bounded (MAX_TRAILS, LRU-ish eviction).
 */
export class EffectsSystem implements EffectsApi {
  /** Live particle count — the pool is dense [0..n). */
  get alive(): number {
    return this.n;
  }

  get emitterCount(): number {
    return this.trails.size;
  }

  private readonly rng: () => number; // explicit-event stream
  private readonly trng: () => number; // emitter stream (kept separate so
  // trail timing never perturbs explosion rolls — determinism stays local)
  private n = 0;
  private shakeAcc = 0;

  // ---- pool columns -----------------------------------------------------
  private readonly kind = new Uint8Array(FX_POOL_MAX);
  private readonly sty = new Uint8Array(FX_POOL_MAX);
  private readonly px = new Float32Array(FX_POOL_MAX);
  private readonly py = new Float32Array(FX_POOL_MAX);
  private readonly vx = new Float32Array(FX_POOL_MAX);
  private readonly vy = new Float32Array(FX_POOL_MAX);
  private readonly age = new Float32Array(FX_POOL_MAX);
  private readonly ttl = new Float32Array(FX_POOL_MAX);
  private readonly dly = new Float32Array(FX_POOL_MAX); // anticipation delay
  private readonly r0 = new Float32Array(FX_POOL_MAX);
  private readonly r1 = new Float32Array(FX_POOL_MAX);
  private readonly rot = new Float32Array(FX_POOL_MAX); // angle / spin phase
  private readonly vrt = new Float32Array(FX_POOL_MAX); // angular velocity
  private readonly len = new Float32Array(FX_POOL_MAX); // streak length
  private readonly al = new Float32Array(FX_POOL_MAX); // base alpha

  private readonly trails = new Map<string, TrailEmitter>();

  constructor(seed: number) {
    this.rng = makeRng(seed >>> 0);
    this.trng = makeRng((seed ^ 0x9e3779b9) >>> 0);
  }

  // ---- pool plumbing ------------------------------------------------------

  /** Append one particle; silently drops when the pool is full (bounded law). */
  private spawn(
    kind: number,
    sty: number,
    x: number,
    y: number,
    vx: number,
    vy: number,
    dly: number,
    ttl: number,
    r0: number,
    r1: number,
    rot: number,
    vrt: number,
    len: number,
    al: number,
  ): void {
    if (this.n >= FX_POOL_MAX) return; // flood drop — never exceeds the cap
    const i = this.n++;
    this.kind[i] = kind;
    this.sty[i] = sty;
    this.px[i] = x;
    this.py[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.ttl[i] = ttl;
    this.dly[i] = dly;
    this.r0[i] = r0;
    this.r1[i] = r1;
    this.rot[i] = rot;
    this.vrt[i] = vrt;
    this.len[i] = len;
    this.al[i] = al;
  }

  /** Swap-remove: move the last live entry into the dead slot. */
  private kill(i: number): void {
    const last = --this.n;
    if (i === last) return;
    this.kind[i] = this.kind[last]!;
    this.sty[i] = this.sty[last]!;
    this.px[i] = this.px[last]!;
    this.py[i] = this.py[last]!;
    this.vx[i] = this.vx[last]!;
    this.vy[i] = this.vy[last]!;
    this.age[i] = this.age[last]!;
    this.ttl[i] = this.ttl[last]!;
    this.dly[i] = this.dly[last]!;
    this.r0[i] = this.r0[last]!;
    this.r1[i] = this.r1[last]!;
    this.rot[i] = this.rot[last]!;
    this.vrt[i] = this.vrt[last]!;
    this.len[i] = this.len[last]!;
    this.al[i] = this.al[last]!;
  }

  // ---- per-frame update -----------------------------------------------------

  update(dt: number): void {
    if (!(dt > 0)) return;
    const step = Math.min(dt, 0.12); // hitch clamp: a tab-switch never teleports ink
    for (let i = 0; i < this.n; ) {
      if (this.dly[i]! > 0) {
        this.dly[i] = this.dly[i]! - step; // anticipation: staged before its strike moment
        i++;
        continue;
      }
      const age = this.age[i]! + step;
      if (age >= this.ttl[i]!) {
        this.kill(i);
        continue; // re-process the swapped-in entry without advancing i
      }
      this.age[i] = age;
      const dr = DRAG[this.kind[i]!]! * step;
      const k = dr < 1 ? 1 - dr : 0;
      this.vx[i] = this.vx[i]! * k;
      this.vy[i] = this.vy[i]! * k;
      this.px[i] = this.px[i]! + this.vx[i]! * step;
      this.py[i] = this.py[i]! + this.vy[i]! * step;
      this.rot[i] = this.rot[i]! + this.vrt[i]! * step;
      i++;
    }
    this.advanceEmitters(step);
  }

  // ---- smoke/fire trail emitters ------------------------------------------

  /**
   * Per-plane emitter hook, called by C_APP every frame for smoking/burning
   * planes (SMOKE_BELOW / FIRE_BELOW). level null stops and forgets the
   * emitter. The map is LRU-ish: re-arming an existing id refreshes it; new
   * ids past MAX_TRAILS evict the oldest — 8 players + churn stays bounded.
   * Actual emission is timed in advanceEmitters so per-frame call order
   * cannot change particle production.
   */
  trail(id: string, x: number, y: number, level: 'smoke' | 'fire' | null): void {
    if (level === null) {
      this.trails.delete(id);
      return;
    }
    const e = this.trails.get(id);
    if (e) {
      e.x = x;
      e.y = y;
      e.lvl = level === 'fire' ? 2 : 1;
      this.trails.delete(id); // refresh recency before re-inserting
      this.trails.set(id, e);
      return;
    }
    if (this.trails.size >= MAX_TRAILS) {
      const oldest = this.trails.keys().next().value;
      if (oldest !== undefined) this.trails.delete(oldest);
    }
    this.trails.set(id, { x, y, lvl: level === 'fire' ? 2 : 1, acc: 0, cnt: 0 });
  }

  private advanceEmitters(dt: number): void {
    // Iterator over a ≤24-entry map — event-scale cost, not particle scale.
    for (const e of this.trails.values()) {
      e.acc += dt;
      if (e.lvl === 1) {
        while (e.acc >= SMOKE_INT) {
          e.acc -= SMOKE_INT;
          this.spawnTrailSmoke(e.x, e.y, false);
        }
      } else {
        while (e.acc >= EMBER_INT) {
          e.acc -= EMBER_INT;
          e.cnt++;
          this.spawnTrailEmber(e.x, e.y);
          if (e.cnt % 3 === 0) this.spawnTrailSmoke(e.x, e.y, true); // fire smokes too
        }
      }
    }
  }

  /** Growing gray-brown puff drifting EAST-downwind (§7), lt→dk→ink as it ages. */
  private spawnTrailSmoke(x: number, y: number, heavy: boolean): void {
    const r = this.trng();
    const r2 = this.trng();
    const r3 = this.trng();
    this.spawn(
      FX.PUFF,
      V_SMOKE,
      x + (r - 0.5) * 4,
      y + (r2 - 0.5) * 4,
      13 + r3 * 10,
      (this.trng() - 0.5) * 8,
      0,
      1.1 + r * 0.5,
      2.2 + r2 * 1.4,
      // late puffs ≥1.6× spawn size: these targets give a ≥3.5× ratio.
      13 + r3 * 8,
      0,
      0,
      0,
      // base alphas raised (art round 2) so the final phase holds the dark
      // ink tier instead of washing to mid-gray at distance.
      heavy ? 0.86 : 0.72,
    );
  }

  /** Flickering fireCore/fireEdge ember with violent short life. */
  private spawnTrailEmber(x: number, y: number): void {
    const r = this.trng();
    const r2 = this.trng();
    const r3 = this.trng();
    this.spawn(
      FX.EMBER,
      V_FIRE,
      x + (r - 0.5) * 3,
      y + (r2 - 0.5) * 3,
      (r - 0.5) * 36,
      (r2 - 0.5) * 36,
      0,
      0.26 + r3 * 0.14,
      2.6,
      0.5,
      r3 * TAU,
      0,
      0,
      0.95,
    );
  }

  // ---- events -----------------------------------------------------------------

  /** Muzzle flash: flash-core starburst for ~1–2 frames + brief smoke wisp. */
  muzzleFlash(x: number, y: number, h: number): void {
    const c = Math.cos(h);
    const s = Math.sin(h);
    this.spawn(FX.STAR, V_FLASH, x, y, c * 30, s * 30, 0, 0.06, 3.4, 0, h, 0, 0, 1);
    this.spawn(FX.PUFF, V_SMOKE, x, y, c * 22, s * 22, 0, 0.38, 1, 3.4, 0, 0, 0, 0.3);
  }

  /**
   * Cosmetic optimistic tracer at trigger-down (RULES 10): a fast amber
   * streak along heading that decays before server bullets replace it.
   */
  tracerStub(x: number, y: number, h: number): void {
    this.spawn(FX.STREAK, V_TRACER, x, y, Math.cos(h) * 780, Math.sin(h) * 780, 0, 0.09, 0, 0, h, 0, 24, 0.95);
  }

  /** White-hot spark tick + tiny ink chips where a bullet connected (§7). */
  hitSpark(x: number, y: number, angle: number): void {
    this.spawn(FX.STAR, V_FLASH, x, y, 0, 0, 0, 0.05, 2.6, 0, angle, 0, 0, 1);
    this.spawn(FX.STREAK, V_FLASH, x, y, 0, 0, 0, 0.08, 0, 0, angle, 0, 7, 1);
    const chips = 2 + (this.rng() < 0.5 ? 1 : 0);
    for (let i = 0; i < chips; i++) {
      const back = angle + Math.PI + (this.rng() - 0.5) * 1.7; // backsplash cone
      const sp = 46 + this.rng() * 54;
      this.spawn(
        FX.SHARD,
        V_DEB,
        x,
        y,
        Math.cos(back) * sp,
        Math.sin(back) * sp,
        0.01 + this.rng() * 0.03,
        0.22 + this.rng() * 0.16,
        1 + this.rng() * 0.7,
        0,
        this.rng() * TAU,
        (this.rng() * 2 - 1) * 14,
        0,
        0.95,
      );
    }
    this.shake(SHAKE.SMALL);
  }

  /**
   * Death blast (§7): strike = SOLID flash-core disc then flash bloom and
   * blast bloom just behind it, plus an expanding complete shock ring (both
   * sizes); aftermath = tumbling ink debris
   * shards (bible band 8–14) staggered by tiny delays, then a lingering dark
   * smoke column drifting east-downwind. Over water: foam splash ring + white
   * column + one sunGlare sparkle. Shake follows SHAKE.{MEDIUM,LARGE}.
   */
  explosion(x: number, y: number, size: 'small' | 'large', overWater: boolean): void {
    const big = size === 'large';
    this.shake(big ? SHAKE.LARGE : SHAKE.MEDIUM);

    // strike — §3 law: the blast REPLACES the scene for its first frames.
    // A hard-edged flash-core disc lands first (drawn beneath the soft
    // bloom), then flash bloom, then blast bloom just behind it; an
    // expanding shock ring rides on top for both sizes.
    this.spawn(FX.PUFF, V_CORE, x, y, 0, 0, 0, 0.06, big ? 16 : 12, big ? 16 : 12, 0, 0, 0, 1);
    this.spawn(FX.PUFF, V_FLASH, x, y, 0, 0, 0, big ? 0.2 : 0.15, big ? 10 : 6, big ? 46 : 28, 0, 0, 0, 1);
    this.spawn(FX.PUFF, V_BLAST, x, y, 0, 0, 0.02, big ? 0.3 : 0.22, big ? 12 : 8, big ? 60 : 38, 0, 0, 0, 1);
    // expanding shock ring — BOTH sizes (art round 2: it was absent from every
    // capture). Complete stroke circle born with the strike (~20u) dilating to
    // 95u large / 70u small over ~0.35 s; len[] carries its spawn stroke width
    // so the draw pass can taper 5→1.5 as the front runs out.
    this.spawn(FX.RING, V_BLAST, x, y, 0, 0, 0.02, 0.35, 20, big ? 95 : 70, 0, 0, 5, 0.92);

    // debris — rng rolled BEFORE spawning so pool pressure can't skew rolls
    const shN = big ? 12 + ((this.rng() * 3) | 0) : 9 + ((this.rng() * 3) | 0); // 9–11 / 12–14
    for (let i = 0; i < shN; i++) {
      const ang = this.rng() * TAU;
      const sp = 70 + this.rng() * 140;
      this.spawn(
        FX.SHARD,
        V_DEB,
        x,
        y,
        Math.cos(ang) * sp,
        Math.sin(ang) * sp,
        0.02 + this.rng() * 0.06,
        0.45 + this.rng() * 0.4,
        1.6 + this.rng() * 1.8,
        0,
        this.rng() * TAU,
        (this.rng() * 2 - 1) * 15,
        0,
        0.92,
      );
    }

    // lingering column — delayed, growing, east-drifting dark puffs
    const smN = big ? 9 : 6;
    for (let i = 0; i < smN; i++) {
      this.spawn(
        FX.PUFF,
        V_SMOKE,
        x + (this.rng() - 0.5) * 6,
        y + (this.rng() - 0.5) * 6,
        12 + this.rng() * 16,
        (this.rng() - 0.5) * 10,
        0.08 + i * (big ? 0.07 : 0.09),
        1.1 + this.rng() * 0.9,
        3 + this.rng() * 3,
        14 + this.rng() * 12,
        0,
        0,
        0,
        // lingering column shares the trail darkening law (art round 2).
        0.68 + this.rng() * 0.16,
      );
    }

    // foam splash when the wreck hits open water
    if (overWater) {
      this.spawn(FX.RING, V_FOAM, x, y, 0, 0, 0.04, 0.55, 6, 48, 0, 0, 2.6, 0.85);
      const colN = big ? 5 : 4;
      for (let i = 0; i < colN; i++) {
        const r = this.rng();
        const r2 = this.rng();
        this.spawn(
          FX.PUFF,
          V_FOAM,
          x + (r - 0.5) * 8,
          y + (r2 - 0.5) * 8,
          (r - 0.5) * 14,
          (r2 - 0.5) * 14,
          0.05 + i * 0.04,
          0.35 + this.rng() * 0.2,
          2.5,
          8 + this.rng() * 4,
          0,
          0,
          0,
          0.9,
        );
      }
      this.spawn(FX.STAR, V_GLARE, x, y, 0, 0, 0.03, 0.14, 3.4, 0, this.rng() * TAU, 0, 0, 1);
    }
  }

  /** Crate moments (§7): landing dust ring / pickup sparkle motes. */
  crateFx(kind: 'land' | 'pickup', x: number, y: number): void {
    if (kind === 'land') {
      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * TAU + this.rng() * 0.5;
        const sp = 24 + this.rng() * 18;
        this.spawn(FX.PUFF, V_SMOKE, x, y, Math.cos(ang) * sp, Math.sin(ang) * sp, i * 0.012, 0.45, 2.2, 7.5, 0, 0, 0, 0.38);
      }
      return;
    }
    this.spawn(FX.RING, V_FOAM, x, y, 0, 0, 0, 0.38, 4, 22, 0, 0, 2.2, 0.85);
    for (let i = 0; i < 9; i++) {
      const ang = (i / 9) * TAU + this.rng() * 0.4;
      const sp = 55 + this.rng() * 65;
      this.spawn(
        FX.STAR,
        i % 2 === 0 ? V_FOAM : V_GLARE,
        x,
        y,
        Math.cos(ang) * sp,
        Math.sin(ang) * sp,
        i * 0.008,
        0.3 + this.rng() * 0.15,
        1.8,
        0,
        ang,
        0,
        0,
        1,
      );
    }
  }

  // ---- shake ---------------------------------------------------------------

  shake(mag: number): void {
    this.shakeAcc += mag;
  }

  /** Accumulated magnitude since last call; resets to 0 (C_APP camera feed). */
  consumeShake(): number {
    const v = this.shakeAcc;
    this.shakeAcc = 0;
    return v;
  }

  // ---- rendering ------------------------------------------------------------

  /**
   * Draw all live particles inside a cheap cam-rect cull. CameraView carries
   * no viewport size, so the cull rect is sized for ANY legal viewport
   * (2560–3840 css px wide at CAMERA.ZOOM_MIN ≈ 2700–4000u) — generous on
   * purpose; per-particle work after the cull is the cheap part.
   */
  draw(ctx: CanvasRenderingContext2D, cam: CameraView): void {
    const hw = 2100 / cam.zoom + 160;
    const hh = 1300 / cam.zoom + 160;
    const x0 = cam.x - hw;
    const x1 = cam.x + hw;
    const y0 = cam.y - hh;
    const y1 = cam.y + hh;
    for (let i = 0; i < this.n; i++) {
      const x = this.px[i]!;
      const y = this.py[i]!;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (this.dly[i]! > 0 || this.age[i]! >= this.ttl[i]!) continue;
      const prog = this.age[i]! / this.ttl[i]!;
      switch (this.kind[i]) {
        case FX.PUFF: {
          const a = this.al[i]! * (1 - prog);
          if (a <= 0.02) break;
          const r = this.r0[i]! + (this.r1[i]! - this.r0[i]!) * prog;
          const idx = Math.min(12, Math.round(a * 12));
          if (this.sty[i] === V_CORE) {
            // §3 strike law: SOLID flash disc — flat ink, no soft rim, so the
            // first frames of a blast read as a scene replacement, not fog.
            ctx.fillStyle = FLASH_LAD[idx]!;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, TAU);
            ctx.fill();
          } else if (this.sty[i] === V_SMOKE) {
            if (this.al[i]! >= 0.6 && prog >= 0.58) {
              // §7 round-2: damaged trails must stay DARK at distance — the
              // final phase blends to the darkest existing ink-smoke tone
              // (debris ladder) held at its high-alpha end (tier ≥10 ⇒
              // α≥0.767 ≥ 0.72) until the last sliver releases down the
              // ladder, so death stays a fade, not a pop.
              const held = prog < 0.85;
              softPuff(ctx, x, y, r, DEB_LAD[held ? Math.max(DEB_HOLD, idx) : idx]!, OUT_DEB);
            } else {
              // growing smokeLt→smokeDk: discrete mid-life switch — quantized
              // alphas are house idiom and the soft rim hides the pop.
              softPuff(ctx, x, y, r, (prog < 0.28 ? SMOKE_LT : SMOKE_DK)[idx]!, OUT_SMOKE);
            }
          } else if (this.sty[i] === V_BLAST) {
            softPuff(ctx, x, y, r, BLAST_LAD[idx]!, OUT_BLAST);
          } else if (this.sty[i] === V_FLASH) {
            softPuff(ctx, x, y, r, FLASH_LAD[idx]!, OUT_FLASH);
          } else {
            softPuff(ctx, x, y, r, FOAM_LAD[idx]!, OUT_FOAM);
          }
          break;
        }
        case FX.EMBER: {
          const a = this.al[i]! * (1 - prog);
          if (a <= 0.02) break;
          const r = this.r0[i]! + (this.r1[i]! - this.r0[i]!) * prog;
          const flick = ((this.age[i]! * 28 + i) | 0) & 1; // deterministic flicker
          softPuff(ctx, x, y, r, (flick ? FIRE_C : FIRE_E)[Math.min(12, Math.round(a * 12))]!, OUT_FIRE);
          break;
        }
        case FX.STAR: {
          const a = this.al[i]! * (1 - prog);
          if (a <= 0.02) break;
          const sty = this.sty[i];
          ctx.fillStyle =
            sty === V_GLARE
              ? GLARE_LAD[Math.min(12, Math.round(a * 12))]!
              : sty === V_FOAM
                ? FOAM_LAD[Math.min(12, Math.round(a * 12))]!
                : FLASH_LAD[Math.min(12, Math.round(a * 12))]!;
          star(ctx, x, y, 6, this.r0[i]!, this.r0[i]! * 0.42, this.rot[i]!);
          ctx.fill();
          break;
        }
        case FX.SHARD: {
          const a = this.al[i]! * (1 - prog);
          if (a <= 0.02) break;
          ctx.fillStyle = DEB_LAD[Math.min(12, Math.round(a * 12))]!;
          const r = this.r0[i]!;
          const ca = Math.cos(this.rot[i]!);
          const sa = Math.sin(this.rot[i]!);
          ctx.beginPath(); // tumbling triangle shard — inline verts, no arrays
          ctx.moveTo(x + ca * r * 1.3, y + sa * r * 1.3);
          ctx.lineTo(x - ca * r - sa * r, y - sa * r + ca * r);
          ctx.lineTo(x - ca * r + sa * r, y - sa * r - ca * r);
          ctx.closePath();
          ctx.fill();
          break;
        }
        case FX.STREAK: {
          const a = this.al[i]! * (1 - prog);
          if (a <= 0.02) break;
          const L = this.len[i]!;
          const dx = Math.cos(this.rot[i]!) * L;
          const dy = Math.sin(this.rot[i]!) * L;
          const tracer = this.sty[i] === V_TRACER;
          // glow = two FLAT strokes (see header): halo under solid core.
          const haloIdx = tracer ? Math.max(2, Math.min(5, Math.round(a * 6))) : Math.max(3, Math.min(11, Math.round(a * 12)));
          ctx.strokeStyle = (tracer ? TRACER_LAD[haloIdx] : FLASH_LAD[Math.min(12, haloIdx)])!;
          ctx.lineWidth = 3.2;
          ctx.beginPath();
          ctx.moveTo(x - dx, y - dy);
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.strokeStyle = tracer ? TRACER_LAD[6]! : FLASH_LAD[12]!;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(x - dx, y - dy);
          ctx.lineTo(x, y);
          ctx.stroke();
          break;
        }
        default: {
          // RING — expanding stroked circle (blast ring / foam splash).
          // Complete arc every frame; the stroke tapers from its spawn width
          // (len[]) to a 1.5 hairline as the front dilates (§7 round-2).
          const a = this.al[i]! * (1 - prog);
          if (a <= 0.02) break;
          const r = this.r0[i]! + (this.r1[i]! - this.r0[i]!) * prog;
          ctx.strokeStyle = (this.sty[i] === V_FOAM ? FOAM_LAD : BLAST_LAD)[Math.min(12, Math.round(a * 12))]!;
          const w0 = this.len[i]!;
          ctx.lineWidth = w0 + (1.5 - w0) * prog;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, TAU);
          ctx.stroke();
          break;
        }
      }
    }
  }

  /**
   * Snapshot projectiles rendered straight from bullet data each frame — NO
   * pool involvement, no allocation. Amber core + short warm tail oriented to
   * velocity; length/halo-alpha are QUANTIZED into speed buckets so every
   * bullet picks from four precomputed styles (no per-frame string math).
   */
  drawProjectiles(ctx: CanvasRenderingContext2D, bullets: ReadonlyArray<{ x: number; y: number; vx: number; vy: number }>): void {
    const LEN = [20, 26, 32, 38]; // tail length by speed bucket — ≥ per-frame
    // travel (~13 u) so consecutive-frame strokes join into one continuous
    // amber contrail instead of disconnected dashes
    const HALO = [2, 3, 3, 4]; // halo alpha index into TRACER_LAD
    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i]!;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp < 1) continue;
      const ux = b.vx / sp;
      const uy = b.vy / sp;
      const bk = Math.min(LEN.length - 1, Math.floor(sp / 280));
      const L = LEN[bk]!;
      const tx = b.x - ux * L;
      const ty = b.y - uy * L;
      ctx.strokeStyle = TRACER_LAD[HALO[bk]!]!; // warm halo…
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.strokeStyle = TRACER_LAD[6]!; // …solid amber core
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.fillStyle = TRACER_LAD[6]!; // round cap reads as the round itself
      ctx.beginPath();
      ctx.arc(b.x, b.y, 1.15, 0, TAU);
      ctx.fill();
    }
  }

  // ---- test-only introspection (NOT part of the frozen surface; lives in
  // this module's own file per seams.ts's extension rule). Allocation here is
  // fine: tests never run inside the render loop.

  kindCount(kind: number): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.kind[i] === kind) c++;
    return c;
  }

  /** Packed live-particle state [kind,x,y,age,rot,r0]… — determinism probe. */
  debugDump(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) {
      out.push(this.kind[i]!, this.px[i]!, this.py[i]!, this.age[i]!, this.rot[i]!, this.r0[i]!);
    }
    return out;
  }
}

/**
 * C_FX creator (the seams.ts signature). `seed` derives from the match seed so
 * FX variation is reproducible capture-to-capture (RULES 3).
 */
export function createEffects(seed: number): EffectsApi {
  return new EffectsSystem(seed);
}



