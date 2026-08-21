// ============================================================================
// SDK INPUT — InputHub merging keyboard + Gamepad API + local touch overlay
// into ONE stable normalized frame (docs/PLATFORM.md §4.4/§4.5). Physical
// pads never touch the network; phone pads are a separate relay (rooms).
//
// Headless-first design: every browser dependency (window/document/navigator/
// matchMedia) is guarded, and the constructor canvas param may be null — the
// merge core is drivable by calling the @internal handlers directly, which is
// exactly how the unit tests exercise it without a real DOM.
// Owner: P7_SDK_INPUT_AUDIO.
// ============================================================================

import type { InputEdge, InputFrame, InputHub, KeyBindings, PadBindings, TouchOpts } from './types.js';

/** Mouse-look sensitivity: radians of yaw/pitch per pixel of movementX/Y. */
export const MOUSE_SENSITIVITY = 0.0022;

/** Per-frame dt clamp (s): a backgrounded tab never flings the camera. */
const MAX_DT_SEC = 0.25;

/** Virtual-stick travel radius in CSS pixels (full deflection). */
const STICK_RADIUS_PX = 64;

/** House default bindings; games may override via setKeyBindings. */
export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  actions: [
    { bit: 0, keys: ['Space'] }, // jump/fire
    { bit: 1, keys: ['ShiftLeft', 'ShiftRight'] }, // modifier
    { bit: 2, keys: ['KeyE'] },
    { bit: 3, keys: ['KeyR'] },
  ],
};

export const DEFAULT_PAD_BINDINGS: PadBindings = {
  stickDeadzone: 0.15,
  buttonMap: [
    { from: 0, bit: 0 }, // A -> jump/fire
    { from: 1, bit: 2 },
    { from: 2, bit: 3 },
    { from: 5, bit: 1 }, // RB -> modifier
  ],
  lookSpeedRadPerSec: 2.6,
};

/** requestPointerLock with the unadjustedMovement option, when supported. */
type LockCapable = HTMLElement & {
  requestPointerLock?: (opts?: { readonly unadjustedMovement?: boolean }) => unknown;
};

function clamp11(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** Radial deadzone with rescale: inside dz → 0; outside → full-range remap. */
function applyDeadzone(x: number, y: number, dz: number): { x: number; y: number } {
  const mag = Math.hypot(x, y);
  if (!(mag > dz)) return { x: 0, y: 0 };
  const scaled = Math.min(1, (mag - dz) / Math.max(1e-6, 1 - dz)) / mag;
  return { x: x * scaled, y: y * scaled };
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** All gamepads the UA currently exposes ([] when unavailable/headless). */
function readPads(): readonly (Gamepad | null)[] {
  if (typeof navigator === 'undefined') return [];
  try {
    const list = navigator.getGamepads();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function coarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

export class GameInputHub implements InputHub {
  onLockChange: ((locked: boolean) => void) | null = null;

  private keyBindings: KeyBindings = DEFAULT_KEY_BINDINGS;
  private padBindings: PadBindings = DEFAULT_PAD_BINDINGS;
  private touch: TouchOpts | null = null;

  // keyboard state (codes + which action bits they currently hold)
  private readonly heldKeys = new Set<string>();
  private readonly kbBits = new Set<number>();

  // touch overlay state
  private readonly touchBits = new Set<number>();
  private touchVX = 0;
  private touchVY = 0;
  private overlayRoot: HTMLDivElement | null = null;
  private stickBase: HTMLDivElement | null = null;
  private stickKnob: HTMLDivElement | null = null;
  private stickOriginX = 0;
  private stickOriginY = 0;
  private stickPointer: number | null = null;

  // look accumulation (radians since last frame()) + pad button latch
  private accDX = 0;
  private accDY = 0;
  private prevPadBits = 0;

  private padConn = false;
  private lockedFlag = false;
  private started = false;
  private lastFrameT: number | null = null;
  private edgeQueue: InputEdge[] = [];

  /** THE stable frame object — mutated in place every frame(). */
  private readonly frameState = { moveX: 0, moveZ: 0, lookDX: 0, lookDY: 0, buttons: 0 };

  constructor(private readonly canvas: HTMLElement | null = null) {}

  // ---- configuration ---------------------------------------------------------

  setKeyBindings(b: KeyBindings): void {
    this.clearKeyboard(true); // releases for any bits the old table held
    this.keyBindings = b;
  }

  setPadBindings(b: PadBindings): void {
    this.padBindings = b;
  }

  setTouch(opts: TouchOpts): void {
    this.touch = { enabled: opts.enabled, actions: opts.actions };
    this.rebuildOverlay();
  }

  // ---- pointer lock ------------------------------------------------------------

  requestPointerLock(): Promise<void> {
    const el = this.canvas as LockCapable | null;
    if (!el || typeof el.requestPointerLock !== 'function') {
      return Promise.reject(new Error('InputHub: pointer lock needs a canvas element'));
    }
    try {
      const r = el.requestPointerLock({ unadjustedMovement: true });
      if (isPromiseLike(r)) {
        // Chrome rejects the promise with NotSupportedError where the option
        // is unsupported — fall back to the bare call in that path too.
        return Promise.resolve(r).then(
          () => undefined,
          () => {
            const r2 = el.requestPointerLock();
            return Promise.resolve(r2).then(() => undefined);
          },
        );
      }
      return Promise.resolve();
    } catch {
      // some engines throw synchronously on the options form — retry bare
    }
    try {
      return Promise.resolve(el.requestPointerLock()).then(() => undefined);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  locked(): boolean {
    return this.lockedFlag;
  }

  // ---- lifecycle ----------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.evtKeyDown);
      window.addEventListener('keyup', this.evtKeyUp);
      window.addEventListener('blur', this.evtBlur);
      window.addEventListener('gamepadconnected', this.evtPadOn);
      window.addEventListener('gamepaddisconnected', this.evtPadOff);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('mousemove', this.evtMouseMove);
      document.addEventListener('pointerlockchange', this.evtLockChange);
    }
    // seed connectivity from whatever the UA already reports
    for (const p of readPads()) {
      if (p != null && p.connected !== false) {
        this.padConn = true;
        break;
      }
    }
    this.rebuildOverlay();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.evtKeyDown);
      window.removeEventListener('keyup', this.evtKeyUp);
      window.removeEventListener('blur', this.evtBlur);
      window.removeEventListener('gamepadconnected', this.evtPadOn);
      window.removeEventListener('gamepaddisconnected', this.evtPadOff);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('mousemove', this.evtMouseMove);
      document.removeEventListener('pointerlockchange', this.evtLockChange);
    }
    this.clearKeyboard(false);
    this.clearTouch(false);
    this.prevPadBits = 0;
    this.lastFrameT = null;
    this.lockedFlag = false;
    this.padConn = false;
    this.edgeQueue.length = 0;
  }

  // ---- per-frame merge ----------------------------------------------------------

  /**
   * Stable object mutated in place — read in the same tick. Polls the Gamepad
   * API, merges keyboard/gamepad/touch into axes+buttons, folds accumulated
   * look deltas (mouse + right stick·dt) in, and queues pad-button edges.
   */
  frame(): InputFrame {
    const f = this.frameState;
    const t = nowMs();
    const dt =
      this.lastFrameT === null ? 0 : Math.min(MAX_DT_SEC, Math.max(0, (t - this.lastFrameT) / 1000));
    this.lastFrameT = t;

    const kb = this.keyBindings;
    let mx = 0;
    let mz = 0;
    if (anyHeld(kb.left, this.heldKeys)) mx -= 1;
    if (anyHeld(kb.right, this.heldKeys)) mx += 1;
    if (anyHeld(kb.forward, this.heldKeys)) mz += 1;
    if (anyHeld(kb.back, this.heldKeys)) mz -= 1;

    const pb = this.padBindings;
    const pads = readPads();
    let activePads = 0;
    let padBits = 0;
    for (const p of pads) {
      if (p == null || p.connected === false) continue;
      if (++activePads > 1) break; // first connected pad drives input
      const ax = p.axes;
      const left = applyDeadzone(ax[0] ?? 0, ax[1] ?? 0, pb.stickDeadzone);
      mx += left.x;
      mz += -left.y; // stick up (negative ly) = forward intent
      const right = applyDeadzone(ax[2] ?? 0, ax[3] ?? 0, pb.stickDeadzone);
      this.accDX += right.x * pb.lookSpeedRadPerSec * dt;
      this.accDY += right.y * pb.lookSpeedRadPerSec * dt;
      for (const m of pb.buttonMap) {
        const btn = p.buttons[m.from];
        if (btn != null && (btn.pressed || btn.value > 0.5)) padBits |= 1 << m.bit;
      }
    }
    this.padConn = activePads > 0;

    // pad-button edges vs the previous frame's latch
    const changed = padBits ^ this.prevPadBits;
    if (changed !== 0) {
      for (let bit = 0; bit < 32; bit++) {
        const mask = 1 << bit;
        if ((changed & mask) === 0) continue;
        this.edgeQueue.push((padBits & mask) !== 0 ? { kind: 'press', bit } : { kind: 'release', bit });
      }
    }
    this.prevPadBits = padBits;

    // touch stick (clientY grows downward → invert for forward)
    const tv = applyDeadzone(this.touchVX, -this.touchVY, pb.stickDeadzone);
    mx += tv.x;
    mz += tv.y;

    f.moveX = clamp11(mx);
    f.moveZ = clamp11(mz);
    f.lookDX = this.accDX;
    f.lookDY = this.accDY;
    this.accDX = 0;
    this.accDY = 0;

    let bits = padBits;
    for (const b of this.kbBits) bits |= 1 << b;
    for (const b of this.touchBits) bits |= 1 << b;
    f.buttons = bits >>> 0;
    return f;
  }

  /** Drains press/release events queued since the last call. */
  edges(): InputEdge[] {
    const q = this.edgeQueue;
    this.edgeQueue = [];
    return q;
  }

  /** True while any gamepad is connected. */
  padConnected(): boolean {
    return this.padConn;
  }

  // ---- @internal handlers (DOM listener targets AND unit-test hooks) ----

  /** @internal keydown by code (OS repeats are ignored via dedupe). */
  handleKeyDown(code: string): void {
    if (this.heldKeys.has(code)) return; // repeat
    this.heldKeys.add(code);
    for (const a of this.keyBindings.actions) {
      if (!a.keys.includes(code) || this.kbBits.has(a.bit)) continue;
      this.kbBits.add(a.bit);
      this.edgeQueue.push({ kind: 'press', bit: a.bit });
    }
  }

  /** @internal keyup by code (multi-key bits wait for their LAST key). */
  handleKeyUp(code: string): void {
    if (!this.heldKeys.delete(code)) return;
    for (const a of this.keyBindings.actions) {
      if (!a.keys.includes(code)) continue;
      let stillHeld = false;
      for (const k of a.keys) {
        if (k !== code && this.heldKeys.has(k)) {
          stillHeld = true;
          break;
        }
      }
      if (!stillHeld && this.kbBits.delete(a.bit)) {
        this.edgeQueue.push({ kind: 'release', bit: a.bit });
      }
    }
  }

  /** @internal blur clears ALL held keyboard + touch state (with releases). */
  handleBlur(): void {
    this.clearKeyboard(true);
    this.clearTouch(true);
  }

  /** @internal raw mouse deltas in px — counted only while pointer-locked. */
  handleMouseMove(dxPx: number, dyPx: number): void {
    if (!this.lockedFlag) return;
    if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return;
    this.accDX += dxPx * MOUSE_SENSITIVITY;
    this.accDY += dyPx * MOUSE_SENSITIVITY;
  }

  /** @internal mirrors the document pointerlockchange handler for tests. */
  forceLockState(v: boolean): void {
    if (this.lockedFlag === v) return;
    this.lockedFlag = v;
    this.onLockChange?.(v);
  }

  /** @internal 'gamepadconnected'. */
  handlePadConnected(): void {
    this.padConn = true;
  }

  /** @internal 'gamepaddisconnected' — re-sync against the live list. */
  handlePadDisconnected(): void {
    this.padConn = readPads().some((p) => p != null && p.connected !== false);
    if (!this.padConn) {
      // gone mid-hold: emit releases so games never see stuck pad bits
      const changed = this.prevPadBits;
      this.prevPadBits = 0;
      for (let bit = 0; bit < 32; bit++) {
        if ((changed & (1 << bit)) !== 0) this.edgeQueue.push({ kind: 'release', bit });
      }
    }
  }

  // ---- DOM listener wrappers -------------------------------------------------

  private readonly evtKeyDown = (e: KeyboardEvent): void => {
    if (this.isBoundKey(e.code)) e.preventDefault(); // keep Space/arrows off page scroll
    if (e.repeat) return;
    this.handleKeyDown(e.code);
  };

  private readonly evtKeyUp = (e: KeyboardEvent): void => {
    this.handleKeyUp(e.code);
  };

  private readonly evtBlur = (): void => {
    this.handleBlur();
  };

  private readonly evtMouseMove = (e: MouseEvent): void => {
    this.handleMouseMove(e.movementX ?? 0, e.movementY ?? 0);
  };

  private readonly evtLockChange = (): void => {
    const doc = typeof document === 'undefined' ? null : document;
    this.forceLockState(doc !== null && this.canvas !== null && doc.pointerLockElement === this.canvas);
  };

  private readonly evtPadOn = (): void => {
    this.handlePadConnected();
  };

  private readonly evtPadOff = (): void => {
    this.handlePadDisconnected();
  };

  private isBoundKey(code: string): boolean {
    const kb = this.keyBindings;
    return (
      kb.left.includes(code) ||
      kb.right.includes(code) ||
      kb.forward.includes(code) ||
      kb.back.includes(code) ||
      kb.actions.some((a) => a.keys.includes(code))
    );
  }

  // ---- held-state teardown helpers ----------------------------------------------

  private clearKeyboard(withEdges: boolean): void {
    this.heldKeys.clear();
    for (const bit of this.kbBits) {
      if (withEdges) this.edgeQueue.push({ kind: 'release', bit });
    }
    this.kbBits.clear();
  }

  private clearTouch(withEdges: boolean): void {
    for (const bit of this.touchBits) {
      if (withEdges) this.edgeQueue.push({ kind: 'release', bit });
    }
    this.touchBits.clear();
    this.touchVX = 0;
    this.touchVY = 0;
    this.stickPointer = null;
    if (this.stickBase) this.stickBase.style.display = 'none';
    if (this.stickKnob) this.stickKnob.style.transform = '';
  }

  private touchPress(bit: number): void {
    if (this.touchBits.has(bit)) return;
    this.touchBits.add(bit);
    this.edgeQueue.push({ kind: 'press', bit });
  }

  private touchRelease(bit: number): void {
    if (this.touchBits.delete(bit)) this.edgeQueue.push({ kind: 'release', bit });
  }

  // ---- touch overlay DOM -----------------------------------------------------------

  /** Rebuild the overlay: only when enabled AND a coarse primary pointer. */
  private rebuildOverlay(): void {
    this.destroyOverlay();
    if (typeof document === 'undefined' || !this.touch?.enabled || !coarsePointer()) return;

    const doc = document;
    const root = doc.createElement('div');
    root.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'right:0',
      'bottom:0',
      'z-index:2147483000',
      'pointer-events:none',
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif',
    ].join(';');

    // virtual stick zone: LEFT half of the screen
    const zone = doc.createElement('div');
    zone.style.cssText =
      'position:absolute;left:0;top:0;width:50%;height:100%;pointer-events:auto;touch-action:none;';
    root.appendChild(zone);

    const base = doc.createElement('div');
    base.style.cssText =
      `position:absolute;width:${STICK_RADIUS_PX * 2}px;height:${STICK_RADIUS_PX * 2}px;` +
      `margin:${-STICK_RADIUS_PX}px 0 0 ${-STICK_RADIUS_PX}px;border-radius:50%;` +
      'border:2px solid rgba(255,255,255,.35);background:rgba(20,22,28,.25);display:none;';
    const knob = doc.createElement('div');
    knob.style.cssText =
      'position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;' +
      'border-radius:50%;background:rgba(255,255,255,.45);pointer-events:none;';
    base.appendChild(knob);
    zone.appendChild(base);

    // action buttons: RIGHT side cluster
    const wrap = doc.createElement('div');
    wrap.style.cssText =
      'position:absolute;right:16px;bottom:16px;display:flex;flex-direction:column;gap:12px;' +
      'align-items:flex-end;pointer-events:none;';
    root.appendChild(wrap);

    for (const a of this.touch.actions) {
      const btn = doc.createElement('div');
      btn.textContent = a.label;
      btn.style.cssText =
        'width:64px;height:64px;border-radius:50%;border:2px solid rgba(255,255,255,.4);' +
        'background:rgba(20,22,28,.4);color:#fff;display:flex;align-items:center;' +
        'justify-content:center;font-size:13px;font-weight:600;user-select:none;' +
        '-webkit-user-select:none;pointer-events:auto;touch-action:none;';
      btn.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        try {
          btn.setPointerCapture(ev.pointerId);
        } catch {
          /* detached */
        }
        this.touchPress(a.bit);
      });
      const rel = (): void => this.touchRelease(a.bit);
      btn.addEventListener('pointerup', rel);
      btn.addEventListener('pointercancel', rel);
      wrap.appendChild(btn);
    }

    // stick pointer tracking (capture keeps move/up flowing outside the zone)
    zone.addEventListener('pointerdown', (ev) => {
      if (this.stickPointer !== null) return;
      this.stickPointer = ev.pointerId;
      this.stickOriginX = ev.clientX;
      this.stickOriginY = ev.clientY;
      base.style.left = `${ev.clientX}px`;
      base.style.top = `${ev.clientY}px`;
      base.style.display = 'block';
      try {
        zone.setPointerCapture(ev.pointerId);
      } catch {
        /* detached */
      }
    });
    zone.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== this.stickPointer) return;
      const dx = ev.clientX - this.stickOriginX;
      const dy = ev.clientY - this.stickOriginY;
      const len = Math.hypot(dx, dy);
      const k = len > STICK_RADIUS_PX ? STICK_RADIUS_PX / len : 1;
      this.touchVX = (dx * k) / STICK_RADIUS_PX;
      this.touchVY = (dy * k) / STICK_RADIUS_PX;
      knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    });
    const endStick = (ev: PointerEvent): void => {
      if (ev.pointerId !== this.stickPointer) return;
      this.stickPointer = null;
      this.touchVX = 0;
      this.touchVY = 0;
      base.style.display = 'none';
      knob.style.transform = '';
    };
    zone.addEventListener('pointerup', endStick);
    zone.addEventListener('pointercancel', endStick);

    doc.body.appendChild(root);
    this.overlayRoot = root;
    this.stickBase = base;
    this.stickKnob = knob;
  }

  private destroyOverlay(): void {
    this.clearTouch(true); // releases for buttons/stick held while removed
    if (this.overlayRoot) this.overlayRoot.remove();
    this.overlayRoot = null;
    this.stickBase = null;
    this.stickKnob = null;
  }
}

function anyHeld(keys: readonly string[], held: ReadonlySet<string>): boolean {
  for (const k of keys) {
    if (held.has(k)) return true;
  }
  return false;
}
