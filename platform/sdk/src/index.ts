// Barrel for @platform/sdk. Implementation modules append their re-exports
// here (owner specs); types are part of the frozen contract.
export * from './types.js';

// ---- P7_SDK_INPUT_AUDIO -----------------------------------------------------
export { DEFAULT_KEY_BINDINGS, DEFAULT_PAD_BINDINGS, MOUSE_SENSITIVITY, GameInputHub } from './input.js';
export { SynthKit } from './audio.js';
export { showPadPairing } from './padQr.js';
export type { PadPairOverlay } from './padQr.js';

// ---- P6_SDK_CORE (net / rooms / profile / saves / facade) -------------------
export * from './net.js';
export * from './rooms.js';
export * from './profile.js';
export * from './saves.js';
export * from './client.js';
