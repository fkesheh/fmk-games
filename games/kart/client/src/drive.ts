// ============================================================================
// kart-drive — DriveController: keyboard → INPUTS → predicted kart.
//
// The kart is no longer simulated here alone: this module produces one
// `kart_input` per SIM_DT of real time, applies it IMMEDIATELY through a
// shared KartPredictor (so steering is instant — nothing in the local response
// path waits for the server) and hands the same objects to the wire. The
// server integrates the identical shared stepDrive over the identical inputs
// and is authoritative; reconcile() re-bases on its state and replays whatever
// it has not acknowledged yet. Kart-vs-kart contact is SERVER-resolved and is
// deliberately absent from this file.
//
// What still lives here is everything DOM- and feel-shaped: the keyboard
// (Arrows/WASD drive, Space/Shift drift, R respawn, N nitro; tracked by e.code,
// cleared on window blur, ignored while typing in a lobby field), the external
// setInput latch (e2e/debug driver AND the tablet touch pad — app.ts merges
// both into ONE latched input, there is no second input path), the pre-GO
// freeze, KIDS MODE (setAssist → the shared pursuitSteer controller owns the
// steer channel), the stuck auto-respawn for players who cannot press R
// (setStuckGuard: kids AND tablet, since the touch layout has no reverse), the
// smoothed drift visual, and the VISUAL error offset that hides a
// reconciliation correction over ~120ms.
//
// TouchPointers (below) is the DOM-FREE half of the tablet control surface:
// pointerId -> control bookkeeping with no element, rect or event in it, so the
// multi-touch rules that decide whether a child's steering sticks are unit
// testable in node. app.ts owns the elements, the hit-test and the listeners.
//
// R / the stuck detector do NOT teleport directly: they raise a one-shot flag
// consumed by the next input as `respawn: true`, so the teleport is part of the
// replayable input sequence instead of something reconciliation fights.
//
// state() returns module scratch — copy out what you keep; nothing here
// allocates per frame except exactly one input object per sim tick, which is
// REQUIRED: the predictor retains it for replay, so it can never be scratch.
// ============================================================================
import {
  NITRO_TIME,
  PENDING_INPUT_CAP,
  SIM_DT,
  KartPredictor,
  forwardSpeed,
  makeAssistState,
  pursuitSteer,
  stuckStep,
} from '@kart/shared';
import type {
  AssistState,
  KartC2S,
  KartInput,
  KartInputMsg,
  KartSim,
  TrackDef,
} from '@kart/shared';

// ---- tuning -----------------------------------------------------------------
const MAX_FRAME_DT = 0.25; // tab-back hitch clamp; sim time beyond this is dropped
const DRIFT_VIS_RATE = 10; // driftVisual approach rate /s
const ERR_TAU_S = 0.12; // visual error offset decay time constant (~120ms)
const ERR_SNAP_M = 8; // a correction bigger than this is a teleport: snap, don't smooth
// Backstop only: flush() runs every frame while in a room, so the outbox holds
// at most a frame's worth (1-2). The cap exists so that a caller which stops
// flushing (screen change, torn-down socket) cannot grow it without bound —
// dropped frames are what the ack + replay already recover from.
const OUTBOX_CAP = PENDING_INPUT_CAP;
// A correction that stays pinned at the clamp means prediction is not
// converging at all (the offset would otherwise park the rendered kart a full
// ERR_SNAP_M from where gates and collisions actually resolve). After this many
// consecutive clamped corrections, stop hiding it and snap.
const ERR_CLAMP_GIVE_UP = 3;
// TABLET + KIDS MODE: the assist owns the steer channel (docs/KART.md), but the
// touch layout in that combination renders two steering zones and nothing else
// — zones that did nothing would be a lie to the one player who cannot be told
// why. A held zone therefore adds this much steer ON TOP of the pursuit, and
// only ever through the ext latch (the keyboard's kids-mode behaviour is
// untouched: keys never reach `ext`). Strictly < 1 is the safety property —
// pursuitSteer saturates at ±1, so the assist can always out-pull a held thumb
// and the kart cannot be steered off the road no matter how long she holds.
// With no touch steer latched this term is exactly +0: kids mode is bit-for-bit
// what it was.
const KIDS_TOUCH_NUDGE = 0.6;

export interface DriveState extends KartSim {
  steer: number; // current effective steering input -1..1 (wheel visual)
  driftVisual: number; // smoothed 0..1 drift intensity (skid visual)
  speed: number; // signed forward speed, m/s
  assist: boolean; // KIDS MODE auto-steer active (HUD badge / debug surface)
}

// ---- module scratch (zero per-frame allocation; do not retain) ----------------
const STATE_OUT: DriveState = {
  x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0,
  gear: 1, shiftLeft: 0, drifting: false, nitroLeft: 0,
  expectedGate: 0, anchorX: 0, anchorZ: 0, anchorYaw: 0,
  steer: 0, driftVisual: 0, speed: 0, assist: false,
};

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
  private readonly pred: KartPredictor;

  // held keyboard state (tracked by e.code, layout-independent)
  private keyUp = false;
  private keyDown = false;
  private keyLeft = false;
  private keyRight = false;
  private keyDrift = false;

  // external input latch (setInput) + the per-tick merged effective input
  private readonly ext: KartInput = { throttle: 0, brake: 0, steer: 0, drift: false };
  private readonly eff: KartInput = { throttle: 0, brake: 0, steer: 0, drift: false };

  private acc = 0; // real time accumulated toward the next SIM_DT tick
  private seq = 0; // per-client monotonic, never reset within a connection
  private driftVis = 0;
  private frozen = false; // pre-GO freeze: ticks are sent but never simulated
  private assistOn = false; // KIDS MODE — app-owned; reset()/blur never clear it
  private stuckGuard = false; // TABLET — the stuck auto-respawn without the auto-steer
  private readonly assist: AssistState = makeAssistState();
  private respawnPending = false; // one-shot, consumed by the next input's `respawn`

  // inputs produced since the last flush() — the SAME objects the predictor holds
  private readonly outbox: KartInputMsg[] = [];

  // visual-only position offset that absorbs the last reconciliation correction
  private errX = 0;
  private errZ = 0;
  private errClamped = 0; // consecutive corrections that hit the offset clamp
  private lastCorr = 0; // metres the last reconcile() moved the predicted kart

  /** App-wired nitro request hook — fired on a fresh KeyN press. */
  onNitro: (() => void) | null = null;

  constructor(private track: TrackDef) {
    this.pred = new KartPredictor(track);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
      window.addEventListener('blur', this.onBlur);
    }
  }

  /** Swap circuits (the room's trackId arrives with kart_joined). Drops the replay queue. */
  setTrack(track: TrackDef): void {
    this.track = track;
    this.pred.setTrack(track);
  }

  /** Remove keyboard listeners (teardown / hot-reload). */
  dispose(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  /**
   * Teleport to a spawn/grid slot (the GO grid wipe). Clears the predictor's
   * replay queue — the inputs that led anywhere else are moot now — and the
   * visual error offset, so the kart appears exactly on its slot.
   */
  reset(x: number, z: number, yaw: number): void {
    this.pred.reset(x, z, yaw);
    this.acc = 0;
    this.driftVis = 0;
    this.errX = 0;
    this.errZ = 0;
    this.errClamped = 0;
    this.lastCorr = 0;
    // inputs already emitted for the PRE-reset kart are dropped from the replay
    // queue by pred.reset(), so sending them would be asserting intent for a
    // kart that no longer exists. The server ignores them today (it force-acks
    // at GO) — do not lean on that.
    this.outbox.length = 0;
    this.assist.wrongWayT = 0;
    this.assist.recovering = false;
    this.assist.stuckT = 0;
    this.respawnPending = false;
  }

  /** Latch an external input (debug surface / e2e). Merged over the keyboard per tick. */
  setInput(inp: KartInput): void {
    this.ext.throttle = inp.throttle;
    this.ext.brake = inp.brake;
    this.ext.steer = inp.steer;
    this.ext.drift = inp.drift;
  }

  /**
   * Pre-GO freeze: while frozen, the tick still produces and SENDS an input
   * (liveness + the ack keeps flowing) but with every channel zeroed, and it is
   * NOT pushed into the predictor — the server does not integrate outside
   * 'racing' either, so both peers stay in exact agreement while the grid waits.
   */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  /**
   * KIDS MODE toggle: while on, the steer channel is driven by the shared
   * assist controller (pure pursuit toward the centerline ~10m ahead +
   * wrong-way recovery + reverse mirror) instead of the keyboard, and a stuck
   * kart auto-respawns. Throttle/brake/drift/R/nitro stay manual. App-owned —
   * reset() and window blur do NOT clear it.
   */
  setAssist(on: boolean): void {
    this.assistOn = on;
  }

  /**
   * TABLET MODE: arm the stuck auto-respawn WITHOUT the auto-steer. The touch
   * layout has no brake and no reverse, so a pad player who buries the kart in
   * a barrier has no input that can back it out and no R key to press; this is
   * the whole of their recovery. Independent of setAssist — a tablet player is
   * not a child — and app-owned, like the assist: reset() and blur never clear
   * it. Off by default, so a keyboard player is never teleported unasked.
   */
  setStuckGuard(on: boolean): void {
    this.stuckGuard = on;
    if (!on) this.assist.stuckT = 0; // leaving tablet mode must not carry a part-run timer
  }

  /** Server-approved nitro (the nitro event for the local player): start the boost. */
  activateNitro(): void {
    this.pred.state().nitroLeft = NITRO_TIME;
  }

  /**
   * Advance real time; emits one input per SIM_DT of it. Each input is applied
   * to the predictor the instant it is produced (instant steering) and queued
   * for both the wire and the replay.
   */
  step(dt: number): void {
    if (!(dt > 0)) return; // NaN/negative guard
    const dtc = Math.min(dt, MAX_FRAME_DT);
    // visual error offset decays toward 0 with a ~ERR_TAU_S time constant
    if (this.errX !== 0 || this.errZ !== 0) {
      const k = Math.exp(-dtc / ERR_TAU_S);
      this.errX *= k;
      this.errZ *= k;
    }
    this.acc += dtc;
    while (this.acc >= SIM_DT) {
      this.acc -= SIM_DT;
      this.tick();
    }
  }

  /**
   * Adopt the server's authoritative own-state and replay everything it has not
   * acknowledged. The position jump the correction introduces is moved into the
   * VISUAL offset instead of onto the screen, so a converged client (correction
   * 0m) renders with an offset of exactly 0 and a small correction is absorbed
   * over ~120ms; a jump past ERR_SNAP_M is a teleport and snaps.
   * @returns the correction in metres.
   */
  reconcile(auth: Readonly<KartSim>, ackSeq: number): number {
    const s = this.pred.state();
    const preX = s.x;
    const preZ = s.z;
    const corr = this.pred.reconcile(auth, ackSeq);
    this.lastCorr = corr;
    if (corr <= 0) return corr;
    if (corr > ERR_SNAP_M) {
      this.errX = 0; // teleport (respawn / grid wipe / desync): show it honestly
      this.errZ = 0;
      this.errClamped = 0;
      return corr;
    }
    this.errX += preX - s.x;
    this.errZ += preZ - s.z;
    const mag = Math.hypot(this.errX, this.errZ);
    if (mag > ERR_SNAP_M) {
      this.errClamped++;
      if (this.errClamped >= ERR_CLAMP_GIVE_UP) {
        // sustained divergence: smoothing has become a lie about where the kart
        // is — drop the whole offset rather than render permanently offset
        this.errX = 0;
        this.errZ = 0;
        this.errClamped = 0;
        return corr;
      }
      const k = ERR_SNAP_M / mag; // stacked corrections must never park us far off
      this.errX *= k;
      this.errZ *= k;
    } else {
      this.errClamped = 0;
    }
    return corr;
  }

  /**
   * Hand every input produced since the last flush to `send` (which must
   * serialize synchronously — these objects are still owned by the predictor).
   * @returns how many inputs were sent.
   */
  flush(send: (m: KartC2S) => void): number {
    const box = this.outbox;
    const n = box.length;
    for (let i = 0; i < n; i++) {
      const m = box[i];
      if (m !== undefined) send(m);
    }
    box.length = 0;
    return n;
  }

  /**
   * Live predicted state + the visual offset + visual extras. Module scratch —
   * do not retain. This is the RENDERED view of the kart, not the sim's own
   * state: the visual error offset is folded into x/z, and while frozen the
   * velocity reads 0 (a parked grid must show a parked speedo and an idling
   * engine). The predictor's true state is never touched by either — physics,
   * gates and the replay all run on the real numbers.
   */
  state(): DriveState {
    const k = this.pred.state();
    const o = STATE_OUT;
    o.x = k.x + this.errX; // RENDERED position: physics/gates use the true one
    o.y = k.y;
    o.z = k.z + this.errZ;
    o.yaw = k.yaw;
    o.vx = this.frozen ? 0 : k.vx;
    o.vz = this.frozen ? 0 : k.vz;
    o.gear = k.gear; o.shiftLeft = k.shiftLeft;
    o.drifting = k.drifting;
    o.nitroLeft = k.nitroLeft;
    o.expectedGate = k.expectedGate;
    o.anchorX = k.anchorX; o.anchorZ = k.anchorZ; o.anchorYaw = k.anchorYaw;
    o.steer = this.eff.steer;
    o.driftVisual = this.driftVis;
    o.speed = this.frozen ? 0 : forwardSpeed(k);
    o.assist = this.assistOn;
    return o;
  }

  /** Effective merged throttle 0..1 (keyboard + latched ext) — the audio load axis. */
  throttle(): number {
    return this.eff.throttle;
  }

  /** Inputs still awaiting a server ack (netcode health / telemetry). */
  pending(): number {
    return this.pred.pendingCount();
  }

  /** Metres the last reconcile() moved the predicted kart (0 = converged). */
  lastCorrection(): number {
    return this.lastCorr;
  }

  /** The last input seq produced (what the server's ack is compared against). */
  seqNo(): number {
    return this.seq;
  }

  // ---- internals --------------------------------------------------------------

  /** One SIM_DT of driver intent: build it, apply it, queue it. */
  private tick(): void {
    const e = this.eff;
    if (this.frozen) {
      e.throttle = 0; e.brake = 0; e.steer = 0; e.drift = false;
      this.respawnPending = false; // a respawn means nothing on a frozen grid
      this.emit(false); // liveness only: sent, never simulated on either side
      return;
    }
    const k = this.pred.state();
    e.throttle = clamp((this.keyUp ? 1 : 0) + this.ext.throttle, 0, 1);
    e.brake = clamp((this.keyDown ? 1 : 0) + this.ext.brake, 0, 1);
    // STUCK AUTO-RESPAWN — for anyone with no R key within reach. That was
    // originally only KIDS MODE; it is now every TABLET player too, because the
    // touch layout deliberately has no brake/reverse (docs/TOUCH_PWA.md §4.2.1)
    // and a fourth right-hand button would crowd the gas/nitro channel the
    // layout is tuned around. Without this, a wedged pad player has no way out
    // at all. The rule itself is shared + unit tested (sim.ts stuckStep)
    // because losing it strands a player, and it is unchanged: throttle held
    // above STUCK_THROTTLE while |speed| stays under STUCK_SPEED for
    // STUCK_HOLD_S of SIM time. Off for a keyboard player with neither flag —
    // they have R, and an unasked-for teleport would be worse than being stuck.
    if (
      (this.assistOn || this.stuckGuard) &&
      stuckStep(this.assist, e.throttle, forwardSpeed(k), SIM_DT)
    ) {
      this.respawn();
    }
    // KIDS MODE: the steer channel is fully owned by the assist controller.
    if (this.assistOn) {
      // + the latched touch nudge (0 unless a tablet steering zone is held, so
      // the keyboard/e2e path through kids mode is unchanged to the bit)
      e.steer = clamp(
        pursuitSteer(this.track, k, this.assist, SIM_DT) + this.ext.steer * KIDS_TOUCH_NUDGE,
        -1,
        1,
      );
    } else {
      e.steer = clamp((this.keyRight ? 1 : 0) - (this.keyLeft ? 1 : 0) + this.ext.steer, -1, 1);
    }
    e.drift = this.keyDrift || this.ext.drift;
    const respawn = this.respawnPending;
    this.respawnPending = false;
    const msg = this.emit(respawn);
    this.pred.push(msg); // applied NOW — this is what keeps the local kart instant
    // smoothed skid intensity for the renderer (deterministic per sim tick)
    const target = k.drifting ? 1 : 0;
    this.driftVis += (target - this.driftVis) * Math.min(1, DRIFT_VIS_RATE * SIM_DT);
  }

  /**
   * Allocate this tick's wire input and queue it for sending. ONE allocation
   * per sim tick is required, not a leak: the predictor retains the object for
   * replay, so it can never be a reused scratch object.
   */
  private emit(respawn: boolean): KartInputMsg {
    const e = this.eff;
    const msg: KartInputMsg = {
      t: 'kart_input',
      seq: ++this.seq,
      throttle: e.throttle,
      brake: e.brake,
      steer: e.steer,
      drift: e.drift,
      respawn,
      dt: SIM_DT,
    };
    if (this.outbox.length >= OUTBOX_CAP) this.outbox.shift(); // socket away: drop oldest
    this.outbox.push(msg);
    return msg;
  }

  /** R / the stuck guard's auto-recovery — the teleport rides the NEXT input. */
  private respawn(): void {
    this.respawnPending = true;
    this.driftVis = 0;
    this.errX = 0; // the pre-teleport visual error is meaningless at the anchor
    this.errZ = 0;
    this.assist.wrongWayT = 0; // re-anchored facing travel — recovery state is moot
    this.assist.recovering = false;
    this.assist.stuckT = 0;
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

// ============================================================================
// TABLET TOUCH — the DOM-free half
// ============================================================================

/** One target on the tablet control surface. `null` is dead space (no control). */
export type TouchControl = 'left' | 'right' | 'gas' | 'drift' | 'nitro';

/** Every control, in hit-test order (the surfaces never overlap). */
export const TOUCH_CONTROLS: readonly TouchControl[] = ['left', 'right', 'gas', 'drift', 'nitro'];

/**
 * Multi-touch bookkeeping for the tablet pad: which pointerId is currently on
 * which control, and therefore which controls are held.
 *
 * This is a correctness object, not a convenience one. Two thumbs are down
 * simultaneously for the whole race, and the failure mode of getting it wrong
 * is STUCK STEERING — a kart that keeps turning after the child let go, which
 * she cannot diagnose and cannot escape. Hence:
 *
 *  - state is keyed by `pointerId`, never by "the touch"; a second finger can
 *    never overwrite the first, and releasing one never releases the other;
 *  - `retarget()` moves a finger between controls (sliding out of a zone
 *    releases it and engages whatever is under the finger now, dead space
 *    included, WITHOUT forgetting the finger — sliding back re-engages);
 *  - `release()` is what pointerup, pointercancel and lostpointercapture all
 *    call, because a system-cancelled press must free the control exactly like
 *    a lift; and
 *  - `clear()` exists so blur / tab-hide / screen change cannot leave a control
 *    latched with no pointer left alive to release it.
 *
 * Zero allocation after construction: presses mutate a Map and a small counter
 * record, and the derived reads are arithmetic.
 */
export class TouchPointers {
  /** pointerId -> the control it is on (null = the finger is down on dead space). */
  private readonly byId = new Map<number, TouchControl | null>();
  /** How many pointers are on each control (two thumbs on one zone is legal). */
  private readonly held: Record<TouchControl, number> = {
    left: 0, right: 0, gas: 0, drift: 0, nitro: 0,
  };

  /**
   * A pointer went down on `control` (null = dead space; still tracked, so a
   * slide onto a button from outside one engages it).
   * @returns true if this press newly engaged the control (the nitro edge).
   */
  press(pointerId: number, control: TouchControl | null): boolean {
    if (this.byId.has(pointerId)) return this.retarget(pointerId, control);
    this.byId.set(pointerId, control);
    if (control === null) return false;
    return ++this.held[control] === 1;
  }

  /**
   * A tracked pointer moved onto `control` (null = dead space). Untracked
   * pointers are ignored — a mouse moving across the pad with no button down
   * must not steer.
   * @returns true if the move newly engaged the control (the nitro edge).
   */
  retarget(pointerId: number, control: TouchControl | null): boolean {
    if (!this.byId.has(pointerId)) return false;
    const prev = this.byId.get(pointerId) ?? null;
    if (prev === control) return false;
    if (prev !== null) this.held[prev]--;
    this.byId.set(pointerId, control);
    if (control === null) return false;
    return ++this.held[control] === 1;
  }

  /** pointerup / pointercancel / lostpointercapture — all release identically. */
  release(pointerId: number): void {
    const prev = this.byId.get(pointerId);
    if (prev === undefined) return;
    if (prev !== null) this.held[prev]--;
    this.byId.delete(pointerId);
  }

  /** Blur / tab hide / leaving the race screen: nothing may stay held. */
  clear(): void {
    this.byId.clear();
    this.held.left = 0;
    this.held.right = 0;
    this.held.gas = 0;
    this.held.drift = 0;
    this.held.nitro = 0;
  }

  /** Is anything holding this control down? */
  isDown(control: TouchControl): boolean {
    return this.held[control] > 0;
  }

  /** Pointers currently tracked (dead-space fingers included). */
  count(): number {
    return this.byId.size;
  }

  /**
   * Merged steering, -1..1. BOTH zones held is 0 — deliberately, and not by
   * accident of ordering: two thumbs down means "straight", and lifting one of
   * them must leave the kart steering toward the thumb that is STILL DOWN
   * rather than snapping to neutral. That falls straight out of reading both
   * counters every time instead of remembering "the last zone touched".
   */
  steer(): number {
    return (this.held.right > 0 ? 1 : 0) - (this.held.left > 0 ? 1 : 0);
  }
}
