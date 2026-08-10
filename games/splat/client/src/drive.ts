// ============================================================================
// splat-drive — DriveController: keyboard + tablet touch + ext latch → steer →
// predicted skier (CONTRACT §7 C1, seam frozen in §7a).
//
// Steering is the ONLY input in SKI SPLAT. This module produces one
// `splat_input` per SIM_DT of real time, applies it IMMEDIATELY through the
// shared SkiPredictor (steering never waits for the server), and hands the
// same (seq, steer, dt) to the wire. The server integrates the identical
// stepSki over the identical inputs and is authoritative; reconcile() re-bases
// on its state and replays whatever it has not acknowledged yet.
//
// The wire steer is POST-RAMP and POST-ASSIST-EMA (CONTRACT §5): the ramp to
// full lock (STEER_RAMP_S) and the assist smoothing (ASSIST_STEER_EMA) live
// HERE, not in the sim. stepSki applies neither.
//
// What lives here, all DOM- and feel-shaped:
//  - the keyboard (←/→ and A/D, tracked by e.code, cleared on window blur AND
//    visibilitychange, ignored while typing in a menu field);
//  - TouchPointers (below): the DOM-FREE half of the tablet control surface,
//    the kart class trimmed to the two steering zones — C2 owns the elements,
//    the hit-test and the listeners, and wires pointercancel/lostpointercapture
//    into release();
//  - the external setInput latch (debug/e2e), merged ADDITIVELY with the
//    ramped keyboard + touch steer per SIM_DT tick, clamped to -1..1;
//  - ASSIST MODE: an EMA over the merged steer (ASSIST_STEER_EMA per tick).
//    The EMA IS the "narrowed max steer rate" of §7: the per-tick change is
//    bounded by ASSIST_STEER_EMA * |target - current|, so the wire steer can
//    never jump full-scale in one tick. setAssist forwards to the predictor —
//    the physics half (plant radius, snare, edge push) flips in the sim;
//  - the VISUAL error offset that hides a small reconciliation correction over
//    ~120ms (the kart pattern) and snaps honestly on teleports.
//
// state() returns the predictor's LIVE state — the true physics numbers (read
// by convention only; replay runs on it). The visual error offset is exposed
// separately (errorX()/errorZ()): C2 adds them to the camera position, never
// to anything gameplay-shaped. steerVisual() is the ramped/EMA'd steer for the
// own-skis angle and the camera carve roll.
//
// SIGN CONVENTION (end-to-end, frozen with the sim — do not flip casually):
// the wire steer is SIM-space: positive steer turns the skier toward world +x
// (stepSki semantics). The camera looks along +z in three.js's right-handed
// y-up world, so world +x renders on SCREEN-LEFT — wire positive = screen-LEFT.
// Every input surface therefore maps screen geometry onto the wire with the
// sign inverted from what the world axes suggest:
//   - RIGHT key (ArrowRight/KeyD) / RIGHT touch zone -> steer -1 (screen right)
//   - LEFT key (ArrowLeft/KeyA)  / LEFT touch zone   -> steer +1 (screen left)
//   - setInput(+1) = full screen-LEFT, setInput(-1) = full screen-RIGHT — the
//     debug/e2e latch speaks the same screen convention (see setInput).
// steerVisual() shares the wire sign, so a screen-RIGHT turn reads NEGATIVE;
// the camera roll and own-skis angle consume it as-is.
//
// Nothing here allocates per frame except exactly one input message per sim
// tick — REQUIRED: the outbox retains it until flush(), so it can never be a
// reused scratch object.
// ============================================================================
import {
  ASSIST_STEER_EMA,
  PENDING_INPUT_CAP,
  SIM_DT,
  STEER_RAMP_S,
} from '@splat/shared';
import { SkiPredictor } from '@splat/shared/sim.js';
import type { SkierSim, SlopeDef, SplatC2S, SplatInputMsg } from '@splat/shared';

// ---- tuning -----------------------------------------------------------------
const MAX_FRAME_DT_S = 0.25; // tab-back hitch clamp; sim time beyond this is dropped
const ERR_TAU_S = 0.12; // visual error offset decay time constant (~120ms)
const ERR_SNAP_M = 8; // a correction bigger than this is a teleport: snap, don't smooth
// Backstop only: flush() runs every frame while in a room, so the outbox holds
// at most a frame's worth (1-2). The cap exists so that a caller which stops
// flushing (screen change, torn-down socket) cannot grow it without bound —
// dropped inputs are what the ack + replay already recover from.
const OUTBOX_CAP = PENDING_INPUT_CAP;
// A correction that stays pinned at the clamp means prediction is not
// converging at all. After this many consecutive clamped corrections, stop
// hiding it and snap.
const ERR_CLAMP_GIVE_UP = 3;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** True when a key event targets an editable element (menus keep typing). */
function typingTarget(t: EventTarget | null): boolean {
  if (typeof HTMLInputElement === 'undefined') return false; // headless (unit tests)
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

export class DriveController {
  private readonly pred: SkiPredictor;

  /** The tablet control surface — C2 wires DOM Pointer Events into this. */
  readonly touch: TouchPointers = new TouchPointers();

  // held keyboard state (tracked by e.code, layout-independent)
  private keyLeft = false;
  private keyRight = false;

  // per-channel ramps: 0 -> ±1 over STEER_RAMP_S while held, back on release
  private keyRamp = 0;
  private touchRamp = 0;

  // external input latch (setInput) — debug/e2e; merged additively, NOT ramped
  private extSteer = 0;

  // the value that goes on the wire: merged raw steer, assist-EMA'd when on.
  // Also the skis/camera-roll visual (steerVisual()).
  private steerVis = 0;

  private acc = 0; // real time accumulated toward the next SIM_DT tick
  private seq = 0; // per-client monotonic, never reset within a connection
  private assistOn = false; // app-owned; reset()/blur never clear it

  // inputs produced since the last flush()
  private readonly outbox: SplatInputMsg[] = [];

  // visual-only position offset that absorbs the last reconciliation correction
  private errX = 0;
  private errZ = 0;
  private errClamped = 0; // consecutive corrections that hit the offset clamp
  private lastCorr = 0; // metres the last reconcile() moved the predicted skier

  constructor(private readonly slope: SlopeDef) {
    this.pred = new SkiPredictor(slope);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
      window.addEventListener('blur', this.onBlur);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  /** Remove DOM listeners (teardown / hot-reload). */
  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('blur', this.onBlur);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
  }

  /**
   * Teleport to a spawn/grid slot (the GO grid wipe). Clears the predictor's
   * replay queue, the outbox (those inputs asserted intent for a skier that no
   * longer exists), the ramps and the visual error offset, so the skier
   * appears exactly on its slot with neutral skis. The wire seq keeps climbing
   * (per-connection monotonic); the assist toggle is app-owned and survives.
   */
  reset(x: number, z: number, yaw: number): void {
    this.pred.reset(x, z, yaw);
    this.acc = 0;
    this.keyRamp = 0;
    this.touchRamp = 0;
    this.steerVis = 0;
    this.errX = 0;
    this.errZ = 0;
    this.errClamped = 0;
    this.lastCorr = 0;
    this.outbox.length = 0;
  }

  /** Latch an external steer (debug surface / e2e), -1..1, in the SCREEN
   *  convention: -1 = full screen-RIGHT, +1 = full screen-LEFT (the value is
   *  already in wire sign — wire positive turns toward world +x = screen-left).
   *  Merged additively with the ramped keyboard + touch steer per tick, then
   *  clamped. */
  setInput(steer: number): void {
    this.extSteer = Number.isFinite(steer) ? clamp(steer, -1, 1) : 0;
  }

  /**
   * ASSIST MODE toggle: while on, the merged steer passes through an EMA
   * (ASSIST_STEER_EMA per SIM_DT tick) before it goes on the wire — the sim
   * never smooths, so the wire carries the already-smoothed value (§5). The
   * physics half (plant radius, snare duration, edge pushback) is the sim's
   * and flips via the predictor. App-owned — reset() and blur do NOT clear it.
   */
  setAssist(on: boolean): void {
    this.assistOn = on;
    this.pred.setAssist(on);
  }

  /**
   * Advance real time (rAF dt in MILLISECONDS); emits one input per SIM_DT of
   * it. Each input is applied to the predictor the instant it is produced
   * (instant steering) and queued for both the wire and the replay.
   */
  step(dtMs: number): void {
    if (!(dtMs > 0)) return; // NaN/negative guard
    const dtc = Math.min(dtMs / 1000, MAX_FRAME_DT_S);
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
   * Hand every input produced since the last flush to `send` (which must
   * serialize synchronously).
   * @returns how many inputs were sent.
   */
  flush(send: (m: SplatC2S) => void): number {
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
   * Adopt the server's authoritative own-state and replay everything it has
   * not acknowledged. The position jump the correction introduces is moved
   * into the VISUAL offset (errorX/errorZ) instead of onto the screen, so a
   * converged client (correction 0m) renders with an offset of exactly 0 and a
   * small correction is absorbed over ~120ms; a jump past ERR_SNAP_M is a
   * teleport and snaps.
   * @returns the correction in metres.
   */
  reconcile(auth: Readonly<SkierSim>, ackSeq: number): number {
    const s = this.pred.state();
    const preX = s.x;
    const preZ = s.z;
    const corr = this.pred.reconcile(auth, ackSeq);
    this.lastCorr = corr;
    if (corr <= 0) return corr;
    if (corr > ERR_SNAP_M) {
      this.errX = 0; // teleport (grid wipe / desync): show it honestly
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
        // sustained divergence: smoothing has become a lie about where the
        // skier is — drop the whole offset rather than render offset forever
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

  /** Live predicted state — read-only by convention; the TRUE physics numbers
   *  (no visual offset folded in). Camera: add errorX()/errorZ(). */
  state(): SkierSim {
    return this.pred.state();
  }

  /** The ramped (and assist-EMA'd) steer, -1..1 — own-skis angle + camera roll.
   *  Wire/screen sign: NEGATIVE = a screen-right turn, positive = screen-left. */
  steerVisual(): number {
    return this.steerVis;
  }

  /** Visual error offset from reconcile smoothing — add to state() for render. */
  errorX(): number {
    return this.errX;
  }
  errorZ(): number {
    return this.errZ;
  }

  /** Inputs still awaiting a server ack (netcode health / telemetry). */
  pending(): number {
    return this.pred.pendingCount();
  }

  /** Metres the last reconcile() moved the predicted skier (0 = converged). */
  lastCorrection(): number {
    return this.lastCorr;
  }

  /** The last input seq produced (what the server's ack is compared against). */
  seqNo(): number {
    return this.seq;
  }

  // ---- internals --------------------------------------------------------------

  /** One SIM_DT of driver intent: ramp, merge, smooth, apply, queue. */
  private tick(): void {
    // 1. ramps: held keys/zones approach ±1 over STEER_RAMP_S, release ramps back.
    //    Screen geometry is inverted onto the wire sign (see header): the RIGHT
    //    key targets -1 (screen right = world -x), the LEFT key targets +1.
    const keyTarget = (this.keyLeft ? 1 : 0) - (this.keyRight ? 1 : 0);
    this.keyRamp = rampToward(this.keyRamp, keyTarget);
    this.touchRamp = rampToward(this.touchRamp, this.touch.steer());
    // 2. additive merge of the three sources, clamped (the kart ext-latch merge)
    const raw = clamp(this.keyRamp + this.touchRamp + this.extSteer, -1, 1);
    // 3. ASSIST: EMA over the merged steer — the wire carries the smoothed
    //    value, and the EMA bound (≤ ASSIST_STEER_EMA * error per tick) IS the
    //    narrowed max steer rate of §7. Off: pass through untouched.
    if (this.assistOn) {
      this.steerVis += (raw - this.steerVis) * ASSIST_STEER_EMA;
    } else {
      this.steerVis = raw;
    }
    const steer = clamp(this.steerVis, -1, 1);
    // 4. ONE allocation per sim tick — the outbox retains the message until
    //    flush(), so it can never be a reused scratch object. The wire seq
    //    rides into the predictor so reconcile's ackSeq drops the right entries.
    const msg: SplatInputMsg = {
      t: 'splat_input',
      seq: ++this.seq,
      steer,
      dt: SIM_DT,
    };
    this.pred.push({ seq: msg.seq, steer, dt: SIM_DT }); // applied NOW
    if (this.outbox.length >= OUTBOX_CAP) this.outbox.shift(); // socket away: drop oldest
    this.outbox.push(msg);
  }

  private clearHeld(): void {
    this.keyLeft = false;
    this.keyRight = false;
    this.touch.clear(); // a thumb can never stay latched across a focus loss
  }

  private readonly onBlur = (): void => {
    this.clearHeld(); // never leave input stuck down across a focus loss
  };

  private readonly onVisibility = (): void => {
    // tab hidden mid-press: keyup/pointerup may never arrive — clear everything
    if (typeof document !== 'undefined' && document.hidden) this.clearHeld();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (typingTarget(e.target)) return; // DOM menus keep normal typing
    switch (e.code) {
      case 'ArrowLeft': case 'KeyA': this.keyLeft = true; break;
      case 'ArrowRight': case 'KeyD': this.keyRight = true; break;
      default: return; // not a game key — leave the event alone
    }
    e.preventDefault(); // game keys never scroll/navigate the page
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    // ungated: held flags must clear even if focus moved mid-press
    switch (e.code) {
      case 'ArrowLeft': case 'KeyA': this.keyLeft = false; break;
      case 'ArrowRight': case 'KeyD': this.keyRight = false; break;
    }
  };
}

/** Move `cur` toward `target` at the STEER_RAMP_S rate for one SIM_DT tick. */
function rampToward(cur: number, target: number): number {
  const maxDelta = SIM_DT / STEER_RAMP_S;
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}

// ============================================================================
// TABLET TOUCH — the DOM-free half (kart TouchPointers, trimmed to two zones)
// ============================================================================

/** One steering zone on the tablet control surface. `null` is dead space. */
export type SkiTouchSide = 'left' | 'right';

/**
 * Multi-touch bookkeeping for the tablet pad: which pointerId is currently on
 * which steering zone, and therefore which zones are held.
 *
 * This is a correctness object, not a convenience one. The failure mode of
 * getting it wrong is STUCK STEERING — a skier that keeps carving after the
 * player let go, which they cannot diagnose and cannot escape. Hence:
 *
 *  - state is keyed by `pointerId`, never by "the touch"; a second finger can
 *    never overwrite the first, and releasing one never releases the other;
 *  - `retarget()` moves a finger between zones (sliding out of a zone releases
 *    it and engages whatever is under the finger now, dead space included,
 *    WITHOUT forgetting the finger — sliding back re-engages);
 *  - `release()` is what pointerup, pointercancel and lostpointercapture all
 *    call, because a system-cancelled press must free the zone exactly like a
 *    lift; and
 *  - `clear()` exists so blur / tab-hide / screen change cannot leave a zone
 *    latched with no pointer left alive to release it.
 *
 * Zero allocation after construction: presses mutate a Map and two counters.
 */
export class TouchPointers {
  /** pointerId -> the zone it is on (null = the finger is down on dead space). */
  private readonly byId = new Map<number, SkiTouchSide | null>();
  /** How many pointers are on each zone (two thumbs on one zone is legal). */
  private heldLeft = 0;
  private heldRight = 0;

  /** A pointer went down on `side` (null = dead space; still tracked, so a
   *  slide onto a zone from outside one engages it). */
  press(pointerId: number, side: SkiTouchSide | null): void {
    if (this.byId.has(pointerId)) {
      this.retarget(pointerId, side);
      return;
    }
    this.byId.set(pointerId, side);
    this.bump(side, 1);
  }

  /** A tracked pointer moved onto `side` (null = dead space). Untracked
   *  pointers are ignored — a mouse moving across the pad with no button down
   *  must not steer. */
  retarget(pointerId: number, side: SkiTouchSide | null): void {
    if (!this.byId.has(pointerId)) return;
    const prev = this.byId.get(pointerId) ?? null;
    if (prev === side) return;
    this.bump(prev, -1);
    this.byId.set(pointerId, side);
    this.bump(side, 1);
  }

  /** pointerup / pointercancel / lostpointercapture — all release identically. */
  release(pointerId: number): void {
    const prev = this.byId.get(pointerId);
    if (prev === undefined) return;
    this.bump(prev, -1);
    this.byId.delete(pointerId);
  }

  /** Blur / tab hide / leaving the race screen: nothing may stay held. */
  clear(): void {
    this.byId.clear();
    this.heldLeft = 0;
    this.heldRight = 0;
  }

  /** Is anything holding this zone down? */
  isDown(side: SkiTouchSide): boolean {
    return side === 'left' ? this.heldLeft > 0 : this.heldRight > 0;
  }

  /** Pointers currently tracked (dead-space fingers included). */
  count(): number {
    return this.byId.size;
  }

  /**
   * Merged steering, -1..1, in wire/screen sign (see the DriveController
   * header): the RIGHT zone contributes -1 (screen right = world -x), the LEFT
   * zone +1. BOTH zones held is 0 — deliberately: two thumbs
   * down means "straight", and lifting one of them must leave the skier
   * steering toward the thumb that is STILL DOWN rather than snapping to
   * neutral. That falls straight out of reading both counters every time
   * instead of remembering "the last zone touched".
   */
  steer(): number {
    return (this.heldLeft > 0 ? 1 : 0) - (this.heldRight > 0 ? 1 : 0);
  }

  private bump(side: SkiTouchSide | null, d: number): void {
    if (side === 'left') this.heldLeft += d;
    else if (side === 'right') this.heldRight += d;
  }
}
