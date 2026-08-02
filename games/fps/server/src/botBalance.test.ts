// ============================================================================
// T-BAL — bot BALANCE regression guard.
//
// Everything else in this suite asserts that the bot code is CORRECT. Nothing
// asserted that it is FUN, and that gap hid the worst bot defect in the game
// for its entire existence: bots bought primaries successfully and then never
// equipped them, so every bot ever spawned fought with a pistol. The unit tests
// were all green throughout.
//
// So this file measures the thing the unit tests cannot: a scripted "competent
// human" plays real GameRoom matches against real bots under fake timers, and
// the aggregate is asserted against WIDE bounds. The bounds are deliberately
// loose — this must catch "someone broke the bots" or "someone made the bots
// unfair", not "someone moved a knob by 5%". A flaky balance test is worse than
// no balance test, because the next person deletes it.
//
// DETERMINISM: fake timers pin Date.now(), so the room's own rng seed
// (`rng(Date.now() ^ roomSeq)`) and every bot brain seed derived from it are
// fixed. Vitest isolates the module registry per test file, so `roomSeq` starts
// at 0 here and the Nth room in this file always gets the same seed. Same
// commit => byte-identical numbers, every run.
//
// The full-fidelity version of this harness (40 duel + 40 team matches, ~22s)
// was used to pick the tune; the numbers in the task report come from it. What
// lives here is the same harness at a sample size that fits a normal suite run.
// If you are re-tuning, raise MATCHES locally rather than trusting this sample.
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INPUT_FIRE, MAPS, PLAYER, WEAPONS, boxToAABB, hitscan } from '@fps/shared';
import type { C2S, GameEvent, HitscanTarget, PlayerId, S2C, Team, Vec3, WeaponId } from '@fps/shared';
import { GameRoom } from './game.js';
import type { RoomIO } from './game.js';

type SnapshotMsg = Extract<S2C, { t: 'snapshot' }>;

const SOLIDS = MAPS.dustbowl.boxes.map(boxToAABB);

/** Matches per scenario. Sized for suite runtime, not for statistical power. */
const DUEL_MATCHES = 4;
const TEAM_MATCHES = 8;

/**
 * Per-test timeout. These tests simulate tens of thousands of server ticks, so
 * they run in seconds rather than milliseconds — well past vitest's 5s default
 * once the full suite is sharing workers. Set here rather than in
 * vitest.config.ts so the cost stays with the file that incurs it.
 */
const BALANCE_TIMEOUT_MS = 120_000;

interface Stamped {
  tick: number;
  id: PlayerId;
  ev: GameEvent;
}

class FakeIO implements RoomIO {
  tick = 0;
  readonly evs: Stamped[] = [];
  /** Chronological team-assignment log, replayed during reduction so round
      attribution survives the halftime side swap. */
  readonly teamLog: Array<{ tick: number; id: PlayerId; team: Team }> = [];
  private readonly snaps = new Map<PlayerId, SnapshotMsg>();
  private readonly roster = new Map<PlayerId, Team>();

  private setTeam(id: PlayerId, team: Team): void {
    this.roster.set(id, team);
    this.teamLog.push({ tick: this.tick, id, team });
  }

  send(id: PlayerId, msg: S2C): void {
    if (msg.t === 'snapshot') {
      this.snaps.set(id, structuredClone(msg));
      return;
    }
    if (msg.t === 'event') {
      const ev = msg.ev;
      this.evs.push({ tick: this.tick, id, ev: structuredClone(ev) });
      if (ev.t === 'player_joined') this.setTeam(ev.entry.id, ev.entry.team);
      if (ev.t === 'team_changed') this.setTeam(ev.id, ev.team);
      if (ev.t === 'halftime') for (const r of ev.roster) this.setTeam(r.id, r.team);
      return;
    }
    if (msg.t === 'joined') for (const r of msg.roster) this.setTeam(r.id, r.team);
  }

  rttMs(): number {
    return 0;
  }

  snap(id: PlayerId): SnapshotMsg | undefined {
    return this.snaps.get(id);
  }

  teamOf(id: PlayerId): Team | undefined {
    return this.roster.get(id);
  }
}

// ---- nav grid over dustbowl (BFS; same shape as game.test.ts) ---------------

const NAV_CELL = 0.6;
const NAV_X0 = -33;
const NAV_Z0 = -25;
const NAV_NX = Math.ceil(66 / NAV_CELL);
const NAV_NZ = Math.ceil(50 / NAV_CELL);

function navCellBlocked(cx: number, cz: number): boolean {
  const r = PLAYER.radius + 0.08;
  for (const s of SOLIDS) {
    if (s.maxY <= PLAYER.stepUp) continue;
    if (cx + r > s.minX && cx - r < s.maxX && cz + r > s.minZ && cz - r < s.maxZ) return true;
  }
  return false;
}

const NAV_BLOCKED: readonly boolean[] = (() => {
  const out: boolean[] = [];
  for (let iz = 0; iz < NAV_NZ; iz++) {
    for (let ix = 0; ix < NAV_NX; ix++) {
      out.push(navCellBlocked(NAV_X0 + (ix + 0.5) * NAV_CELL, NAV_Z0 + (iz + 0.5) * NAV_CELL));
    }
  }
  return out;
})();

function navFree(ix: number, iz: number): boolean {
  return NAV_BLOCKED[iz * NAV_NX + ix] === false;
}

function navCellOf(x: number, z: number): { ix: number; iz: number } {
  return {
    ix: Math.min(NAV_NX - 1, Math.max(0, Math.floor((x - NAV_X0) / NAV_CELL))),
    iz: Math.min(NAV_NZ - 1, Math.max(0, Math.floor((z - NAV_Z0) / NAV_CELL))),
  };
}

function navNearestFree(cell: { ix: number; iz: number }): { ix: number; iz: number } {
  if (navFree(cell.ix, cell.iz)) return cell;
  for (let ring = 1; ring < 10; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const jx = cell.ix + dx;
        const jz = cell.iz + dz;
        if (jx >= 0 && jx < NAV_NX && jz >= 0 && jz < NAV_NZ && navFree(jx, jz)) return { ix: jx, iz: jz };
      }
    }
  }
  return cell;
}

function navPath(x0: number, z0: number, x1: number, z1: number): Array<{ x: number; z: number }> {
  const start = navNearestFree(navCellOf(x0, z0));
  const goal = navNearestFree(navCellOf(x1, z1));
  const startIdx = start.iz * NAV_NX + start.ix;
  const goalIdx = goal.iz * NAV_NX + goal.ix;
  if (startIdx === goalIdx) return [];
  const prev = new Int32Array(NAV_NX * NAV_NZ).fill(-2);
  const queue = new Int32Array(NAV_NX * NAV_NZ);
  let head = 0;
  let tail = 0;
  queue[tail++] = startIdx;
  prev[startIdx] = -1;
  while (head < tail) {
    const cur = queue[head++];
    if (cur === undefined) break;
    if (cur === goalIdx) break;
    const cx = cur % NAV_NX;
    const cz = Math.floor(cur / NAV_NX);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const jx = cx + dx;
        const jz = cz + dz;
        if (jx < 0 || jx >= NAV_NX || jz < 0 || jz >= NAV_NZ || !navFree(jx, jz)) continue;
        if (dx !== 0 && dz !== 0 && (!navFree(cx + dx, cz) || !navFree(cx, cz + dz))) continue;
        const j = jz * NAV_NX + jx;
        if (prev[j] !== -2) continue;
        prev[j] = cur;
        queue[tail++] = j;
      }
    }
  }
  if (prev[goalIdx] === -2) return [];
  const cells: number[] = [];
  for (let c = goalIdx; c >= 0; ) {
    cells.push(c);
    const p = prev[c];
    if (p === undefined || p < 0) break;
    c = p;
  }
  cells.reverse();
  return cells.map((c) => ({
    x: NAV_X0 + ((c % NAV_NX) + 0.5) * NAV_CELL,
    z: NAV_Z0 + (Math.floor(c / NAV_NX) + 0.5) * NAV_CELL,
  }));
}

// ---- the scripted "competent human" -----------------------------------------
// Buys AND equips the best affordable primary, BFS-walks toward the nearest
// enemy, stands and shoots the chest whenever the shared hitscan says the line
// is clear inside 30m, reloads on an empty mag. No headshot hunting, no
// wallbangs, no prefiring. This is the yardstick the bounds below are measured
// against: it is deliberately a solid-but-unspectacular player, so "the human
// beats the bots most of the time" means something.

class HumanDriver {
  private seq = 0;
  private path: Array<{ x: number; z: number }> = [];
  private pathIdx = 0;
  private lastPathAt = -1000;
  private lastX = 0;
  private lastZ = 0;
  private stuck = 0;
  private lastFireAt = -1000;

  constructor(
    private readonly room: GameRoom,
    private readonly io: FakeIO,
    private readonly id: PlayerId,
  ) {}

  step(i: number): void {
    const snap = this.io.snap(this.id);
    if (snap === undefined) {
      // never go quiet: NET.inputTimeoutMs disconnects a silent player
      this.send({ moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 });
      return;
    }
    const me = snap.players.find((p) => p.id === this.id);
    const you = snap.you;

    if (you.canBuy) {
      if (!you.weapons.includes('rifle') && you.money >= WEAPONS.rifle.price) {
        this.room.handleBuy(this.id, 'rifle');
      } else if (!you.weapons.includes('smg') && you.money >= WEAPONS.smg.price) {
        this.room.handleBuy(this.id, 'smg');
      }
      for (const w of ['rifle', 'smg', 'pistol'] as const) {
        if (you.weapons.includes(w)) {
          if (you.weapon !== w) this.room.handleSwitch(this.id, w);
          break;
        }
      }
    }

    if (me === undefined || !you.alive) {
      this.send({ moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 });
      return;
    }

    const myTeam = this.io.teamOf(this.id);
    const others: HitscanTarget[] = [];
    let tgt: { x: number; y: number; z: number; id: PlayerId } | null = null;
    let bestD = Infinity;
    for (const pl of snap.players) {
      if (pl.id === this.id || !pl.alive) continue;
      others.push({ id: pl.id, x: pl.x, y: pl.y, z: pl.z, height: PLAYER.heightStand });
      if (this.io.teamOf(pl.id) === myTeam) continue;
      const d = Math.hypot(pl.x - me.x, pl.z - me.z);
      if (d < bestD) {
        bestD = d;
        tgt = { x: pl.x, y: pl.y, z: pl.z, id: pl.id };
      }
    }

    const def = WEAPONS[you.weapon];
    if (you.mag === 0 && def.mag !== -1) {
      this.room.handleReload(this.id);
      this.send({ moveX: 0, moveZ: 0, yaw: me.yaw, pitch: 0, buttons: 0 });
      return;
    }

    let yaw = me.yaw;
    let pitch = 0;
    let buttons = 0;
    let moveZ = 0;
    let clear = false;

    if (tgt !== null) {
      const eye: Vec3 = { x: me.x, y: me.y + PLAYER.heightStand - PLAYER.eyeOffset, z: me.z };
      const aim: Vec3 = { x: tgt.x, y: tgt.y + 1.15, z: tgt.z };
      const dx = aim.x - eye.x;
      const dy = aim.y - eye.y;
      const dz = aim.z - eye.z;
      const flat = Math.hypot(dx, dz) || 1e-9;
      const len = Math.hypot(dx, dy, dz) || 1e-9;
      const dir: Vec3 = { x: dx / len, y: dy / len, z: dz / len };
      const probe = hitscan(eye, dir, others, SOLIDS, 200);
      clear = probe !== null && probe.targetId === tgt.id && bestD <= 30;
      yaw = Math.atan2(-dx, -dz);
      pitch = Math.atan2(dy, flat);
    }

    const moved = Math.hypot(me.x - this.lastX, me.z - this.lastZ);
    this.lastX = me.x;
    this.lastZ = me.z;
    if (!clear && moved < 0.01) this.stuck++;
    else this.stuck = 0;

    if (clear) {
      if (def.auto) {
        buttons |= INPUT_FIRE;
      } else {
        const interval = Math.max(1, Math.round(def.interval * 30) + 1);
        if (i - this.lastFireAt >= interval) {
          buttons |= INPUT_FIRE;
          this.lastFireAt = i;
        }
      }
    } else if (tgt !== null) {
      if (this.pathIdx >= this.path.length || i - this.lastPathAt > 90 || this.stuck > 15) {
        this.path = navPath(me.x, me.z, tgt.x, tgt.z);
        this.pathIdx = 0;
        this.lastPathAt = i;
        this.stuck = 0;
      }
      const wp = this.path[this.pathIdx];
      if (wp !== undefined) {
        if (Math.hypot(wp.x - me.x, wp.z - me.z) < 0.5) this.pathIdx++;
        else {
          yaw = Math.atan2(-(wp.x - me.x), -(wp.z - me.z));
          pitch = 0;
          moveZ = 1;
        }
      }
    }

    this.send({ moveX: 0, moveZ, yaw, pitch, buttons });
  }

  private send(o: { moveX: number; moveZ: number; yaw: number; pitch: number; buttons: number }): void {
    this.seq++;
    const msg: Extract<C2S, { t: 'input' }> = { t: 'input', seq: this.seq, ...o };
    this.room.handleInput(this.id, msg);
  }
}

// ---- match runner ------------------------------------------------------------

interface MatchStats {
  botShots: number;
  botHits: number;
  botHeadshotHits: number;
  botKills: number;
  humanKills: number;
  humanDeaths: number;
  totalKills: number;
  ttk: number[];
  humanRoundWins: number;
  botRoundWins: number;
  humanMatchWin: boolean | null;
  /** Weapon-held poll counts across all bots, sampled every 60 ticks. */
  held: Record<string, number>;
}

function runMatch(enemyBots: number, allyBots: number): MatchStats {
  const io = new FakeIO();
  const room = new GameRoom('dustbowl', 'public', io);
  const humanId = 'H1';
  room.addPlayer(humanId, 'Human');
  const botIds: PlayerId[] = [];
  for (let i = 0; i < enemyBots + allyBots; i++) {
    const b = room.addBot();
    if (b === null) throw new Error('addBot failed');
    botIds.push(b);
  }
  room.start();
  room.handleMessage(humanId, { t: 'start' });

  const driver = new HumanDriver(room, io, humanId);
  const botSet = new Set(botIds);
  const held: Record<string, number> = {};

  const MAX_TICKS = 60_000;
  let evCursor = 0;
  let ended = false;
  for (let i = 0; i < MAX_TICKS && !ended; i++) {
    io.tick = i;
    driver.step(i);
    vi.advanceTimersByTime(34);
    for (; evCursor < io.evs.length; evCursor++) {
      if (io.evs[evCursor]?.ev.t === 'match_end') ended = true;
    }
    if (i % 60 === 0) {
      const snap = io.snap(humanId);
      if (snap !== undefined) {
        for (const p of snap.players) {
          if (botSet.has(p.id) && p.alive) held[p.weapon] = (held[p.weapon] ?? 0) + 1;
        }
      }
    }
  }

  room.stop();

  const s: MatchStats = {
    botShots: 0, botHits: 0, botHeadshotHits: 0, botKills: 0, humanKills: 0,
    humanDeaths: 0, totalKills: 0, ttk: [], humanRoundWins: 0, botRoundWins: 0,
    humanMatchWin: null, held,
  };
  const firstDmg = new Map<string, number>();
  const seenShot = new Set<string>();
  const seenKill = new Set<string>();
  const seenRound = new Set<string>();
  // replay the team log so every attribution uses the team AT THAT TICK
  const team = new Map<PlayerId, Team>();
  let tlCursor = 0;
  const advanceTeams = (t: number): void => {
    while (tlCursor < io.teamLog.length) {
      const e = io.teamLog[tlCursor];
      if (e === undefined || e.tick > t) break;
      team.set(e.id, e.team);
      tlCursor++;
    }
  };
  const isEnemyBot = (id: PlayerId): boolean => botSet.has(id) && team.get(id) !== team.get(humanId);

  for (const st of io.evs) {
    advanceTeams(st.tick);
    const ev = st.ev;
    if (ev.t === 'shot') {
      const key = `${st.tick}|${ev.shooterId}|${ev.to.x.toFixed(4)}|${ev.to.z.toFixed(4)}`;
      if (seenShot.has(key)) continue; // broadcast: one logical shot per recipient
      seenShot.add(key);
      if (isEnemyBot(ev.shooterId)) s.botShots++;
    } else if (ev.t === 'hit') {
      // 'hit' is delivered to the SHOOTER only => st.id IS the shooter
      const k = `${st.id}>${ev.victimId}`;
      if (!firstDmg.has(k)) firstDmg.set(k, st.tick);
      if (isEnemyBot(st.id)) {
        s.botHits++;
        if (ev.headshot) s.botHeadshotHits++;
      }
    } else if (ev.t === 'kill') {
      const key = `${st.tick}|${ev.victimId}`;
      if (seenKill.has(key)) continue;
      seenKill.add(key);
      s.totalKills++;
      const kid = ev.killerId;
      if (kid !== null) {
        const t0 = firstDmg.get(`${kid}>${ev.victimId}`);
        if (isEnemyBot(kid)) {
          s.botKills++;
          if (t0 !== undefined) s.ttk.push((st.tick - t0) / 30);
        } else if (kid === humanId) {
          s.humanKills++;
        }
      }
      if (ev.victimId === humanId) s.humanDeaths++;
      for (const k of [...firstDmg.keys()]) if (k.endsWith(`>${ev.victimId}`)) firstDmg.delete(k);
    } else if (ev.t === 'round_start') {
      firstDmg.clear(); // no engagement spans a round boundary
    } else if (ev.t === 'round_end') {
      const key = `re|${st.tick}`;
      if (seenRound.has(key)) continue;
      seenRound.add(key);
      if (ev.winner === team.get(humanId)) s.humanRoundWins++;
      else if (ev.winner !== null) s.botRoundWins++;
    } else if (ev.t === 'match_end') {
      const key = `me|${st.tick}`;
      if (seenRound.has(key)) continue;
      seenRound.add(key);
      s.humanMatchWin = ev.winner === team.get(humanId);
    }
  }
  return s;
}

// ---- aggregation -------------------------------------------------------------

interface Agg {
  matches: number;
  botShots: number;
  botHits: number;
  botAccuracy: number;
  headshotShareOfHits: number;
  botKills: number;
  totalKills: number;
  botKillShare: number;
  humanKills: number;
  humanDeaths: number;
  humanKd: number;
  botTtkMean: number;
  humanRoundWinRate: number;
  humanMatchWins: number;
  matchesDecided: number;
  heldPistol: number;
  heldPrimary: number;
  held: Record<string, number>;
}

function aggregate(all: MatchStats[]): Agg {
  const sum = (f: (s: MatchStats) => number): number => all.reduce((a, s) => a + f(s), 0);
  const held: Record<string, number> = {};
  for (const s of all) for (const [k, v] of Object.entries(s.held)) held[k] = (held[k] ?? 0) + v;
  const ttk = all.flatMap((s) => s.ttk);
  const botShots = sum((s) => s.botShots);
  const botHits = sum((s) => s.botHits);
  const botKills = sum((s) => s.botKills);
  const totalKills = sum((s) => s.totalKills);
  const humanKills = sum((s) => s.humanKills);
  const humanDeaths = sum((s) => s.humanDeaths);
  const hrw = sum((s) => s.humanRoundWins);
  const brw = sum((s) => s.botRoundWins);
  const primary = (held['rifle'] ?? 0) + (held['smg'] ?? 0) + (held['shotgun'] ?? 0) + (held['sniper'] ?? 0);
  return {
    matches: all.length,
    botShots,
    botHits,
    botAccuracy: botShots === 0 ? 0 : botHits / botShots,
    headshotShareOfHits: botHits === 0 ? 0 : sum((s) => s.botHeadshotHits) / botHits,
    botKills,
    totalKills,
    botKillShare: totalKills === 0 ? 0 : botKills / totalKills,
    humanKills,
    humanDeaths,
    humanKd: humanDeaths === 0 ? Infinity : humanKills / humanDeaths,
    botTtkMean: ttk.length === 0 ? 0 : ttk.reduce((a, b) => a + b, 0) / ttk.length,
    humanRoundWinRate: hrw + brw === 0 ? 0 : hrw / (hrw + brw),
    humanMatchWins: all.filter((s) => s.humanMatchWin === true).length,
    matchesDecided: all.filter((s) => s.humanMatchWin !== null).length,
    heldPistol: held['pistol'] ?? 0,
    heldPrimary: primary,
    held,
  };
}

function report(label: string, a: Agg): void {
  console.log(
    [
      `\n##### ${label} (${a.matches} matches) #####`,
      `bot shots/hits    : ${a.botShots} / ${a.botHits}  accuracy ${(100 * a.botAccuracy).toFixed(1)}%`,
      `bot headshots     : ${(100 * a.headshotShareOfHits).toFixed(1)}% of hits`,
      `bot kill share    : ${a.botKills} / ${a.totalKills} = ${(100 * a.botKillShare).toFixed(1)}%`,
      `human K / D       : ${a.humanKills} / ${a.humanDeaths} = ${a.humanKd.toFixed(2)}`,
      `bot TTK mean      : ${a.botTtkMean.toFixed(3)}s`,
      `human round wins  : ${(100 * a.humanRoundWinRate).toFixed(1)}%`,
      `human match wins  : ${a.humanMatchWins} / ${a.matchesDecided}`,
      `bot weapons held  : ${JSON.stringify(a.held)}`,
      '################################',
    ].join('\n'),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); // pins every room/brain seed
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bot balance (measured, wide bounds)', () => {
  it(`team 3v3: bots hold their primaries, threaten a competent human, and still lose`, () => {
    const all: MatchStats[] = [];
    for (let r = 0; r < TEAM_MATCHES; r++) all.push(runMatch(3, 2));
    const a = aggregate(all);
    report('TEAM 3v3', a);

    // --- THE defect. Bots bought primaries and then held a pistol forever,
    // because handleBuy re-equips only when the HELD weapon leaves the owned
    // list. If this ever goes red again, bots are unarmed regardless of what
    // the buy logs say. Poll counts, not events: this asks what they HELD.
    expect(a.heldPrimary).toBeGreaterThan(0);
    expect(a.held['rifle'] ?? 0).toBeGreaterThan(0);
    expect(a.heldPrimary).toBeGreaterThan(a.heldPistol); // most of their time, armed

    // --- Bots must be able to shoot straight, but not perfectly.
    expect(a.botShots).toBeGreaterThan(200);
    expect(a.botAccuracy).toBeGreaterThan(0.35);
    expect(a.botAccuracy).toBeLessThan(0.95);

    // --- Headshots stay incidental. Bots aim at the upper chest on purpose; a
    // rifle headshot is 33 x 4 = 132, an outright one-shot kill, so a jump here
    // means bots have quietly become an aimbot.
    expect(a.headshotShareOfHits).toBeLessThan(0.45);

    // --- Threatening: bots take a real share of the kills. 3 of the 6 players
    // on the field are enemy bots, so 50% would be "exactly average player".
    expect(a.botKillShare).toBeGreaterThan(0.20);
    expect(a.botKillShare).toBeLessThan(0.70);

    // --- Beatable (I4). The human is a solid-but-unspectacular scripted
    // player and must still come out ahead on the exchange...
    expect(a.humanKd).toBeGreaterThan(1);
    // ...but not by the absurd margin the pistol-only bots conceded (3.5+).
    expect(a.humanKd).toBeLessThan(3.5);

    // --- Round win rate is the fair measure of difficulty: match win rate in a
    // first-to-6 amplifies any per-round edge into a near-certainty. The human
    // wins most rounds, never all of them.
    expect(a.humanRoundWinRate).toBeGreaterThan(0.45);
    expect(a.humanRoundWinRate).toBeLessThan(0.90);

    // --- Bots kill fast enough to matter and not so fast it is instant.
    expect(a.botTtkMean).toBeGreaterThan(0.1);
    expect(a.botTtkMean).toBeLessThan(2.5);
  }, BALANCE_TIMEOUT_MS);

  it('duel 1v1: a lone bot buys, equips and fights back', () => {
    const all: MatchStats[] = [];
    for (let r = 0; r < DUEL_MATCHES; r++) all.push(runMatch(1, 0));
    const a = aggregate(all);
    report('DUEL 1v1', a);

    // A lone bot is the cleanest read on "did it equip what it bought", with no
    // teammate's weapon polls mixed in.
    expect(a.heldPrimary).toBeGreaterThan(0);
    expect(a.heldPrimary).toBeGreaterThan(a.heldPistol);

    // It fights back: it lands kills on the human rather than being a prop.
    expect(a.botKills).toBeGreaterThan(0);
    expect(a.botAccuracy).toBeGreaterThan(0.35);
    expect(a.botAccuracy).toBeLessThan(0.95);

    // The human still clearly wins a 1v1 — but a duel best-of-10 amplifies the
    // per-round edge, so only the round rate is asserted here.
    expect(a.humanRoundWinRate).toBeGreaterThan(0.5);
  }, BALANCE_TIMEOUT_MS);
});
