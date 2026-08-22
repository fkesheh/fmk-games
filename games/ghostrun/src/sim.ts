// ============================================================================
// GHOSTRUN SIM — pure character controller (specs/P11.md rules block).
//
// No DOM, no three, no clock: `step(state, input, dt)` advances a fixed-dt
// world. Movement law: run 10 u/s · jump v=8.5 · g=−22 · coyote 0.12 s ·
// air control 0.6. Collision is AABB vs platform slabs (ramps are sloped
// tops queried through platformGroundY) plus the moving ferry blocks whose
// pose comes from track.movingBlockPose(t) — riders are carried along.
// Fall below (checkpoint top − 12) respawns at the last checkpoint and adds
// a +1 s penalty to the FINAL time (the run clock itself never stops).
//
// Recording: every 100 ms one [t, x, y, z, yaw] row lands in growable plain
// arrays — the exact blob shape that later becomes save slot 'ghost'.
// ============================================================================

import type { Track } from './track.js';
import { CHECKPOINT_STRIDE, movingBlockPose, platformGroundY } from './track.js';

// ---- tuning -----------------------------------------------------------------

export const PHYS = {
  /** Horizontal run speed, units/s. */
  runSpeed: 10,
  /** Jump launch velocity, units/s upward. */
  jumpVel: 8.5,
  /** Gravity acceleration, units/s². */
  gravity: -22,
  /** Grace window after walking off an edge, seconds. */
  coyoteSec: 0.12,
  /** Fraction of ground acceleration available mid-air. */
  airControl: 0.6,
  /** Ground acceleration toward wish velocity, units/s². */
  groundAccel: 60,
  /** Ground deceleration with no input, units/s². */
  frictionDecel: 45,
  /** Ledge heights up to this are climbed automatically, units. */
  stepUpMax: 0.55,
  /** Down-steps up to this stay glued to the feet, units. */
  snapDownMax: 0.35,
  /** Fall this far below the active checkpoint top → respawn. */
  fallLimit: 12,
  /** Penalty added to the final time per death, ms. */
  penaltyMs: 1000,
  /** Recording cadence, ms. */
  sampleIntervalMs: 100,
  /** Player capsule approximated as this AABB. */
  radius: 0.35,
  height: 1.15,
  eyeHeight: 0.85,
} as const;

/** Flat-ground maximum jump clearance (informational; track gaps stay under it). */
export const JUMP_RANGE_FLAT = (PHYS.runSpeed * 2 * PHYS.jumpVel) / -PHYS.gravity;

// ---- recording blobs -----------------------------------------------------------

/** Growable sample rows — the plain-object replay format saved to slot 'ghost'. */
export interface GhostSamples {
  readonly t: number[];
  readonly x: number[];
  readonly y: number[];
  readonly z: number[];
  readonly yaw: number[];
}

export function emptySamples(): GhostSamples {
  return { t: [], x: [], y: [], z: [], yaw: [] };
}

/** Round to 2 decimals — keeps a multi-minute replay comfortably under quota. */
export function quantize2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function quantizeSamples(s: GhostSamples): GhostSamples {
  return {
    t: s.t.map(quantize2),
    x: s.x.map(quantize2),
    y: s.y.map(quantize2),
    z: s.z.map(quantize2),
    yaw: s.yaw.map(quantize2),
  };
}

export interface GhostPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

/** Interpolate the replay at tMs (clamped to the recorded span); null if empty. */
export function sampleGhost(s: GhostSamples, tMs: number): GhostPose | null {
  const n = s.t.length;
  if (n === 0) return null;
  if (n === 1 || tMs <= (s.t[0] as number)) {
    return poseAt(s, 0);
  }
  if (tMs >= (s.t[n - 1] as number)) return poseAt(s, n - 1);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((s.t[mid] as number) <= tMs) lo = mid;
    else hi = mid;
  }
  const t0 = s.t[lo] as number;
  const t1 = s.t[hi] as number;
  const f = t1 > t0 ? (tMs - t0) / (t1 - t0) : 0;
  return {
    x: lerp(s.x[lo] as number, s.x[hi] as number, f),
    y: lerp(s.y[lo] as number, s.y[hi] as number, f),
    z: lerp(s.z[lo] as number, s.z[hi] as number, f),
    yaw: angleLerp(s.yaw[lo] as number, s.yaw[hi] as number, f),
  };
}

function poseAt(s: GhostSamples, i: number): GhostPose {
  return {
    x: s.x[i] as number,
    y: s.y[i] as number,
    z: s.z[i] as number,
    yaw: s.yaw[i] as number,
  };
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

function angleLerp(a: number, b: number, f: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

// ---- state ---------------------------------------------------------------------

export type SimEventType = 'jump' | 'land' | 'checkpoint' | 'respawn' | 'finish';

export interface SimEvent {
  readonly kind: SimEventType;
  /** Platform/checkpoint index when relevant, else -1. */
  readonly i: number;
}

export interface SimInput {
  /** Camera-relative strafe axis, -1..1. */
  readonly mx: number;
  /** Forward intent, -1..1 (+1 = forward). */
  readonly mz: number;
  /** Jump button HELD (edges detected internally). */
  readonly jump: boolean;
}

export interface SimState {
  readonly track: Track;
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  yaw: number;
  onGround: boolean;
  /** 'plat' grounds on platforms[i], 'block' on movingBlocks[groundIndex]. */
  groundKind: 'none' | 'plat' | 'block';
  groundIndex: number;
  coyote: number;
  airTime: number;
  /** Run clock, counts up. Penalties do NOT stop it. */
  timeMs: number;
  penaltyMs: number;
  finished: boolean;
  /** Highest checkpoint reached (platform index, multiple of CHECKPOINT_STRIDE). */
  lastCp: number;
  respawns: number;
  readonly samples: GhostSamples;
  lastSampleT: number;
  prevJump: boolean;
  readonly events: SimEvent[];
}

export function createSim(track: Track): SimState {
  const st: SimState = {
    track,
    pos: { x: track.startPos.x, y: track.startPos.y, z: track.startPos.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: track.startYaw,
    onGround: true,
    groundKind: 'plat',
    groundIndex: 0,
    coyote: PHYS.coyoteSec,
    airTime: 0,
    timeMs: 0,
    penaltyMs: 0,
    finished: false,
    lastCp: 0,
    respawns: 0,
    samples: { t: [0], x: [track.startPos.x], y: [track.startPos.y], z: [track.startPos.z], yaw: [track.startYaw] },
    lastSampleT: 0,
    prevJump: false,
    events: [],
  };
  return st;
}

/** Scoreboard number: clock plus every death penalty. */
export function finalTimeMs(st: SimState): number {
  return st.timeMs + st.penaltyMs;
}

export function drainEvents(st: SimState): SimEvent[] {
  if (st.events.length === 0) return [];
  return st.events.splice(0, st.events.length);
}

// ---- stepping --------------------------------------------------------------------

/**
 * Advance the world by dt seconds (fixed-step; the Loop feeds 1/60).
 * Safe to call after finish() — the world simply freezes.
 */
export function step(st: SimState, input: SimInput, dt: number): void {
  if (st.finished || dt <= 0) return;
  const track = st.track;

  // ---- clock + ferry carry -----------------------------------------------------
  const tPrevS = st.timeMs / 1000;
  st.timeMs += dt * 1000;
  const posesPrev = movingBlockPose(track, tPrevS);
  const posesNow = movingBlockPose(track, st.timeMs / 1000);
  if (st.groundKind === 'block') {
    const b = posesNow[st.groundIndex];
    const o = posesPrev[st.groundIndex];
    if (b !== undefined && o !== undefined) {
      st.pos.x += b.x - o.x;
      st.pos.z += b.z - o.z;
    }
  }

  // ---- wish velocity (camera-relative) ------------------------------------------
  const fx = -Math.sin(st.yaw);
  const fz = -Math.cos(st.yaw);
  const rx = Math.cos(st.yaw);
  const rz = -Math.sin(st.yaw);
  const wx = fx * input.mz + rx * input.mx;
  const wz = fz * input.mz + rz * input.mx;
  const wl = Math.hypot(wx, wz);
  const hasIntent = wl > 0.01;
  let tvx = 0;
  let tvz = 0;
  if (hasIntent) {
    const s = Math.min(1, wl) / wl;
    tvx = wx * s * PHYS.runSpeed;
    tvz = wz * s * PHYS.runSpeed;
  }
  const rate = (st.onGround ? PHYS.groundAccel : PHYS.groundAccel * PHYS.airControl) * dt;
  if (hasIntent || st.onGround) {
    st.vel.x = approach(st.vel.x, tvx, rate);
    st.vel.z = approach(st.vel.z, tvz, rate);
  }

  // ---- coyote + jump --------------------------------------------------------------
  if (st.onGround) st.coyote = PHYS.coyoteSec;
  else st.coyote = Math.max(0, st.coyote - dt);

  const jumpPressed = input.jump && !st.prevJump;
  st.prevJump = input.jump;
  if (jumpPressed && (st.onGround || st.coyote > 0)) {
    st.vel.y = PHYS.jumpVel;
    st.onGround = false;
    st.groundKind = 'none';
    st.coyote = 0;
    st.events.push({ kind: 'jump', i: -1 });
  }

  // ---- integrate --------------------------------------------------------------------
  st.vel.y = Math.max(-42, st.vel.y + PHYS.gravity * dt);
  const prevY = st.pos.y;
  st.pos.x += st.vel.x * dt;
  st.pos.y += st.vel.y * dt;
  st.pos.z += st.vel.z * dt;

  // ---- ground resolve ------------------------------------------------------------------
  interface Cand {
    gy: number;
    kind: 'plat' | 'block';
    idx: number;
  }
  const cands: Cand[] = [];
  const m = PHYS.radius * 0.6; // forgiveness margin around footprints
  for (const p of track.platforms) {
    const gy = platformGroundY(p, st.pos.x, st.pos.z, m);
    if (gy !== null) {
      cands.push({ gy, kind: 'plat', idx: p.i });
    }
  }
  for (let bi = 0; bi < posesNow.length; bi++) {
    const pose = posesNow[bi] as { x: number; y: number; z: number };
    const blk = track.movingBlocks[bi] as { hw: number; hh: number; hd: number };
    if (
      Math.abs(st.pos.x - pose.x) <= blk.hw + m &&
      Math.abs(st.pos.z - pose.z) <= blk.hd + m
    ) {
      cands.push({ gy: pose.y + blk.hh, kind: 'block', idx: bi });
    }
  }

  const wasGrounded = st.onGround;
  let landed: Cand | null = null;
  if (st.vel.y <= 0.0001) {
    for (const c of cands) {
      if (prevY >= c.gy - 0.05 && st.pos.y <= c.gy + 0.001) {
        if (landed === null || c.gy > landed.gy) landed = c;
      }
    }
  }
  let support: Cand | null = landed;
  if (support === null && wasGrounded) {
    for (const c of cands) {
      if (c.gy <= st.pos.y + PHYS.stepUpMax && c.gy >= st.pos.y - PHYS.snapDownMax) {
        if (support === null || c.gy > support.gy) support = c;
      }
    }
  }
  if (support !== null) {
    st.pos.y = support.gy;
    st.vel.y = 0;
    if (!wasGrounded) st.events.push({ kind: 'land', i: support.kind === 'plat' ? support.idx : -1 });
    st.onGround = true;
    st.groundKind = support.kind;
    st.groundIndex = support.idx;
    st.airTime = 0;
  } else {
    st.onGround = false;
    st.groundKind = 'none';
    st.airTime += dt;
  }

  // ---- walls: push out of anything too tall to step ------------------------------------
  for (const p of track.platforms) {
    const top = Math.max(p.y0, p.y1);
    const bottom = Math.min(p.y0, p.y1) - p.thick;
    pushOut(st, p.cx, p.cz, p.hw, p.hd, bottom, top);
  }
  for (let bi = 0; bi < posesNow.length; bi++) {
    const pose = posesNow[bi] as { x: number; y: number; z: number };
    const blk = track.movingBlocks[bi] as { hw: number; hh: number; hd: number };
    if (st.groundKind === 'block' && st.groundIndex === bi) continue; // riding it
    pushOut(st, pose.x, pose.z, blk.hw, blk.hd, pose.y - blk.hh, pose.y + blk.hh);
  }

  // ---- progress: checkpoints + finish ------------------------------------------------------
  if (st.onGround && st.groundKind === 'plat') {
    const p = track.platforms[st.groundIndex];
    if (p !== undefined) {
      const cpBase = Math.floor(p.i / CHECKPOINT_STRIDE) * CHECKPOINT_STRIDE;
      if (cpBase > st.lastCp) {
        st.lastCp = cpBase;
        st.events.push({ kind: 'checkpoint', i: cpBase });
      }
      if (p.kind === 'finish') {
        st.finished = true;
        st.events.push({ kind: 'finish', i: p.i });
      }
    }
  }

  // ---- the void -------------------------------------------------------------------------------
  const cp = track.checkpoints.find((c) => c.i === st.lastCp) ?? track.checkpoints[0];
  if (cp !== undefined && st.pos.y < cp.pos.y - PHYS.fallLimit) {
    respawn(st);
  }

  // ---- recorder: strict 100 ms cadence -----------------------------------------------------------
  while (st.timeMs - st.lastSampleT >= PHYS.sampleIntervalMs) {
    st.lastSampleT += PHYS.sampleIntervalMs;
    st.samples.t.push(st.lastSampleT);
    st.samples.x.push(st.pos.x);
    st.samples.y.push(st.pos.y);
    st.samples.z.push(st.pos.z);
    st.samples.yaw.push(st.yaw);
  }
}

/** Death: back to the last checkpoint, +1 s on the final scoreboard. */
function respawn(st: SimState): void {
  const cp =
    st.track.checkpoints.find((c) => c.i === st.lastCp) ?? st.track.checkpoints[0];
  if (cp !== undefined) {
    st.pos.x = cp.pos.x;
    st.pos.y = cp.pos.y;
    st.pos.z = cp.pos.z;
    st.yaw = cp.yaw;
  }
  st.vel.x = 0;
  st.vel.y = 0;
  st.vel.z = 0;
  st.onGround = true;
  st.groundKind = 'plat';
  st.groundIndex = st.lastCp;
  st.coyote = PHYS.coyoteSec;
  st.penaltyMs += PHYS.penaltyMs;
  st.respawns++;
  st.events.push({ kind: 'respawn', i: st.lastCp });
}

/** Push a body out of one axis-aligned slab along the shallowest axis. */
function pushOut(
  st: SimState,
  cx: number,
  cz: number,
  hw: number,
  hd: number,
  bottom: number,
  top: number,
): void {
  if (top <= st.pos.y + PHYS.stepUpMax) return; // low enough to step/climb — not a wall
  if (bottom >= st.pos.y + PHYS.height) return; // fully above the head
  const ex = hw + PHYS.radius;
  const ez = hd + PHYS.radius;
  const dx = st.pos.x - cx;
  const dz = st.pos.z - cz;
  if (Math.abs(dx) >= ex || Math.abs(dz) >= ez) return;
  const px = ex - Math.abs(dx);
  const pz = ez - Math.abs(dz);
  if (px <= pz) {
    st.pos.x += dx >= 0 ? px : -px;
    if (Math.sign(st.vel.x) === -Math.sign(dx || 1)) st.vel.x = 0;
  } else {
    st.pos.z += dz >= 0 ? pz : -pz;
    if (Math.sign(st.vel.z) === -Math.sign(dz || 1)) st.vel.z = 0;
  }
}

function approach(v: number, target: number, maxDelta: number): number {
  const d = target - v;
  if (d > maxDelta) return v + maxDelta;
  if (d < -maxDelta) return v - maxDelta;
  return target;
}
