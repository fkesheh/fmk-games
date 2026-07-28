// ============================================================================
// KART room (docs/KART.md) — authoritative race rules over client-trusted
// positions. Clients stream kart_state at 15Hz; the SERVER owns gates, laps,
// places, and results. One 15Hz interval drives the whole phase machine
// (lobby → ready 5s → countdown 3-2-1-GO → racing → results 10s → lobby),
// place computation, the race timeout, and the snapshot broadcast.
//
// Gate credit model: the 8 gates are credited IN ORDER only — a credit needs
// the player's streamed position within GATE_RADIUS of the EXPECTED gate
// (skipping gates gives nothing). nextGate starts at 1, so the start/finish
// line (gate 0) is the LAST credit of every lap: 8 credits per lap, finish at
// exactly LAPS_TO_WIN * GATES. `progress` is the monotonic credit count
// (KART.md "progress = lap×GATES + nextGateIndex" with a 0-based lap).
// Never throws.
// ============================================================================
import {
  COUNTDOWN_SECONDS,
  GATE_RADIUS,
  GATES,
  INPUT_STALE_MS,
  KART_COLORS,
  LAPS_TO_WIN,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NITRO_CHARGES,
  NITRO_TIME,
  READY_SECONDS,
  RESULTS_SECONDS,
  RACE_TIMEOUT_S,
  SNAPSHOT_HZ,
  buildTrack,
  gridSlot,
  parseKartC2S,
} from '@kart/shared';
import type {
  KartPhase,
  KartPlayerInfo,
  KartPlayerSnap,
  KartS2C,
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
  lastStateAt: number; // serverTime ms of join / last valid kart_state; stale sweep
  lastSeq: number; // last accepted kart_state seq (per-client monotonic)
  // last streamed kart state (spawn = the player's grid slot)
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  steer: number;
  drift: boolean;
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
}

export class KartRoom implements GameRoomHandle {
  readonly id: RoomId;
  readonly code: string | null;
  readonly visibility: Visibility;

  private readonly io: RoomIO;
  private readonly track: TrackDef; // shared TrackDef: gate positions for credit checks
  private readonly players = new Map<PlayerId, Player>(); // insertion order = join order

  private phase: KartPhase = 'lobby';
  private tickCount = 0; // snapshot sequence
  private phaseEndsAt = 0; // serverTime ms; 0 when no phase timer runs
  private countdown = 0; // current countdown number during 'countdown', else 0
  private countdownEndsAt = 0; // serverTime ms of the next countdown beat / GO
  private raceStartAt = 0; // serverTime ms of GO
  private raceEndsAt = 0; // serverTime ms; hard cap (RACE_TIMEOUT_S after GO)
  private finishOrder: PlayerId[] = []; // finish sequence; kept even for disconnects
  private interval: ReturnType<typeof setInterval> | null = null;
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

  /** Players with no kart_state for INPUT_STALE_MS. */
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
      // lobby fills up -> 5s "get ready" (players stay seated across races);
      // transition BEFORE the joined payload so its phase field is current
      if (this.phase === 'lobby' && this.playerCount() >= MIN_PLAYERS) this.enterReady(now);
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
      if (parsed.seq <= p.lastSeq) return; // per-client monotonic: drop late dupes
      p.lastSeq = parsed.seq;
      // Pre-GO freeze (frozen): positions are IGNORED outside 'racing' — the
      // snapshot stays at the grid slot until GO wipes any pre-GO movement.
      if (this.phase !== 'racing') return;
      p.x = parsed.p[0];
      p.y = parsed.p[1];
      p.z = parsed.p[2];
      p.yaw = parsed.yaw;
      p.vx = parsed.v[0];
      p.vz = parsed.v[1];
      p.steer = parsed.steer;
      p.drift = parsed.drift;
      if (!p.finished) this.tryGateCredit(p, now);
    } catch (err) {
      console.error('[kart] handleMessage failed', err);
    }
  }

  start(): void {
    this.stopped = false; // idempotent
    if (this.interval === null) {
      this.interval = setInterval(() => this.tick(), 1000 / SNAPSHOT_HZ);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // -------------------------------------------------------------------------
  // Phase machine (driven by the 15Hz tick)
  // -------------------------------------------------------------------------

  private tick(): void {
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
          this.updatePlaces();
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
      this.tickCount++;
      this.broadcastSnapshot(now);
    } catch (err) {
      console.error('[kart] tick failed', err);
    }
  }

  /** 5s "get ready" once the lobby reaches MIN_PLAYERS. */
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
      // Pre-GO freeze: wipe any streamed pre-GO movement back to the grid slot
      const spawn = gridSlot(this.track, p.slot);
      p.x = spawn.x;
      p.y = 0;
      p.z = spawn.z;
      p.yaw = spawn.yaw;
      p.vx = 0;
      p.vz = 0;
      p.steer = 0;
      p.drift = false;
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

  /** Results -> lobby: race state resets, players stay seated, re-arm at MIN_PLAYERS. */
  private resetToLobby(now: number): void {
    for (const p of this.players.values()) this.resetRaceState(p);
    this.finishOrder = [];
    this.phase = 'lobby';
    this.phaseEndsAt = 0;
    this.countdown = 0;
    this.broadcastEvent({ kind: 'restart' });
    if (this.playerCount() >= MIN_PLAYERS) this.enterReady(now);
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
    const dx = p.x - gate.x;
    const dz = p.z - gate.z;
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
   * remains (else silently ignored). The boost itself is client-side; the
   * server times nitroActive (NITRO_TIME) for snaps and broadcasts the event.
   */
  private tryNitro(p: Player, now: number): void {
    if (this.phase !== 'racing') return;
    if (p.nitroLeft <= 0) return;
    p.nitroLeft--;
    p.nitroUntil = now + NITRO_TIME * 1000;
    this.broadcastEvent({ kind: 'nitro', playerId: p.id, left: p.nitroLeft });
  }

  /**
   * Race position: finished players first by finish time (their order is
   * final), then racing players by progress desc; ties break by distance to
   * the player's next gate, ascending.
   */
  private updatePlaces(): void {
    const order = [...this.players.values()];
    order.sort((a, b) => {
      if (a.finished && b.finished) return a.finishMs - b.finishMs;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.progress !== b.progress) return b.progress - a.progress;
      return this.distToNextGate(a) - this.distToNextGate(b);
    });
    order.forEach((p, i) => {
      p.place = i + 1;
    });
  }

  private distToNextGate(p: Player): number {
    const gate = this.track.gates[p.nextGate]!;
    return Math.hypot(p.x - gate.x, p.z - gate.z);
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
    const p: Player = {
      id,
      name,
      slot,
      color: slot % KART_COLORS.length,
      lastStateAt: now,
      lastSeq: -1,
      x: spawn.x,
      y: 0,
      z: spawn.z,
      yaw: spawn.yaw,
      vx: 0,
      vz: 0,
      steer: 0,
      drift: false,
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
    };
    if (this.phase === 'racing') p.lapStartAt = now; // mid-race joiner races immediately
    return p;
  }

  /** Back to the grid for the next race (slot and color stay). */
  private resetRaceState(p: Player): void {
    const spawn = gridSlot(this.track, p.slot);
    p.x = spawn.x;
    p.y = 0;
    p.z = spawn.z;
    p.yaw = spawn.yaw;
    p.vx = 0;
    p.vz = 0;
    p.steer = 0;
    p.drift = false;
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
    return Math.round((Math.hypot(you.x - ahead.x, you.z - ahead.z) / 20) * 1000);
  }

  /** Fresh per-recipient snapshot (the `you` block differs). */
  private snapshotFor(you: Player, now: number): KartS2C {
    const players: KartPlayerSnap[] = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        name: p.name,
        slot: p.slot,
        color: p.color,
        p: [p.x, p.y, p.z],
        yaw: p.yaw,
        v: [p.vx, p.vz],
        steer: p.steer,
        drift: p.drift,
        lap: p.lap,
        nextGate: p.nextGate,
        progress: p.progress,
        place: p.place,
        finished: p.finished,
        finishMs: p.finishMs,
        nitroActive: now < p.nitroUntil,
      });
    }
    return {
      t: 'kart_snapshot',
      tick: this.tickCount,
      serverTime: now,
      phase: this.phase,
      countdown: this.countdown,
      phaseEndsAt: this.phaseEndsAt,
      you: {
        lap: you.lap,
        nextGate: you.nextGate,
        progress: you.progress,
        place: you.place,
        finished: you.finished,
        finishMs: you.finishMs,
        bestLapMs: you.bestLapMs,
        nitroLeft: you.nitroLeft,
        gapAheadMs: this.gapAheadMs(you),
      },
      players,
    };
  }

  private broadcastSnapshot(now: number): void {
    for (const p of this.players.values()) this.io.send(p.id, this.snapshotFor(p, now));
  }

  // one shared message object per event: Session.send JSON-encodes synchronously
  private broadcastEvent(ev: RaceEvent): void {
    const msg: KartS2C = { t: 'race_event', ev };
    for (const p of this.players.values()) this.io.send(p.id, msg);
  }
}
