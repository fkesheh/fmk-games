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
//
// P0 scale amendments (all additive, all default-compatible): stats reports
// enqueue for an off-tick batched flush instead of writing sqlite on the game
// tick (flushStats; close() drains); room capacity is opts/env-configurable
// with optional per-game caps (LobbyOptions/parseLobbyOpts); the stale sweep
// visits a round-robin slice per poll instead of every room; room-originated
// wire bytes are metered per room (wireStats) for the snapshot budget.
//
// P1 hosted authority (docs/PLATFORM.md §12): rooms for games declaring
// GameModule.hostedAuthority, created with settings.hosted === true, run
// COLD on the server (setHosted(true), start() never called — zero tick CPU)
// while one elected client sims authoritatively in the browser. The shim owns
// the lease table + renewal watchdog + election/promotion arbiter, relays
// player inputs to the holder and the holder's snapshots to the room
// (leaseId-validated; the id is a bearer token, unicast only). Two unrenewed
// lapses => sticky central fallback (the cold room starts simming). No game
// opts in yet, so every room today is central and behaves exactly as before.
// ============================================================================
import type {
  C2S,
  GameModule,
  GameRoomHandle,
  LobbyC2S,
  PlayerId,
  ProfileRef,
  RawEnvelope,
  RoomId,
  RoomInfo,
  RoomIO,
  S2C,
  StatsDelta,
  Visibility,
} from '@platform/shared';
import { CLAIM_ALPHABET, AUTH, PADS, STATS, isValidLeaseId, rng, rngInt } from '@platform/shared';
import type { Session } from './net.js';
import { WireMeter, type WireSnapshot } from './services/wireMeter.js';

const DEFAULT_MAX_ROOMS = 64; // platform-wide capacity guard unless opts/env say otherwise
const PUBLIC_REAP_MS = 30_000; // empty public rooms linger this long, then close
const STATS_QUEUE_CAP = 4096; // pending off-tick stats writes before oldest-drop
const DEFAULT_SWEEP_ROOMS_PER_POLL = 64; // stale sweep visits at most this many rooms per 1s poll
const HOST_LEASE_TTL_MS = 6000; // host must renew inside this; the 1s sweep watchdogs it
const HOST_SNAP_MAX_HZ = 60; // per-room host_snap relay cap (flood guard, pad_input precedent)
const HOST_MAX_LAPSES = 2; // consecutive unrenewed lapses before sticky central fallback
const LEASE_ID_LEN = 12; // bearer token length over CLAIM_ALPHABET (unicast only, never logged)

/**
 * The slice of the v2 Store the gateway actually needs (services/db.ts
 * satisfies this structurally; tests substitute a spy without touching
 * sqlite). null (the default, pre-v2 constructor arity) means profiles are
 * unavailable: auth answers auth_err and reportStats is a no-op.
 */
/** One clamped stats report awaiting an off-tick flush. */
export interface StatsWrite {
  profileId: string;
  gameId: string;
  delta: Record<string, number>;
}

export interface LobbyStore {
  profileIdByToken(token: string): string | null;
  profileById(id: string): { id: string; name: string } | null;
  addStats(profileId: string, gameId: string, delta: Record<string, number>): void;
  /**
   * P0-2: optional single-transaction batch. The lobby prefers it when present
   * (services/db.ts Store implements it); otherwise it loops addStats.
   */
  addStatsBatch?(entries: readonly StatsWrite[]): void;
}

/**
 * P0-3 capacity/sweep knobs. All optional; invalid values (non-integer, <= 0)
 * silently fall back to defaults — the lobby never throws over config.
 */
export interface LobbyOptions {
  /** Global room cap; default 64. Breaches answer 'rooms_full' as before. */
  maxRooms?: number;
  /** Per-game room caps by module id; games absent here are uncapped. */
  maxRoomsPerGame?: Record<string, number>;
  /** Rooms visited per pollStaleSessions call; default 64. Past that the sweep
   * rotates round-robin, so per-poll work stays bounded at room scale. */
  sweepRoomsPerPoll?: number;
}

function positiveIntOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * P0-3: read the env-configurable knobs (index.ts passes process.env).
 * PLATFORM_MAX_ROOMS / PLATFORM_SWEEP_ROOMS; garbage or absent => unset, and
 * the constructor default applies. Per-game caps are code config (LobbyOptions
 * only) — no env spelling. Pure + total, so tests cover it directly.
 */
export function parseLobbyOpts(env: Record<string, string | undefined>): LobbyOptions {
  const opts: LobbyOptions = {};
  const maxRooms = env.PLATFORM_MAX_ROOMS === undefined ? Number.NaN : Number(env.PLATFORM_MAX_ROOMS);
  if (Number.isInteger(maxRooms) && maxRooms > 0) opts.maxRooms = maxRooms;
  const sweep = env.PLATFORM_SWEEP_ROOMS === undefined ? Number.NaN : Number(env.PLATFORM_SWEEP_ROOMS);
  if (Number.isInteger(sweep) && sweep > 0) opts.sweepRoomsPerPoll = sweep;
  return opts;
}

/**
 * One minted pad pairing, keyed by its 6-char code. Single-use: consumed on
 * successful bind, deleted once expired (lazy GC at use sites).
 */
interface PendingPadPairing {
  roomId: RoomId;
  owner: PlayerId;
  expiresAt: number; // epoch ms
}

/** One live pad binding: padSessionId -> the room + owner player it feeds. */
interface PadBinding {
  roomId: RoomId;
  owner: PlayerId;
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
  'leave',
  'ping',
  // ---- v2 (specs/P4.md): routed BEFORE the raw-passthrough default ----
  'auth',
  'pad_pair_request',
  'join_as_pad',
  'pad_input',
  // ---- P1 hosted authority: host heartbeat, validated against the room lease ----
  'host_renew',
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

/** N-char code over CLAIM_ALPHABET from the shared non-gameplay stream. */
function mintCode(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CLAIM_ALPHABET.charAt(rngInt(rand, 0, CLAIM_ALPHABET.length - 1));
  }
  return out;
}

/** 6-char pairing code over CLAIM_ALPHABET (same shape as claim codes). */
function mintPairCode(): string {
  return mintCode(AUTH.claimCodeLen);
}

/** P1: one room's live hosting lease (the leaseId is a Bearer [REDACTED], unicast only). */
interface HostLease {
  leaseId: string;
  hostId: PlayerId;
  tick: number; // last renewed sim tick (resumeTick source on promotion)
  expiresAt: number; // epoch ms; pushed by every valid host_renew
}

interface TrackedRoom {
  room: GameRoomHandle;
  emptySince: number | null; // serverTime ms when the room last became empty
  // ---- hosted authority (P1); central rooms leave every one at its zero value ----
  hosted: boolean; // cold server room + elected browser host (never both simming)
  central: boolean; // sticky central fallback after HOST_MAX_LAPSES unrenewed lapses
  lease: HostLease | null;
  standbyId: PlayerId | null; // promotion runner-up, recomputed on membership change
  unhostedLapses: number; // consecutive expiries with zero valid renews
  snapWindowStart: number; // host_snap rate window (epoch ms)
  snapWindowCount: number; // host_snap frames relayed in the current window
}

/** Zero-value hosted fields for a fresh room; the hosted flag is set at creation. */
function freshTracked(room: GameRoomHandle, hosted: boolean): TrackedRoom {
  return {
    room,
    emptySince: Date.now(), // born empty
    hosted,
    central: false,
    lease: null,
    standbyId: null,
    unhostedLapses: 0,
    snapWindowStart: 0,
    snapWindowCount: 0,
  };
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
  private readonly maxRooms: number; // P0-3: global cap (opts/env/default)
  private readonly maxRoomsPerGame: Record<string, number>; // P0-3: sanitized copy
  private readonly sweepRoomsPerPoll: number; // P0-3: rooms visited per poll
  private sweepCursor = 0; // round-robin offset into the room key order
  private readonly sessions = new Map<PlayerId, Session>(); // every session that ever spoke
  private readonly sessionRoom = new Map<PlayerId, GameRoomHandle>(); // <= 1 room per session
  private readonly rooms = new Map<RoomId, TrackedRoom>();
  private readonly kicked = new Set<PlayerId>(); // room-initiated drops awaiting socket close
  /** Minted-but-unspent pad pairing codes. One code => one pending pairing. */
  private readonly pendingPads = new Map<string, PendingPadPairing>();
  /** Live pad bindings keyed by the PAD session's id (pads are never players). */
  private readonly pads = new Map<PlayerId, PadBinding>();
  /**
   * P0-2: off-tick stats queue. reportStats (called synchronously from game
   * tick threads) only clamps + enqueues; the sqlite write happens in
   * flushStats on a later turn of the event loop, so a slow disk never stalls
   * a 30Hz sim. Bounded: past STATS_QUEUE_CAP the oldest entry is dropped and
   * statsDroppedCount ticks (visible via statsDropped(), never silent).
   */
  private readonly statsQueue: StatsWrite[] = [];
  private statsFlushScheduled = false;
  private statsDroppedCount = 0;
  /** P0-1: per-room wire byte meter, fed by the io bridge below. */
  private readonly wire = new WireMeter();

  // Shared RoomIO for every room: resolves PlayerId -> Session and observes
  // player_left broadcasts to catch room-initiated removals. Unknown ids
  // (bots have no session) get a send no-op and rttMs 0. v2 members: profile
  // lookups read the session's auth state; stats are clamped + queued inside
  // try/catch (never throw into game threads); padOwner resolves a pad
  // SESSION id to the player seat it drives. P0-1: attributed sends feed the
  // wire meter (snapshots dominate room traffic, so this ≈ snapshot bytes).
  private readonly io: RoomIO = {
    send: (id, msg) => {
      const leftId = playerLeftId(msg);
      if (leftId !== null && this.sessionRoom.has(leftId)) {
        // Mapping still present => the lobby did not initiate this removal:
        // the room kicked the player (fps: the speedhack guard). The lobby owns the socket.
        this.sessionRoom.delete(leftId);
        this.kicked.add(leftId);
        this.unbindPadsForOwner(leftId, true); // kicked owners lose their pads too
      }
      const bytes = this.sessions.get(id)?.send(msg as S2C); // game S2C envelopes pass through untouched
      if (typeof bytes === 'number' && bytes > 0) {
        const room = this.sessionRoom.get(id);
        // Unmapped ids (the kicked player's own final frames, never-seated
        // ids) carry no room: skipped, never misattributed.
        if (room !== undefined) this.wire.add(room.id, room.info().game, bytes);
      }
    },
    rttMs: (id) => this.sessions.get(id)?.rttMs() ?? 0,
    profileId: (id) => this.sessions.get(id)?.profileId ?? '',
    reportStats: (playerId, delta) => this.reportStats(playerId, delta),
    padOwner: (padSessionId) => this.pads.get(padSessionId)?.owner ?? null,
  };

  /**
   * `store` is optional so every pre-v2 caller (`new Lobby([mod])`) stays
   * valid: without it auth answers auth_err and reportStats no-ops. `opts`
   * (P0-3) is likewise optional: omitted => the historical 64-room behavior.
   */
  constructor(modules: readonly GameModule[], store: LobbyStore | null = null, opts: LobbyOptions = {}) {
    this.modules = modules; // registry order matters: [0] is the default game
    this.store = store;
    this.maxRooms = positiveIntOr(opts.maxRooms, DEFAULT_MAX_ROOMS);
    const perGame: Record<string, number> = {};
    if (opts.maxRoomsPerGame !== undefined) {
      for (const gameId of Object.keys(opts.maxRoomsPerGame)) {
        const cap = opts.maxRoomsPerGame[gameId];
        if (typeof cap === 'number' && Number.isInteger(cap) && cap > 0) perGame[gameId] = cap;
      }
    }
    this.maxRoomsPerGame = perGame;
    this.sweepRoomsPerPoll = positiveIntOr(opts.sweepRoomsPerPoll, DEFAULT_SWEEP_ROOMS_PER_POLL);
  }

  handleMessage(sess: Session, msg: C2S): void {
    try {
      this.sessions.set(sess.id, sess); // cheap re-registration; io bridge needs it
      if (!isLobbyMsg(msg)) {
        if (msg.t === 'host_snap') {
          this.hostSnapshot(sess, msg); // P1: validated + relayed; never reaches the room
          return;
        }
        // room-level pass-through: the RAW object goes to the session's room;
        // the game validates it with its own protocol parser
        const room = this.sessionRoom.get(sess.id);
        room?.handleMessage(sess.id, msg);
        // P1-2: in hosted rooms the envelope ALSO rides to the lease holder —
        // inputs AND start intents alike, so the host sim is the only thing
        // that can leave the lobby phase. The room already got it for
        // seats/liveness (cold rooms ignore sim branches via setHosted).
        if (room !== undefined) this.relayToHost(sess.id, room, msg);
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
        case 'leave':
          // A bound pad's leave unbinds (owner hears pad_status bound:false);
          // no-op for non-pads. Mirrors handleDisconnect — without this the
          // leave path silently keeps the binding (pads are never in
          // sessionRoom, so leaveRoom below returns early for them).
          this.detachPad(sess.id, true);
          this.leaveRoom(sess.id, true); // explicit leave: permanent removal
          break;
        case 'ping':
          break; // answered at the transport layer (net.ts); never routed
        // ---- v2 (specs/P4.md): routed before the raw-passthrough default ----
        case 'auth':
          this.authSession(sess, msg.token);
          break;
        case 'pad_pair_request':
          this.padPairRequest(sess);
          break;
        case 'join_as_pad':
          this.joinAsPad(sess, msg.room, msg.token);
          break;
        case 'pad_input':
          this.padInput(sess.id, msg);
          break;
        // ---- P1 hosted authority ----
        case 'host_renew':
          this.hostRenew(sess, msg.leaseId, msg.tick);
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
      this.detachPad(sess.id, true);
      // leaveRoom below also unbinds pads owned by this session; the explicit
      // call after it is the safety net for removals that bypassed the
      // session->room map (room kicks already deleted it).
      this.leaveRoom(sess.id);
      this.unbindPadsForOwner(sess.id, false);
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
   * P0-1: cumulative room-traffic wire counters (snapshot budget input).
   * Totals run since construction/resetWireStats; `rooms` covers open rooms.
   */
  wireStats(): WireSnapshot {
    return this.wire.snapshot();
  }

  /** P0-1: zero the wire meter (soak harness samples deltas across resets). */
  resetWireStats(): void {
    this.wire.reset();
  }

  /**
   * Polled by index.ts every 1s. Returns sessions whose socket must close:
   * input-stale players (reported by room.stalePlayers()) plus room-kicked
   * players. Also reaps empty rooms (private immediately, public after
   * PUBLIC_REAP_MS).
   *
   * P0-3: the room walk is staggered — at most sweepRoomsPerPoll rooms per
   * call, rotating round-robin — so per-poll work stays bounded when rooms
   * number in the hundreds. Kicked-session draining is NOT sliced (it never
   * touches rooms). At <= 64 rooms with default opts this visits everything
   * every poll, exactly the historical behavior.
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
      const ids = [...this.rooms.keys()];
      const total = ids.length;
      const slice = Math.min(this.sweepRoomsPerPoll, total);
      for (let i = 0; i < slice; i++) {
        const roomId = total === 0 ? undefined : ids[(this.sweepCursor + i) % total];
        if (roomId === undefined) continue;
        const tracked = this.rooms.get(roomId);
        if (tracked === undefined) continue; // reaped earlier in this same slice
        if (tracked.hosted && !tracked.central) this.checkLease(tracked, now); // P1-3 renewal watchdog
        for (const id of tracked.room.stalePlayers()) {
          const sess = this.sessions.get(id);
          if (sess !== undefined) out.push(sess);
          this.sessionRoom.delete(id); // before removePlayer: lobby-initiated
          tracked.room.removePlayer(id);
          this.onMemberLeft(tracked.room, id); // P2-1: stale host loss promotes too
          this.unbindPadsForOwner(id, true); // stale owner loses its pads too
        }
        if (tracked.room.playerCount() > 0) {
          tracked.emptySince = null;
          continue;
        }
        if (tracked.emptySince === null) tracked.emptySince = now;
        // Ghost-bearing rooms (even private) get the grace window — see
        // leaveRoom; they are "reconnecting", not "abandoned".
        const privateSweep =
          tracked.room.info().visibility === 'private' &&
          tracked.room.hasRebindableSeats?.() !== true;
        const expired = privateSweep || now - tracked.emptySince >= PUBLIC_REAP_MS;
        if (expired) {
          tracked.room.stop();
          this.rooms.delete(roomId);
          this.wire.drop(roomId); // meter keeps open rooms only
          this.unbindPadsForRoom(roomId); // a closed room takes its pads with it
          console.log(
            `[lobby] room ${roomId} closed (empty ${tracked.room.info().visibility}); ${this.rooms.size} open`,
          );
        }
      }
      // Reaps inside the slice shift key order, so the cursor is approximate
      // after a reap-heavy poll — acceptable for a sweep (rooms just get
      // visited a poll early/late), and exact in the common no-reap case.
      this.sweepCursor = total === 0 ? 0 : (this.sweepCursor + slice) % total;
    } catch (err) {
      console.error('[lobby] pollStaleSessions failed', err);
    }
    return out;
  }

  /** Server shutdown: stop every room tick; sockets are NetServer's concern. */
  close(): void {
    this.flushStats(); // drain pending stats before the store goes away
    for (const { room } of this.rooms.values()) room.stop();
    this.rooms.clear();
    this.sessionRoom.clear();
    this.sessions.clear();
    this.kicked.clear();
    this.pendingPads.clear();
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
      if (this.atCapacity(mod.id)) {
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
    if (this.atCapacity(mod.id)) {
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
    if (this.atCapacity(mod.id)) {
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
   * P0-3: true when creating another room for this game would breach the
   * global cap OR that game's per-game cap. The per-game walk is O(rooms) but
   * room creation is rare (joins reuse), so no index is worth it.
   */
  private atCapacity(gameId: string): boolean {
    if (this.rooms.size >= this.maxRooms) return true;
    const perGame = this.maxRoomsPerGame[gameId];
    if (perGame === undefined) return false;
    let n = 0;
    for (const { room } of this.rooms.values()) {
      if (room.info().game === gameId) {
        n += 1;
        if (n >= perGame) return true;
      }
    }
    return false;
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
    // P1: hosted ⟺ the game declares hostedAuthority AND settings ask for it
    // AND the room implements setHosted (cold mode). Anything less => central.
    const hostedAsk = settings !== undefined && settings.hosted === true;
    const hosted = mod.hostedAuthority === true && hostedAsk && room.setHosted !== undefined;
    this.rooms.set(room.id, freshTracked(room, hosted));
    if (hosted) {
      room.setHosted?.(true); // cold: seats + liveness only; start() NEVER runs (zero tick CPU)
    } else {
      if (mod.hostedAuthority === true && hostedAsk) {
        console.log(`[lobby] room ${room.id} asked for hosted but the room has no setHosted — central`);
      }
      room.start();
    }
    const code = room.info().code;
    console.log(
      `[lobby] room ${room.id} created (${visibility}${code !== null ? `, code ${code}` : ''}, game ${mod.id}${hosted ? ', hosted' : ''}); ${this.rooms.size} open`,
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
    // sig is a pure pass-through, same as resume: the platform never reads,
    // dedups, or steers on it — only the room interprets it (module.ts's
    // rebind rule, resume first then sig). Keeping that logic out of the
    // lobby is what lets "one session per browser" stay a room-level policy
    // decision rather than a platform-wide rule nobody asked for here.
    room.addPlayer(sess.id, name, resume, sig); // the room sends its own join payload
    // P1-3: a hosted room with no lease elects on first seat (aces law: no
    // start press needed — the lease IS the starter pistol). Later joins only
    // refresh the standby runner-up; the lease never churns on membership.
    const hosted = this.rooms.get(room.id);
    if (hosted !== undefined && hosted.hosted && !hosted.central) {
      if (hosted.lease === null) this.electHost(hosted, Date.now(), 0);
      else if (hosted.lease.hostId !== sess.id) {
        hosted.standbyId = this.runnerUp(room, hosted.lease.hostId);
      }
    }
  }

  private leaveRoom(id: PlayerId, permanent = false): void {
    const room = this.sessionRoom.get(id);
    if (room === undefined) return;
    this.sessionRoom.delete(id); // before removePlayer: lobby-initiated, not a kick
    room.removePlayer(id, permanent);
    this.onMemberLeft(room, id); // P2-1: host loss promotes NOW (seats/ghosts proceed untouched)
    // The departing player's pads unbind with them; they are still connected
    // here (leave != disconnect), so they DO hear bound:false.
    this.unbindPadsForOwner(id, true);
    if (room.playerCount() > 0) return;
    const tracked = this.rooms.get(room.id);
    if (tracked === undefined) return;
    // A room with rebindable ghost seats is "reconnecting", not "abandoned":
    // it gets the grace window (reseats land in ~2s) instead of an immediate
    // stop — otherwise near-simultaneous drops sweep a live private room and
    // strand both players on no_room. Rooms without the hook (absent => no
    // ghosts) sweep exactly as before.
    const ghosts = room.hasRebindableSeats?.() === true;
    if (room.info().visibility === 'private' && !ghosts) {
      room.stop(); // empty private rooms close immediately
      this.rooms.delete(room.id);
      this.wire.drop(room.id); // meter keeps open rooms only
      this.unbindPadsForRoom(room.id); // a closed room takes its pads with it
      console.log(`[lobby] room ${room.id} closed (empty private); ${this.rooms.size} open`);
    } else if (tracked.emptySince === null) {
      tracked.emptySince = Date.now(); // public rooms (and ghost-bearing rooms) get a grace window
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
   * maxKeysPerDelta keys) and ENQUEUE for an off-tick flush — this runs on a
   * game tick thread, so it must never touch sqlite (P0-2). Profile + game id
   * are snapshotted now (the room may close before the flush lands).
   * Anonymous/unknown players and room-less ids no-op; nothing here may ever
   * throw into a game thread.
   */
  private reportStats(playerId: PlayerId, delta: StatsDelta): void {
    try {
      if (this.store === null) return; // pre-v2 wiring: stats have nowhere to go
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
      if (this.statsQueue.length >= STATS_QUEUE_CAP) {
        this.statsQueue.shift(); // oldest-drop: backpressure must not grow memory
        this.statsDroppedCount += 1;
      }
      this.statsQueue.push({ profileId: profile, gameId: room.info().game, delta: clamped });
      if (!this.statsFlushScheduled) {
        this.statsFlushScheduled = true;
        setImmediate(() => this.flushStats()); // off the tick's call stack
      }
    } catch (err) {
      console.error('[lobby] reportStats failed', err);
    }
  }

  /**
   * P0-2: drain the stats queue into the store — one batch transaction when
   * the store supports it, else one addStats per entry. Runs off-tick via
   * setImmediate, synchronously from close(), and directly in tests. Empty
   * queue => no store touch. Never throws (a broken DB must not break the
   * gateway); a failed batch is dropped, not retried, and logged loudly.
   */
  flushStats(): void {
    this.statsFlushScheduled = false;
    if (this.statsQueue.length === 0) return;
    const store = this.store;
    if (store === null) {
      this.statsQueue.length = 0;
      return;
    }
    const batch = this.statsQueue.splice(0, this.statsQueue.length);
    try {
      if (store.addStatsBatch !== undefined) {
        store.addStatsBatch(batch);
      } else {
        for (const w of batch) store.addStats(w.profileId, w.gameId, w.delta);
      }
    } catch (err) {
      console.error('[lobby] flushStats failed, dropping batch', err);
    }
  }

  /** Queued-but-unflushed stats writes (harness/tests introspection). */
  statsPending(): number {
    return this.statsQueue.length;
  }

  /** Entries dropped by oldest-drop backpressure since construction. */
  statsDropped(): number {
    return this.statsDroppedCount;
  }

  // -------------------------------------------------------------------------
  // P1 — hosted authority: lease table, election, watchdog, relay
  // -------------------------------------------------------------------------

  /**
   * Live lease holder of a room, or null (central rooms, and hosted rooms
   * between host loss and promotion, always read null). Harness/tests
   * introspection; the relay path never needs it.
   */
  hostOf(roomId: RoomId): PlayerId | null {
    const tracked = this.rooms.get(roomId);
    if (tracked === undefined || !tracked.hosted || tracked.central) return null;
    return tracked.lease?.hostId ?? null;
  }

  /** Seated session ids of one room, in session-registration (age) order. */
  private roomMembers(room: GameRoomHandle): PlayerId[] {
    const out: PlayerId[] = [];
    for (const [id, r] of this.sessionRoom) {
      if (r === room) out.push(id);
    }
    return out;
  }

  /**
   * P1-3: host candidates ranked — measured RTT first (an unmeasured 0 sorts
   * AFTER every real sample: prefer a known-good link), lowest rtt wins,
   * ties break to the longest-lived session (registration order). Pads are
   * never candidates. Election-time only, so O(sessions log sessions) is fine.
   */
  private rankMembers(room: GameRoomHandle): PlayerId[] {
    const age = new Map<PlayerId, number>();
    let i = 0;
    for (const id of this.sessions.keys()) age.set(id, i++);
    const rttOf = (id: PlayerId): number => this.sessions.get(id)?.rttMs() ?? 0;
    return this.roomMembers(room)
      .filter((id) => !this.pads.has(id) && this.sessions.has(id))
      .sort((a, b) => {
        const ra = rttOf(a);
        const rb = rttOf(b);
        const ua = ra > 0 ? 0 : 1;
        const ub = rb > 0 ? 0 : 1;
        if (ua !== ub) return ua - ub;
        if (ra !== rb) return ra - rb;
        return (age.get(a) ?? 0) - (age.get(b) ?? 0);
      });
  }

  /** Best candidate that is NOT the holder — the promotion runner-up. */
  private runnerUp(room: GameRoomHandle, hostId: PlayerId): PlayerId | null {
    return this.rankMembers(room).find((id) => id !== hostId) ?? null;
  }

  /** Seat a fresh lease on the best candidate (new bearer id every time). */
  private electHost(tracked: TrackedRoom, now: number, resumeTick: number): void {
    const ranked = this.rankMembers(tracked.room);
    const hostId = ranked[0];
    if (hostId === undefined) {
      tracked.lease = null; // vacant: no candidates (room is draining)
      tracked.standbyId = null;
      return;
    }
    this.seatLease(tracked, hostId, ranked[1] ?? null, resumeTick, now);
  }

  /** Issue the lease: unicast the bearer id to the holder, broadcast the change. */
  private seatLease(
    tracked: TrackedRoom,
    hostId: PlayerId,
    standbyId: PlayerId | null,
    resumeTick: number,
    now: number,
  ): void {
    const leaseId = mintCode(LEASE_ID_LEN);
    tracked.lease = { leaseId, hostId, tick: resumeTick, expiresAt: now + HOST_LEASE_TTL_MS };
    tracked.standbyId = standbyId;
    // The leaseId travels ONLY here (unicast) — the room broadcast below and
    // every log line MUST NOT carry it (bearer token: whoever holds it sims).
    this.sessions.get(hostId)?.send({ t: 'host_lease', leaseId, hostId, ttlMs: HOST_LEASE_TTL_MS });
    this.broadcastToRoom(tracked.room, { t: 'host_change', newHostId: hostId, resumeTick });
  }

  /** One room-wide fan-out that is NOT game traffic (skips the io bridge). */
  private broadcastToRoom(room: GameRoomHandle, msg: S2C): void {
    for (const id of this.roomMembers(room)) this.sessions.get(id)?.send(msg);
  }

  /**
   * P1-3: promote the standby (preferred — the lapsed holder is probably gone)
   * or, with no live standby, re-elect among whoever remains. Either way the
   * bearer id rotates: an old loop presenting it gets host_revoked and halts.
   */
  private promoteStandby(tracked: TrackedRoom, now: number, resumeTick: number): void {
    const standby = tracked.standbyId;
    if (standby !== null && this.sessionRoom.get(standby) === tracked.room && this.sessions.has(standby)) {
      const next = this.rankMembers(tracked.room).filter((id) => id !== standby);
      this.seatLease(tracked, standby, next[0] ?? null, resumeTick, now);
    } else {
      this.electHost(tracked, now, resumeTick);
    }
  }

  /**
   * P1-3: sticky central fallback — nobody in this room renewed twice running,
   * so nobody CAN host (old clients, dead tabs). The cold room un-colds and
   * starts simming; members hear host_change(null) and render server snaps.
   * One way: a central room never re-hosts (re-hosting is pilot work).
   */
  private revokeToCentral(tracked: TrackedRoom, resumeTick: number): void {
    tracked.central = true;
    tracked.lease = null;
    tracked.standbyId = null;
    tracked.room.setHosted?.(false);
    tracked.room.start(); // idempotent; the cold room never started
    this.broadcastToRoom(tracked.room, { t: 'host_change', newHostId: null, resumeTick });
    console.log(`[lobby] room ${tracked.room.id} fell back to central (no renewable host)`);
  }

  /**
   * P1-3 renewal watchdog, run from the 1s staggered sweep per visited hosted
   * room. A vacant lease with seated players elects immediately (host reaped
   * as stale between polls); an expired lease promotes or, after
   * HOST_MAX_LAPSES unrenewed lapses, falls back to central.
   */
  private checkLease(tracked: TrackedRoom, now: number): void {
    const lease = tracked.lease;
    if (lease === null) {
      if (tracked.room.playerCount() > 0) this.electHost(tracked, now, 0);
      return;
    }
    if (now < lease.expiresAt) return;
    tracked.unhostedLapses += 1;
    if (tracked.unhostedLapses >= HOST_MAX_LAPSES) {
      this.revokeToCentral(tracked, lease.tick);
      return;
    }
    this.promoteStandby(tracked, now, lease.tick);
  }

  /**
   * P2-1: a member left (explicit leave, drop, or stale reap — all funnel
   * through here). Host loss promotes synchronously instead of waiting out
   * the TTL; standby loss just recomputes the runner-up. Seats and ghosts
   * are the room's business and proceed untouched — promotion never disturbs
   * them (the ex-host rebinds later as an ordinary member via resume/sig).
   */
  private onMemberLeft(room: GameRoomHandle, id: PlayerId): void {
    const tracked = this.rooms.get(room.id);
    if (tracked === undefined || !tracked.hosted || tracked.central) return;
    const lease = tracked.lease;
    if (lease !== null && lease.hostId === id) {
      this.promoteStandby(tracked, Date.now(), lease.tick);
    } else if (tracked.standbyId === id) {
      tracked.standbyId = lease === null ? null : this.runnerUp(room, lease.hostId);
    }
  }

  /**
   * P1: host heartbeat. Exact holder + bearer match pushes the expiry and
   * records the tick (any valid renew proves the room CAN host, resetting the
   * lapse counter). Anything else — wrong sender, stale id, no lease, central
   * room — earns a host_revoked echo of the PRESENTED id (never the live one)
   * so the orphaned loop halts instead of split-braining.
   */
  private hostRenew(sess: Session, leaseId: string, tick: number): void {
    const room = this.sessionRoom.get(sess.id);
    if (room === undefined) return;
    const tracked = this.rooms.get(room.id);
    if (tracked === undefined || !tracked.hosted || tracked.central) return;
    const lease = tracked.lease;
    if (lease === null || lease.hostId !== sess.id || lease.leaseId !== leaseId) {
      sess.send({ t: 'host_revoked', leaseId });
      return;
    }
    lease.tick = tick;
    lease.expiresAt = Date.now() + HOST_LEASE_TTL_MS;
    tracked.unhostedLapses = 0;
  }

  /**
   * P1: a host snapshot frame. Validated (holder + bearer id), rate-capped,
   * relayed to every seated member except the sender, bytes metered. Forged
   * or stale frames are dropped and their sender told to halt. NEVER reaches
   * room.handleMessage — the cold room must not see host traffic.
   */
  private hostSnapshot(sess: Session, msg: RawEnvelope): void {
    const room = this.sessionRoom.get(sess.id);
    if (room === undefined) return;
    const tracked = this.rooms.get(room.id);
    if (tracked === undefined || !tracked.hosted || tracked.central) return;
    const lease = tracked.lease;
    const presented = msg.leaseId;
    if (lease === null || lease.hostId !== sess.id || !isValidLeaseId(presented) || presented !== lease.leaseId) {
      if (isValidLeaseId(presented)) sess.send({ t: 'host_revoked', leaseId: presented });
      return;
    }
    const now = Date.now();
    if (now - tracked.snapWindowStart >= 1000) {
      tracked.snapWindowStart = now;
      tracked.snapWindowCount = 0;
    }
    if (tracked.snapWindowCount >= HOST_SNAP_MAX_HZ) return;
    tracked.snapWindowCount += 1;
    const game = room.info().game;
    for (const id of this.roomMembers(room)) {
      if (id === sess.id) continue;
      const bytes = this.sessions.get(id)?.send(msg as S2C);
      if (typeof bytes === 'number' && bytes > 0) this.wire.add(room.id, game, bytes);
    }
  }

  /**
   * P1-2: in hosted rooms every player envelope ALSO rides to the lease holder
   * (inputs AND start intents — the host sim is the only thing that can leave
   * the lobby phase). Central rooms, vacant leases, and the holder's own mail
   * short-circuit to nothing.
   */
  private relayToHost(fromId: PlayerId, room: GameRoomHandle, msg: RawEnvelope): void {
    const tracked = this.rooms.get(room.id);
    if (tracked === undefined || !tracked.hosted || tracked.central) return;
    const lease = tracked.lease;
    if (lease === null || lease.hostId === fromId) return;
    this.sessions.get(lease.hostId)?.send(msg as S2C);
  }

  // -------------------------------------------------------------------------
  // v2 — pad pairing + input relay (specs/P4.md)
  // -------------------------------------------------------------------------

  /** Drop expired pending pairings; called lazily wherever a code is minted. */
  private gcExpiredPairings(now: number): void {
    if (this.pendingPads.size === 0) return;
    for (const [code, pending] of this.pendingPads) {
      if (pending.expiresAt <= now) this.pendingPads.delete(code); // safe mid-iteration
    }
  }

  /**
   * In-room player mints a single-use pairing code. The reply carries the
   * code plus the exact /pad/ URL to open on the phone (game + room baked in,
   * so the pad page can join without typing anything but the code).
   */
  private padPairRequest(sess: Session): void {
    const room = this.sessionRoom.get(sess.id);
    if (room === undefined) {
      this.sendError(sess, 'no_room', 'join a room before pairing a pad');
      return;
    }
    this.gcExpiredPairings(Date.now());
    let code: string | null = null;
    for (let attempt = 0; attempt < 16 && code === null; attempt++) {
      const candidate = mintPairCode();
      if (!this.pendingPads.has(candidate)) code = candidate; // collision ~impossible in 32^6
    }
    if (code === null) {
      this.sendError(sess, 'pad_busy', 'could not allocate a pairing code, try again');
      return;
    }
    this.pendingPads.set(code, {
      roomId: room.id,
      owner: sess.id,
      expiresAt: Date.now() + PADS.pairTtlMs,
    });
    sess.send({
      t: 'pad_pair',
      room: room.id,
      token: code,
      urlPath: `/pad/?game=${room.info().game}&r=${room.id}`,
    });
  }

  /**
   * A pad device spends its code: bind this session to (room, owner). The
   * code is consumed ONLY on success — wrong-room or gone-owner attempts
   * leave it spendable where it belongs. Pads are never added to the room:
   * no seat, no RoomInfo count, no stale sweep.
   */
  private joinAsPad(sess: Session, roomId: string, token: string): void {
    const reject = (reason: string): void => {
      sess.send({ t: 'pad_rejected', reason });
    };
    if (this.pads.has(sess.id)) {
      reject('already_bound');
      return;
    }
    const pending = this.pendingPads.get(token);
    if (pending === undefined) {
      reject('bad_code'); // unknown, already used, or expired-and-collected
      return;
    }
    if (pending.expiresAt <= Date.now()) {
      this.pendingPads.delete(token);
      reject('expired_code');
      return;
    }
    if (pending.roomId !== roomId) {
      reject('room_mismatch'); // code stays valid for its own room
      return;
    }
    const ownerRoom = this.sessionRoom.get(pending.owner);
    if (ownerRoom === undefined || ownerRoom.id !== pending.roomId) {
      this.pendingPads.delete(token);
      reject('owner_gone'); // owner left the room between mint and bind
      return;
    }
    this.pendingPads.delete(token); // single-use: consumed on successful bind
    this.pads.set(sess.id, { roomId: pending.roomId, owner: pending.owner, windowStart: Date.now(), windowCount: 0 });
    sess.send({ t: 'pad_joined' });
    this.sessions.get(pending.owner)?.send({ t: 'pad_status', bound: true });
    console.log(`[lobby] pad ${sess.id} paired to ${pending.owner} in room ${pending.roomId}`);
  }

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
    // P1-2: hosted rooms drive the sim on the holder, so pad frames ride there
    // too (under the pad session id; the browser io resolves the seat — pilot).
    this.relayToHost(padSessionId, tracked.room, msg);
    this.sessions.get(padSessionId)?.send({ t: 'pad_input_echo', seq: msg.seq });
  }

  /**
   * Remove one pad binding. `notifyOwner` is false on paths where the owner
   * is itself going away (its socket is closing / already told).
   */
  private detachPad(padSessionId: PlayerId, notifyOwner: boolean): void {
    const binding = this.pads.get(padSessionId);
    if (binding === undefined) return;
    this.pads.delete(padSessionId);
    if (!notifyOwner) return;
    this.sessions.get(binding.owner)?.send({ t: 'pad_status', bound: false });
  }

  /** Unbind every pad owned by this player (owner left/was removed/disconnected). */
  private unbindPadsForOwner(ownerId: PlayerId, notifyOwner: boolean): void {
    for (const padId of [...this.pads.keys()]) {
      const binding = this.pads.get(padId);
      if (binding === undefined || binding.owner !== ownerId) continue;
      this.detachPad(padId, false);
    }
    if (!notifyOwner) return;
    this.sessions.get(ownerId)?.send({ t: 'pad_status', bound: false });
  }

  /** Unbind every pad feeding a closing room (empty reap, private close). */
  private unbindPadsForRoom(roomId: RoomId): void {
    for (const [padId, binding] of [...this.pads]) {
      if (binding.roomId !== roomId) continue;
      this.detachPad(padId, true);
    }
  }
}
