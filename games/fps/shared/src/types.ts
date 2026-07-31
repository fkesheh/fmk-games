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
export const INPUT_ALT = 1 << 3; // right mouse / F: sniper scope
export const INPUT_WALK = 1 << 4; // Shift: slow + quiet walk (CS walk)

// ---- client -> server ----
export type C2S =
  | { t: 'list_rooms' }
  | { t: 'quick_join'; name: string }
  | { t: 'create_public'; name: string; mapId: MapId }
  | { t: 'create_private'; name: string; mapId: MapId }
  | { t: 'join_private'; name: string; code: string }
  | { t: 'leave' }
  | { t: 'add_bot' } // add a server-driven bot to the current room (bot takes a player slot)
  | { t: 'remove_bot' } // remove the most recently added bot
  | { t: 'switch_team'; team: Team } // request to join the given team (see GameRoom semantics)
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
  | { t: 'buy_gear'; item: GearId } // armor items: kevlar vest / helmet (CS gear)
  | { t: 'kill_bots' } // console 'killbots': kill every bot in place (they stay in the room)
  | { t: 'suicide' } // console 'kill' command: the server kills the sender (killerId null)
  // ADDITIVE (manual start). Warmup IS this game's lobby and it never ends by
  // itself: a match begins only when a seated player asks for it. Accepted ONLY
  // while phase === 'warmup' AND playerCount >= MIN_PLAYERS_FOR_MATCH (bots
  // count — they hold real roster slots). ANY seated player may send it; there
  // is no host. Ignored silently in every other case, never an error, never a
  // throw. The same applies after a match ends: the room resets to warmup and
  // WAITS for another explicit 'start'.
  | { t: 'start' }
  | { t: 'ping'; ts: number };

export type GearId = 'kevlar' | 'helmet';

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
  headshots: number; // kills that were headshots (scoreboard HS column)
  bot: boolean; // server-driven player (scoreboard shows a BOT tag)
  money: number | null; // populated only for the receiving player, null otherwise
  connected: boolean; // always true for bots
  // ADDITIVE (mid-round join): true while this player is seated on a team but
  // sits out the round in progress — absent from the world and from snapshots,
  // spawning at the next freeze. Scoreboard shows "joining next round".
  // Absent/undefined means false (older servers never send it).
  joiningNextRound?: boolean;
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
  armor: number; // 0..100 kevlar points (0 = no vest)
  helmet: boolean; // owned helmet (protects head with armor absorb)
  // ADDITIVE (mid-round join): the recipient joined after this round went live
  // and is spectating until the next freeze. alive is false and there is no
  // respawnAt — the HUD should say "joining next round", not "respawning".
  // Absent/undefined means false.
  joiningNextRound?: boolean;
}

export type RoundEndReason = 'elimination' | 'time' | 'forfeit';

// ADDITIVE. Personal, human-readable server notice delivered to ONE player when
// the server changed something about their participation without them asking.
// `text` is display-ready; `code` lets a client style/localize it. Clients that
// do not know a code should still show `text` (or ignore the event entirely —
// nothing else depends on it).
export type NoticeCode =
  | 'joining_next_round' // you joined mid-round: spectating until the next freeze
  | 'team_rebalanced'; // the server moved you to the other team to even the sides

export type GameEvent =
  | { t: 'shot'; shooterId: PlayerId; weapon: WeaponId; from: Vec3; to: Vec3 } // broadcast to ALL players in the room; from = shooter eye, to = hit point or wall end (drives tracers, muzzle flash, shot sounds)
  | { t: 'kill'; killerId: PlayerId | null; victimId: PlayerId; weapon: WeaponId; headshot: boolean }
  | { t: 'multikill'; playerId: PlayerId; count: number } // broadcast; count = 2,3,4,5+ (5+ = ace) — kills within MULTIKILL_WINDOW of the previous one
  | { t: 'hit'; victimId: PlayerId; dmg: number; headshot: boolean; killed: boolean } // to shooter only
  | { t: 'dmg_taken'; fromId: PlayerId | null; dmg: number; yaw: number } // to victim only; yaw = world yaw towards shooter
  | { t: 'round_start'; round: number; scoreT: number; scoreCT: number; freezeUntil: number } // serverTime ms
  | { t: 'round_end'; winner: Team | null; reason: RoundEndReason; scoreT: number; scoreCT: number } // winner null = mutual elimination, both teams get loss reward
  | { t: 'match_end'; winner: Team; scoreT: number; scoreCT: number }
  | { t: 'halftime'; roster: RosterEntry[] } // sides swapped; REPLACE local roster with this one
  | { t: 'player_joined'; entry: RosterEntry }
  | { t: 'player_left'; id: PlayerId }
  | { t: 'team_changed'; id: PlayerId; team: Team } // broadcast; roster update for id (also fired when applied at freeze)
  | { t: 'buy_result'; ok: boolean; weapon: WeaponId | null; reason: string | null }
  | { t: 'notice'; code: NoticeCode; text: string }; // ADDITIVE; to one player only

export type S2C =
  | { t: 'welcome'; playerId: PlayerId }
  | { t: 'room_list'; rooms: RoomInfo[] }
  | { t: 'joined'; roomId: RoomId; code: string | null; mapId: MapId; you: PlayerId; team: Team; tick: number; serverTime: number; round: number; scoreT: number; scoreCT: number; roster: RosterEntry[] }
  | {
      t: 'snapshot';
      tick: number;
      serverTime: number;
      ack: number;
      phase: RoomPhase;
      phaseEndsAt: number; // 0 during warmup/matchEnd (HUD hides the timer when 0)
      players: PlayerSnap[];
      you: YouSnap;
      // ---- THE MANUAL-START LOBBY (identical contract across all four games) --
      // ADDITIVE. No game on this platform auto-starts; fps's lobby is `warmup`
      // (which stays fully playable) and it leaves warmup only because a seated
      // player asked. These three fields are what the lobby UI renders, so the
      // client never hardcodes the threshold or re-derives the acceptance rule
      // and drifts from the server's answer. Sent on EVERY snapshot; absent
      // only from an older server (treat as unknown and hide the button).
      /** Seated players right now — bots included; the count `canStart` judges. */
      seated?: number;
      /** MIN_PLAYERS_FOR_MATCH, mirrored on the wire. */
      minPlayers?: number;
      /**
       * True iff a `{t:'start'}` arriving right now would be ACCEPTED: phase is
       * `warmup` and `seated >= minPlayers`. The server is the only judge; the
       * button is enabled/disabled straight from this field.
       */
      canStart?: boolean;
    }
  | { t: 'event'; ev: GameEvent }
  | { t: 'pong'; ts: number; serverTime: number }
  | { t: 'error'; code: string; message: string };

// ---- serverTime convention ----
// All serverTime fields are milliseconds on the SERVER clock (Date.now()).
// Clients compute an offset from 'joined'.serverTime / pong and may display
// countdowns as (phaseEndsAt - estimatedServerNow).
