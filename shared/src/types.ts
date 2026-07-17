// ============================================================================
// FROZEN CONTRACT — shared cross-module types. See CONTRACT.md.
// After freeze: implementers may NOT modify this file. Types only, no logic.
// ============================================================================

// ---- ids & vocab ----
export type PlayerId = string; // 8-char server-assigned
export type RoomId = string;
export type Team = 'T' | 'CT';
export type MapId = 'dustbowl' | 'crossfire' | 'office' | 'frostbite' | 'urbana' | 'bunker';
export type WeaponId = 'knife' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'sniper';
export type RoomPhase = 'warmup' | 'freeze' | 'live' | 'roundEnd' | 'matchEnd';
export type RoomVisibility = 'public' | 'private';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ---- input buttons bitfield (C2S 'input'.buttons) ----
export const INPUT_FIRE = 1 << 0;
export const INPUT_JUMP = 1 << 1;
export const INPUT_CROUCH = 1 << 2;
export const INPUT_ALT = 1 << 3; // right mouse: sniper scope

// ---- client -> server ----
export type C2S =
  | { t: 'list_rooms' }
  | { t: 'quick_join'; name: string }
  | { t: 'create_private'; name: string; mapId: MapId }
  | { t: 'join_private'; name: string; code: string }
  | { t: 'leave' }
  | {
      t: 'input';
      seq: number; // monotonically increasing per client, starts at 1
      moveX: number; // -1..1 strafe (right positive)
      moveZ: number; // -1..1 forward/backward (forward positive)
      yaw: number; // radians, 0 = -Z (north), increases CCW seen from above
      pitch: number; // radians, clamped to [-1.45, 1.45]
      buttons: number; // INPUT_* bitfield
    }
  | { t: 'reload' }
  | { t: 'switch'; weapon: WeaponId }
  | { t: 'buy'; weapon: WeaponId }
  | { t: 'ping'; ts: number };

// ---- server -> client ----
export interface RoomInfo {
  id: RoomId;
  code: string | null; // join code for private rooms, null for public
  mapId: MapId;
  players: number;
  maxPlayers: number;
  phase: RoomPhase;
  visibility: RoomVisibility;
}

export interface RosterEntry {
  id: PlayerId;
  name: string;
  team: Team;
  kills: number;
  deaths: number;
  money: number | null; // populated only for the receiving player, null otherwise
  connected: boolean;
}

// One player inside a snapshot. x/y/z = FEET position (y is the floor under them).
export interface PlayerSnap {
  id: PlayerId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  hp: number; // 0..100
  alive: boolean;
  crouch: boolean;
  moving: boolean; // horizontal speed > 0.5 m/s (drives walk anim + footsteps)
  weapon: WeaponId; // currently held
}

// Private per-recipient state, sent every snapshot.
export interface YouSnap {
  hp: number;
  alive: boolean;
  money: number;
  weapons: WeaponId[]; // owned, current first
  weapon: WeaponId;
  mag: number; // -1 for melee
  reserve: number; // -1 for melee
  canBuy: boolean; // true during freeze + buyTime window of 'live'
  spectateTarget: PlayerId | null; // set while dead in a live round
  respawnAt: number | null; // serverTime ms when warmup respawn happens, else null
  vy: number; // authoritative vertical velocity (client prediction replays gravity from it)
}

export type RoundEndReason = 'elimination' | 'time' | 'forfeit';

export type GameEvent =
  | { t: 'shot'; shooterId: PlayerId; weapon: WeaponId; from: Vec3; to: Vec3 } // broadcast to ALL players in the room; from = shooter eye, to = hit point or wall end (drives tracers, muzzle flash, shot sounds)
  | { t: 'kill'; killerId: PlayerId | null; victimId: PlayerId; weapon: WeaponId; headshot: boolean }
  | { t: 'hit'; victimId: PlayerId; dmg: number; headshot: boolean; killed: boolean } // to shooter only
  | { t: 'dmg_taken'; fromId: PlayerId | null; dmg: number; yaw: number } // to victim only; yaw = world yaw towards shooter
  | { t: 'round_start'; round: number; scoreT: number; scoreCT: number; freezeUntil: number } // serverTime ms
  | { t: 'round_end'; winner: Team | null; reason: RoundEndReason; scoreT: number; scoreCT: number } // winner null = mutual elimination, both teams get loss reward
  | { t: 'match_end'; winner: Team; scoreT: number; scoreCT: number }
  | { t: 'halftime'; roster: RosterEntry[] } // sides swapped; REPLACE local roster with this one
  | { t: 'player_joined'; entry: RosterEntry }
  | { t: 'player_left'; id: PlayerId }
  | { t: 'buy_result'; ok: boolean; weapon: WeaponId | null; reason: string | null };

export type S2C =
  | { t: 'welcome'; playerId: PlayerId }
  | { t: 'room_list'; rooms: RoomInfo[] }
  | { t: 'joined'; roomId: RoomId; code: string | null; mapId: MapId; you: PlayerId; team: Team; tick: number; serverTime: number; round: number; scoreT: number; scoreCT: number; roster: RosterEntry[] }
  | { t: 'snapshot'; tick: number; serverTime: number; ack: number; phase: RoomPhase; phaseEndsAt: number; players: PlayerSnap[]; you: YouSnap } // phaseEndsAt = 0 during warmup/matchEnd (HUD hides the timer when 0)
  | { t: 'event'; ev: GameEvent }
  | { t: 'pong'; ts: number; serverTime: number }
  | { t: 'error'; code: string; message: string };

// ---- serverTime convention ----
// All serverTime fields are milliseconds on the SERVER clock (Date.now()).
// Clients compute an offset from 'joined'.serverTime / pong and may display
// countdowns as (phaseEndsAt - estimatedServerNow).
