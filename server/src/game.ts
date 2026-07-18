// ============================================================================
// server/src/game.ts (S2) — authoritative game room.
// Owns all mutable match state: phase machine, movement sim, fire/damage/death,
// round flow, economy glue, snapshots + events. Combat math is combat.ts (S3),
// buy rules are economy.ts (S3); socket/session handling is net.ts (S1).
// Behavioral invariants: CONTRACT.md "Behavioral invariants (S2)". Never throws.
// ============================================================================
import {
  ECONOMY,
  INPUT_ALT,
  INPUT_CROUCH,
  INPUT_FIRE,
  INPUT_JUMP,
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
  rewindTicks,
  rng,
  rngInt,
  rngPick,
  shotSeed,
  stepBody,
} from '@fps/shared';
import type {
  AABB,
  BodyState,
  C2S,
  GameEvent,
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
import { killReward, roundRewards, tryBuy } from './economy.js';

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
  kills: number;
  deaths: number;
  headshots: number;
  lastKillAt: number; // serverTime ms of this player's last kill, 0 = none
  streak: number; // multikill streak (kills within MULTIKILL_WINDOW of the previous)
  spawnProtectedUntil: number; // serverTime ms
  respawnAt: number | null; // warmup respawn timer, else null
  spectateTarget: PlayerId | null; // set while dead in a live round
  // preallocated wire objects, mutated in place per snapshot (no hot allocs)
  snap: PlayerSnap;
  you: YouSnap;
  snapshotMsg: SnapshotMsg;
}

const ROOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
let roomSeq = 0; // mixes into the rng seed so same-ms rooms still differ

function randomToken(next: () => number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET.charAt(rngInt(next, 0, ROOM_ALPHABET.length - 1));
  return s;
}

function defaultAmmo(w: WeaponId): Ammo {
  return { mag: WEAPONS[w].mag, reserve: WEAPONS[w].reserve };
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
  private readonly lag = new LagBuffer(NET.lagBufferTicks);
  private readonly next: () => number;

  private phase: RoomPhase = 'warmup';
  private phaseEndsAt = 0; // 0 during warmup/matchEnd per wire contract
  private round = 0; // 0 during warmup, 1..N during a match
  private scoreT = 0;
  private scoreCT = 0;
  private tickN = 0;
  private buyOpenUntil = 0; // serverTime ms; canBuy while live && now < this
  private matchEndResetAt = 0; // serverTime ms; warmup reset 6s after match_end
  private timer: ReturnType<typeof setInterval> | null = null;

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

  info(): RoomInfo {
    return {
      id: this.id,
      code: this.code,
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

  addPlayer(id: PlayerId, name: string): void {
    try {
      if (this.players.has(id) || this.players.size >= MAX_PLAYERS) return;
      const now = Date.now();
      // auto-assign the smaller team, coin flip on tie
      const t = this.countConnected('T');
      const ct = this.countConnected('CT');
      const team: Team = t < ct ? 'T' : ct < t ? 'CT' : this.next() < 0.5 ? 'T' : 'CT';

      const snap: PlayerSnap = {
        id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
        hp: PLAYER.maxHp, alive: true, crouch: false, moving: false, weapon: 'pistol',
      };
      const you: YouSnap = {
        hp: PLAYER.maxHp, alive: true, money: ECONOMY.start,
        weapons: ['pistol', 'knife'], weapon: 'pistol',
        mag: WEAPONS.pistol.mag, reserve: WEAPONS.pistol.reserve,
        canBuy: false, spectateTarget: null, respawnAt: null, vy: 0,
      };
      const snapshotMsg: SnapshotMsg = {
        t: 'snapshot', tick: 0, serverTime: 0, ack: 0,
        phase: this.phase, phaseEndsAt: 0, players: [], you,
      };
      const p: PlayerState = {
        id, name, team,
        body: makeBody(0, 0, 0),
        yaw: 0, pitch: 0, scoped: false,
        inputQueue: [], lastProcessedSeq: 0, lastInputAt: now,
        inputWindow: 0, inputWindowCount: 0, prevButtons: 0,
        weapons: ['knife', 'pistol'], ownedOrdered: ['pistol', 'knife'], weapon: 'pistol',
        ammo: new Map<WeaponId, Ammo>([['pistol', defaultAmmo('pistol')]]),
        reloadUntil: 0, nextShotAt: 0, bloom: 0, shotSeq: 0,
        hp: PLAYER.maxHp, alive: true,
        money: ECONOMY.start, kills: 0, deaths: 0, headshots: 0,
        lastKillAt: 0, streak: 0,
        spawnProtectedUntil: 0, respawnAt: null, spectateTarget: null,
        snap, you, snapshotMsg,
      };
      this.players.set(id, p);
      this.placeAtSpawn(p, now); // drop-in: always spawn alive, with protection
      this.io.send(id, {
        t: 'joined', roomId: this.id, code: this.code, mapId: this.mapId,
        you: id, team, tick: this.tickN, serverTime: now,
        round: this.round, scoreT: this.scoreT, scoreCT: this.scoreCT,
        roster: this.buildRoster(id),
      });
      this.broadcastExcept(id, { t: 'player_joined', entry: this.rosterEntry(p, null) });
    } catch (err) {
      console.error('[game] addPlayer failed', err);
    }
  }

  removePlayer(id: PlayerId): void {
    try {
      if (!this.players.delete(id)) return;
      this.broadcast({ t: 'player_left', id });
    } catch (err) {
      console.error('[game] removePlayer failed', err);
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
      p.inputWindowCount++;
      if (p.inputWindowCount > NET.inputQueueCap) {
        this.removePlayer(id); // S1 owns the socket close
        return;
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
    for (const p of this.players.values()) this.tickPlayer(p, now);
    this.pushLagBuffer();
    if (this.phase === 'live') this.checkElimination(now);
    this.updateSpectators();
    this.sendSnapshots(now);
  }

  // -------------------------------------------------------------------------
  // Phase machine: warmup -> freeze -> live -> roundEnd -> (halftime) ->
  // matchEnd -> warmup. All timings from ROUNDS.
  // -------------------------------------------------------------------------

  private advancePhase(now: number): void {
    switch (this.phase) {
      case 'warmup':
        if (this.players.size >= MIN_PLAYERS_FOR_MATCH) this.beginFreeze(1, now);
        return;
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
    for (const p of this.players.values()) {
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
    // winner null (mutual elimination) => both teams get the loss reward
    const rewards = roundRewards(winner);
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
    this.broadcast({ t: 'match_end', winner, scoreT: this.scoreT, scoreCT: this.scoreCT });
  }

  private fullReset(now: number): void {
    // 6s after match_end: fresh match — warmup, scores/round 0, money reset,
    // everyone back on knife+pistol (new pistol round economy), revived at spawn
    this.phase = 'warmup';
    this.phaseEndsAt = 0;
    this.round = 0;
    this.scoreT = 0;
    this.scoreCT = 0;
    for (const p of this.players.values()) {
      p.money = ECONOMY.start;
      p.weapons = ['knife', 'pistol'];
      p.ammo.clear();
      p.ammo.set('pistol', defaultAmmo('pistol'));
      this.setWeapon(p, 'pistol');
      this.placeAtSpawn(p, now);
    }
  }

  private abortToWarmup(now: number): void {
    // low-population abort (frozen): scores/money/round reset, owned list kept
    this.phase = 'warmup';
    this.phaseEndsAt = 0;
    this.round = 0;
    this.scoreT = 0;
    this.scoreCT = 0;
    for (const p of this.players.values()) {
      p.money = ECONOMY.start;
      p.spectateTarget = null;
      if (!p.alive && p.respawnAt === null) {
        // round-dead players rejoin via the warmup respawn timer
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
    for (const h of hits) {
      const victim = this.players.get(h.targetId);
      if (victim !== undefined) this.applyDamage(victim, p, h, def, now);
      if (closest === null || h.dist < closest.dist) closest = h;
    }
    // one volley => one shot event: drives remote muzzle flash, tracers, sounds
    this.broadcast({
      t: 'shot',
      shooterId: p.id,
      weapon: def.id,
      from: origin,
      to: closest !== null ? closest.point : wallEndPoint(origin, aimDir(p.yaw, p.pitch), this.solids, maxDist),
    });
  }

  private applyDamage(victim: PlayerState, shooter: PlayerState, hit: ShotHit, def: WeaponDef, now: number): void {
    if (!victim.alive || now < victim.spawnProtectedUntil) return;
    victim.hp -= hit.dmg;
    const killed = victim.hp <= 0;
    this.sendEvent(shooter.id, { t: 'hit', victimId: victim.id, dmg: hit.dmg, headshot: hit.headshot, killed });
    // yaw = world yaw from the victim towards the shooter (inverse of aimDir)
    this.sendEvent(victim.id, {
      t: 'dmg_taken',
      fromId: shooter.id,
      dmg: hit.dmg,
      yaw: Math.atan2(-(shooter.body.x - victim.body.x), -(shooter.body.z - victim.body.z)),
    });
    if (killed) this.kill(victim, shooter, hit.headshot, def, now);
  }

  private kill(victim: PlayerState, killer: PlayerState, headshot: boolean, def: WeaponDef, now: number): void {
    victim.alive = false;
    victim.hp = 0;
    victim.deaths++;
    victim.reloadUntil = 0;
    victim.bloom = 0;
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
    victim.streak = 0;
    victim.lastKillAt = 0;
    if (killer.streak >= 2) {
      this.broadcast({ t: 'multikill', playerId: killer.id, count: Math.min(killer.streak, 5) });
    }
    if (this.phase !== 'warmup') killer.money = killReward(killer.money); // no economy in warmup
    this.broadcast({ t: 'kill', killerId: killer.id, victimId: victim.id, weapon: def.id, headshot });
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
      const m = p.snapshotMsg;
      m.tick = this.tickN;
      m.serverTime = now;
      m.ack = p.lastProcessedSeq;
      m.phase = this.phase;
      m.phaseEndsAt = this.phaseEndsAt;
      m.players = list; // shared + per-player you/ack: Session.send stringifies now
      this.io.send(p.id, m);
    }
  }

  // -------------------------------------------------------------------------
  // Spawns, weapons, roster, small helpers.
  // -------------------------------------------------------------------------

  private placeAtSpawn(p: PlayerState, now: number): void {
    const spawn = this.pickSpawn(p.team);
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

  private pickSpawn(team: Team): SpawnPoint {
    const list = this.map.spawns[team];
    let pick = rngPick(this.next, list);
    // retry up to 4x while an alive enemy is within 10m, then accept
    for (let attempt = 0; attempt < 4 && this.enemyWithin(team, pick.x, pick.z, 10); attempt++) {
      pick = rngPick(this.next, list);
    }
    return pick;
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
      money: p.id === forId ? p.money : null,
      connected: true,
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
