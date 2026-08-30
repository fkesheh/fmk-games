// ============================================================================
// ACES types — FROZEN Layer-1. Shapes only; no logic.
// These are the exact objects the server sim mutates, the wire carries
// (snapshots), and the client predicts/renders against.
// Units: position/speed in world u (px at zoom 1), heading in radians,
// [0, 2π), 0 = +x (east). Angles grow CLOCKWISE on screen (canvas y-down).
// ============================================================================

import type { Difficulty, PlaneClassId, TeamId } from './config.js';

/** Full authoritative plane state — lives in the server sim. */
export interface PlaneState {
  id: string;
  name: string;
  team: TeamId;
  cls: PlaneClassId;
  bot: boolean;

  x: number;
  y: number;
  /** Velocity components, u/s. Speed = hypot; heading is separate (facing). */
  vx: number;
  vy: number;
  h: number; //        facing heading, rad

  hp: number;
  heat: number; //     0..HEAT_MAX; ≥max = jammed until ≤ HEAT_RESUME
  jammed: boolean;
  boost: number; //    BOOST_MAX..0 fuel
  boosting: boolean;
  throttle: number; // last applied −0.3..1 (echoed for HUD needle)
  invulnT: number; //  spawn-protection seconds remaining
  fireCd: number; //   seconds until next volley may fire
  dead: boolean;
  respawnT: number; // >0 while waiting to respawn
  streak: number; //   consecutive kills without dying
}

/** One bullet in flight. Bullets are team-colored pass-through friendly-fire-off. */
export interface BulletState {
  id: number;
  team: TeamId;
  owner: string; //    plane id
  x: number;
  y: number;
  vx: number; //       includes inherited plane velocity
  vy: number;
  t: number; //        seconds remaining
}

export type CratePhase = 'fall' | 'active';

export interface CrateState {
  id: number;
  x: number;
  y: number;
  phase: CratePhase;
  t: number; //        fall: seconds remaining · active: seconds left alive
}

export type MatchPhase = 'lobby' | 'live' | 'end';

/** Per-human/bot scoreboard row (server-assembled). */
export interface ScoreRow {
  id: string;
  name: string;
  team: TeamId;
  cls: PlaneClassId;
  bot: boolean;
  kills: number;
  deaths: number;
  shots: number;
  hits: number;
  score: number; //    kills*100 + hits*2 (display only)
}

/**
 * Client input frame — the ONLY thing a client sends about flying.
 * th: throttle −0.3..1 (S/W or ↓/↑) · tr: turn −1..1 (A/D or ←/→)
 * fire/boost: buttons. seq echoes back on the player's snapshot row.
 */
export interface InputFrame {
  readonly seq: number;
  readonly th: number;
  readonly tr: number;
  readonly fire: boolean;
  readonly boost: boolean;
}

// ---- events (server → clients, discrete happenings) ------------------------------

export interface KillEvent {
  kind: 'kill';
  killer: string;
  killerName: string;
  victim: string;
  victimName: string;
  killerTeam: TeamId;
  victimTeam: TeamId;
  killerCls: PlaneClassId;
  victimCls: PlaneClassId;
  crash: boolean; //    true when the victim died by burning/crash, not bullets
  streak: number; //    killer's new streak (for ACE/LEGEND banners)
  x: number; //         wreck position — effects/audio anchor at death instant
  y: number;
}

export interface HitEvent {
  kind: 'hit';
  target: string; //    plane that took the hit
  by: string; //        shooter plane id
  x: number;
  y: number; //         impact point
  dmg: number;
  killed: boolean;
}

export interface CrateEvent {
  kind: 'crate';
  what: 'spawn' | 'pickup' | 'expire';
  x: number;
  y: number;
  by?: string; //       pickup taker
}

/**
 * Phase changes ride the dedicated PhaseMsg channel (protocol.ts), never the
 * event stream — PhaseMsg carries endsAtS/winner and is the single
 * authority for HUD clocks and end screens.
 */
export type GameEvent = KillEvent | HitEvent | CrateEvent;
