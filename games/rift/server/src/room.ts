// ============================================================================
// ANCIENTS (rift) room (CONTRACT §2/§5) — authoritative MOBA room hosting the
// wave-2 modules: sim core (sim/world.ts), ability engine (sim/abilities.ts),
// vision (sim/vision.ts) and bots (bots.ts). Mirrors the wordbomb room's
// discipline: deps injected (ports.ts), no GameRoomHandle member ever throws,
// one phase timer slot, preallocated per-player snapshot objects mutated in
// place, and a headless seam — the public tickOnce() — that runs exactly one
// sim tick + snapshot push (the interval driver just calls it, guarded; T13's
// balance harness and room.test.ts pump it directly).
//
// Phase ladder:  lobby -(rift_start, then LOBBY_COUNTDOWN_MS)-> lock -> live
//                -(ancient falls / hard cap)-> ended -(MATCH_END_MS)-> lobby
//                (bots removed, sim discarded, picks KEPT — and it WAITS).
//
// Fog discipline (CONTRACT §4/§5): vision sets are computed twice per tick
// (once per team) and reused for bot percepts, cast-event filtering and
// snapshots. Structures go to everyone every tick (hp <= 0 = destroyed);
// own-team mobiles always; enemy mobiles only when in their team's set; wards
// only for the owning team (the sets encode this); 'proj' ents are in both
// sets by T5's rule. Cast events go ONLY to teams whose set holds the caster.
//
// NOTHING AUTO-STARTS. The room leaves `lobby` only because a seated human
// sent {t:'rift_start'} while canStart held. I6: no member of GameRoomHandle
// throws; one bad tick is caught and logged by the interval driver and never
// kills the interval.
// ============================================================================
import {
  buildMap,
  FOUNTAIN_RADIUS,
  HERO_LIST,
  HERO_VISION,
  heroById,
  INVENTORY_SLOTS,
  isPlayerTeam,
  LANES_FOR_TEAM_SIZE,
  LOBBY_COUNTDOWN_MS,
  MATCH_END_MS,
  MAX_PLAYERS,
  MAX_TEAM_SIZE,
  MIN_PLAYERS,
  MIN_TEAM_SIZE,
  parseRiftC2S,
  ROOM_ALPHABET,
  ROOM_CODE_LEN,
  ROOM_ID_LEN,
  STARTING_GOLD,
  STARTING_SKILL_POINTS,
  TICK_RATE,
} from '@rift/shared';
import type {
  AbilitySnap,
  BoardEntry,
  EndReason,
  EntKind,
  EntSnap,
  HeroId,
  ItemId,
  MapDef,
  Phase,
  PlayerStats,
  RiftEvent,
  RiftS2C,
  RiftSettings,
  RosterEntry,
  TeamId,
} from '@rift/shared';
import { rngInt } from '@platform/shared';
import type {
  GameRoomHandle,
  PlayerId,
  RoomId,
  RoomInfo,
  RoomIO,
  Visibility,
} from '@platform/shared';
import type { RoomDeps } from './ports.js';
import { createWorld } from './sim/world.js';
import { createAbilitiesEngine, ITEM_EVENT_SLOT_BASE } from './sim/abilities.js';
import { computeTeamVisible } from './sim/vision.js';
import { createBotBrain } from './bots.js';
import { NO_ENT } from './sim/types.js';
import type {
  BotBrain,
  BotPercept,
  CampPercept,
  Ent,
  EntId,
  Order,
  SeatDef,
  SimEvent,
  World,
} from './sim/types.js';

// ---- wire aliases (the frozen S2C shapes this room emits) --------------------
type RiftHello = Extract<RiftS2C, { t: 'rift_hello' }>;
type RiftLobby = Extract<RiftS2C, { t: 'rift_lobby' }>;
type RiftBegin = Extract<RiftS2C, { t: 'rift_begin' }>;

/** HERO_LIST is non-empty by shared-data construction; the fallback only
 *  exists to satisfy noUncheckedIndexedAccess. */
const FIRST_HERO: HeroId = HERO_LIST[0]?.id ?? 'bullwark';

/** FNV-1a over the room id, mixed with the seat index — deterministic bot
 *  brain seeds, room-local (the platform exports no such helper; CONTRACT §5
 *  assigns these 20 lines to T10). */
function hashSeed(roomId: string, index: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < roomId.length; i++) {
    h ^= roomId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= index >>> 0;
  h = Math.imul(h, 0x01000193);
  return h >>> 0;
}

function randomToken(next: () => number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET.charAt(rngInt(next, 0, ROOM_ALPHABET.length - 1));
  return s;
}

function isStructureKind(k: EntKind): boolean {
  return k === 'tower' || k === 'guard' || k === 'ancient';
}

/**
 * Server-side seat record. Array insertion order IS join order (CONTRACT §2
 * lane round-robin and bot-fill ordering). One seat per hero for the whole
 * match: late joiners and resume rebinds MUTATE the seat (and the hero ent's
 * pid) rather than creating a new one, so K/D/A and loot attribution follow
 * the hero, not the socket.
 */
interface Seat {
  pid: PlayerId;
  name: string;
  team: TeamId;
  /** True for bot-fill seats and for permanent leavers (seat converted). */
  bot: boolean;
  connected: boolean;
  /** Manual lobby pick; duplicates across humans are allowed (six heroes,
   *  up to sixteen seats). null = cycle-assigned. */
  pick: HeroId | null;
  /** Locked hero; null before lock and again after full-reset. */
  hero: HeroId | null;
  lane: number; // assigned at lock, round-robin per team in join order
  entId: EntId; // hero ent in the live world; NO_ENT outside a match
  /** Non-null while bot-driven (bot seats AND disconnected ghosts). */
  brain: BotBrain | null;
  /** Insertion-order index at lock — the hashSeed(roomId, index) input. */
  seatIndex: number;
}

/** Mutable mirror of YouSnap (the frozen wire type's arrays are readonly-typed). */
interface YouMut {
  hero: HeroId;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  level: number;
  xp: number;
  gold: number;
  kills: number;
  deaths: number;
  assists: number;
  skillPoints: number;
  respawnAtTick: number;
  abilities: AbilitySnap[];
  items: (ItemId | null)[];
  itemCharges: number[];
  itemCdUntilTick: number[];
}

/** Mutable mirror of the rift_snap wire shape — preallocated per channel. */
interface SnapMut {
  t: 'rift_snap';
  tick: number;
  serverTime: number;
  phase: Phase;
  matchTick: number;
  overtime: boolean;
  wardStock: number;
  kills: [number, number];
  board: BoardEntry[];
  you: YouMut | null;
  ents: EntSnap[];
}

/**
 * Per-connected-human send state. The snapshot object, its YouSnap, the ents
 * array and every EntSnap in the pool are allocated ONCE (when the human
 * connects into a live room) and mutated in place every tick — no per-tick
 * allocation in the hot path (CONTRACT §11.6). io.send JSON-encodes
 * synchronously (platform Session), so mutating after send is safe.
 */
interface Channel {
  readonly seat: Seat;
  readonly snap: SnapMut;
  readonly you: YouMut;
  readonly entPool: Map<EntId, EntSnap>;
}

export class RiftRoom implements GameRoomHandle {
  readonly id: RoomId;
  readonly code: string | null;
  readonly visibility: Visibility;

  private readonly io: RoomIO;
  private readonly settings: RiftSettings; // frozen for this room's lifetime
  private readonly deps: RoomDeps; // rand, injected (ports.ts)

  private seats: Seat[] = []; // insertion order = join order
  private readonly channels = new Map<PlayerId, Channel>();

  private phase: Phase = 'lobby';
  private countdownEndsAt = 0; // absolute ms; 0 unless a lobby countdown runs

  // --- live-match state (null/reset outside a match) ---
  private world: World | null = null;
  private mapDef: MapDef | null = null;
  private lockedTeamSize = 0; // 0 until locked — info().label switch
  private lockedLanes = 0;
  private beginMsg: RiftBegin | null = null; // re-sent to live joiners
  private lastEndEv: RiftEvent | null = null; // re-sent to ended-phase joiners
  /** Caller-owned vision sets, one per team, refilled every tick (T5 seam). */
  private readonly visSets: [Set<EntId>, Set<EntId>] = [new Set(), new Set()];
  /** Reused BotPercept.visible buffer — valid only during feedBot (T6 seam). */
  private readonly perceptBuf: Ent[] = [];
  /** Reused camp table for bot percepts (TERRAIN_CONTRACT §5): ONE
   *  CampPercept per World.camps entry, built at lock; only `up` is refreshed
   *  in place each tick, so feeding eight bots allocates nothing. */
  private readonly campPercepts: CampPercept[] = [];
  /** Fountain anchors (own ancient positions) for bot atFountain percepts. */
  private readonly fountainX: [number, number] = [0, 0];
  private readonly fountainZ: [number, number] = [0, 0];
  /** Caster ent id -> fx tag for colouring their projectiles (see noteCastFx). */
  private readonly projFx = new Map<EntId, string>();
  /** Auto-assignment hero cycle (LEAST-picked first at lock, wrapping). */
  private heroCycle: HeroId[] = HERO_LIST.map((d) => d.id);
  private heroCycleIdx = 0;
  /** Shared scoreboard rows, rebuilt per tick — identical for every client. */
  private readonly boardRows: BoardEntry[] = [];
  private snapSeq = 0; // room-monotonic snapshot counter (survives world resets)

  private phaseTimer: ReturnType<typeof setTimeout> | null = null; // countdown | matchEnd
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    visibility: Visibility,
    io: RoomIO,
    settings: RiftSettings,
    deps: RoomDeps,
  ) {
    this.visibility = visibility;
    this.io = io;
    this.settings = { ...settings }; // defensive copy: settings never mutate
    this.deps = deps;
    // Ids come from the injected rand (CONTRACT §5: "from ROOM_ALPHABET via
    // the injected rand") — the module-scope stream is reserved for ids, so
    // tests substituting a constant rand simply get constant ids.
    this.id = randomToken(this.deps.rand, ROOM_ID_LEN);
    this.code = visibility === 'private' ? randomToken(this.deps.rand, ROOM_CODE_LEN) : null;
  }

  // -------------------------------------------------------------------------
  // GameRoomHandle surface — none of these may throw (I6)
  // -------------------------------------------------------------------------

  info(): RoomInfo {
    return {
      id: this.id,
      code: this.code,
      game: 'rift',
      label: this.lockedTeamSize > 0 ? `${this.lockedTeamSize}v${this.lockedTeamSize}` : 'lobby',
      // connected humans — the lobby list's fullness signal (CONTRACT §2);
      // seats (humans + bots) would over-report a bot-filled room as full.
      players: this.playerCount(),
      maxPlayers: MAX_PLAYERS,
      // Reported verbatim. An earlier local experiment mapped 'lobby' to
      // 'warmup' to court quick_join's fps-convention preference; PR #6 closed
      // the quick-join collisions a different way and its lobby.test.ts asserts
      // the 'lobby' fallback path explicitly, so the mapping is gone.
      phase: this.phase,
      visibility: this.visibility,
    };
  }

  /** Connected humans. The platform uses this for its empty-room reaper and
   *  its coarse room_full guard; the fine guard lives in addPlayer (a live
   *  room full of displaceable bots must still accept joiners). */
  playerCount(): number {
    return this.connectedHumans();
  }

  /** The platform's own liveness handles dead sockets (CONTRACT §2). */
  stalePlayers(): PlayerId[] {
    return [];
  }

  addPlayer(id: PlayerId, name: string, resume?: PlayerId): void {
    try {
      const self = this.seats.find((s) => s.pid === id);
      if (self !== undefined) {
        if (!self.connected) this.rebindSeat(self, id, name); // same-id ghost rejoin
        else self.name = name;
        this.sendJoinPayloads(self);
        this.afterMembershipChange();
        return;
      }
      if (resume !== undefined && this.rebindGhost(resume, id, name)) return;
      if (this.phase === 'lobby') {
        if (this.connectedHumans() >= MAX_PLAYERS) {
          // Must agree with the platform's own guard (room.playerCount(), i.e.
          // connected humans) — seats.length drifts above that count because a
          // non-permanent lobby leave deliberately keeps a ghost seat for
          // reconnect, so comparing seats.length here COULD map a joiner into
          // a room they hold no seat in. Never throws.
          this.io.send(id, { t: 'error', code: 'room_full', message: 'room is full' });
          return;
        }
        const seat: Seat = {
          pid: id,
          name,
          team: this.smallerTeam(),
          bot: false,
          connected: true,
          pick: null,
          hero: null,
          lane: 0,
          entId: NO_ENT,
          brain: null,
          seatIndex: 0,
        };
        this.seats.push(seat);
        this.sendJoinPayloads(seat);
        this.afterMembershipChange();
        return;
      }
      this.joinLive(id, name);
    } catch (err) {
      console.error('[rift] addPlayer failed', err);
    }
  }

  /**
   * permanent=false/omitted (socket dropped): the hero STAYS in the sim,
   * driven by a FRESH bot brain until addPlayer(id, name, resume) rebinds it
   * (score, items, cooldowns intact — the seat and ent are mutated, never
   * recreated). permanent=true (explicit leave): the seat converts to a bot
   * permanently and becomes displaceable by late joiners.
   */
  removePlayer(id: PlayerId, permanent?: boolean): void {
    try {
      const idx = this.seats.findIndex((s) => s.pid === id);
      if (idx < 0) return;
      const seat = this.seats[idx];
      if (seat === undefined || !seat.connected) return;
      seat.connected = false;
      this.channels.delete(id);

      if (this.phase === 'lobby') {
        if (permanent === true) this.seats.splice(idx, 1);
        // a lobby countdown with nobody left to start for dies in silence
        if (this.countdownEndsAt !== 0 && this.connectedHumans() < MIN_PLAYERS) {
          this.clearPhaseTimer();
          this.countdownEndsAt = 0;
        }
        this.afterMembershipChange();
        return;
      }
      // live / ended: the hero never leaves the sim (CONTRACT §2)
      seat.brain = createBotBrain(hashSeed(this.id, seat.seatIndex), seat.hero ?? FIRST_HERO);
      if (permanent === true) seat.bot = true;
      this.afterMembershipChange();
    } catch (err) {
      console.error('[rift] removePlayer failed', err);
    }
  }

  handleMessage(id: PlayerId, msg: unknown): void {
    try {
      const parsed = parseRiftC2S(msg);
      if (parsed === null) return; // malformed: dropped in silence
      const seat = this.seats.find((s) => s.pid === id);
      if (seat === undefined || !seat.connected) return;
      switch (parsed.t) {
        case 'rift_pick':
          this.handlePick(seat, parsed.hero);
          return;
        case 'rift_start':
          this.tryStart();
          return;
        case 'rift_order':
          if (parsed.kind === 'stop') this.handleOrder(seat, { kind: 'stop' });
          else if (parsed.kind === 'attack') this.handleOrder(seat, { kind: 'attack', target: parsed.target });
          else this.handleOrder(seat, { kind: parsed.kind, x: parsed.x, z: parsed.z });
          return;
        case 'rift_cast':
          this.handleCast(seat, parsed.slot, parsed.x ?? null, parsed.z ?? null, parsed.target ?? NO_ENT);
          return;
        case 'rift_item':
          this.handleItem(seat, parsed.slot, parsed.x ?? null, parsed.z ?? null);
          return;
        case 'rift_buy':
          this.handleBuy(seat, parsed.item);
          return;
        case 'rift_skill':
          this.handleSkill(seat, parsed.slot);
          return;
      }
    } catch (err) {
      console.error('[rift] handleMessage failed', err);
    }
  }

  start(): void {
    this.stopped = false; // idempotent
    if (this.phase === 'live') this.armInterval(); // restart after stop()
  }

  stop(): void {
    this.stopped = true;
    this.clearTickInterval();
    this.clearPhaseTimer();
  }

  // -------------------------------------------------------------------------
  // The headless seam: exactly one sim tick + snapshot push. The interval
  // driver calls this through tickGuarded; tests and T13 pump it directly.
  // -------------------------------------------------------------------------

  tickOnce(): void {
    const w = this.world;
    if (this.phase !== 'live' || w === null || this.stopped) return;
    // Vision FIRST: bots think with fresh sets, cast events filter with the
    // same sets, snapshots serialize from them (computed twice per tick).
    computeTeamVisible(w, 0, this.visSets[0]);
    computeTeamVisible(w, 1, this.visSets[1]);
    // Refresh camp liveness in place (index === CampState.id by construction).
    for (let i = 0; i < this.campPercepts.length; i++) {
      const p = this.campPercepts[i];
      const c = w.camps[i];
      if (p !== undefined && c !== undefined) p.up = c.aliveCount > 0;
    }
    // Bots think BEFORE the world ticks, and their commands go through the
    // SAME handlers human messages hit — no code path a human can't hit.
    for (const s of this.seats) {
      const brain = s.brain;
      if (brain === null) continue;
      const ent = w.get(s.entId);
      if (ent === undefined) continue;
      this.feedBot(s, ent, brain, w);
    }
    w.advance();
    this.dispatchEvents(w, w.drainEvents());
    if (this.phase !== 'live') return; // an ancient fell / hard cap hit this tick
    this.pushSnapshots(w);
  }

  private tickGuarded(): void {
    try {
      this.tickOnce();
    } catch (err) {
      console.error('[rift] tick failed', err); // one bad tick never kills the interval
    }
  }

  // -------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------

  private connectedHumans(): number {
    let n = 0;
    for (const s of this.seats) if (s.connected && !s.bot) n++;
    return n;
  }

  /** Smaller team by seated humans; ties -> team 0 (CONTRACT §2). */
  private smallerTeam(): TeamId {
    let c0 = 0;
    let c1 = 0;
    for (const s of this.seats) {
      if (s.team === 0) c0 += 1;
      else c1 += 1;
    }
    return c0 <= c1 ? 0 : 1;
  }

  /** The single source of truth for rift_start acceptance AND canStart. */
  private startAllowed(): boolean {
    return this.phase === 'lobby' && this.countdownEndsAt === 0 && this.connectedHumans() >= MIN_PLAYERS;
  }

  /**
   * teamSize = settings.teamSize ?? auto (smallest size in [2..8] seating
   * every human: ceil(humans/2) clamped). An explicit teamSize too small for
   * the humans already seated expands toward auto — a press of START must
   * never strand a seated human outside the match.
   */
  private resolvedTeamSize(): number {
    const humans = this.seats.length;
    const auto = Math.min(MAX_TEAM_SIZE, Math.max(MIN_TEAM_SIZE, Math.ceil(humans / 2)));
    let c0 = 0;
    let c1 = 0;
    for (const s of this.seats) {
      if (s.team === 0) c0 += 1;
      else c1 += 1;
    }
    const wanted = Math.max(this.settings.teamSize ?? auto, c0, c1, MIN_TEAM_SIZE);
    return Math.min(MAX_TEAM_SIZE, wanted);
  }

  /**
   * Any hero, picked by any number of humans: duplicates are allowed and
   * expected once teamSize exceeds the hero count (6 heroes, up to 16 seats).
   * `hero` is already a validated HeroId (parseRiftC2S / isHeroId) by the time
   * this runs. A pick outside the lobby phase is ignored in silence and never
   * throws. Accepted picks broadcast a rift_pick event + fresh lobby.
   */
  private handlePick(seat: Seat, hero: HeroId): void {
    if (this.phase !== 'lobby') return;
    seat.pick = hero;
    this.broadcastEvent({ t: 'rift_pick', id: seat.pid, hero });
    this.broadcastLobby();
  }

  /** THE MANUAL START — the only door out of `lobby`. Any seated human may
   *  press it; illegal presses (mid-countdown, mid-match, below MIN_PLAYERS)
   *  are ignored in silence. */
  private tryStart(): void {
    if (!this.startAllowed()) return;
    this.countdownEndsAt = Date.now() + LOBBY_COUNTDOWN_MS;
    this.setPhaseTimer(() => {
      this.countdownEndsAt = 0;
      if (this.phase === 'lobby' && this.connectedHumans() >= MIN_PLAYERS) this.lock();
      else this.broadcastLobby();
    }, LOBBY_COUNTDOWN_MS);
    this.broadcastLobby();
  }

  // -------------------------------------------------------------------------
  // Lock: seat fill, heroes, lanes, world build, rift_begin
  // -------------------------------------------------------------------------

  private nextCycleHero(): HeroId {
    const list = this.heroCycle;
    const h = list[this.heroCycleIdx % Math.max(1, list.length)];
    this.heroCycleIdx += 1;
    return h ?? FIRST_HERO; // list non-empty by construction
  }

  private lock(): void {
    if (this.phase !== 'lobby') return;
    const teamSize = this.resolvedTeamSize();
    const lanes = LANES_FOR_TEAM_SIZE[teamSize] ?? 1;

    // Heroes: manual picks first (duplicates across humans allowed — the Set
    // below just collapses repeats when building the cycle's exclusion list);
    // the cycle starts at the first un-picked hero and wraps with duplicates
    // allowed too (CONTRACT §2).
    const manual = new Set<HeroId>();
    for (const s of this.seats) if (s.pick !== null) manual.add(s.pick);
    const avail: HeroId[] = [];
    for (const def of HERO_LIST) if (!manual.has(def.id)) avail.push(def.id);
    this.heroCycle = avail.length > 0 ? avail : HERO_LIST.map((d) => d.id);
    this.heroCycleIdx = 0;
    for (const s of this.seats) s.hero = s.pick ?? this.nextCycleHero();

    // Bots fill every seat to teamSize per team (`Bot N`, insertion order =
    // join order — humans all precede them).
    let botN = 1;
    for (const team of [0, 1] as const) {
      let count = 0;
      for (const s of this.seats) if (s.team === team) count += 1;
      while (count < teamSize) {
        this.seats.push({
          pid: `bot-${botN}`,
          name: `Bot ${botN}`,
          team,
          bot: true,
          connected: false,
          pick: null,
          hero: this.nextCycleHero(),
          lane: 0,
          entId: NO_ENT,
          brain: null,
          seatIndex: 0,
        });
        botN += 1;
        count += 1;
      }
    }

    // Lane assignment: round-robin across lanes per team in join order,
    // humans AND bots (seat i of a team -> lane i % lanes).
    for (const team of [0, 1] as const) {
      let i = 0;
      for (const s of this.seats) {
        if (s.team !== team) continue;
        s.lane = i % lanes;
        i += 1;
      }
    }
    this.seats.forEach((s, i) => {
      s.seatIndex = i;
    });

    // Build the world (deterministic map; injected engine + rand per the seam).
    const map = buildMap(lanes);
    this.mapDef = map;
    const seatDefs: SeatDef[] = this.seats.map((s) => ({
      pid: s.pid,
      team: s.team,
      hero: s.hero ?? FIRST_HERO,
      bot: s.bot,
      lane: s.lane,
    }));
    const w = createWorld(map, seatDefs, this.deps.rand, createAbilitiesEngine());
    this.world = w;
    // Camp percept table: one entry per World.camps entry, in the same order
    // (index === id); only `up` ever changes, refreshed per tick in tickOnce.
    this.campPercepts.length = 0;
    for (const c of w.camps) {
      this.campPercepts.push({ id: c.id, tier: c.def.tier, x: c.def.x, z: c.def.z, up: c.aliveCount > 0 });
    }

    // Bind hero ents to seats (pid is the join-order-unique seat key).
    const byPid = new Map<PlayerId, Seat>();
    for (const s of this.seats) byPid.set(s.pid, s);
    for (const e of w.mobiles()) {
      if (e.kind !== 'hero' || e.pid === null) continue;
      const seat = byPid.get(e.pid);
      if (seat !== undefined) seat.entId = e.id;
    }
    // Brains for every bot-driven seat: bot fills AND disconnected ghosts.
    for (const s of this.seats) {
      if (s.bot || !s.connected) {
        s.brain = createBotBrain(hashSeed(this.id, s.seatIndex), s.hero ?? FIRST_HERO);
      }
    }
    // Fountain anchors (own ancient) for bot atFountain percepts.
    for (const def of map.structures) {
      if (def.kind !== 'ancient') continue;
      this.fountainX[def.team] = def.x;
      this.fountainZ[def.team] = def.z;
    }

    this.projFx.clear();
    this.visSets[0].clear();
    this.visSets[1].clear();
    this.lockedTeamSize = teamSize;
    this.lockedLanes = lanes;
    this.snapSeq = 0;
    const laneAssignment: Record<string, number> = {};
    for (const s of this.seats) laneAssignment[s.pid] = s.lane;
    this.beginMsg = { t: 'rift_begin', lanes, teamSize, startAtTick: w.tick, laneAssignment };
    this.phase = 'live';
    for (const s of this.seats) {
      if (!s.connected) continue;
      this.ensureChannel(s);
      this.io.send(s.pid, this.beginMsg);
    }
    this.broadcastRoster();
    this.armInterval();
  }

  // -------------------------------------------------------------------------
  // Live: bot percepts, the shared intake handlers, events, snapshots
  // -------------------------------------------------------------------------

  /** ent.team is the sim's EntTeam (neutral camps exist); the SEAT's team is
   *  the player TeamId that indexes the two fountain anchors. */
  private atFountain(team: TeamId, ent: Ent): boolean {
    const dx = ent.x - this.fountainX[team];
    const dz = ent.z - this.fountainZ[team];
    return dx * dx + dz * dz <= FOUNTAIN_RADIUS * FOUNTAIN_RADIUS;
  }

  /**
   * One bot's tick: build the TEAM-VISION-FILTERED percept (structures are
   * always included — bots reason about towers/wards/creeps — plus every
   * mobile in the bot's team's visible set) and feed the returned commands
   * through the SAME handlers human messages hit (CONTRACT §5).
   */
  private feedBot(seat: Seat, ent: Ent, brain: BotBrain, w: World): void {
    const buf = this.perceptBuf;
    buf.length = 0;
    // The ent IS this seat's hero, so its team equals the seat's player
    // TeamId — index the per-team tuples with seat.team, never with an
    // entity's EntTeam (neutral camps are team 2; TERRAIN_CONTRACT §5's
    // narrowing obligation).
    const vis = this.visSets[seat.team];
    for (const e of w.all()) {
      if (isStructureKind(e.kind) || vis.has(e.id)) buf.push(e);
    }
    const percept: BotPercept = {
      tick: w.tick,
      phase: 'live',
      self: ent,
      visible: buf,
      lane: seat.lane,
      paths: w.map.paths,
      camps: this.campPercepts,
      wardStock: w.wardStock(seat.team),
      atFountain: this.atFountain(seat.team, ent),
      overtime: w.overtime,
    };
    const cmds = brain.tick(percept);
    for (const cmd of cmds) {
      switch (cmd.c) {
        case 'order':
          if (cmd.kind === 'stop') this.handleOrder(seat, { kind: 'stop' });
          else if (cmd.kind === 'attack') this.handleOrder(seat, { kind: 'attack', target: cmd.target });
          else this.handleOrder(seat, { kind: cmd.kind, x: cmd.x, z: cmd.z });
          break;
        case 'cast':
          this.handleCast(seat, cmd.slot, cmd.x ?? null, cmd.z ?? null, cmd.target ?? NO_ENT);
          break;
        case 'buy':
          this.handleBuy(seat, cmd.item);
          break;
        case 'skill':
          this.handleSkill(seat, cmd.slot);
          break;
        case 'item':
          this.handleItem(seat, cmd.slot, cmd.x ?? null, cmd.z ?? null);
          break;
      }
    }
  }

  // --- the intake handlers: humans reach them via handleMessage, bots via
  // --- feedBot. The world validates legality at apply time; illegal input
  // --- silently no-ops there, exactly like a human's illegal click. ---------

  private heroEnt(seat: Seat): Ent | undefined {
    if (this.phase !== 'live' || this.world === null) return undefined;
    return this.world.get(seat.entId);
  }

  private handleOrder(seat: Seat, order: Order): void {
    const ent = this.heroEnt(seat);
    if (ent === undefined || this.world === null) return;
    this.world.order(ent.id, order);
  }

  private handleCast(seat: Seat, slot: number, x: number | null, z: number | null, target: EntId): void {
    const ent = this.heroEnt(seat);
    if (ent === undefined || this.world === null) return;
    this.world.cast(ent.id, slot, x, z, target);
  }

  private handleBuy(seat: Seat, item: ItemId): void {
    const ent = this.heroEnt(seat);
    if (ent === undefined || this.world === null) return;
    this.world.buy(ent.id, item);
  }

  private handleSkill(seat: Seat, slot: number): void {
    const ent = this.heroEnt(seat);
    if (ent === undefined || this.world === null) return;
    this.world.spendSkillPoint(ent.id, slot);
  }

  private handleItem(seat: Seat, slot: number, x: number | null, z: number | null): void {
    const ent = this.heroEnt(seat);
    if (ent === undefined || this.world === null) return;
    this.world.useItem(ent.id, slot, x, z);
  }

  // --- events ----------------------------------------------------------------

  private dispatchEvents(w: World, events: SimEvent[]): void {
    for (const ev of events) {
      switch (ev.k) {
        case 'cast': {
          this.noteCastFx(w, ev.id, ev.slot);
          const wire: RiftEvent = { t: 'rift_cast', id: ev.id, slot: ev.slot, x: ev.x, z: ev.z };
          const msg = { t: 'event', ev: wire };
          // ONLY to teams whose visible set contains the caster (CONTRACT §2).
          for (const team of [0, 1] as const) {
            if (!this.visSets[team].has(ev.id)) continue;
            for (const s of this.seats) {
              if (s.team === team && s.connected) this.io.send(s.pid, msg);
            }
          }
          break;
        }
        case 'kill':
          this.broadcastEvent({
            t: 'rift_kill',
            killer: ev.killerPid,
            victim: ev.victimPid,
            gold: ev.gold,
            firstBlood: ev.firstBlood,
          });
          break;
        case 'structure':
          this.broadcastEvent({ t: 'rift_structure', team: ev.team, kind: ev.kind, lane: ev.lane });
          break;
        case 'surge':
          this.broadcastEvent({ t: 'rift_surge' });
          break;
        case 'end':
          this.onMatchEnd(ev.winner, ev.reason);
          break;
      }
    }
  }

  /**
   * 'proj' ents carry no payload through the frozen seam (it is engine-private),
   * so the snapshot's fx tag is derived HERE: at cast time, the ability's first
   * damage/heal effect gives the school tag ('physical' | 'magic' | 'heal'),
   * remembered per caster and stamped onto their projectiles (owner = caster).
   * A re-cast while an older projectile flies re-tags it — cosmetic only.
   * Item actives (slot >= ITEM_EVENT_SLOT_BASE) spawn no projectiles.
   */
  private noteCastFx(w: World, casterId: EntId, slot: number): void {
    if (slot >= ITEM_EVENT_SLOT_BASE) return;
    const hero = w.get(casterId)?.hero;
    if (hero === null || hero === undefined) return;
    const def = heroById(hero).abilities[slot];
    if (def === undefined) return;
    let tag = 'magic';
    for (const ef of def.effects) {
      if (ef.kind === 'damage') {
        tag = ef.school;
        break;
      }
      if (ef.kind === 'heal') {
        tag = 'heal';
        break;
      }
    }
    this.projFx.set(casterId, tag);
  }

  // --- snapshots ---------------------------------------------------------------

  private ensureChannel(seat: Seat): void {
    if (this.channels.has(seat.pid)) return;
    const abilities: AbilitySnap[] = [];
    for (let i = 0; i < 4; i++) abilities.push({ rank: 0, cdUntilTick: 0 });
    const items: (ItemId | null)[] = [];
    const itemCharges: number[] = [];
    const itemCdUntilTick: number[] = [];
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      items.push(null);
      itemCharges.push(0);
      itemCdUntilTick.push(0);
    }
    const you: YouMut = {
      hero: seat.hero ?? FIRST_HERO,
      x: 0,
      z: 0,
      hp: 0,
      maxHp: 0,
      mana: 0,
      maxMana: 0,
      level: 1,
      xp: 0,
      gold: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
      skillPoints: 0,
      respawnAtTick: 0,
      abilities,
      items,
      itemCharges,
      itemCdUntilTick,
    };
    const snap: SnapMut = {
      t: 'rift_snap',
      tick: 0,
      serverTime: 0,
      phase: 'live',
      matchTick: 0,
      overtime: false,
      wardStock: 0,
      kills: [0, 0],
      board: [],
      you,
      ents: [],
    };
    this.channels.set(seat.pid, { seat, snap, you, entPool: new Map() });
  }

  private pushSnapshots(w: World): void {
    this.snapSeq += 1;
    const serverTime = Date.now(); // wall clock for clock sync; match time is ticks
    const kills: [number, number] = [0, 0];
    for (const e of w.mobiles()) {
      // narrow before indexing the 2-tuple: camp creeps are neutral (team 2)
      if (e.kind === 'hero' && isPlayerTeam(e.team)) kills[e.team] += e.kills;
    }
    this.buildBoard(w);
    for (const ch of this.channels.values()) {
      if (!ch.seat.connected) continue;
      const snap = ch.snap;
      snap.tick = this.snapSeq;
      snap.serverTime = serverTime;
      snap.phase = this.phase;
      snap.matchTick = w.tick;
      snap.overtime = w.overtime;
      snap.wardStock = w.wardStock(ch.seat.team);
      snap.kills[0] = kills[0];
      snap.kills[1] = kills[1];
      snap.board = this.boardRows; // one shared, identical scoreboard
      this.fillYou(ch, w);
      this.fillEnts(ch, w);
      this.io.send(ch.seat.pid, snap);
    }
  }

  /** Rebuild the shared scoreboard rows in place, one per seat. */
  private buildBoard(w: World): void {
    const rows = this.boardRows;
    while (rows.length > this.seats.length) rows.pop();
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if (s === undefined) continue;
      let row = rows[i];
      if (row === undefined) {
        row = {
          id: s.pid,
          hero: s.hero ?? FIRST_HERO,
          team: s.team,
          level: 1,
          kills: 0,
          deaths: 0,
          assists: 0,
          bot: s.bot,
          connected: s.connected,
        };
        rows[i] = row;
      }
      row.id = s.pid;
      row.hero = s.hero ?? FIRST_HERO;
      row.team = s.team;
      row.bot = s.bot;
      row.connected = s.connected;
      const ent = w.get(s.entId);
      row.level = ent?.level ?? 1;
      row.kills = ent?.kills ?? 0;
      row.deaths = ent?.deaths ?? 0;
      row.assists = ent?.assists ?? 0;
    }
  }

  /** The owning player's full private state, every snapshot. */
  private fillYou(ch: Channel, w: World): void {
    const ent = w.get(ch.seat.entId);
    if (ent === undefined) {
      ch.snap.you = null; // spectator-less edge: seat with no hero ent
      return;
    }
    const you = ch.you;
    ch.snap.you = you;
    you.hero = ch.seat.hero ?? FIRST_HERO;
    you.x = ent.x;
    you.z = ent.z;
    you.hp = ent.hp;
    you.maxHp = ent.maxHp;
    you.mana = ent.mana;
    you.maxMana = ent.maxMana;
    you.level = ent.level;
    you.xp = ent.xp;
    you.gold = ent.gold;
    you.kills = ent.kills;
    you.deaths = ent.deaths;
    you.assists = ent.assists;
    you.skillPoints = ent.skillPoints;
    you.respawnAtTick = ent.respawnAtTick;
    for (let i = 0; i < 4; i++) {
      const ab = you.abilities[i];
      if (ab === undefined) continue;
      ab.rank = ent.abilityRanks[i] ?? 0;
      ab.cdUntilTick = ent.abilityCdUntilTick[i] ?? 0;
    }
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      you.items[i] = ent.items[i] ?? null;
      you.itemCharges[i] = ent.itemCharges[i] ?? 0;
      you.itemCdUntilTick[i] = ent.itemCdUntilTick[i] ?? 0;
    }
  }

  /**
   * Fog-filtered entity list, serialized into the channel's preallocated
   * ents array with pooled EntSnap objects: structures ALWAYS (hp <= 0 means
   * destroyed), mobiles only when in the player's team's visible set (which
   * already encodes: own-team always, wards own-team only, projs both teams).
   */
  private fillEnts(ch: Channel, w: World): void {
    const out = ch.snap.ents;
    out.length = 0;
    const vis = this.visSets[ch.seat.team];
    for (const e of w.all()) {
      if (!isStructureKind(e.kind) && !vis.has(e.id)) continue;
      let s = ch.entPool.get(e.id);
      if (s === undefined) {
        s = { id: e.id, k: e.kind, team: e.team, x: 0, z: 0, hp: 0, maxHp: 0 };
        ch.entPool.set(e.id, s);
      }
      s.x = e.x;
      s.z = e.z;
      s.hp = e.hp;
      s.maxHp = e.maxHp;
      if (e.kind === 'hero') {
        s.lvl = e.level;
        if (e.hero !== null) s.hero = e.hero;
        else delete s.hero;
        if (e.pid !== null) s.pid = e.pid;
        else delete s.pid;
      }
      if (e.kind === 'proj') {
        s.tx = e.ox; // flight target, per the engine's snapshot convention
        s.tz = e.oz;
        const fx = this.projFx.get(e.owner);
        if (fx !== undefined) s.fx = fx;
        else delete s.fx;
      }
      if (e.atkTarget !== NO_ENT) s.atk = e.atkTarget;
      else delete s.atk;
      out.push(s);
    }
  }

  // -------------------------------------------------------------------------
  // End + full reset
  // -------------------------------------------------------------------------

  private onMatchEnd(winner: TeamId | null, reason: EndReason): void {
    if (this.phase !== 'live') return;
    this.phase = 'ended';
    this.clearTickInterval();
    const ev: RiftEvent = { t: 'rift_end', winner, reason, stats: this.collectStats() };
    this.lastEndEv = ev;
    this.broadcastEvent(ev);
    this.setPhaseTimer(() => this.fullReset(), MATCH_END_MS);
  }

  /** Full PlayerStats per seat, read off the hero ents (CONTRACT §2 ended). */
  private collectStats(): PlayerStats[] {
    const w = this.world;
    const out: PlayerStats[] = [];
    for (const s of this.seats) {
      const ent = w?.get(s.entId);
      out.push({
        id: s.pid,
        name: s.name,
        hero: s.hero ?? FIRST_HERO,
        team: s.team,
        kills: ent?.kills ?? 0,
        deaths: ent?.deaths ?? 0,
        assists: ent?.assists ?? 0,
        goldEarned: ent?.goldEarned ?? 0,
        heroDamage: ent?.heroDamage ?? 0,
        structureDamage: ent?.structureDamage ?? 0,
      });
    }
    return out;
  }

  /**
   * MATCH_END_MS after the end: bots removed, sim discarded, picks KEPT, and
   * the room WAITS in the lobby for the next explicit START (CONTRACT §2).
   * Disconnected ghost seats are kept too — resume rebind works into the
   * lobby; permanent-leave conversions (bot === true) are removed.
   */
  private fullReset(): void {
    if (this.phase !== 'ended') return;
    this.clearTickInterval();
    this.world = null;
    this.mapDef = null;
    this.projFx.clear();
    this.visSets[0].clear();
    this.visSets[1].clear();
    this.channels.clear();
    this.boardRows.length = 0;
    this.campPercepts.length = 0;
    this.lastEndEv = null;
    this.beginMsg = null;
    this.lockedTeamSize = 0;
    this.lockedLanes = 0;
    this.heroCycle = HERO_LIST.map((d) => d.id);
    this.heroCycleIdx = 0;
    this.seats = this.seats.filter((s) => !s.bot);
    for (const s of this.seats) {
      s.brain = null;
      s.entId = NO_ENT;
      s.lane = 0;
      s.hero = null; // pick survives and applies again at the next lock
    }
    this.phase = 'lobby';
    this.countdownEndsAt = 0;
    this.broadcastLobby();
    this.broadcastRoster();
  }

  // -------------------------------------------------------------------------
  // Membership helpers
  // -------------------------------------------------------------------------

  /** Rebind a ghost seat in place: pid/name/connection updated, hero ent's
   *  pid follows, bot brain dropped — score, items and cooldowns intact. */
  private rebindSeat(seat: Seat, id: PlayerId, name: string): void {
    seat.pid = id;
    seat.name = name;
    seat.connected = true;
    seat.brain = null;
    const ent = this.world?.get(seat.entId);
    if (ent !== undefined) ent.pid = id;
    if (this.phase === 'live') this.ensureChannel(seat);
  }

  /** Resume-token rejoin: oldId names a disconnected, non-bot seat. */
  private rebindGhost(oldId: PlayerId, newId: PlayerId, name: string): boolean {
    const seat = this.seats.find((s) => s.pid === oldId && !s.connected && !s.bot);
    if (seat === undefined) return false;
    this.rebindSeat(seat, newId, name);
    this.sendJoinPayloads(seat);
    this.afterMembershipChange();
    return true;
  }

  /**
   * Late joiner (any phase past lobby, CONTRACT §2): displace the OLDEST bot
   * seat and INHERIT its hero, level, gold, items and position — the seat and
   * hero ent are mutated (pid rebinding), never recreated. If no bot seat
   * exists and a seat is free under the locked teamSize, a fresh level-1 hero
   * spawns at the team's fountain. Otherwise the room is genuinely full.
   */
  private joinLive(id: PlayerId, name: string): void {
    for (const s of this.seats) {
      if (!s.bot) continue;
      s.bot = false;
      s.connected = true;
      s.pid = id;
      s.name = name;
      s.brain = null;
      s.pick = null;
      const ent = this.world?.get(s.entId);
      if (ent !== undefined) ent.pid = id;
      if (this.phase === 'live') this.ensureChannel(s);
      this.sendJoinPayloads(s);
      this.afterMembershipChange();
      return;
    }
    // Free-seat branch. UNREACHABLE BY CONSTRUCTION while live: bot fill
    // guarantees both teams exactly teamSize seats at lock, seats are never
    // removed mid-match (permanent leaves convert to bots), and displacement
    // above consumes any bot seat first. Implemented defensively per
    // CONTRACT §2. SEAM LIMITATION: the frozen World surface has no
    // spawn-hero door (spawnHero is world-internal; the base-stats side table
    // is unreachable through World), so this hero is hydrated field-by-field
    // and the sim's stat recompute (from its private base table) will not
    // track it. Reported to the orchestrator; kept because the contract text
    // requires the behaviour and the branch cannot fire in practice.
    const counts: [number, number] = [0, 0];
    for (const s of this.seats) counts[s.team] += 1;
    const team: TeamId = counts[0] <= counts[1] ? 0 : 1;
    const w = this.world;
    if (w !== null && counts[team] < this.lockedTeamSize) {
      const hero = this.nextCycleHero();
      const lane = this.lockedLanes > 0 ? counts[team] % this.lockedLanes : 0;
      const fx = this.fountainX[team];
      const fz = this.fountainZ[team];
      const entId = w.spawnMobile('hero', team, fx, fz, lane, 0, NO_ENT);
      const ent = w.get(entId);
      if (ent !== undefined) {
        const def = heroById(hero);
        ent.hero = hero;
        ent.pid = id;
        ent.level = 1;
        ent.xp = 0;
        ent.gold = STARTING_GOLD;
        ent.skillPoints = STARTING_SKILL_POINTS;
        ent.vision = HERO_VISION;
        ent.maxHp = def.base.hp;
        ent.hp = def.base.hp;
        ent.maxMana = def.base.mana;
        ent.mana = def.base.mana;
        ent.damage = def.base.damage;
        ent.armor = def.base.armor;
        ent.attackPeriod = def.base.attackPeriod;
        ent.attackRange = def.base.attackRange;
        ent.moveSpeed = def.base.moveSpeed;
        ent.hpRegen = def.base.hpRegen;
        ent.manaRegen = def.base.manaRegen;
      }
      const seat: Seat = {
        pid: id,
        name,
        team,
        bot: false,
        connected: true,
        pick: null,
        hero,
        lane,
        entId,
        brain: null,
        seatIndex: this.seats.length,
      };
      this.seats.push(seat);
      if (this.phase === 'live') this.ensureChannel(seat);
      this.sendJoinPayloads(seat);
      this.afterMembershipChange();
      return;
    }
    this.io.send(id, { t: 'error', code: 'room_full', message: 'room is full' });
  }

  // -------------------------------------------------------------------------
  // Timers — ONE phase-timer slot (countdown | matchEnd) + the tick interval
  // -------------------------------------------------------------------------

  private setPhaseTimer(fn: () => void, ms: number): void {
    this.clearPhaseTimer();
    this.phaseTimer = setTimeout(() => {
      this.phaseTimer = null;
      if (this.stopped) return;
      try {
        fn();
      } catch (err) {
        console.error('[rift] timer failed', err);
      }
    }, ms);
  }

  private clearPhaseTimer(): void {
    if (this.phaseTimer !== null) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }
  }

  private armInterval(): void {
    if (this.tickInterval !== null || this.stopped) return;
    // settings.speed (1..20) is a PUBLIC room option (CONTRACT §2): the room
    // creator's room, the room creator's rules — and the e2e/balance hook.
    const speed = this.settings.speed ?? 1;
    const period = Math.max(1, Math.round(1000 / TICK_RATE / speed));
    this.tickInterval = setInterval(() => this.tickGuarded(), period);
  }

  private clearTickInterval(): void {
    if (this.tickInterval !== null) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  // -------------------------------------------------------------------------
  // Wire — lobby/hello/roster/begin and the shared broadcast helpers
  // -------------------------------------------------------------------------

  private roster(): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const s of this.seats) {
      out.push({
        id: s.pid,
        name: s.name,
        team: s.team,
        bot: s.bot,
        connected: s.connected,
        pick: s.pick,
      });
    }
    return out;
  }

  private helloMsg(seat: Seat): RiftHello {
    return {
      t: 'rift_hello',
      you: seat.pid,
      roomId: this.id,
      code: this.code,
      team: seat.team,
      // live setting: the locked size once locked, else the explicit setting
      // (0 = auto until locked)
      teamSize: this.lockedTeamSize > 0 ? this.lockedTeamSize : (this.settings.teamSize ?? 0),
      roster: this.roster(),
    };
  }

  /** rift_hello on every join; rift_begin (and a cached rift_end) follow for
   *  anyone who joins while a match is live or dwelling in ended. */
  private sendJoinPayloads(seat: Seat): void {
    this.io.send(seat.pid, this.helloMsg(seat));
    if (this.phase === 'lobby') return;
    if (this.beginMsg !== null) {
      // laneAssignment is rebuilt per send: displacement/resume rebind pids
      // after lock, and the joiner must see THEIR pid mapped to a lane.
      const laneAssignment: Record<string, number> = {};
      for (const s of this.seats) laneAssignment[s.pid] = s.lane;
      this.io.send(seat.pid, { ...this.beginMsg, laneAssignment });
    }
    if (this.phase === 'ended' && this.lastEndEv !== null) {
      this.io.send(seat.pid, { t: 'event', ev: this.lastEndEv });
    }
  }

  /** Re-broadcast rift_lobby + rift_roster after EVERY membership change. */
  private afterMembershipChange(): void {
    if (this.phase === 'lobby') this.broadcastLobby();
    this.broadcastRoster();
  }

  private broadcastLobby(): void {
    if (this.phase !== 'lobby') return;
    const picks: Record<string, HeroId | null> = {};
    let humans = 0;
    for (const s of this.seats) {
      picks[s.pid] = s.pick;
      if (s.connected && !s.bot) humans += 1;
    }
    const msg: RiftLobby = {
      t: 'rift_lobby',
      seated: this.seats.length,
      humans,
      minPlayers: MIN_PLAYERS,
      canStart: this.startAllowed(),
      teamSize: this.resolvedTeamSize(),
      picks,
      countdownEndsAt: this.countdownEndsAt,
    };
    for (const s of this.seats) {
      if (s.connected) this.io.send(s.pid, msg);
    }
  }

  private broadcastRoster(): void {
    this.broadcastEvent({ t: 'rift_roster', roster: this.roster() });
  }

  /** One shared message object per event: Session.send JSON-encodes it
   *  synchronously, so every recipient can share the reference. */
  private broadcastEvent(ev: RiftEvent): void {
    const msg = { t: 'event', ev };
    for (const s of this.seats) {
      if (s.connected) this.io.send(s.pid, msg);
    }
  }
}
