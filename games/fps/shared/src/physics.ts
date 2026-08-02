// ============================================================================
// FROZEN CONTRACT — shared movement/collision/raycast primitives.
// Used by: server authoritative sim, client prediction, combat raycasts.
// Deterministic: same inputs => same outputs on both sides. No I/O, no Date.
// ============================================================================
import { NET, PLAYER, TICK_RATE } from './config.js';
import type { Vec3 } from './types.js';

/** Axis-aligned box. All collision + bullet blocking uses these. */
export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

/** Center+size box as authored in map data. */
export interface BoxDefLike {
  x: number; y: number; z: number; // center
  w: number; h: number; d: number; // full extents
}

export function boxToAABB(b: BoxDefLike): AABB {
  return {
    minX: b.x - b.w / 2, minY: b.y - b.h / 2, minZ: b.z - b.d / 2,
    maxX: b.x + b.w / 2, maxY: b.y + b.h / 2, maxZ: b.z + b.d / 2,
  };
}

export interface MoveInput {
  moveX: number; // -1..1 strafe right+
  moveZ: number; // -1..1 forward+
  yaw: number;
  jump: boolean;
  crouch: boolean;
  walk: boolean; // Shift walk: slower + quieter
}

/** Mutable body state advanced by stepBody. x/y/z = FEET position. */
export interface BodyState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  height: number; // current collision height (stand/crouch blend is discrete)
  onGround: boolean;
}

export function makeBody(x: number, y: number, z: number): BodyState {
  return { x, y, z, vx: 0, vy: 0, vz: 0, height: PLAYER.heightStand, onGround: true };
}

export function eyePos(b: BodyState): Vec3 {
  return { x: b.x, y: b.y + b.height - PLAYER.eyeOffset, z: b.z };
}

function overlaps(b: BodyState, s: AABB, pad = 0): boolean {
  return (
    b.x - PLAYER.radius - pad < s.maxX && b.x + PLAYER.radius + pad > s.minX &&
    b.y < s.maxY && b.y + b.height > s.minY &&
    b.z - PLAYER.radius - pad < s.maxZ && b.z + PLAYER.radius + pad > s.minZ
  );
}

/**
 * Advance one body one step with collide-and-slide vs solids.
 * - Horizontal velocity is set directly from input (Quake-lite, no accel):
 *   wish dir rotated by yaw, magnitude PLAYER.speedRun * speedMul * (crouch? crouchMul).
 * - Crouch sets height; standing up under a low ceiling is blocked.
 * - Step-up: if a horizontal move is blocked and onGround, retry lifted by
 *   PLAYER.stepUp and settle down; allows stairs of <= stepUp boxes.
 * - World floor: y clamps at 0 (y < 0 => y = 0, onGround).
 * Mutates and returns b. dt in seconds; callers pass fixed TICK_DT.
 */
export function stepBody(b: BodyState, inp: MoveInput, speedMul: number, dt: number, solids: AABB[]): BodyState {
  // --- crouch/stand ---
  const targetHeight = inp.crouch ? PLAYER.heightCrouch : PLAYER.heightStand;
  if (targetHeight !== b.height) {
    if (targetHeight < b.height) {
      b.height = targetHeight;
    } else {
      // only stand if no solid overlaps the taller volume
      const grown = { ...b, height: targetHeight };
      if (!solids.some((s) => overlaps(grown, s))) b.height = targetHeight;
    }
  }

  // --- horizontal wish velocity (instant, deterministic) ---
  const sin = Math.sin(inp.yaw);
  const cos = Math.cos(inp.yaw);
  // forward = (-sin(yaw), -cos(yaw)) so yaw=0 faces -Z; strafe right = (cos, -sin)
  let wx = -sin * inp.moveZ + cos * inp.moveX;
  let wz = -cos * inp.moveZ - sin * inp.moveX;
  const len = Math.hypot(wx, wz);
  if (len > 1) { wx /= len; wz /= len; }
  const speed = PLAYER.speedRun * speedMul * (inp.crouch ? PLAYER.crouchSpeedMul : inp.walk ? PLAYER.walkSpeedMul : 1);
  b.vx = wx * speed;
  b.vz = wz * speed;

  // --- vertical ---
  if (inp.jump && b.onGround) {
    b.vy = PLAYER.jumpVel;
    b.onGround = false;
  }
  b.vy -= PLAYER.gravity * dt;
  if (b.vy < -40) b.vy = -40; // terminal velocity

  // --- integrate axis by axis ---
  moveHorizontal(b, b.vx * dt, 0, solids);
  moveHorizontal(b, 0, b.vz * dt, solids);

  b.y += b.vy * dt;
  b.onGround = false;
  for (const s of solids) {
    if (!overlaps(b, s)) continue;
    if (b.vy <= 0 && b.y < s.maxY && b.y > s.maxY - 1.2) {
      // landed on top
      b.y = s.maxY;
      b.vy = 0;
      b.onGround = true;
    } else if (b.vy > 0 && b.y + b.height > s.minY && b.y + b.height < s.minY + 1.2) {
      // bonked head
      b.y = s.minY - b.height;
      b.vy = 0;
    } else {
      // deep overlap (e.g. teleported into a box): push out along smallest penetration
      pushOut(b, s);
    }
  }

  // --- world floor ---
  if (b.y <= 0) {
    b.y = 0;
    if (b.vy < 0) b.vy = 0;
    b.onGround = true;
  }
  return b;
}

function moveHorizontal(b: BodyState, dx: number, dz: number, solids: AABB[]): void {
  if (dx === 0 && dz === 0) return;
  b.x += dx;
  b.z += dz;
  for (const s of solids) {
    if (!overlaps(b, s)) continue;
    if (b.onGround && s.maxY - b.y <= PLAYER.stepUp && s.maxY - b.y > 0) {
      // step-up assist: only if the ledge top is within reach and has headroom
      const lifted = { ...b, y: s.maxY };
      if (!solids.some((o) => o !== s && overlaps(lifted, o))) {
        b.y = s.maxY;
        continue;
      }
    }
    if (dx > 0) b.x = s.minX - PLAYER.radius;
    else if (dx < 0) b.x = s.maxX + PLAYER.radius;
    if (dz > 0) b.z = s.minZ - PLAYER.radius;
    else if (dz < 0) b.z = s.maxZ + PLAYER.radius;
  }
}

function pushOut(b: BodyState, s: AABB): void {
  const candidates: Array<[number, () => void]> = [
    [s.maxX + PLAYER.radius - b.x, () => { b.x = s.maxX + PLAYER.radius; }],
    [b.x - (s.minX - PLAYER.radius), () => { b.x = s.minX - PLAYER.radius; }],
    [s.maxY - b.y, () => { b.y = s.maxY; b.vy = 0; b.onGround = true; }],
    [b.y + b.height - s.minY, () => { b.y = s.minY - b.height; b.vy = 0; }],
    [s.maxZ + PLAYER.radius - b.z, () => { b.z = s.maxZ + PLAYER.radius; }],
    [b.z - (s.minZ - PLAYER.radius), () => { b.z = s.minZ - PLAYER.radius; }],
  ];
  let best: (() => void) | null = null;
  let bestPen = Infinity;
  for (const [pen, apply] of candidates) {
    if (pen > 0 && pen < bestPen) { bestPen = pen; best = apply; }
  }
  if (best) best();
}

// ---------------------------------------------------------------------------
// Raycasts. dir MUST be normalized. Returns distance along ray or -1.
// ---------------------------------------------------------------------------

export function raycastAABB(o: Vec3, d: Vec3, s: AABB, maxDist: number): number {
  let tmin = 0;
  let tmax = maxDist;
  const axes: Array<[number, number, number, number]> = [
    [o.x, d.x, s.minX, s.maxX],
    [o.y, d.y, s.minY, s.maxY],
    [o.z, d.z, s.minZ, s.maxZ],
  ];
  for (const [oc, dc, mn, mx] of axes) {
    if (Math.abs(dc) < 1e-9) {
      if (oc < mn || oc > mx) return -1;
    } else {
      let t1 = (mn - oc) / dc;
      let t2 = (mx - oc) / dc;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
  }
  return tmin <= maxDist ? tmin : -1;
}

/** Nearest solid hit distance, or -1. */
export function raycastSolids(o: Vec3, d: Vec3, solids: AABB[], maxDist: number): number {
  let best = -1;
  for (const s of solids) {
    const t = raycastAABB(o, d, s, maxDist);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

/**
 * Height of the head hitbox: the head is the TOP `HEAD_BOX_H` metres of a body,
 * standing or crouched. Exported because the bot aim point (server/src/bots.ts)
 * is defined relative to the head box; a private copy of this number there
 * could silently drift away from the hitbox the hitscan actually tests.
 */
export const HEAD_BOX_H = 0.3;

/** Player hitboxes at a feet position. head = top HEAD_BOX_H m, body = rest. */
export function playerHitboxes(x: number, y: number, z: number, height: number): { head: AABB; body: AABB } {
  const r = PLAYER.radius;
  const headH = HEAD_BOX_H;
  return {
    head: { minX: x - r * 0.8, minY: y + height - headH, minZ: z - r * 0.8, maxX: x + r * 0.8, maxY: y + height, maxZ: z + r * 0.8 },
    body: { minX: x - r, minY: y, minZ: z - r, maxX: x + r, maxY: y + height - headH, maxZ: z + r },
  };
}

export interface HitscanTarget {
  id: string;
  x: number; y: number; z: number; // feet
  height: number;
}

export interface HitResult {
  targetId: string;
  dist: number;
  headshot: boolean;
  point: Vec3;
}

/**
 * Hitscan vs players, blocked by solids. Returns the CLOSEST player hit that
 * is nearer than any solid, or null. origin is the shooter's eye.
 */
export function hitscan(
  origin: Vec3,
  dir: Vec3,
  targets: HitscanTarget[],
  solids: AABB[],
  maxDist: number,
): HitResult | null {
  const wallDist = raycastSolids(origin, dir, solids, maxDist);
  const limit = wallDist >= 0 ? wallDist : maxDist;
  let best: HitResult | null = null;
  for (const tgt of targets) {
    const hb = playerHitboxes(tgt.x, tgt.y, tgt.z, tgt.height);
    const headT = raycastAABB(origin, dir, hb.head, limit);
    const bodyT = raycastAABB(origin, dir, hb.body, limit);
    let dist = -1;
    let headshot = false;
    if (headT >= 0 && (bodyT < 0 || headT <= bodyT)) { dist = headT; headshot = true; }
    else if (bodyT >= 0) { dist = bodyT; }
    if (dist >= 0 && dist <= limit && (best === null || dist < best.dist)) {
      best = {
        targetId: tgt.id,
        dist,
        headshot,
        point: { x: origin.x + dir.x * dist, y: origin.y + dir.y * dist, z: origin.z + dir.z * dist },
      };
    }
  }
  return best;
}

/** Falloff multiplier for a hit at distance dist given weapon range config. */
export function falloffMul(dist: number, rangeStart: number, rangeEnd: number, minDmgMul: number): number {
  if (dist <= rangeStart) return 1;
  if (dist >= rangeEnd) return minDmgMul;
  const k = (dist - rangeStart) / (rangeEnd - rangeStart);
  return 1 - k * (1 - minDmgMul);
}

/**
 * THE lag-compensation formula (frozen). How far behind the server's current
 * tick a shooter's view of the world runs: one-way latency (rtt/2) plus the
 * remote-entity interpolation delay the shooter renders at. Clamp to
 * NET.lagCompMaxMs. Server uses: lagBuffer.at(currentTick - rewindTicks(rtt)).
 */
export function rewindTicks(rttMs: number): number {
  const tickMs = 1000 / TICK_RATE;
  const ms = Math.min(NET.lagCompMaxMs, Math.max(0, rttMs / 2 + NET.interpDelayMs));
  return Math.round(ms / tickMs);
}

/** Unit vector from yaw/pitch (same convention as input: yaw 0 = -Z). */
export function aimDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Apply spread (degrees, half-angle) to a direction using a seeded rng. */
export function applySpread(dir: Vec3, spreadDeg: number, next: () => number): Vec3 {
  if (spreadDeg <= 0) return dir;
  const rad = (spreadDeg * Math.PI) / 180;
  const angle = next() * Math.PI * 2;
  const mag = Math.sqrt(next()) * Math.tan(rad);
  // build an orthonormal basis around dir
  const up: Vec3 = Math.abs(dir.y) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const right = norm(cross(dir, up));
  const up2 = cross(right, dir);
  return norm({
    x: dir.x + right.x * Math.cos(angle) * mag + up2.x * Math.sin(angle) * mag,
    y: dir.y + right.y * Math.cos(angle) * mag + up2.y * Math.sin(angle) * mag,
    z: dir.z + right.z * Math.cos(angle) * mag + up2.z * Math.sin(angle) * mag,
  });
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
