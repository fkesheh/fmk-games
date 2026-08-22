// ============================================================================
// GHOSTRUN TRACK — pure, seeded, daily procedural course (specs/P11.md).
//
// Determinism law: every number derives from rng(dateSeed(dateKey)) —
// Math.random is a contract violation in gameplay/track code. The same UTC
// date string ALWAYS builds the same 40-platform course; a new day hashes to
// a new seed ("today's run").
//
// Layout: a centerline path of straight runs joined by gentle curves. Gaps
// between platforms are jumpable (see MAX_GAP vs sim.PHYS jump range), ramps
// are sloped slabs climbed via step-up, and three wide gaps are bridged by
// MOVING blocks whose pose is a pure function of time (deterministic phase).
// Checkpoints sit on every 8th platform (0, 8, 16, 24, 32); platform 39 is
// the finish pad.
// ============================================================================

import { rng, rngInt, rngRange } from '@platform/shared';

// ---- geometry vocabulary -----------------------------------------------------

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * One walkable slab. (cx, cz) is the footprint CENTER; hw/hd are half extents.
 * Tops are either flat (rampAxis 0, y0 === y1) or sloped along the x or z axis
 * where y0 is the LOW end's top height and y1 the HIGH end's. `thick` is the
 * slab thickness below the lowest top point.
 */
export interface Platform {
  readonly i: number;
  readonly cx: number;
  readonly cz: number;
  readonly hw: number;
  readonly hd: number;
  readonly y0: number;
  readonly y1: number;
  readonly thick: number;
  /** 0 = flat top, 1 = slope along x, 2 = slope along z. */
  readonly rampAxis: 0 | 1 | 2;
  /**
   * Which way the FAR end of travel points: +1 → y1 sits at the +axis edge,
   * -1 → at the −axis edge. Height lerps y0 (near end) → y1 (far end).
   */
  readonly rampDir: 1 | -1;
  readonly kind: 'start' | 'run' | 'finish';
}

/** A gap-bridging block that ferries along `axis` around its base center. */
export interface MovingBlock {
  readonly bx: number;
  readonly by: number; // CENTER y
  readonly bz: number;
  readonly hw: number;
  readonly hh: number;
  readonly hd: number;
  readonly axis: 'x' | 'z';
  readonly amp: number; // travel amplitude, units
  readonly omega: number; // rad/s
  readonly phase: number; // rad
}

/** A respawn point standing on platform index `i` (multiples of CHECKPOINT_STRIDE). */
export interface Checkpoint {
  readonly i: number;
  readonly pos: Vec3; // feet spawn
  readonly yaw: number; // facing down-track
}

export interface MovingPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Track {
  readonly dateKey: string;
  readonly seed: number;
  readonly platforms: readonly Platform[];
  readonly movingBlocks: readonly MovingBlock[];
  readonly checkpoints: readonly Checkpoint[];
  readonly startPos: Vec3;
  readonly startYaw: number;
  readonly finishPos: Vec3;
}

// ---- tuning (mirrored as assertions in track.test.ts) --------------------------

export const PLATFORM_COUNT = 40;
export const CHECKPOINT_STRIDE = 8;
/** Gap sections bridged ONLY by moving blocks (gap after these platform indices). */
const MOVING_AFTER: readonly number[] = [12, 23, 33];
/** Ramp platforms: `up` climbs away from the previous deck, `down` descends. */
const RAMP_AT: ReadonlyArray<{ at: number; up: boolean }> = [
  { at: 7, up: true },
  { at: 18, up: true },
  { at: 29, up: false },
];
/** Design bounds asserted by tests: edge-to-edge clearance / rise across jumps. */
export const MAX_GAP = 6.0;
export const MAX_JUMP_RISE = 0.55;
/** Max |climb|/run of a ramp — must stay inside the sim's step-up budget. */
export const MAX_RAMP_SLOPE = 0.38;

// ---- seed pipeline --------------------------------------------------------------

/** FNV-1a over the date string → uint32 seed. Same string, same seed, forever. */
export function dateSeed(dateKey: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < dateKey.length; i++) {
    h ^= dateKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** UTC calendar key 'yyyy-mm-dd' — the daily identity of the track. */
export function todayDateKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = `${now.getUTCMonth() + 1}`.padStart(2, '0');
  const d = `${now.getUTCDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---- queries ----------------------------------------------------------------------

/** Top surface height under (x,z), or null beyond `margin` outside the footprint. */
export function platformGroundY(p: Platform, x: number, z: number, margin = 0): number | null {
  if (Math.abs(x - p.cx) > p.hw + margin || Math.abs(z - p.cz) > p.hd + margin) return null;
  if (p.rampAxis === 0 || p.y1 === p.y0) return p.y0;
  if (p.rampAxis === 1) {
    const t = clamp01(((x - p.cx) / p.hw) * p.rampDir * 0.5 + 0.5);
    return p.y0 + (p.y1 - p.y0) * t;
  }
  const t = clamp01(((z - p.cz) / p.hd) * p.rampDir * 0.5 + 0.5);
  return p.y0 + (p.y1 - p.y0) * t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Bounding-box top/bottom (ramps included conservatively). */
export function platformTopY(p: Platform): number {
  return Math.max(p.y0, p.y1);
}
export function platformBottomY(p: Platform): number {
  return Math.min(p.y0, p.y1) - p.thick;
}

/** Pose centers of every moving block at time t (seconds). Pure + periodic. */
export function movingBlockPose(track: Track, t: number): readonly MovingPose[] {
  return track.movingBlocks.map((b) => {
    const off = b.amp * Math.sin(b.omega * t + b.phase);
    return {
      x: b.bx + (b.axis === 'x' ? off : 0),
      y: b.by,
      z: b.bz + (b.axis === 'z' ? off : 0),
    };
  });
}

/** Edge-to-edge AABB clearance between two platforms' footprints (≥ 0). */
export function edgeGap(a: Platform, b: Platform): number {
  const gx = Math.max(0, Math.abs(b.cx - a.cx) - (a.hw + b.hw));
  const gz = Math.max(0, Math.abs(b.cz - a.cz) - (a.hd + b.hd));
  return Math.hypot(gx, gz);
}

// ---- generation --------------------------------------------------------------------

interface WipPlatform {
  i: number;
  cx: number;
  cz: number;
  hw: number;
  hd: number;
  y0: number;
  y1: number;
  thick: number;
  rampAxis: 0 | 1 | 2;
  rampDir: 1 | -1;
  kind: 'start' | 'run' | 'finish';
}

/**
 * Build today's course from a UTC date key. Fully deterministic: identical
 * inputs produce structurally-identical tracks (asserted by tests).
 */
export function buildTrack(dateKey: string): Track {
  const seed = dateSeed(dateKey);
  const rand = rng(seed);

  const wip: WipPlatform[] = [];
  let heading = 0; // travel direction: forward = (sin h, cos h)
  let x = 0;
  let z = 0;
  let topY = 0;

  // heading plan: straightLeft counts straight platforms; then a gentle turn.
  let straightLeft = 4;
  let turnRate = 0;
  let turnLeft = 0;

  for (let i = 0; i < PLATFORM_COUNT; i++) {
    const kind: 'start' | 'run' | 'finish' =
      i === 0 ? 'start' : i === PLATFORM_COUNT - 1 ? 'finish' : 'run';

    // ---- footprint size ----
    let hw: number;
    let hd: number;
    if (kind === 'start') {
      hw = 3.4;
      hd = 3.4;
    } else if (kind === 'finish') {
      hw = 4.2;
      hd = 4.2;
    } else if (i % CHECKPOINT_STRIDE === 0) {
      hw = rngRange(rand, 2.3, 2.9); // checkpoint pads run generous
      hd = rngRange(rand, 2.8, 3.6);
    } else {
      hw = rngRange(rand, 1.7, 2.5);
      hd = rngRange(rand, 2.0, 3.1);
    }

    // ---- heading: gentle curves between straight runs ----
    if (i > 0) {
      if (turnLeft > 0) {
        heading += turnRate;
        turnLeft--;
      } else if (straightLeft > 0) {
        straightLeft--;
      } else {
        turnRate = (rand() < 0.5 ? -1 : 1) * rngRange(rand, 0.09, 0.17);
        turnLeft = rngInt(rand, 2, 4);
      }
    }

    // ---- gap + rise from the previous platform ----
    let gap = 0;
    let rise = 0;
    let rampAxis: 0 | 1 | 2 = 0;
    let rampDir: 1 | -1 = 1;
    const ramp = RAMP_AT.find((r) => r.at === i);
    if (i > 0) {
      if (MOVING_AFTER.includes(i - 1)) {
        gap = rngRange(rand, 9.6, 11.2); // bridged only by a moving block
      } else if (ramp !== undefined) {
        gap = 0.7; // nearly touching — you climb the ramp body
        // slope runs along the DOMINANT travel axis; the far end (along
        // heading) gets y1, and rampDir records which way "far" points.
        rampAxis = Math.abs(Math.sin(heading)) > Math.abs(Math.cos(heading)) ? 1 : 2;
        rampDir =
          (rampAxis === 1 ? Math.sin(heading) : Math.cos(heading)) >= 0 ? 1 : -1;
      } else {
        gap = rngRange(rand, 3.0, 5.1);
        rise = rngRange(rand, -0.9, MAX_JUMP_RISE);
      }
    }
    if (topY + rise < 0.3) rise = Math.max(rise, 0.3 - topY); // never sink into the void

    // ---- advance the centerline ----
    const prev = wip[wip.length - 1];
    const prevAlong = prev === undefined ? 0 : prev.hd;
    const dist = prevAlong + gap + hd;
    x += Math.sin(heading) * dist;
    z += Math.cos(heading) * dist;

    // ---- heights ----
    let y0 = topY + rise;
    let y1 = y0;
    if (ramp !== undefined && rampAxis !== 0) {
      const runLen = (rampAxis === 1 ? hw : hd) * 2;
      const climb =
        Math.min(rngRange(rand, 1.4, 2.1), MAX_RAMP_SLOPE * runLen) *
        (ramp.up ? 1 : -1);
      y1 = Math.max(0.4, y0 + climb); // never descend into the void
      topY = y1;
    } else {
      topY = y0;
    }

    wip.push({
      i,
      cx: x,
      cz: z,
      hw,
      hd,
      y0,
      y1,
      thick: 0.7,
      rampAxis,
      rampDir,
      kind,
    });
  }

  const platforms = wip as readonly Platform[];

  // ---- moving blocks: ferry across the three wide gaps ----
  const movingBlocks: MovingBlock[] = MOVING_AFTER.map((afterIdx) => {
    const from = platforms[afterIdx] as Platform;
    const to = platforms[afterIdx + 1] as Platform;
    const mx = (from.cx + to.cx) / 2;
    const mz = (from.cz + to.cz) / 2;
    // dominant travel axis decides which way the block ferries
    const axis: 'x' | 'z' = Math.abs(to.cx - from.cx) > Math.abs(to.cz - from.cz) ? 'x' : 'z';
    const span = axis === 'x' ? Math.abs(to.cx - from.cx) : Math.abs(to.cz - from.cz);
    const e2e = Math.max(0, span - from.hd * 2); // ≈ edge-to-edge along travel
    const hdB = 1.5;
    const amp = Math.max(1.5, e2e / 2 + 1.15 - hdB); // extremes overlap both edges
    return {
      bx: mx,
      by: platformTopY(from) - 0.12 - 0.4, // top sits just below the deck
      bz: mz,
      hw: 1.5,
      hh: 0.4,
      hd: hdB,
      axis,
      amp,
      omega: (Math.PI * 2) / rngRange(rand, 3.4, 4.2),
      phase: afterIdx * 1.13,
    };
  });

  // ---- checkpoints every stride + finish flag ----
  const checkpoints: Checkpoint[] = [];
  for (let c = 0; c < PLATFORM_COUNT; c += CHECKPOINT_STRIDE) {
    const p = platforms[c] as Platform;
    const nxt = platforms[Math.min(c + CHECKPOINT_STRIDE, PLATFORM_COUNT - 1)] as Platform;
    const dx = nxt.cx - p.cx;
    const dz = nxt.cz - p.cz;
    // house convention: forward = (-sin yaw, -cos yaw)
    const yaw = Math.atan2(-dx, -dz);
    checkpoints.push({ i: c, pos: { x: p.cx, y: platformTopY(p), z: p.cz }, yaw });
  }
  const last = platforms[PLATFORM_COUNT - 1] as Platform;

  const first = platforms[0] as Platform;
  const startNext = platforms[1] as Platform;
  const startYaw = Math.atan2(
    -(startNext.cx - first.cx),
    -(startNext.cz - first.cz),
  );

  return {
    dateKey,
    seed,
    platforms,
    movingBlocks,
    checkpoints,
    startPos: { x: first.cx, y: platformTopY(first), z: first.cz },
    startYaw,
    finishPos: { x: last.cx, y: platformTopY(last), z: last.cz },
  };
}
