// ============================================================================
// FROZEN CONTRACT — balance & tuning. Pure data, no logic. See CONTRACT.md.
// ============================================================================
import type { WeaponId } from './types.js';

export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
export const MAX_PLAYERS = 10; // 5v5
export const MIN_PLAYERS_FOR_MATCH = 2;
export const PRIVATE_CODE_LEN = 5; // A-Z0-9 join code
export const MAX_ROOMS = 64;

export const PLAYER = {
  radius: 0.3, // horizontal half-extent (player is an AABB)
  heightStand: 1.8,
  heightCrouch: 1.3,
  eyeOffset: 0.18, // eye = feet + height - eyeOffset
  speedRun: 4.8, // m/s at moveMul 1.0
  crouchSpeedMul: 0.45,
  walkSpeedMul: 0.55, // Shift walk: slow AND quiet (footstep volume x0.4 client-side)
  jumpVel: 5.9, // m/s vertical (~0.87m apex — clears 0.8 docks, not 1.2 crates)
  gravity: 20, // m/s^2
  stepUp: 0.42, // max ledge auto-step height
  maxHp: 100,
} as const;

export const NET = {
  pingEveryMs: 2000,
  interpDelayMs: 120, // remote-entity render delay behind latest snapshot
  interpMaxExtrapolateMs: 100,
  lagCompMaxMs: 250, // clamp for shooter rewind
  lagBufferTicks: 64, // ~2.1s of position history per player
  maxInputPerTick: 4, // anti-speedhack: max consumed client inputs per tick
  inputQueueCap: 90, // ~3s of queued inputs per player; older ones are dropped
  inputTimeoutMs: 5000, // no input for this long => disconnect
} as const;

export const ECONOMY = {
  start: 800,
  killReward: 300,
  winReward: 3250,
  lossReward: 1900,
  max: 16000,
} as const;

export const ROUNDS = {
  freezeTime: 3, // s, buy-only, no movement/damage
  buyTime: 12, // s into 'live' during which canBuy stays true
  roundTime: 100, // s of 'live'
  roundEndTime: 4, // s of 'roundEnd' before next freeze
  winRounds: 6, // first to this many round wins takes the match
  maxRounds: 10, // hard cap; higher score wins; tie => CT wins the match
  halftimeAfter: 5, // swap sides after this many rounds
  warmupRespawnDelay: 2, // s
  spawnProtection: 1.5, // s of invulnerability after any (re)spawn
} as const;

export interface WeaponDef {
  id: WeaponId;
  name: string; // display name
  price: number; // 0 = issued free
  damage: number; // per pellet/bullet, before headshot/falloff
  headshotMul: number;
  interval: number; // min seconds between shots
  auto: boolean; // hold-to-fire
  mag: number; // -1 = melee (no ammo)
  reserve: number; // -1 = melee
  reload: number; // s
  spreadDeg: number; // base hip spread (half-angle, degrees)
  scopedSpreadDeg: number | null; // spread while scoped (sniper only), else null
  spreadPerShot: number; // added per consecutive shot
  maxSpreadDeg: number;
  spreadRecover: number; // degrees/s recovery
  pellets: number; // >1 only for shotgun
  rangeStart: number; // m, full damage up to here
  rangeEnd: number; // m, damage decays linearly to minDmgMul here
  minDmgMul: number;
  moveMul: number; // movement speed multiplier while held
  zoomFov: number | null; // scoped camera fov (deg), null = no scope
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  knife: {
    id: 'knife', name: 'Knife', price: 0,
    damage: 40, headshotMul: 1.5, interval: 0.8, auto: false,
    mag: -1, reserve: -1, reload: 0,
    spreadDeg: 0, scopedSpreadDeg: null, spreadPerShot: 0, maxSpreadDeg: 0, spreadRecover: 0,
    pellets: 1, rangeStart: 2.2, rangeEnd: 2.4, minDmgMul: 1, moveMul: 1.0, zoomFov: null,
  },
  pistol: {
    id: 'pistol', name: 'P9 Sidearm', price: 0,
    damage: 25, headshotMul: 3, interval: 0.17, auto: false,
    mag: 12, reserve: 48, reload: 2.0,
    spreadDeg: 1.2, scopedSpreadDeg: null, spreadPerShot: 0.4, maxSpreadDeg: 4, spreadRecover: 8,
    pellets: 1, rangeStart: 18, rangeEnd: 36, minDmgMul: 0.5, moveMul: 0.98, zoomFov: null,
  },
  smg: {
    id: 'smg', name: 'K90 SMG', price: 1500,
    damage: 21, headshotMul: 2.5, interval: 0.08, auto: true,
    mag: 30, reserve: 120, reload: 2.4,
    spreadDeg: 1.6, scopedSpreadDeg: null, spreadPerShot: 0.5, maxSpreadDeg: 6, spreadRecover: 9,
    pellets: 1, rangeStart: 14, rangeEnd: 30, minDmgMul: 0.4, moveMul: 0.95, zoomFov: null,
  },
  shotgun: {
    id: 'shotgun', name: 'M870 Breacher', price: 1100,
    damage: 12, headshotMul: 1.5, interval: 0.9, auto: false,
    mag: 7, reserve: 32, reload: 3.2,
    spreadDeg: 4.5, scopedSpreadDeg: null, spreadPerShot: 1.0, maxSpreadDeg: 7, spreadRecover: 6,
    pellets: 9, rangeStart: 6, rangeEnd: 18, minDmgMul: 0.2, moveMul: 0.92, zoomFov: null,
  },
  rifle: {
    id: 'rifle', name: 'AK-4 Rifle', price: 2700,
    damage: 33, headshotMul: 4, interval: 0.1, auto: true,
    mag: 30, reserve: 90, reload: 2.6,
    spreadDeg: 1.0, scopedSpreadDeg: null, spreadPerShot: 0.55, maxSpreadDeg: 5.5, spreadRecover: 7,
    pellets: 1, rangeStart: 22, rangeEnd: 44, minDmgMul: 0.8, moveMul: 0.9, zoomFov: null,
  },
  sniper: {
    id: 'sniper', name: 'AWM Sniper', price: 4750,
    damage: 115, headshotMul: 2, interval: 1.5, auto: false,
    mag: 5, reserve: 30, reload: 3.2,
    spreadDeg: 8, scopedSpreadDeg: 0.05, spreadPerShot: 2, maxSpreadDeg: 9, spreadRecover: 4,
    pellets: 1, rangeStart: 60, rangeEnd: 90, minDmgMul: 0.85, moveMul: 0.82, zoomFov: 25,
  },
};

export const BASE_FOV = 75; // degrees, unscoped
export const WEAPON_ORDER: WeaponId[] = ['knife', 'pistol', 'smg', 'shotgun', 'rifle', 'sniper'];
export const MULTIKILL_WINDOW = 4; // s between kills to keep a streak alive

// Deterministic per-shot spread seed. Implementations MUST use this so client
// crosshair bloom and server shots agree statistically.
export function shotSeed(tick: number, shotSeq: number): number {
  return ((tick * 73856093) ^ (shotSeq * 19349663) ^ 0x9e3779b9) >>> 0;
}
