// ============================================================================
// Platform lobby: matchmaking, room lifecycle, session->room routing —
// rooms.ts generalized around a GameModule registry (games plug in via
// registry.ts; this file never imports a game). Preserved behaviors: public
// quick-join matching (prefer warmup, first room with space), join_public by
// room id (public rooms only; missing or private => 'no_room', full =>
// 'room_full'), private rooms
// with game-generated 5-char codes, the MAX_ROOMS guard ('rooms_full'),
// 'no_room'/'room_full' on join_private, list_rooms (public only), a session
// in at most one room, empty-room reaping (private immediately, public after
// 30s), and kick-vs-leave disambiguation by observing 'player_left' on the
// RoomIO bridge (lobby-initiated removals delete the session->room mapping
// BEFORE room.removePlayer). Generalized: `game` selects the module (default
// = first registered; unknown => 'unknown_game'); settings pass opaquely to
// module.createRoom (a throw => 'bad_settings' with the module's message);
// room-level messages route as RAW objects to GameRoomHandle.handleMessage.
// Never throws.
// ============================================================================
import type {
  C2S,
  GameModule,
  GameRoomHandle,
  LobbyC2S,
  PlayerId,
  RoomId,
  RoomInfo,
  RoomIO,
  S2C,
  Visibility,
} from '@platform/shared';
import type { Session } from './net.js';

const MAX_ROOMS = 64; // platform-wide capacity guard
const PUBLIC_REAP_MS = 30_000; // empty public rooms linger this long, then close

interface TrackedRoom {
  room: GameRoomHandle;
  emptySince: number | null; // serverTime ms when the room last became empty
}

const LOBBY_TAGS: ReadonlySet<string> = new Set([
  'list_rooms',
  'quick_join',
  'join_public',
  'create_public',
  'create_private',
  'join_private',
  'leave',
  'ping',
]);

/** parseC2S emits a parsed LobbyC2S for lobby tags; anything else is a raw envelope. */
function isLobbyMsg(msg: C2S): msg is LobbyC2S {
  return LOBBY_TAGS.has(msg.t);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Kick detection: rooms broadcast their own S2C through the io bridge; the
 * platform-observable removal is the {t:'event', ev:{t:'player_left', id}}
 * envelope. Returns the departed id when msg is one, else null.
 */
function playerLeftId(msg: unknown): PlayerId | null {
  if (!isObj(msg) || msg.t !== 'event' || !isObj(msg.ev)) return null;
  if (msg.ev.t !== 'player_left' || typeof msg.ev.id !== 'string') return null;
  return msg.ev.id;
}

export class Lobby {
  private readonly modules: readonly GameModule[];
  private readonly sessions = new Map<PlayerId, Session>(); // every session that ever spoke
  private readonly sessionRoom = new Map<PlayerId, GameRoomHandle>(); // <= 1 room per session
  private readonly rooms = new Map<RoomId, TrackedRoom>();
  private readonly kicked = new Set<PlayerId>(); // room-initiated drops awaiting socket close

  // Shared RoomIO for every room: resolves PlayerId -> Session and observes
  // player_left broadcasts to catch room-initiated removals. Unknown ids
  // (bots have no session) get a send no-op and rttMs 0.
  private readonly io: RoomIO = {
    send: (id, msg) => {
      const leftId = playerLeftId(msg);
      if (leftId !== null && this.sessionRoom.has(leftId)) {
        // Mapping still present => the lobby did not initiate this removal:
        // the room kicked the player (fps: the speedhack guard). The lobby owns the socket.
        this.sessionRoom.delete(leftId);
        this.kicked.add(leftId);
      }
      this.sessions.get(id)?.send(msg as S2C); // game S2C envelopes pass through untouched
    },
    rttMs: (id) => this.sessions.get(id)?.rttMs() ?? 0,
  };

  constructor(modules: readonly GameModule[]) {
    this.modules = modules; // registry order matters: [0] is the default game
  }

  handleMessage(sess: Session, msg: C2S): void {
    try {
      this.sessions.set(sess.id, sess); // cheap re-registration; io bridge needs it
      if (!isLobbyMsg(msg)) {
        // room-level pass-through: the RAW object goes to the session's room;
        // the game validates it with its own protocol parser
        this.sessionRoom.get(sess.id)?.handleMessage(sess.id, msg);
        return;
      }
      switch (msg.t) {
        case 'list_rooms':
          this.listRooms(sess);
          break;
        case 'quick_join':
          this.quickJoin(sess, msg.name, msg.game, msg.resume);
          break;
        case 'join_public':
          this.joinPublic(sess, msg.name, msg.roomId, msg.resume);
          break;
        case 'create_public':
          this.createPublic(sess, msg.name, msg.game, msg.settings, msg.resume);
          break;
        case 'create_private':
          this.createPrivate(sess, msg.name, msg.game, msg.settings, msg.resume);
          break;
        case 'join_private':
          this.joinPrivate(sess, msg.name, msg.code, msg.resume);
          break;
        case 'leave':
          this.leaveRoom(sess.id, true); // explicit leave: permanent removal
          break;
        case 'ping':
          break; // answered at the transport layer (net.ts); never routed
      }
    } catch (err) {
      console.error('[lobby] handleMessage failed', err);
    }
  }

  handleDisconnect(sess: Session): void {
    try {
      this.leaveRoom(sess.id);
      this.sessions.delete(sess.id);
      this.kicked.delete(sess.id);
    } catch (err) {
      console.error('[lobby] handleDisconnect failed', err);
    }
  }

  roomCount(): number {
    return this.rooms.size;
  }

  /**
   * Polled by index.ts every 1s. Returns sessions whose socket must close:
   * input-stale players (reported by room.stalePlayers()) plus room-kicked
   * players. Also reaps empty rooms (private immediately, public after
   * PUBLIC_REAP_MS).
   */
  pollStaleSessions(): Session[] {
    const out: Session[] = [];
    try {
      for (const id of this.kicked) {
        const sess = this.sessions.get(id);
        if (sess !== undefined) out.push(sess);
      }
      this.kicked.clear();

      const now = Date.now();
      for (const [roomId, tracked] of this.rooms) {
        for (const id of tracked.room.stalePlayers()) {
          const sess = this.sessions.get(id);
          if (sess !== undefined) out.push(sess);
          this.sessionRoom.delete(id); // before removePlayer: lobby-initiated
          tracked.room.removePlayer(id);
        }
        if (tracked.room.playerCount() > 0) {
          tracked.emptySince = null;
          continue;
        }
        if (tracked.emptySince === null) tracked.emptySince = now;
        const expired =
          tracked.room.info().visibility === 'private' || now - tracked.emptySince >= PUBLIC_REAP_MS;
        if (expired) {
          tracked.room.stop();
          this.rooms.delete(roomId); // safe: Map iteration tolerates deleting current
          console.log(
            `[lobby] room ${roomId} closed (empty ${tracked.room.info().visibility}); ${this.rooms.size} open`,
          );
        }
      }
    } catch (err) {
      console.error('[lobby] pollStaleSessions failed', err);
    }
    return out;
  }

  /** Server shutdown: stop every room tick; sockets are NetServer's concern. */
  close(): void {
    for (const { room } of this.rooms.values()) room.stop();
    this.rooms.clear();
    this.sessionRoom.clear();
    this.sessions.clear();
    this.kicked.clear();
  }

  // -------------------------------------------------------------------------
  // Matchmaking
  // -------------------------------------------------------------------------

  private listRooms(sess: Session): void {
    const rooms: RoomInfo[] = [];
    for (const { room } of this.rooms.values()) {
      if (room.info().visibility === 'public') rooms.push(room.info());
    }
    sess.send({ t: 'room_list', rooms });
  }

  private quickJoin(sess: Session, name: string, game: string | undefined, resume: PlayerId | undefined): void {
    const mod = this.moduleFor(game);
    if (mod === undefined) {
      this.sendError(sess, 'unknown_game', game === undefined ? 'no game registered' : `unknown game: ${game}`);
      return;
    }
    let room = this.findPublicRoom(mod.id, 'warmup') ?? this.findPublicRoom(mod.id, null);
    if (room === undefined) {
      if (this.rooms.size >= MAX_ROOMS) {
        this.sendError(sess, 'rooms_full', 'server is at capacity, try again later');
        return;
      }
      const created = this.createRoom(mod, 'public', {}, sess); // default settings
      if (created === null) return; // bad_settings already sent
      room = created;
    }
    this.leaveRoom(sess.id);
    this.joinRoom(sess, room, name, resume);
  }

  private joinPublic(sess: Session, name: string, roomId: string, resume: PlayerId | undefined): void {
    const tracked = this.rooms.get(roomId);
    // private rooms answer 'no_room' too: join-by-id must not reveal them
    if (tracked === undefined || tracked.room.info().visibility !== 'public') {
      this.sendError(sess, 'no_room', 'no public room with that id');
      return;
    }
    if (tracked.room.playerCount() >= tracked.room.info().maxPlayers) {
      this.sendError(sess, 'room_full', 'room is full');
      return;
    }
    this.leaveRoom(sess.id);
    this.joinRoom(sess, tracked.room, name, resume);
  }

  private createPublic(
    sess: Session,
    name: string,
    game: string | undefined,
    settings: Record<string, unknown> | undefined,
    resume: PlayerId | undefined,
  ): void {
    const mod = this.moduleFor(game);
    if (mod === undefined) {
      this.sendError(sess, 'unknown_game', game === undefined ? 'no game registered' : `unknown game: ${game}`);
      return;
    }
    if (this.rooms.size >= MAX_ROOMS) {
      this.sendError(sess, 'rooms_full', 'server is at capacity, try again later');
      return;
    }
    const room = this.createRoom(mod, 'public', settings, sess); // listed by list_rooms, no code
    if (room === null) return; // bad_settings already sent
    this.leaveRoom(sess.id);
    this.joinRoom(sess, room, name, resume);
  }

  private createPrivate(
    sess: Session,
    name: string,
    game: string | undefined,
    settings: Record<string, unknown> | undefined,
    resume: PlayerId | undefined,
  ): void {
    const mod = this.moduleFor(game);
    if (mod === undefined) {
      this.sendError(sess, 'unknown_game', game === undefined ? 'no game registered' : `unknown game: ${game}`);
      return;
    }
    if (this.rooms.size >= MAX_ROOMS) {
      this.sendError(sess, 'rooms_full', 'server is at capacity, try again later');
      return;
    }
    const room = this.createRoom(mod, 'private', settings, sess); // code generated by the room
    if (room === null) return; // bad_settings already sent
    this.leaveRoom(sess.id);
    this.joinRoom(sess, room, name, resume);
  }

  private joinPrivate(sess: Session, name: string, code: string, resume: PlayerId | undefined): void {
    let found: GameRoomHandle | undefined;
    for (const { room } of this.rooms.values()) {
      const info = room.info();
      if (info.visibility === 'private' && info.code === code) {
        found = room;
        break;
      }
    }
    if (found === undefined) {
      this.sendError(sess, 'no_room', 'no room with that code');
      return;
    }
    if (found.playerCount() >= found.info().maxPlayers) {
      this.sendError(sess, 'room_full', 'room is full');
      return;
    }
    this.leaveRoom(sess.id);
    this.joinRoom(sess, found, name, resume);
  }

  /** First public room of this game with space; when phase is set, only that phase. */
  private findPublicRoom(gameId: string, phase: 'warmup' | null): GameRoomHandle | undefined {
    for (const { room } of this.rooms.values()) {
      const info = room.info();
      if (info.game !== gameId || info.visibility !== 'public' || room.playerCount() >= info.maxPlayers) continue;
      if (phase !== null && info.phase !== phase) continue;
      return room;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  /** Absent game => the first registered module; unknown id => undefined. */
  private moduleFor(game: string | undefined): GameModule | undefined {
    if (game === undefined) return this.modules[0];
    return this.modules.find((m) => m.id === game);
  }

  /** Registers + starts a module room; null (error already sent) on invalid settings. */
  private createRoom(
    mod: GameModule,
    visibility: Visibility,
    settings: Record<string, unknown> | undefined,
    sess: Session,
  ): GameRoomHandle | null {
    let room: GameRoomHandle;
    try {
      const opts: { visibility: Visibility; io: RoomIO; settings?: Record<string, unknown> } = {
        visibility,
        io: this.io,
      };
      if (settings !== undefined) opts.settings = settings; // opaque to the platform
      room = mod.createRoom(opts);
    } catch (err) {
      // contract: modules throw Error(message) on invalid settings
      this.sendError(sess, 'bad_settings', err instanceof Error ? err.message : String(err));
      return null;
    }
    this.rooms.set(room.id, { room, emptySince: Date.now() }); // born empty
    room.start();
    const code = room.info().code;
    console.log(
      `[lobby] room ${room.id} created (${visibility}${code !== null ? `, code ${code}` : ''}, game ${mod.id}); ${this.rooms.size} open`,
    );
    return room;
  }

  private joinRoom(sess: Session, room: GameRoomHandle, name: string, resume: PlayerId | undefined): void {
    const tracked = this.rooms.get(room.id);
    if (tracked !== undefined) tracked.emptySince = null;
    this.sessionRoom.set(sess.id, room);
    room.addPlayer(sess.id, name, resume); // the room sends its own join payload
  }

  private leaveRoom(id: PlayerId, permanent = false): void {
    const room = this.sessionRoom.get(id);
    if (room === undefined) return;
    this.sessionRoom.delete(id); // before removePlayer: lobby-initiated, not a kick
    room.removePlayer(id, permanent);
    if (room.playerCount() > 0) return;
    const tracked = this.rooms.get(room.id);
    if (tracked === undefined) return;
    if (room.info().visibility === 'private') {
      room.stop(); // empty private rooms close immediately
      this.rooms.delete(room.id);
      console.log(`[lobby] room ${room.id} closed (empty private); ${this.rooms.size} open`);
    } else if (tracked.emptySince === null) {
      tracked.emptySince = Date.now(); // public rooms get a grace window
    }
  }

  private sendError(sess: Session, code: string, message: string): void {
    sess.send({ t: 'error', code, message });
  }
}
