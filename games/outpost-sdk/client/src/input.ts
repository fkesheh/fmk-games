// ============================================================================
// C2 — InputController: pointer lock, mouse look, held state, edge queue.
// Ported from games/fps/client/src/input/input.ts, conventions preserved
// exactly (SENS, zoom sens mul, pitch clamp, yaw sign, e.code keys, the
// zero-allocation reused frame() object, the semi-auto fireLatch, the edge
// queue). OUTPOST ADDITIONS: INPUT_INTERACT (hold E) with a short release
// grace so a rapid release/re-press does not instantly zero repair progress.
// Keys tracked by e.code (layout-independent). Window blur AND pointer-lock
// loss clear every held key/button so nothing sticks. Gameplay keys/edges are
// only honored while pointer-locked; unlocked DOM menus keep normal typing.
// Blur must NOT pause the game — co-op, the horde keeps coming.
// ============================================================================
import {
  INPUT_ALT,
  INPUT_CROUCH,
  INPUT_FIRE,
  INPUT_INTERACT,
  INPUT_JUMP,
  INPUT_WALK,
} from '@outpost/shared';

export type InputEdge = 'reload' | 'slot1' | 'slot2' | 'slot3' | 'scoreboard' | 'menu' | 'qswitch';

// ---- tuning (frozen conventions, ported from STRICKEN) ----------------------
const SENS = 0.0022; // rad per mouse px
const ZOOM_SENS_MUL = 0.4; // while scoped
const PITCH_MIN = -1.45;
const PITCH_MAX = 1.45;
const TWO_PI = Math.PI * 2;
// OUTPOST addition: a rapid E release/re-press within this window does not
// drop INPUT_INTERACT — repairing under fire must not be miserable.
const INTERACT_GRACE_MS = 150;

// Shared empty result so edges() never allocates in the per-frame hot path.
const NO_EDGES: readonly InputEdge[] = [];

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

  private started = false;
  private zoomed = false;

  // held state
  private keyW = false;
  private keyA = false;
  private keyS = false;
  private keyD = false;
  private jumpHeld = false;
  private keyCHeld = false; // 'C' — crouch
  // Caps Lock crouch state, flipped on EVERY CapsLock key event (down AND up).
  // Windows fires keydown+keyup per physical press/release → hold-crouch.
  // macOS fires keydown only when caps engages and keyup when it disengages
  // (two physical presses) → toggle-crouch. One flag serves both platforms.
  private capsCrouch = false;
  private fireHeld = false;
  private altHeld = false;
  private keyFHeld = false; // 'F' — scope = altHeld || keyFHeld
  private tabHeld = false;
  private shiftLHeld = false; // walk = shiftLHeld || shiftRHeld
  private shiftRHeld = false;
  // Semi-auto latch: a press that starts AND ends between two frame() samples
  // is still reported in exactly one frame() result.
  private fireLatch = false;

  // INTERACT (hold E): physical key state plus a short post-release grace so
  // a rapid tap-release-tap does not zero out repair/revive progress.
  private interactPhysicalHeld = false;
  private interactReleasedAt: number | null = null;

  private queue: InputEdge[] = [];

  // frame() result is one reused object — no per-frame allocation. Do not retain.
  private readonly frameOut = { moveX: 0, moveZ: 0, buttons: 0 };

  constructor(private readonly canvas: HTMLCanvasElement) {}

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
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.clearHeld();
    if (this.locked()) document.exitPointerLock();
  }

  locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  setZoomed(on: boolean): void {
    this.zoomed = on;
  }

  // ---- per-frame state ----------------------------------------------------------
  /** Held WASD/jump/crouch/fire/alt/walk/interact. Safe every rAF; returns a reused object. */
  frame(): { moveX: number; moveZ: number; buttons: number } {
    let buttons = 0;
    if (this.fireHeld || this.fireLatch) buttons |= INPUT_FIRE;
    this.fireLatch = false; // consumed by this frame — reported exactly once
    if (this.jumpHeld) buttons |= INPUT_JUMP;
    if (this.keyCHeld || this.capsCrouch) buttons |= INPUT_CROUCH;
    if (this.altHeld || this.keyFHeld) buttons |= INPUT_ALT;
    if (this.shiftLHeld || this.shiftRHeld) buttons |= INPUT_WALK;
    if (this.interacting()) buttons |= INPUT_INTERACT;
    const o = this.frameOut;
    o.moveX = (this.keyD ? 1 : 0) - (this.keyA ? 1 : 0); // right positive
    o.moveZ = (this.keyW ? 1 : 0) - (this.keyS ? 1 : 0); // forward positive
    o.buttons = buttons;
    return o;
  }

  /** Drain queued edges. Returned array is owned by the caller; do not mutate NO_EDGES. */
  edges(): readonly InputEdge[] {
    if (this.queue.length === 0) return NO_EDGES;
    const out = this.queue;
    this.queue = [];
    return out;
  }

  clearHeld(): void {
    this.keyW = this.keyA = this.keyS = this.keyD = false;
    this.jumpHeld = this.keyCHeld = false;
    this.fireHeld = this.altHeld = this.keyFHeld = false;
    this.shiftLHeld = this.shiftRHeld = false;
    this.capsCrouch = false; // no stuck crouch on blur/unlock
    this.fireLatch = false;
    // hard clear — no grace across blur/unlock, only across a fast re-press
    this.interactPhysicalHeld = false;
    this.interactReleasedAt = null;
    if (this.tabHeld) {
      // never leave the scoreboard stuck open across blur/unlock
      this.tabHeld = false;
      this.queue.push('scoreboard');
    }
  }

  // ---- internal -------------------------------------------------------------------
  private interacting(): boolean {
    if (this.interactPhysicalHeld) return true;
    if (this.interactReleasedAt === null) return false;
    return performance.now() - this.interactReleasedAt < INTERACT_GRACE_MS;
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

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.locked()) return;
    if (e.code === 'CapsLock') {
      // flip capsCrouch on down AND up (keyup case is in onKeyUp). NOT
      // preventDefault'd: CapsLock also toggles OS caps state — harmless here.
      if (!e.repeat) this.capsCrouch = !this.capsCrouch;
      return;
    }
    switch (e.code) {
      case 'KeyW': this.keyW = true; break;
      case 'KeyA': this.keyA = true; break;
      case 'KeyS': this.keyS = true; break;
      case 'KeyD': this.keyD = true; break;
      case 'Space': this.jumpHeld = true; break;
      case 'KeyC': this.keyCHeld = true; break;
      case 'KeyF': this.keyFHeld = true; break;
      case 'ShiftLeft': this.shiftLHeld = true; break;
      case 'ShiftRight': this.shiftRHeld = true; break;
      case 'KeyE':
        // a re-press within the grace window cancels the pending release —
        // interactPhysicalHeld alone already covers it via interacting().
        this.interactPhysicalHeld = true;
        this.interactReleasedAt = null;
        break;
      case 'KeyQ': if (!e.repeat) this.queue.push('qswitch'); break;
      case 'KeyR': if (!e.repeat) this.queue.push('reload'); break;
      case 'Tab':
        // No down/up variant in InputEdge — fired once on press; the consumer
        // treats this as a toggle rather than a hold (see input.ts summary).
        if (!e.repeat && !this.tabHeld) {
          this.tabHeld = true;
          this.queue.push('scoreboard');
        }
        break;
      case 'Escape': if (!e.repeat) this.queue.push('menu'); break;
      case 'Digit1': if (!e.repeat) this.queue.push('slot1'); break;
      case 'Digit2': if (!e.repeat) this.queue.push('slot2'); break;
      case 'Digit3': if (!e.repeat) this.queue.push('slot3'); break;
      default:
        return; // not a game key — leave the event alone
    }
    e.preventDefault(); // suppress browser defaults for game keys while locked
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    // ungated: held flags must clear even if lock was lost between down and up
    switch (e.code) {
      case 'CapsLock':
        // flip counterpart to onKeyDown. Still gated by pointer lock like the
        // keydown — otherwise a Windows keyup while unlocked would flip
        // crouch on with no matching keydown.
        if (this.locked() && !e.repeat) this.capsCrouch = !this.capsCrouch;
        break;
      case 'KeyW': this.keyW = false; break;
      case 'KeyA': this.keyA = false; break;
      case 'KeyS': this.keyS = false; break;
      case 'KeyD': this.keyD = false; break;
      case 'Space': this.jumpHeld = false; break;
      case 'KeyC': this.keyCHeld = false; break;
      case 'KeyF': this.keyFHeld = false; break;
      case 'ShiftLeft': this.shiftLHeld = false; break;
      case 'ShiftRight': this.shiftRHeld = false; break;
      case 'KeyE':
        this.interactPhysicalHeld = false;
        this.interactReleasedAt = performance.now();
        break;
      case 'Tab':
        if (this.tabHeld) this.tabHeld = false;
        break;
    }
  };
}
