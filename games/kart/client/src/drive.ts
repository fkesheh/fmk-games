// ============================================================================
// kart-drive — DriveController: keyboard → deterministic local kart sim.
// Wraps the shared stepKart at fixed 120Hz substeps (render dt accumulates),
// with a surfaceAt() grip lookup per substep, barrier push-out at the road
// shoulder, soft kart-kart repulsion, and an in-order gate tracker whose last
// credited gate doubles as the R-respawn anchor. Keyboard: Arrows/WASD drive,
// Space/Shift drift (handbrake), R respawn; window blur clears every held key
// (this game has no pointer lock). state()/packet() return module scratch
// objects — copy out what you keep; nothing here allocates per frame, and
// logic never calls Math.random (deterministic per input sequence).
// ============================================================================
import {
  BARRIER_DAMP, GATES, GATE_RADIUS, KART_RADIUS, SNAPSHOT_HZ,
  closestOnTrack, forwardSpeed, makeKart, stepKart, surfaceAt,
} from '@kart/shared';
import type { KartC2S, KartInput, KartState, TrackDef } from '@kart/shared';

// ---- tuning -----------------------------------------------------------------
const SUBSTEP_DT = 1 / 120; // fixed physics rate, independent of rAF rate
const MAX_FRAME_DT = 0.25; // tab-back hitch clamp; sim time beyond this is dropped
const PACKET_DT = 1 / SNAPSHOT_HZ; // kart_state stream rate (15Hz)
const BARRIER_OUT = 1.2; // barrier wall offset past the road edge (m)
const DRIFT_VIS_RATE = 10; // driftVisual approach rate /s

export interface DriveState extends KartState {
  steer: number; // current effective steering input -1..1 (wheel visual)
  driftVisual: number; // smoothed 0..1 drift intensity (skid visual)
  speed: number; // signed forward speed, m/s
}

// ---- module scratch (zero per-frame allocation; do not retain) ----------------
const STATE_OUT: DriveState = {
  x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0,
  drifting: false, driftTime: 0, turboLeft: 0,
  steer: 0, driftVisual: 0, speed: 0,
};
const PACKET_OUT: KartC2S = {
  t: 'kart_state', seq: 0, p: [0, 0, 0], yaw: 0, v: [0, 0], steer: 0, drift: false,
};
const NO_OTHERS: ReadonlyArray<readonly [number, number, number]> = [];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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
    k.drifting = false; k.driftTime = 0; k.turboLeft = 0;
    this.acc = 0;
    this.driftVis = 0;
    this.pktClock = PACKET_DT;
    this.expectedGate = 0;
    this.anchorX = x; this.anchorZ = z; this.anchorYaw = yaw;
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

  /** Advance the sim by render dt (seconds); runs fixed 120Hz substeps inside. */
  step(dt: number): void {
    if (!(dt > 0)) return; // NaN/negative guard
    const dtc = Math.min(dt, MAX_FRAME_DT);
    this.pktClock += dtc;
    const e = this.eff;
    e.throttle = clamp((this.keyUp ? 1 : 0) + this.ext.throttle, 0, 1);
    e.brake = clamp((this.keyDown ? 1 : 0) + this.ext.brake, 0, 1);
    e.steer = clamp((this.keyRight ? 1 : 0) - (this.keyLeft ? 1 : 0) + this.ext.steer, -1, 1);
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
    o.drifting = k.drifting; o.driftTime = k.driftTime; o.turboLeft = k.turboLeft;
    o.steer = this.eff.steer;
    o.driftVisual = this.driftVis;
    o.speed = forwardSpeed(k);
    return o;
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
    k.drifting = false; k.driftTime = 0; k.turboLeft = 0;
    this.acc = 0;
    this.driftVis = 0;
    this.pktClock = PACKET_DT; // tell the server at once
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
