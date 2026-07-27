// ============================================================================
// kart-drive — DriveController: keyboard → deterministic local kart sim.
// Wraps the shared stepKart at fixed 120Hz substeps (render dt accumulates),
// with a surfaceAt() grip lookup per substep, barrier push-out at the road
// shoulder, soft kart-kart repulsion, and an in-order gate tracker whose last
// credited gate doubles as the R-respawn anchor. Keyboard: Arrows/WASD drive,
// Space/Shift drift (handbrake), R respawn; window blur clears every held key
// (this game has no pointer lock). KIDS MODE (setAssist): pure-pursuit auto-steer
// ~10m ahead on the centerline replaces the keyboard steer channel, hardened by
// three assist-only safeties — wrong-way recovery (>100° off the travel tangent
// for 1.2s of sim time → full-lock steer back to within 30°), stuck auto-respawn
// (throttle held 2.5s while barely moving → respawn(); kids can't press R) and
// the reverse steer mirror (the bicycle model's yaw rate flips sign with speedF).
// Throttle, brake, drift, R and nitro stay manual. state()/packet() return module scratch
// objects — copy out what you keep; nothing here allocates per frame, and
// logic never calls Math.random (deterministic per input sequence).
// ============================================================================
import {
  BARRIER_DAMP, GATES, GATE_RADIUS, KART_RADIUS, NITRO_TIME, SNAPSHOT_HZ,
  closestOnTrack, forwardSpeed, makeKart, stepKart, surfaceAt,
} from '@kart/shared';
import type { KartC2S, KartInput, KartState, TrackDef } from '@kart/shared';

// ---- tuning -----------------------------------------------------------------
const SUBSTEP_DT = 1 / 120; // fixed physics rate, independent of rAF rate
const MAX_FRAME_DT = 0.25; // tab-back hitch clamp; sim time beyond this is dropped
const PACKET_DT = 1 / SNAPSHOT_HZ; // kart_state stream rate (15Hz)
const BARRIER_OUT = 1.2; // barrier wall offset past the road edge (m)
const DRIFT_VIS_RATE = 10; // driftVisual approach rate /s
const PURSUIT_AHEAD = 10; // KIDS MODE lookahead along the centerline (m)
const PURSUIT_GAIN = 2.2; // KIDS MODE steer = clamp(-yawErr * gain)
const WRONG_WAY_RAD = (100 * Math.PI) / 180; // facing vs travel past this = wrong way
const WRONG_WAY_HOLD_S = 1.2; // continuous wrong-way sim time before recovery
const RECOVER_DONE_RAD = (30 * Math.PI) / 180; // recovery exits inside this alignment
const STUCK_THROTTLE = 0.5; // auto-respawn needs the throttle held above this
const STUCK_SPEED = 0.5; // ...while |speed| stays under this (m/s)
const STUCK_HOLD_S = 2.5; // continuous stuck sim time before the auto-respawn
const REVERSE_FLIP_SPEED = -0.5; // speedF below this mirrors the assist steer
const CORRECT_SUPPRESS_S = 0.6; // post-respawn window where server echoes are known-stale

export interface DriveState extends KartState {
  steer: number; // current effective steering input -1..1 (wheel visual)
  driftVisual: number; // smoothed 0..1 drift intensity (skid visual)
  speed: number; // signed forward speed, m/s
  assist: boolean; // KIDS MODE auto-steer active (HUD badge / debug surface)
}

// ---- module scratch (zero per-frame allocation; do not retain) ----------------
const STATE_OUT: DriveState = {
  x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0,
  gear: 1, shiftLeft: 0, drifting: false, nitroLeft: 0,
  steer: 0, driftVisual: 0, speed: 0, assist: false,
};
const PACKET_OUT: Extract<KartC2S, { t: 'kart_state' }> = {
  t: 'kart_state', seq: 0, p: [0, 0, 0], yaw: 0, v: [0, 0], steer: 0, drift: false,
};
const NO_OTHERS: ReadonlyArray<readonly [number, number, number]> = [];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap an angle to (-π, π]. */
function wrapPi(a: number): number {
  const TWO_PI = Math.PI * 2;
  return ((((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

/** True when a key event targets an editable element (lobby inputs keep typing). */
function typingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

export class DriveController {
  private readonly k: KartState = makeKart(0, 0, 0);

  // held keyboard state (tracked by e.code, layout-independent)
  private keyUp = false;
  private keyDown = false;
  private keyLeft = false;
  private keyRight = false;
  private keyDrift = false;

  // external input latch (setInput) + the per-step merged effective input
  private readonly ext: KartInput = { throttle: 0, brake: 0, steer: 0, drift: false };
  private readonly eff: KartInput = { throttle: 0, brake: 0, steer: 0, drift: false };

  private acc = 0; // stepped-but-unconsumed frame time
  private pktClock = PACKET_DT; // first packet() fires immediately
  private seq = 0; // per-client monotonic, never reset within a connection
  private driftVis = 0;
  private frozen = false; // pre-GO freeze: step() integrates nothing
  private assistOn = false; // KIDS MODE — app-owned; reset()/blur never clear it
  private correctSuppress = 0; // sim-seconds left where correctTo() is ignored
  private wrongWayT = 0; // continuous sim-seconds facing >100° off the travel tangent
  private recovering = false; // wrong-way recovery: full-lock steer, pursuit off
  private stuckT = 0; // continuous sim-seconds throttle held while nearly stopped

  /** App-wired nitro request hook — fired on a fresh KeyN press. */
  onNitro: (() => void) | null = null;

  // other karts' [x,y,z] for soft repulsion — reference retained, caller-owned
  private others: ReadonlyArray<readonly [number, number, number]> = NO_OTHERS;

  // in-order gate tracker; the last credited gate is the respawn anchor
  private expectedGate = 0;
  private anchorX = 0;
  private anchorZ = 0;
  private anchorYaw = 0;

  constructor(private readonly track: TrackDef) {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
      window.addEventListener('blur', this.onBlur);
    }
  }

  /** Remove keyboard listeners (teardown / hot-reload). */
  dispose(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  /** Teleport to a spawn/grid slot. The next gate to cross is gate 0 (the line). */
  reset(x: number, z: number, yaw: number): void {
    const k = this.k;
    k.x = x; k.y = 0; k.z = z; k.yaw = yaw;
    k.vx = 0; k.vz = 0;
    k.gear = 1; k.shiftLeft = 0;
    k.drifting = false;
    this.acc = 0;
    this.driftVis = 0;
    this.pktClock = PACKET_DT;
    this.expectedGate = 0;
    this.anchorX = x; this.anchorZ = z; this.anchorYaw = yaw;
    this.wrongWayT = 0;
    this.recovering = false;
    this.stuckT = 0;
  }

  /** Latch an external input (debug surface / e2e). Merged over the keyboard per step. */
  setInput(inp: KartInput): void {
    this.ext.throttle = inp.throttle;
    this.ext.brake = inp.brake;
    this.ext.steer = inp.steer;
    this.ext.drift = inp.drift;
  }

  /** Other karts as [x,y,z] tuples (e.g. snapshot player p arrays). Reference retained. */
  setOthers(positions: ReadonlyArray<readonly [number, number, number]>): void {
    this.others = positions;
  }

  /**
   * Pre-GO freeze: while frozen, step() integrates nothing — input is ignored,
   * velocity is zeroed, and the kart holds its grid slot no matter what the
   * keyboard or a debug setInput latch says. The packet clock keeps running so
   * the (stationary) state stream never gaps.
   */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  /**
   * KIDS MODE toggle: while on, step() ignores the keyboard/latched steer and
   * drives the steer channel with the assist controller (pure pursuit toward
   * the centerline ~10m ahead + wrong-way recovery + reverse mirror), and a
   * stuck kart auto-respawns. Throttle/brake/drift/R/nitro stay manual.
   * App-owned — reset() and window blur do NOT clear it.
   */
  setAssist(on: boolean): void {
    this.assistOn = on;
  }

  /** Server-approved nitro (the nitro event for the local player): start the boost. */
  activateNitro(): void {
    this.k.nitroLeft = NITRO_TIME;
  }

  /**
   * GENTLE own-state server correction (app.ts correctOwn): nudge POSITION
   * only. Velocity, gear, the gate tracker and the respawn anchor are all
   * untouched — this is a nudge, not the grid reset (drive.reset() zeroes
   * velocity, restarts the gate tracker at 0 and re-anchors mid-track).
   * Suppressed for CORRECT_SUPPRESS_S of sim time after a respawn: the server
   * then still echoes our PRE-teleport position for ~rtt/2 + a snapshot
   * interval, and pulling toward that known-stale echo rubber-bands the kart
   * (the echo adopts the respawned position from our next kart_state — the
   * net model is client-trusted, so the divergence heals by itself).
   */
  correctTo(x: number, z: number): void {
    if (this.correctSuppress > 0) return;
    this.k.x = x;
    this.k.z = z;
  }

  /** Advance the sim by render dt (seconds); runs fixed 120Hz substeps inside. */
  step(dt: number): void {
    if (!(dt > 0)) return; // NaN/negative guard
    const dtc = Math.min(dt, MAX_FRAME_DT);
    this.pktClock += dtc;
    if (this.correctSuppress > 0) {
      this.correctSuppress = Math.max(0, this.correctSuppress - dtc);
    }
    const e = this.eff;
    if (this.frozen) {
      e.throttle = 0; e.brake = 0; e.steer = 0; e.drift = false;
      this.k.vx = 0; this.k.vz = 0;
      return;
    }
    e.throttle = clamp((this.keyUp ? 1 : 0) + this.ext.throttle, 0, 1);
    e.brake = clamp((this.keyDown ? 1 : 0) + this.ext.brake, 0, 1);
    // KIDS MODE: the steer channel is fully owned by the assist controller.
    if (this.assistOn) {
      // STUCK AUTO-RESPAWN (kids can't press R): throttle held while barely
      // moving for STUCK_HOLD_S of continuous sim time teleports to the anchor.
      if (e.throttle > STUCK_THROTTLE && Math.abs(forwardSpeed(this.k)) < STUCK_SPEED) {
        this.stuckT += dtc;
        if (this.stuckT >= STUCK_HOLD_S) {
          this.stuckT = 0;
          this.respawn();
        }
      } else {
        this.stuckT = 0;
      }
      e.steer = this.assistSteer(dtc);
    } else {
      e.steer = clamp((this.keyRight ? 1 : 0) - (this.keyLeft ? 1 : 0) + this.ext.steer, -1, 1);
    }
    e.drift = this.keyDrift || this.ext.drift;
    this.acc += dtc;
    while (this.acc >= SUBSTEP_DT) {
      this.substep();
      this.acc -= SUBSTEP_DT;
    }
    this.creditGate();
    this.repelOthers();
  }

  /** Live sim state + visual extras. Module scratch — do not retain. */
  state(): DriveState {
    const k = this.k;
    const o = STATE_OUT;
    o.x = k.x; o.y = k.y; o.z = k.z; o.yaw = k.yaw;
    o.vx = k.vx; o.vz = k.vz;
    o.gear = k.gear; o.shiftLeft = k.shiftLeft;
    o.drifting = k.drifting;
    o.nitroLeft = k.nitroLeft;
    o.steer = this.eff.steer;
    o.driftVisual = this.driftVis;
    o.speed = forwardSpeed(k);
    o.assist = this.assistOn;
    return o;
  }

  /** Effective merged throttle 0..1 (keyboard + latched ext) — the audio load axis. */
  throttle(): number {
    return this.eff.throttle;
  }

  /**
   * 15Hz kart_state packet for the wire: non-null once per PACKET_DT of stepped
   * sim time. Module scratch — serialize/send immediately, do not retain.
   */
  packet(): KartC2S | null {
    if (this.pktClock < PACKET_DT) return null;
    this.pktClock -= PACKET_DT;
    const k = this.k;
    const p = PACKET_OUT;
    p.seq = ++this.seq;
    p.p[0] = k.x; p.p[1] = k.y; p.p[2] = k.z;
    p.yaw = k.yaw;
    p.v[0] = k.vx; p.v[1] = k.vz;
    p.steer = this.eff.steer;
    p.drift = k.drifting; // actual drift state — what remote skid visuals need
    return p;
  }

  // ---- internals --------------------------------------------------------------

  /**
   * KIDS MODE assist channel — owns e.steer while assist is on, layering three
   * safeties over pure pursuit (all deterministic on sim time, no allocation).
   * WRONG-WAY RECOVERY: facing more than WRONG_WAY_RAD off the nearest
   * centerline tangent for WRONG_WAY_HOLD_S continuous drops pursuit in favor
   * of a full-lock steer toward the tangent (the sign that shrinks the yaw
   * error fastest) until aligned within RECOVER_DONE_RAD. REVERSE FLIP: the
   * bicycle model's yaw rate is proportional to speedF, so while reversing the
   * whole assist output is mirrored (backing up steers opposite, like a real
   * car). Pure pursuit: walk the centerline forward from the kart's nearest
   * sample to the point ~PURSUIT_AHEAD m ahead, then steer toward it. Positive
   * steer = RIGHT (yaw decreases): with the platform yaw convention
   * forward = (-sin(yaw), -cos(yaw)), the desired yaw to a target is
   * atan2(-dx, -dz), so steer = clamp(-yawErr * gain) turns toward the target.
   */
  private assistSteer(dtc: number): number {
    const k = this.k;
    const cl = this.track.centerline;
    const n = cl.length;
    const i0 = closestOnTrack(this.track, k.x, k.z).index;
    const a0 = cl[i0]!;
    const b0 = cl[(i0 + 1) % n]!;
    // travel direction at the nearest sample — same yaw convention as creditGate
    const travelYaw = Math.atan2(-(b0[0] - a0[0]), -(b0[1] - a0[1]));
    const yawErr = wrapPi(travelYaw - k.yaw); // facing vs travel, |·| in 0..π
    if (this.recovering) {
      if (Math.abs(yawErr) < RECOVER_DONE_RAD) {
        this.recovering = false;
        this.wrongWayT = 0;
      }
    } else if (Math.abs(yawErr) > WRONG_WAY_RAD) {
      this.wrongWayT += dtc;
      if (this.wrongWayT > WRONG_WAY_HOLD_S) this.recovering = true;
    } else {
      this.wrongWayT = 0;
    }

    let steer: number;
    if (this.recovering) {
      // full lock toward the tangent: positive steer = RIGHT = yaw decreases
      steer = yawErr > 0 ? -1 : 1;
    } else {
      let i = i0;
      let ahead = 0;
      for (let steps = 0; steps < n && ahead < PURSUIT_AHEAD; steps++) {
        const a = cl[i]!;
        i = (i + 1) % n;
        const b = cl[i]!;
        ahead += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      const target = cl[i]!;
      const desiredYaw = Math.atan2(-(target[0] - k.x), -(target[1] - k.z));
      steer = clamp(-wrapPi(desiredYaw - k.yaw) * PURSUIT_GAIN, -1, 1);
    }
    // mirror the command while backing up (yaw response flips with speedF)
    return forwardSpeed(k) < REVERSE_FLIP_SPEED ? -steer : steer;
  }

  private substep(): void {
    const k = this.k;
    stepKart(k, this.eff, SUBSTEP_DT, surfaceAt(this.track, k.x, k.z));
    this.collideBarrier();
    // smoothed skid intensity for the renderer (deterministic per substep count)
    const target = k.drifting ? 1 : 0;
    this.driftVis += (target - this.driftVis) * Math.min(1, DRIFT_VIS_RATE * SUBSTEP_DT);
  }

  /**
   * Barrier band: the kart center may not exceed |lateral| > roadHalfW +
   * BARRIER_OUT - KART_RADIUS. Push out along the centerline normal by the
   * OVERSHOOT ONLY (teleporting to the sample's band point would discard the
   * tangential motion and freeze a wall-grinding kart in place), and keep
   * BARRIER_DAMP of the normal speed, bounced inward.
   */
  private collideBarrier(): void {
    const k = this.k;
    const t = this.track;
    const lim = t.roadHalfW + BARRIER_OUT - KART_RADIUS;
    const c = closestOnTrack(t, k.x, k.z);
    const over = Math.abs(c.lateral) - lim;
    if (over <= 0) return;
    const side = c.lateral > 0 ? 1 : -1;
    const cl = t.centerline;
    const a = cl[c.index]!;
    const b = cl[(c.index + 1) % cl.length]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    // left-of-travel unit normal — matches closestOnTrack's lateral sign
    const nx = -dz / len;
    const nz = dx / len;
    k.x -= nx * side * over;
    k.z -= nz * side * over;
    const vn = k.vx * nx + k.vz * nz;
    if (vn * side > 0) {
      // still moving outward: damped reflection off the wall
      const cut = vn * (1 + BARRIER_DAMP);
      k.vx -= nx * cut;
      k.vz -= nz * cut;
    }
  }

  /** Server rule mirrored locally: credit within GATE_RADIUS of the expected gate, in order. */
  private creditGate(): void {
    const g = this.track.gates[this.expectedGate]!; // GATES entries; index kept in range below
    const dx = this.k.x - g.x;
    const dz = this.k.z - g.z;
    if (dx * dx + dz * dz > GATE_RADIUS * GATE_RADIUS) return;
    this.anchorX = g.x;
    this.anchorZ = g.z;
    this.anchorYaw = Math.atan2(-g.tx, -g.tz); // face along travel (platform yaw convention)
    this.expectedGate = (this.expectedGate + 1) % GATES;
  }

  /** Soft circle push: separate half the overlap from any kart closer than 2*KART_RADIUS. */
  private repelOthers(): void {
    const k = this.k;
    const minD = 2 * KART_RADIUS;
    let pushed = false;
    for (const o of this.others) {
      let dx = k.x - o[0];
      let dz = k.z - o[2];
      const d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-6) {
        dx = 1; dz = 0; d = 1; // stacked exactly: deterministic split direction
      }
      const push = ((minD - d) * 0.5) / d; // half each — the remote client resolves its own
      k.x += dx * push;
      k.z += dz * push;
      pushed = true;
    }
    if (pushed) this.collideBarrier(); // a shove can land us past the wall
  }

  /** R — back to the last credited gate (or the spawn point) with a fresh kart. */
  private respawn(): void {
    const k = this.k;
    k.x = this.anchorX; k.y = 0; k.z = this.anchorZ; k.yaw = this.anchorYaw;
    k.vx = 0; k.vz = 0;
    k.gear = 1; k.shiftLeft = 0;
    k.drifting = false;
    this.acc = 0;
    this.driftVis = 0;
    this.pktClock = PACKET_DT; // tell the server at once
    this.correctSuppress = CORRECT_SUPPRESS_S; // echoes of the old spot are stale now
    this.wrongWayT = 0; // re-anchored facing travel — recovery state is moot
    this.recovering = false;
    this.stuckT = 0;
  }

  private clearHeld(): void {
    this.keyUp = this.keyDown = this.keyLeft = this.keyRight = this.keyDrift = false;
  }

  private readonly onBlur = (): void => {
    this.clearHeld(); // never leave keys stuck down across a focus loss
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (typingTarget(e.target)) return; // DOM menus keep normal typing
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': this.keyUp = true; break;
      case 'ArrowDown': case 'KeyS': this.keyDown = true; break;
      case 'ArrowLeft': case 'KeyA': this.keyLeft = true; break;
      case 'ArrowRight': case 'KeyD': this.keyRight = true; break;
      case 'Space': case 'ShiftLeft': case 'ShiftRight': this.keyDrift = true; break;
      case 'KeyR': if (!e.repeat) this.respawn(); break;
      case 'KeyN': if (!e.repeat) this.onNitro?.(); break;
      default: return; // not a game key — leave the event alone
    }
    e.preventDefault(); // game keys never scroll/navigate the page
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    // ungated: held flags must clear even if focus moved mid-press
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': this.keyUp = false; break;
      case 'ArrowDown': case 'KeyS': this.keyDown = false; break;
      case 'ArrowLeft': case 'KeyA': this.keyLeft = false; break;
      case 'ArrowRight': case 'KeyD': this.keyRight = false; break;
      case 'Space': case 'ShiftLeft': case 'ShiftRight': this.keyDrift = false; break;
    }
  };
}
