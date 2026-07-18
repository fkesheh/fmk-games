// ============================================================================
// S1 — lobby: matchmaking, room lifecycle, session->room routing.
// Owns public quick-join matching (prefer warmup), private 5-char codes,
// empty-room reaping (private immediately, public after 30s), the MAX_ROOMS
// guard, and the RoomIO bridge between GameRoom (S2) and sessions (net.ts).
// Invariants: a session is in at most one room; lobby-initiated removals
// delete the session->room mapping BEFORE room.removePlayer so the resulting
// player_left broadcast is not mistaken for a room-initiated kick (speedhack
// guard in game.ts) — kicks are detected via the RoomIO pass-through and the
// socket close is surfaced to index.ts via pollStaleSessions(). Never throws.
// ============================================================================
import { MAP_LIST, MAX_PLAYERS, MAX_ROOMS, rng, rngPick } from '@fps/shared';
import type { C2S, MapId, PlayerId, RoomId, RoomInfo } from '@fps/shared';
import { GameRoom } from './game.js';
import type { RoomIO } from './game.js';
import type { Session } from './net.js';

const PUBLIC_REAP_MS = 30_000; // empty public rooms linger this long, then close

interface TrackedRoom {
  room: GameRoom;
  emptySince: number | null; // serverTime ms when the room last became empty
}

export class Lobby {
  private readonly sessions = new Map<PlayerId, Session>(); // every session that ever spoke
  private readonly sessionRoom = new Map<PlayerId, GameRoom>(); // <= 1 room per session
  private readonly rooms = new Map<RoomId, TrackedRoom>();
  private readonly kicked = new Set<PlayerId>(); // room-initiated drops awaiting socket close

  // Shared RoomIO for every room: resolves PlayerId -> Session and observes
  // player_left broadcasts to catch room-initiated removals.
  private readonly io: RoomIO = {
    send: (id, msg) => {
      if (msg.t === 'event' && msg.ev.t === 'player_left' && this.sessionRoom.has(msg.ev.id)) {
        // Mapping still present => the lobby did not initiate this removal:
        // it is the speedhack guard in GameRoom.handleInput. S1 owns the socket.
        this.sessionRoom.delete(msg.ev.id);
        this.kicked.add(msg.ev.id);
      }
      this.sessions.get(id)?.send(msg);
    },
    rttMs: (id) => this.sessions.get(id)?.rttMs() ?? 0,
  };

  constructor() {
    // all state initialized inline; explicit per the frozen export table
  }

  handleMessage(sess: Session, msg: C2S): void {
    try {
      this.sessions.set(sess.id, sess); // cheap re-registration; io bridge needs it
      switch (msg.t) {
        case 'list_rooms':
          this.listRooms(sess);
          break;
        case 'quick_join':
          this.quickJoin(sess, msg.name);
          break;
        case 'create_public':
          this.createPublic(sess, msg.name, msg.mapId);
          break;
        case 'create_private':
          this.createPrivate(sess, msg.name, msg.mapId);
          break;
        case 'join_private':
          this.joinPrivate(sess, msg.name, msg.code);
          break;
        case 'leave':
          this.leaveRoom(sess.id);
          break;
        case 'input':
          this.sessionRoom.get(sess.id)?.handleInput(sess.id, msg);
          break;
        case 'reload':
          this.sessionRoom.get(sess.id)?.handleReload(sess.id);
          break;
        case 'switch':
          this.sessionRoom.get(sess.id)?.handleSwitch(sess.id, msg.weapon);
          break;
        case 'buy':
          this.sessionRoom.get(sess.id)?.handleBuy(sess.id, msg.weapon);
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
   * input-stale players (NET.inputTimeoutMs, reported by room.stalePlayers())
   * plus room-kicked speedhackers. Also reaps empty rooms (private
   * immediately, public after PUBLIC_REAP_MS).
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
          tracked.room.visibility === 'private' || now - tracked.emptySince >= PUBLIC_REAP_MS;
        if (expired) {
          tracked.room.stop();
          this.rooms.delete(roomId); // safe: Map iteration tolerates deleting current
          console.log(`[lobby] room ${roomId} closed (empty ${tracked.room.visibility}); ${this.rooms.size} open`);
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
      if (room.visibility === 'public') rooms.push(room.info());
    }
    sess.send({ t: 'room_list', rooms });
  }

  private quickJoin(sess: Session, name: string): void {
    let room = this.findPublicRoom('warmup') ?? this.findPublicRoom(null);
    if (room === undefined) {
      if (this.rooms.size >= MAX_ROOMS) {
        this.sendError(sess, 'rooms_full', 'server is at capacity, try again later');
        return;
      }
      // random map pick: server-side generation uses rng(Date.now()) — RULE 7
      room = this.createRoom(rngPick(rng(Date.now()), MAP_LIST).id, 'public');
    }
    this.leaveRoom(sess.id);
    this.joinRoom(sess, room, name);
  }

  private createPublic(sess: Session, name: string, mapId: MapId): void {
    if (this.rooms.size >= MAX_ROOMS) {
      this.sendError(sess, 'rooms_full', 'server is at capacity, try again later');
      return;
    }
    const room = this.createRoom(mapId, 'public'); // listed by list_rooms, no code
    this.leaveRoom(sess.id);
    this.joinRoom(sess, room, name);
  }

  private createPrivate(sess: Session, name: string, mapId: MapId): void {
    if (this.rooms.size >= MAX_ROOMS) {
      this.sendError(sess, 'rooms_full', 'server is at capacity, try again later');
      return;
    }
    const room = this.createRoom(mapId, 'private'); // code generated by GameRoom
    this.leaveRoom(sess.id);
    this.joinRoom(sess, room, name);
  }

  private joinPrivate(sess: Session, name: string, code: string): void {
    let found: GameRoom | undefined;
    for (const { room } of this.rooms.values()) {
      if (room.visibility === 'private' && room.code === code) {
        found = room;
        break;
      }
    }
    if (found === undefined) {
      this.sendError(sess, 'no_room', 'no room with that code');
      return;
    }
    if (found.playerCount() >= MAX_PLAYERS) {
      this.sendError(sess, 'room_full', 'room is full');
      return;
    }
    this.leaveRoom(sess.id);
    this.joinRoom(sess, found, name);
  }

  /** First public room with space; when phase is set, only that phase. */
  private findPublicRoom(phase: 'warmup' | null): GameRoom | undefined {
    for (const { room } of this.rooms.values()) {
      if (room.visibility !== 'public' || room.playerCount() >= MAX_PLAYERS) continue;
      if (phase !== null && room.info().phase !== phase) continue;
      return room;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  private createRoom(mapId: MapId, visibility: 'public' | 'private'): GameRoom {
    const room = new GameRoom(mapId, visibility, this.io);
    this.rooms.set(room.id, { room, emptySince: Date.now() }); // born empty
    room.start();
    console.log(`[lobby] room ${room.id} created (${visibility}${room.code !== null ? `, code ${room.code}` : ''}, map ${mapId}); ${this.rooms.size} open`);
    return room;
  }

  private joinRoom(sess: Session, room: GameRoom, name: string): void {
    const tracked = this.rooms.get(room.id);
    if (tracked !== undefined) tracked.emptySince = null;
    this.sessionRoom.set(sess.id, room);
    room.addPlayer(sess.id, name); // sends 'joined' + broadcasts 'player_joined'
  }

  private leaveRoom(id: PlayerId): void {
    const room = this.sessionRoom.get(id);
    if (room === undefined) return;
    this.sessionRoom.delete(id); // before removePlayer: lobby-initiated, not a kick
    room.removePlayer(id);
    if (room.playerCount() > 0) return;
    const tracked = this.rooms.get(room.id);
    if (tracked === undefined) return;
    if (room.visibility === 'private') {
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
