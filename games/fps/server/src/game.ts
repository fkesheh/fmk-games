// ============================================================================
// server/src/game.ts (S2) — authoritative game room.
// Owns all mutable match state: phase machine, movement sim, fire/damage/death,
// round flow, economy glue, server-driven bots, snapshots + events. Combat math
// is combat.ts (S3), buy rules are economy.ts (S3); socket/session handling is
// net.ts (S1).
// Behavioral invariants: CONTRACT.md "Behavioral invariants (S2)". Never throws.
// ============================================================================
import {
  ECONOMY,
  GEAR,
  INPUT_ALT,
  INPUT_CROUCH,
  INPUT_FIRE,
  INPUT_JUMP,
  INPUT_WALK,
  MAPS,
  MAX_PLAYERS,
  MIN_PLAYERS_FOR_MATCH,
  MULTIKILL_WINDOW,
  NET,
  PLAYER,
  PRIVATE_CODE_LEN,
  ROUNDS,
  TICK_DT,
  TICK_RATE,
  WEAPONS,
  aimDir,
  boxToAABB,
  eyePos,
  makeBody,
  parseC2S,
  rewindTicks,
  rng,
  rngInt,
  shotSeed,
  stepBody,
} from '@fps/shared';
import type {
  AABB,
  BodyState,
  C2S,
  GameEvent,
  GearId,
  HitscanTarget,
  MapDef,
  MapId,
  PlayerId,
  PlayerSnap,
  RoomId,
  RoomInfo,
  RoomPhase,
  RoomVisibility,
  RosterEntry,
  RoundEndReason,
  S2C,
  SpawnPoint,
  Team,
  WeaponDef,
  WeaponId,
  YouSnap,
} from '@fps/shared';
import { LagBuffer, resolveShot, wallEndPoint } from './combat.js';
import type { ShotContext, ShotHit } from './combat.js';
import { killReward, roundRewards, tryBuy, tryBuyGear } from './economy.js';
import { BotBrain } from './bots.js';
import type { BotCommand, BotPercept } from './bots.js';

// ---------------------------------------------------------------------------
// Frozen wire surface (CONTRACT.md module table). S1 injects its sessions.
// ---------------------------------------------------------------------------
export interface RoomIO {
  send(id: PlayerId, msg: S2C): void;
  rttMs(id: PlayerId): number;
}

type InputMsg = Extract<C2S, { t: 'input' }>;
type SnapshotMsg = Extract<S2C, { t: 'snapshot' }>;

interface Ammo {
  mag: number;
  reserve: number;
}

/** Full server-side state for one connected player. */
interface PlayerState {
  id: PlayerId;
  name: string;
  team: Team;
  bot: boolean; // server-driven (S4 brain); no session, exempt from stale/kick guards
  // movement / aim
  body: BodyState;
  yaw: number;
  pitch: number;
  scoped: boolean; // INPUT_ALT held (only meaningful with a scoped weapon)
  inputQueue: InputMsg[]; // capped at NET.inputQueueCap, oldest dropped
  lastProcessedSeq: number; // ack field in snapshots
  lastInputAt: number; // serverTime ms of last input; drives stalePlayers()
  inputWindow: number; // 1s bucket for the speedhack guard
  inputWindowCount: number;
  prevButtons: number; // buttons of the last consumed input (semi-auto edge)
  // weapons / ammo
  weapons: WeaponId[]; // owned, stable order
  ownedOrdered: WeaponId[]; // owned, current first (YouSnap.weapons wire order)
  weapon: WeaponId; // currently held
  ammo: Map<WeaponId, Ammo>; // non-melee weapons only
  reloadUntil: number; // serverTime ms, 0 = not reloading
  nextShotAt: number; // serverTime ms, fire-interval gate
  bloom: number; // current spread add (deg), recovers over time
  shotSeq: number; // per-shot counter feeding shotSeed
  // match state
  hp: number;
  alive: boolean;
  money: number;
  armor: number; // kevlar points 0..100 (0 = no vest); soaks part of incoming damage
  hasKevlar: boolean; // owns the vest (gates helmet buys); death drops it
  helmet: boolean; // owns the helmet (armor absorb extends to headshots); death drops it
  kills: number;
  deaths: number;
  headshots: number;
  // C5 end-of-match stats. Siblings of kills/deaths/headshots in every respect:
  // written on the same paths, and cleared by the same resetMatchStats().
  damageDealt: number; // post-armour HP actually removed from ENEMIES (no self/team damage, no overkill)
  shotsFired: number; // trigger PULLS that consumed a round (a shotgun blast is 1, not 8; a pull dropped on an empty mag is 0)
  shotsHit: number; // pulls that landed >= 1 damaging hit on an enemy (again 1 per blast, not per pellet)
  lastKillAt: number; // serverTime ms of this player's last kill, 0 = none
  streak: number; // multikill streak (kills within MULTIKILL_WINDOW of the previous)
  spawnProtectedUntil: number; // serverTime ms
  respawnAt: number | null; // warmup respawn timer, else null
  spectateTarget: PlayerId | null; // set while dead in a live round
  // Mid-round joiner: seated on a team and on the scoreboard, but NOT in the
  // world for the round already in progress — no body, no snapshot entry, no
  // hitbox, no vote in elimination. Cleared (and the player spawned) by the
  // next beginFreeze / fullReset / abortToWarmup. Never true in warmup/freeze.
  pending: boolean;
  joinSeq: number; // monotonic per room; higher = joined more recently
  balancedRound: number; // round this player was last auto-balanced, -1 = never

  // preallocated wire objects, mutated in place per snapshot (no hot allocs)
  snap: PlayerSnap;
  you: YouSnap;
  snapshotMsg: SnapshotMsg;
}

/** Server-side runtime for one bot: its brain, emitted input seq, tick scratch. */
interface BotState {
  brain: BotBrain;
  seq: number; // last emitted input seq (per-client monotonic, starts at 1)
  percept: BotPercept; // reused scratch, mutated in place each tick (no hot allocs)
}

const ROOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
let roomSeq = 0; // mixes into the rng seed so same-ms rooms still differ

/** Min gap between two freshly placed teammates (2.5x the PLAYER.radius AABB
    diagonal): closer than this and the two bodies interpenetrate at spawn. */
const SPAWN_MIN_SEP = 1.5;

function randomToken(next: () => number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET.charAt(rngInt(next, 0, ROOM_ALPHABET.length - 1));
  return s;
}

function defaultAmmo(w: WeaponId): Ammo {
  return { mag: WEAPONS[w].mag, reserve: WEAPONS[w].reserve };
}

/**
 * Clear the six per-MATCH scoreboard counters. C5 requires damageDealt /
 * shotsFired / shotsHit to be reset wherever kills/deaths/headshots are, so the
 * six live and die together in exactly one function — a stat that survives a
 * reset the others do not is worse than no stat at all.
 *
 * The three EXISTING counters were previously zeroed only at player creation,
 * which meant a room's second match reported the first match's frags. Every
 * match boundary now calls this: handleStart (a new match begins), fullReset
 * (the lobby return 6s after match_end) and abortToWarmup (low-population
 * abort). It is deliberately NOT called at beginFreeze — stats accumulate
 * across the rounds OF a match, which is the whole point of them.
 */
function resetMatchStats(p: PlayerState): void {
  p.kills = 0;
  p.deaths = 0;
  p.headshots = 0;
  p.damageDealt = 0;
  p.shotsFired = 0;
  p.shotsHit = 0;
}

export class GameRoom {
  readonly id: RoomId;
  readonly code: string | null;
  readonly visibility: RoomVisibility;

  private readonly mapId: MapId;
  private readonly map: MapDef;
  private readonly io: RoomIO;
  private readonly solids: AABB[];
  private readonly players = new Map<PlayerId, PlayerState>();
  private readonly bots = new Map<PlayerId, BotState>(); // insertion order = add order
  private botCounter = 0; // 'Bot N' counter — never reused, also seeds the brain
  private joinCounter = 0; // monotonic join stamp; orders "most recently joined"
  private readonly lag = new LagBuffer(NET.lagBufferTicks);
  private readonly next: () => number;

  private phase: RoomPhase = 'warmup';
  private phaseEndsAt = 0; // 0 during warmup/matchEnd per wire contract
  private round = 0; // 0 during warmup, 1..N during a match
  private scoreT = 0;
  private scoreCT = 0;
  // Consecutive rounds each side has lost, NOT on the wire (contract C3). Read
  // before a round's result is applied to size that side's loss payout, then
  // updated: the winner drops to 0, the loser climbs a rung, a draw climbs both.
  // Reset alongside the halftime side swap — economic pressure belongs to the
  // side, not to the players who just crossed over.
  private readonly lossStreak: { t: number; ct: number } = { t: 0, ct: 0 };
  private tickN = 0;
  private buyOpenUntil = 0; // serverTime ms; canBuy while live && now < this
  private matchEndResetAt = 0; // serverTime ms; warmup reset 6s after match_end
  private timer: ReturnType<typeof setInterval> | null = null;
  // queued team-switch requests (made during freeze/live/roundEnd/matchEnd),
  // applied at the next beginFreeze; warmup switches apply immediately instead
  private readonly teamSwitchQueue = new Map<PlayerId, Team>();

  // spawn indices already handed out in the current spawn wave, per team.
  // Cleared by beginSpawnWave() at the start of every full placement pass.
  private readonly spawnTaken: Record<Team, Set<number>> = { T: new Set(), CT: new Set() };

  // tick scratch, reused across ticks (hot-path allocation ban)
  private readonly snapPlayers: PlayerSnap[] = [];
  private readonly scratchTargets: HitscanTarget[] = [];

  constructor(mapId: MapId, visibility: RoomVisibility, io: RoomIO) {
    this.mapId = mapId;
    this.map = MAPS[mapId];
    this.visibility = visibility;
    this.io = io;
    this.solids = this.map.boxes.map(boxToAABB);
    // server-side generation (room id, private code) uses rng(Date.now()) — RULE 7
    this.next = rng((Date.now() ^ (roomSeq++ * 0x9e3779b9)) >>> 0);
    this.id = randomToken(this.next, 8);
    this.code = visibility === 'private' ? randomToken(this.next, PRIVATE_CODE_LEN) : null;
  }

  // fps RoomInfo plus the platform RoomInfo fields (game/label) — one object
  // satisfies both the fps client (mapId) and the lobby list (game, label).
  info(): RoomInfo & { game: 'fps'; label: string } {
    return {
      id: this.id,
      code: this.code,
      game: 'fps',
      label: this.map.name, // map display name (lobby list subtitle)
      mapId: this.mapId,
      players: this.players.size,
      maxPlayers: MAX_PLAYERS,
      phase: this.phase,
      visibility: this.visibility,
    };
  }

  playerCount(): number {
    return this.players.size;
  }

  /**
   * Manual start (frozen lobby contract, identical across the platform's games):
   * warmup IS this game's lobby and it NEVER ends by itself. A match begins only
   * when a seated player asks for it, and only while the room is actually in
   * warmup with enough players. Bots count — they hold real roster slots — so a
   * solo player who adds a bot can start.
   *
   * Recomputed from live state every snapshot, so dropping back below the
   * minimum (a leaver, a removed bot) makes it false again immediately.
   */
  canStartMatch(): boolean {
    return this.phase === 'warmup' && this.players.size >= MIN_PLAYERS_FOR_MATCH;
  }

  addPlayer(id: PlayerId, name: string): void {
    try {
      if (this.players.has(id)) return;
      if (this.players.size >= MAX_PLAYERS) {
        // full room: displace the longest-connected bot so the human can join
        const oldest = this.bots.keys().next();
        if (oldest.done) return; // full of humans: join refused
        this.removePlayer(oldest.value);
      }
      this.joinPlayer(id, name, false);
    } catch (err) {
      console.error('[game] addPlayer failed', err);
    }
  }

  removePlayer(id: PlayerId): void {
    try {
      if (!this.players.delete(id)) return;
      this.bots.delete(id);
      this.teamSwitchQueue.delete(id); // drop any pending switch for the leaver
      this.broadcast({ t: 'player_left', id });
    } catch (err) {
      console.error('[game] removePlayer failed', err);
    }
  }

  addBot(): PlayerId | null {
    try {
      if (this.players.size >= MAX_PLAYERS) return null; // bots hold normal slots
      this.botCounter++;
      const n = this.botCounter;
      const brain = new BotBrain(this.botSeed(n));
      const id = this.freshPlayerId();
      this.joinPlayer(id, `Bot ${n}`, true); // identical join flow, roster bot: true
      if (!this.players.has(id)) return null; // join refused (already logged)
      this.bots.set(id, {
        brain,
        seq: 0,
        percept: {
          self: {
            x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 0,
            mag: 0, reserve: 0, reloading: false, crouch: false,
            weapon: 'pistol', // overwritten from PlayerState.weapon every tick
          },
          enemies: [],
          solids: this.solids,
          map: this.map,
          tick: 0,
          phase: this.phase,
          money: 0,
          owned: [],
          canBuy: false,
        },
      });
      return id;
    } catch (err) {
      console.error('[game] addBot failed', err);
      return null;
    }
  }

  removeBot(): boolean {
    try {
      // insertion order: the last key is the most recently added bot
      let last: PlayerId | null = null;
      for (const id of this.bots.keys()) last = id;
      if (last === null) return false;
      this.removePlayer(last); // full leave flow
      return true;
    } catch (err) {
      console.error('[game] removeBot failed', err);
      return false;
    }
  }

  botCount(): number {
    return this.bots.size;
  }

  /**
   * Shared join flow for humans and bots: identical spawn/roster/broadcast.
   *
   * Mid-round joins (CS rule): warmup and freeze drop you straight into the
   * world — freeze IS the pre-round buy window, so joining then costs nobody
   * anything. Joining once the round is under way (live/roundEnd/matchEnd)
   * seats you on a team and puts you on the scoreboard, but leaves you OUT of
   * the world until the next freeze: `pending`, alive false, no body, no
   * snapshot entry, no hitbox. Before this, every join called placeAtSpawn
   * unconditionally, which left drop-ins standing in the map as shootable
   * targets who could not act until the round rolled over.
   */
  private joinPlayer(id: PlayerId, name: string, bot: boolean): void {
    if (this.players.has(id) || this.players.size >= MAX_PLAYERS) return;
    const now = Date.now();
    const team = this.pickTeam();
    const pending = this.roundInProgress();

    const snap: PlayerSnap = {
      id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
      hp: pending ? 0 : PLAYER.maxHp, alive: !pending, crouch: false, moving: false, weapon: 'pistol',
    };
    const you: YouSnap = {
      hp: pending ? 0 : PLAYER.maxHp, alive: !pending, money: ECONOMY.start,
      weapons: ['pistol', 'knife'], weapon: 'pistol',
      mag: WEAPONS.pistol.mag, reserve: WEAPONS.pistol.reserve,
      canBuy: false, spectateTarget: null, respawnAt: null, vy: 0,
      armor: 0, helmet: false, joiningNextRound: pending,
    };
    const snapshotMsg: SnapshotMsg = {
      t: 'snapshot', tick: 0, serverTime: 0, ack: 0,
      phase: this.phase, phaseEndsAt: 0, players: [], you,
      seated: 0, minPlayers: MIN_PLAYERS_FOR_MATCH, canStart: false,
    };
    const p: PlayerState = {
      id, name, team, bot,
      body: makeBody(0, 0, 0),
      yaw: 0, pitch: 0, scoped: false,
      inputQueue: [], lastProcessedSeq: 0, lastInputAt: now,
      inputWindow: 0, inputWindowCount: 0, prevButtons: 0,
      weapons: ['knife', 'pistol'], ownedOrdered: ['pistol', 'knife'], weapon: 'pistol',
      ammo: new Map<WeaponId, Ammo>([['pistol', defaultAmmo('pistol')]]),
      reloadUntil: 0, nextShotAt: 0, bloom: 0, shotSeq: 0,
      hp: pending ? 0 : PLAYER.maxHp, alive: !pending,
      money: ECONOMY.start, kills: 0, deaths: 0, headshots: 0,
      damageDealt: 0, shotsFired: 0, shotsHit: 0,
      armor: 0, hasKevlar: false, helmet: false,
      lastKillAt: 0, streak: 0,
      spawnProtectedUntil: 0, respawnAt: null, spectateTarget: null,
      pending, joinSeq: ++this.joinCounter, balancedRound: -1,
      snap, you, snapshotMsg,
    };
    this.players.set(id, p);
    // warmup/freeze: straight into the world. Round in progress: stay out of it.
    if (!pending) this.placeAtSpawn(p, now);
    this.io.send(id, {
      t: 'joined', roomId: this.id, code: this.code, mapId: this.mapId,
      you: id, team, tick: this.tickN, serverTime: now,
      round: this.round, scoreT: this.scoreT, scoreCT: this.scoreCT,
      roster: this.buildRoster(id),
    });
    this.broadcastExcept(id, { t: 'player_joined', entry: this.rosterEntry(p, null) });
    // never leave a spectating joiner guessing why they cannot move
    if (pending && !bot) {
      this.sendEvent(id, {
        t: 'notice',
        code: 'joining_next_round',
        text: 'Round in progress — you spawn at the start of the next round',
      });
    }
  }

  /** True while a round is under way: a fresh joiner must sit this one out. */
  private roundInProgress(): boolean {
    return this.phase !== 'warmup' && this.phase !== 'freeze';
  }

  private pickTeam(): Team {
    // auto-assign the smaller team, coin flip on tie
    const t = this.countConnected('T');
    const ct = this.countConnected('CT');
    return t < ct ? 'T' : ct < t ? 'CT' : this.next() < 0.5 ? 'T' : 'CT';
  }

  /** Balance guard (frozen): target team must not already have >= other + 1. */
  private teamSwitchAllowed(team: Team): boolean {
    const target = this.countConnected(team);
    const other = this.countConnected(team === 'T' ? 'CT' : 'T');
    return target < other + 1;
  }

  /** Immediate switch (warmup): set team, broadcast, respawn with protection. */
  private applyTeamSwitch(p: PlayerState, team: Team, now: number): void {
    p.team = team;
    this.teamSwitchQueue.delete(p.id); // satisfied: drop any stale queued request
    this.broadcast({ t: 'team_changed', id: p.id, team });
    this.placeAtSpawn(p, now); // new team's spawns, spawn protection included
  }

  /** beginFreeze application of queued requests; guard re-evaluated per request. */
  private applyQueuedTeamSwitches(): void {
    if (this.teamSwitchQueue.size === 0) return;
    for (const [id, team] of this.teamSwitchQueue) {
      this.teamSwitchQueue.delete(id); // consumed either way
      const p = this.players.get(id);
      if (p === undefined || p.team === team) continue; // gone or already there
      if (!this.teamSwitchAllowed(team)) {
        this.io.send(id, { t: 'error', code: 'team_full', message: 'team is full' });
        continue;
      }
      p.team = team;
      this.broadcast({ t: 'team_changed', id, team });
    }
  }

  /**
   * Freeze-time auto-balance. pickTeam()/teamSwitchAllowed() keep JOINS even,
   * but a roster that goes lopsided through leavers is never repaired — a 5v2
   * stays 5v2 forever. So at every freeze (and only at a freeze: yanking
   * someone out of a live round is worse than the imbalance) move players off
   * the bigger side until the sides differ by at most 1.
   *
   * Candidate order, best first:
   *   1. bots before humans   — a bot does not care which side it plays
   *   2. players NOT moved at the previous freeze — nobody gets ping-ponged
   *   3. most recently joined — the newest player has the least invested
   * Each move shrinks the gap by exactly 2, so from |diff| >= 2 it never
   * overshoots into a worse imbalance; the loop is bounded by the roster size.
   */
  private autoBalanceTeams(): void {
    for (let guard = this.players.size; guard > 0; guard--) {
      const t = this.countConnected('T');
      const ct = this.countConnected('CT');
      if (Math.abs(t - ct) <= 1) return; // already balanced (or 1 apart: fine)
      const from: Team = t > ct ? 'T' : 'CT';
      const to: Team = from === 'T' ? 'CT' : 'T';
      const mover = this.pickBalanceCandidate(from);
      if (mover === null) return; // nothing movable: leave it rather than churn
      mover.team = to;
      mover.balancedRound = this.round;
      this.teamSwitchQueue.delete(mover.id); // a pending request is now moot
      this.broadcast({ t: 'team_changed', id: mover.id, team: to });
      if (!mover.bot) {
        this.sendEvent(mover.id, {
          t: 'notice',
          code: 'team_rebalanced',
          text: `Teams were uneven — you were moved to ${to}`,
        });
      }
    }
  }

  /** Least-disruptive player to move off `from` (see autoBalanceTeams). */
  private pickBalanceCandidate(from: Team): PlayerState | null {
    let best: PlayerState | null = null;
    let bestRank = Infinity;
    let bestSeq = -1;
    for (const p of this.players.values()) {
      if (p.team !== from) continue;
      // moved at the previous freeze: only picked when nothing else is left
      const movedLastRound = p.balancedRound === this.round - 1 ? 1 : 0;
      const rank = (p.bot ? 0 : 2) + movedLastRound;
      if (rank < bestRank || (rank === bestRank && p.joinSeq > bestSeq)) {
        best = p;
        bestRank = rank;
        bestSeq = p.joinSeq;
      }
    }
    return best;
  }

  private freshPlayerId(): PlayerId {
    let id = randomToken(this.next, 8);
    while (this.players.has(id)) id = randomToken(this.next, 8);
    return id;
  }

  private botSeed(botIndex: number): number {
    // deterministic hash (FNV-1a) of room id + bot index: one seeded brain each
    let h = 0x811c9dc5;
    const s = `${this.id}#${botIndex}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /**
   * GameRoomHandle entry: the platform lobby routes RAW room-level envelopes
   * here (lobby tags are platform-owned and ignored below). Validate with the
   * frozen fps parser; silently drop nulls — never throw on wire data.
   */
  handleMessage(id: PlayerId, msg: unknown): void {
    const parsed = parseC2S(msg);
    if (parsed === null) return;
    switch (parsed.t) {
      case 'input':
        this.handleInput(id, parsed);
        return;
      case 'reload':
        this.handleReload(id);
        return;
      case 'switch':
        this.handleSwitch(id, parsed.weapon);
        return;
      case 'buy':
        this.handleBuy(id, parsed.weapon);
        return;
      case 'buy_gear':
        this.handleBuyGear(id, parsed.item);
        return;
      case 'kill_bots':
        this.handleKillBots();
        return;
      case 'start':
        this.handleStart(id);
        return;
      case 'switch_team':
        this.handleSwitchTeam(id, parsed.team);
        return;
      case 'suicide':
        this.handleSuicide(id);
        return;
      case 'add_bot':
        if (this.addBot() === null) {
          this.io.send(id, { t: 'error', code: 'room_full', message: 'room is full' });
        }
        return;
      case 'remove_bot':
        this.removeBot(); // false (no bots) is fine
        return;
      default:
        return; // lobby-level tags (list_rooms, quick_join, create_*, join_private, leave, ping)
    }
  }

  handleInput(id: PlayerId, msg: InputMsg): void {
    try {
      const p = this.players.get(id);
      if (p === undefined) return;
      const now = Date.now();
      p.lastInputAt = now;
      // speedhack guard: more than inputQueueCap inputs inside a 1s window
      const bucket = Math.floor(now / 1000);
      if (bucket !== p.inputWindow) {
        p.inputWindow = bucket;
        p.inputWindowCount = 0;
      }
      if (!p.bot) {
        // bots emit exactly 1 input/tick: exempt from the speedhack kick
        p.inputWindowCount++;
        if (p.inputWindowCount > NET.inputQueueCap) {
          this.removePlayer(id); // S1 owns the socket close
          return;
        }
      }
      if (msg.seq <= p.lastProcessedSeq) return; // stale/duplicate
      if (p.inputQueue.length >= NET.inputQueueCap) p.inputQueue.shift(); // oldest dropped
      p.inputQueue.push(msg);
    } catch (err) {
      console.error('[game] handleInput failed', err);
    }
  }

  handleReload(id: PlayerId): void {
    try {
      const p = this.players.get(id);
      if (p === undefined || !p.alive || p.reloadUntil > 0) return;
      const def = WEAPONS[p.weapon];
      if (def.mag === -1) return; // melee
      const ammo = p.ammo.get(p.weapon);
      if (ammo === undefined || ammo.mag >= def.mag || ammo.reserve <= 0) return;
      p.reloadUntil = Date.now() + def.reload * 1000;
    } catch (err) {
      console.error('[game] handleReload failed', err);
    }
  }

  handleSwitch(id: PlayerId, weapon: WeaponId): void {
    try {
      const p = this.players.get(id);
      if (p === undefined || !p.alive) return;
      if (weapon === p.weapon || !p.weapons.includes(weapon)) return;
      this.setWeapon(p, weapon); // switch cancels reload (inside setWeapon)
    } catch (err) {
      console.error('[game] handleSwitch failed', err);
    }
  }

  handleBuy(id: PlayerId, weapon: WeaponId): void {
    try {
      const p = this.players.get(id);
      if (p === undefined) return;
      const res = tryBuy(p.money, p.weapons, weapon, this.canBuyAt(Date.now()));
      if (!res.ok) {
        this.sendEvent(id, { t: 'buy_result', ok: false, weapon: null, reason: res.reason });
        return;
      }
      // replaced primary leaves the owned list: drop its ammo record
      for (const w of p.weapons) {
        if (!res.owned.includes(w)) p.ammo.delete(w);
      }
      p.money = res.money;
      p.weapons = res.owned;
      p.ammo.set(weapon, defaultAmmo(weapon)); // a new gun comes loaded
      if (!res.owned.includes(p.weapon)) this.setWeapon(p, weapon); // held primary was replaced
      else this.rebuildOwnedOrdered(p);
      this.sendEvent(id, { t: 'buy_result', ok: true, weapon, reason: null });
    } catch (err) {
      console.error('[game] handleBuy failed', err);
    }
  }

  // Gear buy (C2S buy_gear): CS kevlar vest / helmet in the same canBuy window
  // as weapons. buy_result carries weapon null; failures report the frozen
  // reason string ('buy time expired' / 'insufficient funds' / 'already owned'
  // / 'requires kevlar'). A kevlar buy (rebuy included) refills armor to full;
  // a helmet buy keeps the armor points the vest already has.
  handleBuyGear(id: PlayerId, item: GearId): void {
    try {
      const p = this.players.get(id);
      if (p === undefined) return;
      const res = tryBuyGear(p.money, p.hasKevlar, p.helmet, item, this.canBuyAt(Date.now()));
      if (!res.ok) {
        this.sendEvent(id, { t: 'buy_result', ok: false, weapon: null, reason: res.reason });
        return;
      }
      p.money = res.money;
      p.hasKevlar = res.hasKevlar;
      p.helmet = res.helmet;
      // res.armor is GEAR.armorStart for a vest buy, 0 for a helmet buy: the
      // max refills the vest without letting a helmet purchase wipe points
      p.armor = Math.max(p.armor, res.armor);
      this.sendEvent(id, { t: 'buy_result', ok: true, weapon: null, reason: null });
    } catch (err) {
      console.error('[game] handleBuyGear failed', err);
    }
  }

  // Manual start (C2S start): the ONLY warmup -> freeze transition there is.
  // Accepted from ANY seated player (no host concept on this platform) while
  // canStartMatch() holds; ignored silently otherwise — an unknown sender, the
  // wrong phase, or too few players are all no-ops, never errors, never throws.
  handleStart(id: PlayerId): void {
    try {
      if (!this.players.has(id)) return; // only a seated player may start it
      if (!this.canStartMatch()) return; // wrong phase or below the minimum
      // A fresh match starts from a clean scoreboard: warmup frags/damage are
      // practice and must not land in this match's `match_end` stats.
      for (const p of this.players.values()) resetMatchStats(p);
      this.beginFreeze(1, Date.now()); // round 1 of a fresh match (scores are 0 in warmup)
    } catch (err) {
      console.error('[game] handleStart failed', err);
    }
  }

  // Console 'kill' command (C2S suicide): the existing death path with no
  // killer — kill event carries killerId null, weapon 'knife', headshot false,
  // no kill reward / streak for anyone. Only where bodies actually simulate
  // (warmup/live): ignored while dead and in freeze/roundEnd/matchEnd.
  handleSuicide(id: PlayerId): void {
    try {
      const p = this.players.get(id);
      if (p === undefined || !p.alive) return;
      if (this.phase !== 'warmup' && this.phase !== 'live') return;
      this.kill(p, null, false, WEAPONS.knife, Date.now());
    } catch (err) {
      console.error('[game] handleSuicide failed', err);
    }
  }

  // Console 'killbots' command (C2S kill_bots): every bot dies IN PLACE through
  // the normal death path — kill event with killerId null, weapon 'knife',
  // headshot false, no reward/streak; bots stay in the room (no removal) and
  // follow the usual phase rules (warmup: they respawn; rounds: dead until the
  // next freeze). Already-dead bots are skipped (no double death count).
  handleKillBots(): void {
    try {
      const now = Date.now();
      for (const botId of this.bots.keys()) {
        const p = this.players.get(botId);
        if (p === undefined || !p.alive) continue;
        this.kill(p, null, false, WEAPONS.knife, now);
      }
    } catch (err) {
      console.error('[game] handleKillBots failed', err);
    }
  }

  // Team switch (frozen invariant): no-op if already on `team`. Balance guard:
  // denied with {t:'error', code:'team_full'} when the target team already has
  // >= (other team + 1) players (bots count — they hold normal slots). In
  // warmup the switch applies immediately (respawn at the new team's spawns
  // with protection); in freeze/live/roundEnd/matchEnd it is queued and
  // applied at the next beginFreeze with the guard re-evaluated. Requests
  // denied at beginFreeze are dropped WITH the error message (documented
  // choice — the alternative was a silent drop).
  handleSwitchTeam(id: PlayerId, team: Team): void {
    try {
      const p = this.players.get(id);
      if (p === undefined || p.team === team) return; // unknown or no-op
      if (this.phase === 'warmup') {
        if (!this.teamSwitchAllowed(team)) {
          this.io.send(id, { t: 'error', code: 'team_full', message: 'team is full' });
          return;
        }
        this.applyTeamSwitch(p, team, Date.now());
        return;
      }
      this.teamSwitchQueue.set(id, team); // latest request wins
    } catch (err) {
      console.error('[game] handleSwitchTeam failed', err);
    }
  }

  start(): void {
    if (this.timer !== null) return; // idempotent
    this.timer = setInterval(() => this.tickGuarded(), 1000 / TICK_RATE);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Players with no input for NET.inputTimeoutMs; S1 polls and closes sockets. */
  stalePlayers(): PlayerId[] {
    const now = Date.now();
    const out: PlayerId[] = [];
    for (const p of this.players.values()) {
      if (p.bot) continue; // server-driven: no socket to time out
      if (now - p.lastInputAt > NET.inputTimeoutMs) out.push(p.id);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Tick. One bad tick must never kill the interval.
  // -------------------------------------------------------------------------

  private tickGuarded(): void {
    try {
      this.tick();
    } catch (err) {
      console.error('[game] tick failed', err);
    }
  }

  private tick(): void {
    const now = Date.now();
    this.tickN++;
    this.advancePhase(now);
    this.tickBots(now); // bots emit their input BEFORE any movement is consumed
    for (const p of this.players.values()) this.tickPlayer(p, now);
    this.pushLagBuffer();
    if (this.phase === 'live') this.checkElimination(now);
    this.updateSpectators();
    this.sendSnapshots(now);
  }

  // -------------------------------------------------------------------------
  // Bots (S4): one brain tick per bot per server tick. The returned BotCommand
  // is fed through the exact same input/reload/buy handlers a client message
  // hits (with the same clamps parseC2S would apply on the wire).
  // -------------------------------------------------------------------------

  private tickBots(now: number): void {
    if (this.bots.size === 0) return;
    for (const [id, b] of this.bots) {
      const p = this.players.get(id);
      if (p === undefined) continue; // player gone (mid-removal): nothing to drive
      // percept: reused scratch mutated in place (no per-tick allocation);
      // enemies = alive players of the other team at CURRENT positions/heights
      const self = b.percept.self;
      self.x = p.body.x;
      self.y = p.body.y;
      self.z = p.body.z;
      self.yaw = p.yaw;
      self.pitch = p.pitch;
      self.hp = p.hp;
      // The HELD weapon, not owned[0] — the brain resolves its WeaponDef from
      // this, so it can never disagree with the fire path about what it holds.
      self.weapon = p.weapon;
      const def = WEAPONS[p.weapon];
      const ammo = p.ammo.get(p.weapon);
      self.mag = def.mag === -1 ? -1 : ammo !== undefined ? ammo.mag : 0;
      self.reserve = def.reserve === -1 ? -1 : ammo !== undefined ? ammo.reserve : 0;
      self.reloading = p.reloadUntil > 0;
      self.crouch = p.body.height < PLAYER.heightStand;
      const enemies = b.percept.enemies;
      let n = 0;
      for (const o of this.players.values()) {
        if (o.team === p.team || !o.alive) continue;
        let e = enemies[n];
        if (e === undefined) {
          e = { id: '', x: 0, y: 0, z: 0, height: 0, alive: true };
          enemies[n] = e;
        }
        e.id = o.id;
        e.x = o.body.x;
        e.y = o.body.y;
        e.z = o.body.z;
        e.height = o.body.height;
        e.alive = true;
        n++;
      }
      enemies.length = n;
      b.percept.tick = this.tickN;
      b.percept.phase = this.phase;
      b.percept.money = p.money;
      b.percept.owned = p.weapons;
      b.percept.canBuy = this.canBuyAt(now);

      let cmd: BotCommand;
      try {
        cmd = b.brain.tick(b.percept);
      } catch (err) {
        console.error('[game] bot brain failed', err);
        continue;
      }
      // a buggy brain must not poison the sim: parseC2S drops non-finite inputs
      if (
        !Number.isFinite(cmd.moveX) ||
        !Number.isFinite(cmd.moveZ) ||
        !Number.isFinite(cmd.yaw) ||
        !Number.isFinite(cmd.pitch) ||
        !Number.isFinite(cmd.buttons)
      ) {
        continue;
      }
      b.seq++;
      this.handleInput(id, {
        t: 'input',
        seq: b.seq,
        moveX: Math.min(1, Math.max(-1, cmd.moveX)),
        moveZ: Math.min(1, Math.max(-1, cmd.moveZ)),
        yaw: cmd.yaw,
        pitch: Math.min(1.45, Math.max(-1.45, cmd.pitch)),
        buttons: cmd.buttons & 0xf,
      });
      // switch BEFORE reload: the bot services the gun it ends the tick
      // holding, not the one it is putting away. Same handler as a client's
      // { t: 'switch' } — it rejects unowned weapons and dead players itself.
      if (cmd.switchTo !== null) this.handleSwitch(id, cmd.switchTo);
      if (cmd.reload) this.handleReload(id);
      if (cmd.buy !== null) this.handleBuy(id, cmd.buy);
    }
  }

  // -------------------------------------------------------------------------
  // Phase machine: warmup -> freeze -> live -> roundEnd -> (halftime) ->
  // matchEnd -> warmup. All timings from ROUNDS.
  //
  // warmup is the LOBBY and it is a terminal phase for the tick loop: the only
  // way out is an explicit C2S 'start' (handleStart). Warmup stays fully
  // playable — bodies step, guns fire, the dead respawn on the warmup timer —
  // it simply never ends by itself. Every path back to warmup (fullReset after
  // a match, abortToWarmup on low population) therefore parks the room there
  // until a player starts the next match.
  // -------------------------------------------------------------------------

  private advancePhase(now: number): void {
    switch (this.phase) {
      case 'warmup':
        return; // lobby: only handleStart leaves warmup — never a timer, never a headcount
      case 'freeze':
      case 'live': {
        // low-population abort: match collapses straight back to warmup
        if (this.players.size < MIN_PLAYERS_FOR_MATCH) {
          this.abortToWarmup(now);
          return;
        }
        // forfeit: a whole team gone (but MIN still met) loses the round
        const t = this.countConnected('T');
        const ct = this.countConnected('CT');
        if (t === 0 || ct === 0) {
          this.endRound(t === 0 ? 'CT' : 'T', 'forfeit', now);
          return;
        }
        if (this.phase === 'freeze') {
          if (now >= this.phaseEndsAt) this.beginLive(now);
        } else if (now >= this.phaseEndsAt) {
          // time: more alive wins, tie => CT
          this.endRound(this.countAlive('T') > this.countAlive('CT') ? 'T' : 'CT', 'time', now);
        }
        return;
      }
      case 'roundEnd':
        if (this.players.size < MIN_PLAYERS_FOR_MATCH) {
          this.abortToWarmup(now);
          return;
        }
        if (now >= this.phaseEndsAt) this.advanceAfterRound(now);
        return;
      case 'matchEnd':
        if (now >= this.matchEndResetAt) this.fullReset(now);
        return;
    }
  }

  private beginFreeze(round: number, now: number): void {
    this.phase = 'freeze';
    this.round = round;
    this.phaseEndsAt = now + ROUNDS.freezeTime * 1000;
    // queued team switches apply now (halftime's side swap already happened in
    // advanceAfterRound, so guards below see post-swap teams); placeAtSpawn in
    // the loop then teleports switchers to their NEW team's spawns
    this.applyQueuedTeamSwitches();
    // auto-balance AFTER queued switches (it must see the final rosters) and
    // BEFORE placement (movers spawn on their new side, not their old one)
    this.autoBalanceTeams();
    this.beginSpawnWave(); // one claim set per round: no two teammates share a point
    for (const p of this.players.values()) {
      p.pending = false; // mid-round joiners join THIS round, from the freeze
      this.placeAtSpawn(p, now); // teleported, healed, protected
      this.refillWeapons(p); // every owned weapon refills mag+reserve for free
      p.streak = 0; // multikill streaks reset for everyone at every freeze
      p.lastKillAt = 0;
    }
    this.broadcast({
      t: 'round_start', round,
      scoreT: this.scoreT, scoreCT: this.scoreCT,
      freezeUntil: this.phaseEndsAt,
    });
  }

  private beginLive(now: number): void {
    this.phase = 'live';
    this.phaseEndsAt = now + ROUNDS.roundTime * 1000;
    this.buyOpenUntil = now + ROUNDS.buyTime * 1000;
  }

  private endRound(winner: Team | null, reason: RoundEndReason, now: number): void {
    if (winner === 'T') this.scoreT++;
    else if (winner === 'CT') this.scoreCT++;
    // Payouts use the PRE-round streaks: a side that has already lost twice is
    // paid the third rung for losing this one. winner null (mutual
    // elimination) pays both sides their own loss reward.
    const rewards = roundRewards(winner, this.lossStreak);
    this.lossStreak.t = winner === 'T' ? 0 : this.lossStreak.t + 1;
    this.lossStreak.ct = winner === 'CT' ? 0 : this.lossStreak.ct + 1;
    for (const p of this.players.values()) {
      const gain = p.team === 'T' ? rewards.t : rewards.ct;
      p.money = Math.min(ECONOMY.max, p.money + gain); // clamp is caller-side per S3 table
    }
    this.phase = 'roundEnd';
    this.phaseEndsAt = now + ROUNDS.roundEndTime * 1000;
    this.broadcast({ t: 'round_end', winner, reason, scoreT: this.scoreT, scoreCT: this.scoreCT });
  }

  private advanceAfterRound(now: number): void {
    if (
      this.scoreT >= ROUNDS.winRounds ||
      this.scoreCT >= ROUNDS.winRounds ||
      this.round >= ROUNDS.maxRounds
    ) {
      this.beginMatchEnd(now);
      return;
    }
    if (this.round === ROUNDS.halftimeAfter) {
      // swap sides; side-scores swap too so they follow the players
      for (const p of this.players.values()) p.team = p.team === 'T' ? 'CT' : 'T';
      const tmp = this.scoreT;
      this.scoreT = this.scoreCT;
      this.scoreCT = tmp;
      // loss streaks do NOT follow the players across the swap: both sides
      // start the second half on the base rung (contract C3)
      this.lossStreak.t = 0;
      this.lossStreak.ct = 0;
      // per-recipient roster: each player sees only their own money
      for (const p of this.players.values()) {
        this.sendEvent(p.id, { t: 'halftime', roster: this.buildRoster(p.id) });
      }
    }
    this.beginFreeze(this.round + 1, now);
  }

  private beginMatchEnd(now: number): void {
    const winner: Team =
      this.scoreT === this.scoreCT ? 'CT' : this.scoreT > this.scoreCT ? 'T' : 'CT'; // tie => CT
    this.phase = 'matchEnd';
    this.phaseEndsAt = 0; // wire contract: 0 during matchEnd
    this.matchEndResetAt = now + 6000;
    this.broadcast({
      t: 'match_end', winner, scoreT: this.scoreT, scoreCT: this.scoreCT,
      stats: this.buildMatchStats(),
    });
  }

  /**
   * C5's end-of-match scoreboard: EVERY player still in the room, both teams,
   * bots and mid-round joiners included (a joiner sitting out the last round is
   * still present, and reports the zeroes that are the truth about their match).
   *
   * The order is the server's and is TOTAL, so the client renders it as received
   * — including the top-3 cut the end screen makes — and never re-sorts:
   *   kills DESC -> damage DESC -> deaths ASC -> joinSeq ASC.
   * kills first because that is the number the match was scored on; damage
   * breaks ties because it is the finer-grained measure of the same work (it is
   * exactly the "did nothing but chip everyone" case the flat kill list hid);
   * deaths next; and joinSeq — unique per room and never reused — makes the
   * comparator a strict total order, so two identical lines can never swap
   * between builds or between two players' copies of the same message.
   */
  private buildMatchStats(): Array<Extract<GameEvent, { t: 'match_end' }>['stats'][number]> {
    const rows = [...this.players.values()];
    rows.sort(
      (a, b) =>
        b.kills - a.kills ||
        b.damageDealt - a.damageDealt ||
        a.deaths - b.deaths ||
        a.joinSeq - b.joinSeq,
    );
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      kills: p.kills,
      deaths: p.deaths,
      headshots: p.headshots,
      damage: p.damageDealt,
      shotsFired: p.shotsFired,
      shotsHit: p.shotsHit,
    }));
  }

  private fullReset(now: number): void {
    // 6s after match_end: back to the LOBBY — warmup, scores/round 0, money
    // reset, everyone back on knife+pistol (new pistol round economy), revived
    // at spawn. The room then WAITS: the next match needs another explicit
    // 'start', however many players are sitting in warmup.
    this.phase = 'warmup';
    this.phaseEndsAt = 0;
    this.round = 0;
    this.scoreT = 0;
    this.scoreCT = 0;
    this.lossStreak.t = 0;
    this.lossStreak.ct = 0;
    this.beginSpawnWave();
    for (const p of this.players.values()) {
      p.pending = false; // fresh match: nobody is sitting a round out any more
      p.balancedRound = -1;
      resetMatchStats(p); // back in the lobby: the scoreboard clears with the scores
      p.money = ECONOMY.start;
      p.weapons = ['knife', 'pistol'];
      p.ammo.clear();
      p.ammo.set('pistol', defaultAmmo('pistol'));
      this.setWeapon(p, 'pistol');
      this.placeAtSpawn(p, now);
    }
  }

  private abortToWarmup(now: number): void {
    // low-population abort (frozen): scores/money/round reset, owned list kept.
    // Back in the lobby: refilling the room does NOT resume — someone must
    // send 'start' again.
    this.phase = 'warmup';
    this.phaseEndsAt = 0;
    this.round = 0;
    this.scoreT = 0;
    this.scoreCT = 0;
    this.lossStreak.t = 0;
    this.lossStreak.ct = 0;
    for (const p of this.players.values()) {
      p.money = ECONOMY.start;
      p.spectateTarget = null;
      p.balancedRound = -1;
      resetMatchStats(p); // the aborted match's scoreboard dies with the match
      // the match is over: a mid-round joiner is a normal warmup player again
      p.pending = false;
      if (!p.alive && p.respawnAt === null) {
        // round-dead players (and ex-pending joiners) rejoin via the warmup timer
        p.respawnAt = now + ROUNDS.warmupRespawnDelay * 1000;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-player tick: reload completion, bloom recovery, warmup respawn, inputs.
  // -------------------------------------------------------------------------

  private tickPlayer(p: PlayerState, now: number): void {
    if (p.reloadUntil > 0 && now >= p.reloadUntil) this.completeReload(p);
    if (p.bloom > 0) p.bloom = Math.max(0, p.bloom - WEAPONS[p.weapon].spreadRecover * TICK_DT);
    if (!p.alive && this.phase === 'warmup' && p.respawnAt !== null && now >= p.respawnAt) {
      this.placeAtSpawn(p, now);
    }
    // consume inputs: everything while frozen (keeps ack current, no sim),
    // at most NET.maxInputPerTick otherwise (anti-speedhack)
    const q = p.inputQueue;
    const n = this.phase === 'freeze' ? q.length : Math.min(q.length, NET.maxInputPerTick);
    for (let i = 0; i < n; i++) {
      const msg = q[i];
      if (msg === undefined) break;
      this.applyInput(p, msg, now);
    }
    if (n >= q.length) q.length = 0;
    else if (n > 0) {
      q.copyWithin(0, n);
      q.length -= n;
    }
  }

  private applyInput(p: PlayerState, msg: InputMsg, now: number): void {
    p.lastProcessedSeq = msg.seq;
    p.yaw = msg.yaw;
    p.pitch = msg.pitch;
    p.scoped = (msg.buttons & INPUT_ALT) !== 0;
    const fireDown = (msg.buttons & INPUT_FIRE) !== 0;
    const fireEdge = fireDown && (p.prevButtons & INPUT_FIRE) === 0;
    p.prevButtons = msg.buttons;
    // frozen invariant: bodies step + damage applies ONLY in warmup/live;
    // freeze/roundEnd/matchEnd still ack + track aim (above) but never simulate
    if (!p.alive || (this.phase !== 'warmup' && this.phase !== 'live')) return;
    stepBody(
      p.body,
      {
        moveX: msg.moveX,
        moveZ: msg.moveZ,
        yaw: msg.yaw,
        jump: (msg.buttons & INPUT_JUMP) !== 0,
        crouch: (msg.buttons & INPUT_CROUCH) !== 0,
        walk: (msg.buttons & INPUT_WALK) !== 0,
      },
      WEAPONS[p.weapon].moveMul,
      TICK_DT,
      this.solids,
    );
    const def = WEAPONS[p.weapon];
    if (def.auto ? fireDown : fireEdge) this.tryFire(p, def, now);
  }

  // -------------------------------------------------------------------------
  // Fire + damage. Shots resolve via S3 resolveShot against the lag-compensated
  // target set; exactly one `shot` event per trigger pull.
  // -------------------------------------------------------------------------

  private tryFire(p: PlayerState, def: WeaponDef, now: number): void {
    if (p.reloadUntil > 0 || now < p.nextShotAt) return;
    const ammo = p.ammo.get(p.weapon);
    if (def.mag !== -1 && (ammo === undefined || ammo.mag <= 0)) return;
    p.shotSeq++;
    p.nextShotAt = now + def.interval * 1000;
    if (ammo !== undefined && def.mag !== -1) ammo.mag--;
    // C5: ONE pull, counted once, whatever the pellet count. Everything that
    // could have swallowed this pull — reloading, the fire-rate gate, an empty
    // magazine — already returned above, so reaching here IS the trigger pull.
    // The knife has no magazine (mag === -1) and consumes nothing, but a swing
    // is still a pull and can still land, so it counts on both sides; excluding
    // it would let knife hits push accuracy above 100%.
    p.shotsFired++;

    const origin = eyePos(p.body);
    const maxDist = def.id === 'knife' ? def.rangeEnd : 200; // per S3 table
    // lag compensation: rewind by the frozen formula, then drop teammates,
    // the dead, and spawn-protected players from the target set
    const rewind = rewindTicks(this.io.rttMs(p.id));
    const rewound = this.lag.at(Math.max(0, this.tickN - rewind), p.id);
    const targets = this.scratchTargets;
    targets.length = 0;
    for (const tgt of rewound) {
      const tp = this.players.get(tgt.id);
      if (tp === undefined || !tp.alive || tp.team === p.team) continue;
      if (now < tp.spawnProtectedUntil) continue;
      targets.push(tgt);
    }
    const ctx: ShotContext = {
      tick: this.tickN, shooterId: p.id, origin, yaw: p.yaw, pitch: p.pitch,
      weapon: def, bloomDeg: p.bloom, scoped: p.scoped,
      targets, solids: this.solids, maxDist,
    };
    const hits = resolveShot(ctx, shotSeed(this.tickN, p.shotSeq));
    // bloom applies AFTER the shot that caused it (first shot = base spread)
    p.bloom = Math.min(def.maxSpreadDeg, p.bloom + def.spreadPerShot);

    let closest: ShotHit | null = null;
    let credited = 0; // enemy HP this PULL removed, summed over its pellets
    for (const h of hits) {
      const victim = this.players.get(h.targetId);
      if (victim !== undefined) credited += this.applyDamage(victim, p, h, def, now);
      if (closest === null || h.dist < closest.dist) closest = h;
    }
    // C5: one pull that lands ANY damaging pellet is exactly one hit. Pellets
    // that arrived after the victim died, or landed on a spawn-protected or
    // same-team player, credited nothing and so do not make this a hit.
    if (credited > 0) p.shotsHit++;
    // one volley => one shot event: drives remote muzzle flash, tracers, sounds
    this.broadcast({
      t: 'shot',
      shooterId: p.id,
      weapon: def.id,
      from: origin,
      to: closest !== null ? closest.point : wallEndPoint(origin, aimDir(p.yaw, p.pitch), this.solids, maxDist),
    });
  }

  /**
   * Apply one pellet's damage. Returns the enemy HP this pellet is CREDITED with
   * removing, which is what C5's `damageDealt` is made of and what tells the
   * caller whether the pull counts as a hit:
   *  - post-ARMOUR: what the victim's hp bar actually lost, not what the weapon
   *    rolled (`hit.dmg`) — the vest eats its share and the roll overstates it;
   *  - no OVERKILL: a 40-damage hit on a 12-hp player is credited 12, because 12
   *    is all the HP there was to take;
   *  - never SELF- or TEAM damage. The target set in tryFire already excludes
   *    both, so this is a belt-and-braces guard on the accounting only: the
   *    damage itself still applies exactly as before if anything ever routes
   *    here, it simply earns the shooter nothing.
   * 0 means "nothing credited" — blocked, absorbed by the guards, or friendly.
   */
  private applyDamage(victim: PlayerState, shooter: PlayerState, hit: ShotHit, def: WeaponDef, now: number): number {
    if (!victim.alive || now < victim.spawnProtectedUntil) return 0;
    // frozen armor model: with points left, hp loses round(dmg*(1-absorb)) and
    // armor loses round(dmg*absorb); when armor runs out mid-hit the unsoaked
    // remainder rolls into hp. Headshots BYPASS armor unless a helmet is owned.
    let hpDmg = hit.dmg;
    if (victim.armor > 0 && (!hit.headshot || victim.helmet)) {
      const soaked = Math.round(hit.dmg * GEAR.absorb);
      hpDmg = Math.round(hit.dmg * (1 - GEAR.absorb));
      if (victim.armor >= soaked) {
        victim.armor -= soaked;
      } else {
        hpDmg += soaked - victim.armor; // armor ran out: unsoaked part rolls into hp
        victim.armor = 0;
      }
    }
    const hpBefore = victim.hp;
    victim.hp -= hpDmg;
    const killed = victim.hp <= 0;
    // hp can go negative on a killing blow; only what was actually there counts
    const removed = hpBefore - Math.max(0, victim.hp);
    const credited = shooter !== victim && shooter.team !== victim.team ? removed : 0;
    shooter.damageDealt += credited;
    this.sendEvent(shooter.id, { t: 'hit', victimId: victim.id, dmg: hit.dmg, headshot: hit.headshot, killed });
    // yaw = world yaw from the victim towards the shooter (inverse of aimDir)
    this.sendEvent(victim.id, {
      t: 'dmg_taken',
      fromId: shooter.id,
      dmg: hit.dmg,
      yaw: Math.atan2(-(shooter.body.x - victim.body.x), -(shooter.body.z - victim.body.z)),
    });
    if (killed) this.kill(victim, shooter, hit.headshot, def, now);
    return credited;
  }

  private kill(victim: PlayerState, killer: PlayerState | null, headshot: boolean, def: WeaponDef, now: number): void {
    victim.alive = false;
    victim.hp = 0;
    victim.deaths++;
    victim.reloadUntil = 0;
    victim.bloom = 0;
    // death drops gear (frozen): vest + helmet gone, armor points zeroed
    victim.armor = 0;
    victim.hasKevlar = false;
    victim.helmet = false;
    if (killer !== null) {
      killer.kills++;
      if (headshot) killer.headshots++;
      // multikill streak: within MULTIKILL_WINDOW of the killer's previous kill
      // extends it, otherwise it restarts at 1; dying resets the victim's own
      if (killer.lastKillAt > 0 && now - killer.lastKillAt <= MULTIKILL_WINDOW * 1000) {
        killer.streak++;
      } else {
        killer.streak = 1;
      }
      killer.lastKillAt = now;
    }
    victim.streak = 0;
    victim.lastKillAt = 0;
    if (killer !== null && killer.streak >= 2) {
      this.broadcast({ t: 'multikill', playerId: killer.id, count: Math.min(killer.streak, 5) });
    }
    if (killer !== null && this.phase !== 'warmup') killer.money = killReward(killer.money); // no economy in warmup
    this.broadcast({ t: 'kill', killerId: killer !== null ? killer.id : null, victimId: victim.id, weapon: def.id, headshot });
    if (this.phase === 'warmup') {
      // warmup: free respawn, owned list persists
      victim.respawnAt = now + ROUNDS.warmupRespawnDelay * 1000;
    } else {
      // rounds: death drops the primary — owned resets to knife+pistol
      victim.respawnAt = null;
      victim.weapons = ['knife', 'pistol'];
      victim.ammo.clear();
      victim.ammo.set('pistol', defaultAmmo('pistol'));
      this.setWeapon(victim, 'pistol');
    }
  }

  private pushLagBuffer(): void {
    // fresh entry objects: the ring buffer retains whatever we hand it
    const entries: Array<{ id: PlayerId; x: number; y: number; z: number; height: number }> = [];
    for (const p of this.players.values()) {
      if (p.alive) entries.push({ id: p.id, x: p.body.x, y: p.body.y, z: p.body.z, height: p.body.height });
    }
    this.lag.push(this.tickN, entries);
  }

  private checkElimination(now: number): void {
    const t = this.countAlive('T');
    const ct = this.countAlive('CT');
    if (t > 0 && ct > 0) return;
    if (t === 0 && ct === 0) this.endRound(null, 'elimination', now); // mutual: both loss rewards
    else this.endRound(t === 0 ? 'CT' : 'T', 'elimination', now);
  }

  // -------------------------------------------------------------------------
  // Snapshots (every tick, every player) + spectate targets.
  // -------------------------------------------------------------------------

  private updateSpectators(): void {
    for (const p of this.players.values()) {
      if (p.alive) {
        p.spectateTarget = null;
        continue;
      }
      if (this.phase === 'live' || this.phase === 'roundEnd' || this.phase === 'matchEnd') {
        const cur = p.spectateTarget !== null ? this.players.get(p.spectateTarget) : undefined;
        if (cur !== undefined && cur.alive && cur.team === p.team) continue; // still valid
        p.spectateTarget = this.firstAliveTeammate(p);
      } else {
        p.spectateTarget = null; // warmup: respawn incoming; freeze: all alive
      }
    }
  }

  private firstAliveTeammate(p: PlayerState): PlayerId | null {
    for (const o of this.players.values()) {
      if (o.id !== p.id && o.team === p.team && o.alive) return o.id;
    }
    return null;
  }

  private sendSnapshots(now: number): void {
    const list = this.snapPlayers;
    list.length = 0;
    for (const p of this.players.values()) {
      // mid-round joiners have no body this round: they are not in the world,
      // so they are not in ANYONE's snapshot (their own included). The client's
      // first-self-snapshot reset then rebases prediction when they do spawn.
      if (p.pending) continue;
      const s = p.snap;
      s.x = p.body.x;
      s.y = p.body.y;
      s.z = p.body.z;
      s.yaw = p.yaw;
      s.pitch = p.pitch;
      s.hp = p.hp;
      s.alive = p.alive;
      s.crouch = p.body.height < PLAYER.heightStand;
      s.moving = Math.hypot(p.body.vx, p.body.vz) > 0.5;
      s.weapon = p.weapon;
      list.push(s);
    }
    const canBuy = this.canBuyAt(now);
    // lobby gate, recomputed every tick so the button never lies: a leaver or a
    // removed bot flips canStart back to false on the very next snapshot
    const seated = this.players.size;
    const canStart = this.canStartMatch();
    for (const p of this.players.values()) {
      const def = WEAPONS[p.weapon];
      const ammo = p.ammo.get(p.weapon);
      const you = p.you;
      you.hp = p.hp;
      you.alive = p.alive;
      you.money = p.money;
      you.weapons = p.ownedOrdered;
      you.weapon = p.weapon;
      you.mag = def.mag === -1 ? -1 : ammo !== undefined ? ammo.mag : 0;
      you.reserve = def.reserve === -1 ? -1 : ammo !== undefined ? ammo.reserve : 0;
      you.canBuy = canBuy;
      you.spectateTarget = p.spectateTarget;
      you.respawnAt = p.respawnAt;
      you.vy = p.body.vy;
      you.armor = p.armor;
      you.helmet = p.helmet;
      you.joiningNextRound = p.pending;
      const m = p.snapshotMsg;
      m.tick = this.tickN;
      m.serverTime = now;
      m.ack = p.lastProcessedSeq;
      m.phase = this.phase;
      m.phaseEndsAt = this.phaseEndsAt;
      m.seated = seated;
      m.minPlayers = MIN_PLAYERS_FOR_MATCH;
      m.canStart = canStart;
      m.players = list; // shared + per-player you/ack: Session.send stringifies now
      this.io.send(p.id, m);
    }
  }

  // -------------------------------------------------------------------------
  // Spawns, weapons, roster, small helpers.
  // -------------------------------------------------------------------------

  private placeAtSpawn(p: PlayerState, now: number): void {
    const spawn = this.pickSpawn(p.team, p.id);
    p.body = makeBody(spawn.x, 0, spawn.z);
    p.yaw = spawn.yaw;
    p.pitch = 0;
    p.scoped = false;
    p.hp = PLAYER.maxHp;
    p.alive = true;
    p.reloadUntil = 0;
    p.bloom = 0;
    p.respawnAt = null;
    p.spectateTarget = null;
    p.inputQueue.length = 0;
    p.prevButtons = 0;
    p.spawnProtectedUntil = now + ROUNDS.spawnProtection * 1000;
  }

  /** A placement pass (round freeze, full reset) starts with a clean claim set. */
  private beginSpawnWave(): void {
    this.spawnTaken.T.clear();
    this.spawnTaken.CT.clear();
  }

  /**
   * Pick a spawn point for `self` on `team`.
   *
   * At 7 a side over 7 spawn points, picking randomly WITH REPLACEMENT puts two
   * teammates on the same point — two AABBs inside each other. So each pick
   * CLAIMS a spawn index for the current wave and never reuses a claimed one
   * while a free one exists; on top of that, any spawn with a living teammate
   * already within SPAWN_MIN_SEP is treated as occupied (this also covers
   * drop-ins, warmup respawns and team switches, which are waves of one).
   * The pre-existing "avoid spawning near a live enemy" rule is kept as the
   * weakest preference. Single bounded pass over the list: never loops, never
   * throws, and always returns a real spawn.
   */
  private pickSpawn(team: Team, self: PlayerId): SpawnPoint {
    const list = this.map.spawns[team];
    const taken = this.spawnTaken[team];
    if (list.length === 0) return { x: 0, z: 0, yaw: 0 }; // unreachable: maps ship >= 7
    if (taken.size >= list.length) taken.clear(); // more bodies than points: reuse from scratch
    // Penalties, ordered by severity, so the minimum is the least-crowded spawn.
    // A body on the point (100/teammate) always outweighs a stale claim (50),
    // which always outweighs a nearby enemy (10).
    let best = -1;
    let bestScore = Infinity;
    const offset = list.length > 0 ? Math.floor(this.next() * list.length) % list.length : 0;
    for (let i = 0; i < list.length; i++) {
      const idx = (offset + i) % list.length;
      const s = list[idx];
      if (s === undefined) continue;
      let score = this.teammatesWithin(team, self, s.x, s.z, SPAWN_MIN_SEP) * 100;
      if (taken.has(idx)) score += 50;
      if (this.enemyWithin(team, s.x, s.z, 10)) score += 10;
      if (score === 0) {
        best = idx;
        break;
      }
      if (score < bestScore) {
        bestScore = score;
        best = idx;
      }
    }
    const pick = best >= 0 ? list[best] : undefined;
    if (pick === undefined) return list[0] ?? { x: 0, z: 0, yaw: 0 };
    taken.add(best);
    return pick;
  }

  /** Living same-team players (excluding `self`) whose body is within `dist`. */
  private teammatesWithin(team: Team, self: PlayerId, x: number, z: number, dist: number): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (p.id === self || p.team !== team || !p.alive) continue;
      if (Math.hypot(p.body.x - x, p.body.z - z) < dist) n++;
    }
    return n;
  }

  private enemyWithin(team: Team, x: number, z: number, dist: number): boolean {
    for (const p of this.players.values()) {
      if (p.team === team || !p.alive) continue;
      if (Math.hypot(p.body.x - x, p.body.y, p.body.z - z) < dist) return true;
    }
    return false;
  }

  private refillWeapons(p: PlayerState): void {
    for (const w of p.weapons) {
      if (WEAPONS[w].mag !== -1) p.ammo.set(w, defaultAmmo(w));
    }
  }

  private completeReload(p: PlayerState): void {
    p.reloadUntil = 0;
    const def = WEAPONS[p.weapon];
    const ammo = p.ammo.get(p.weapon);
    if (def.mag === -1 || ammo === undefined) return;
    const take = Math.min(def.mag - ammo.mag, ammo.reserve);
    ammo.mag += take;
    ammo.reserve -= take;
  }

  private setWeapon(p: PlayerState, w: WeaponId): void {
    p.weapon = w;
    p.reloadUntil = 0; // switching cancels reload
    p.bloom = 0;
    this.rebuildOwnedOrdered(p);
  }

  private rebuildOwnedOrdered(p: PlayerState): void {
    p.ownedOrdered.length = 0;
    p.ownedOrdered.push(p.weapon);
    for (const w of p.weapons) if (w !== p.weapon) p.ownedOrdered.push(w);
  }

  private canBuyAt(now: number): boolean {
    return this.phase === 'freeze' || (this.phase === 'live' && now < this.buyOpenUntil);
  }

  private countConnected(team: Team): number {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n++;
    return n;
  }

  private countAlive(team: Team): number {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team && p.alive) n++;
    return n;
  }

  private rosterEntry(p: PlayerState, forId: PlayerId | null): RosterEntry {
    // money is populated only for the receiving player
    return {
      id: p.id, name: p.name, team: p.team,
      kills: p.kills, deaths: p.deaths, headshots: p.headshots,
      bot: p.bot,
      money: p.id === forId ? p.money : null,
      connected: true,
      joiningNextRound: p.pending, // scoreboard tag: seated, spawns next round
    };
  }

  private buildRoster(forId: PlayerId | null): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const p of this.players.values()) out.push(this.rosterEntry(p, forId));
    return out;
  }

  // one shared message object per event: Session.send JSON-encodes synchronously
  private broadcast(ev: GameEvent): void {
    const msg: S2C = { t: 'event', ev };
    for (const p of this.players.values()) this.io.send(p.id, msg);
  }

  private broadcastExcept(exclude: PlayerId, ev: GameEvent): void {
    const msg: S2C = { t: 'event', ev };
    for (const p of this.players.values()) {
      if (p.id !== exclude) this.io.send(p.id, msg);
    }
  }

  private sendEvent(id: PlayerId, ev: GameEvent): void {
    this.io.send(id, { t: 'event', ev });
  }
}
