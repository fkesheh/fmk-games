// ============================================================================
// FROZEN — seeded RNG. Canonical implementation lives in @platform/shared
// (deterministic for a given seed; Math.random is a contract violation).
// ============================================================================
export { rng, rngRange, rngInt, rngPick } from '@platform/shared/rng';
