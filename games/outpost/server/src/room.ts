// ============================================================================
// srv-room — THE SERVER INTEGRATOR.
//
// OutpostRoom owns the SimContext, the preallocated zombie/spit/segment pools,
// the setInterval tick loop, the phase machine (lobby -> wave -> intermission
// -> ended), the spawn drip, snapshot assembly, input ingestion (with
// STRICKEN's anti-speedhack bucket), stalePlayers(), and rejoin/ghosting.
//
// It calls into waves.ts / horde.ts / fence.ts / survivors.ts / combat.ts
// through their frozen public functions and never reaches past them. Every
// public method is try/catch: one bad tick must not kill the interval, one
// malformed message must not throw across the socket boundary.
//
// Tick order (FIXED, per CONTRACT.md):
//   advancePhase -> ingest inputs & step survivors (stepBody) -> resolveInteract
//   -> stepRevives -> stepDowned -> stepHorde -> stepSpits -> checkSquadWipe
//   -> snapshot
// `applyInvulnerability()` runs between stepSpits and checkSquadWipe — see its
// doc for why: it is a room-owned patch for a debug-only affordance that has
// no field on the frozen Survivor struct to hang off (CONTRACT GAP, documented
// there and in this module's return summary).
// ============================================================================
import { PLAYER, makeBody, stepBody } from '@fps/shared';
import type { WeaponDef, WeaponId } from '@fps/shared';
import { rng, rngInt } from '@platform/shared';
import type { GameRoomHandle, PlayerId, RoomId, RoomInfo, Visibility } from '@platform/shared';
import {
  ECONOMY,
  FENCE,
  GAME_ID,
  GAME_NAME,
  HORDE,
  INPUT_CROUCH,
  INPUT_FIRE,
  INPUT_ALT,
  INPUT_INTERACT,
  INPUT_JUMP,
  INPUT_WALK,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NETCODE,
  SIM_HZ,
  STATIC_SOLIDS,
  SURVIVOR,
  SURVIVOR_SPAWNS,
  TICK_DT,
  WAVES,
  WEAPONS,
  parseC2S,
} from '@outpost/shared';
import type {
  DebugMsg,
  FenceSegment,
  InputMsg,
  OutpostEvent,
  RosterEntry,
  RunStats,
  S2C,
  SegmentSnap,
  SimContext,
  SnapshotMsg,
  Spit,
  SpitSnap,
  Survivor,
  SurvivorSnap,
  TimeOfDay,
  YouSnap,
  Zombie,
  ZombieKind,
  ZombieSnap,
} from '@outpost/shared';
import { damageSegment, fenceSolids, repairSegment } from './fence.js';
import { spawnZombie, stepHorde, stepSpits } from './horde.js';
import { waveComposition, waveSize } from './waves.js';
import { damageSurvivor, isSquadWiped, resolveInteract, stepDowned, stepRevives } from './survivors.js';
import { resolveShot } from './combat.js';

// ---------------------------------------------------------------------------
// Frozen wire surface (CONTRACT.md's room.ts section, mirroring games/fps's
// server/src/game.ts RoomIO shape). Structurally compatible with the
// platform's generic RoomIO (send accepts `unknown`, a supertype of S2C), so
// module.ts's `new OutpostRoom(opts.visibility, opts.io)` passes through
// unchanged.
// ---------------------------------------------------------------------------
export interface RoomIO {
  send(id: PlayerId, msg: S2C): void;
  rttMs(id: PlayerId): number;
}

/** Injectable clock/rng for deterministic tests (vi.useFakeTimers() + a fixed rand). */
export interface RoomDeps {
  rand(): number;
  now(): number;
}

type WireSet = { snap: SurvivorSnap; you: YouSnap; msg: SnapshotMsg };

const ROOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PRIVATE_CODE_LEN = 5;
/** Upgrade-tier firearms: with SURVIVOR.firearmSlots === 2 and the pistol
 *  permanently occupying one slot, exactly one of these may be owned at a
 *  time — buying a new one replaces whichever is currently held. This
 *  replace-on-buy policy is room.ts's own call (no sibling module owns
 *  weapon-rack economics; see this module's return summary). */
const UPGRADE_TIERS: readonly WeaponId[] = ['shotgun', 'smg', 'rifle', 'sniper'];

let roomSeq = 0; // mixes into the id/code rng seed so same-ms rooms still differ

function randomToken(next: () => number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET.charAt(rngInt(next, 0, ROOM_ALPHABET.length - 1));
  return s;
}

/** Stable deterministic spawn-point index for a player id (FNV-1a hash mod
 *  SURVIVOR_SPAWNS.length). Survivor has no room for a "which spawn slot"
 *  field, and this needs to be the SAME slot on rejoin/respawn without extra
 *  room-side bookkeeping. */
function spawnIndexFor(id: PlayerId): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % SURVIVOR_SPAWNS.length;
}

function defaultAmmo(w: WeaponId): { mag: number; reserve: number } {
  return { mag: WEAPONS[w].mag, reserve: WEAPONS[w].reserve };
}

export class OutpostRoom implements GameRoomHandle {
  readonly id: RoomId;
  readonly code: string | null;

  private readonly visibility: Visibility;
  private readonly io: RoomIO;
  private readonly deps: RoomDeps;
  private readonly debugEnabled: boolean;

  private readonly ctx: SimContext;
  private phaseEndsAt = 0; // ms; 0 outside intermission
  private nextWaveAt = 0; // ms; the wave CLOCK — wave N+1 lands here regardless of clearing
  private wavePlayers = 0; // headcount frozen for the CURRENT wave's size + spawn rate
  private spawnQueue: ZombieKind[] = [];
  private spawnAccum = 0; // fractional zombies-per-tick accumulator
  private timer: ReturnType<typeof setInterval> | null = null;

  // per-player wire objects, preallocated at join and mutated in place —
  // Survivor itself carries no wire fields (frozen struct), so these live in
  // a parallel map keyed by PlayerId.
  private readonly wire = new Map<PlayerId, WireSet>();
  // debug-only invulnerability flags (see applyInvulnerability's doc — no
  // field for this exists on the frozen Survivor struct).
  private readonly invuln = new Set<PlayerId>();
  // edge-tracks "this player's held repair is currently denied for scrap"
  // so stepInteract emits buy_result once per denial onset, not every tick
  // INTERACT is held against an unaffordable segment (frozen Survivor has no
  // field to carry this either).
  private readonly repairDenied = new Set<PlayerId>();

  // preallocated zombie/spit/segment pools — sized once, NEVER resized.
  private readonly zombieSnapPool: ZombieSnap[];
  private readonly spitSnapPool: SpitSnap[];
  private readonly segmentSnapList: SegmentSnap[];
  // packed per-snapshot output lists — the arrays themselves are reused
  // (.length = 0 + push), their contents are pointers into the pools above.
  private readonly survivorSnapList: SurvivorSnap[] = [];
  private readonly zombieSnapList: ZombieSnap[] = [];
  private readonly spitSnapList: SpitSnap[] = [];

  constructor(visibility: Visibility, io: RoomIO, deps?: RoomDeps, settings?: Record<string, unknown>) {
    this.visibility = visibility;
    this.io = io;
    this.deps =
      deps ??
      {
        rand: rng((Date.now() ^ ((roomSeq++) * 0x9e3779b9)) >>> 0),
        now: () => Date.now(),
      };
    // CONTRACT GAP: the frozen constructor signature `(visibility, io, deps?)`
    // has no way to receive `settings.debug`, yet CONTRACT.md's own
    // "Authorization" section requires DebugMsg to be gated on
    // `settings.debug === true`. module.ts (already written, not mine) calls
    // `new OutpostRoom(opts.visibility, opts.io)` and never forwards
    // `opts.settings` either. `settings` is added here as an ADDITIVE optional
    // 4th parameter — every 3-arg call site (module.ts, this room's own
    // tests) still compiles unchanged — so debug mode is reachable at all,
    // but production rooms created via the real registry path currently
    // never enable it. See this module's return summary for the exact
    // one-line fix module.ts needs.
    this.debugEnabled = settings?.['debug'] === true;

    const idRand = rng((this.deps.now() ^ ((roomSeq++) * 0x9e3779b9)) >>> 0);
    this.id = randomToken(idRand, 8);
    this.code = visibility === 'private' ? randomToken(idRand, PRIVATE_CODE_LEN) : null;

    const zombies: Zombie[] = Array.from({ length: HORDE.maxAlive }, (_, i): Zombie => ({
      id: i,
      kind: 'shambler',
      alive: false,
      hp: 0,
      maxHp: 0,
      body: makeBody(0, 0, 0),
      yaw: 0,
      height: 0,
      radius: 0,
      speed: 0,
      state: 'approach',
      targetSeg: -1,
      targetPlayer: null,
      retargetAt: 0,
      attackCooldown: 0,
      spitCooldown: 0,
      dyingFor: 0,
      gait: 0,
    }));
    const spits: Spit[] = Array.from({ length: HORDE.maxAlive }, (_, i): Spit => ({
      id: i,
      alive: false,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      ttl: 0,
      ownerId: -1,
    }));
    const segments: FenceSegment[] = Array.from({ length: FENCE.segments }, (_, i): FenceSegment => ({
      id: i,
      hp: FENCE.segmentHp,
      maxHp: FENCE.segmentHp,
      breached: false,
      rebuild: 0,
      sinceHit: 0,
    }));

    this.zombieSnapPool = Array.from({ length: HORDE.maxAlive }, (_, i): ZombieSnap => ({
      id: i, k: 'shambler', x: 0, y: 0, z: 0, yaw: 0, hp: 0, st: 'approach', g: 0,
    }));
    this.spitSnapPool = Array.from({ length: HORDE.maxAlive }, (_, i): SpitSnap => ({ id: i, x: 0, y: 0, z: 0 }));
    this.segmentSnapList = segments.map((seg): SegmentSnap => ({
      hp: seg.maxHp > 0 ? seg.hp / seg.maxHp : 0,
      br: seg.breached,
      rb: seg.rebuild,
    }));

    this.ctx = {
      tick: 0,
      dt: TICK_DT,
      serverTime: this.deps.now(),
      phase: 'lobby',
      wave: 0,
      survivors: new Map(),
      zombies,
      segments,
      spits,
      staticSolids: STATIC_SOLIDS,
      solids: [...STATIC_SOLIDS, ...fenceSolids(segments)],
      rand: () => this.deps.rand(),
      emit: (ev: OutpostEvent) => this.broadcastEvent(ev),
      rebuildSolids: () => {
        this.ctx.solids = [...STATIC_SOLIDS, ...fenceSolids(this.ctx.segments)];
      },
    };
  }

  // -------------------------------------------------------------------------
  // GameRoomHandle
  // -------------------------------------------------------------------------

  info(): RoomInfo {
    return {
      id: this.id,
      code: this.code,
      game: GAME_ID,
      label: GAME_NAME,
      players: this.playerCount(),
      maxPlayers: MAX_PLAYERS,
      phase: this.ctx.phase,
      visibility: this.visibility,
    };
  }

  /** CONNECTED survivors only — a ghost holding a seat is not a browsable player. */
  playerCount(): number {
    let n = 0;
    for (const s of this.ctx.survivors.values()) if (s.connected) n++;
    return n;
  }

  stalePlayers(): PlayerId[] {
    const now = this.now();
    const out: PlayerId[] = [];
    for (const s of this.ctx.survivors.values()) {
      if (!s.connected) continue;
      if (now - s.lastInputAt > NETCODE.inputTimeoutMs) out.push(s.id);
    }
    return out;
  }

  addPlayer(id: PlayerId, name: string, resume?: PlayerId, sig?: string): void {
    try {
      if (this.ctx.survivors.has(id)) return;
      if (this.tryRebind(id, name, resume, sig)) return;
      // CONNECTED count, not survivors.size: a ghosted (connected=false, kept
      // for tryRebind) survivor still holds an entry in ctx.survivors but is
      // gone for good if it never reconnects, and nothing ever expires that
      // entry — gating on raw seat count would let ghosts permanently wall
      // off a seat, silently stranding a new joiner's session (mapped to the
      // room by lobby.ts before addPlayer runs) with no seat and no error.
      if (this.playerCount() >= MAX_PLAYERS) return; // full: no bots to evict, co-op has none
      this.joinSurvivor(id, name, sig ?? null);
    } catch (err) {
      console.error('[outpost] addPlayer failed', err);
    }
  }

  /**
   * permanent=true, or the seat holds nothing at stake yet (still in lobby):
   * remove outright. Otherwise ghost — `connected=false`, seat retained for
   * `tryRebind`. Survivor.id is READONLY (unlike STRICKEN's PlayerState.id),
   * so a rebind cannot re-key the same object in place; see `tryRebind`.
   */
  removePlayer(id: PlayerId, permanent?: boolean): void {
    try {
      const s = this.ctx.survivors.get(id);
      if (s === undefined) return;
      if (permanent === true || this.ctx.phase === 'lobby') {
        this.ctx.survivors.delete(id);
        this.wire.delete(id);
        this.invuln.delete(id);
        this.repairDenied.delete(id);
        this.broadcastEvent({ t: 'player_left', id });
        return;
      }
      s.connected = false;
      this.broadcastEvent({ t: 'player_left', id });
    } catch (err) {
      console.error('[outpost] removePlayer failed', err);
    }
  }

  handleMessage(id: PlayerId, msg: unknown): void {
    try {
      const parsed = parseC2S(msg);
      if (parsed === null) return;
      const now = this.now();
      switch (parsed.t) {
        case 'input':
          this.handleInput(id, parsed);
          return;
        case 'reload':
          this.handleReload(id, now);
          return;
        case 'switch':
          this.handleSwitch(id, parsed.weapon);
          return;
        case 'buy_weapon':
          this.handleBuyWeapon(id, parsed.weapon);
          return;
        case 'buy_ammo':
          this.handleBuyAmmo(id);
          return;
        case 'start':
          this.handleStart(id, parsed.seed, now);
          return;
        case 'ping':
          this.handlePing(id, parsed.ts, now);
          return;
        case 'debug':
          this.handleDebug(id, parsed);
          return;
        default:
          return;
      }
    } catch (err) {
      console.error('[outpost] handleMessage failed', err);
    }
  }

  start(): void {
    if (this.timer !== null) return; // idempotent
    this.timer = setInterval(() => this.tickGuarded(), 1000 / SIM_HZ);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Rejoin
  // -------------------------------------------------------------------------

  private tryRebind(newId: PlayerId, name: string, resume: PlayerId | undefined, sig: string | undefined): boolean {
    let old: Survivor | undefined;
    let oldId: PlayerId | undefined;
    if (resume !== undefined) {
      const byResume = this.ctx.survivors.get(resume);
      if (byResume !== undefined && !byResume.connected) {
        old = byResume;
        oldId = resume;
      }
    }
    if (old === undefined && sig !== undefined) {
      for (const [id, s] of this.ctx.survivors) {
        if (!s.connected && s.sig === sig) {
          old = s;
          oldId = id;
          break;
        }
      }
    }
    if (old === undefined || oldId === undefined) return false;

    const now = this.now();
    // Survivor.id is readonly: cannot re-key the SAME object like STRICKEN
    // does. Build a fresh Survivor carrying every stateful field forward
    // (economy, weapons, position, stats) under the new id instead.
    const revived: Survivor = {
      ...old,
      id: newId,
      name,
      sig: sig ?? old.sig,
      connected: true,
      lastProcessedSeq: 0,
      lastInputAt: now,
      inputWindow: 0,
      inputWindowCount: 0,
      prevButtons: 0,
      inputQueue: [],
    };
    this.ctx.survivors.delete(oldId);
    this.ctx.survivors.set(newId, revived);

    const oldWire = this.wire.get(oldId);
    this.wire.delete(oldId);
    if (oldWire !== undefined) {
      oldWire.snap.id = newId;
      this.wire.set(newId, oldWire);
    } else {
      this.wire.set(newId, this.freshWire(newId, name));
    }
    if (this.invuln.delete(oldId)) this.invuln.add(newId);

    this.io.send(newId, {
      t: 'joined',
      roomId: this.id,
      code: this.code,
      you: newId,
      tick: this.ctx.tick,
      serverTime: now,
      phase: this.ctx.phase,
      wave: this.ctx.wave,
      roster: this.buildRoster(),
    });
    this.broadcastExcept(newId, { t: 'event', ev: { t: 'player_joined', entry: this.rosterEntry(revived) } });
    return true;
  }

  private freshWire(id: PlayerId, name: string): WireSet {
    const you: YouSnap = {
      hp: 0, status: 'alive', bleedout: 0, scrap: 0, weapons: [], weapon: 'pistol',
      mag: 0, reserve: 0, vy: 0, interact: 'none', interactProgress: 0, interactCost: 0, returnAtWave: 0,
    };
    const snap: SurvivorSnap = {
      id, n: name, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 0, st: 'alive',
      cr: false, mv: false, w: 'pistol', rev: 0, revBy: null, bl: 0, k: 0, rv: 0,
    };
    const msg: SnapshotMsg = {
      t: 'snapshot', tick: 0, serverTime: 0, ack: 0, phase: this.ctx.phase, wave: this.ctx.wave,
      phaseEndsAt: 0, waveRemaining: 0, tod: 'dusk', players: [], zombies: [], segments: [], spits: [],
      you, seated: 0, minPlayers: MIN_PLAYERS, canStart: false,
    };
    return { snap, you, msg };
  }

  private joinSurvivor(id: PlayerId, name: string, sig: string | null): void {
    const now = this.now();
    const s: Survivor = {
      id, name, connected: true, sig,
      body: makeBody(0, 0, 0), yaw: 0, pitch: 0,
      hp: SURVIVOR.maxHp, status: 'alive', lastDamageAt: now, bleedout: 0,
      reviveProgress: 0, reviveBy: null, returnAtWave: 0,
      scrap: SURVIVOR.startScrap,
      weapons: ['pistol', 'knife'], // "current first" — pistol is issued as the active weapon
      weapon: 'pistol',
      ammo: new Map([['pistol', defaultAmmo('pistol')]]),
      reloadUntil: 0, nextShotAt: 0, bloom: 0, shotSeq: 0,
      interacting: false, scoped: false, interactKind: 'none', interactTarget: -1, reviveTargetId: null,
      kills: 0, headshots: 0, damageDealt: 0, repairHp: 0, revivesGiven: 0, timesDowned: 0,
      inputQueue: [], lastProcessedSeq: 0, lastInputAt: now, prevButtons: 0, inputWindow: 0, inputWindowCount: 0,
    };
    this.placeAtSpawn(s, now);
    this.ctx.survivors.set(id, s);
    this.wire.set(id, this.freshWire(id, name));

    this.io.send(id, {
      t: 'joined',
      roomId: this.id,
      code: this.code,
      you: id,
      tick: this.ctx.tick,
      serverTime: now,
      phase: this.ctx.phase,
      wave: this.ctx.wave,
      roster: this.buildRoster(),
    });
    this.broadcastExcept(id, { t: 'event', ev: { t: 'player_joined', entry: this.rosterEntry(s) } });
  }

  private rosterEntry(s: Survivor): RosterEntry {
    return { id: s.id, name: s.name, status: s.status, kills: s.kills, revivesGiven: s.revivesGiven, connected: s.connected };
  }

  private buildRoster(): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const s of this.ctx.survivors.values()) out.push(this.rosterEntry(s));
    return out;
  }

  private broadcastExcept(exceptId: PlayerId, msg: S2C): void {
    for (const s of this.ctx.survivors.values()) {
      if (s.connected && s.id !== exceptId) this.io.send(s.id, msg);
    }
  }

  /** Reset a survivor to full health at their (stable, id-hashed) spawn point.
   *  Used at first join AND when a dead survivor returns at the next wave —
   *  economy/weapons/stats are NOT touched here; they persist across the run. */
  private placeAtSpawn(s: Survivor, now: number): void {
    const spawn = SURVIVOR_SPAWNS[spawnIndexFor(s.id)] ?? SURVIVOR_SPAWNS[0];
    if (spawn === undefined) return; // SURVIVOR_SPAWNS is never empty; defensive only
    s.body = makeBody(spawn.x, spawn.y, spawn.z);
    s.yaw = spawn.yaw;
    s.pitch = 0;
    s.hp = SURVIVOR.maxHp;
    s.status = 'alive';
    s.lastDamageAt = now;
    s.bleedout = 0;
    s.reviveProgress = 0;
    s.reviveBy = null;
    s.interacting = false;
    s.interactKind = 'none';
    s.interactTarget = -1;
    s.reviveTargetId = null;
    s.reloadUntil = 0;
    s.nextShotAt = 0;
    s.bloom = 0;
    s.prevButtons = 0;
    s.inputQueue.length = 0;
  }

  // -------------------------------------------------------------------------
  // Tick. try/catch at the boundary: one bad tick must never kill the interval.
  // -------------------------------------------------------------------------

  private tickGuarded(): void {
    try {
      this.tick();
    } catch (err) {
      console.error('[outpost] tick failed', err);
    }
  }

  private tick(): void {
    const ctx = this.ctx;
    ctx.tick++;
    const now = this.now();
    ctx.serverTime = now;

    this.advancePhase(now);
    this.stepSurvivors(now);
    this.stepInteract();
    stepRevives(ctx);
    stepDowned(ctx);
    stepHorde(ctx);
    stepSpits(ctx);
    this.applyInvulnerability();
    this.checkSquadWipe();

    if (ctx.tick % NETCODE.snapshotEveryTicks === 0) this.sendSnapshots(now);
  }

  // -------------------------------------------------------------------------
  // Phase machine: lobby -> intermission (opening lull OR post-wave) -> wave
  // -> ... -> ended. lobby NEVER ends itself — only handleStart leaves it.
  // -------------------------------------------------------------------------

  private advancePhase(now: number): void {
    const ctx = this.ctx;
    if (ctx.phase === 'lobby' || ctx.phase === 'ended') return;
    if (ctx.phase === 'intermission') {
      if (now >= this.phaseEndsAt) this.beginWave(now);
      return;
    }
    // phase === 'wave'. The clock wins: the next wave lands on schedule even
    // with the previous one still on its feet, so leftovers accumulate.
    if (now >= this.nextWaveAt) {
      this.beginWave(now);
      return;
    }
    if (this.spawnQueue.length === 0 && this.aliveThreatCount() === 0) {
      this.beginIntermission(now);
      return;
    }
    this.stepSpawnDrip();
  }

  private beginWave(now: number): void {
    const ctx = this.ctx;
    ctx.wave += 1;
    this.nextWaveAt = now + WAVES.wavePeriodSec * 1000;
    this.wavePlayers = this.playerCount();
    const count = waveSize(ctx.wave, this.wavePlayers);
    this.spawnQueue = waveComposition(ctx.wave, count, ctx.rand);
    this.spawnAccum = 0;
    ctx.phase = 'wave';
    this.phaseEndsAt = 0;
    this.broadcastEvent({ t: 'wave_start', wave: ctx.wave, count, tod: this.currentTod() });
  }

  private beginIntermission(now: number): void {
    const ctx = this.ctx;
    ctx.phase = 'intermission';
    this.phaseEndsAt = Math.min(now + WAVES.intermissionSec * 1000, this.nextWaveAt);
    this.returnDeadSurvivors(ctx.wave + 1, now);
    this.broadcastEvent({ t: 'wave_clear', wave: ctx.wave, intermissionEndsAt: this.phaseEndsAt });
  }

  private returnDeadSurvivors(nextWave: number, now: number): void {
    for (const s of this.ctx.survivors.values()) {
      if (s.status !== 'dead' || s.returnAtWave > nextWave) continue;
      this.placeAtSpawn(s, now);
      this.broadcastEvent({ t: 'returned', id: s.id });
    }
  }

  private stepSpawnDrip(): void {
    if (this.spawnQueue.length === 0) return;
    const rate = WAVES.spawnPerSecBase * (WAVES.playerBase + WAVES.playerStep * this.wavePlayers);
    this.spawnAccum += rate * TICK_DT;
    while (this.spawnAccum >= 1 && this.spawnQueue.length > 0) {
      this.spawnAccum -= 1;
      const kind = this.spawnQueue.shift();
      if (kind === undefined) break;
      // Pool full (HORDE.maxAlive): put it back at the front and stop
      // draining this tick rather than discarding it — HORDE.maxAlive's doc
      // promises excess queues and drips in as others die.
      if (spawnZombie(this.ctx, kind, this.ctx.wave) === -1) {
        this.spawnQueue.unshift(kind);
        break;
      }
    }
  }

  private aliveThreatCount(): number {
    let n = 0;
    for (const z of this.ctx.zombies) if (z.alive && z.state !== 'dying') n++;
    return n;
  }

  private currentTod(): TimeOfDay {
    return this.ctx.wave >= WAVES.nightFromWave ? 'night' : 'dusk';
  }

  private checkSquadWipe(): void {
    if (this.ctx.phase === 'ended') return;
    if (isSquadWiped(this.ctx.survivors)) this.endRun();
  }

  private endRun(): void {
    const ctx = this.ctx;
    ctx.phase = 'ended';
    this.phaseEndsAt = 0;
    const stats: RunStats[] = [];
    for (const s of ctx.survivors.values()) {
      stats.push({
        id: s.id, name: s.name, kills: s.kills, headshots: s.headshots,
        damage: s.damageDealt, repairHp: s.repairHp, revivesGiven: s.revivesGiven,
        timesDowned: s.timesDowned,
      });
    }
    this.broadcastEvent({ t: 'run_end', wave: ctx.wave, stats });
  }

  /**
   * Debug-only invulnerability. CONTRACT GAP: Survivor has no `invulnerable`
   * field and `damageSurvivor`/`stepHorde`/`stepSpits` (all sibling-owned)
   * have no invuln parameter, so room.ts cannot intercept damage AS it is
   * applied by those pure systems mid-tick. Instead this restores hp/status
   * to full/alive for every flagged id at the END of the tick, undoing
   * whatever damage landed this tick — sufficient for the capture harness's
   * "park a player for many seconds while framing shots" use case, though not
   * a true mid-tick invulnerability guarantee.
   */
  private applyInvulnerability(): void {
    if (this.invuln.size === 0) return;
    for (const id of this.invuln) {
      const s = this.ctx.survivors.get(id);
      if (s === undefined) continue;
      if (s.status !== 'alive' || s.hp < SURVIVOR.maxHp) {
        s.status = 'alive';
        s.hp = SURVIVOR.maxHp;
        s.bleedout = 0;
        s.reviveProgress = 0;
        s.reviveBy = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-survivor: input queue drain, movement, fire, regen/reload/bloom.
  // -------------------------------------------------------------------------

  private stepSurvivors(now: number): void {
    for (const s of this.ctx.survivors.values()) {
      if (!s.connected) continue; // ghost: no session driving it

      if (s.status === 'alive') {
        if (s.reloadUntil > 0 && now >= s.reloadUntil) this.completeReload(s);
        const def = WEAPONS[s.weapon];
        if (s.bloom > 0) s.bloom = Math.max(0, s.bloom - def.spreadRecover * TICK_DT);
        if (now - s.lastDamageAt >= SURVIVOR.regenDelaySec * 1000 && s.hp < SURVIVOR.regenCap) {
          s.hp = Math.min(SURVIVOR.regenCap, s.hp + SURVIVOR.regenPerSec * TICK_DT);
        }
      }

      const q = s.inputQueue;
      const n = Math.min(q.length, NETCODE.maxInputPerTick);
      for (let i = 0; i < n; i++) {
        const msg = q[i];
        if (msg === undefined) break;
        this.applyInput(s, msg, now);
      }
      if (n >= q.length) q.length = 0;
      else {
        q.copyWithin(0, n);
        q.length -= n;
      }
    }
  }

  private applyInput(s: Survivor, msg: InputMsg, now: number): void {
    s.lastProcessedSeq = msg.seq;
    s.yaw = msg.yaw;
    s.pitch = msg.pitch;
    s.interacting = (msg.buttons & INPUT_INTERACT) !== 0;
    // INPUT_ALT was defined as "right mouse / scope" and read by NOTHING on
    // the server, so every sniper shot used the 8 deg hip cone.
    s.scoped = (msg.buttons & INPUT_ALT) !== 0 && WEAPONS[s.weapon].zoomFov !== null;
    const fireDown = (msg.buttons & INPUT_FIRE) !== 0;
    const fireEdge = fireDown && (s.prevButtons & INPUT_FIRE) === 0;
    s.prevButtons = msg.buttons;

    if (s.status === 'dead') return; // not in the world this run

    const speedMul = s.status === 'alive' ? WEAPONS[s.weapon].moveMul : SURVIVOR.downedMoveMul;
    stepBody(
      s.body,
      {
        moveX: msg.moveX,
        moveZ: msg.moveZ,
        yaw: msg.yaw,
        jump: (msg.buttons & INPUT_JUMP) !== 0,
        crouch: (msg.buttons & INPUT_CROUCH) !== 0,
        walk: (msg.buttons & INPUT_WALK) !== 0,
      },
      speedMul,
      TICK_DT,
      this.ctx.solids,
    );

    if (s.status !== 'alive') return;
    const def = WEAPONS[s.weapon];
    if (def.auto ? fireDown : fireEdge) this.tryFire(s, def, now);
  }

  /**
   * Cooldown/ammo/reload gating is room.ts's job (mirrors STRICKEN's tryFire);
   * combat.ts's `resolveShot` owns the ballistic resolution once a shot is
   * confirmed allowed — targets, hitscan, falloff/headshot damage, kill scrap,
   * stats, and the shot/hit/zombie_died events. It also reads (but does not
   * increment) `s.bloom`/`s.shotSeq`, so both are room-owned here.
   */
  private tryFire(s: Survivor, def: WeaponDef, now: number): void {
    if (s.reloadUntil > 0 || now < s.nextShotAt) return;
    const ammo = s.ammo.get(s.weapon);
    if (def.mag !== -1 && (ammo === undefined || ammo.mag <= 0)) return;
    s.nextShotAt = now + def.interval * 1000;
    if (ammo !== undefined && def.mag !== -1) ammo.mag--;
    s.shotSeq++;
    resolveShot(this.ctx, s, def);
    s.bloom = Math.min(def.maxSpreadDeg, s.bloom + def.spreadPerShot);
  }

  private completeReload(s: Survivor): void {
    const def = WEAPONS[s.weapon];
    const ammo = s.ammo.get(s.weapon);
    if (ammo !== undefined) {
      const need = def.mag - ammo.mag;
      const take = Math.min(need, ammo.reserve);
      ammo.mag += take;
      ammo.reserve -= take;
    }
    s.reloadUntil = 0;
  }

  // -------------------------------------------------------------------------
  // Interact: resolveInteract per connected survivor, then apply the ONE
  // continuous action a held INTERACT actually performs server-side (repair;
  // revive is resolved globally by stepRevives, buy is explicit C2S).
  // -------------------------------------------------------------------------

  private stepInteract(): void {
    const ctx = this.ctx;
    for (const s of ctx.survivors.values()) {
      if (!s.connected) continue;
      resolveInteract(ctx, s);
      if (s.status === 'alive' && s.interacting && s.interactKind === 'repair' && s.interactTarget >= 0) {
        // resolveInteract only ever targets a segment with hp < maxHp, so a 0
        // return here is unambiguously "can't afford this tick's cost" (see
        // repairSegment's doc) — never "nothing left to repair". Edge-trigger
        // on the transition into denial so held INTERACT doesn't spam the
        // event (and thus the deny sfx) every tick.
        const restored = repairSegment(ctx, s, s.interactTarget);
        if (restored > 0) {
          this.repairDenied.delete(s.id);
        } else if (!this.repairDenied.has(s.id)) {
          this.repairDenied.add(s.id);
          this.sendEvent(s.id, { t: 'buy_result', ok: false, weapon: null, reason: 'insufficient scrap' });
        }
      } else {
        this.repairDenied.delete(s.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // C2S handlers reached only via handleMessage (except handleInput, exposed
  // publicly so tests can drive it directly without a JSON round-trip).
  // -------------------------------------------------------------------------

  handleInput(id: PlayerId, msg: InputMsg): void {
    try {
      const s = this.ctx.survivors.get(id);
      if (s === undefined || !s.connected) return;
      const now = this.now();
      s.lastInputAt = now;
      const bucket = Math.floor(now / 1000);
      if (bucket !== s.inputWindow) {
        s.inputWindow = bucket;
        s.inputWindowCount = 0;
      }
      s.inputWindowCount++;
      if (s.inputWindowCount > NETCODE.inputQueueCap) {
        this.removePlayer(id); // speedhack guard tripped; platform closes the socket
        return;
      }
      if (msg.seq <= s.lastProcessedSeq) return; // stale/duplicate
      if (s.inputQueue.length >= NETCODE.inputQueueCap) s.inputQueue.shift();
      s.inputQueue.push(msg);
    } catch (err) {
      console.error('[outpost] handleInput failed', err);
    }
  }

  private handleReload(id: PlayerId, now: number): void {
    const s = this.ctx.survivors.get(id);
    if (s === undefined || s.status !== 'alive' || s.reloadUntil > 0) return;
    const def = WEAPONS[s.weapon];
    if (def.mag === -1) return; // melee
    const ammo = s.ammo.get(s.weapon);
    if (ammo === undefined || ammo.mag >= def.mag || ammo.reserve <= 0) return;
    s.reloadUntil = now + def.reload * 1000;
  }

  private handleSwitch(id: PlayerId, weapon: WeaponId): void {
    const s = this.ctx.survivors.get(id);
    if (s === undefined || s.status !== 'alive') return;
    if (weapon === s.weapon || !s.weapons.includes(weapon)) return;
    s.weapon = weapon;
    s.reloadUntil = 0;
    this.reorderCurrentFirst(s);
  }

  private reorderCurrentFirst(s: Survivor): void {
    const i = s.weapons.indexOf(s.weapon);
    if (i > 0) {
      s.weapons.splice(i, 1);
      s.weapons.unshift(s.weapon);
    }
  }

  /**
   * No sibling module owns weapon-rack/ammo-crate economics (waves/horde/
   * fence/survivors/combat's briefs stop at repair/revive/shooting), so this
   * IS room.ts's domain, not a gap. Replace-on-buy policy: see UPGRADE_TIERS.
   */
  private handleBuyWeapon(id: PlayerId, weapon: WeaponId): void {
    const s = this.ctx.survivors.get(id);
    if (s === undefined) return;
    if (s.status !== 'alive') {
      this.sendEvent(id, { t: 'buy_result', ok: false, weapon: null, reason: 'not alive' });
      return;
    }
    if (s.interactKind !== 'weaponRack') {
      this.sendEvent(id, { t: 'buy_result', ok: false, weapon: null, reason: 'not at the rack' });
      return;
    }
    if (weapon === 'knife' || s.weapons.includes(weapon)) {
      this.sendEvent(id, { t: 'buy_result', ok: false, weapon: null, reason: 'already owned' });
      return;
    }
    const price = ECONOMY.weaponPrice[weapon];
    if (s.scrap < price) {
      this.sendEvent(id, { t: 'buy_result', ok: false, weapon: null, reason: 'insufficient scrap' });
      return;
    }
    s.scrap -= price;
    if (UPGRADE_TIERS.includes(weapon)) {
      const oldTier = s.weapons.find((w) => UPGRADE_TIERS.includes(w));
      if (oldTier !== undefined) {
        s.weapons = s.weapons.filter((w) => w !== oldTier);
        s.ammo.delete(oldTier);
      }
    }
    s.weapons.push(weapon);
    s.ammo.set(weapon, defaultAmmo(weapon));
    s.weapon = weapon;
    s.reloadUntil = 0;
    s.bloom = 0;
    this.reorderCurrentFirst(s);
    this.sendEvent(id, { t: 'buy_result', ok: true, weapon, reason: null });
  }

  private handleBuyAmmo(id: PlayerId): void {
    const s = this.ctx.survivors.get(id);
    if (s === undefined) return;
    if (s.status !== 'alive') {
      this.sendEvent(id, { t: 'buy_result', ok: false, weapon: null, reason: 'not alive' });
      return;
    }
    if (s.interactKind !== 'ammoCrate') {
      this.sendEvent(id, { t: 'buy_result', ok: false, weapon: null, reason: 'not at the crate' });
      return;
    }
    if (s.scrap < ECONOMY.ammoRefillCost) {
      this.sendEvent(id, { t: 'buy_result', ok: false, weapon: null, reason: 'insufficient scrap' });
      return;
    }
    // ONE magazine for the HELD weapon, not a full refill of everything.
    // Repeatable: hold INTERACT at the crate and it ticks. Buying in small
    // increments means a broke player can top up with 10 scrap instead of being
    // locked out until they have a lump sum, and it stops a restock competing
    // head-on with a 200-scrap gun.
    const held = WEAPONS[s.weapon];
    if (held.reserve === -1) {
      this.sendEvent(id, { t: 'buy_result', ok: false, weapon: null, reason: 'melee takes no ammo' });
      return;
    }
    const ammo = s.ammo.get(s.weapon);
    if (ammo === undefined || ammo.reserve >= held.reserve) {
      this.sendEvent(id, { t: 'buy_result', ok: false, weapon: null, reason: 'reserve already full' });
      return;
    }
    s.scrap -= ECONOMY.ammoRefillCost;
    ammo.reserve = Math.min(held.reserve, ammo.reserve + held.mag);
    this.sendEvent(id, { t: 'buy_result', ok: true, weapon: s.weapon, reason: null });
  }

  /** The only warmup(lobby)->intermission(opening lull) transition there is. */
  private handleStart(id: PlayerId, seed: number | undefined, now: number): void {
    if (!this.ctx.survivors.has(id)) return; // only a seated player may start it
    if (this.ctx.phase !== 'lobby') return;
    if (this.playerCount() < MIN_PLAYERS) return;
    if (seed !== undefined) this.ctx.rand = rng(seed);
    this.ctx.wave = 0;
    this.ctx.phase = 'intermission';
    this.phaseEndsAt = now + WAVES.openingLullSec * 1000;
  }

  private handlePing(id: PlayerId, ts: number, now: number): void {
    const s = this.ctx.survivors.get(id);
    if (s === undefined || !s.connected) return;
    this.io.send(id, { t: 'pong', ts, serverTime: now });
  }

  /**
   * The sole handler of DebugMsg (CONTRACT.md). Every op calls into fence/
   * horde/survivors through their normal public functions except 'spawn'
   * (see the comment there — SpawnZombieFn only places on the ring, not at an
   * arbitrary point, which OutpostDebugApi.spawnAt needs) and 'invuln' (see
   * applyInvulnerability's doc). Silently dropped when the room was not
   * created with settings.debug === true (see the constructor's gap note).
   */
  private handleDebug(id: PlayerId, msg: DebugMsg): void {
    if (!this.debugEnabled) return;
    const ctx = this.ctx;
    switch (msg.op) {
      case 'hurt': {
        const s = ctx.survivors.get(id);
        if (s === undefined) return;
        damageSurvivor(ctx, s, msg.a ?? 0, null);
        return;
      }
      case 'teleport': {
        const s = ctx.survivors.get(id);
        if (s === undefined) return;
        s.body.x = msg.a ?? s.body.x;
        s.body.y = msg.b ?? s.body.y;
        s.body.z = msg.c ?? s.body.z;
        s.body.vx = 0;
        s.body.vy = 0;
        s.body.vz = 0;
        return;
      }
      case 'breach': {
        const seg = ctx.segments[msg.a ?? -1];
        if (seg === undefined) return;
        damageSegment(ctx, seg.id, seg.maxHp); // guarantees <= 0 hp regardless of current hp
        return;
      }
      case 'spawn': {
        const kind = msg.kind ?? 'shambler';
        const wave = Math.max(1, ctx.wave);
        const zid = spawnZombie(ctx, kind, wave);
        if (zid === -1) return; // pool full
        const z = ctx.zombies[zid];
        if (z === undefined) return;
        z.body.x = msg.a ?? z.body.x;
        z.body.z = msg.b ?? z.body.z;
        z.body.y = 0;
        z.body.vx = 0;
        z.body.vy = 0;
        z.body.vz = 0;
        z.retargetAt = 0; // react to the relocated position on the next stepHorde
        return;
      }
      case 'end':
        this.endRun();
        return;
      case 'invuln': {
        if ((msg.a ?? 0) >= 1) this.invuln.add(id);
        else this.invuln.delete(id);
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private sendEvent(id: PlayerId, ev: OutpostEvent): void {
    this.io.send(id, { t: 'event', ev });
  }

  private broadcastEvent(ev: OutpostEvent): void {
    for (const s of this.ctx.survivors.values()) {
      if (s.connected) this.io.send(s.id, { t: 'event', ev });
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots: every NETCODE.snapshotEveryTicks ticks (15 Hz at SIM_HZ 30),
  // into preallocated per-player wire objects mutated in place.
  // -------------------------------------------------------------------------

  private sendSnapshots(now: number): void {
    const ctx = this.ctx;

    this.survivorSnapList.length = 0;
    for (const s of ctx.survivors.values()) {
      if (!s.connected) continue;
      const w = this.wire.get(s.id);
      if (w === undefined) continue;
      const sn = w.snap;
      sn.id = s.id;
      sn.n = s.name;
      sn.x = s.body.x;
      sn.y = s.body.y;
      sn.z = s.body.z;
      sn.yaw = s.yaw;
      sn.pitch = s.pitch;
      sn.hp = s.hp;
      sn.st = s.status;
      sn.cr = s.body.height < PLAYER.heightStand;
      sn.mv = Math.hypot(s.body.vx, s.body.vz) > 0.5;
      sn.w = s.weapon;
      sn.rev = s.reviveProgress;
      sn.revBy = s.reviveBy;
      sn.bl = s.bleedout;
      sn.k = s.kills;
      sn.rv = s.revivesGiven;
      this.survivorSnapList.push(sn);
    }

    this.zombieSnapList.length = 0;
    for (const z of ctx.zombies) {
      if (!z.alive) continue;
      const zn = this.zombieSnapPool[z.id];
      if (zn === undefined) continue;
      zn.id = z.id;
      zn.k = z.kind;
      zn.x = z.body.x;
      zn.y = z.body.y;
      zn.z = z.body.z;
      zn.yaw = z.yaw;
      zn.hp = z.maxHp > 0 ? z.hp / z.maxHp : 0;
      zn.st = z.state;
      zn.g = z.gait;
      this.zombieSnapList.push(zn);
    }

    for (const seg of ctx.segments) {
      const sn = this.segmentSnapList[seg.id];
      if (sn === undefined) continue;
      sn.hp = seg.maxHp > 0 ? seg.hp / seg.maxHp : 0;
      sn.br = seg.breached;
      sn.rb = seg.rebuild;
    }

    this.spitSnapList.length = 0;
    for (const sp of ctx.spits) {
      if (!sp.alive) continue;
      const spn = this.spitSnapPool[sp.id];
      if (spn === undefined) continue;
      spn.id = sp.id;
      spn.x = sp.x;
      spn.y = sp.y;
      spn.z = sp.z;
      this.spitSnapList.push(spn);
    }

    const seated = this.playerCount();
    const canStart = ctx.phase === 'lobby' && seated >= MIN_PLAYERS;
    const tod = this.currentTod();
    const waveRemaining = this.spawnQueue.length + this.aliveThreatCount();
    const phaseEndsAt = ctx.phase === 'intermission' ? this.phaseEndsAt : 0;

    for (const s of ctx.survivors.values()) {
      if (!s.connected) continue;
      const w = this.wire.get(s.id);
      if (w === undefined) continue;
      const def = WEAPONS[s.weapon];
      const ammo = s.ammo.get(s.weapon);
      const you = w.you;
      you.hp = s.hp;
      you.status = s.status;
      you.bleedout = s.bleedout;
      you.scrap = s.scrap;
      you.weapons = s.weapons;
      you.weapon = s.weapon;
      you.mag = def.mag === -1 ? -1 : ammo !== undefined ? ammo.mag : 0;
      you.reserve = def.reserve === -1 ? -1 : ammo !== undefined ? ammo.reserve : 0;
      you.vy = s.body.vy;
      you.interact = s.interactKind;
      you.interactProgress = this.interactProgressOf(s);
      you.interactCost = this.interactCostOf(s);
      you.returnAtWave = s.returnAtWave;

      const m = w.msg;
      m.tick = ctx.tick;
      m.serverTime = now;
      m.ack = s.lastProcessedSeq;
      m.phase = ctx.phase;
      m.wave = ctx.wave;
      m.phaseEndsAt = phaseEndsAt;
      m.waveRemaining = waveRemaining;
      m.tod = tod;
      m.players = this.survivorSnapList;
      m.zombies = this.zombieSnapList;
      m.segments = this.segmentSnapList;
      m.spits = this.spitSnapList;
      m.you = you;
      m.seated = seated;
      m.minPlayers = MIN_PLAYERS;
      m.canStart = canStart;
      this.io.send(s.id, m);
    }
  }

  private interactProgressOf(s: Survivor): number {
    if (s.interactKind === 'repair' && s.interactTarget >= 0) {
      const seg = this.ctx.segments[s.interactTarget];
      if (seg === undefined) return 0;
      return seg.breached ? seg.rebuild : seg.maxHp > 0 ? seg.hp / seg.maxHp : 0;
    }
    if (s.interactKind === 'revive' && s.reviveTargetId !== null) {
      const target = this.ctx.survivors.get(s.reviveTargetId);
      return target !== undefined ? target.reviveProgress : 0;
    }
    return 0;
  }

  private interactCostOf(s: Survivor): number {
    if (s.interactKind === 'ammoCrate') return ECONOMY.ammoRefillCost;
    if (s.interactKind === 'repair' && s.interactTarget >= 0) {
      const seg = this.ctx.segments[s.interactTarget];
      if (seg === undefined) return 0;
      const hpRoom = seg.maxHp - seg.hp;
      const costMul = seg.breached ? ECONOMY.rebuildCostMul : 1;
      return Math.ceil(hpRoom * ECONOMY.repairScrapPerHp * costMul);
    }
    return 0;
  }

  private now(): number {
    return this.deps.now();
  }
}
