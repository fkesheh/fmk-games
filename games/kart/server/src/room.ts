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
// ============================================================================
import {
  BUMP_COOLDOWN_MS,
  BUMP_MIN_SPEED,
  COUNTDOWN_SECONDS,
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
  SIM_BUDGET_MUL,
  SIM_HZ,
  SNAPSHOT_HZ,
  buildTrack,
  clampToBarrier,
  gridSlot,
  makeSim,
  parseKartC2S,
  resetSim,
  resolveKartPair,
  stepDrive,
} from '@kart/shared';
import type {
  KartInputMsg,
  KartPhase,
  KartPlayerInfo,
  KartPlayerSnap,
  KartS2C,
  KartSim,
  KartYou,
  RaceEvent,
  TrackDef,
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

export class KartRoom implements GameRoomHandle {
  readonly id: RoomId;
  readonly code: string | null;
  readonly visibility: Visibility;

  private readonly io: RoomIO;
  private readonly track: TrackDef; // shared TrackDef: gate positions for credit checks
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
  private finishOrder: PlayerId[] = []; // finish sequence; kept even for disconnects
  private simTimer: ReturnType<typeof setInterval> | null = null;
  private snapTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(visibility: Visibility, io: RoomIO) {
    this.visibility = visibility;
    this.io = io;
    this.track = buildTrack(); // deterministic: same gates the client renders
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
      label: '3 laps · circuit',
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
    }
    this.updatePlaces();
    this.broadcastEvent({ kind: 'go' });
  }

  private enterResults(now: number): void {
    this.phase = 'results';
    this.phaseEndsAt = now + RESULTS_SECONDS * 1000;
  }

  /**
   * Results -> lobby: race state resets and players stay seated, and the room
   * then WAITS. It used to re-arm itself the moment MIN_PLAYERS were seated,
   * which meant a finished race rolled straight into the next one and nobody
   * could leave, join, or catch their breath between races. The next race now
   * needs another explicit `{t:'start'}` (frozen lobby contract).
   */
  private resetToLobby(_now: number): void {
    for (const p of this.players.values()) this.resetRaceState(p);
    this.finishOrder = [];
    this.phase = 'lobby';
    this.phaseEndsAt = 0;
    this.countdown = 0;
    this.broadcastEvent({ kind: 'restart' });
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
      this.finishOrder.push(p.id);
      this.broadcastEvent({ kind: 'finish', playerId: p.id, place: this.finishOrder.length });
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
