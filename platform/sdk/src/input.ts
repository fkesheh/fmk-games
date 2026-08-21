// ============================================================================
// SDK INPUT — InputHub merging keyboard + Gamepad API + local touch into one
// normalized frame (docs/PLATFORM.md §4.4/§4.5). Physical pads never touch
// the network; phone pads are a separate relay handled by rooms.
// Owner: P7_SDK_INPUT_AUDIO — implement InputHub from types.ts.
// ============================================================================

import type { InputEdge, InputFrame, InputHub, KeyBindings, PadBindings, TouchOpts } from './types.js';

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

export class GameInputHub implements InputHub {
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(private readonly canvas: HTMLElement | null = null) {
    void canvas;
  }

  setKeyBindings(_b: KeyBindings): void {
    void _b;
  }
  setPadBindings(_b: PadBindings): void {
    void _b;
  }
  setTouch(_opts: TouchOpts): void {
    void _opts;
  }
  requestPointerLock(): Promise<void> {
    return Promise.reject(new Error('P7_SDK_INPUT_AUDIO: not implemented'));
  }
  locked(): boolean {
    return false;
  }
  start(): void {}
  stop(): void {}

  /** Stable object mutated in place — read in the same tick. */
  frame(): InputFrame {
    throw new Error('P7_SDK_INPUT_AUDIO: not implemented');
  }

  edges(): InputEdge[] {
    return [];
  }

  padConnected(): boolean {
    return false;
  }
}
