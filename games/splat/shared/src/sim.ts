// ============================================================================
// FROZEN CONTRACT — SKI SPLAT: the SHARED, SERVER-AUTHORITATIVE ski simulation.
//
// This module is the whole netcode contract (the kart sim.ts pattern). The
// server integrates every skier here from the input stream (V1 room) and the
// client runs the IDENTICAL function on the IDENTICAL (steer, dt) sequence for
// prediction and replay (C1 DriveController via SkiPredictor). The wire carries
// inputs, never coordinates — so "what the server simulated" and "what the
// client predicted" are the same code over the same data, and reconciliation
// converges to zero error instead of tugging at a tether.
//
// PURITY IS THE CONTRACT: no window/document/THREE/performance/Date, no I/O,
// no Math.random. All gameplay timers are SIM ms (simMs accumulates dt*1000
// inside stepSki) — never wall clock, never ticks — so two peers replaying
// equal (steer, dt) sequences stay bit-identical forever.
//
// WIRE STEER IS POST-RAMP AND POST-ASSIST-EMA (CONTRACT §5): stepSki applies
// NO ramp and NO EMA. opts.assist changes ONLY plant radius, snare duration
// and edge pushback (§6); steer smoothing lives in the client input layer.
//
// PLANT-HIT DETECTION (server convention): stepSki records a hit by setting
// s.lastPlantIx AND s.lastPlantHitMs together, in the same step, always as a
// pair (both change atomically — a hit is the only writer of either field
// after makeSim/resetSim). The SERVER detects a NEW hit between steps by
// watching for (lastPlantIx, lastPlantHitMs) to differ from the previous
// step's values and then emits `splat_event plant_hit { id, plantIx, x, z }`.
// stepSki itself emits nothing — it is pure.
//
// GATE-CROSSING DETECTION (server convention, CONTRACT §6 — same pattern as
// plant hits): crossing gate ix (prevZ < g.z <= newZ, ix > lastGateIx)
// ALWAYS writes s.lastGateIx = ix — a miss included, so a missed gate can
// never be re-taken by circling back. A CLEAN pass (|x - g.x| <= g.halfWidth)
// additionally writes s.boostUntilMs in the SAME step: on a pass lastGateIx
// and boostUntilMs change together atomically (the pass is the only writer
// of boostUntilMs after makeSim/resetSim). The SERVER detects a pass between
// steps by watching for lastGateIx to advance AND boostUntilMs to differ,
// then emits `splat_event gate { id, gateIx, x, z }`; a lastGateIx advance
// with an UNCHANGED boostUntilMs was a miss (no event). Gates never touch
// plant rearm/immunity, and plants never touch the gate fields.
//
// Readings of §6 where the prose left latitude (verified numerically against
// the 4-year-old test before freezing these bodies):
// - YAW SOFT-CLAMP: beyond ±YAW_MAX a positional spring removes
//   YAW_SPRING * (|yaw| - YAW_MAX) * dt per step toward the fall line
//   ("YAW_SPRING rad/s² per rad" beyond the clamp). Full-lock equilibrium
//   sits ~0.22 rad past YAW_MAX (measured 1.574 rad); under the retuned
//   speed constants that is a hair past traverse at the START of a run, so
//   a few mm of backward z drift over the first ~3 s is the frozen physics
//   — then rising speed pulls turnRate down, the equilibrium drops back
//   under pi/2, and the edge band spirals the skier downhill. No donut.
// - SOFT EDGES: SkierSim carries no lateral-velocity field, so the "inward
//   lateral acceleration, quadratic in depth" manifests as (a) centripetal
//   curvature of the heading toward the fall line, rate = a_edge / v, and
//   (b) a direct inward position shift ½·a_edge·dt². Depth is UNCAPPED
//   (quadratic keeps growing past the band), which is what contains a
//   full-lock skier within ~4 m of the piste edge without any wall or stop.
// - POST-HIT BOUNDS: §6 lists bounds before plant contact, but the §6
//   invariant is MIN_SPEED ≤ v ≤ cap at ALL times, so after the hit's
//   v *= PLANT_HIT_SPEED_MUL the bounds are re-asserted (the snare cap is
//   binding from the hit step on). Contact never zeroes v.
// - resolveSkiPair: positional split capped at SKIER_PUSH * SIM_DT per skier
//   per call (SKIER_PUSH is an accel; × one tick is the soft per-tick nudge).
//   v and yaw are untouched — momentum kept, never a disable.
// - SkiPredictor.push accepts an OPTIONAL seq (SkiInput & { seq?: number }):
//   the frozen SkiInput has no seq field, so the ack watermark bookkeeping
//   lives in the private pending queue entries { seq, steer, dt }. Callers
//   (C1) SHOULD pass their wire seq; without one an internal monotonic
//   counter assigns it. Either way the queue stays ascending.
// ============================================================================
import {
  ASSIST_EDGE_MUL,
  ASSIST_PLANT_RADIUS_MUL,
  ASSIST_SNARE_MUL,
  CARVE_SCRUB,
  DRAG,
  EDGE_PUSH,
  EDGE_ZONE,
  GATE_BOOST_MAX,
  GATE_BOOST_MS,
  GATE_BOOST_V,
  G_ACCEL,
  J_COOLDOWN_MS,
  MAX_SPEED,
  MIN_SPEED,
  PENDING_INPUT_CAP,
  PLANT_BAND_M,
  PLANT_HIT_SPEED_MUL,
  PLANT_IMMUNITY_MS,
  PLANT_REARM_MS,
  PLANT_SNARE_MS,
  SIM_DT,
  SKIER_PUSH,
  SKIER_RADIUS,
  TURN_RATE_BASE,
  TURN_RATE_MIN,
  YAW_MAX,
  YAW_SPRING,
} from './config.js';
import type { SkierSim, SlopeDef } from './types.js';

/** One tick of driver intent — the ONLY thing a client is allowed to assert. */
export interface SkiInput {
  steer: number; // -1..1, post-ramp, post-assist-EMA
  dt: number;    // sim seconds this input covers
  /** v2 JUMP edge: true on the ONE input where a jump is requested. The sim
   *  consumes the edge (hop or kicker launch) and never treats a held flag as
   *  repeated jumps. Omitted = false (CONTRACT §11.2). */
  jump?: boolean;
}

/** stepSki options: assist changes plant radius, snare duration, edge push
 *  ONLY; jump is the v2 launch edge (CONTRACT §11.2). */
export interface SkiStepOpts {
  assist?: boolean;
  jump?: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Yaw rate at full lock: wider carve when fast (lerp over v 0 -> MAX_SPEED). */
function turnRateAt(v: number): number {
  const t = clamp(v / MAX_SPEED, 0, 1);
  return TURN_RATE_BASE + (TURN_RATE_MIN - TURN_RATE_BASE) * t;
}

/** Fresh skier at a grid slot. lastPlantHitMs starts one rearm window in the
 *  past so both plant gates (rearm AND immunity) pass at simMs = 0; the jump
 *  cooldown clock starts one cooldown window in the past so a hop is legal
 *  immediately (CONTRACT §11.2). */
export function makeSim(x: number, z: number, yaw: number): SkierSim {
  return {
    x,
    z,
    yaw,
    v: MIN_SPEED,
    simMs: 0,
    snareUntilMs: 0,
    lastPlantIx: -1,
    lastPlantHitMs: -PLANT_REARM_MS,
    lastGateIx: -1,
    boostUntilMs: 0,
    airborne: false,
    airStartMs: -J_COOLDOWN_MS,
    airVy: 0,
    airStartY: 0,
    lastKickerIx: -1,
    finished: false,
    finishMs: 0,
  };
}

/** Teleport to a spawn/grid slot with a fresh skier (the GO grid wipe). */
export function resetSim(s: SkierSim, x: number, z: number, yaw: number): void {
  s.x = x;
  s.z = z;
  s.yaw = yaw;
  s.v = MIN_SPEED;
  s.simMs = 0;
  s.snareUntilMs = 0;
  s.lastPlantIx = -1;
  s.lastPlantHitMs = -PLANT_REARM_MS;
  s.lastGateIx = -1;
  s.boostUntilMs = 0;
  s.airborne = false;
  s.airStartMs = -J_COOLDOWN_MS;
  s.airVy = 0;
  s.airStartY = 0;
  s.lastKickerIx = -1;
  s.finished = false;
  s.finishMs = 0;
}

/** Field-by-field copy (no allocation) — the reconcile re-base. */
export function copySim(dst: SkierSim, src: Readonly<SkierSim>): void {
  dst.x = src.x;
  dst.z = src.z;
  dst.yaw = src.yaw;
  dst.v = src.v;
  dst.simMs = src.simMs;
  dst.snareUntilMs = src.snareUntilMs;
  dst.lastPlantIx = src.lastPlantIx;
  dst.lastPlantHitMs = src.lastPlantHitMs;
  dst.lastGateIx = src.lastGateIx;
  dst.boostUntilMs = src.boostUntilMs;
  dst.airborne = src.airborne;
  dst.airStartMs = src.airStartMs;
  dst.airVy = src.airVy;
  dst.airStartY = src.airStartY;
  dst.lastKickerIx = src.lastKickerIx;
  dst.finished = src.finished;
  dst.finishMs = src.finishMs;
}

/** v2 shared helper (CONTRACT §11.2, gauntlet-corrected): the height ABOVE
 *  THE CURRENT TERRAIN the skier is flying at — 0 when grounded. The skier's
 *  world-space y is airStartY + arc (arc = airVy*t - 0.5*G_ACCEL*t*t) while
 *  airborne; the terrain below is slope.height(x, z), so the visible air is
 *  the difference, clamped at 0. The client adds it to slope.height(x, z)
 *  for the camera eye and skier rendering; the sim's landing test uses the
 *  same world frame (airStartY + arc <= slope.height). Pure + deterministic;
 *  both peers compute the same number from the same fields. */
export function airHeight(s: Readonly<SkierSim>, x: number, z: number, slope: SlopeDef): number {
  if (!s.airborne) return 0;
  const t = (s.simMs - s.airStartMs) / 1000;
  const worldY = s.airStartY + s.airVy * t - 0.5 * G_ACCEL * t * t;
  const h = worldY - slope.height(x, z);
  return h > 0 ? h : 0;
}

/**
 * THE shared step — the one function both peers run per input. CONTRACT §6,
 * in order: sim clock, gravity along heading, steering, carve scrub, yaw
 * soft-clamp, motion, speed bounds, plant contact, slalom gates, soft
 * edges, finish.
 *
 * A FINISHED skier is frozen: the call is a no-op and the state is left
 * untouched (the input is still "consumed" by the caller, so server ack
 * bookkeeping keeps working — §6: "input still acked").
 *
 * NOT included: skier-vs-skier contact. Only the server can resolve that (it
 * is the only peer holding every skier at the same instant), so it happens
 * once, after all skiers have stepped — see resolveSkiPair.
 */
export function stepSki(
  s: SkierSim,
  steer: number,
  dt: number,
  slope: SlopeDef,
  opts?: SkiStepOpts,
): void {
  if (s.finished) return; // frozen on the runout; state untouched
  // NaN / non-positive / +Infinity guard: a tick of nothing. One malformed
  // number must never reach the integrator (callers clamp to
  // [SIM_DT_MIN, SIM_DT_MAX] already — this is the last line of defence).
  if (!Number.isFinite(dt) || dt <= 0) return;
  const st = Number.isFinite(steer) ? clamp(steer, -1, 1) : 0;
  const assist = opts?.assist === true;

  // -- sim clock first ------------------------------------------------------
  s.simMs += dt * 1000;

  // -- gravity along heading (gradeAt >= GRADE_MIN by construction: no
  //    backward roll, no stopped state) --------------------------------------
  const accel = G_ACCEL * slope.gradeAt(s.x, s.z, s.yaw) - DRAG * s.v * s.v;
  s.v += accel * dt;

  // -- steering: yaw rate = steer * TURN_RATE(v) ----------------------------
  s.yaw += st * turnRateAt(s.v) * dt;

  // -- carving scrubs speed -------------------------------------------------
  s.v *= 1 - CARVE_SCRUB * Math.abs(st) * dt * (s.v / MAX_SPEED);

  // -- yaw soft-clamp: spring beyond ±YAW_MAX back toward the fall line -----
  const absYaw = Math.abs(s.yaw);
  if (absYaw > YAW_MAX) {
    s.yaw -= Math.sign(s.yaw) * YAW_SPRING * (absYaw - YAW_MAX) * dt;
  }

  // -- motion along heading (yaw 0 = +Z downhill) ----------------------------
  const prevZ = s.z; // gate crossing detection needs the pre-step z
  s.x += Math.sin(s.yaw) * s.v * dt;
  s.z += Math.cos(s.yaw) * s.v * dt;

  // -- bounds: MIN_SPEED <= v <= cap. The cap is the MIN of the applicable
  //    ceilings: MAX_SPEED is the base; while boosted (simMs < boostUntilMs)
  //    GATE_BOOST_MAX replaces it; while snared (simMs < snareUntilMs) the
  //    half cap applies on top — the snare half-cap wins over the boost cap.
  let vMax = s.simMs < s.boostUntilMs ? GATE_BOOST_MAX : MAX_SPEED;
  if (s.simMs < s.snareUntilMs) vMax = Math.min(vMax, MAX_SPEED / 2);
  s.v = clamp(s.v, MIN_SPEED, vMax);

  // -- plant contact: spatial hash over bands k-1..k+1, circle test ---------
  // Deterministic candidate order (band ascending, grid order within); the
  // FIRST candidate passing BOTH gates takes the hit, one hit per step. On a
  // hit BOTH lastPlantIx and lastPlantHitMs are written together — the pair
  // is the server's new-hit signal (see the header comment).
  const k = Math.floor(s.z / PLANT_BAND_M);
  for (let band = k - 1; band <= k + 1; band++) {
    const plants = slope.plantGrid(band);
    let hit = false;
    for (const p of plants) {
      const rr = p.r * (assist ? ASSIST_PLANT_RADIUS_MUL : 1) + SKIER_RADIUS;
      const dx = s.x - p.x;
      const dz = s.z - p.z;
      if (dx * dx + dz * dz > rr * rr) continue;
      const ix = slope.plants.indexOf(p);
      if (ix < 0) continue; // grid entry not in slope.plants: no identity, skip
      const sinceHit = s.simMs - s.lastPlantHitMs;
      const rearmed = ix !== s.lastPlantIx || sinceHit >= PLANT_REARM_MS;
      if (!rearmed || sinceHit < PLANT_IMMUNITY_MS) continue;
      s.v = clamp(s.v * PLANT_HIT_SPEED_MUL, MIN_SPEED, vMax); // never zeroes v
      s.snareUntilMs = s.simMs + PLANT_SNARE_MS * (assist ? ASSIST_SNARE_MUL : 1);
      s.lastPlantIx = ix;
      s.lastPlantHitMs = s.simMs;
      hit = true;
      break;
    }
    if (hit) break;
  }

  // -- slalom gates (CONTRACT §6, see the header for the server convention) --
  // slope.gates is ascending z, so scan forward from lastGateIx+1 and stop at
  // the first gate not crossed this step. EVERY crossed gate is consumed
  // (lastGateIx = ix, hit or miss — no circling back); a clean pass grants
  // the boost, writing lastGateIx and boostUntilMs together in this step.
  for (let ix = s.lastGateIx + 1; ix < slope.gates.length; ix++) {
    const g = slope.gates[ix];
    if (g === undefined) break;
    if (!(prevZ < g.z && g.z <= s.z)) break; // ascending z: nothing further crossed
    if (Math.abs(s.x - g.x) <= g.halfWidth) {
      s.v = Math.min(s.v + GATE_BOOST_V, vMax); // §6: clamped by the current cap
      s.boostUntilMs = s.simMs + GATE_BOOST_MS;
    }
    s.lastGateIx = ix;
  }

  // -- soft edges: quadratic inward pushback past width/2 - EDGE_ZONE --------
  // No wall, no stop: curvature toward the fall line plus a small direct
  // inward shift; depth uncapped so a full-lock skier is always contained.
  const over = Math.abs(s.x) - (slope.width / 2 - EDGE_ZONE);
  if (over > 0) {
    const depth = over / EDGE_ZONE;
    const aEdge = EDGE_PUSH * depth * depth * (assist ? ASSIST_EDGE_MUL : 1);
    if (s.yaw !== 0) {
      s.yaw -= (Math.sign(s.yaw) * (aEdge / Math.max(s.v, MIN_SPEED)) * dt);
    }
    s.x -= Math.sign(s.x) * 0.5 * aEdge * dt * dt;
  }

  // -- finish: stamp from the sim clock, then freeze -------------------------
  if (s.z >= slope.finishZ) {
    s.finished = true;
    s.finishMs = s.simMs;
  }
}

/**
 * SERVER-ONLY skier-vs-skier contact, resolved ONCE for the pair so both
 * skiers see the same shove on the same tick (the kart resolveKartPair
 * discipline). Soft positional push apart along the separation normal, each
 * skier moving half the overlap capped at SKIER_PUSH * SIM_DT per call — a
 * nudge, not a teleport. v and yaw are untouched: momentum is kept and
 * contact is never a disable.
 */
export function resolveSkiPair(a: SkierSim, b: SkierSim): void {
  const minD = 2 * SKIER_RADIUS;
  let dx = b.x - a.x;
  let dz = b.z - a.z;
  const d2 = dx * dx + dz * dz;
  if (!Number.isFinite(d2) || d2 >= minD * minD) return;
  const d = Math.sqrt(d2);
  if (d < 1e-6) {
    dx = 1; // exactly stacked: deterministic split direction
    dz = 0;
  } else {
    dx /= d;
    dz /= d;
  }
  const shift = Math.min((minD - d) * 0.5, SKIER_PUSH * SIM_DT);
  a.x -= dx * shift;
  a.z -= dz * shift;
  b.x += dx * shift;
  b.z += dz * shift;
}

// ---- client-side prediction ---------------------------------------------------

/** Pending-queue entry: the frozen SkiInput plus the ack-bookkeeping seq. */
interface PendingSkiInput {
  seq: number;
  steer: number;
  dt: number;
}

/**
 * Prediction + reconciliation, the ski twin of KartPredictor. push() applies
 * an input LOCALLY AND IMMEDIATELY (steering never waits for the server) and
 * queues it; reconcile() re-bases on the server's authoritative SkierSim,
 * drops the inputs the server has consumed (seq <= ackSeq), and replays the
 * rest through the same stepSki. With no plant divergence and no dropped
 * input the replay reproduces the server's state exactly and the correction
 * is 0 m — the skier never gets tugged.
 *
 * It lives in shared/ rather than the client because it is pure: the
 * prediction contract (same inputs => same state on both sides) is directly
 * unit-testable against a simulated server.
 */
export class SkiPredictor {
  private readonly s: SkierSim = makeSim(0, 0, 0);
  private readonly pending: PendingSkiInput[] = []; // seq-ordered ascending
  private assist: boolean;
  private nextSeq = 1; // internal seq source when the caller passes none

  constructor(
    private readonly slope: SlopeDef,
    opts?: SkiStepOpts,
  ) {
    this.assist = opts?.assist === true;
  }

  /** C1 calls this on splat_assist toggle: physics switch immediately —
   *  the very next push AND every replay in reconcile use the new flag
   *  (the server does the same with its stored per-player assist). */
  setAssist(on: boolean): void {
    this.assist = on;
  }

  /**
   * Apply one input immediately and queue it for replay. `inp.seq` is
   * OPTIONAL (see the header comment): pass the wire seq so reconcile's
   * ackSeq drops the right entries; without one an internal counter assigns
   * ascending seqs. The queued values are COPIED — callers may reuse inp.
   */
  push(inp: SkiInput & { seq?: number }): void {
    const seq = inp.seq ?? this.nextSeq;
    this.nextSeq = seq + 1;
    if (this.pending.length >= PENDING_INPUT_CAP) this.pending.shift(); // drop oldest
    this.pending.push({ seq, steer: inp.steer, dt: inp.dt });
    stepSki(this.s, inp.steer, inp.dt, this.slope, { assist: this.assist });
  }

  /**
   * Authoritative correction: adopt the server's state for `ackSeq`, then
   * replay everything it has not consumed yet.
   * @returns how far (m) the corrected state ended up from the pre-correction
   * prediction — 0 in the converged case; the caller uses it to smooth the
   * visual and to report netcode health.
   */
  reconcile(auth: Readonly<SkierSim>, ackSeq: number): number {
    const preX = this.s.x;
    const preZ = this.s.z;
    copySim(this.s, auth);
    let acked = 0;
    while (acked < this.pending.length) {
      const p = this.pending[acked];
      if (p === undefined || p.seq > ackSeq) break;
      acked++;
    }
    if (acked > 0) {
      this.pending.copyWithin(0, acked); // shift without allocating
      this.pending.length -= acked;
    }
    const opts: SkiStepOpts = { assist: this.assist };
    for (const p of this.pending) stepSki(this.s, p.steer, p.dt, this.slope, opts);
    return Math.hypot(this.s.x - preX, this.s.z - preZ);
  }

  /** Live reference to the predicted state — read-only by convention. */
  state(): SkierSim {
    return this.s;
  }

  /** Inputs still awaiting an ack (netcode health / telemetry). */
  pendingCount(): number {
    return this.pending.length;
  }

  /** Re-base at a spawn/grid slot; drops every unacknowledged input. */
  reset(x: number, z: number, yaw: number): void {
    resetSim(this.s, x, z, yaw);
    this.pending.length = 0;
    this.nextSeq = 1;
  }
}
