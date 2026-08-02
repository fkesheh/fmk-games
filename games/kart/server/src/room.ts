// ============================================================================
// KART room (docs/KART.md) — the SERVER-AUTHORITATIVE race. It used to referee
// race rules over CLIENT-TRUSTED POSITIONS: clients streamed `kart_state`
// (absolute world x/y/z/yaw/velocity) and the room copied it straight into the
// player record behind nothing but a stateless range clamp. Kart-vs-kart
// contact was resolved client-side, position-only and per-client, so the two
// drivers in a bump saw two different, contradictory collisions.
//
// WHAT CHANGED — the wire now carries INTENT, never coordinates:
//   * clients send `kart_input` (throttle/brake/steer/drift/respawn + dt + seq);
//     `kart_state` does not exist any more, so "teleport to the next gate" is
//     not a message that can be sent;
//   * the room integrates the SHARED sim (shared/sim.ts stepDrive, the exact
//     function the client predicts with) at SIM_HZ from that input stream and
//     owns every position on the track;
//   * kart-vs-kart contact is resolved ONCE per tick over all karts
//     (resolveKartPair) — real momentum exchange, so both drivers get the same
//     impact, at the same instant, with the hit costing the hitter what it
//     gives the hit;
//   * each snapshot echoes `you.lastProcessedSeq` + `you.sim` so the client can
//     re-base and replay its unacknowledged inputs (fps/net/prediction.ts).
// A client's only remaining levers are the CONTENTS of its inputs and how many
// it sends; the latter is bounded by MAX_INPUTS_PER_TICK per tick and by
// SIM_BUDGET_MUL seconds of simulated kart time per real second.
//
// TWO INTERVALS: the sim tick (SIM_HZ) runs the phase machine, consumes inputs,
// integrates, resolves contact and recomputes places; the snapshot tick
// (SNAPSHOT_HZ) only broadcasts. Both are individually guarded — this room
// never throws, whatever arrives on the wire.
//
// Phase machine (unchanged): lobby -[{t:'start'}]-> ready 5s → countdown
// 3-2-1-GO → racing → results 10s → lobby. NOTHING auto-starts (frozen lobby
// contract): 'lobby' is left only when a seated player sends `{t:'start'}` with
// at least MIN_PLAYERS seated, and the results timer returns the room to the
// lobby to WAIT for the next one.
//
// Gate credit model (unchanged, now over SERVER-SIMULATED positions): the 8
// gates are credited IN ORDER only — a credit needs the kart within
// GATE_RADIUS of the EXPECTED gate (skipping gates gives nothing) — and the
// check runs after EVERY integrated input, not once per tick, so a burst of
// queued inputs can never tunnel through a gate. nextGate starts at 1, so the
// start/finish line (gate 0) is the LAST credit of every lap: 8 credits per
// lap, finish at exactly LAPS_TO_WIN * GATES. `progress` is the monotonic
// credit count (KART.md "progress = lap×GATES + nextGateIndex", 0-based lap).
//
// CHAMPIONSHIP (additive, per-room-session): a room IS an F1 season. It races
// `season.rounds` circuits off a calendar built by walking the track registry
// from its own starting circuit WITH WRAPAROUND — which is also the answer to
// "what if the season is longer than the registry": with one circuit registered
// an 8-round season is 8 races at that circuit, and a room that books FEWER
// rounds than the registry holds simply races the first `rounds` of the
// rotation (the rest is not "missing", the season is just shorter). Each round
// is scored on the way INTO 'results' (25-18-15-...-1; a DNF is not in
// finishOrder, so it scores 0 with no special case), the circuit advances on
// the way BACK to the lobby, and the final round crowns a champion and rolls
// into a fresh season. Points are per-room and die with it — nothing here
// persists. A room booked `{ championship: false }` behaves EXACTLY as it did
// before any of this existed: one fixed circuit, `championship: null` on the
// wire, the old lobby label.
// ============================================================================
import {
  BUMP_COOLDOWN_MS,
  BUMP_MIN_SPEED,
  CHAMPIONSHIP_DEFAULT,
  COUNTDOWN_SECONDS,
  DEFAULT_SEASON_ROUNDS,
  GATE_RADIUS,
  GATES,
  INPUT_QUEUE_CAP,
  INPUT_STALE_MS,
  KART_COLORS,
  LAPS_TO_WIN,
  MAX_INPUTS_PER_TICK,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NITRO_CHARGES,
  NITRO_TIME,
  READY_SECONDS,
  RESULTS_SECONDS,
  RACE_TIMEOUT_S,
  SEASON_STANDINGS_CAP,
  SIM_BUDGET_MUL,
  SIM_HZ,
  SNAPSHOT_HZ,
  buildCalendar,
  buildTrack,
  clampToBarrier,
  compareSeason,
  gridSlot,
  makeSim,
  parseKartC2S,
  pointsForPlace,
  resetSim,
  resolveKartPair,
  stepDrive,
  TRACKS,
} from '@kart/shared';
import type {
  KartInputMsg,
  KartPhase,
  KartPlayerInfo,
  KartPlayerSnap,
  KartS2C,
  KartSeason,
  KartSeasonSettings,
  KartSim,
  KartStandingRow,
  KartYou,
  RaceEvent,
  TrackDef,
  TrackId,
} from '@kart/shared';
import { rng, rngInt } from '@platform/shared';
import type {
  GameRoomHandle,
  PlayerId,
  RoomId,
  RoomInfo,
  RoomIO,
  Visibility,
} from '@platform/shared';

type SnapshotMsg = Extract<KartS2C, { t: 'kart_snapshot' }>;

const ROOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PRIVATE_CODE_LEN = 5; // A-Z0-9 join code, same convention as the other rooms
let roomSeq = 0; // mixes into the rng seed so same-ms rooms still differ

function randomToken(next: () => number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET.charAt(rngInt(next, 0, ROOM_ALPHABET.length - 1));
  return s;
}

/**
 * Server-side player record, join order = Map insertion order. Disconnects
 * delete the entry immediately (racing has no rejoin-value v1); only their
 * finishOrder entry survives if they had already finished.
 */
interface Player {
  id: PlayerId;
  name: string;
  slot: number; // grid slot (lowest free at join)
  color: number; // index into KART_COLORS
  lastStateAt: number; // serverTime ms of join / last valid message; stale sweep
  // ---- authoritative simulation ----
  // `sim` IS the kart: position, yaw, velocity, gearbox, drift and respawn
  // anchor. Nothing on the wire writes to it — only stepDrive (from consumed
  // inputs) and resolveKartPair (contact) do.
  sim: KartSim;
  steer: number; // last consumed input's steer: a VISUAL channel (wheel angle), not physics
  inputQueue: KartInputMsg[]; // FIFO, capped at INPUT_QUEUE_CAP (oldest dropped)
  lastQueuedSeq: number; // monotonic gate applied at enqueue time
  lastProcessedSeq: number; // last seq actually consumed; echoed as you.lastProcessedSeq
  simWindow: number; // floor(now/1000) bucket the speedhack budget is charged in
  simUsed: number; // simulated seconds charged inside that bucket
  bumpAt: number; // serverTime ms of this player's last 'bump' event (cooldown)
  // race state (reset on every return to the lobby)
  lap: number; // 1-based current lap
  nextGate: number; // expected gate index; 1 at race start (the line ends each lap)
  progress: number; // total gate credits this race (monotonic)
  place: number; // 1-based; grid order (slot+1) outside racing/results
  lapStartAt: number; // serverTime ms of current lap start, -1 outside racing
  bestLapMs: number; // -1 until a lap completes
  // gap timing: credit count (== progress after the increment) -> serverTime ms
  gateTimes: Map<number, number>;
  finished: boolean;
  finishMs: number; // race time at finish, -1 while racing
  // nitro (per race, refilled at GO)
  nitroLeft: number; // charges remaining (0 outside racing until the GO refill)
  nitroUntil: number; // serverTime ms; nitroActive in snaps while now < nitroUntil
  // ---- persistent wire objects (allocated ONCE at join, mutated per tick) ----
  // The snapshot is SNAPSHOT_HZ x every recipient; rebuilding it allocated
  // O(n^2) objects per tick (400/tick at MAX_PLAYERS 20). These three are the
  // whole fix: `snap` is this player's entry in the ONE shared per-tick roster,
  // `you` is their private block (whose `sim` field is bound to `sim` above
  // ONCE, at join — never reassigned per tick), `msg` the envelope. Safe
  // because Session.send JSON-encodes synchronously (platform/server net.ts ->
  // encodeS2C), so no recipient can observe a later tick's values.
  snap: KartPlayerSnap;
  you: KartYou;
  msg: SnapshotMsg;
}

/**
 * One driver's championship record — the SERVER side of a KartStandingRow.
 *
 * It is deliberately NOT keyed off the Player map: a driver who disconnects
 * keeps their points (as in F1), so the entry outlives the seat. `seq` is the
 * unique 0-based order of first appearance THIS season and is what makes
 * compareSeason a TOTAL order (see the tie-break note on rebuildStandings).
 */
interface SeasonEntry {
  id: PlayerId;
  name: string; // last known display name; refreshed whenever the driver is seen
  points: number; // season total
  delta: number; // points from the most recently SCORED round (the "+18")
  wins: number; // first countback rung
  bestFinish: number; // lowest finishing place; 0 = has never finished
  joinedRound: number; // 1-based round of first appearance
  seq: number; // unique join order this season; the final tie-break
}

export class KartRoom implements GameRoomHandle {
  readonly id: RoomId;
  readonly code: string | null;
  readonly visibility: Visibility;

  /**
   * The LIVE circuit. It used to be a fixed field — a room raced one track for
   * its whole life — but a championship changes circuit between rounds, so this
   * is now a getter over the mutable `track`. Everything that reads a room's
   * circuit (lobby list, joins, snapshots) therefore follows the calendar for
   * free instead of reporting the track the room happened to be built with.
   */
  get trackId(): TrackId {
    return this.track.id;
  }

  private readonly io: RoomIO;
  // MUTABLE now (was readonly): resetToLobby swaps it for the next round's
  // circuit. Everything positional — gridSlot, gate credit, barrier clamp —
  // reads it live, which is why the swap happens BEFORE the grid reset.
  private track: TrackDef; // shared TrackDef: gate positions for credit checks
  private readonly players = new Map<PlayerId, Player>(); // insertion order = join order
  // The ONE per-tick roster array, shared by every recipient's snapshot (see
  // buildSnapPlayers). Rebuilt in place each tick; never reallocated.
  private readonly snapPlayers: KartPlayerSnap[] = [];
  // The ONE scratch Player[] — rebuilt in place for the pair loop and for the
  // place sort (which used to allocate `[...players.values()]` every tick, a
  // cost that doubled when places moved from 15Hz to SIM_HZ).
  private readonly order: Player[] = [];

  private phase: KartPhase = 'lobby';
  private tickCount = 0; // snapshot sequence
  private phaseEndsAt = 0; // serverTime ms; 0 when no phase timer runs
  private countdown = 0; // current countdown number during 'countdown', else 0
  private countdownEndsAt = 0; // serverTime ms of the next countdown beat / GO
  private raceStartAt = 0; // serverTime ms of GO
  private raceEndsAt = 0; // serverTime ms; hard cap (RACE_TIMEOUT_S after GO)
  // Finish sequence; kept even for disconnects, and never reassigned (it is
  // emptied in place). It is the round's CLASSIFICATION — championship points
  // are read straight off it — so it may never contain an id twice.
  private readonly finishOrder: PlayerId[] = [];
  private simTimer: ReturnType<typeof setInterval> | null = null;
  private snapTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  // -------------------------------------------------------------------------
  // CHAMPIONSHIP (per-room-session; nothing is persisted anywhere — the season
  // lives on this object and dies with it). A room IS a season: it races
  // `season.rounds` circuits off `calendar`, scores each one on the way into
  // 'results', crowns a champion on the final round and then starts a fresh
  // season on the way back to the lobby.
  // -------------------------------------------------------------------------
  private readonly season: KartSeasonSettings;
  // The track the season ALWAYS restarts from — not `track`, which moves with
  // the calendar. Without it, season 2 would start wherever season 1 ended and
  // the rotation would drift one circuit per season.
  private readonly baseTrackId: TrackId;
  private calendar: TrackId[] = []; // empty on a championship-disabled room
  private round = 1; // 1-based; during 'results' it is the round just SCORED
  private seasonOver = false; // final round scored: standings final, champion crowned
  // Double-award guard. enterResults is reachable from three places (the last
  // gate credit, the last racer leaving, the race timeout) and two of them can
  // fire in the same tick — scoring is idempotent per round, not per call.
  private scoredRound = 0;
  private championId: PlayerId | null = null;
  private readonly entries = new Map<PlayerId, SeasonEntry>();
  private seasonSeq = 0; // next SeasonEntry.seq; reset only by startNewSeason
  private standingsDirty = true;
  // POOLED standings rows. The wire object below binds `.standings` to this
  // array ONCE, so a snapshot costs zero allocations even though the table is
  // mirrored on every tick (same discipline as snapPlayers / snap / you / msg).
  private readonly standingRows: KartStandingRow[] = [];
  // Scratch for the sort in rebuildStandings — refilled in place, never
  // reallocated, so a churny room does not allocate one array per rebuild.
  private readonly sortScratch: SeasonEntry[] = [];
  // The ONE KartSeason object every snapshot points at, allocated once here.
  // `null` on a championship-disabled room, which is exactly the wire value
  // that tells a client to render nothing extra.
  private readonly seasonWire: KartSeason | null;

  constructor(
    trackId: TrackId,
    visibility: Visibility,
    io: RoomIO,
    // Optional with a full default so the 3-arg call site in module.ts keeps
    // compiling AND every room still gets a season (championship on by default).
    season: KartSeasonSettings = { championship: CHAMPIONSHIP_DEFAULT, rounds: DEFAULT_SEASON_ROUNDS },
  ) {
    this.visibility = visibility;
    this.io = io;
    this.season = season;
    this.baseTrackId = trackId;
    // The season's opening circuit is calendar[0], which buildCalendar anchors
    // at `trackId` — so it IS `trackId` — but going through the calendar means
    // round 1 and round n are produced by the same rule.
    let first: TrackId = trackId;
    if (season.championship) {
      this.calendar = buildCalendar(trackId, season.rounds);
      this.round = 1;
      first = this.calendar[0] ?? trackId;
    }
    this.track = buildTrack(TRACKS[first]); // deterministic: same gates the client renders
    this.seasonWire = season.championship
      ? {
          round: 1,
          rounds: season.rounds,
          trackId: this.track.id,
          // null on a one-round season: there is no round 2 to name.
          nextTrackId: this.calendar[1] ?? null,
          over: false,
          championId: null,
          standings: this.standingRows, // bound ONCE; refilled in place forever after
        }
      : null;
    // server-side generation (room id, private code) uses rng(Date.now())
    const next = rng((Date.now() ^ (roomSeq++ * 0x9e3779b9)) >>> 0);
    this.id = randomToken(next, 8);
    this.code = visibility === 'private' ? randomToken(next, PRIVATE_CODE_LEN) : null;
  }

  info(): RoomInfo {
    return {
      id: this.id,
      code: this.code,
      game: 'kart',
      // A championship room advertises WHERE IN THE SEASON it is, because that
      // is what a browser needs to decide whether to join ("R7/8" is nearly
      // over); a plain room keeps the old lap-count label verbatim.
      label: this.season.championship
        ? `R${this.round}/${this.season.rounds} · ${this.track.name}`
        : `3 laps · ${this.track.name}`,
      players: this.playerCount(),
      maxPlayers: MAX_PLAYERS,
      phase: this.phase,
      visibility: this.visibility,
    };
  }

  /** Entries are deleted on disconnect, so the map size IS the count. */
  playerCount(): number {
    return this.players.size;
  }

  /** Players with no valid message (kart_input/nitro/start) for INPUT_STALE_MS. */
  stalePlayers(): PlayerId[] {
    const now = Date.now();
    const out: PlayerId[] = [];
    for (const p of this.players.values()) {
      if (now - p.lastStateAt > INPUT_STALE_MS) out.push(p.id);
    }
    return out;
  }

  addPlayer(id: PlayerId, name: string, _resume?: PlayerId): void {
    try {
      const now = Date.now();
      const existing = this.players.get(id);
      if (existing !== undefined) {
        // same-session re-add: keep slot + race state, play on
        existing.name = name;
        existing.lastStateAt = now;
      } else {
        if (this.playerCount() >= MAX_PLAYERS) {
          // unreachable via the lobby (it guards room_full first); never throws
          this.io.send(id, { t: 'error', code: 'room_full', message: 'room is full' });
          return;
        }
        this.players.set(id, this.freshPlayer(id, name, now));
      }
      // NO AUTO-START (frozen lobby contract): a full lobby still WAITS. The
      // room leaves 'lobby' only on an explicit `{t:'start'}` from a seated
      // player (tryStart) — joining never begins a race.
      const p = this.players.get(id)!;
      // Championship registration happens AFTER the seat exists, so a joiner
      // who was bounced for room_full above never lands in the standings. A
      // mid-season arrival starts on zero with joinedRound = the current round;
      // they cannot touch anybody else's row.
      this.ensureEntry(p);
      this.standingsDirty = true; // `here` flips, and a re-add may have renamed them
      this.io.send(id, this.joinedFor(p));
    } catch (err) {
      console.error('[kart] addPlayer failed', err);
    }
  }

  /**
   * Immediate removal (socket drop or explicit leave alike — no ghosting v1).
   * A finishOrder entry is NOT removed: a finished player keeps their result.
   */
  removePlayer(id: PlayerId, _permanent?: boolean): void {
    try {
      if (!this.players.delete(id)) return;
      // The row SURVIVES the seat (F1: you keep the points you scored), it just
      // stops being `here`. Eviction of departed rows is the standings cap's job.
      this.standingsDirty = true;
      const now = Date.now();
      const n = this.playerCount();
      if (n === 0 && this.phase !== 'lobby') {
        this.resetToLobby(now); // nobody left to show the race/results to
      } else if ((this.phase === 'ready' || this.phase === 'countdown') && n < MIN_PLAYERS) {
        // low pop before GO: cancel back to the lobby
        this.phase = 'lobby';
        this.phaseEndsAt = 0;
        this.countdown = 0;
      } else if (this.phase === 'racing' && this.allFinished()) {
        // the leaver was the last one still out: race over for the rest
        this.enterResults(now);
      }
      // low pop mid-race (n >= 1): the race RUNS ON for the remaining players
      // (docs/KART.md "Low pop") — they can still set laps until finish/timeout
    } catch (err) {
      console.error('[kart] removePlayer failed', err);
    }
  }

  /**
   * Wire ingress ONLY — it never simulates. An input is validated, gated on the
   * per-client monotonic seq and QUEUED; the sim tick is the single place a
   * kart moves, so message timing/bursting cannot buy a player extra motion.
   */
  handleMessage(id: PlayerId, msg: unknown): void {
    try {
      const parsed = parseKartC2S(msg);
      if (parsed === null) return;
      const p = this.players.get(id);
      if (p === undefined) return;
      const now = Date.now();
      p.lastStateAt = now; // any valid message is liveness
      if (parsed.t === 'nitro') {
        this.tryNitro(p, now);
        return;
      }
      if (parsed.t === 'start') {
        this.tryStart(now);
        return;
      }
      if (parsed.seq <= p.lastQueuedSeq) return; // per-client monotonic: drop late dupes
      p.lastQueuedSeq = parsed.seq;
      if (p.inputQueue.length >= INPUT_QUEUE_CAP) p.inputQueue.shift(); // oldest dropped
      p.inputQueue.push(parsed);
    } catch (err) {
      console.error('[kart] handleMessage failed', err);
    }
  }

  start(): void {
    this.stopped = false; // idempotent
    if (this.simTimer === null) {
      this.simTimer = setInterval(() => this.simTick(), 1000 / SIM_HZ);
    }
    if (this.snapTimer === null) {
      this.snapTimer = setInterval(() => this.snapshotTick(), 1000 / SNAPSHOT_HZ);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.simTimer !== null) {
      clearInterval(this.simTimer);
      this.simTimer = null;
    }
    if (this.snapTimer !== null) {
      clearInterval(this.snapTimer);
      this.snapTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Sim tick (SIM_HZ): phase machine, input consumption + integration,
  // kart-vs-kart contact, places. Never throws.
  // -------------------------------------------------------------------------

  private simTick(): void {
    if (this.stopped) return;
    try {
      const now = Date.now();
      switch (this.phase) {
        case 'ready':
          if (now >= this.phaseEndsAt) this.enterCountdown(now);
          break;
        case 'countdown':
          if (now >= this.countdownEndsAt) this.advanceCountdown(now);
          break;
        case 'racing':
          if (now >= this.raceEndsAt) {
            this.broadcastEvent({ kind: 'timeout' });
            this.enterResults(now);
          }
          break;
        case 'results':
          if (now >= this.phaseEndsAt) this.resetToLobby(now);
          break;
        case 'lobby':
          break;
      }
      // integrate in join order, then resolve every contact ONCE over the
      // post-step positions (order-independent, unlike per-player resolution)
      for (const p of this.players.values()) this.tickPlayer(p, now);
      if (this.phase === 'racing') {
        this.resolveContacts(now);
        this.updatePlaces();
      }
    } catch (err) {
      console.error('[kart] simTick failed', err);
    }
  }

  /** Snapshot tick (SNAPSHOT_HZ): broadcast only, no simulation. Never throws. */
  private snapshotTick(): void {
    if (this.stopped) return;
    try {
      this.tickCount++;
      this.broadcastSnapshot(Date.now());
    } catch (err) {
      console.error('[kart] snapshotTick failed', err);
    }
  }

  /**
   * Consume this player's queued inputs (FIFO, at most MAX_INPUTS_PER_TICK) and
   * integrate them.
   *
   * SPEEDHACK BUDGET: simulated time is charged into a 1-second wall-clock
   * bucket and capped at SIM_BUDGET_MUL seconds of kart time per real second.
   * An honest client sending SIM_HZ inputs of SIM_DT each sits at exactly 1.0
   * and never trips it; the headroom absorbs jitter/catch-up. Over budget the
   * remaining inputs simply stay QUEUED (and unacknowledged), which is a rate
   * limit rather than a kick — the flood is throttled to real time.
   *
   * Outside 'racing' inputs are still consumed and ACKED but NOT integrated:
   * the pre-GO grid freeze holds (nothing a client sends can move a kart before
   * GO) while the client's replay queue still drains instead of growing to its
   * cap during the whole countdown.
   */
  private tickPlayer(p: Player, now: number): void {
    const q = p.inputQueue;
    if (q.length === 0) return;
    const win = Math.floor(now / 1000);
    if (p.simWindow !== win) {
      p.simWindow = win;
      p.simUsed = 0;
    }
    const racing = this.phase === 'racing';
    const max = Math.min(q.length, MAX_INPUTS_PER_TICK);
    let n = 0;
    for (; n < max; n++) {
      const inp = q[n];
      if (inp === undefined) break;
      // budget is charged only for inputs that actually integrate
      if (racing && p.simUsed + inp.dt > SIM_BUDGET_MUL) break;
      p.lastProcessedSeq = inp.seq;
      if (racing) {
        // steer is a VISUAL channel (the remote kart's wheel angle), but it is
        // still client-supplied, so it obeys the pre-GO freeze too: a kart on
        // the grid shows straight wheels no matter what its driver is holding.
        p.steer = inp.steer;
        stepDrive(p.sim, inp, inp.dt, this.track);
        p.simUsed += inp.dt;
        // per INPUT, not per tick: a burst can never tunnel through a gate
        if (!p.finished) this.tryGateCredit(p, now);
      }
    }
    if (n >= q.length) q.length = 0;
    else if (n > 0) {
      q.copyWithin(0, n);
      q.length -= n;
    }
  }

  /**
   * Kart-vs-kart contact for the WHOLE room, resolved once per sim tick after
   * every kart has stepped. Each unordered pair is resolved exactly once, so
   * both drivers get the same overlap split and the same normal impulse — the
   * bump is one fact about the race instead of two clients disagreeing.
   *
   * A shove can land a kart past the wall, so every kart is re-clamped to the
   * barrier AFTER the whole pair loop, not inside it. Two reasons, both real:
   * resolveKartPair returns 0 for a pair that is TOUCHING BUT SEPARATING — it
   * has already split their overlap by then, so a zero return is not "nothing
   * moved" and an inner-loop clamp guarded by the return value misses it (two
   * karts respawning onto the same gate anchor is the easy case: 1.8m of
   * push-out with zero relative velocity). And a chained shove (A pushed into
   * B, B pushed into the wall) is only resolved if the pairs happen to come in
   * the right order. One unconditional O(n) pass at the end covers both, and
   * costs 20 clamps a tick instead of up to 380 — cheaper than the guarded
   * version it replaces, and it cannot miss a case.
   */
  private resolveContacts(now: number): void {
    const list = this.rebuildOrder();
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]!;
        const impulse = resolveKartPair(a.sim, b.sim);
        if (impulse <= 0) continue;
        if (
          impulse >= BUMP_MIN_SPEED &&
          now - a.bumpAt >= BUMP_COOLDOWN_MS &&
          now - b.bumpAt >= BUMP_COOLDOWN_MS
        ) {
          a.bumpAt = now;
          b.bumpAt = now;
          this.broadcastEvent({ kind: 'bump', a: a.id, b: b.id, impulse });
        }
      }
    }
    for (const p of list) clampToBarrier(p.sim, this.track);
  }

  /** The shared scratch roster, refilled in place (never reallocated). */
  private rebuildOrder(): Player[] {
    const list = this.order;
    list.length = 0;
    for (const p of this.players.values()) list.push(p);
    return list;
  }

  // -------------------------------------------------------------------------
  // Phase machine
  // -------------------------------------------------------------------------

  /**
   * The ONE way out of 'lobby' (frozen lobby contract). Any seated player may
   * send `{t:'start'}` — there is no host in KART. Accepted only in 'lobby'
   * with at least MIN_PLAYERS seated; every other case is silently ignored, so
   * a spammed or mistimed start is a no-op rather than an error.
   */
  private tryStart(now: number): void {
    if (this.phase !== 'lobby') return;
    if (this.playerCount() < MIN_PLAYERS) return;
    this.enterReady(now);
  }

  /** True while a `{t:'start'}` would be accepted (mirrored onto every snapshot). */
  private canStart(): boolean {
    return this.phase === 'lobby' && this.playerCount() >= MIN_PLAYERS;
  }

  /** 5s "get ready" — entered ONLY from tryStart, never automatically. */
  private enterReady(now: number): void {
    this.phase = 'ready';
    this.phaseEndsAt = now + READY_SECONDS * 1000;
  }

  /** First countdown beat fires immediately; the rest tick at 1s each. */
  private enterCountdown(now: number): void {
    this.phase = 'countdown';
    this.countdown = COUNTDOWN_SECONDS;
    this.countdownEndsAt = now + 1000;
    this.phaseEndsAt = now + COUNTDOWN_SECONDS * 1000; // GO time for the HUD clock
    this.broadcastEvent({ kind: 'countdown', n: this.countdown });
  }

  /** 3 → 2 → 1 at 1s beats, then GO. */
  private advanceCountdown(now: number): void {
    this.countdown--;
    if (this.countdown <= 0) {
      this.go(now);
      return;
    }
    this.countdownEndsAt += 1000;
    this.broadcastEvent({ kind: 'countdown', n: this.countdown });
  }

  /** Race start: everyone (grid + mid-countdown joiners) starts lap 1 together. */
  private go(now: number): void {
    this.phase = 'racing';
    this.countdown = 0;
    this.raceStartAt = now;
    this.raceEndsAt = now + RACE_TIMEOUT_S * 1000;
    this.phaseEndsAt = this.raceEndsAt;
    for (const p of this.players.values()) {
      // Grid wipe: a fresh kart on the slot, and the pre-GO input backlog is
      // DROPPED but ACKED — dropping alone would leave those seqs pending in
      // the client's replay queue forever (it would keep re-applying inputs the
      // server will never process), acking alone would let them apply after GO.
      const spawn = gridSlot(this.track, p.slot);
      resetSim(p.sim, spawn.x, spawn.z, spawn.yaw);
      p.steer = 0;
      p.inputQueue.length = 0;
      p.lastProcessedSeq = Math.max(p.lastProcessedSeq, p.lastQueuedSeq);
      p.simWindow = 0;
      p.simUsed = 0;
      p.bumpAt = 0;
      p.nitroLeft = NITRO_CHARGES; // per-race charges refill at GO
      p.nitroUntil = 0;
      p.lapStartAt = now;
      // Everyone on the grid is in the championship BEFORE a wheel turns, so a
      // driver who DNFs this round still shows up in the table on 0 — the
      // standings are the room's roster, not just its finishers.
      this.ensureEntry(p);
    }
    this.updatePlaces();
    this.broadcastEvent({ kind: 'go' });
  }

  private enterResults(now: number): void {
    this.phase = 'results';
    this.phaseEndsAt = now + RESULTS_SECONDS * 1000;
    this.scoreRound();
  }

  /**
   * Results -> lobby: race state resets and players stay seated, and the room
   * then WAITS. It used to re-arm itself the moment MIN_PLAYERS were seated,
   * which meant a finished race rolled straight into the next one and nobody
   * could leave, join, or catch their breath between races. The next race now
   * needs another explicit `{t:'start'}` (frozen lobby contract).
   */
  private resetToLobby(_now: number): void {
    // ORDER IS LOAD-BEARING: the calendar advances FIRST, because the grid
    // reset below calls gridSlot(this.track, ...) and has to place karts on the
    // circuit they are about to race, not the one they just left.
    this.advanceSeason();
    for (const p of this.players.values()) this.resetRaceState(p);
    this.finishOrder.length = 0; // pooled like every other per-race array here
    this.phase = 'lobby';
    this.phaseEndsAt = 0;
    this.countdown = 0;
    this.broadcastEvent({ kind: 'restart' });
  }

  // -------------------------------------------------------------------------
  // Championship: scoring, calendar advance, standings
  // -------------------------------------------------------------------------

  /**
   * Award the round's points. Called from enterResults ONLY, and IDEMPOTENT per
   * round: enterResults has three callers (the last gate credit, the last racer
   * leaving mid-race, the race timeout) and two of them can land in the same
   * tick, so the guard is what stops a race paying out twice.
   *
   * DNF SCORES 0 BY OMISSION: a driver who never crossed the line is not in
   * finishOrder, so this loop never reaches them and there is no special case
   * to get wrong. They still get a row (the ensureEntry sweep below) with
   * delta 0, which is how the results screen shows "started, scored nothing".
   */
  private scoreRound(): void {
    if (!this.season.championship) return;
    if (this.scoredRound === this.round) return; // already paid for this round
    this.scoredRound = this.round;
    // The "+N" column is per-round, so it is cleared for EVERYONE first —
    // otherwise last round's delta would linger on this round's absentees.
    for (const e of this.entries.values()) e.delta = 0;
    for (let i = 0; i < this.finishOrder.length; i++) {
      const id = this.finishOrder[i]!;
      const place = i + 1; // finishOrder IS the classification, in order
      const pts = pointsForPlace(place);
      // Defensive: a driver can finish and then disconnect before this runs, so
      // their Player record (and their name with it) may be gone. The points
      // are theirs regardless — F1 does not un-award a race because someone
      // left the paddock — so the row is created on the spot.
      //
      // `null`, NOT a placeholder string: they almost always DO have a row
      // already (go() registers the whole grid), and passing a fallback name
      // here would overwrite the real one with it for the rest of the season —
      // "DRIVER — 25 pts" on the results screen of the driver who just won.
      // The placeholder is only ever the name of a row that has none.
      const seated = this.players.get(id);
      const e = this.ensureEntryFor(id, seated?.name ?? null);
      e.points += pts;
      e.delta = pts;
      if (place === 1) e.wins++;
      if (e.bestFinish === 0 || place < e.bestFinish) e.bestFinish = place; // 0 = never finished
    }
    // Everyone still seated gets a row even if they scored nothing this round.
    for (const p of this.players.values()) this.ensureEntry(p);
    this.standingsDirty = true;
    if (this.round >= this.season.rounds) {
      this.seasonOver = true;
      // The champion is whoever the FROZEN tie-break puts first — resolve the
      // table now rather than trusting a later rebuild, so `championId` and the
      // standings a client sees are computed from the same sort.
      this.rebuildStandings();
      this.championId = this.standingRows[0]?.id ?? null;
    }
  }

  /**
   * Calendar advance, on the way back to the lobby. A finished season rolls
   * into a fresh one; otherwise the room moves to the next round and circuit.
   * The room still does NOT re-arm: the next round waits for another explicit
   * `{t:'start'}` (frozen lobby contract).
   */
  private advanceSeason(): void {
    if (!this.season.championship) return;
    if (this.seasonOver) {
      this.startNewSeason();
      return;
    }
    // AN ABANDONED ROUND DOES NOT BURN A CALENDAR SLOT. resetToLobby is also
    // the abandon path — the last player leaves during ready/countdown/racing,
    // so the round is never scored — and the rule is "the room moves to the
    // next circuit when a race FINISHES". A race nobody raced did not finish.
    // Without this gate a churny room drifts toward the final round on empty
    // slots and then crowns a "champion" off a table of departed ghosts.
    // `scoredRound === round` is precisely "this round paid out" (scoreRound
    // stamps it), so it is the same guard that makes scoring idempotent.
    if (this.scoredRound !== this.round) return; // stay on this round AND this circuit
    // Clamp as belt-and-braces: `round` must never index past the calendar even
    // if some future path advances without a score.
    this.round = Math.min(this.round + 1, this.season.rounds);
    this.setTrack(this.calendar[this.round - 1] ?? this.baseTrackId);
  }

  /**
   * Wipe the table and race the calendar again from `baseTrackId`. Everyone
   * seated is re-registered immediately on 0 points / joinedRound 1: the new
   * season starts level, and nobody carries a mid-season badge into round 1.
   */
  private startNewSeason(): void {
    this.entries.clear();
    this.seasonSeq = 0;
    this.round = 1;
    this.seasonOver = false;
    this.championId = null;
    this.scoredRound = 0; // round 1 has not been paid yet
    this.calendar = buildCalendar(this.baseTrackId, this.season.rounds);
    this.setTrack(this.calendar[0] ?? this.baseTrackId);
    for (const p of this.players.values()) this.ensureEntry(p);
    this.standingsDirty = true;
  }

  /** Swap the room's circuit. Rebuilding an identical track is pure waste. */
  private setTrack(id: TrackId): void {
    if (this.track.id === id) return;
    this.track = buildTrack(TRACKS[id]);
  }

  /** Register/refresh a seated player's championship row. */
  private ensureEntry(p: Player): void {
    if (!this.season.championship) return;
    this.ensureEntryFor(p.id, p.name);
  }

  /**
   * The one place a SeasonEntry is born. A new driver starts on zero, with
   * `joinedRound` stamped at the CURRENT round (so the table can mark them as a
   * mid-season arrival) and a unique `seq` — the tie-break's final rung.
   */
  private ensureEntryFor(id: PlayerId, name: string | null): SeasonEntry {
    let e = this.entries.get(id);
    if (e === undefined) {
      // Trim BEFORE inserting, with one slot of headroom. Trimming AFTER would
      // let the cap evict the row we were just asked to create — a departed
      // finisher's brand-new entry is on 0 points with the highest seq, i.e.
      // EXACTLY the victim the tie-break picks — and the caller would then add
      // that round's points to a detached object that is in no table.
      this.evictOverflow(1);
      e = {
        id,
        name: name ?? 'DRIVER', // last resort: a row must have some label
        points: 0,
        delta: 0,
        wins: 0,
        bestFinish: 0, // 0 == never finished, which compareSeason ranks last
        joinedRound: this.round,
        seq: this.seasonSeq++,
      };
      this.entries.set(id, e);
    } else if (name !== null) {
      // Only a LIVE name overwrites: a same-session re-add can rename and the
      // row should follow, but "we no longer know this driver's name" must
      // never clobber the one we already had.
      e.name = name;
    }
    this.standingsDirty = true;
    return e;
  }

  /**
   * Standings cap. A departed driver KEEPS their points, so a long-lived public
   * room with heavy churn would otherwise grow one row per person who ever sat
   * in it. Past SEASON_STANDINGS_CAP the cheapest rows go first: never a seated
   * driver, then fewest points, then the LATEST joiner (highest seq) — i.e. we
   * drop the person who contributed least and arrived last. MAX_PLAYERS (20) is
   * below the cap (40), so a full grid can never evict itself, and the `break`
   * below is unreachable defence rather than a real policy.
   *
   * `headroom` is how many rows the caller is ABOUT to add, so it can trim
   * before inserting and keep the incoming row structurally un-evictable.
   */
  private evictOverflow(headroom: number): void {
    while (this.entries.size + headroom > SEASON_STANDINGS_CAP) {
      let victim: SeasonEntry | null = null;
      for (const e of this.entries.values()) {
        if (this.players.has(e.id)) continue; // seated drivers are untouchable
        if (
          victim === null ||
          e.points < victim.points ||
          (e.points === victim.points && e.seq > victim.seq)
        ) {
          victim = e;
        }
      }
      if (victim === null) break; // everyone is seated: nothing may be evicted
      this.entries.delete(victim.id);
    }
  }

  /**
   * Refill the pooled standings rows, sorted by the FROZEN tie-break
   * (compareSeason): points desc, then wins desc, then best single finish asc
   * (0 = never finished, ranked last), then join order asc. That last rung is
   * unique per driver, so the comparator is a TOTAL order — the table has
   * exactly one valid arrangement and a re-sort can never shuffle equals.
   *
   * Runs at most once per snapshot tick and only when something actually
   * changed (award / join / leave / rename / new season), and allocates nothing
   * in the steady state: rows are pushed only to GROW the pool.
   */
  private rebuildStandings(): void {
    if (!this.standingsDirty) return;
    this.standingsDirty = false;
    const list = this.sortScratch;
    list.length = 0;
    for (const e of this.entries.values()) list.push(e);
    list.sort(compareSeason);
    const rows = this.standingRows;
    while (rows.length < list.length) {
      rows.push({
        id: '',
        name: '',
        pos: 0,
        points: 0,
        delta: 0,
        wins: 0,
        bestFinish: 0,
        here: false,
        joinedRound: 1,
      });
    }
    rows.length = list.length;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      const r = rows[i]!;
      r.id = e.id;
      r.name = e.name;
      r.pos = i + 1; // championship position, 1-based and ascending in the array
      r.points = e.points;
      r.delta = e.delta;
      r.wins = e.wins;
      r.bestFinish = e.bestFinish;
      r.here = this.players.has(e.id); // a departed driver keeps the row, loses the flag
      r.joinedRound = e.joinedRound;
    }
  }

  // -------------------------------------------------------------------------
  // Gates / laps / places
  // -------------------------------------------------------------------------

  /**
   * Credit the EXPECTED gate only, in order (a skipped gate simply never
   * matches). The line (gate 0) closes the lap: lap event + bestLap update.
   * Finish = LAPS_TO_WIN * GATES credits — the finish event's place is the
   * finishOrder length, so finished disconnects keep their slot in the order.
   */
  private tryGateCredit(p: Player, now: number): void {
    const gate = this.track.gates[p.nextGate]!;
    const dx = p.sim.x - gate.x;
    const dz = p.sim.z - gate.z;
    if (dx * dx + dz * dz > GATE_RADIUS * GATE_RADIUS) return;
    const credited = p.nextGate;
    p.nextGate = (p.nextGate + 1) % GATES;
    p.progress++;
    p.gateTimes.set(p.progress, now); // gap timing: timestamp every credit
    this.broadcastEvent({ kind: 'gate', playerId: p.id, gate: credited });
    if (credited === 0 && p.lapStartAt >= 0) {
      const lapMs = now - p.lapStartAt;
      if (p.bestLapMs < 0 || lapMs < p.bestLapMs) p.bestLapMs = lapMs;
      this.broadcastEvent({ kind: 'lap', playerId: p.id, lap: p.lap, lapMs });
      p.lap++;
      p.lapStartAt = now;
    }
    if (p.progress >= LAPS_TO_WIN * GATES && !p.finished) {
      p.finished = true;
      p.finishMs = now - this.raceStartAt;
      // finishOrder ITSELF is the authority on "already classified", not the
      // per-player `finished` flag above: a same-id rejoin mid-race deletes the
      // Player and builds a FRESH one with finished:false, which can drive the
      // distance again and reach this branch a second time. That was cosmetic
      // when finishOrder only fed a results screen; it is now the SCORING
      // INPUT, so a duplicate would pay the driver twice, invent a win, and
      // shift every later finisher down a place. The array is at most
      // MAX_PLAYERS long, so the linear scan is free.
      let place = this.finishOrder.indexOf(p.id) + 1; // 0 => not classified yet
      if (place === 0) {
        this.finishOrder.push(p.id);
        place = this.finishOrder.length;
      }
      this.broadcastEvent({ kind: 'finish', playerId: p.id, place });
    }
    this.updatePlaces();
    if (this.allFinished()) this.enterResults(now);
  }

  /**
   * Nitro (frozen): one charge per use, only while racing, only if a charge
   * remains (else silently ignored).
   *
   * THREE different quantities, deliberately: `p.nitroLeft` is the CHARGE COUNT
   * (0..NITRO_CHARGES, shown in the HUD), `p.nitroUntil` is the wall-clock
   * window `nitroActive` is true in (the remote flame/skid visual), and
   * `p.sim.nitroLeft` is BOOST SECONDS consumed by stepKart. The last one used
   * to be set only on the client, which was harmless while the client owned
   * positions — now that the server integrates, a server sim without the boost
   * would fight a client prediction with it for the whole NITRO_TIME, i.e. a
   * hard correction on every press.
   */
  private tryNitro(p: Player, now: number): void {
    if (this.phase !== 'racing') return;
    if (p.nitroLeft <= 0) return;
    p.nitroLeft--;
    p.nitroUntil = now + NITRO_TIME * 1000;
    p.sim.nitroLeft = NITRO_TIME; // boost seconds: what the SIM actually burns
    this.broadcastEvent({ kind: 'nitro', playerId: p.id, left: p.nitroLeft });
  }

  /**
   * Race position: finished players first by finish time (their order is
   * final), then racing players by progress desc; ties break by distance to
   * the player's next gate, ascending. Sorts the shared scratch array in
   * place — it runs at SIM_HZ now, so it may not allocate.
   */
  private updatePlaces(): void {
    const order = this.rebuildOrder();
    order.sort(this.placeCmp); // hoisted: a fresh comparator closure per call
    // was the one remaining allocation in a 30Hz tick
    for (let i = 0; i < order.length; i++) order[i]!.place = i + 1;
  }

  /** Place order: finishers first by finish time, then by progress, then by
   *  distance to their own next gate. Allocated once, not per sort. */
  private readonly placeCmp = (a: Player, b: Player): number => {
    if (a.finished && b.finished) return a.finishMs - b.finishMs;
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.progress !== b.progress) return b.progress - a.progress;
    return this.distToNextGate(a) - this.distToNextGate(b);
  };

  private distToNextGate(p: Player): number {
    const gate = this.track.gates[p.nextGate]!;
    return Math.hypot(p.sim.x - gate.x, p.sim.z - gate.z);
  }

  /** Every connected player has finished (and someone is connected). */
  private allFinished(): boolean {
    if (this.players.size === 0) return false;
    for (const p of this.players.values()) if (!p.finished) return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // Player records / wire
  // -------------------------------------------------------------------------

  /** Fresh entry: grid spawn; a mid-race joiner starts lap 1 NOW and races too. */
  private freshPlayer(id: PlayerId, name: string, now: number): Player {
    const slot = this.lowestFreeSlot();
    const spawn = gridSlot(this.track, slot);
    const color = slot % KART_COLORS.length;
    const sim = makeSim(spawn.x, spawn.z, spawn.yaw);
    const snap: KartPlayerSnap = {
      id,
      name,
      slot,
      color,
      p: [spawn.x, 0, spawn.z],
      yaw: spawn.yaw,
      v: [0, 0],
      steer: 0,
      drift: false,
      lap: 1,
      nextGate: 1,
      progress: 0,
      place: slot + 1,
      finished: false,
      finishMs: -1,
      nitroActive: false,
    };
    const you: KartYou = {
      lap: 1,
      nextGate: 1,
      progress: 0,
      place: slot + 1,
      finished: false,
      finishMs: -1,
      bestLapMs: -1,
      nitroLeft: 0,
      gapAheadMs: 0,
      lastProcessedSeq: -1,
      sim, // bound ONCE: the sim mutates in place, the reference never changes
    };
    const p: Player = {
      id,
      name,
      slot,
      color,
      lastStateAt: now,
      sim,
      steer: 0,
      inputQueue: [],
      lastQueuedSeq: -1,
      lastProcessedSeq: -1,
      simWindow: 0,
      simUsed: 0,
      bumpAt: 0,
      lap: 1,
      nextGate: 1,
      progress: 0,
      place: slot + 1, // grid order until places are computed at GO
      lapStartAt: -1,
      bestLapMs: -1,
      gateTimes: new Map(),
      finished: false,
      finishMs: -1,
      nitroLeft: 0, // no charges until the GO refill (mid-race joiners included)
      nitroUntil: 0,
      snap,
      you,
      msg: {
        t: 'kart_snapshot',
        tick: 0,
        serverTime: now,
        phase: this.phase,
        countdown: 0,
        phaseEndsAt: 0,
        playerCount: this.playerCount(),
        minPlayers: MIN_PLAYERS,
        canStart: this.canStart(),
        // Both of these are now REFRESHED PER TICK in broadcastSnapshot — the
        // circuit moves with the calendar, so `trackId` can no longer be a
        // set-once field. They are seeded here purely to satisfy the type at
        // construction.
        trackId: this.track.id,
        championship: this.seasonWire, // the ONE shared season object (null when disabled)
        you, // same object: broadcastSnapshot mutates it, never replaces it
        players: this.snapPlayers,
      },
    };
    if (this.phase === 'racing') p.lapStartAt = now; // mid-race joiner races immediately
    return p;
  }

  /** Back to the grid for the next race (slot and color stay). */
  private resetRaceState(p: Player): void {
    const spawn = gridSlot(this.track, p.slot);
    resetSim(p.sim, spawn.x, spawn.z, spawn.yaw);
    p.steer = 0;
    p.inputQueue.length = 0;
    p.lastProcessedSeq = Math.max(p.lastProcessedSeq, p.lastQueuedSeq);
    p.simWindow = 0;
    p.simUsed = 0;
    p.bumpAt = 0;
    p.lap = 1;
    p.nextGate = 1;
    p.progress = 0;
    p.place = p.slot + 1;
    p.lapStartAt = -1;
    p.bestLapMs = -1;
    p.gateTimes.clear();
    p.finished = false;
    p.finishMs = -1;
    p.nitroLeft = 0;
    p.nitroUntil = 0;
  }

  private lowestFreeSlot(): number {
    const taken = new Set<number>();
    for (const p of this.players.values()) taken.add(p.slot);
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      if (!taken.has(slot)) return slot;
    }
    return MAX_PLAYERS - 1; // unreachable: addPlayer guards the cap first
  }

  /**
   * kart_joined payload (frozen): the full seated roster, joiner included.
   * `code` is an additive field (same convention as bank_state) so clients can
   * show the private-room invite code; the frozen KartS2C union is untouched.
   */
  private joinedFor(you: Player): KartS2C & { code: string | null } {
    const players: KartPlayerInfo[] = [];
    for (const p of this.players.values()) {
      players.push({ id: p.id, name: p.name, slot: p.slot, color: p.color });
    }
    return {
      t: 'kart_joined',
      code: this.code, // private-room invite code (null for public); everyone in the room may see it
      you: you.id,
      slot: you.slot,
      color: you.color,
      phase: this.phase,
      trackId: this.track.id,
      players,
    };
  }

  /**
   * Gap timing (docs/KART.md, frozen): ms behind the player one place ahead.
   * Exact when both karts have a timestamp for the same gate sequence (the
   * common credit count, i.e. min progress), else estimated from the spatial
   * distance at 20 m/s. 0 for the leader and outside 'racing'.
   */
  private gapAheadMs(you: Player): number {
    if (this.phase !== 'racing' || you.place <= 1) return 0;
    let ahead: Player | undefined;
    for (const p of this.players.values()) {
      if (p.place === you.place - 1) {
        ahead = p;
        break;
      }
    }
    if (ahead === undefined) return 0;
    const seq = Math.min(you.progress, ahead.progress);
    if (seq > 0) {
      const mine = you.gateTimes.get(seq);
      const theirs = ahead.gateTimes.get(seq);
      if (mine !== undefined && theirs !== undefined) return Math.max(0, mine - theirs);
    }
    return Math.round((Math.hypot(you.sim.x - ahead.sim.x, you.sim.z - ahead.sim.z) / 20) * 1000);
  }

  /**
   * The per-player roster — IDENTICAL for every recipient, so it is built ONCE
   * per tick into the shared `snapPlayers` array and each player's persistent
   * `snap` object is mutated in place. Nothing here is allocated per tick.
   *
   * This used to live inside the per-recipient loop: n snapshots x n entries =
   * O(n^2) fresh objects every tick (8 players -> 64/tick; 20 -> 400/tick, i.e.
   * 8,000/s at SNAPSHOT_HZ 20, each with two fresh sub-arrays). Same pattern as
   * the FPS server (games/fps/server/src/game.ts sendSnapshots).
   */
  private buildSnapPlayers(now: number): KartPlayerSnap[] {
    const list = this.snapPlayers;
    list.length = 0;
    for (const p of this.players.values()) {
      const s = p.snap;
      const k = p.sim; // the authoritative kart: nothing else writes these
      s.name = p.name; // a same-session re-add can rename; id/slot/color cannot change
      s.p[0] = k.x;
      s.p[1] = k.y;
      s.p[2] = k.z;
      s.yaw = k.yaw;
      s.v[0] = k.vx;
      s.v[1] = k.vz;
      s.steer = p.steer;
      s.drift = k.drifting;
      s.lap = p.lap;
      s.nextGate = p.nextGate;
      s.progress = p.progress;
      s.place = p.place;
      s.finished = p.finished;
      s.finishMs = p.finishMs;
      s.nitroActive = now < p.nitroUntil;
      list.push(s);
    }
    return list;
  }

  /**
   * One shared roster + a per-recipient `you` block. The wire bytes are exactly
   * what snapshotFor() used to produce — Session.send JSON-encodes each message
   * synchronously, so reusing the objects is invisible to clients. `you.sim` is
   * NOT assigned here: it is bound to the player's live KartSim once at join.
   */
  private broadcastSnapshot(now: number): void {
    const list = this.buildSnapPlayers(now);
    const count = this.playerCount();
    const canStart = this.canStart();
    const trackId = this.track.id;
    // ONCE per tick, not once per recipient: the season is one shared object
    // (its `standings` array is bound to standingRows for the room's lifetime),
    // so refreshing it here costs O(1) instead of O(players).
    const season = this.seasonWire;
    if (season !== null) {
      season.round = this.round;
      season.rounds = this.season.rounds;
      season.trackId = trackId;
      // null on the final round: there is no next circuit to preview.
      season.nextTrackId = this.round < this.season.rounds ? (this.calendar[this.round] ?? null) : null;
      season.over = this.seasonOver;
      season.championId = this.championId;
      this.rebuildStandings(); // no-op unless something actually changed
    }
    for (const p of this.players.values()) {
      const you = p.you;
      you.lap = p.lap;
      you.nextGate = p.nextGate;
      you.progress = p.progress;
      you.place = p.place;
      you.finished = p.finished;
      you.finishMs = p.finishMs;
      you.bestLapMs = p.bestLapMs;
      you.nitroLeft = p.nitroLeft;
      you.gapAheadMs = this.gapAheadMs(p);
      you.lastProcessedSeq = p.lastProcessedSeq;
      const m = p.msg;
      m.tick = this.tickCount;
      m.serverTime = now;
      m.phase = this.phase;
      m.countdown = this.countdown;
      m.phaseEndsAt = this.phaseEndsAt;
      m.playerCount = count;
      m.minPlayers = MIN_PLAYERS;
      m.canStart = canStart;
      // Per tick, not per join: a room that changed circuit between rounds must
      // tell clients that were already connected, and the snapshot is the only
      // message they are guaranteed to keep receiving.
      m.trackId = trackId;
      m.championship = season;
      m.players = list;
      this.io.send(p.id, m);
    }
  }

  // one shared message object per event: Session.send JSON-encodes synchronously
  private broadcastEvent(ev: RaceEvent): void {
    const msg: KartS2C = { t: 'race_event', ev };
    for (const p of this.players.values()) this.io.send(p.id, msg);
  }
}
