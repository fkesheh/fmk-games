// ============================================================================
// FROZEN PLATFORM CONTRACT — how a game plugs into the platform.
// See docs/STRUCTURE.md. Platform code never imports from games/*; games
// implement GameModule and register in platform/server/src/registry.ts.
// ============================================================================

export type PlayerId = string;
export type RoomId = string;
export type Visibility = 'public' | 'private';

/** What the platform offers a game room. */
export interface RoomIO {
  send(id: PlayerId, msg: unknown): void; // no-op for unknown ids (bots have no session)
  rttMs(id: PlayerId): number; // 0 for unknown ids
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
  addPlayer(id: PlayerId, name: string, resume?: PlayerId): void;
  // resume: a playerId from a previous (disconnected) session. Games that support
  // rejoin may re-bind the new session to the old entry; others ignore it.
  /**
   * permanent=true: the player explicitly left (C2S 'leave') — remove them fully.
   * permanent=false/omitted: socket dropped — games MAY ghost the entry briefly
   * (rejoin via resume) and purge later.
   */
  removePlayer(id: PlayerId, permanent?: boolean): void;
  /**
   * A room-level message from a player: the RAW decoded JSON object with a string
   * `t` field (envelope-checked by the platform). The GAME validates the rest with
   * its own protocol parser and silently drops invalid messages.
   */
  handleMessage(id: PlayerId, msg: unknown): void;
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
}
