// ============================================================================
// FROZEN CONTRACT — seeded RNG shared by server, client prediction, and all
// procedural client art. The canonical implementation moved to
// @platform/shared (rng is game-agnostic); this module re-exports it so the
// frozen @fps/shared import surface is unchanged. Deterministic for a given
// seed. Math.random is a contract violation everywhere; server-side
// non-gameplay generation (room ids, codes, map picks) uses rng(Date.now()).
// ============================================================================
export * from '@platform/shared/rng';
