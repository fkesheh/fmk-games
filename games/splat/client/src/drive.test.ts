// ============================================================================
// drive.test.ts — the SKI SPLAT control surface's correctness rules.
//
// Steering is the ONLY input, and the player who holds a thumb on a tablet
// zone cannot tell you what went wrong when it sticks — so every rule that
// prevents STUCK STEERING is proven here:
//
// 1. TouchPointers: multi-touch bookkeeping by pointerId. The four cases the
//    contract names (both down / lift one / slide across / pointercancel) are
//    real things two thumbs do in one descent.
// 2. DriveController: the keyboard ramp (full lock over STEER_RAMP_S and
//    back), the additive ext-latch merge with its ±1 clamp, blur /
//    visibilitychange clearing held input, one splat_input per SIM_DT with a
//    monotonic seq, ASSIST MODE (EMA smoothing + narrowed steer rate + the
//    predictor physics flip), and reconcile convergence / replay / smoothing.
//
// DOM: DriveController only touches window/document behind typeof guards, and
// the keyboard tests install a MINIMAL fake window/document on globalThis
// (addEventListener/removeEventListener + a fire() helper) — the kart-style
// dependency injection that keeps the controller testable headless. The fake
// is removed after each test so no other suite sees it.
// ============================================================================
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSIST_STEER_EMA,
  PLANT_BAND_M,
  SIM_DT,
  STEER_RAMP_S,
} from '@splat/shared';
import { makeSim, stepSki } from '@splat/shared/sim.js';
import type {
  Plant,
  SlopeDef,
  SplatInputMsg,
} from '@splat/shared';
import { DriveController, TouchPointers } from './drive.js';

const LEFT_THUMB = 1; // pointerId — arbitrary and deliberately not 0/1-ordered
const RIGHT_THUMB = 7;
const FRAME_MS = 1000 / 30; // exactly one SIM_DT tick per step() call

/** A flat, plant-free-by-default slope — the frozen SlopeDef interface needs
 *  no generator (P1's fixtures do exactly this). */
function flatSlope(plants: readonly Plant[] = []): SlopeDef {
  return {
    seed: 1,
    length: 800,
    width: 56,
    finishZ: 800,
    plants,
    height: (_x: number, z: number): number => -0.21 * z,
    gradeAt: (): number => 0.21,
    plantGrid: (zBand: number): readonly Plant[] =>
      plants.filter((p) => Math.floor(p.z / PLANT_BAND_M) === zBand),
  };
}

/** Run `frames` single-tick steps (1 tick = 1/30 s of sim time). */
function run(d: DriveController, frames: number): void {
  for (let i = 0; i < frames; i++) d.step(FRAME_MS);
}

/** Drain the outbox, keeping only the input messages. */
function drain(d: DriveController): SplatInputMsg[] {
  const out: SplatInputMsg[] = [];
  d.flush((m) => {
    if (m.t === 'splat_input') out.push(m);
  });
  return out;
}

// ---- fake DOM (installed only around keyboard/blur tests) --------------------

type Handler = (e: unknown) => void;

class FakeTarget {
  private readonly handlers = new Map<string, Set<Handler>>();

  addEventListener(type: string, fn: Handler): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: Handler): void {
    this.handlers.get(type)?.delete(fn);
  }

  listenerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  fire(type: string, ev: object): void {
    for (const fn of this.handlers.get(type) ?? []) fn(ev);
  }
}

const g = globalThis as { window?: unknown; document?: unknown };
let fakeWindow: FakeTarget;
let fakeDocument: FakeTarget & { hidden: boolean };

function installFakeDom(): void {
  fakeWindow = new FakeTarget();
  fakeDocument = new FakeTarget() as FakeTarget & { hidden: boolean };
  fakeDocument.hidden = false;
  g.window = fakeWindow;
  g.document = fakeDocument;
}

function removeFakeDom(): void {
  delete g.window;
  delete g.document;
}

function key(type: 'keydown' | 'keyup', code: string): void {
  fakeWindow.fire(type, { code, target: null, preventDefault() {} });
}

afterEach(removeFakeDom);

// ==============================================================================
// TouchPointers — multi-touch by pointerId (the four contract cases)
// ==============================================================================
describe('TouchPointers — the four multi-touch cases', () => {
  it('both thumbs down reads straight', () => {
    const t = new TouchPointers();
    t.press(LEFT_THUMB, 'left');
    t.press(RIGHT_THUMB, 'right');
    expect(t.steer()).toBe(0);
    expect(t.isDown('left')).toBe(true);
    expect(t.isDown('right')).toBe(true);
    expect(t.count()).toBe(2);
  });

  it('lifting one thumb steers toward the thumb still held, not neutral', () => {
    const t = new TouchPointers();
    t.press(LEFT_THUMB, 'left');
    t.press(RIGHT_THUMB, 'right');
    t.release(RIGHT_THUMB);
    expect(t.steer()).toBe(1); // the left thumb never lifted — still steering left (+1 = screen-left)
    t.press(RIGHT_THUMB, 'right');
    t.release(LEFT_THUMB);
    expect(t.steer()).toBe(-1); // the right thumb alone: -1 = screen-right
  });

  it('a thumb sliding from the left zone into the right switches sides cleanly', () => {
    const t = new TouchPointers();
    t.press(LEFT_THUMB, 'left');
    expect(t.steer()).toBe(1);
    t.retarget(LEFT_THUMB, 'right');
    expect(t.steer()).toBe(-1);
    expect(t.isDown('left')).toBe(false); // the zone it left must not stay latched
    expect(t.count()).toBe(1); // still ONE finger, not two
  });

  it('pointercancel releases exactly like a lift, and leaves the other thumb alone', () => {
    const t = new TouchPointers();
    t.press(LEFT_THUMB, 'left');
    t.press(RIGHT_THUMB, 'right');
    // the system takes the steering pointer away (notification, app switch,
    // palm rejection): release() is what pointercancel/lostpointercapture call
    t.release(LEFT_THUMB);
    expect(t.isDown('left')).toBe(false);
    expect(t.steer()).toBe(-1); // the right thumb is untouched (-1 = screen-right)
  });

  it('dead space is tracked so sliding in engages, and unknown pointers are ignored', () => {
    const t = new TouchPointers();
    t.press(LEFT_THUMB, null); // down between zones
    expect(t.steer()).toBe(0);
    expect(t.count()).toBe(1); // still down: sliding onto a zone must engage it
    t.retarget(LEFT_THUMB, 'left');
    expect(t.steer()).toBe(1);
    t.retarget(LEFT_THUMB, null);
    expect(t.steer()).toBe(0);
    // a mouse crossing with no button down, and a stray up from before the pad
    t.retarget(42, 'right');
    expect(t.steer()).toBe(0);
    t.release(42);
    expect(t.count()).toBe(1);
  });

  it('clear() releases every zone (blur / tab hide / leaving the race)', () => {
    const t = new TouchPointers();
    t.press(LEFT_THUMB, 'left');
    t.press(RIGHT_THUMB, 'right');
    t.clear();
    expect(t.count()).toBe(0);
    expect(t.steer()).toBe(0);
    expect(t.isDown('left')).toBe(false);
    expect(t.isDown('right')).toBe(false);
    // counters are genuinely zeroed: a fresh press after clear works normally
    t.press(LEFT_THUMB, 'left');
    expect(t.steer()).toBe(1);
  });
});

// ==============================================================================
// DriveController — keyboard ramp, merge, focus-loss clearing
// ==============================================================================
describe('DriveController — keyboard ramp', () => {
  it('a held key ramps to full lock over STEER_RAMP_S and release ramps back', () => {
    installFakeDom();
    const d = new DriveController(flatSlope());
    // 6 ticks at SIM_DT/30 cover 0.2 s >= STEER_RAMP_S (0.18 s): full lock
    key('keydown', 'ArrowLeft'); // screen-left = wire +1
    run(d, 3); // half the ramp: clearly steering but NOT yet full lock
    const mid = d.steerVisual();
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    run(d, 3);
    expect(d.steerVisual()).toBe(1);
    key('keyup', 'ArrowLeft');
    run(d, 2);
    expect(d.steerVisual()).toBeLessThan(1); // on its way back
    run(d, 4);
    expect(d.steerVisual()).toBe(0);
    d.dispose();
  });

  it('A/D are the same controls as the arrows, and opposing keys cancel', () => {
    installFakeDom();
    const d = new DriveController(flatSlope());
    key('keydown', 'KeyD'); // screen-right = wire -1
    run(d, 6);
    expect(d.steerVisual()).toBe(-1);
    key('keydown', 'KeyA'); // both held = straight, like both thumbs down
    run(d, 6);
    expect(d.steerVisual()).toBe(0);
    key('keyup', 'KeyA'); // lifting one steers toward the key still held
    run(d, 6);
    expect(d.steerVisual()).toBe(-1);
    d.dispose();
  });

  it('a held touch zone ramps to full lock over STEER_RAMP_S too', () => {
    const d = new DriveController(flatSlope());
    d.touch.press(LEFT_THUMB, 'right'); // right zone = screen-right = wire -1
    run(d, 3);
    expect(d.steerVisual()).toBeLessThan(0);
    expect(d.steerVisual()).toBeGreaterThan(-1);
    run(d, 3);
    expect(d.steerVisual()).toBe(-1);
    d.touch.release(LEFT_THUMB);
    run(d, 6);
    expect(d.steerVisual()).toBe(0);
  });

  it('both touch zones down holds straight through the ramp', () => {
    const d = new DriveController(flatSlope());
    d.touch.press(LEFT_THUMB, 'left');
    run(d, 6);
    expect(d.steerVisual()).toBe(1); // one thumb: full lock (+1 = screen-left)
    d.touch.press(RIGHT_THUMB, 'right');
    run(d, 6);
    expect(d.steerVisual()).toBe(0); // two thumbs: back to straight
  });

  it('REGRESSION: screen-right surfaces produce a NEGATIVE wire steer (camera looks +z, so world +x is screen-left)', () => {
    installFakeDom();
    // ArrowRight: the very first splat_input inside the ramp window is negative
    const d = new DriveController(flatSlope());
    key('keydown', 'ArrowRight');
    run(d, 1);
    const keySent = drain(d);
    expect(keySent.length).toBe(1);
    const keyMsg = keySent[0];
    expect(keyMsg).toBeDefined();
    if (keyMsg !== undefined) {
      expect(keyMsg.steer).toBeLessThan(0);
      expect(keyMsg.steer).toBeGreaterThan(-1); // still ramping, not full lock
    }
    d.dispose();
    // the right touch zone agrees, and KeyD matches ArrowRight
    const t = new DriveController(flatSlope());
    t.touch.press(RIGHT_THUMB, 'right');
    run(t, 1);
    const touchMsg = drain(t)[0];
    expect(touchMsg).toBeDefined();
    if (touchMsg !== undefined) expect(touchMsg.steer).toBeLessThan(0);
    const kd = new DriveController(flatSlope());
    key('keydown', 'KeyD');
    run(kd, 1);
    const kdMsg = drain(kd)[0];
    expect(kdMsg).toBeDefined();
    if (kdMsg !== undefined) expect(kdMsg.steer).toBeLessThan(0);
    kd.dispose();
  });
});

describe('DriveController — the additive ext-latch merge', () => {
  it('the ext latch is un-ramped and merges additively with the keyboard', () => {
    installFakeDom();
    const d = new DriveController(flatSlope());
    d.setInput(0.5); // latch speaks the screen convention: + = screen-left
    run(d, 1); // one tick: the latch applies at once, no ramp
    expect(d.steerVisual()).toBe(0.5);
    key('keydown', 'ArrowRight'); // screen-right = wire -1
    run(d, 6); // keyboard fully ramped: -1 + 0.5
    expect(d.steerVisual()).toBe(-0.5);
    d.setInput(-0.5);
    run(d, 1); // -1 + (-0.5) = -1.5, clamped
    expect(d.steerVisual()).toBe(-1);
    d.dispose();
  });

  it('clamps the merged steer at ±1 in both directions', () => {
    const d = new DriveController(flatSlope());
    d.setInput(-1);
    d.touch.press(LEFT_THUMB, 'right'); // -1 latch + -1 zone
    run(d, 6);
    expect(d.steerVisual()).toBe(-1); // -1 + -1 clamps, not -2
    d.setInput(1);
    run(d, 1);
    expect(d.steerVisual()).toBe(0); // 1 + (-1) cancels
    d.setInput(1);
    d.touch.press(RIGHT_THUMB, 'left'); // both zones now: touch steers 0, ext drives +1
    run(d, 6);
    expect(d.steerVisual()).toBe(1);
    // and the wire value is clamped too
    const sent = drain(d);
    for (const m of sent) {
      expect(m.steer).toBeGreaterThanOrEqual(-1);
      expect(m.steer).toBeLessThanOrEqual(1);
    }
  });

  it('a non-finite latch reads as neutral instead of poisoning the wire', () => {
    const d = new DriveController(flatSlope());
    d.setInput(Number.NaN);
    run(d, 3);
    expect(d.steerVisual()).toBe(0);
    const sent = drain(d);
    for (const m of sent) expect(Number.isFinite(m.steer)).toBe(true);
  });
});

describe('DriveController — focus loss clears held input', () => {
  it('blur: steering returns to neutral and no zone stays latched', () => {
    installFakeDom();
    const d = new DriveController(flatSlope());
    key('keydown', 'ArrowLeft');
    d.touch.press(LEFT_THUMB, 'right');
    run(d, 6); // key fully left, thumb fully right — they cancel by accident...
    key('keyup', 'ArrowLeft');
    run(d, 6);
    expect(d.steerVisual()).toBe(-1); // ...so now the thumb alone drives full right
    fakeWindow.fire('blur', {});
    expect(d.touch.isDown('right')).toBe(false); // no thumb stays latched
    run(d, 6);
    expect(d.steerVisual()).toBe(0); // and the ramp drains to neutral
    d.dispose();
  });

  it('visibilitychange to hidden clears; a visible change does not', () => {
    installFakeDom();
    const d = new DriveController(flatSlope());
    key('keydown', 'ArrowRight');
    fakeDocument.hidden = false;
    fakeDocument.fire('visibilitychange', {}); // spurious event while visible
    run(d, 6);
    expect(d.steerVisual()).toBe(-1); // key still held: full lock reached (-1 = screen-right)
    fakeDocument.hidden = true; // tab hidden mid-press: keyup may never arrive
    fakeDocument.fire('visibilitychange', {});
    run(d, 6);
    expect(d.steerVisual()).toBe(0);
    d.dispose();
  });

  it('dispose() removes every listener it registered', () => {
    installFakeDom();
    const d = new DriveController(flatSlope());
    expect(fakeWindow.listenerCount('keydown')).toBe(1);
    expect(fakeDocument.listenerCount('visibilitychange')).toBe(1);
    d.dispose();
    expect(fakeWindow.listenerCount('keydown')).toBe(0);
    expect(fakeWindow.listenerCount('keyup')).toBe(0);
    expect(fakeWindow.listenerCount('blur')).toBe(0);
    expect(fakeDocument.listenerCount('visibilitychange')).toBe(0);
  });
});

// ==============================================================================
// DriveController — the wire: one splat_input per SIM_DT, monotonic seq
// ==============================================================================
describe('DriveController — step / flush', () => {
  it('emits exactly one splat_input per SIM_DT with a monotonic seq', () => {
    const d = new DriveController(flatSlope());
    d.step(100); // 100 ms = 3 SIM_DT ticks
    const sent = drain(d);
    expect(sent.length).toBe(3);
    expect(sent.map((m) => m.seq)).toEqual([1, 2, 3]);
    for (const m of sent) {
      expect(m.t).toBe('splat_input');
      expect(m.dt).toBe(SIM_DT);
      expect(m.steer).toBe(0);
    }
    expect(d.seqNo()).toBe(3);
    d.step(100); // 3 more: the seq keeps climbing across frames
    const more = drain(d);
    expect(more.map((m) => m.seq)).toEqual([4, 5, 6]);
  });

  it('a sub-tick step emits nothing and the remainder carries over', () => {
    const d = new DriveController(flatSlope());
    d.step(10); // 10 ms < SIM_DT: no tick yet
    expect(drain(d).length).toBe(0);
    d.step(FRAME_MS); // 10 + 33.3 ms crosses one boundary
    expect(drain(d).length).toBe(1);
  });

  it('flush drains the outbox: a second flush sends nothing', () => {
    const d = new DriveController(flatSlope());
    d.step(100);
    let n = 0;
    expect(d.flush(() => { n++; })).toBe(3);
    expect(n).toBe(3);
    expect(d.flush(() => { n++; })).toBe(0);
    expect(n).toBe(3);
  });

  it('a non-positive dt is ignored (rAF hitch guard)', () => {
    const d = new DriveController(flatSlope());
    d.step(0);
    d.step(-50);
    d.step(Number.NaN);
    expect(drain(d).length).toBe(0);
  });

  it('reset() re-bases the predictor, drops the outbox and centres the skis', () => {
    const d = new DriveController(flatSlope());
    d.setInput(1);
    run(d, 6);
    d.reset(4.5, -3, 0.1);
    const s = d.state();
    expect(s.x).toBe(4.5);
    expect(s.z).toBe(-3);
    expect(s.yaw).toBe(0.1);
    expect(d.pending()).toBe(0);
    expect(d.steerVisual()).toBe(0); // neutral skis on the grid
    expect(drain(d).length).toBe(0); // pre-reset intent died with the old skier
  });
});

// ==============================================================================
// DriveController — ASSIST MODE
// ==============================================================================
describe('DriveController — assist mode', () => {
  it('the EMA smooths: a full-scale jump moves the wire steer by at most ASSIST_STEER_EMA * error', () => {
    const d = new DriveController(flatSlope());
    d.setAssist(true);
    d.setInput(1);
    run(d, 1);
    expect(d.steerVisual()).toBeCloseTo(ASSIST_STEER_EMA, 10); // one EMA step from 0
    const before = d.steerVisual();
    d.setInput(-1); // a full-scale reversal in one tick
    run(d, 1);
    // narrowed max steer rate: |Δ| = ASSIST_STEER_EMA * |target - current| <= 2 * EMA
    expect(Math.abs(d.steerVisual() - before)).toBeLessThanOrEqual(2 * ASSIST_STEER_EMA + 1e-12);
    // the same reversal without assist would have jumped the full 2.0
    const raw = new DriveController(flatSlope());
    raw.setInput(1);
    run(raw, 1);
    raw.setInput(-1);
    run(raw, 1);
    expect(raw.steerVisual()).toBe(-1);
  });

  it('a square-wave input never reaches full lock under assist, and the wire carries the smoothed value', () => {
    const d = new DriveController(flatSlope());
    d.setAssist(true);
    for (let i = 0; i < 40; i++) {
      d.setInput(i % 2 === 0 ? 1 : -1);
      run(d, 1);
    }
    // steady-state EMA amplitude for a ±1 square wave is a/(2-a) ≈ 0.21
    expect(Math.abs(d.steerVisual())).toBeLessThan(0.3);
    const sent = drain(d);
    expect(sent.length).toBe(40);
    const last = sent[sent.length - 1];
    expect(last).toBeDefined();
    if (last !== undefined) {
      expect(last.steer).toBeCloseTo(d.steerVisual(), 10); // wire = smoothed value
      expect(Math.abs(last.steer)).toBeLessThan(0.3); // never the raw ±1
    }
  });

  it('setAssist forwards to the predictor: the plant contact radius shrinks in the sim', () => {
    // One bush beside the fall line: close enough to touch at the normal
    // radius (0.75 + 0.5 = 1.25 m) but not at the assist radius (x0.8 = 1.1 m).
    const plant: Plant = { x: 1.18, z: 30, r: 0.75, kind: 'bush' };
    const slope = flatSlope([plant]);
    const plain = new DriveController(slope);
    run(plain, 180); // 6 s of fall-line descent: z crosses 30 m
    expect(plain.state().lastPlantIx).toBe(0); // contact, unassisted
    const assisted = new DriveController(slope);
    assisted.setAssist(true); // the predictor's assist flag flips with it
    run(assisted, 180);
    expect(assisted.state().lastPlantIx).toBe(-1); // the assist radius misses
  });
});

// ==============================================================================
// DriveController — reconcile
// ==============================================================================
describe('DriveController — reconcile', () => {
  it('converges: in-order acks of the same input stream correct ~0 m', () => {
    const slope = flatSlope();
    const d = new DriveController(slope);
    d.setInput(0.4);
    run(d, 6);
    const sent = drain(d);
    // the server integrates the IDENTICAL inputs through the IDENTICAL stepSki
    const server = makeSim(0, 0, 0);
    for (const m of sent) stepSki(server, m.steer, m.dt, slope);
    const last = sent[sent.length - 1];
    expect(last).toBeDefined();
    if (last === undefined) return;
    const corr = d.reconcile(server, last.seq);
    expect(corr).toBeLessThan(1e-9); // prediction == server: no tug
    expect(d.pending()).toBe(0); // everything acked
    expect(d.lastCorrection()).toBe(corr);
  });

  it('replays unacked inputs after a server correction and absorbs the jump visually', () => {
    const slope = flatSlope();
    const d = new DriveController(slope);
    d.setInput(0.6);
    run(d, 6); // 6 inputs, seqs 1..6
    const sent = drain(d);
    expect(sent.length).toBe(6);
    // the server consumed only the first 3, then DIVERGED (a plant hit it and
    // the prediction did not): server-side state is 0.5 m off the fall line
    const server = makeSim(0, 0, 0);
    for (let i = 0; i < 3; i++) {
      const m = sent[i];
      if (m !== undefined) stepSki(server, m.steer, m.dt, slope);
    }
    server.x += 0.5;
    const ack = sent[2];
    expect(ack).toBeDefined();
    if (ack === undefined) return;
    const corr = d.reconcile(server, ack.seq);
    expect(corr).toBeGreaterThan(0); // a real correction happened
    expect(d.pending()).toBe(3); // inputs 4..6 survived and were replayed
    // the jump went into the visual error offset, not onto the screen...
    const errBefore = Math.hypot(d.errorX(), d.errorZ());
    expect(errBefore).toBeGreaterThan(0.4);
    // ...and the offset decays back to nothing over the next frames
    run(d, 12); // 0.4 s: several ERR_TAU_S (~0.12 s) time constants
    expect(Math.hypot(d.errorX(), d.errorZ())).toBeLessThan(errBefore * 0.1);
  });

  it('a teleport-scale correction snaps honestly instead of smoothing', () => {
    const d = new DriveController(flatSlope());
    run(d, 6);
    const far = makeSim(100, 500, 0); // a grid wipe / desync, not a nudge
    const corr = d.reconcile(far, 999);
    expect(corr).toBeGreaterThan(8); // past ERR_SNAP_M
    expect(d.errorX()).toBe(0); // no offset: the skier IS somewhere else now
    expect(d.errorZ()).toBe(0);
    expect(d.state().x).toBe(100);
    expect(d.state().z).toBe(500);
  });
});
