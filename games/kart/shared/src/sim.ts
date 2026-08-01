// ============================================================================
// FROZEN CONTRACT — KART GP: the SHARED, SERVER-AUTHORITATIVE drive simulation.
//
// This module is the whole netcode contract. The server integrates every kart
// here from the input stream (games/kart/server/src/room.ts) and the client
// runs the IDENTICAL function on the IDENTICAL input for prediction and replay
// (games/kart/client/src/drive.ts, mirroring fps/client/src/net/prediction.ts).
// The wire carries inputs, never coordinates — so "what the server simulated"
// and "what the client predicted" are the same code over the same data, and
// reconciliation converges to zero error instead of tugging at a tether.
//
// PURITY IS THE CONTRACT: no window/document/THREE/performance/Date, no I/O,
// no Math.random. Deterministic per (state, input, dt, track) on both sides —
// break that and prediction stops converging.
//
// Layering: kartPhysics.stepKart is the untouched handling model (120Hz
// substeps); stepDrive adds what the OLD client loop owned — the substep
// accumulator, the per-substep surface lookup, barrier push-out, the in-order
// gate/respawn-anchor tracker and the respawn teleport — so all of it now runs
// on both sides. Kart-vs-kart contact is NOT in stepDrive: it is resolved once,
// by the server, over all karts AFTER they have all stepped (resolveKartPair).
// ============================================================================
import {
  BARRIER_DAMP,
  BARRIER_OUT,
  GATE_RADIUS,
  GATES,
  KART_RADIUS,
  KART_RESTITUTION,
  PENDING_INPUT_CAP,
  SIM_SUBSTEP_HZ,
} from './config.js';
import { makeKart, stepKart } from './kartPhysics.js';
import type { KartInput, KartState } from './kartPhysics.js';
import { closestOnTrack, pointAtArc, surfaceAt } from './track.js';
import type { TrackDef } from './track.js';

// ---- assist tuning (KIDS MODE pure pursuit; pure math, shared so the server
// tests and any future bot can drive the same line the client's assist does) ---
const PURSUIT_AHEAD = 10; // lookahead along the centerline (m)
const PURSUIT_GAIN = 2.2; // steer = clamp(-yawErr * gain)
const WRONG_WAY_RAD = (100 * Math.PI) / 180; // facing vs travel past this = wrong way
const WRONG_WAY_HOLD_S = 1.2; // continuous wrong-way sim time before recovery
const RECOVER_DONE_RAD = (30 * Math.PI) / 180; // recovery exits inside this alignment
const REVERSE_FLIP_SPEED = -0.5; // speedF below this mirrors the assist steer

/** Hard ceiling on substeps in one stepDrive call (SIM_DT_MAX needs 8). */
const MAX_SUBSTEPS = 64;

/**
 * One kart's complete authoritative state. Everything the sim needs and
 * NOTHING else: two peers holding equal KartSim values that then consume equal
 * inputs stay equal forever. The gate tracker lives here (not in the room)
 * because the respawn teleport is an INPUT — replaying it during
 * reconciliation must land in exactly the same place it did when predicted.
 *
 * `expectedGate` is the anchor tracker only. Race truth (lap / progress /
 * place / finish) is the ROOM's referee over these positions — a deliberately
 * separate tracker: the room starts at gate 1 (the grid sits behind the line)
 * while the anchor tracker starts at 0.
 */
export interface KartSim extends KartState {
  expectedGate: number; // next gate that moves the respawn anchor
  anchorX: number;
  anchorZ: number;
  anchorYaw: number;
}

/** One tick of driver intent — the ONLY thing a client is allowed to assert. */
export interface DriveInput extends KartInput {
  /** R / kids-mode stuck recovery: teleport to the last credited gate. */
  respawn: boolean;
}

/** A queued/wire input: intent plus the sim time it accounts for. */
export interface SimInput extends DriveInput {
  seq: number; // per-client monotonic, +1 per sim tick
  dt: number; // sim seconds this input covers (honest clients: SIM_DT)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap an angle to (-π, π]. */
export function wrapPi(a: number): number {
  const TWO_PI = Math.PI * 2;
  return ((((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

/** Fresh kart at a grid slot; the spawn point is its first respawn anchor. */
export function makeSim(x: number, z: number, yaw: number): KartSim {
  const k = makeKart(x, z, yaw) as KartSim;
  k.expectedGate = 0;
  k.anchorX = x;
  k.anchorZ = z;
  k.anchorYaw = yaw;
  return k;
}

/** Teleport to a spawn/grid slot with a fresh kart (the GO grid wipe). */
export function resetSim(s: KartSim, x: number, z: number, yaw: number): void {
  s.x = x;
  s.y = 0;
  s.z = z;
  s.yaw = yaw;
  s.vx = 0;
  s.vz = 0;
  s.gear = 1;
  s.shiftLeft = 0;
  s.drifting = false;
  s.nitroLeft = 0;
  s.expectedGate = 0;
  s.anchorX = x;
  s.anchorZ = z;
  s.anchorYaw = yaw;
}

/** Field-by-field copy (no allocation) — the reconcile re-base. */
export function copySim(dst: KartSim, src: Readonly<KartSim>): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.yaw = src.yaw;
  dst.vx = src.vx;
  dst.vz = src.vz;
  dst.gear = src.gear;
  dst.shiftLeft = src.shiftLeft;
  dst.drifting = src.drifting;
  dst.nitroLeft = src.nitroLeft;
  dst.expectedGate = src.expectedGate;
  dst.anchorX = src.anchorX;
  dst.anchorZ = src.anchorZ;
  dst.anchorYaw = src.anchorYaw;
}

/**
 * Barrier band: the kart center may not exceed |lateral| > roadHalfW +
 * BARRIER_OUT - KART_RADIUS. Push out along the centerline normal by the
 * OVERSHOOT ONLY (teleporting to the sample's band point would discard the
 * tangential motion and freeze a wall-grinding kart in place), and keep
 * BARRIER_DAMP of the normal speed, bounced inward. Exported because a
 * kart-vs-kart shove can land a kart past the wall after stepDrive returned.
 */
export function clampToBarrier(s: KartState, track: TrackDef): void {
  const lim = track.roadHalfW + BARRIER_OUT - KART_RADIUS;
  const c = closestOnTrack(track, s.x, s.z);
  const over = Math.abs(c.lateral) - lim;
  if (over <= 0) return;
  const side = c.lateral > 0 ? 1 : -1;
  const cl = track.centerline;
  const a = cl[c.index]!;
  const b = cl[(c.index + 1) % cl.length]!;
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  // left-of-travel unit normal — matches closestOnTrack's lateral sign
  const nx = -dz / len;
  const nz = dx / len;
  s.x -= nx * side * over;
  s.z -= nz * side * over;
  const vn = s.vx * nx + s.vz * nz;
  if (vn * side > 0) {
    // still moving outward: damped reflection off the wall
    const cut = vn * (1 + BARRIER_DAMP);
    s.vx -= nx * cut;
    s.vz -= nz * cut;
  }
}

/** Move the respawn anchor when the EXPECTED gate is passed, in order. */
function creditAnchor(s: KartSim, track: TrackDef): void {
  // Normalised, not just modulo: a NEGATIVE or non-integer expectedGate (only
  // reachable by re-basing on a malformed authoritative state) would index the
  // array out of bounds and throw inside the snapshot handler. Anchor tracking
  // is cosmetic-grade state — it must never be able to take a client down.
  const idx = ((Math.trunc(s.expectedGate) % GATES) + GATES) % GATES;
  const g = track.gates[idx]!;
  const dx = s.x - g.x;
  const dz = s.z - g.z;
  if (dx * dx + dz * dz > GATE_RADIUS * GATE_RADIUS) return;
  s.anchorX = g.x;
  s.anchorZ = g.z;
  s.anchorYaw = Math.atan2(-g.tx, -g.tz); // face along travel (platform yaw convention)
  s.expectedGate = (idx + 1) % GATES;
}

/** Back to the last credited gate (or the spawn point) with a fresh kart. */
function respawnTo(s: KartSim): void {
  s.x = s.anchorX;
  s.y = 0;
  s.z = s.anchorZ;
  s.yaw = s.anchorYaw;
  s.vx = 0;
  s.vz = 0;
  s.gear = 1;
  s.shiftLeft = 0;
  s.drifting = false;
}

/**
 * THE shared step — the one function both peers run per input.
 *
 * Integrates `dt` seconds as SIM_SUBSTEP_HZ-rate substeps (dt/n each, so any
 * dt is exact and equal dt on both sides gives bit-identical output), looking
 * up the surface per substep and clamping to the barrier after each, then
 * moves the respawn anchor if the expected gate was passed. `respawn` consumes
 * the whole tick: it teleports and integrates nothing, which is what makes it
 * safe to replay in the middle of a queue of unacknowledged inputs.
 *
 * NOT included: kart-vs-kart contact. Only the server can resolve that (it is
 * the only peer holding every kart at the same instant), so it happens once,
 * after all karts have stepped — see resolveKartPair.
 */
export function stepDrive(s: KartSim, inp: DriveInput, dt: number, track: TrackDef): void {
  // NaN / non-positive / +Infinity guard: a tick of nothing. Infinity matters —
  // it passes `dt > 0` and would spin the substep loop forever, so a single
  // malformed number must never reach the integrator even though every caller
  // is supposed to have clamped it to [SIM_DT_MIN, SIM_DT_MAX] already.
  if (!Number.isFinite(dt) || dt <= 0) return;
  if (inp.respawn) {
    respawnTo(s);
    return;
  }
  // ...and the substep count is capped for the same reason: bounded work per
  // call, whatever dt says (SIM_DT_MAX gives 8, so the cap is never reached
  // through the wire).
  const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.round(dt * SIM_SUBSTEP_HZ)));
  const sdt = dt / n;
  for (let i = 0; i < n; i++) {
    stepKart(s, inp, sdt, surfaceAt(track, s.x, s.z));
    clampToBarrier(s, track);
  }
  creditAnchor(s, track);
}

/**
 * SERVER-ONLY kart-vs-kart contact, resolved ONCE for the pair so both karts
 * see the same impact on the same tick (the old client-side repelOthers was
 * half-resolved per client, position-only, and run against raw snapshot
 * positions that differed from the interpolated ones on screen — player A got
 * shoved off-line while B saw a clean pass).
 *
 * Equal masses: the overlap is split evenly and the normal impulse
 * j = -(1 + e)·v_rel·n / 2 is applied with opposite signs, so momentum along
 * the normal is conserved exactly and a bump COSTS the hitter what it gives
 * the hit. Tangential motion is untouched (karts slide past each other rather
 * than sticking).
 *
 * @returns the approach speed (m/s) that was removed — 0 when the karts are
 * not touching or are already separating; the room uses it as the bump event's
 * impulse and as the audible-hit threshold.
 */
export function resolveKartPair(a: KartState, b: KartState): number {
  const minD = 2 * KART_RADIUS;
  let dx = b.x - a.x;
  let dz = b.z - a.z;
  let d2 = dx * dx + dz * dz;
  if (d2 >= minD * minD) return 0;
  let d = Math.sqrt(d2);
  if (d < 1e-6) {
    dx = 1; // exactly stacked: deterministic split direction
    dz = 0;
    d = 1;
    d2 = 1;
  }
  const nx = dx / d;
  const nz = dz / d;
  // positional split — half the overlap each
  const half = (minD - d) * 0.5;
  a.x -= nx * half;
  a.z -= nz * half;
  b.x += nx * half;
  b.z += nz * half;
  // momentum exchange along the normal (equal masses)
  const vrel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
  if (vrel >= 0) return 0; // already separating: contact is positional only
  const j = (-(1 + KART_RESTITUTION) * vrel) / 2;
  a.vx -= nx * j;
  a.vz -= nz * j;
  b.vx += nx * j;
  b.vz += nz * j;
  return -vrel;
}

// ---- KIDS MODE / bot steering ------------------------------------------------

/** Rolling state of the assist controller (owned by the caller, mutated here). */
export interface AssistState {
  wrongWayT: number; // continuous sim-seconds facing >WRONG_WAY_RAD off travel
  recovering: boolean; // full-lock steer back toward the travel tangent
  stuckT: number; // continuous sim-seconds of throttle-held-but-not-moving
}

export function makeAssistState(): AssistState {
  return { wrongWayT: 0, recovering: false, stuckT: 0 };
}

// ---- KIDS MODE stuck guard ----------------------------------------------------
// A kid cannot press R, so a kart wedged nose-first into a barrier at full
// throttle would stay wedged forever. This is the escape hatch, and it is the
// one assist rule with real stakes: losing it strands a player with no way out.
// It lives here, in the pure shared module, precisely so it can be unit-tested
// against the same sim the server runs — see sim.test.ts.
export const STUCK_THROTTLE = 0.5; // needs the throttle held above this...
export const STUCK_SPEED = 0.5; // ...while |forward speed| stays under this (m/s)
export const STUCK_HOLD_S = 2.5; // ...for this much continuous SIM time

/**
 * Advance the stuck timer by one tick of sim time.
 * @returns true EXACTLY ONCE per stuck episode — on the tick the hold time is
 * reached — at which point the caller must put `respawn: true` on that tick's
 * input. The teleport rides the INPUT STREAM rather than being applied locally:
 * that is what makes the server the one that decides and applies it, and what
 * makes the relocation survive reconciliation (the server replays the same flag
 * on the same seq and lands on the same anchor).
 */
export function stuckStep(a: AssistState, throttle: number, speedF: number, dt: number): boolean {
  if (throttle > STUCK_THROTTLE && Math.abs(speedF) < STUCK_SPEED) {
    a.stuckT += dt;
    if (a.stuckT >= STUCK_HOLD_S) {
      a.stuckT = 0; // one request per episode; the timer restarts from here
      return true;
    }
  } else {
    a.stuckT = 0; // any real motion (or a lifted throttle) resets the hold
  }
  return false;
}

/**
 * Pure-pursuit steer toward the centerline ~PURSUIT_AHEAD m ahead, with two
 * safeties. WRONG-WAY RECOVERY: facing more than WRONG_WAY_RAD off the nearest
 * centerline tangent for WRONG_WAY_HOLD_S continuous drops pursuit in favor of
 * a full-lock steer toward the tangent until aligned within RECOVER_DONE_RAD.
 * REVERSE FLIP: the bicycle model's yaw rate is proportional to speedF, so
 * while reversing the output is mirrored (backing up steers opposite, like a
 * real car). Positive steer = RIGHT (yaw decreases): with the platform yaw
 * convention forward = (-sin(yaw), -cos(yaw)), the desired yaw to a target is
 * atan2(-dx, -dz), so steer = clamp(-yawErr * gain) turns toward it.
 */
export function pursuitSteer(
  track: TrackDef,
  s: Readonly<KartState>,
  a: AssistState,
  dt: number,
): number {
  const cl = track.centerline;
  const n = cl.length;
  const i0 = closestOnTrack(track, s.x, s.z).index;
  const a0 = cl[i0]!;
  const b0 = cl[(i0 + 1) % n]!;
  const travelYaw = Math.atan2(-(b0[0] - a0[0]), -(b0[1] - a0[1]));
  const yawErr = wrapPi(travelYaw - s.yaw);
  if (a.recovering) {
    if (Math.abs(yawErr) < RECOVER_DONE_RAD) {
      a.recovering = false;
      a.wrongWayT = 0;
    }
  } else if (Math.abs(yawErr) > WRONG_WAY_RAD) {
    a.wrongWayT += dt;
    if (a.wrongWayT > WRONG_WAY_HOLD_S) a.recovering = true;
  } else {
    a.wrongWayT = 0;
  }

  let steer: number;
  if (a.recovering) {
    steer = yawErr > 0 ? -1 : 1; // full lock toward the tangent
  } else {
    // ONE arc-length walk in the codebase — the same helper the starting grid
    // uses (track.ts pointAtArc). It interpolates inside the final segment, so
    // the aim point is exactly PURSUIT_AHEAD metres of ROAD ahead rather than
    // snapped to whichever sample first passed it (up to 3.6 m of slop).
    const target = pointAtArc(track, i0, PURSUIT_AHEAD);
    const desiredYaw = Math.atan2(-(target.x - s.x), -(target.z - s.z));
    steer = clamp(-wrapPi(desiredYaw - s.yaw) * PURSUIT_GAIN, -1, 1);
  }
  const speedF = s.vx * -Math.sin(s.yaw) + s.vz * -Math.cos(s.yaw);
  return speedF < REVERSE_FLIP_SPEED ? -steer : steer;
}

// ---- client-side prediction ---------------------------------------------------

/**
 * Prediction + reconciliation, the kart twin of fps/client/src/net/prediction.ts.
 * push() applies an input LOCALLY AND IMMEDIATELY (this is what keeps steering
 * instant — nothing waits for the server) and queues it; reconcile() re-bases
 * on the server's authoritative KartSim, drops the inputs the server has
 * consumed, and replays the rest through the same stepDrive. With no contact
 * and no dropped input the replay reproduces the server's state exactly and
 * the correction is 0m — the kart never gets tugged.
 *
 * It lives in shared/ rather than the client because it is pure: that makes
 * the prediction contract (same inputs => same state on both sides) directly
 * unit-testable against a simulated server.
 */
export class KartPredictor {
  private readonly s: KartSim = makeSim(0, 0, 0);
  private readonly pending: SimInput[] = []; // seq-ordered ascending
  private lastCorrection = 0; // metres the last reconcile() moved us

  constructor(private track: TrackDef) {}

  /**
   * Swap the circuit this predictor integrates on (the room's trackId arrives
   * with kart_joined, after the client has already built a default track).
   * INVARIANT: after setTrack the predictor holds a valid state on the NEW
   * circuit and has nothing queued — never a position expressed in the OLD
   * circuit's coordinates. It does exactly what reset() does, defaulting the
   * anchor to the origin: (x, z, yaw) are optional so this stays a drop-in
   * one-argument call (drive.ts's `pred.setTrack(track)` is frozen), but the
   * caller SHOULD pass the real grid slot for the new track immediately after
   * — see KartApp.applyTrack — since the origin is only guaranteed valid, not
   * correct. Dropping every pending input is required either way: replaying
   * inputs from one circuit's geometry on another's would reconcile against a
   * road that was never driven.
   */
  setTrack(track: TrackDef, x = 0, z = 0, yaw = 0): void {
    this.track = track;
    this.reset(x, z, yaw);
  }

  /** Re-base at a spawn/grid slot; drops every unacknowledged input. */
  reset(x: number, z: number, yaw: number): void {
    resetSim(this.s, x, z, yaw);
    this.pending.length = 0;
    this.lastCorrection = 0;
  }

  /**
   * Apply one input immediately and queue it for replay. The queued object is
   * RETAINED (it is replayed later) — callers must not mutate it afterwards.
   */
  push(inp: SimInput): void {
    if (this.pending.length >= PENDING_INPUT_CAP) this.pending.shift(); // drop oldest
    this.pending.push(inp);
    stepDrive(this.s, inp, inp.dt, this.track);
  }

  /**
   * Authoritative correction: adopt the server's state for `ackSeq`, then
   * replay everything it has not consumed yet.
   * @returns how far (m) the corrected state ended up from the pre-correction
   * prediction — 0 in the converged case; the caller uses it to smooth the
   * visual and to report netcode health.
   */
  reconcile(auth: Readonly<KartSim>, ackSeq: number): number {
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
    for (const p of this.pending) stepDrive(this.s, p, p.dt, this.track);
    this.lastCorrection = Math.hypot(this.s.x - preX, this.s.z - preZ);
    return this.lastCorrection;
  }

  /** Live reference to the predicted state — read-only by convention. */
  state(): KartSim {
    return this.s;
  }

  /** Inputs still awaiting an ack (netcode health / telemetry). */
  pendingCount(): number {
    return this.pending.length;
  }

  /** Metres the last reconcile() moved the kart (0 = perfectly converged). */
  correction(): number {
    return this.lastCorrection;
  }
}
