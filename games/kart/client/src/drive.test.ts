// ============================================================================
// drive.test.ts — the tablet control surface's correctness rules.
//
// Two things are proven here, and both are about a player who cannot tell you
// what went wrong:
//
// 1. TouchPointers: multi-touch bookkeeping by pointerId. Every case below is a
//    real thing two thumbs do in one lap, and every one of them produces STUCK
//    STEERING under the naive "one touch" handling this class exists to
//    replace.
// 2. The KIDS MODE touch nudge in DriveController: a held steering zone biases
//    the auto-steer, and — the part that must never rot — latching NO touch
//    steer leaves the assist bit-for-bit what it was before the pad existed.
//
// Node environment: TouchPointers has no DOM in it at all, and DriveController
// only touches `window` behind a typeof guard, so both run headless.
// ============================================================================
import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACK_ID, SIM_DT, TRACKS, buildTrack, gridSlot } from '@kart/shared';
import type { KartInput, TrackDef } from '@kart/shared';
import { DriveController, TOUCH_CONTROLS, TouchPointers } from './drive.js';

const LEFT_THUMB = 1; // pointerId — the ids are arbitrary and deliberately not 0/1-ordered
const RIGHT_THUMB = 7;

function input(partial: Partial<KartInput>): KartInput {
  return { throttle: 0, brake: 0, steer: 0, drift: false, ...partial };
}

describe('TouchPointers — multi-touch by pointerId', () => {
  it('steers toward the single held zone', () => {
    const t = new TouchPointers();
    t.press(LEFT_THUMB, 'left');
    expect(t.steer()).toBe(-1);
    t.release(LEFT_THUMB);
    expect(t.steer()).toBe(0);
    t.press(RIGHT_THUMB, 'right');
    expect(t.steer()).toBe(1);
  });

  it('both thumbs down at once reads straight', () => {
    const t = new TouchPointers();
    t.press(LEFT_THUMB, 'left');
    t.press(RIGHT_THUMB, 'right');
    expect(t.steer()).toBe(0);
    expect(t.count()).toBe(2);
  });

  it('lifting one thumb steers toward the thumb still held, not neutral', () => {
    const t = new TouchPointers();
    t.press(LEFT_THUMB, 'left');
    t.press(RIGHT_THUMB, 'right');
    t.release(RIGHT_THUMB);
    expect(t.steer()).toBe(-1); // the left thumb never lifted — it must still steer left
    t.press(RIGHT_THUMB, 'right');
    t.release(LEFT_THUMB);
    expect(t.steer()).toBe(1);
  });

  it('a thumb sliding from one zone into the other switches sides cleanly', () => {
    const t = new TouchPointers();
    t.press(LEFT_THUMB, 'left');
    t.retarget(LEFT_THUMB, 'right');
    expect(t.steer()).toBe(1);
    expect(t.isDown('left')).toBe(false); // the zone it left must not stay latched
    expect(t.count()).toBe(1); // and it is still ONE finger, not two
  });

  it('pointercancel mid-press releases exactly like a lift', () => {
    const t = new TouchPointers();
    t.press(LEFT_THUMB, 'left');
    t.press(RIGHT_THUMB, 'gas');
    // the system takes the steering pointer away (notification, app switch,
    // palm rejection): release() is what pointercancel calls
    t.release(LEFT_THUMB);
    expect(t.steer()).toBe(0);
    expect(t.isDown('left')).toBe(false);
    expect(t.isDown('gas')).toBe(true); // ...and the other thumb is untouched
  });

  it('a thumb sliding off accelerate onto nitro does not leave accelerate latched', () => {
    const t = new TouchPointers();
    t.press(RIGHT_THUMB, 'gas');
    expect(t.isDown('gas')).toBe(true);
    t.retarget(RIGHT_THUMB, 'nitro');
    expect(t.isDown('gas')).toBe(false);
    expect(t.isDown('nitro')).toBe(true);
  });

  it('a thumb sliding off a button into dead space releases it but stays tracked', () => {
    const t = new TouchPointers();
    t.press(RIGHT_THUMB, 'gas');
    t.retarget(RIGHT_THUMB, null);
    expect(t.isDown('gas')).toBe(false);
    expect(t.count()).toBe(1); // still down: sliding back must re-engage
    t.retarget(RIGHT_THUMB, 'gas');
    expect(t.isDown('gas')).toBe(true);
    t.release(RIGHT_THUMB);
    expect(t.count()).toBe(0);
  });

  it('reports the fresh-press edge once per control (the nitro trigger)', () => {
    const t = new TouchPointers();
    expect(t.press(RIGHT_THUMB, 'nitro')).toBe(true);
    expect(t.press(LEFT_THUMB, 'nitro')).toBe(false); // second finger: already engaged, no new edge
    t.release(RIGHT_THUMB);
    expect(t.isDown('nitro')).toBe(true); // one finger left on it
    t.release(LEFT_THUMB);
    expect(t.isDown('nitro')).toBe(false);
    expect(t.press(RIGHT_THUMB, 'nitro')).toBe(true); // engaged again => a new edge
  });

  it('two thumbs on one zone survive one of them lifting', () => {
    const t = new TouchPointers();
    t.press(LEFT_THUMB, 'left');
    t.press(RIGHT_THUMB, 'left');
    t.release(LEFT_THUMB);
    expect(t.steer()).toBe(-1); // still one finger on it
    t.release(RIGHT_THUMB);
    expect(t.steer()).toBe(0);
  });

  it('ignores moves and releases for pointers it never saw go down', () => {
    const t = new TouchPointers();
    // a mouse crossing the pad with no button down, and a stray up from a
    // pointer that went down before the pad existed
    expect(t.retarget(42, 'right')).toBe(false);
    expect(t.steer()).toBe(0);
    t.release(42);
    expect(t.count()).toBe(0);
  });

  it('clear() releases every control (blur / tab hide / leaving the race)', () => {
    const t = new TouchPointers();
    t.press(LEFT_THUMB, 'left');
    t.press(RIGHT_THUMB, 'gas');
    t.press(9, 'drift');
    t.clear();
    expect(t.count()).toBe(0);
    expect(t.steer()).toBe(0);
    for (const c of TOUCH_CONTROLS) expect(t.isDown(c)).toBe(false);
    // and the counters are genuinely zeroed, not merely emptied of ids:
    // a fresh press after a clear must read as a fresh edge
    expect(t.press(LEFT_THUMB, 'drift')).toBe(true);
  });
});

describe('DriveController — the stuck auto-respawn guard', () => {
  const track: TrackDef = buildTrack(TRACKS[DEFAULT_TRACK_ID]);

  /**
   * Hold the kart at a standstill under throttle for `secs` of SIM time and
   * report whether a respawn ever rode the input stream. Throttle AND brake
   * together is a standstill the sim reaches from a legal input pair — the
   * same condition a kart buried nose-first in a barrier is in (throttle held,
   * speed pinned at ~0), without needing a barrier in a unit test.
   */
  function respawnedWhilePinned(configure: (d: DriveController) => void, secs: number): boolean {
    const d = new DriveController(track);
    const g = gridSlot(track, 0);
    d.reset(g.x, g.z, g.yaw);
    configure(d);
    d.setInput(input({ throttle: 1, brake: 1 }));
    let sawRespawn = false;
    const ticks = Math.round(secs / SIM_DT);
    for (let i = 0; i < ticks; i++) {
      d.step(SIM_DT);
      d.flush((m) => {
        if (m.t === 'kart_input' && m.respawn) sawRespawn = true;
      });
    }
    return sawRespawn;
  }

  it('recovers a TABLET player with no assist (no brake, no reverse, no R key)', () => {
    expect(respawnedWhilePinned((d) => d.setStuckGuard(true), 4)).toBe(true);
  });

  it('still recovers a KIDS MODE player (the original behaviour, untouched)', () => {
    expect(respawnedWhilePinned((d) => d.setAssist(true), 4)).toBe(true);
  });

  it('never fires for a keyboard player — they have R, and a surprise teleport is worse', () => {
    expect(respawnedWhilePinned(() => undefined, 6)).toBe(false);
  });

  it('does not fire before the shared hold time is up', () => {
    // STUCK_HOLD_S is 2.5 sim-s: a two-second scrape must not teleport anyone
    expect(respawnedWhilePinned((d) => d.setStuckGuard(true), 2)).toBe(false);
  });

  it('leaving tablet mode drops a part-run stuck timer instead of carrying it', () => {
    const d = new DriveController(track);
    const g = gridSlot(track, 0);
    d.reset(g.x, g.z, g.yaw);
    d.setStuckGuard(true);
    d.setInput(input({ throttle: 1, brake: 1 }));
    for (let i = 0; i < Math.round(2 / SIM_DT); i++) d.step(SIM_DT); // 2s of the 2.5s hold
    d.setStuckGuard(false);
    d.setStuckGuard(true);
    let sawRespawn = false;
    for (let i = 0; i < Math.round(1 / SIM_DT); i++) {
      d.step(SIM_DT); // 1 more second: enough only if the old timer survived
      d.flush((m) => {
        if (m.t === 'kart_input' && m.respawn) sawRespawn = true;
      });
    }
    expect(sawRespawn).toBe(false);
  });
});

describe('DriveController — KIDS MODE touch nudge', () => {
  const track: TrackDef = buildTrack(TRACKS[DEFAULT_TRACK_ID]);

  /** A controller sat on grid slot 0 with the assist on, ready to tick. */
  function assisted(ext: KartInput | null): DriveController {
    const d = new DriveController(track);
    const g = gridSlot(track, 0);
    d.reset(g.x, g.z, g.yaw);
    d.setAssist(true);
    if (ext !== null) d.setInput(ext);
    return d;
  }

  it('is a NO-OP when no touch steer is latched (keyboard kids mode is unchanged)', () => {
    const plain = assisted(null);
    const zeroed = assisted(input({ throttle: 1 })); // e2e latches (1,0,0,false)
    plain.step(SIM_DT);
    zeroed.step(SIM_DT);
    // identical to the bit: the nudge term is `ext.steer * k` and ext.steer is 0
    expect(zeroed.state().steer).toBe(plain.state().steer);
  });

  it('a held steering zone biases the auto-steer toward that side', () => {
    const plain = assisted(null);
    const right = assisted(input({ steer: 1 }));
    const left = assisted(input({ steer: -1 }));
    plain.step(SIM_DT);
    right.step(SIM_DT);
    left.step(SIM_DT);
    const base = plain.state().steer;
    expect(right.state().steer).toBeGreaterThan(base);
    expect(left.state().steer).toBeLessThan(base);
  });

  it('cannot be pushed past full lock, so the assist always out-pulls a held thumb', () => {
    // pursuitSteer saturates at ±1; the nudge is < 1, so a thumb held forever
    // still loses to a saturated correction — the kart cannot be steered off
    // the road by holding a zone.
    for (const s of [-1, -0.5, 0, 0.5, 1]) {
      const d = assisted(input({ steer: s, throttle: 1 }));
      for (let i = 0; i < 60; i++) d.step(SIM_DT); // 2 sim-seconds of holding
      const steer = d.state().steer;
      expect(steer).toBeGreaterThanOrEqual(-1);
      expect(steer).toBeLessThanOrEqual(1);
    }
  });
});
