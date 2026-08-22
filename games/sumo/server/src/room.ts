// ============================================================================
// SUMO room — the SERVER-AUTHORITATIVE arena (specs/P10.md). One 30Hz tick
// owns everything: phase machine, bot brains, input consumption, the shared
// sim (sim.ts), KO attribution, stats and the per-tick snapshot broadcast.
//
// The wire carries INTENT ONLY (`{t:'input',seq,mx,mz,bits}`): no message a
// client can send names a coordinate. Inputs are LATEST-WINS — axes are
// absolute, so a newer frame simply replaces an older one and a flood past
// the 30Hz cadence buys nothing; the per-client monotonic `seq` gates replays
// and is echoed as you.ack. Phone pads deliver `{t:'pad_input'}` under the
// PAD session's own id; the room resolves the owning seat via io.padOwner()
// and applies that frame to the owner every tick (sticky stick, pad wins over
// keyboard while bound).
//
// Rounds: warmup -> countdown(3s) -> live(45s shrink) -> results(4s) -> …
// Last player standing takes the round; timer expiry hands it to the most
// centered survivor; nobody alive = draw. First to WINS_TO_MATCH round wins
// takes the match, then wins reset and play continues. No respawns: a fallen
// player watches until the next round. Bots fill to >= MIN_PLAYERS whenever
// at least one human is seated (spec: "bots fill to >=2 when alone").
//
// Stats (v2 proof): every KO credits {'sumo.ko':1} to the last pusher within
// PUSHER_WINDOW_MS (else {'sumo.self':1} to the victim); each round win pays
// {'sumo.win':1}. Anonymous players/bots no-op inside the platform sink.
//
// Simplicity vs KART: rounds are seconds long and respawn-free, so a socket
// drop DELETES the seat outright instead of ghosting it (contract-compliant:
// rebind via resume/sig is optional), and there is no explicit start verb —
// the room auto-runs whenever MIN_PLAYERS are seated.
//
// Never throws on any wire input; timers are injectable for tests.
// ============================================================================
import {
  COUNTDOWN_S,
  INPUT_STALE_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLATFORM_R_START,
  PUSHER_WINDOW_MS,
  RESULTS_S,
  ROUND_SHRINK_S,
  SIM_DT,
  SIM_HZ,
  SUMO_COLORS,
  WINS_TO_MATCH,
  parseSumoC2S,
  padFrameToInput,
} from '@sumo/shared';
import type { SumoEvent, SumoPhase, SumoPlayerSnap, SumoSnapMsg, SumoWinRow } from '@sumo/shared';
import { rng, rngRange } from '@platform/shared';
import type { GameRoomHandle, PlayerId, RoomId, RoomInfo, RoomIO, Visibility } from '@platform/shared';
import {
  decideRound,
  hasFallenOut,
  makeBody,
  platformRadiusAt,
  pusherIsA,
  resolvePair,
  stepBody,
} from './sim.js';
import type { AliveStanding, SumoBody } from './sim.js';

const ROOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PRIVATE_CODE_LEN = 5;
let roomSeq = 0; // mixes into the rng seed so same-ms rooms still differ

/** Latest-wins intent frame from either transport (kb or pad). */
interface Intent {
  mx: number;
  mz: number;
  bits: number;
  seq: number;
}

/** Bot steering state (bots never touch the wire). */
interface BotBrain {
  tx: number; // wander target
  tz: number;
  retargetAt: number; // epoch ms
  dashHoldTicks: number;
  jumpHoldTicks: number;
}

/**
 * Server-side player record. Bots sit in the same map with the same wire
 * objects — they ARE seats (they count toward RoomInfo, they can win rounds);
 * they just synthesize their intent locally.
 */
interface Player {
  id: PlayerId;
  name: string;
  slot: number; // lowest free seat at join; drives color + spawn order
  colorIdx: number;
  bot: boolean;
  body: SumoBody;
  alive: boolean;
  wins: number;
  // ---- inputs ----
  kbIntent: Intent | null; // latest direct client frame
  padIntent: Intent | null; // latest phone-pad frame for this seat (sticky)
  lastQueuedSeq: number; // monotonic gate on direct inputs
  ack: number; // last consumed seq, echoed as you.ack
  lastInputAt: number; // epoch ms of any valid input (stale sweep)
  // ---- KO attribution ----
  lastPusherId: PlayerId | null;
  lastPusherAt: number;
  brain: BotBrain | null; // bots only
  // ---- persistent wire objects (allocated ONCE at join, mutated in place) --
  snap: SumoPlayerSnap;
  you: SumoSnapMsg['you'];
  msg: SumoSnapMsg;
}

function randomToken(next: () => number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET.charAt(Math.floor(next() * ROOM_ALPHABET.length) % ROOM_ALPHABET.length);
  return s;
}

const BOT_NAMES = ['Tumbleweed', 'Pushkin', 'Wobbles', 'Slammer', 'Boulderon', 'YoYo', 'Bigfoot', 'Nudger'];

export class SumoRoom implements GameRoomHandle {
  readonly id: RoomId;
  readonly code: string | null;
  private readonly visibility: Visibility;
  private readonly io: RoomIO;
  private readonly clock: () => number;
  private readonly rand: () => number;

  private readonly players = new Map<PlayerId, Player>();
  // ONE shared roster/wins/events set, bound into every snapshot object once
  // (kart precedent: Session.send JSON-encodes synchronously, so mutating in
  // place between sends is invisible to recipients).
  private readonly snapPlayers: SumoPlayerSnap[] = [];
  private readonly snapWins: SumoWinRow[] = [];
  private readonly events: SumoEvent[] = [];

  private phase: SumoPhase = 'warmup';
  private phaseEndsAt = 0; // epoch ms; 0 when no timer runs (warmup)
  private roundStartAt = 0; // epoch ms of 'live' entry (shrink clock)
  private radius = PLATFORM_R_START;
  private round = 0; // incremented at every countdown entry
  private matchOver = false; // someone hit WINS_TO_MATCH; wins reset at results end
  private tickCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    visibility: Visibility,
    io: RoomIO,
    /** Additive test seam: virtual clock (Loop-style). Defaults to Date.now(). */
    clock: () => number = Date.now,
  ) {
    this.visibility = visibility;
    this.io = io;
    this.clock = clock;
    const next = rng((Date.now() ^ (roomSeq++ * 0x9e3779b9)) >>> 0);
    this.rand = next;
    this.id = randomToken(next, 8);
    this.code = visibility === 'private' ? randomToken(next, PRIVATE_CODE_LEN) : null;
  }

  // -------------------------------------------------------------------------
  // GameRoomHandle
  // -------------------------------------------------------------------------

  info(): RoomInfo {
    return {
      id: this.id,
      code: this.code,
      game: 'sumo',
      label:
        this.phase === 'warmup'
          ? `first to ${WINS_TO_MATCH} — waiting for sumoists`
          : `round ${this.round} · first to ${WINS_TO_MATCH}`,
      players: this.playerCount(),
      maxPlayers: MAX_PLAYERS,
      phase: this.phase,
      visibility: this.visibility,
    };
  }

  /** Every row here is live (no ghosts — see header note). Bots count. */
  playerCount(): number {
    return this.players.size;
  }

  stalePlayers(): PlayerId[] {
    const now = this.clock();
    const out: PlayerId[] = [];
    for (const p of this.players.values()) {
      if (p.bot) continue; // bots never go stale
      if (now - p.lastInputAt > INPUT_STALE_MS) out.push(p.id);
    }
    return out;
  }

  addPlayer(id: PlayerId, name: string, _resume?: PlayerId, _sig?: string): void {
    try {
      const now = this.clock();
      const existing = this.players.get(id);
      if (existing !== undefined) {
        existing.name = name; // same-session re-add: refresh + keep everything
        existing.lastInputAt = now;
        this.ensureBotFill();
        return;
      }
      if (this.players.size >= MAX_PLAYERS) {
        // unreachable via the lobby (it guards room_full first); never throw
        this.io.send(id, { t: 'error', code: 'room_full', message: 'room is full' });
        return;
      }
      const p = this.freshPlayer(id, name, now);
      this.players.set(id, p);
      this.ensureBotFill();
      this.io.send(id, this.joinedFor(p));
    } catch (err) {
      console.error('[sumo] addPlayer failed', err);
    }
  }

  /**
   * Both paths delete the seat outright (see header: short respawn-free
   * rounds make ghosting pure overhead). A mid-round deletion simply shrinks
   * the alive census on the next tick's end-check.
   */
  removePlayer(id: PlayerId, _permanent?: boolean): void {
    try {
      const p = this.players.get(id);
      if (p === undefined) return;
      this.players.delete(id);
      if (this.playerCount() === 0) {
        this.resetToWarmup();
        return;
      }
      if ((this.phase === 'countdown' || this.phase === 'live') && this.aliveCount() <= 1) {
        this.endRound(this.clock());
        return;
      }
      if (this.phase === 'countdown' && this.playerCount() < MIN_PLAYERS) {
        this.resetToWarmup(); // not enough left to race — back to warmup
        return;
      }
      // A departed seat must not leave the bots understaffed mid-round when a
      // human remains; refill happens only outside live phases.
      if (this.phase !== 'live') this.ensureBotFill();
    } catch (err) {
      console.error('[sumo] removePlayer failed', err);
    }
  }

  /**
   * Wire ingress ONLY — never simulates. Direct inputs land under the
   * player's own id; pad_input arrives under the PAD session's id and is
   * resolved to the owning seat through io.padOwner().
   */
  handleMessage(id: PlayerId, msg: unknown): void {
    try {
      const parsed = parseSumoC2S(msg);
      if (parsed !== null) {
        const p = this.players.get(id);
        if (p === undefined || p.bot) return; // bots ignore the wire
        p.lastInputAt = this.clock(); // any valid message is liveness
        if (parsed.t === 'debug_bot') {
          this.addBot();
          return;
        }
        if (parsed.seq <= p.lastQueuedSeq) return; // monotonic gate: late dupes die
        p.lastQueuedSeq = parsed.seq;
        p.kbIntent = { mx: parsed.mx, mz: parsed.mz, bits: parsed.bits, seq: parsed.seq };
        return;
      }
      // The lobby parses pad_input before routing; validate again anyway.
      if (typeof msg !== 'object' || msg === null) return;
      const raw = msg as Record<string, unknown>;
      if (raw.t !== 'pad_input') return;
      const owner = this.io.padOwner?.(id) ?? null; // optional v2 member
      if (owner === null) return;
      const p = this.players.get(owner);
      if (p === undefined || p.bot) return;
      const frame = padFrameToInput(raw as Parameters<typeof padFrameToInput>[0]);
      if (frame === null) return;
      p.lastInputAt = this.clock();
      p.padIntent = { mx: frame.mx, mz: frame.mz, bits: frame.bits, seq: frame.seq };
    } catch (err) {
      console.error('[sumo] handleMessage failed', err);
    }
  }

  start(): void {
    this.stopped = false; // idempotent
    if (this.timer === null) {
      this.timer = setInterval(() => this.tickOnce(), 1000 / SIM_HZ);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Tick — the whole game. Public so tests can drive it with a virtual clock.
  // -------------------------------------------------------------------------

  tickOnce(): void {
    if (this.stopped) return;
    try {
      const now = this.clock();
      switch (this.phase) {
        case 'warmup':
          this.ensureBotFill();
          if (this.playerCount() >= MIN_PLAYERS) this.enterCountdown(now);
          break;
        case 'countdown':
          if (now >= this.phaseEndsAt) this.goLive(now);
          break;
        case 'live':
          this.stepWorld(now);
          if (this.phase === 'live' && now >= this.phaseEndsAt) this.endRound(now); // timeout
          break;
        case 'results':
          if (now >= this.phaseEndsAt) this.afterResults(now);
          break;
      }
      this.broadcastSnapshot(now);
    } catch (err) {
      console.error('[sumo] tick failed', err);
    }
  }

  // -------------------------------------------------------------------------
  // Phase machine
  // -------------------------------------------------------------------------

  private enterCountdown(now: number): void {
    this.phase = 'countdown';
    this.round += 1;
    this.phaseEndsAt = now + COUNTDOWN_S * 1000;
    this.spawnAll();
    this.pushEvent({ kind: 'countdown', n: COUNTDOWN_S });
  }

  private goLive(now: number): void {
    this.phase = 'live';
    this.roundStartAt = now;
    this.phaseEndsAt = now + ROUND_SHRINK_S * 1000;
    this.radius = PLATFORM_R_START;
    this.pushEvent({ kind: 'go' });
  }

  private afterResults(now: number): void {
    if (this.matchOver) {
      this.matchOver = false;
      for (const p of this.players.values()) p.wins = 0; // fresh match
      this.round = 0;
    }
    if (this.playerCount() >= MIN_PLAYERS) {
      this.enterCountdown(now);
    } else {
      this.resetToWarmup();
    }
  }

  private resetToWarmup(): void {
    this.phase = 'warmup';
    this.phaseEndsAt = 0;
    this.matchOver = false;
    this.radius = PLATFORM_R_START;
    this.events.length = 0;
  }

  /**
   * One sim step: consume intents, integrate bodies, resolve every contact
   * pair once, apply falls + KO credit, and end the round at <=1 alive.
   */
  private stepWorld(now: number): void {
    const elapsed = Math.max(0, (now - this.roundStartAt) / 1000);
    this.radius = platformRadiusAt(elapsed);

    for (const p of this.players.values()) {
      if (!p.alive) continue; // the fallen watch
      const supported = Math.hypot(p.body.x, p.body.z) <= this.radius;
      // Bots synthesize their frame locally; humans run latest-wins over
      // pad-then-keyboard (a bound pad owns the seat until unbound).
      const intent = p.bot
        ? this.botIntent(p, now, this.radius)
        : (p.padIntent ?? p.kbIntent);
      if (intent !== null) {
        stepBody(p.body, intent.mx, intent.mz, intent.bits, supported, SIM_DT);
        if (intent.seq > p.ack) p.ack = intent.seq;
      } else {
        stepBody(p.body, 0, 0, 0, supported, SIM_DT);
      }
    }

    // Contact: every unordered pair ONCE, post-step positions. The faster
    // mover along the pair normal is the pusher (momentum-weighted).
    const list = [...this.players.values()].filter((p) => p.alive);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b === undefined) continue;
        const aIsPusher = pusherIsA(a.body, b.body);
        const impact = resolvePair(a.body, b.body);
        if (impact <= 0) continue;
        const shovee = aIsPusher ? b : a;
        shovee.lastPusherId = (aIsPusher ? a.id : b.id) ?? null;
        shovee.lastPusherAt = now;
      }
    }

    // Falls => KO credit / self-fall + killfeed event.
    for (const p of list) {
      if (!hasFallenOut(p.body)) continue;
      this.creditKnockout(p, now);
    }

    if (this.aliveCount() <= 1) this.endRound(now);
  }

  /** Mark a player out, attribute stats + killfeed, then let the census speak. */
  private creditKnockout(victim: Player, now: number): void {
    victim.alive = false;
    const withinWindow = now - victim.lastPusherAt <= PUSHER_WINDOW_MS;
    const pusher =
      victim.lastPusherId !== null && withinWindow ? this.players.get(victim.lastPusherId) : undefined;
    if (pusher !== undefined && pusher.id !== victim.id) {
      this.io.reportStats?.(pusher.id, { 'sumo.ko': 1 });
      this.pushEvent({ kind: 'ko', victim: victim.id, by: pusher.id });
    } else {
      this.io.reportStats?.(victim.id, { 'sumo.self': 1 });
      this.pushEvent({ kind: 'ko', victim: victim.id, by: null });
    }
    victim.lastPusherId = null;
  }

  private endRound(now: number): void {
    if (this.phase !== 'live') return; // idempotent: falls + timer may both call
    const standings: AliveStanding[] = [];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      standings.push({ id: p.id, distToCenter: Math.hypot(p.body.x, p.body.z) });
    }
    const outcome = decideRound(standings);
    let champion: PlayerId | null = null;
    if (outcome.winner !== null) {
      const w = this.players.get(outcome.winner);
      if (w !== undefined) {
        w.wins += 1;
        this.io.reportStats?.(w.id, { 'sumo.win': 1 });
        if (w.wins >= WINS_TO_MATCH) champion = w.id;
      }
    }
    this.pushEvent({ kind: 'round_end', winner: outcome.winner, draw: outcome.draw });
    if (champion !== null) {
      this.matchOver = true;
      this.pushEvent({ kind: 'match_end', champion });
    }
    this.phase = 'results';
    this.phaseEndsAt = now + RESULTS_S * 1000;
  }

  private aliveCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.alive) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // Bots
  // -------------------------------------------------------------------------

  /**
   * Keep total seats at max(MIN_PLAYERS, humans) while >=1 human is present;
   * an empty room keeps no bots (a born-empty public room must not sumo
   * itself forever). Grows anywhere; SHRINKS outside live phases — countdown
   * included, since pre-GO churn harms nobody and a second human arriving
   * mid-countdown should not doom the bot to ride the whole round.
   */
  private ensureBotFill(): void {
    let humans = 0;
    for (const p of this.players.values()) if (!p.bot) humans++;
    const target = humans === 0 ? 0 : Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, humans));
    let total = this.players.size;
    while (total < target && this.addBot() !== null) total++;
    if (total > target && this.phase !== 'live') {
      for (const [id, p] of this.players) {
        if (total <= target) break;
        if (p.bot) {
          this.players.delete(id);
          total--;
        }
      }
    }
  }

  /** Seat one more bot, or null at capacity. */
  private addBot(): Player | null {
    if (this.players.size >= MAX_PLAYERS) return null;
    const now = this.clock();
    const slot = this.lowestFreeSlot();
    const id = `bot-${slot}-${randomToken(this.rand, 6)}`;
    const name = BOT_NAMES[slot % BOT_NAMES.length] ?? 'Bot';
    const p = this.freshPlayer(id, name, now);
    p.bot = true;
    p.brain = { tx: 0, tz: 0, retargetAt: 0, dashHoldTicks: 0, jumpHoldTicks: 0 };
    this.players.set(id, p);
    return p;
  }

  /**
   * Simple brain: wander inside the safe ring, hug the center hard when the
   * platform gets tight, and dash when a living opponent is close AND roughly
   * ahead. Occasional hops for flavor (never near the edge).
   */
  private botIntent(p: Player, now: number, radius: number): Intent {
    const brain = p.brain;
    const b = p.body;
    let bits = 0;
    if (brain === undefined || brain === null) return { mx: 0, mz: 0, bits, seq: -1 };

    if (now >= brain.retargetAt) {
      const ang = this.rand() * Math.PI * 2;
      const r = rngRange(this.rand, 0, Math.max(1, radius * 0.5));
      brain.tx = Math.cos(ang) * r;
      brain.tz = Math.sin(ang) * r;
      brain.retargetAt = now + rngRange(this.rand, 800, 2000);
    }

    const distCenter = Math.hypot(b.x, b.z);
    let dx: number;
    let dz: number;
    if (distCenter > radius * 0.65) {
      dx = -b.x;
      dz = -b.z; // hard toward center near the rim
    } else {
      dx = brain.tx - b.x;
      dz = brain.tz - b.z;
    }
    let mag = Math.hypot(dx, dz);
    if (mag < 1e-4) {
      dx = 0;
      dz = 0;
      mag = 0;
    } else {
      dx /= mag;
      dz /= mag;
    }

    // Dash-on-opportunity: living opponent within reach, roughly ahead.
    if (b.dashCd <= 0 && b.grounded) {
      let bestOpp: Player | null = null;
      let bestD2 = 16; // 4u squared
      for (const o of this.players.values()) {
        if (o === p || !o.alive) continue;
        const ddx = o.body.x - b.x;
        const ddz = o.body.z - b.z;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestOpp = o;
        }
      }
      if (bestOpp !== null && mag > 0) {
        const ox = bestOpp.body.x - b.x;
        const oz = bestOpp.body.z - b.z;
        const olen = Math.hypot(ox, oz) || 1;
        const align = (dx * ox + dz * oz) / olen;
        if (align > 0.75) brain.dashHoldTicks = 3;
      }
    }
    if (brain.dashHoldTicks > 0) {
      brain.dashHoldTicks--;
      bits |= 1 << 0; // BIT_DASH
    }
    if (brain.jumpHoldTicks > 0) {
      brain.jumpHoldTicks--;
      bits |= 1 << 1; // BIT_JUMP
    } else if (
      distCenter < radius * 0.4 &&
      b.grounded &&
      this.rand() < 0.006 // ~once per 5.5s of wandering
    ) {
      brain.jumpHoldTicks = 2;
    }

    return { mx: dx, mz: dz, bits, seq: -1 };
  }

  // -------------------------------------------------------------------------
  // Players / spawns / wire payloads
  // -------------------------------------------------------------------------

  private lowestFreeSlot(): number {
    const taken = new Set<number>();
    for (const p of this.players.values()) taken.add(p.slot);
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      if (!taken.has(slot)) return slot;
    }
    return MAX_PLAYERS - 1; // unreachable: callers guard the cap first
  }

  private freshPlayer(id: PlayerId, name: string, now: number): Player {
    const slot = this.lowestFreeSlot();
    const colorIdx = slot % SUMO_COLORS.length;
    const spawnAngle = this.rand() * Math.PI * 2;
    const spawnR = PLATFORM_R_START * 0.55;
    const sx = Math.cos(spawnAngle) * spawnR;
    const sz = Math.sin(spawnAngle) * spawnR;
    const body = makeBody(sx, sz, Math.atan2(-sx, -sz));
    const snap: SumoPlayerSnap = {
      id,
      name,
      color: colorIdx,
      x: sx,
      y: 0,
      z: sz,
      vy: 0,
      yaw: body.yaw,
      alive: true,
      dashing: false,
    };
    const you: SumoSnapMsg['you'] = {
      seq: 0,
      ack: -1,
      x: sx,
      y: 0,
      z: sz,
      vy: 0,
      cooldowns: { dash: 0 },
    };
    const p: Player = {
      id,
      name,
      slot,
      colorIdx,
      bot: false,
      body,
      alive: true,
      wins: 0,
      kbIntent: null,
      padIntent: null,
      lastQueuedSeq: -1,
      ack: -1,
      lastInputAt: now,
      lastPusherId: null,
      lastPusherAt: Number.NEGATIVE_INFINITY,
      brain: null,
      snap,
      you,
      msg: {
        t: 'snap',
        tick: 0,
        serverTime: now,
        phase: this.phase,
        phaseEndsAt: this.phaseEndsAt,
        round: Math.max(1, this.round),
        radius: this.radius,
        you, // same object, mutated per tick
        players: this.snapPlayers, // the ONE shared roster
        wins: this.snapWins,
        events: this.events,
      },
    };
    return p;
  }

  /** Fresh bodies on a ring facing the center — everyone races every round. */
  private spawnAll(): void {
    const seated = [...this.players.values()];
    const n = Math.max(1, seated.length);
    const r = PLATFORM_R_START * 0.55;
    for (let i = 0; i < seated.length; i++) {
      const p = seated[i];
      if (p === undefined) continue;
      const angle = (i / n) * Math.PI * 2;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      p.body = makeBody(x, z, Math.atan2(-x, -z));
      p.alive = true;
      p.kbIntent = null;
      p.padIntent = null;
      p.lastPusherId = null;
      p.lastPusherAt = Number.NEGATIVE_INFINITY;
    }
  }

  private joinedFor(p: Player): { t: 'sumo_joined'; you: PlayerId; roomId: RoomId; code: string | null; phase: SumoPhase; players: Array<{ id: PlayerId; name: string; color: number; wins: number }> } {
    const roster: Array<{ id: PlayerId; name: string; color: number; wins: number }> = [];
    for (const q of this.players.values()) {
      roster.push({ id: q.id, name: q.name, color: q.colorIdx, wins: q.wins });
    }
    return {
      t: 'sumo_joined',
      you: p.id,
      roomId: this.id,
      code: this.code,
      phase: this.phase,
      players: roster,
    };
  }

  // -------------------------------------------------------------------------
  // Snapshot broadcast — EVERY tick (specs/P10.md)
  // -------------------------------------------------------------------------

  private broadcastSnapshot(now: number): void {
    this.tickCount++;
    // Shared roster, refilled in place (persistent per-player objects).
    const list = this.snapPlayers;
    list.length = 0;
    for (const p of this.players.values()) {
      const s = p.snap;
      s.name = p.name;
      s.color = p.colorIdx;
      s.x = p.body.x;
      s.y = p.body.y;
      s.z = p.body.z;
      s.vy = p.body.vy;
      s.yaw = p.body.yaw;
      s.alive = p.alive;
      s.dashing = p.body.dashFlash > 0;
      list.push(s);
    }
    // Wins table, pooled + sorted (wins desc, then slot asc for stability).
    const rows = this.snapWins;
    rows.length = 0;
    for (const p of this.players.values()) {
      let row = rows.find((r) => r.id === p.id);
      if (row === undefined) {
        row = { id: p.id, name: p.name, wins: p.wins };
        rows.push(row);
      } else {
        row.name = p.name;
        row.wins = p.wins;
      }
    }
    rows.sort((a, b) => b.wins - a.wins);

    for (const p of this.players.values()) {
      const you = p.you;
      you.seq = p.lastQueuedSeq;
      you.ack = p.ack;
      you.x = p.body.x;
      you.y = p.body.y;
      you.z = p.body.z;
      you.vy = p.body.vy;
      you.cooldowns.dash = p.body.dashCd;
      const m = p.msg;
      m.tick = this.tickCount;
      m.serverTime = now;
      m.phase = this.phase;
      m.phaseEndsAt = this.phaseEndsAt;
      m.round = Math.max(1, this.round);
      m.radius = this.radius;
      this.io.send(p.id, m);
    }
    this.events.length = 0; // AFTER the sends: Session.send encodes synchronously
  }

  private pushEvent(ev: SumoEvent): void {
    if (this.events.length >= 32) return; // killfeed cap; snaps carry them anyway
    this.events.push(ev);
  }
}
