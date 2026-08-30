// ============================================================================
// FROZEN PLATFORM CONTRACT — how a game plugs into the platform.
// See docs/STRUCTURE.md. Platform code never imports from games/*; games
// implement GameModule and register in platform/server/src/registry.ts.
//
// v2 amendment (docs/PLATFORM.md §5): OPTIONAL members only — profileId,
// reportStats, padOwner on RoomIO; padLayout on GameModule. Pre-v2 games are
// untouched and remain contract-compliant by ignoring them.
// ============================================================================

import type { PadLayout, StatsDelta } from './services.js';

export type PlayerId = string;
export type RoomId = string;
export type Visibility = 'public' | 'private';
/** Server-side profile id; empty string when anonymous/unavailable. */
export type ProfileRef = string;

/** What the platform offers a game room. */
export interface RoomIO {
  send(id: PlayerId, msg: unknown): void; // no-op for unknown ids (bots have no session)
  rttMs(id: PlayerId): number; // 0 for unknown ids
  /**
   * v2: the authenticated profile behind a connected player, or '' when the
   * session is anonymous / the id is unknown (bots). Never throws.
   */
  profileId?(id: PlayerId): ProfileRef;
  /**
   * v2: fire-and-forget stat counters for persistence. Keys are game-defined;
   * values are clamped finite numbers (see limits.ts STATS). No-op when the
   * player is anonymous or unknown.
   */
  reportStats?(playerId: PlayerId, delta: StatsDelta): void;
}

/** Game-agnostic room description shown in the lobby list. */
export interface RoomInfo {
  id: RoomId;
  code: string | null; // join code for private rooms
  game: string; // GameModule.id
  label: string; // game-specific subtitle (fps: the map name)
  players: number;
  maxPlayers: number;
  phase: string; // game-defined ('warmup' | 'live' | ...)
  visibility: Visibility;
}

/** A live room, owned and driven by a game module. */
export interface GameRoomHandle {
  readonly id: RoomId;
  info(): RoomInfo;
  playerCount(): number;
  /** ids with no input for the game's timeout — the platform closes their sockets. */
  stalePlayers(): PlayerId[];
  /** Called when a session joins. The room sends its own join payload to the player. */
  addPlayer(id: PlayerId, name: string, resume?: PlayerId, sig?: string): void;
  // resume: a playerId from a previous (disconnected) session. Games that support
  // rejoin may re-bind the new session to the old entry; others ignore it.
  //
  // sig: the joiner's DURABLE browser signature (@platform/shared identity).
  // Where `resume` is ephemeral — it only matches while the ghost still holds
  // the exact playerId of the dropped socket — `sig` is the same value across
  // reloads, reconnects and playerId rotation. Rooms that support rejoin
  // SHOULD match on `resume` first (cheapest, exact, and what existing
  // clients send) and fall back to `sig`; a room that ignores both is still
  // contract-compliant, it just won't resume anyone.
  /**
   * permanent=true: the player explicitly left (C2S 'leave') — remove them fully.
   * permanent=false/omitted: socket dropped — games MAY ghost the entry briefly
   * (rejoin via resume/sig) and purge later.
   */
  removePlayer(id: PlayerId, permanent?: boolean): void;
  /**
   * A room-level message from a player: the RAW decoded JSON object with a string
   * `t` field (envelope-checked by the platform). The GAME validates the rest with
   * its own protocol parser and silently drops invalid messages.
   */
  handleMessage(id: PlayerId, msg: unknown): void;
  /**
   * OPTIONAL pad (phone-as-controller) bind. Absent => the game has no pad
   * mode and the lobby answers 'pad_unsupported' without knowing which games
   * support pads. See @platform/shared pad.ts and docs/PAD.md.
   *
   * `id` is the PAD session's id (never a seat); `token` is the single-use
   * pairing token this room minted for one of its seated players. The ROOM
   * validates the token (tokens are game-level state) and returns false when
   * it is unknown, expired or already consumed — the lobby forwards that as
   * 'pad_rejected'. On true the lobby routes that session's room-level
   * messages here, and a pad disconnect arrives as removePlayer(padId).
   *
   * Pads never occupy a seat: they must not appear in playerCount(),
   * RoomInfo.players or stalePlayers(), and must never keep a room alive.
   */
  addPad?(id: PlayerId, token: string): boolean;
  start(): void; // idempotent
  stop(): void;
}

/** A registered game. */
export interface GameModule {
  readonly id: string; // 'fps'
  readonly name: string; // display name
  readonly clientDist: string; // absolute path to the built client (served at /<id>/)
  readonly devPort?: number; // vite dev-server port; when reachable, /<id>/ is proxied
  // there instead of serving clientDist (single dev entry point through the platform server)
  /**
   * Seat range, reported by the game rather than restated by the platform.
   *
   * The launcher advertises these on its cards. They used to be hardcoded
   * strings there ("2–8 players") and silently went stale the moment a cap
   * changed — every one of the four was wrong. Deriving them means the front
   * page cannot lie about the game behind it.
   */
  readonly minPlayers: number;
  readonly maxPlayers: number;
  createRoom(opts: {
    visibility: Visibility;
    io: RoomIO;
    settings?: Record<string, unknown>; // game-specific (fps: { mapId })
  }): GameRoomHandle;
  // throws Error(message) on invalid settings — the lobby forwards it as
  // { t: 'error', code: 'bad_settings', message }
  /**
   * v2: declaring a pad layout opts the game into phone-as-gamepad. The
   * platform serves it at GET /api/pads/:game, renders /pad/?game=<id> from
   * it, and relays `{t:'pad_input', …}` messages from bound pad sessions into
   * this game's rooms (resolve seats via RoomIO.padOwner).
   */
  readonly padLayout?: PadLayout;
}
