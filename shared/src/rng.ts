// ============================================================================
// FROZEN CONTRACT — seeded RNG shared by server, client prediction, and all
// procedural client art. Deterministic for a given seed. Math.random is a
// contract violation everywhere; server-side non-gameplay generation (room
// ids, codes, map picks) uses rng(Date.now()).
// ============================================================================

/** mulberry32: returns a function producing floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Float in [min, max) from a seeded rng function. */
export function rngRange(next: () => number, min: number, max: number): number {
  return min + next() * (max - min);
}

/** Integer in [min, max] inclusive from a seeded rng function. */
export function rngInt(next: () => number, min: number, max: number): number {
  return Math.floor(min + next() * (max - min + 1));
}

/** Pick one element from a non-empty array. */
export function rngPick<T>(next: () => number, items: readonly T[]): T {
  const chosen = items[Math.min(items.length - 1, Math.floor(next() * items.length))];
  if (chosen === undefined) throw new Error('rngPick: empty array');
  return chosen;
}

/** Symmetric hash of (mapId, salt) so each map's deco seed is stable. */
export function decoSeed(mapId: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < mapId.length; i++) {
    h ^= mapId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
