// ============================================================================
// ORBIT SIM — pure endless-tunnel run (specs/P9.md rules block).
//
// No DOM, no three, no clock: step(state, input, dt) advances a fixed-dt
// world down −Z. ALL randomness flows through the seeded @platform/shared
// rng consumed in strict z-frontier order, so a seed fully determines the
// debris field: same seed ⇒ same layout at the same distance, which is what
// makes slot-'resume' restores byte-identical to uninterrupted runs.
//
// Rules implemented here:
//   · speed 18→42 u/s over a 180s monotonic ramp; boost = 1.5s burst +40%,
//     4s cooldown after each burst.
//   · debris rocks + spinning laser hoops spawn ahead / recycle behind.
//   · NEAR MISS: an obstacle crossing the ship plane within 1.2u of contact,
//     without touching → combo++, +25×combo points; combo resets after 2s
//     without a fresh near-miss.
//   · score = floor(dist) + nearMisses·25·comboMult (accumulated per event).
//   · hit → shield consumed (brief invulnerability) else the run ends.
//   · one shield pickup per ~20s worth of distance.
// ============================================================================

import { rng, rngRange } from '@platform/shared';

// ---- tuning -----------------------------------------------------------------

export const SIM = {
  /** Tunnel cross-section radius (units). */
  tunnelR: 6,
  /** Ship collision radius. */
  shipR: 0.55,
  /** Hoop laser half-thickness. */
  hoopTube: 0.35,
  /** Clearance band that still counts as a NEAR MISS. */
  nearMissDist: 1.2,
  /** Points per near miss × combo multiplier. */
  nearMissPoints: 25,
  /** Seconds without a new near-miss before combo resets. */
  comboWindowSec: 2,
  speedStart: 18,
  speedEnd: 42,
  rampSec: 180,
  /** Boost burst length (s) and speed multiplier while it lasts. */
  boostDurSec: 1.5,
  boostMult: 1.4,
  /** Cooldown AFTER a burst ends before boost may fire again (s). */
  boostCooldownSec: 4,
  maxLatSpeed: 13,
  latAccel: 70,
  /** One shield pickup per ~this many seconds worth of distance. */
  shieldEverySec: 20,
  pickupR: 0.9,
  maxShields: 2,
  /** Grace after a shield absorbs a hit (s). */
  invulnSec: 1.0,
  /** Generate obstacles this far ahead of the ship (units). */
  spawnAhead: 150,
  /** Cull entities this far behind the ship (units). */
  recycleBehind: 16,
  firstObstacleDist: 45,
} as const;

const TAU = Math.PI * 2;

// ---- entities -----------------------------------------------------------------

export type ObstacleKind = 'rock' | 'hoop';

export interface Obstacle {
  readonly id: number;
  readonly kind: ObstacleKind;
  x: number;
  y: number;
  z: number;
  /** Rock body radius; for hoops the ring CENTERLINE radius. */
  readonly r: number;
  /** Visual spin rate rad/s (renderer-only). */
  readonly spin: number;
  phase: number;
  /** Set once the ship's plane has crossed this obstacle's z. */
  passed: boolean;
  /** Set when a shield absorbed a hit on it — no further collision. */
  dead: boolean;
}

export interface Pickup {
  readonly id: number;
  x: number;
  y: number;
  z: number;
  phase: number;
  taken: boolean;
}

export type RunEventKind = 'near' | 'pickup' | 'shieldhit' | 'explode' | 'boost';

export interface RunEvent {
  readonly kind: RunEventKind;
  /** Combo value after the near miss; 0 for other kinds. */
  readonly combo: number;
}

export interface SteerInput {
  /** Lateral steer −1..1 (+1 right). */
  readonly ax: number;
  /** Vertical steer −1..1 (+1 up). */
  readonly ay: number;
}

/** What slot 'resume' stores: {seed, dist, score}. */
export interface ResumeData {
  readonly dist: number;
  readonly score: number;
}

interface GenState {
  next: () => number;
  obsZ: number;
  shieldZ: number;
  seq: number;
}

export interface RunState {
  readonly seed: number;
  x: number;
  y: number;
  /** Ship position along −Z (always ≤ 0). */
  z: number;
  vx: number;
  vy: number;
  elapsed: number;
  dist: number;
  shields: number;
  combo: number;
  comboT: number;
  nearMisses: number;
  bonusPoints: number;
  boostT: number;
  boostCd: number;
  alive: boolean;
  finished: boolean;
  invulnT: number;
  readonly obstacles: Obstacle[];
  readonly pickups: Pickup[];
  readonly events: RunEvent[];
  readonly gen: GenState;
}

// ---- curve helpers ---------------------------------------------------------------

/** Monotonic difficulty ramp: 18 u/s at t=0 → 42 u/s at t=180, capped. */
export function speedAt(tSec: number): number {
  const f = Math.min(1, Math.max(0, tSec) / SIM.rampSec);
  return SIM.speedStart + (SIM.speedEnd - SIM.speedStart) * f;
}

/**
 * Inverse of dist(t) = 18t + t²/15 (for t ≤ 180); used by the generator to
 * convert a z frontier into "seconds into the run" so shield spacing tracks
 * speed without needing wall-clock state. Clamped to [0, 180].
 */
export function timeAtDist(distU: number): number {
  if (distU <= 0) return 0;
  if (distU >= 5400) return SIM.rampSec;
  return Math.min(SIM.rampSec, (-18 + Math.sqrt(324 + (4 * distU) / 15)) * 7.5);
}

/** Difficulty factor 0..1 purely from DISTANCE (z-order determinism). */
function diffFactor(distU: number): number {
  return Math.min(1, Math.max(0, distU / 4200));
}

function clamp11(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function approach(v: number, target: number, maxDelta: number): number {
  const d = target - v;
  if (d > maxDelta) return v + maxDelta;
  if (d < -maxDelta) return v - maxDelta;
  return target;
}

// ---- scoring -----------------------------------------------------------------

/** Score = floor(distance) + accumulated near-miss bonus. */
export function scoreOf(st: RunState): number {
  return Math.floor(st.dist) + st.bonusPoints;
}

// ---- generation ------------------------------------------------------------------

/**
 * Deterministic content stream: two z frontiers (obstacles, shields) march
 * ahead of the ship; every draw comes from ONE rng in frontier order, so the
 * layout at any distance depends only on (seed, dist) — never on timing.
 */
function ensureGenerated(st: RunState): void {
  const g = st.gen;
  const target = st.z - SIM.spawnAhead;

  while (g.obsZ > target) {
    spawnObstacleAt(st, g.obsZ);
    // gaps tighten as distance grows: 15u apart → 9u apart, ± jitter
    const df = diffFactor(-g.obsZ);
    g.obsZ -= 15 - 6 * df + rngRange(g.next, -1.5, 1.5);
  }
  while (g.shieldZ > target) {
    spawnPickupAt(st, g.shieldZ);
    // next pickup ~20s worth of distance away at the speed of THAT moment
    const t = timeAtDist(-g.shieldZ);
    g.shieldZ -= speedAt(t) * SIM.shieldEverySec * rngRange(g.next, 0.85, 1.15);
  }
}

function spawnObstacleAt(st: RunState, z: number): void {
  const next = st.gen.next;
  const id = ++st.gen.seq;
  if (next() < 0.3) {
    // laser hoop: ring radius 2.3–3.5, modestly off-axis
    const ringR = rngRange(next, 2.3, 3.5);
    const maxOff = Math.max(0, SIM.tunnelR - ringR - 0.5) * 0.55;
    const ang = next() * TAU;
    const rad = Math.sqrt(next()) * maxOff;
    st.obstacles.push({
      id,
      kind: 'hoop',
      x: Math.cos(ang) * rad,
      y: Math.sin(ang) * rad,
      z,
      r: ringR,
      spin: (next() < 0.5 ? -1 : 1) * rngRange(next, 0.8, 2.4),
      phase: next() * TAU,
      passed: false,
      dead: false,
    });
  } else {
    // rock: radius 0.7–2.1 anywhere in the cross-section
    const r = rngRange(next, 0.7, 2.1);
    const ang = next() * TAU;
    const rad = Math.sqrt(next()) * Math.max(0, SIM.tunnelR - r - 0.6);
    st.obstacles.push({
      id,
      kind: 'rock',
      x: Math.cos(ang) * rad,
      y: Math.sin(ang) * rad,
      z,
      r,
      spin: rngRange(next, -2.2, 2.2),
      phase: next() * TAU,
      passed: false,
      dead: false,
    });
  }
}

function spawnPickupAt(st: RunState, z: number): void {
  const next = st.gen.next;
  const ang = next() * TAU;
  const rad = Math.sqrt(next()) * (SIM.tunnelR - 1.6);
  st.pickups.push({
    id: ++st.gen.seq,
    x: Math.cos(ang) * rad,
    y: Math.sin(ang) * rad,
    z,
    phase: next() * TAU,
    taken: false,
  });
}

// ---- collision classification -------------------------------------------------------

export type Outcome = 'hit' | 'near' | 'clear';

/**
 * Lateral clearance between ship center and one obstacle:
 *   rock: radialDist − r − shipR          (touch = contact)
 *   hoop: |radialDist − ringR| − tube − shipR   (clipping either rim = contact)
 * Negative ⇒ hit; < nearMissDist without touching ⇒ NEAR MISS.
 */
export function obstacleOutcome(o: Obstacle, sx: number, sy: number): Outcome {
  const d = Math.hypot(sx - o.x, sy - o.y);
  const lateral = o.kind === 'rock' ? d - o.r - SIM.shipR : Math.abs(d - o.r) - SIM.hoopTube - SIM.shipR;
  if (lateral <= 0) return 'hit';
  if (lateral < SIM.nearMissDist) return 'near';
  return 'clear';
}

// ---- lifecycle ---------------------------------------------------------------------

export function createRun(seed: number, resume?: ResumeData): RunState {
  // all-or-nothing validity: partial/garbage data falls back to a fresh start
  const valid =
    resume !== undefined &&
    Number.isFinite(resume.dist) &&
    resume.dist > 0 &&
    Number.isFinite(resume.score) &&
    resume.score >= 0;
  const startDist = valid && resume !== undefined ? resume.dist : 0;
  const st: RunState = {
    seed: seed >>> 0,
    x: 0,
    y: 0,
    z: -startDist,
    vx: 0,
    vy: 0,
    elapsed: 0,
    dist: startDist,
    shields: 0,
    combo: 0,
    comboT: 0,
    nearMisses: 0,
    // restore keeps floor(dist) implicit; carry only the earned bonus over
    bonusPoints:
      valid && resume !== undefined
        ? Math.max(0, Math.floor(resume.score) - Math.floor(startDist))
        : 0,
    boostT: 0,
    boostCd: 0,
    alive: true,
    finished: false,
    invulnT: 0,
    obstacles: [],
    pickups: [],
    events: [],
    gen: {
      next: rng(seed >>> 0),
      obsZ: -SIM.firstObstacleDist,
      shieldZ: -(speedAt(0) * SIM.shieldEverySec),
      seq: 0,
    },
  };
  ensureGenerated(st);
  return st;
}

/** Trigger the boost (bit 0 press edge). False while cooling down or done. */
export function tryBoost(st: RunState): boolean {
  if (!st.alive || st.finished || st.boostCd > 0) return false;
  st.boostT = SIM.boostDurSec;
  st.boostCd = SIM.boostDurSec + SIM.boostCooldownSec;
  st.events.push({ kind: 'boost', combo: 0 });
  return true;
}

/**
 * Effective forward speed this instant (ramp × boost multiplier).
 *
 * The ramp reads through timeAtDist(dist), NOT wall-clock elapsed: the two
 * are identical when played from t=0 (dist(t)=∫ramp dt), but keying speed to
 * distance makes slot-'resume' restores exact — same (seed, dist) reproduces
 * the same speed and therefore the same entire future trajectory.
 */
export function currentSpeed(st: RunState): number {
  const base = speedAt(timeAtDist(st.dist));
  return base * (st.boostT > 0 ? SIM.boostMult : 1);
}

export function drainEvents(st: RunState): RunEvent[] {
  if (st.events.length === 0) return [];
  return st.events.splice(0, st.events.length);
}

// ---- stepping ------------------------------------------------------------------------

/**
 * Advance the world by dt seconds (fixed step; the engine Loop feeds 1/30).
 * Safe to call after finish() — the world freezes.
 */
export function step(st: RunState, input: SteerInput, dt: number): void {
  if (st.finished || dt <= 0) return;
  st.elapsed += dt;
  if (st.invulnT > 0) st.invulnT = Math.max(0, st.invulnT - dt);

  // ---- boost timers ----
  if (st.boostT > 0) st.boostT = Math.max(0, st.boostT - dt);
  if (st.boostCd > 0) st.boostCd = Math.max(0, st.boostCd - dt);
  const speed = currentSpeed(st);

  // ---- steering: accelerate laterally toward stick intent, clamp to tunnel ----
  st.vx = approach(st.vx, clamp11(input.ax) * SIM.maxLatSpeed, SIM.latAccel * dt);
  st.vy = approach(st.vy, clamp11(input.ay) * SIM.maxLatSpeed, SIM.latAccel * dt);
  st.x += st.vx * dt;
  st.y += st.vy * dt;
  const lim = SIM.tunnelR - SIM.shipR;
  const rad = Math.hypot(st.x, st.y);
  if (rad > lim) {
    const k = lim / rad;
    st.x *= k;
    st.y *= k;
    st.vx *= k;
    st.vy *= k;
  }

  // ---- advance down −Z ----
  st.z -= speed * dt;
  st.dist += speed * dt;

  ensureGenerated(st);

  // ---- recycle everything well behind the ship ----
  const cutoff = st.z + SIM.recycleBehind;
  for (let i = st.obstacles.length - 1; i >= 0; i--) {
    const o = st.obstacles[i] as Obstacle;
    if (o.z > cutoff || (o.passed && o.dead)) st.obstacles.splice(i, 1);
  }
  for (let i = st.pickups.length - 1; i >= 0; i--) {
    const p = st.pickups[i] as Pickup;
    if (p.z > cutoff || p.taken) st.pickups.splice(i, 1);
  }

  // ---- obstacle crossings (ship plane passes the entity's z) ----
  for (const o of st.obstacles) {
    if (o.passed) continue;
    o.passed = true;
    if (!st.alive || o.dead) continue;
    const out = obstacleOutcome(o, st.x, st.y);
    if (out === 'hit') {
      if (st.invulnT > 0) continue; // grace window after a shield save
      if (st.shields > 0) {
        st.shields--;
        o.dead = true;
        st.invulnT = SIM.invulnSec;
        st.events.push({ kind: 'shieldhit', combo: 0 });
      } else {
        st.alive = false;
        st.finished = true;
        st.events.push({ kind: 'explode', combo: 0 });
      }
    } else if (out === 'near') {
      st.combo += 1;
      st.comboT = SIM.comboWindowSec;
      st.nearMisses += 1;
      st.bonusPoints += SIM.nearMissPoints * st.combo;
      st.events.push({ kind: 'near', combo: st.combo });
    }
  }

  // ---- shield pickups ----
  for (const p of st.pickups) {
    if (p.taken || st.z > p.z) continue;
    p.taken = true;
    const close = Math.hypot(st.x - p.x, st.y - p.y) < SIM.pickupR + SIM.shipR;
    if (st.alive && close && st.shields < SIM.maxShields) {
      st.shields++;
      st.events.push({ kind: 'pickup', combo: 0 });
    }
  }

  // ---- combo decay: reset after the window lapses without a new near miss ----
  if (st.comboT > 0) {
    st.comboT = Math.max(0, st.comboT - dt);
    if (st.comboT === 0) st.combo = 0;
  }
}
