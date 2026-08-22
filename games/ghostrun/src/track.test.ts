// ============================================================================
// TRACK TESTS — seed determinism + reachability sanity (specs/P11.md).
// The reachability law: every non-ferry gap must be clearable with the sim's
// actual jump arc; wide gaps must be bridgeable by their moving block.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { PHYS, JUMP_RANGE_FLAT } from './sim.js';
import type { Platform } from './track.js';
import {
  CHECKPOINT_STRIDE,
  MAX_GAP,
  MAX_JUMP_RISE,
  MAX_RAMP_SLOPE,
  PLATFORM_COUNT,
  buildTrack,
  dateSeed,
  edgeGap,
  movingBlockPose,
  platformTopY,
  todayDateKey,
} from './track.js';

describe('seed pipeline', () => {
  it('hashes a date string deterministically', () => {
    expect(dateSeed('2026-08-21')).toBe(dateSeed('2026-08-21'));
    expect(dateSeed('2026-08-21')).not.toBe(dateSeed('2026-08-22'));
    expect(Number.isInteger(dateSeed('1999-12-31'))).toBe(true);
  });

  it('todayDateKey is UTC yyyy-mm-dd', () => {
    const d = new Date(Date.UTC(2026, 7, 21, 23, 59, 59));
    expect(todayDateKey(d)).toBe('2026-08-21');
    expect(todayDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('buildTrack determinism', () => {
  it('same day-string → identical tracks', () => {
    const a = JSON.stringify(buildTrack('2026-08-21'));
    const b = JSON.stringify(buildTrack('2026-08-21'));
    expect(a).toBe(b);
  });

  it('different day-string → different track', () => {
    const a = buildTrack('2026-08-21');
    const b = buildTrack('2026-08-22');
    expect(a.seed).not.toBe(b.seed);
    expect(JSON.stringify(a.platforms)).not.toBe(JSON.stringify(b.platforms));
  });

  it('has the documented shape: 40 platforms, checkpoints every 8, finish pad', () => {
    const t = buildTrack('2026-08-21');
    expect(t.platforms.length).toBe(PLATFORM_COUNT);
    expect(t.platforms[0]?.kind).toBe('start');
    expect(t.platforms[PLATFORM_COUNT - 1]?.kind).toBe('finish');
    expect(t.movingBlocks.length).toBe(3);
    expect(t.checkpoints.length).toBe(PLATFORM_COUNT / CHECKPOINT_STRIDE);
    t.checkpoints.forEach((cp, i) => {
      expect(cp.i).toBe(i * CHECKPOINT_STRIDE);
      const p = t.platforms[cp.i];
      expect(p).toBeDefined();
      // checkpoint respawn sits on its platform footprint
      expect(Math.abs(cp.pos.x - (p as Platform).cx)).toBeLessThanOrEqual((p as Platform).hw);
      expect(Math.abs(cp.pos.z - (p as Platform).cz)).toBeLessThanOrEqual((p as Platform).hd);
    });
    expect(t.finishPos.x).toBeCloseTo(t.platforms[PLATFORM_COUNT - 1]!.cx, 5);
  });
});

describe('reachability sanity', () => {
  const t = buildTrack('2026-08-21');

  it('every ordinary gap fits inside the flat jump range with margin', () => {
    const ferryAfter = new Set([12, 23, 33]);
    for (let i = 1; i < t.platforms.length; i++) {
      const prev = t.platforms[i - 1]!;
      const cur = t.platforms[i]!;
      if (ferryAfter.has(i - 1)) continue; // moving-block section, tested below
      const gap = edgeGap(prev, cur);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(MAX_GAP);
      expect(MAX_GAP).toBeLessThan(JUMP_RANGE_FLAT); // design margin vs physics
      const rise = cur.y0 - prev.y1;
      expect(rise).toBeLessThanOrEqual(MAX_JUMP_RISE);
    }
  });

  it('ramps are walkable slopes, not walls', () => {
    for (const p of t.platforms) {
      if (p.rampAxis === 0) continue;
      const rise = Math.abs(p.y1 - p.y0);
      const run = (p.rampAxis === 1 ? p.hw : p.hd) * 2;
      expect(rise / run).toBeLessThanOrEqual(MAX_RAMP_SLOPE + 1e-9);
    }
  });

  it('wide gaps are covered by their ferry block at the travel extremes', () => {
    const ferryAfter = [12, 23, 33];
    expect(t.movingBlocks.length).toBe(ferryAfter.length);
    ferryAfter.forEach((afterIdx, k) => {
      const from = t.platforms[afterIdx]!;
      const to = t.platforms[afterIdx + 1]!;
      const blk = t.movingBlocks[k]!;
      const span =
        blk.axis === 'x' ? Math.abs(to.cx - from.cx) : Math.abs(to.cz - from.cz);
      const e2e = span - from.hd * 2; // ≈ edge-to-edge along travel
      // block edge reach at extremes overlaps both platform edges
      expect(blk.amp + blk.hd).toBeGreaterThanOrEqual(e2e / 2);
      expect(e2e).toBeGreaterThan(MAX_GAP); // genuinely needs the ferry
    });
  });

  it('the course stays floating in a sane height band', () => {
    for (const p of t.platforms) {
      expect(platformTopY(p)).toBeGreaterThanOrEqual(0.3);
      expect(platformTopY(p)).toBeLessThanOrEqual(12);
    }
  });
});

describe('movingBlockPose', () => {
  const t = buildTrack('2026-08-21');

  it('is deterministic and periodic per block', () => {
    const a = movingBlockPose(t, 3.3);
    const b = movingBlockPose(t, 3.3);
    expect(a).toEqual(b);

    const blk = t.movingBlocks[0]!;
    const period = (Math.PI * 2) / blk.omega;
    const p1 = movingBlockPose(t, 10)[0]!;
    const p2 = movingBlockPose(t, 10 + period)[0]!;
    expect(p1.x).toBeCloseTo(p2.x, 6);
    expect(p1.z).toBeCloseTo(p2.z, 6);
  });

  it('stays within its amplitude band around the base center', () => {
    for (let k = 0; k < t.movingBlocks.length; k++) {
      const blk = t.movingBlocks[k]!;
      for (let s = 0; s <= 20; s++) {
        const poses = movingBlockPose(t, (s / 4) * ((Math.PI * 2) / blk.omega));
        const pose = poses[k]!;
        const off = blk.axis === 'x' ? pose.x - blk.bx : pose.z - blk.bz;
        expect(Math.abs(off)).toBeLessThanOrEqual(blk.amp + 1e-9);
        expect(pose.y).toBe(blk.by);
      }
    }
  });
});
