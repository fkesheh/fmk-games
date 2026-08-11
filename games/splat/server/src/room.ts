// ============================================================================
// SKI SPLAT room (CONTRACT §4/§5/§6) — the SERVER-AUTHORITATIVE downhill race,
// cloned on the kart room discipline:
//
//   * the wire carries INTENT, never coordinates: clients send `splat_input`
//     (steer + dt + seq, the ONLY input — steering is the whole game), plus
//     `splat_assist` and the bare `{t:'start'}`;
//   * the room integrates the SHARED sim (shared/sim.ts stepSki, the exact
//     function the client predicts with) at TICK_HZ from per-player input
//     queues and owns every position on the slope;
//   * skier-vs-skier contact is resolved ONCE per tick over all racers
//     (resolveSkiPair) — server-only, one fact about the bump;
//   * plant hits are detected by diffing (lastPlantIx, lastPlantHitMs) between
//     steps (the sim.ts header convention: a hit is the only writer of the
//     pair) and broadcast as `splat_event plant_hit`; slalom gate passes are
//     detected the same way on (lastGateIx, boostUntilMs) — an advance WITH a
//     boostUntilMs change is a clean pass (`splat_event gate`), an advance
//     alone is a miss and emits nothing; finishing is detected the
//     same way on `finished` and broadcast as `splat_event finished`;
//   * each snapshot echoes `you.lastProcessedSeq` + `you.sim` so the client can
//     re-base its predictor and replay unacknowledged inputs.
//
// TWO INTERVALS: the sim tick (TICK_HZ 30) runs the phase machine, consumes
// inputs, integrates, resolves contact, detects plant/finish events and
// recomputes places; the snapshot tick (SNAPSHOT_HZ 20) only broadcasts. Both
// are individually guarded — this room never throws, whatever arrives on the
// wire.
//
// PHASE MACHINE (CONTRACT §4): lobby —[{t:'start'}]→ countdown (3s) → racing →
// results (8s) → lobby. Manual start only, any seated player, >= MIN_PLAYERS,
// silently ignored otherwise. NOTHING auto-starts. The seed is picked at
// countdown entry (settings {seed} override for dev/e2e, else rng(Date.now())),
// the slope regenerated and every seated player placed on the §4 start grid by
// slot — rematch = new mountain.
//
// LATE JOINERS (§4): joining mid-round seats you WAITING — splat_joined with
// the live phase, a parked `you.sim` at the gate, excluded from snapshot
// players[] and places. The next countdown entry turns every seated waiter
// into a racer on the grid.
//
// GHOSTS (§4): a socket drop keeps the seat (slot, sim, everything) with
// connected=false; the sim freezes where it was and NO player_left is sent
// until results. addPlayer with `resume` (then `sig`) rebinds the ghosted seat
// onto the new session — same slot, sim intact. Ghosts are swept at results.
//
// TIME DISCIPLINE: gameplay timers are SIM ms inside stepSki (snare, rearm,
// immunity, finishMs) — never touched here. Date.now() is used ONLY for phase
// timers (countdown/grace/hard-cap/results), the speedhack budget window and
// stale detection. Math.random is never used (rng from @platform/shared).
// ============================================================================
import {
  COUNTDOWN_MS,
  INPUT_QUEUE_CAP,
  INPUT_STALE_MS,
  MAX_INPUTS_PER_TICK,
  MAX_PLAYERS,
  MIN_PLAYERS,
  RACE_FIRST_FINISH_GRACE_MS,
  RACE_HARD_CAP_MS,
  RESULTS_MS,
  SIM_BUDGET_MUL,
  SLOPE_LENGTH,
  SNAPSHOT_HZ,
  START_PER_ROW,
  START_ROW_SPACING,
  TICK_HZ,
  parseSplatC2S,
} from '@splat/shared';
import type {
  Phase,
  RosterEntry,
  SkierSim,
  SlopeDef,
  SplatEvent,
  SplatInputMsg,
  SplatJoined,
} from '@splat/shared';
import { genSlope } from '@splat/shared/slope';
import { airHeight, makeSim, resetSim, resolveSkiPair, stepSki } from '@splat/shared/sim';
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
let roomSeq = 0; // mixes into rng seeds so same-ms rooms still differ

function randomToken(next: () => number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET.charAt(rngInt(next, 0, ROOM_ALPHABET.length - 1));
  return s;
}

/** §4 start grid: slot i -> row = floor(i/4), x = (i%4 - 1.5)*spacing, z = -row*spacing. */
function gridX(slot: number): number {
  return (slot % START_PER_ROW - 1.5) * START_ROW_SPACING;
}

function gridZ(slot: number): number {
  return -Math.floor(slot / START_PER_ROW) * START_ROW_SPACING;
}

// ---- pooled wire shapes ------------------------------------------------------
// The frozen wire interfaces in types.ts are readonly (they describe what a
// CLIENT may trust, not how the server builds them). The room mutates pooled
// objects in place — the kart pattern — so these structurally-identical
// mutable twins are what the pools hold. SkierSim itself is already mutable.

interface SkierSnapWire {
  id: string;
  slot: number;
  x: number;
  z: number;
  yaw: number;
  v: number;
  steer: number;
  airborne: boolean;
  airH: number;       // v2 server-computed air height above terrain (render)
  finished: boolean;
  finishMs: number;
  place: number;
}

interface YouWire {
  lastProcessedSeq: number;
  sim: SkierSim; // bound ONCE at seating; the sim mutates, the reference never changes
}

interface SnapshotWire {
  t: 'splat_snapshot';
  tick: number;
  serverTime: number;
  phase: Phase;
  seed: number;
  countdown: number;
  phaseEndsAt: number;
  playerCount: number;
  minPlayers: number;
  canStart: boolean;
  you: YouWire;
  players: SkierSnapWire[];
}

/**
 * Server-side player record, join order = Map insertion order. A socket drop
 * GHOSTS the entry (connected:false) instead of deleting it — slot, sim and
 * assist survive so a rejoin (resume, then sig) resumes exactly where the
 * skier stopped; an explicit leave deletes it outright. Ghost seats are swept
 * at results.
 */
interface Player {
  id: PlayerId;
  name: string;
  slot: number; // grid slot (lowest free at join); indexes SKIER_COLORS/GLYPHS
  lastStateAt: number; // serverTime ms of join / last valid message; stale sweep
  connected: boolean;
  sig: string | null; // durable browser signature; the rebind fallback after resume
  // `waiting` is the LATE JOINER flag: seated mid-round, parked at the gate,
  // excluded from snapshot players[]/places/contact until the next countdown
  // entry grids them (which clears it).
  waiting: boolean;
  assist: boolean; // splat_assist, any phase; fed to stepSki opts, NEVER broadcast
  // ---- authoritative simulation ----
  // `sim` IS the skier: nothing on the wire writes to it — only stepSki (from
  // consumed inputs) and resolveSkiPair (contact) do.
  sim: SkierSim;
  steer: number; // last consumed input's steer: a VISUAL channel (remote lean), not physics
  inputQueue: SplatInputMsg[]; // FIFO, capped at INPUT_QUEUE_CAP (oldest dropped)
  lastQueuedSeq: number; // monotonic gate applied at enqueue time
  lastProcessedSeq: number; // last seq actually consumed; echoed as you.lastProcessedSeq
  simWindow: number; // floor(now/1000) bucket the speedhack budget is charged in
  simUsed: number; // simulated seconds charged inside that bucket
  place: number; // 1-based; slot+1 outside racing/results
  // ---- persistent wire objects (allocated ONCE at seating, mutated per tick) ----
  snap: SkierSnapWire;
  you: YouWire;
  msg: SnapshotWire;
}

export class SplatRoom implements GameRoomHandle {
  readonly id: RoomId;
  readonly code: string | null;
  readonly visibility: Visibility;

  private readonly io: RoomIO;
  private readonly players = new Map<PlayerId, Player>(); // insertion order = join order
  // The ONE per-tick racer roster, shared by every recipient's snapshot.
  // Rebuilt in place each tick; never reallocated.
  private readonly snapPlayers: SkierSnapWire[] = [];
  // The ONE scratch Player[] — rebuilt in place for the pair loop and the
  // place sort; never reallocated.
  private readonly order: Player[] = [];

  private phase: Phase = 'lobby';
  private tickCount = 0; // snapshot sequence
  private phaseEndsAt = 0; // serverTime ms; 0 when no phase timer runs
  private countdown = 0; // 3..1 during countdown, else 0
  private countdownEndsAt = 0; // serverTime ms of the next countdown beat / GO
  private raceStartAt = 0; // serverTime ms of GO
  private raceEndsAt = 0; // serverTime ms; hard cap (RACE_HARD_CAP_MS after GO)
  private firstFinishAt: number | null = null; // serverTime ms of the first finisher (grace clock)
  private readonly finishOrder: PlayerId[] = []; // emptied in place at countdown entry
  private seed = -1; // current slope seed; -1 = no race yet
  private slope: SlopeDef | null = null; // null until the first countdown entry
  private simTimer: ReturnType<typeof setInterval> | null = null;
  private snapTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    visibility: Visibility,
    io: RoomIO,
    // dev/e2e slope override from room settings {seed}; null = pick per race
    private readonly seedOverride: number | null = null,
  ) {
    this.visibility = visibility;
    this.io = io;
    // server-side generation (room id, private code) uses rng(Date.now())
    const next = rng((Date.now() ^ (roomSeq++ * 0x9e3779b9)) >>> 0);
    this.id = randomToken(next, 8);
    this.code = visibility === 'private' ? randomToken(next, PRIVATE_CODE_LEN) : null;
  }

  info(): RoomInfo {
    return {
      id: this.id,
      code: this.code,
      game: 'splat',
      label: `${SLOPE_LENGTH} m downhill`,
      players: this.playerCount(),
      maxPlayers: MAX_PLAYERS,
      phase: this.phase,
      visibility: this.visibility,
    };
  }

  /**
   * CONNECTED players only — a ghost (dropped socket, seat kept for rejoin)
   * must never count as "here": it keeps the lobby's "2/8" honest and
   * MIN_PLAYERS gating from being fooled by a skier who is not coming back.
   */
  playerCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  /** Every seated row, ghosts included — the SLOT census (a ghost still owns
   *  its grid slot, so this is what the room_full guard must check). */
  private seatedCount(): number {
    return this.players.size;
  }

  /**
   * Connected players with no valid message for INPUT_STALE_MS. A ghost's
   * lastStateAt stops moving the instant it ghosts, so without the connected
   * guard it would look PERMANENTLY stale and the platform would try to evict
   * an already-gone connection forever — a ghost is never returned here.
   */
  stalePlayers(): PlayerId[] {
    const now = Date.now();
    const out: PlayerId[] = [];
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      if (now - p.lastStateAt > INPUT_STALE_MS) out.push(p.id);
    }
    return out;
  }

  /**
   * Seat a joiner:
   *   1. `id` itself already has a row -> same-session re-add: refresh only.
   *   2. else `resume` names a ghost's playerId -> rebind onto the new id.
   *   3. else `sig` matches a ghost's stored signature -> rebind (fallback).
   *   4. else -> a genuinely new skier: fresh seat, gated on the SEATED cap.
   * A fresh seat taken mid-round (phase !== 'lobby') is a LATE JOINER: parked
   * at the gate (waiting), excluded from the race until the next countdown.
   * Only case 4 can grow the roster, so it is the only capacity check.
   */
  addPlayer(id: PlayerId, name: string, resume?: PlayerId, sig?: string): void {
    try {
      const now = Date.now();
      const existing = this.players.get(id);
      if (existing !== undefined) {
        existing.name = name;
        existing.lastStateAt = now;
        existing.connected = true;
        if (sig !== undefined) existing.sig = sig;
      } else {
        const ghost = this.findGhost(resume, sig);
        if (ghost !== null) {
          this.rebind(ghost, id, name, sig, now);
        } else {
          if (this.seatedCount() >= MAX_PLAYERS) {
            // unreachable via the lobby (it guards room_full first); never throws
            this.io.send(id, { t: 'error', code: 'room_full', message: 'room is full' });
            return;
          }
          this.players.set(id, this.freshPlayer(id, name, now, sig ?? null));
        }
      }
      // NO AUTO-START (frozen lobby contract): joining never begins a race.
      const p = this.players.get(id);
      if (p === undefined) return;
      this.io.send(id, this.joinedFor(p, now));
      this.broadcastRoster();
    } catch (err) {
      console.error('[splat] addPlayer failed', err);
    }
  }

  /** A disconnected seat matching `resume` (exact playerId) or, failing that, `sig`. */
  private findGhost(resume: PlayerId | undefined, sig: string | undefined): Player | null {
    if (resume !== undefined) {
      const byResume = this.players.get(resume);
      if (byResume !== undefined && !byResume.connected) return byResume;
    }
    if (sig !== undefined) {
      for (const p of this.players.values()) {
        if (!p.connected && p.sig === sig) return p;
      }
    }
    return null;
  }

  /**
   * Re-key a ghosted seat onto a new playerId — slot, sim, assist, queue
   * watermarks, everything stays; only the id moves. The wire roster entry
   * (snap.id) follows the seat, not the old socket.
   */
  private rebind(ghost: Player, newId: PlayerId, name: string, sig: string | undefined, now: number): void {
    this.players.delete(ghost.id);
    ghost.id = newId;
    ghost.name = name;
    ghost.connected = true;
    ghost.lastStateAt = now;
    if (sig !== undefined) ghost.sig = sig;
    ghost.snap.id = newId;
    this.players.set(newId, ghost);
  }

  /**
   * A socket drop GHOSTS the seat (connected:false, everything else kept, NO
   * player_left until results) so a rejoin resumes the SAME race; an explicit
   * leave (`permanent`) deletes it outright and rosters immediately.
   */
  removePlayer(id: PlayerId, permanent?: boolean): void {
    try {
      const p = this.players.get(id);
      if (p === undefined) return;
      if (permanent === true) {
        this.players.delete(id);
      } else {
        // Ghost it. The input queue is cleared and tickPlayer refuses to step a
        // disconnected seat, so the ghost's skier freezes on the spot — and the
        // pair loop / place computation skip it too (rebuildOrder).
        p.connected = false;
        p.inputQueue.length = 0;
      }
      this.broadcastRoster(); // roster on every join/leave (content may be unchanged for a ghost)
      const now = Date.now();
      const n = this.playerCount(); // CONNECTED count: a ghost never props this up
      if (n === 0 && this.phase !== 'lobby') {
        this.resetToLobby(); // nobody left to show the race/results to
      } else if (this.phase === 'countdown' && n < MIN_PLAYERS) {
        // low pop before GO: cancel back to the lobby
        this.phase = 'lobby';
        this.phaseEndsAt = 0;
        this.countdown = 0;
      } else if (this.phase === 'racing' && this.allFinished()) {
        // the leaver was the last one still out: race over for the rest
        this.enterResults(now);
      }
      // low pop mid-race (n >= 1): the race RUNS ON for the remaining skiers
    } catch (err) {
      console.error('[splat] removePlayer failed', err);
    }
  }

  /**
   * Wire ingress ONLY — it never simulates. Every message goes through
   * parseSplatC2S (total, clamping; null = silently dropped), an input is
   * gated on the per-client monotonic seq and QUEUED; the sim tick is the
   * single place a skier moves, so message timing/bursting cannot buy a player
   * extra motion. `splat_assist` is stored per player at ANY phase and never
   * broadcast (invisible to others).
   */
  handleMessage(id: PlayerId, msg: unknown): void {
    try {
      const parsed = parseSplatC2S(msg);
      if (parsed === null) return;
      const p = this.players.get(id);
      if (p === undefined) return;
      if (!p.connected) return; // a ghost takes no input, ever
      p.lastStateAt = Date.now(); // any valid message is liveness
      if (parsed.t === 'start') {
        this.tryStart();
        return;
      }
      if (parsed.t === 'splat_assist') {
        p.assist = parsed.on;
        return;
      }
      if (parsed.seq <= p.lastQueuedSeq) return; // per-client monotonic: drop late dupes
      p.lastQueuedSeq = parsed.seq;
      if (p.inputQueue.length >= INPUT_QUEUE_CAP) p.inputQueue.shift(); // oldest dropped
      p.inputQueue.push(parsed);
    } catch (err) {
      console.error('[splat] handleMessage failed', err);
    }
  }

  start(): void {
    this.stopped = false; // idempotent
    if (this.simTimer === null) {
      this.simTimer = setInterval(() => this.simTick(), 1000 / TICK_HZ);
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
  // Sim tick (TICK_HZ): phase machine, input consumption + integration,
  // skier-vs-skier contact, places. Never throws.
  // -------------------------------------------------------------------------

  private simTick(): void {
    if (this.stopped) return;
    try {
      const now = Date.now();
      switch (this.phase) {
        case 'countdown':
          if (now >= this.countdownEndsAt) this.advanceCountdown(now);
          break;
        case 'racing':
          // Race end: hard cap, or the grace window after the first finisher.
          // (all-finished is handled below, right after integration.)
          if (now >= this.raceEndsAt) {
            this.enterResults(now);
          } else if (
            this.firstFinishAt !== null &&
            now >= this.firstFinishAt + RACE_FIRST_FINISH_GRACE_MS
          ) {
            this.enterResults(now);
          }
          break;
        case 'results':
          if (now >= this.phaseEndsAt) this.resetToLobby();
          break;
        case 'lobby':
          break;
      }
      // integrate in join order, then resolve every contact ONCE over the
      // post-step positions (order-independent, unlike per-player resolution)
      for (const p of this.players.values()) this.tickPlayer(p, now);
      if (this.phase === 'racing') {
        this.resolveContacts();
        this.updatePlaces();
        if (this.allFinished()) this.enterResults(now);
      }
    } catch (err) {
      console.error('[splat] simTick failed', err);
    }
  }

  /** Snapshot tick (SNAPSHOT_HZ): broadcast only, no simulation. Never throws. */
  private snapshotTick(): void {
    if (this.stopped) return;
    try {
      this.tickCount++;
      this.broadcastSnapshot(Date.now());
    } catch (err) {
      console.error('[splat] snapshotTick failed', err);
    }
  }

  /**
   * Consume this player's queued inputs (FIFO, at most MAX_INPUTS_PER_TICK)
   * and integrate them through stepSki.
   *
   * SPEEDHACK BUDGET: simulated time is charged into a 1-second wall-clock
   * bucket and capped at SIM_BUDGET_MUL seconds of ski time per real second.
   * An honest client sending TICK_HZ inputs of SIM_DT each sits at exactly 1.0
   * and never trips it; the headroom absorbs jitter/catch-up. Over budget the
   * remaining inputs simply stay QUEUED (and unacknowledged) — a rate limit,
   * not a kick.
   *
   * Outside racing (and for WAITING late joiners) inputs are still consumed
   * and ACKED but NOT integrated: the pre-GO grid freeze holds while the
   * client's replay queue still drains instead of growing to its cap.
   *
   * PLANT-HIT DETECTION (sim.ts header convention): a hit is the only writer
   * of the (lastPlantIx, lastPlantHitMs) pair — a diff between steps means a
   * new hit, and the room emits `splat_event plant_hit` with the sim's fresh
   * position. GATE DETECTION is the same pattern on (lastGateIx,
   * boostUntilMs): an advance WITH a boostUntilMs change is a clean pass
   * (`splat_event gate`); an advance alone is a miss and emits NOTHING (a
   * missed gate is gone — no circling back). Finishing is detected the same
   * way on `finished`.
   */
  private tickPlayer(p: Player, now: number): void {
    if (!p.connected) return; // ghost: frozen, never simulated as an active racer
    const q = p.inputQueue;
    if (q.length === 0) return;
    const win = Math.floor(now / 1000);
    if (p.simWindow !== win) {
      p.simWindow = win;
      p.simUsed = 0;
    }
    const racing = this.phase === 'racing' && !p.waiting && this.slope !== null;
    const slope = this.slope;
    const max = Math.min(q.length, MAX_INPUTS_PER_TICK);
    let n = 0;
    for (; n < max; n++) {
      const inp = q[n];
      if (inp === undefined) break;
      // budget is charged only for inputs that actually integrate
      if (racing && p.simUsed + inp.dt > SIM_BUDGET_MUL) break;
      p.lastProcessedSeq = inp.seq;
      if (racing && slope !== null) {
        // steer is a VISUAL channel (remote lean), but it is still client-
        // supplied, so it obeys the pre-GO freeze like everything else.
        p.steer = inp.steer;
        const prevPlantIx = p.sim.lastPlantIx;
        const prevPlantHitMs = p.sim.lastPlantHitMs;
        const prevGateIx = p.sim.lastGateIx;
        const prevBoostUntilMs = p.sim.boostUntilMs;
        const prevFinished = p.sim.finished;
        stepSki(p.sim, inp.steer, inp.dt, slope, { assist: p.assist, jump: inp.jump === true });
        p.simUsed += inp.dt;
        if (p.sim.lastPlantIx !== prevPlantIx || p.sim.lastPlantHitMs !== prevPlantHitMs) {
          this.broadcastEvent({
            t: 'plant_hit',
            id: p.id,
            plantIx: p.sim.lastPlantIx,
            x: p.sim.x,
            z: p.sim.z,
          });
        }
        // Gate diff (sim.ts header convention): lastGateIx advancing WITH a
        // boostUntilMs change is a clean pass; advancing alone is a miss and
        // emits nothing.
        if (p.sim.lastGateIx !== prevGateIx && p.sim.boostUntilMs !== prevBoostUntilMs) {
          this.broadcastEvent({
            t: 'gate',
            id: p.id,
            gateIx: p.sim.lastGateIx,
            x: p.sim.x,
            z: p.sim.z,
          });
        }
        if (!prevFinished && p.sim.finished) this.onFinished(p, now);
      }
    }
    if (n >= q.length) q.length = 0;
    else if (n > 0) {
      q.copyWithin(0, n);
      q.length -= n;
    }
  }

  /**
   * A skier crossed the line: classify them (finishOrder IS the finish
   * classification, so a place is never awarded twice), start the grace clock
   * if they are first, and broadcast `splat_event finished`.
   */
  private onFinished(p: Player, now: number): void {
    let place = this.finishOrder.indexOf(p.id) + 1; // 0 => not classified yet
    if (place === 0) {
      this.finishOrder.push(p.id);
      place = this.finishOrder.length;
    }
    if (this.firstFinishAt === null) this.firstFinishAt = now;
    this.broadcastEvent({ t: 'finished', id: p.id, place, finishMs: p.sim.finishMs });
  }

  /**
   * Skier-vs-skier contact for the WHOLE room, resolved once per sim tick
   * after every skier has stepped. Each unordered pair is resolved exactly
   * once, so both skiers get the same overlap split — a soft nudge, momentum
   * kept, never a disable. Connected racers only: a ghost cannot shove or be
   * shoved, and a parked late joiner is not on the hill.
   */
  private resolveContacts(): void {
    const list = this.rebuildOrder();
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b === undefined) continue;
        resolveSkiPair(a.sim, b.sim);
      }
    }
  }

  /**
   * The shared scratch roster, refilled in place (never reallocated).
   * CONNECTED RACERS only: feeds both contact resolution and place
   * computation — a ghost does neither (its place stays frozen at whatever it
   * was) and a waiting late joiner is not racing yet.
   */
  private rebuildOrder(): Player[] {
    const list = this.order;
    list.length = 0;
    for (const p of this.players.values()) {
      if (p.connected && !p.waiting) list.push(p);
    }
    return list;
  }

  // -------------------------------------------------------------------------
  // Phase machine
  // -------------------------------------------------------------------------

  /**
   * The ONE way out of 'lobby' (frozen lobby contract). Any seated player may
   * send `{t:'start'}` — there is no host. Accepted only in 'lobby' with at
   * least MIN_PLAYERS connected; every other case is silently ignored, so a
   * spammed or mistimed start is a no-op rather than an error.
   */
  private tryStart(): void {
    if (this.phase !== 'lobby') return;
    if (this.playerCount() < MIN_PLAYERS) return;
    this.enterCountdown(Date.now());
  }

  /** True while a `{t:'start'}` would be accepted (mirrored onto every snapshot). */
  private canStart(): boolean {
    return this.phase === 'lobby' && this.playerCount() >= MIN_PLAYERS;
  }

  /**
   * Countdown entry — the round's RESET POINT (§4): pick the seed (settings
   * {seed} override, else rng(Date.now())), regenerate the slope, and grid
   * every seated player by slot. This is also where WAITING late joiners
   * become racers. The pre-race input backlog is DROPPED but ACKED — dropping
   * alone would leave those seqs pending in the client's replay queue forever,
   * acking alone would let them apply after GO. Ghosts are not re-gridded for
   * a race they are not in.
   */
  private enterCountdown(now: number): void {
    this.seed =
      this.seedOverride ?? rngInt(rng((Date.now() ^ (roomSeq++ * 0x9e3779b9)) >>> 0), 1, 0x7fffffff);
    this.slope = genSlope(this.seed);
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      p.waiting = false; // a parked late joiner becomes a racer HERE
      resetSim(p.sim, gridX(p.slot), gridZ(p.slot), 0);
      p.steer = 0;
      p.inputQueue.length = 0;
      p.lastProcessedSeq = Math.max(p.lastProcessedSeq, p.lastQueuedSeq);
      p.simWindow = 0;
      p.simUsed = 0;
      p.place = p.slot + 1;
    }
    this.finishOrder.length = 0;
    this.firstFinishAt = null;
    this.phase = 'countdown';
    this.countdown = 3;
    this.countdownEndsAt = now + 1000;
    this.phaseEndsAt = now + COUNTDOWN_MS; // GO time for the HUD clock
  }

  /** 3 → 2 → 1 at 1s beats, then GO. */
  private advanceCountdown(now: number): void {
    this.countdown--;
    if (this.countdown <= 0) {
      this.go(now);
      return;
    }
    this.countdownEndsAt += 1000;
  }

  /** Race start: everyone gridded at countdown entry descends together. */
  private go(now: number): void {
    this.phase = 'racing';
    this.countdown = 0;
    this.raceStartAt = now;
    this.raceEndsAt = now + RACE_HARD_CAP_MS;
    this.phaseEndsAt = this.raceEndsAt;
    this.updatePlaces();
  }

  /**
   * Results entry — also the GHOST SWEEP (§4): the race the ghosts were in
   * just ended, so their seats are removed and player_left is finally
   * broadcast for each (until now a disconnect was invisible on the wire).
   */
  private enterResults(now: number): void {
    this.phase = 'results';
    this.phaseEndsAt = now + RESULTS_MS;
    this.sweepGhosts();
  }

  /**
   * Results -> lobby: players stay seated (positions kept for the results
   * screen; the next countdown entry re-grids them), the seed/slope stay put
   * (the mountain does not change until the next race), and the room WAITS —
   * the next race needs another explicit `{t:'start'}`.
   */
  private resetToLobby(): void {
    this.sweepGhosts(); // seats ghosted during the results window go too
    this.finishOrder.length = 0;
    this.firstFinishAt = null;
    this.raceStartAt = 0;
    this.raceEndsAt = 0;
    this.phase = 'lobby';
    this.phaseEndsAt = 0;
    this.countdown = 0;
  }

  /** Delete every ghosted seat, broadcasting player_left + a roster refresh
   *  if anything changed. Idempotent. */
  private sweepGhosts(): void {
    let swept = false;
    for (const [id, p] of this.players) {
      if (p.connected) continue;
      this.players.delete(id);
      this.broadcastEvent({ t: 'player_left', id });
      swept = true;
    }
    if (swept) this.broadcastRoster();
  }

  /**
   * Every CONNECTED RACER has finished (and at least one exists). A ghost is
   * skipped entirely — its `finished` flag is frozen at whatever it was when
   * it dropped and must never be required to become true, or a race with one
   * ghost who never finishes would never end. Waiting late joiners are not
   * racers and are skipped too.
   */
  private allFinished(): boolean {
    let any = false;
    for (const p of this.players.values()) {
      if (!p.connected || p.waiting) continue;
      any = true;
      if (!p.sim.finished) return false;
    }
    return any;
  }

  /**
   * Race position (§5): finished players first by finishMs (their order is
   * final), then racing players by z desc; ties by slot asc. Sorts the shared
   * scratch array in place — runs at TICK_HZ, so it may not allocate.
   */
  private updatePlaces(): void {
    const order = this.rebuildOrder();
    order.sort(this.placeCmp); // hoisted: a fresh comparator closure per call
    // was the one remaining allocation in a 30Hz tick
    for (let i = 0; i < order.length; i++) {
      const p = order[i];
      if (p !== undefined) p.place = i + 1;
    }
  }

  /** Place order, allocated once, not per sort. */
  private readonly placeCmp = (a: Player, b: Player): number => {
    if (a.sim.finished && b.sim.finished) return a.sim.finishMs - b.sim.finishMs;
    if (a.sim.finished !== b.sim.finished) return a.sim.finished ? -1 : 1;
    if (a.sim.z !== b.sim.z) return b.sim.z - a.sim.z;
    return a.slot - b.slot;
  };

  // -------------------------------------------------------------------------
  // Player records / wire
  // -------------------------------------------------------------------------

  /**
   * Fresh entry. The sim is PARKED AT THE GATE on the player's slot grid
   * position: for a lobby joiner it is simply pre-grid state (the countdown
   * entry re-grids anyway); for a mid-round late joiner it IS the §4 parked
   * `you.sim` at the gate, and `waiting` stays true until the next countdown.
   */
  private freshPlayer(id: PlayerId, name: string, now: number, sig: string | null): Player {
    const slot = this.lowestFreeSlot();
    const sim = makeSim(gridX(slot), gridZ(slot), 0);
    const snap: SkierSnapWire = {
      id,
      slot,
      x: sim.x,
      z: sim.z,
      yaw: sim.yaw,
      v: sim.v,
      steer: 0,
      airborne: false,
      airH: 0,
      finished: false,
      finishMs: 0,
      place: slot + 1,
    };
    const you: YouWire = {
      lastProcessedSeq: -1,
      sim, // bound ONCE: the sim mutates in place, the reference never changes
    };
    return {
      id,
      name,
      slot,
      lastStateAt: now,
      connected: true,
      sig,
      waiting: this.phase !== 'lobby', // mid-round joiner: parked until next countdown
      assist: false,
      sim,
      steer: 0,
      inputQueue: [],
      lastQueuedSeq: -1,
      lastProcessedSeq: -1,
      simWindow: 0,
      simUsed: 0,
      place: slot + 1, // grid order until places are computed at GO
      snap,
      you,
      msg: {
        t: 'splat_snapshot',
        tick: 0,
        serverTime: now,
        phase: this.phase,
        seed: this.seed,
        countdown: 0,
        phaseEndsAt: 0,
        playerCount: this.playerCount(),
        minPlayers: MIN_PLAYERS,
        canStart: this.canStart(),
        you, // same object: broadcastSnapshot mutates it, never replaces it
        players: this.snapPlayers,
      },
    };
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
   * splat_joined payload: the full seated roster (ghosts included — the row
   * is still theirs), joiner included, with the LIVE phase and seed (a late
   * joiner gets the running race's seed so it can build the same mountain;
   * -1 when no race has happened yet). Fresh object per join — joins are
   * rare, pooling would buy nothing.
   */
  private joinedFor(you: Player, now: number): SplatJoined {
    return {
      t: 'splat_joined',
      code: this.code, // private-room invite code (null for public)
      you: you.id,
      slot: you.slot,
      phase: this.phase,
      seed: this.seed,
      serverTime: now,
      players: this.rosterList(),
    };
  }

  private rosterList(): RosterEntry[] {
    const players: RosterEntry[] = [];
    for (const p of this.players.values()) {
      players.push({ id: p.id, name: p.name, slot: p.slot });
    }
    return players;
  }

  /** Full roster refresh on any join/leave (ghosts keep their row). */
  private broadcastRoster(): void {
    const msg = { t: 'splat_roster', players: this.rosterList() };
    for (const p of this.players.values()) {
      if (p.connected) this.io.send(p.id, msg);
    }
  }

  /**
   * The per-tick racer roster — IDENTICAL for every recipient, so it is built
   * ONCE per tick into the shared `snapPlayers` array and each player's
   * persistent `snap` object is mutated in place. RACERS ONLY: waiting late
   * joiners are excluded until the next countdown (§5); ghost racers stay in
   * (their frozen last state is exactly what §4 promises) but receive nothing
   * (the send loop skips them). Nothing here is allocated per tick.
   */
  private buildSnapPlayers(): SkierSnapWire[] {
    const list = this.snapPlayers;
    list.length = 0;
    for (const p of this.players.values()) {
      if (p.waiting) continue;
      const s = p.snap;
      const k = p.sim; // the authoritative skier: nothing else writes these
      s.id = p.id;
      s.slot = p.slot;
      s.x = k.x;
      s.z = k.z;
      s.yaw = k.yaw;
      s.v = k.v;
      s.steer = p.steer;
      s.airborne = k.airborne;
      s.airH = this.slope !== null ? airHeight(k, k.x, k.z, this.slope) : 0;
      s.finished = k.finished;
      s.finishMs = k.finishMs;
      s.place = p.place;
      list.push(s);
    }
    return list;
  }

  /**
   * One shared roster + a per-recipient `you` block. Wire objects are pooled
   * and mutated in place (safe: Session.send JSON-encodes synchronously, so
   * no recipient can observe a later tick's values). `you.sim` is NOT assigned
   * here: it is bound to the player's live SkierSim once at seating. Ghosts
   * are skipped — their socket is gone; io.send would be a no-op anyway.
   */
  private broadcastSnapshot(now: number): void {
    const list = this.buildSnapPlayers();
    const count = this.playerCount();
    const canStart = this.canStart();
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      p.you.lastProcessedSeq = p.lastProcessedSeq;
      const m = p.msg;
      m.tick = this.tickCount;
      m.serverTime = now;
      m.phase = this.phase;
      m.seed = this.seed;
      m.countdown = this.countdown;
      m.phaseEndsAt = this.phaseEndsAt;
      m.playerCount = count;
      m.minPlayers = MIN_PLAYERS;
      m.canStart = canStart;
      m.players = list;
      this.io.send(p.id, m);
    }
  }

  /** One shared message object per event (events are rare; no pooling needed).
   *  Connected players only — a ghost's socket is gone. */
  private broadcastEvent(ev: SplatEvent): void {
    const msg = { t: 'splat_event', ev };
    for (const p of this.players.values()) {
      if (p.connected) this.io.send(p.id, msg);
    }
  }
}
