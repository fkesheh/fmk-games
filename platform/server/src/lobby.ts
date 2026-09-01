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
//
// v2 (specs/P4.md), all additive: an optional Store gives sessions ws auth
// (`auth` -> sess.profileId -> auth_ok/auth_err) and a stats sink
// (RoomIO.reportStats: clamp to STATS limits, write through store.addStats,
// never throw into game threads). Pad pairing is platform-level: a player in
// a room mints a single-use 6-char code (PADS.pairTtlMs TTL); any session can
// spend it via `join_as_pad` to become a PAD session for that (room, owner).
// Pads are NOT players — never added to rooms, invisible to RoomInfo counts,
// exempt from stale sweeping by construction. Their only routed message is
// `pad_input`, relayed RAW into the room under the pad session's id (+ echo
// ack) at <= PADS.inputMaxHz; unbind on pad disconnect / owner leave /
// room close always tells the owner {t:'pad_status', bound:false}.
// The four new C2S tags are routed BEFORE the raw-passthrough default.
// ============================================================================
import type {
  C2S,
  GameModule,
  GameRoomHandle,
  LobbyC2S,
  PlayerId,
  ProfileRef,
  RoomId,
  RoomInfo,
  RoomIO,
  S2C,
  StatsDelta,
  Visibility,
} from '@platform/shared';
import { CLAIM_ALPHABET, AUTH, PADS, STATS, rng, rngInt, RTC } from '@platform/shared';
import type { Session } from './net.js';

const MAX_ROOMS = 64; // platform-wide capacity guard
const PUBLIC_REAP_MS = 30_000; // empty public rooms linger this long, then close

/**
 * The slice of the v2 Store the gateway actually needs (services/db.ts
 * satisfies this structurally; tests substitute a spy without touching
 * sqlite). null (the default, pre-v2 constructor arity) means profiles are
 * unavailable: auth answers auth_err and reportStats is a no-op.
 */
export interface LobbyStore {
  profileIdByToken(token: string): string | null;
  profileById(id: string): { id: string; name: string } | null;
  addStats(profileId: string, gameId: string, delta: Record<string, number>): void;
}

/**
 * One minted pad pairing, keyed by its 6-char code. Single-use: consumed on
 * successful bind, deleted once expired (lazy GC at use sites).
 */
/** One live pad binding: padSessionId -> the room + owner player it feeds. */
/** Per-sender signal rate window (epoch-ms start + admitted count). */
interface RtcWindow {
  start: number;
  count: number;
}

interface PadBinding {
  roomId: RoomId;
  windowStart: number; // epoch ms of the current input-rate window
  windowCount: number; // pad_input frames admitted in the current window
}

const LOBBY_TAGS: ReadonlySet<string> = new Set([
  'list_rooms',
  'quick_join',
  'join_public',
  'create_public',
  'create_private',
  'join_private',
  'join_as_pad',
  'leave',
  'ping',
  // ---- v2 (docs/PLATFORM.md §5): routed BEFORE the raw-passthrough default.
  // pad_pair_request is deliberately ABSENT: docs/PAD.md freezes it as raw
  // pass-through reaching the ROOM, which mints + replies itself. ----
  'auth',
  'join_as_pad',
  'pad_input',
]);

/** parseC2S emits a parsed LobbyC2S for lobby tags; anything else is a raw envelope. */
function isLobbyMsg(msg: C2S): msg is LobbyC2S {
  return LOBBY_TAGS.has(msg.t);
}

/**
 * Server-side non-gameplay randomness per the platform rule ("Math.random is
 * a repo-wide violation"): ONE module-scope stream seeded rng(Date.now()), the
 * wordbomb-module convention — two pairings minted in the same millisecond
 * would otherwise draw identical code sequences.
 */
const rand: () => number = rng(Date.now());

/** 6-char pairing code over CLAIM_ALPHABET (same shape as claim codes). */
interface TrackedRoom {
  room: GameRoomHandle;
  emptySince: number | null; // serverTime ms when the room last became empty
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
  private readonly store: LobbyStore | null;
  private readonly sessions = new Map<PlayerId, Session>(); // every session that ever spoke
  private readonly sessionRoom = new Map<PlayerId, GameRoomHandle>(); // <= 1 room per session
  private readonly rooms = new Map<RoomId, TrackedRoom>();
  private readonly rtcWindows = new Map<PlayerId, RtcWindow>();
  private readonly kicked = new Set<PlayerId>(); // room-initiated drops awaiting socket close
  /** Minted-but-unspent pad pairing codes. One code => one pending pairing. */
  /** Live pad bindings keyed by the PAD session's id (pads are never players). */
  private readonly pads = new Map<PlayerId, PadBinding>();

  // Shared RoomIO for every room: resolves PlayerId -> Session and observes
  // player_left broadcasts to catch room-initiated removals. Unknown ids
  // (bots have no session) get a send no-op and rttMs 0. v2 members: profile
  // lookups read the session's auth state; stats are clamped + written
  // through the store inside try/catch (never throw into game threads);
  // padOwner resolves a pad SESSION id to the player seat it drives.
  private readonly io: RoomIO = {
    send: (id, msg) => {
      const leftId = playerLeftId(msg);
      if (leftId !== null && this.sessionRoom.has(leftId)) {
        // Mapping still present => the lobby did not initiate this removal:
        // the room kicked the player (fps: the speedhack guard). The lobby owns the socket.
        const kickedRoomId = this.sessionRoom.get(leftId)?.id ?? null;
        this.sessionRoom.delete(leftId);
        if (kickedRoomId !== null) this.broadcastRtcPeers(kickedRoomId);
        this.kicked.add(leftId);
        /* pad bindings are room-scoped now; room close reaps them */
      }
      this.sessions.get(id)?.send(msg as S2C); // game S2C envelopes pass through untouched
    },
    rttMs: (id) => this.sessions.get(id)?.rttMs() ?? 0,
    profileId: (id) => this.sessions.get(id)?.profileId ?? '',
    reportStats: (playerId, delta) => this.reportStats(playerId, delta),
  };

  /**
   * `store` is optional so every pre-v2 caller (`new Lobby([mod])`) stays
   * valid: without it auth answers auth_err and reportStats no-ops.
   */
  constructor(modules: readonly GameModule[], store: LobbyStore | null = null) {
    this.modules = modules; // registry order matters: [0] is the default game
    this.store = store;
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
          this.quickJoin(sess, msg.name, msg.game, msg.resume, msg.sig);
          break;
        case 'join_public':
          this.joinPublic(sess, msg.name, msg.roomId, msg.resume, msg.sig);
          break;
        case 'create_public':
          this.createPublic(sess, msg.name, msg.game, msg.settings, msg.resume, msg.sig);
          break;
        case 'create_private':
          this.createPrivate(sess, msg.name, msg.game, msg.settings, msg.resume, msg.sig);
          break;
        case 'join_private':
          this.joinPrivate(sess, msg.name, msg.code, msg.resume, msg.sig);
          break;
        case 'join_as_pad':
          this.joinAsPad(sess, msg.room, msg.token);
          break;
        case 'leave':
          this.leaveRoom(sess.id, true); // explicit leave: permanent removal
          break;
        case 'ping':
          break; // answered at the transport layer (net.ts); never routed
        // ---- v2 (docs/PLATFORM.md §5): routed before the raw default ----
        case 'auth':
          this.authSession(sess, msg.token);
          break;
        case 'pad_input': // normalized-frame channel; pair_request stays RAW (docs/PAD.md)
          this.padInput(sess.id, msg);
          break;
        case 'rtc_signal': // P2P rendezvous relay (docs/PLATFORM.md §12)
          this.rtcSignal(sess.id, msg.to, msg.data);
          break;
      }
    } catch (err) {
      console.error('[lobby] handleMessage failed', err);
    }
  }

  handleDisconnect(sess: Session): void {
    try {
      // If THIS session was a bound pad, its owner must hear the unbind
      // (spec: pad disconnect => owner {t:'pad_status', bound:false}).
      this.detachPad(sess.id);
      // leaveRoom below also unbinds pads owned by this session; the explicit
      // call after it is the safety net for removals that bypassed the
      // session->room map (room kicks already deleted it).
      this.leaveRoom(sess.id);
      /* nothing: pads are not owned at lobby level anymore */
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
          const staleRoomId = tracked.room.id;
          this.sessionRoom.delete(id); // before removePlayer: lobby-initiated
          this.broadcastRtcPeers(staleRoomId);
          tracked.room.removePlayer(id);
          /* nothing: see above */
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
          this.unbindPadsForRoom(roomId); // a closed room takes its pads with it
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
    this.pads.clear();
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

  private quickJoin(
    sess: Session,
    name: string,
    game: string | undefined,
    resume: PlayerId | undefined,
    sig: string | undefined,
  ): void {
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
    this.joinRoom(sess, room, name, resume, sig);
  }

  private joinPublic(
    sess: Session,
    name: string,
    roomId: string,
    resume: PlayerId | undefined,
    sig: string | undefined,
  ): void {
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
    this.joinRoom(sess, tracked.room, name, resume, sig);
  }

  private createPublic(
    sess: Session,
    name: string,
    game: string | undefined,
    settings: Record<string, unknown> | undefined,
    resume: PlayerId | undefined,
    sig: string | undefined,
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
    this.joinRoom(sess, room, name, resume, sig);
  }

  private createPrivate(
    sess: Session,
    name: string,
    game: string | undefined,
    settings: Record<string, unknown> | undefined,
    resume: PlayerId | undefined,
    sig: string | undefined,
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
    this.joinRoom(sess, room, name, resume, sig);
  }

  private joinPrivate(
    sess: Session,
    name: string,
    code: string,
    resume: PlayerId | undefined,
    sig: string | undefined,
  ): void {
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
    this.joinRoom(sess, found, name, resume, sig);
  }

  /**
   * Pad (phone-as-controller) bind. `room` is a room REFERENCE that may be
   * either a public roomId or a private join code — the pad page scanned a QR
   * and cannot know which, so the lobby resolves both (see docs/PAD.md).
   *
   * A pad is NOT a player: no addPlayer, no seat, no room_full check, and
   * emptySince is deliberately left alone so a lone pad cannot keep an empty
   * room alive. The token is validated by the ROOM, not here — tokens are
   * game-level state the room minted.
   */
  private joinAsPad(sess: Session, room: string, token: string): void {
    const found = this.resolveRoomRef(room);
    if (found === undefined) {
      this.sendError(sess, 'no_room', 'no room with that id or code');
      return;
    }
    if (found.addPad === undefined) {
      this.sendError(sess, 'pad_unsupported', 'this game has no phone-controller mode');
      return;
    }
    // A pad session must not stay seated in a previous room; drop any prior
    // membership first (also covers a pad rescanning a second QR).
    this.leaveRoom(sess.id);
    if (!found.addPad(sess.id, token)) {
      this.sendError(sess, 'pad_rejected', 'pairing token invalid, expired or already used');
      return;
    }
    // Register for the v2 normalized-frame relay + rate cap (owner stays
    // ROOM-level state per docs/PAD.md; the lobby never needs it).
    this.pads.set(sess.id, { roomId: found.id, windowStart: Date.now(), windowCount: 0 });
    // Route this session's room-level messages to the room from here on. Note
    // we do NOT clear tracked.emptySince: pads never keep a room alive.
    this.sessionRoom.set(sess.id, found);
    this.broadcastRtcPeers(found.id);
  }

  /** A pad's `room` field: public roomId first, then private join code (case-insensitive). */
  private resolveRoomRef(ref: string): GameRoomHandle | undefined {
    const byId = this.rooms.get(ref);
    if (byId !== undefined) return byId.room;
    const want = ref.toLowerCase();
    for (const { room } of this.rooms.values()) {
      const code = room.info().code;
      if (code !== null && code.toLowerCase() === want) return room;
    }
    return undefined;
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

  private joinRoom(
    sess: Session,
    room: GameRoomHandle,
    name: string,
    resume: PlayerId | undefined,
    sig: string | undefined,
  ): void {
    const tracked = this.rooms.get(room.id);
    if (tracked !== undefined) tracked.emptySince = null;
    this.sessionRoom.set(sess.id, room);
    this.broadcastRtcPeers(room.id);
    // sig is a pure pass-through, same as resume: the platform never reads,
    // dedups, or steers on it — only the room interprets it (module.ts's
    // rebind rule, resume first then sig). Keeping that logic out of the
    // lobby is what lets "one session per browser" stay a room-level policy
    // decision rather than a platform-wide rule nobody asked for here.
    room.addPlayer(sess.id, name, resume, sig); // the room sends its own join payload
  }

  private leaveRoom(id: PlayerId, permanent = false): void {
    const room = this.sessionRoom.get(id);
    if (room === undefined) return;
    const leftRoomId = this.sessionRoom.get(id)?.id ?? null;
    this.sessionRoom.delete(id); // before removePlayer: lobby-initiated, not a kick
    if (leftRoomId !== null) this.broadcastRtcPeers(leftRoomId);
    room.removePlayer(id, permanent);
    // The departing player's pads unbind with them; they are still connected
    // here (leave != disconnect), so they DO hear bound:false.
    /* pad ownership is room-level (docs/PAD.md) */
    if (room.playerCount() > 0) return;
    const tracked = this.rooms.get(room.id);
    if (tracked === undefined) return;
    if (room.info().visibility === 'private') {
      room.stop(); // empty private rooms close immediately
      this.rooms.delete(room.id);
      this.unbindPadsForRoom(room.id); // a closed room takes its pads with it
      console.log(`[lobby] room ${room.id} closed (empty private); ${this.rooms.size} open`);
    } else if (tracked.emptySince === null) {
      tracked.emptySince = Date.now(); // public rooms get a grace window
    }
  }

  private sendError(sess: Session, code: string, message: string): void {
    sess.send({ t: 'error', code, message });
  }

  // -------------------------------------------------------------------------
  // v2 — session auth (specs/P4.md)
  // -------------------------------------------------------------------------

  /**
   * `auth {token}`: resolve the bearer token through the store and bind the
   * profile to this session. Idempotent by design — a second auth simply
   * replaces the first (protocol.ts's contract). Any store failure degrades
   * to auth_err: a broken DB must never take the ws path down with it.
   */
  private authSession(sess: Session, token: string): void {
    const store = this.store;
    if (store === null) {
      sess.send({ t: 'auth_err', message: 'profiles unavailable on this server' });
      return;
    }
    try {
      const profileId = store.profileIdByToken(token);
      if (profileId === null) {
        sess.send({ t: 'auth_err', message: 'invalid or expired token' });
        return;
      }
      const profile = store.profileById(profileId);
      if (profile === null) {
        sess.send({ t: 'auth_err', message: 'profile no longer exists' });
        return;
      }
      sess.profileId = profile.id;
      sess.send({ t: 'auth_ok', profileId: profile.id, name: profile.name });
    } catch (err) {
      console.error('[lobby] auth failed', err);
      sess.send({ t: 'auth_err', message: 'authentication failed' });
    }
  }

  // -------------------------------------------------------------------------
  // v2 — stats sink (RoomIO.reportStats)
  // -------------------------------------------------------------------------

  /**
   * Clamp to STATS limits (finite values only, |v| <= maxValue, at most
   * maxKeysPerDelta keys) and write through to the store under the room's
   * game id. Anonymous/unknown players and room-less ids no-op; nothing here
   * may ever throw into a game thread.
   */
  private reportStats(playerId: PlayerId, delta: StatsDelta): void {
    try {
      const store = this.store;
      if (store === null) return; // pre-v2 wiring: stats have nowhere to go
      const profile = this.sessions.get(playerId)?.profileId ?? '';
      if (profile === '') return; // anonymous (or bot): nothing to persist
      const room = this.sessionRoom.get(playerId);
      if (room === undefined) return; // game id comes from the player's own room
      let kept = 0;
      const clamped: Record<string, number> = {};
      for (const key of Object.keys(delta)) {
        if (kept >= STATS.maxKeysPerDelta) break;
        const value = delta[key];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        clamped[key] = Math.max(-STATS.maxValue, Math.min(STATS.maxValue, value));
        kept += 1;
      }
      if (kept === 0) return;
      store.addStats(profile, room.info().game, clamped);
    } catch (err) {
      console.error('[lobby] reportStats failed', err);
    }
  }

  // -------------------------------------------------------------------------
  // v2 — pad pairing + input relay (specs/P4.md)
  // -------------------------------------------------------------------------

  /** Drop expired pending pairings; called lazily wherever a code is minted. */

  /**
   * The ONLY message a pad session gets routed: relayed RAW into the room
   * under the PAD session's own id (the game resolves the owning seat via
   * RoomIO.padOwner), then acked for RTT estimation. Rate-capped at
   * PADS.inputMaxHz per pad per second window — excess frames are dropped
   * silently (no forward, no echo). Unbound pads are dropped too.
   */
  private padInput(padSessionId: PlayerId, msg: Extract<LobbyC2S, { t: 'pad_input' }>): void {
    const binding = this.pads.get(padSessionId);
    if (binding === undefined) return;
    const tracked = this.rooms.get(binding.roomId);
    if (tracked === undefined) return; // room closed under us (unbind races are synchronous)
    const now = Date.now();
    if (now - binding.windowStart >= 1000) {
      binding.windowStart = now;
      binding.windowCount = 0;
    }
    if (binding.windowCount >= PADS.inputMaxHz) return;
    binding.windowCount += 1;
    tracked.room.handleMessage(padSessionId, msg);
    this.sessions.get(padSessionId)?.send({ t: 'pad_input_echo', seq: msg.seq });
  }

  /** Remove one pad binding (lobby-level registry only; owner notify is ROOM-level). */
  private detachPad(padSessionId: PlayerId): void {
    this.pads.delete(padSessionId);
  }

  /**
   * P2P presence (docs/PLATFORM.md §12 P2): push the room's connected
   * non-pad session ids to every member. Cheap (rooms are small); clients
   * use it for deterministic host selection — lowest id hosts.
   */
  private broadcastRtcPeers(roomId: RoomId): void {
    const ids: PlayerId[] = [];
    for (const [sid, room] of this.sessionRoom) {
      if (room.id === roomId && !this.pads.has(sid)) ids.push(sid);
    }
    ids.sort();
    const msg = { t: 'rtc_peers', ids } as const;
    for (const [sid, room] of this.sessionRoom) {
      if (room.id === roomId && !this.pads.has(sid)) this.sessions.get(sid)?.send(msg);
    }
  }

  /**
   * P2P rendezvous (docs/PLATFORM.md §12 P1): forward one opaque WebRTC
   * signal to a peer in the SAME room. Content-blind, size-capped by
   * parseC2S, rate-capped here. Unknown/cross-room targets drop silently.
   */
  private rtcSignal(fromId: PlayerId, toId: PlayerId, data: unknown): void {
    const room = this.sessionRoom.get(fromId);
    if (room === undefined) return;
    const target = this.sessionRoom.get(toId);
    if (target === undefined || target.id !== room.id) return;
    const now = Date.now();
    let win = this.rtcWindows.get(fromId);
    if (win === undefined || now - win.start >= 1000) {
      win = { start: now, count: 0 };
      this.rtcWindows.set(fromId, win);
    }
    win.count += 1;
    if (win.count > RTC.maxSignalsPerSec) return;
    this.sessions.get(toId)?.send({ t: 'rtc_signal', from: fromId, data });
  }

  /** Unbind every pad feeding a closing room (empty reap, private close). */
  private unbindPadsForRoom(roomId: RoomId): void {
    for (const padId of [...this.pads.keys()]) {
      if (this.pads.get(padId)?.roomId !== roomId) continue;
      this.detachPad(padId);
    }
  }
}
