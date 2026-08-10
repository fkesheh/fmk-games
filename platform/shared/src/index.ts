// Barrel export for @platform/shared: the frozen GameModule contract, the
// canonical seeded rng, the game-agnostic lobby wire protocol, and the
// cross-game browser identity (signature + shared display name + rejoin
// pointer). identity.js is side-effect-free at import time, so the server can
// pull the barrel without ever touching browser storage.
export * from './module.js';
export * from './rng.js';
export * from './protocol.js';
export * from './color.js';
export * from './identity.js';
