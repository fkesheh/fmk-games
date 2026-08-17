// Barrel export for @platform/shared: the frozen GameModule contract, the
// canonical seeded rng, the game-agnostic lobby wire protocol, the cross-game
// browser identity (signature + shared display name + rejoin pointer), and
// phone-as-controller (PAD) platform primitives. identity.js is side-effect-free
// at import time, so the server can pull the barrel without touching browser
// storage.
export * from './module.js';
export * from './rng.js';
export * from './protocol.js';
export * from './pad.js';
export * from './color.js';
export * from './identity.js';
