// ============================================================================
// ACES map — FROZEN Layer-1 logic. Deterministic from MAP_SEED.
//
// The strait: open water west→east, a chain of islands down the middle,
// ROYAL airfield on the west shore, IRON airfield on the east.
// Islands are VISUAL + crate-placement constraints only — planes fly above
// them; there is no terrain collision anywhere in ACES. The client renders
// this exact data, so server and every client agree on the world's shape
// without shipping geometry over the wire.
// ============================================================================

import { MAP_SEED, WORLD } from './config.js';
import type { TeamId } from './config.js';

export interface Island {
  x: number;
  y: number;
  /** Base radius, u. */
  r: number;
  /** Radial noise: N radii multiplying r around the compass (normalized). */
  blob: readonly number[];
  /** Palm/scrub clusters: local offsets, u. */
  palms: ReadonlyArray<{ x: number; y: number; s: number }>;
  /** Rock outcrops: local offsets + scale, u (STYLE_BIBLE §6 density law). */
  rocks: ReadonlyArray<{ x: number; y: number; s: number }>;
}

export interface Airfield {
  team: TeamId;
  x: number;
  y: number;
  /** Runway heading, rad — spawn facing. */
  h: number;
  /** Two parked reserve crates flanking the strip (dressing, not gameplay). */
  parkedCrates: ReadonlyArray<{ x: number; y: number }>;
}

export interface AcesMap {
  seed: number;
  w: number;
  h: number;
  islands: readonly Island[];
  fields: readonly [Airfield, Airfield];
}

/** Seeded RNG — mulberry32. Same algorithm as @platform/shared rng. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the map. Deterministic: same seed → identical islands, palms, fields.
 * Islands keep clear of both airfields and of a central "shipping lane"
 * corridor so mid-map fights have open water.
 */
export function buildMap(seed: number = MAP_SEED): AcesMap {
  const rng = mulberry32(seed);
  const islands: Island[] = [];

  const fieldW = 260; //   airfield clear radius each side must respect
  const fieldsRaw = [
    { team: 'royal' as TeamId, x: fieldW + 60, y: WORLD.H / 2, h: 0 },
    { team: 'iron' as TeamId, x: WORLD.W - fieldW - 60, y: WORLD.H / 2, h: Math.PI },
  ] as const; // tuple (not array): literal indexing stays non-undefined under noUncheckedIndexedAccess
  const fieldPts: readonly { team: TeamId; x: number; y: number; h: number }[] = fieldsRaw;

  // lane corridor: |y − H/2| < LANE keeps mid-map open for head-on passes
  const LANE = 340;
  let tries = 0;
  while (islands.length < 6 && tries < 400) {
    tries++;
    const x = 520 + rng() * (WORLD.W - 1040);
    const y = 300 + rng() * (WORLD.H - 600);
    const r = 150 + rng() * 240;
    if (Math.abs(y - WORLD.H / 2) < LANE && x > 700 && x < WORLD.W - 700) continue;
    const nearField = fieldPts.some(
      (f) => Math.hypot(f.x - x, f.y - y) < r + fieldW + 120,
    );
    if (nearField) continue;
    const overlaps = islands.some((o) => {
      const d = Math.hypot(o.x - x, o.y - y);
      return d < o.r + r + 140;
    });
    if (overlaps) continue;

    // radial blob: 12 spokes, smooth-ish via averaging neighbors once
    const raw = Array.from({ length: 12 }, () => 0.72 + rng() * 0.55);
    const at = (i: number): number => raw[((i % 12) + 12) % 12] ?? 1;
    const blob = raw.map((_, i) => (at(i) + at(i - 1) + at(i + 1)) / 3);

    const palmCount = 3 + Math.floor(rng() * 4);
    const palms = Array.from({ length: palmCount }, () => {
      const a = rng() * Math.PI * 2;
      const rr = r * (0.15 + rng() * 0.55);
      return { x: Math.cos(a) * rr, y: Math.sin(a) * rr, s: 0.8 + rng() * 0.7 };
    });

    const rockCount = 1 + Math.floor(rng() * 3);
    const rocks = Array.from({ length: rockCount }, () => {
      const a = rng() * Math.PI * 2;
      const rr = r * (0.3 + rng() * 0.5);
      return { x: Math.cos(a) * rr, y: Math.sin(a) * rr, s: 0.7 + rng() * 0.8 };
    });

    islands.push({ x, y, r, blob, palms, rocks });
  }

  // Parked dressing crates flank each strip, deterministic from the seed.
  const fields: [Airfield, Airfield] = [
    {
      ...fieldsRaw[0],
      parkedCrates: [
        { x: fieldsRaw[0].x - 40, y: fieldsRaw[0].y - 150 },
        { x: fieldsRaw[0].x - 40, y: fieldsRaw[0].y + 150 },
      ],
    },
    {
      ...fieldsRaw[1],
      parkedCrates: [
        { x: fieldsRaw[1].x + 40, y: fieldsRaw[1].y - 150 },
        { x: fieldsRaw[1].x + 40, y: fieldsRaw[1].y + 150 },
      ],
    },
  ];

  return { seed, w: WORLD.W, h: WORLD.H, islands, fields };
}

/**
 * True when (x,y) is clear for a supply-crate drop: inside bounds margin and
 * not over any island (crates land on open water).
 */
export function isOpenWater(map: AcesMap, x: number, y: number): boolean {
  const m = WORLD.BOUND + 80;
  if (x < m || x > map.w - m || y < m || y > map.h - m) return false;
  return !map.islands.some((o) => Math.hypot(o.x - x, o.y - y) < o.r * 1.05 + 60);
}
