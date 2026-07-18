// ============================================================================
// C2 — InputController: pointer lock, mouse look, held state, edge queue.
// Keys tracked by e.code (layout-independent). Window blur AND pointer-lock
// loss clear every held key/button so nothing sticks. Gameplay keys/edges are
// only honored while pointer-locked; unlocked DOM menus keep normal typing.
// ============================================================================
import { INPUT_ALT, INPUT_CROUCH, INPUT_FIRE, INPUT_JUMP } from '@fps/shared';

export type InputEdge =
  | { kind: 'reload' }
  | { kind: 'slot'; n: number }
  | { kind: 'buy' }
  | { kind: 'scoreboard'; down: boolean }
  | { kind: 'menu' };

// ---- tuning (frozen by CONTRACT.md / UX_BIBLE.md) ---------------------------
const SENS = 0.0022; // rad per mouse px
const ZOOM_SENS_MUL = 0.4; // while scoped
const PITCH_MIN = -1.45;
const PITCH_MAX = 1.45;
const SLOT_COUNT = 6;
const TWO_PI = Math.PI * 2;

// Shared empty result so edges() never allocates in the per-frame hot path.
const NO_EDGES: InputEdge[] = [];

function wrapPi(a: number): number {
  return ((((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class InputController {
  // Look state. yaw: 0 = -Z, increases CCW from above; forward = (-sin, -cos),
  // so mouse-right (movementX > 0) must DECREASE yaw. pitch: positive = up.
  yaw = 0;
  pitch = 0;
  onLockChange: ((locked: boolean) => void) | null = null;

  private started = false;
  private zoomed = false;

  // held state
  private keyW = false;
  private keyA = false;
  private keyS = false;
  private keyD = false;
  private jumpHeld = false;
  private ctrlHeld = false; // either Ctrl
  private keyCHeld = false; // 'C' — crouch = ctrlHeld || keyCHeld
  private fireHeld = false;
  private altHeld = false;
  private keyFHeld = false; // 'F' — scope = altHeld || keyFHeld
  private tabHeld = false;
  // Semi-auto latch: a press that starts AND ends between two frame() samples
  // is still reported in exactly one frame() result.
  private fireLatch = false;

  // wheel slots are relative to the last explicit slot edge (digits included)
  private lastSlot = 1;
  private queue: InputEdge[] = [];

  // frame() result is one reused object — no per-frame allocation. Do not retain.
  private readonly frameOut = { moveX: 0, moveZ: 0, buttons: 0 };

  constructor(private readonly canvas: HTMLElement) {}

  // ---- lifecycle --------------------------------------------------------------
  start(): void {
    if (this.started) return;
    this.started = true;
    this.canvas.addEventListener('click', this.onClick);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('contextmenu', this.onDocumentContextMenu);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', this.onPointerLockError);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.canvas.removeEventListener('click', this.onClick);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('contextmenu', this.onDocumentContextMenu);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('pointerlockerror', this.onPointerLockError);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.clearHeld();
    if (this.locked()) document.exitPointerLock();
  }

  locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  setZoomed(z: boolean): void {
    this.zoomed = z;
  }

  // ---- per-frame state ----------------------------------------------------------
  /** Held WASD/jump/crouch/fire/alt. Safe every rAF; returns a reused object. */
  frame(): { moveX: number; moveZ: number; buttons: number } {
    let buttons = 0;
    if (this.fireHeld || this.fireLatch) buttons |= INPUT_FIRE;
    this.fireLatch = false; // consumed by this frame — reported exactly once
    if (this.jumpHeld) buttons |= INPUT_JUMP;
    if (this.ctrlHeld || this.keyCHeld) buttons |= INPUT_CROUCH;
    if (this.altHeld || this.keyFHeld) buttons |= INPUT_ALT;
    const o = this.frameOut;
    o.moveX = (this.keyD ? 1 : 0) - (this.keyA ? 1 : 0); // right positive
    o.moveZ = (this.keyW ? 1 : 0) - (this.keyS ? 1 : 0); // forward positive
    o.buttons = buttons;
    return o;
  }

  /** Drain queued edges. Returned array is owned by the caller; do not mutate NO_EDGES. */
  edges(): InputEdge[] {
    if (this.queue.length === 0) return NO_EDGES;
    const out = this.queue;
    this.queue = [];
    return out;
  }

  // ---- internal -------------------------------------------------------------------
  private clearHeld(): void {
    this.keyW = this.keyA = this.keyS = this.keyD = false;
    this.jumpHeld = this.ctrlHeld = this.keyCHeld = false;
    this.fireHeld = this.altHeld = this.keyFHeld = false;
    this.fireLatch = false;
    if (this.tabHeld) {
      // never leave the scoreboard stuck open across blur/unlock
      this.tabHeld = false;
      this.queue.push({ kind: 'scoreboard', down: false });
    }
  }

  private readonly onClick = (): void => {
    if (this.locked()) return;
    try {
      const r: unknown = this.canvas.requestPointerLock();
      // new engines return a promise that rejects during the post-Esc cooldown —
      // swallow it; the next canvas click retries.
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      // older engines throw synchronously — same deal
    }
  };

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault(); // RMB is alt-fire/scope, never a context menu
  };

  private readonly onDocumentContextMenu = (e: Event): void => {
    // canvas-level suppression misses nothing when locked, but the pointer is
    // captured and targets can vary by engine — block the menu document-wide.
    if (this.locked()) e.preventDefault();
  };

  private readonly onPointerLockChange = (): void => {
    const locked = this.locked();
    if (!locked) this.clearHeld();
    this.onLockChange?.(locked);
  };

  private readonly onPointerLockError = (): void => {
    // browser denied the request (cooldown / gesture rules) — next click retries
  };

  private readonly onBlur = (): void => {
    this.clearHeld();
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.locked()) return;
    const s = SENS * (this.zoomed ? ZOOM_SENS_MUL : 1);
    this.yaw = wrapPi(this.yaw - e.movementX * s);
    this.pitch = clamp(this.pitch - e.movementY * s, PITCH_MIN, PITCH_MAX);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this.locked()) return;
    if (e.button === 0) {
      this.fireHeld = true;
      this.fireLatch = true;
    } else if (e.button === 2) {
      this.altHeld = true;
    }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    // ungated: clearing is always safe, even if lock was lost mid-press
    if (e.button === 0) this.fireHeld = false;
    else if (e.button === 2) this.altHeld = false;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.locked()) return;
    e.preventDefault();
    if (e.deltaY === 0) return;
    const step = e.deltaY > 0 ? 1 : -1; // wheel down = next slot, up = prev
    this.lastSlot = ((((this.lastSlot - 1 + step) % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT) + 1;
    this.queue.push({ kind: 'slot', n: this.lastSlot });
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.locked()) return;
    switch (e.code) {
      case 'KeyW': this.keyW = true; break;
      case 'KeyA': this.keyA = true; break;
      case 'KeyS': this.keyS = true; break;
      case 'KeyD': this.keyD = true; break;
      case 'Space': this.jumpHeld = true; break;
      case 'ControlLeft':
      case 'ControlRight': this.ctrlHeld = true; break;
      case 'KeyC': this.keyCHeld = true; break;
      case 'KeyF': this.keyFHeld = true; break;
      case 'KeyR': if (!e.repeat) this.queue.push({ kind: 'reload' }); break;
      case 'KeyB': if (!e.repeat) this.queue.push({ kind: 'buy' }); break;
      case 'Tab':
        if (!e.repeat && !this.tabHeld) {
          this.tabHeld = true;
          this.queue.push({ kind: 'scoreboard', down: true });
        }
        break;
      case 'Escape': if (!e.repeat) this.queue.push({ kind: 'menu' }); break;
      case 'Digit1':
      case 'Digit2':
      case 'Digit3':
      case 'Digit4':
      case 'Digit5':
      case 'Digit6':
        if (!e.repeat) {
          this.lastSlot = e.code.charCodeAt(5) - 48; // '1'..'6'
          this.queue.push({ kind: 'slot', n: this.lastSlot });
        }
        break;
      default:
        return; // not a game key — leave the event alone
    }
    e.preventDefault(); // suppress browser defaults for game keys while locked
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    // ungated: held flags must clear even if lock was lost between down and up
    switch (e.code) {
      case 'KeyW': this.keyW = false; break;
      case 'KeyA': this.keyA = false; break;
      case 'KeyS': this.keyS = false; break;
      case 'KeyD': this.keyD = false; break;
      case 'Space': this.jumpHeld = false; break;
      case 'ControlLeft':
      case 'ControlRight': this.ctrlHeld = false; break;
      case 'KeyC': this.keyCHeld = false; break;
      case 'KeyF': this.keyFHeld = false; break;
      case 'Tab':
        if (this.tabHeld) {
          this.tabHeld = false;
          this.queue.push({ kind: 'scoreboard', down: false });
        }
        break;
    }
  };
}
