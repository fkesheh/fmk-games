// ============================================================================
// input.ts unit tests — headless by design: every case drives the @internal
// handlers directly (handleKeyDown/handleKeyUp/handleBlur/handleMouseMove/
// forceLockState) instead of dispatching real DOM events, and fakes the
// Gamepad API by monkey-patching navigator.getGamepads in the node env.
// Deterministic dt comes from spying on performance.now (the hub's own clock).
//
// Harness notes
// -------------
// - No jsdom here (vitest.config.ts runs this file under the node env), so
//   `navigator` may not exist at all (older Node) or may exist WITHOUT
//   getGamepads (Node ≥21's Web globals). installPads() below handles both:
//   it creates a throwaway navigator when missing and always restores the
//   previous property state afterwards so nothing leaks to sibling files in
//   the same worker.
// - The hub is constructed with a null canvas: pointer lock must reject, and
//   everything else must work untouched (that IS part of the contract).
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_KEY_BINDINGS,
  DEFAULT_PAD_BINDINGS,
  MOUSE_SENSITIVITY,
  GameInputHub,
} from './input.js';

// ---- fake Gamepad API ---------------------------------------------------------

interface NavLike {
  getGamepads?: () => Array<Gamepad | null>;
}

const g = globalThis as { navigator?: NavLike };

let createdNavigator = false;
let savedGetGamepads: PropertyDescriptor | undefined;

function installPads(pads: Array<Gamepad | null>): void {
  const nav = g.navigator as NavLike | undefined;
  if (!nav) throw new Error('installPads: navigator was not prepared');
  nav.getGamepads = () => pads;
}

function makeButton(pressed: boolean, value = pressed ? 1 : 0): { pressed: boolean; value: number } {
  return { pressed, value };
}

/** Minimal standard-mapping pad; cast keeps the test free of DOM runtime. */
function fakePad(
  axes: number[],
  buttons: Array<{ pressed: boolean; value: number }> = [],
  index = 0,
): Gamepad {
  return {
    id: 'test-pad',
    index,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes,
    buttons,
    vibrationActuator: null,
  } as unknown as Gamepad;
}

// ---- clock ---------------------------------------------------------------------

let fakeNowMs = 0;

function advanceMs(delta: number): void {
  fakeNowMs += delta;
}

beforeEach(() => {
  // prepare the global navigator slot BEFORE any hub touches it
  if (!g.navigator) {
    createdNavigator = true;
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: {} as NavLike,
        configurable: true,
        writable: true,
      });
    } catch {
      // extremely old Node without a configurable global — pad tests will skip
    }
  }
  const nav = g.navigator as NavLike | undefined;
  savedGetGamepads = nav ? Object.getOwnPropertyDescriptor(nav, 'getGamepads') : undefined;

  fakeNowMs = 1_000_000;
  vi.spyOn(performance, 'now').mockImplementation(() => fakeNowMs);
});

afterEach(() => {
  const nav = g.navigator as NavLike | undefined;
  if (nav) {
    if (savedGetGamepads) Object.defineProperty(nav, 'getGamepads', savedGetGamepads);
    else delete nav.getGamepads;
  }
  if (createdNavigator) {
    try {
      Reflect.deleteProperty(globalThis, 'navigator');
    } catch {
      // leave the placeholder rather than break sibling suites
    }
  }
  createdNavigator = false;
  savedGetGamepads = undefined;
  vi.restoreAllMocks();
});

// ---- helpers -------------------------------------------------------------------

/** Prime the hub's internal clock: the FIRST frame() always reports dt=0
    (contract), so tests advance the fake clock explicitly after this. */
function primedHub(canvas: HTMLElement | null = null): GameInputHub {
  const hub = new GameInputHub(canvas);
  hub.frame();
  return hub;
}

describe('defaults (frozen house bindings)', () => {
  it('expose the documented WASD/arrows table and pad tuning', () => {
    expect(DEFAULT_KEY_BINDINGS.forward).toContain('KeyW');
    expect(DEFAULT_KEY_BINDINGS.actions[0]).toEqual({ bit: 0, keys: ['Space'] });
    expect(DEFAULT_PAD_BINDINGS.stickDeadzone).toBe(0.15);
    expect(DEFAULT_PAD_BINDINGS.lookSpeedRadPerSec).toBe(2.6);
    expect(MOUSE_SENSITIVITY).toBe(0.0022);
  });
});

describe('keyboard merge', () => {
  it('maps WASD onto moveZ/moveX with opposite keys cancelling', () => {
    const hub = primedHub();
    hub.handleKeyDown('KeyW');
    expect(hub.frame()).toMatchObject({ moveZ: 1, moveX: 0 });
    hub.handleKeyDown('KeyS'); // forward+back cancel
    expect(hub.frame()).toMatchObject({ moveZ: 0 });
    hub.handleKeyUp('KeyW');
    hub.handleKeyUp('KeyS');
    hub.handleKeyDown('KeyA');
    hub.handleKeyDown('KeyD'); // strafe cancels too
    expect(hub.frame()).toMatchObject({ moveX: 0 });
    hub.handleKeyUp('KeyA');
    expect(hub.frame()).toMatchObject({ moveX: 1 }); // KeyD still held
  });

  it('merges action bits into the uint32 mask (Space→0, Shift→1)', () => {
    const hub = primedHub();
    hub.handleKeyDown('Space');
    hub.handleKeyDown('ShiftRight');
    expect(hub.frame().buttons).toBe((1 << 0) | (1 << 1));
  });

  it('honors overridden bindings and ignores the old ones', () => {
    const hub = primedHub();
    hub.setKeyBindings({
      left: ['KeyQ'],
      right: [],
      forward: [],
      back: [],
      actions: [{ bit: 7, keys: ['KeyF'] }],
    });
    hub.handleKeyDown('KeyA');
    expect(hub.frame().moveX).toBe(0); // A no longer bound
    hub.handleKeyDown('KeyQ');
    expect(hub.frame().moveX).toBe(-1);
    hub.handleKeyDown('KeyF');
    expect(hub.frame().buttons).toBe(1 << 7);
  });
});

describe('edge queue semantics', () => {
  it('queues press/release once per transition and drains fully', () => {
    const hub = primedHub();
    hub.handleKeyDown('Space');
    expect(hub.edges()).toEqual([{ kind: 'press', bit: 0 }]);
    expect(hub.edges()).toEqual([]); // drained — second call sees nothing
    hub.handleKeyDown('Space'); // OS key-repeat: no duplicate edge
    expect(hub.edges()).toEqual([]);
    hub.handleKeyUp('Space');
    expect(hub.edges()).toEqual([{ kind: 'release', bit: 0 }]);
  });

  it('multi-key action bits release only after the LAST key lifts', () => {
    const hub = primedHub();
    hub.handleKeyDown('ShiftLeft');
    hub.handleKeyDown('ShiftRight');
    expect(hub.edges()).toEqual([{ kind: 'press', bit: 1 }]);
    hub.handleKeyUp('ShiftLeft');
    expect(hub.edges()).toEqual([]); // ShiftRight still holds bit 1
    hub.handleKeyUp('ShiftRight');
    expect(hub.edges()).toEqual([{ kind: 'release', bit: 1 }]);
  });

  it('movement keys never produce edges', () => {
    const hub = primedHub();
    hub.handleKeyDown('KeyW');
    hub.handleKeyDown('KeyA');
    hub.handleKeyUp('KeyW');
    hub.handleKeyUp('KeyA');
    expect(hub.edges()).toEqual([]);
  });
});

describe('blur reset', () => {
  it('clears all held state and emits release edges for held action bits', () => {
    const hub = primedHub();
    hub.handleKeyDown('KeyW');
    hub.handleKeyDown('KeyA');
    hub.handleKeyDown('Space');
    hub.handleKeyDown('ShiftLeft');
    expect(hub.edges()).toEqual([ // drain the presses so only blur's releases remain
      { kind: 'press', bit: 0 },
      { kind: 'press', bit: 1 },
    ]);

    hub.handleBlur();

    const f = hub.frame();
    expect(f.moveX).toBe(0);
    expect(f.moveZ).toBe(0);
    expect(f.buttons).toBe(0);
    expect(hub.edges()).toEqual([
      { kind: 'release', bit: 0 },
      { kind: 'release', bit: 1 },
    ]);
    hub.handleKeyDown('KeyW'); // keyboard works again afterwards
    expect(hub.frame().moveZ).toBe(1);
  });
});

describe('gamepad merge', () => {
  it('drives moveX/moveZ from the left stick with full deflection', () => {
    installPads([fakePad([1, 0, 0, 0])]);
    const hub = primedHub();
    expect(hub.frame()).toMatchObject({ moveX: 1, moveZ: 0 });
    installPads([fakePad([0, -1, 0, 0])]); // ly negative = stick up = forward
    expect(hub.frame()).toMatchObject({ moveX: 0, moveZ: 1 });
  });

  it('applies a radial deadzone with full-range rescale outside it', () => {
    installPads([fakePad([0.1, 0, 0, 0])]); // |v| < 0.15 → silent
    const hub = primedHub();
    expect(hub.frame().moveX).toBe(0);

    installPads([fakePad([0.575, 0, 0, 0])]); // (0.575-.15)/(1-.15) = 0.5 exactly
    expect(hub.frame().moveX).toBeCloseTo(0.5, 6);

    installPads([fakePad([0.1, 0.1, 0, 0])]); // diagonal magnitude ≈0.141 < dz
    const f = hub.frame();
    expect(f.moveX).toBe(0);
    expect(f.moveZ).toBe(0);
  });

  it('accumulates right-stick look deltas at lookSpeed·dt and resets per frame', () => {
    installPads([fakePad([0, 0, 1, 0])]); // pure +x: |(1,0)|=1 → rescale factor is exactly 1
    const hub = primedHub();
    advanceMs(100); // dt = 0.1s
    const f = hub.frame();
    expect(f.lookDX).toBeCloseTo(DEFAULT_PAD_BINDINGS.lookSpeedRadPerSec * 0.1, 6);
    expect(f.lookDY).toBe(0);
    const f2 = hub.frame(); // no time passed → dt 0 → fresh deltas are zero
    expect(f2.lookDX).toBe(0);
    expect(f2.lookDY).toBe(0);

    installPads([fakePad([0, 0, 0, 1])]); // now pitch
    advanceMs(100);
    const f3 = hub.frame();
    expect(f3.lookDX).toBe(0);
    expect(f3.lookDY).toBeCloseTo(DEFAULT_PAD_BINDINGS.lookSpeedRadPerSec * 0.1, 6);
  });

  it('clamps dt after an unrealistic gap (tab switch)', () => {
    installPads([fakePad([0, 0, 1, 0])]);
    const hub = primedHub();
    advanceMs(60_000); // one minute away
    const f = hub.frame();
    expect(Math.abs(f.lookDX)).toBeLessThanOrEqual(DEFAULT_PAD_BINDINGS.lookSpeedRadPerSec * 0.25 + 1e-9);
  });

  it('maps standard buttons through buttonMap into bits + press/release edges', () => {
    // DEFAULT buttonMap: from 0→bit0, from 1→bit2, from 2→bit3, from 5→bit1
    installPads([fakePad([], [makeButton(false)])]);
    const hub = primedHub();
    expect(hub.edges()).toEqual([]);

    installPads([fakePad([], [makeButton(true), makeButton(false), makeButton(false), makeButton(false), makeButton(false), makeButton(true)])]);
    let f = hub.frame();
    expect(f.buttons).toBe((1 << 0) | (1 << 1)); // A + RB
    expect(hub.edges()).toEqual([
      { kind: 'press', bit: 0 },
      { kind: 'press', bit: 1 },
    ]);

    f = hub.frame(); // no transitions → no edges
    expect(f.buttons).toBe((1 << 0) | (1 << 1));
    expect(hub.edges()).toEqual([]);

    installPads([fakePad([], [makeButton(false), makeButton(false), makeButton(false), makeButton(false), makeButton(false), makeButton(true)])]);
    f = hub.frame(); // only A released
    expect(f.buttons).toBe(1 << 1);
    expect(hub.edges()).toEqual([{ kind: 'release', bit: 0 }]);
  });

  it('counts analog value > 0.5 as pressed even when pressed=false', () => {
    installPads([fakePad([], [])]);
    const hub = primedHub();
    installPads([fakePad([], Array.from({ length: 3 }, (_, i) => (i === 2 ? makeButton(false, 0.9) : makeButton(false))))]);
    expect(hub.frame().buttons).toBe(1 << 3); // from:2 → bit:3
  });

  it('ORs keyboard and pad bits for the same position', () => {
    installPads([fakePad([], [makeButton(true)])]);
    const hub = primedHub();
    hub.handleKeyDown('Space');
    expect(hub.frame().buttons).toBe(1 << 0);
    hub.handleKeyUp('Space'); // pad still holds bit 0
    expect(hub.frame().buttons).toBe(1 << 0);
    installPads([null]);
    expect(hub.frame().buttons).toBe(0);
  });
});

describe('pad connectivity', () => {
  it('starts false, tracks the poll, and survives event hooks', () => {
    installPads([null]);
    const hub = primedHub();
    expect(hub.padConnected()).toBe(false);

    installPads([fakePad([0, 0, 0, 0])]);
    hub.frame();
    expect(hub.padConnected()).toBe(true);

    hub.handlePadConnected(); // event hook keeps it sticky between frames
    expect(hub.padConnected()).toBe(true);

    installPads([fakePad([0, 0, 0, 0], [], 1)]);
    hub.frame();
    expect(hub.padConnected()).toBe(true);

    installPads([]);
    hub.frame();
    expect(hub.padConnected()).toBe(false);
  });

  it('emits release edges when the last pad vanishes mid-button-hold', () => {
    installPads([fakePad([], [makeButton(true)])]);
    const hub = primedHub();
    hub.frame();
    expect(hub.edges()).toEqual([{ kind: 'press', bit: 0 }]);

    installPads([]);
    hub.handlePadDisconnected();
    expect(hub.padConnected()).toBe(false);
    expect(hub.edges()).toEqual([{ kind: 'release', bit: 0 }]);
    expect(hub.frame().buttons).toBe(0);
  });
});

describe('pointer-lock mouse look', () => {
  it('rejects without a canvas', async () => {
    const hub = primedHub();
    await expect(hub.requestPointerLock()).rejects.toThrow(/canvas/i);
  });

  it('accumulates mouse deltas at 0.0022 rad/px only while locked', () => {
    const hub = primedHub();
    hub.handleMouseMove(100, -50); // locked() === false → ignored
    expect(hub.frame().lookDX).toBe(0);

    const seen: boolean[] = [];
    hub.onLockChange = (locked) => seen.push(locked);
    hub.forceLockState(true);
    expect(hub.locked()).toBe(true);
    expect(seen).toEqual([true]);

    hub.handleMouseMove(100, -50);
    const f = hub.frame();
    expect(f.lookDX).toBeCloseTo(100 * MOUSE_SENSITIVITY, 9);
    expect(f.lookDY).toBeCloseTo(-50 * MOUSE_SENSITIVITY, 9);
    expect(hub.frame().lookDX).toBe(0); // drained by the previous frame()

    hub.forceLockState(false);
    expect(seen).toEqual([true, false]);
    hub.handleMouseMove(999, 999); // unlocked again → ignored
    expect(hub.frame().lookDX).toBe(0);
  });
});

describe('frame object stability', () => {
  it('returns THE SAME mutated object every call', () => {
    const hub = primedHub();
    const a = hub.frame();
    const b = hub.frame();
    expect(a).toBe(b);
    hub.handleKeyDown('KeyW');
    hub.frame();
    expect(a.moveZ).toBe(1); // mutated in place, not replaced
  });
});

describe('start()/stop() lifecycle (headless-safe)', () => {
  it('stop() detaches and wipes transient state without throwing in node', () => {
    const hub = primedHub();
    hub.start(); // no window/document here — guards must keep this inert
    hub.stop();
    hub.start(); // restartable
    hub.stop();
    expect(hub.frame()).toMatchObject({ moveX: 0, moveZ: 0, lookDX: 0, lookDY: 0, buttons: 0 });
    expect(hub.edges()).toEqual([]);
  });

  it('touch config is accepted headlessly and never builds DOM in node', () => {
    const hub = primedHub();
    expect(() =>
      hub.setTouch({ enabled: true, actions: [{ bit: 4, label: 'BOOST' }] }),
    ).not.toThrow();
    expect(hub.frame()).toMatchObject({ moveX: 0, moveZ: 0, buttons: 0 });
  });
});
