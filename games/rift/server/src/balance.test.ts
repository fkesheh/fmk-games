// ============================================================================
// ANCIENTS (rift) BALANCE HARNESS (T13) — measures the CONTRACT §9 bands over
// headless bot matches, pumped through the room's tickOnce() seam (CONTRACT
// §5), plus the §10 sim-tick budget at 8v8.
//
// Methodology (test-side measurement only; game code is never touched):
// - §9's bands are defined at EVEN BOT SKILL, so every seat must be bot-driven.
//   One fake human is seated to satisfy MIN_PLAYERS; immediately after lock it
//   is disconnected (removePlayer, permanent=false), which puts a same-seed
//   bot brain on its hero — from then on the match is 100% bot-vs-bot. The
//   harness observes through the room's PUBLIC membership surface: every
//   SAMPLE_WINDOW ticks it rebinds the ghost (addPlayer resume), pumps
//   WINDOW_TICKS snapshots (board levels, structure hp, NaN sweep, own gold),
//   then disconnects again. The observed hero idles ~1% of ticks; all other
//   seats are bot-driven 100%. Snapshot objects are mutated in place after
//   send, so the IO below EXTRACTS numbers synchronously at send time.
// - Tower falls are read off the structure ents (structures are in EVERY
//   snapshot; hp <= 0 means destroyed), so no events are missed while the
//   observer is disconnected. Match end is detected via room.info().phase;
//   the authoritative rift_end (reason/winner/stats) is then replayed from the
//   room's ended-phase cache by rejoining once (CONTRACT §2 dwell behaviour).
// - Gold at 10 min per hero: the wire exposes gold only through `you`, so at
//   tick 12000 the harness walks the bot seats with the public late-joiner
//   flow: addPlayer displaces the oldest bot seat and INHERITS its purse
//   (CONTRACT §2), one snapshot is read, and removePlayer(permanent=false)
//   converts the seat back to a bot-driven ghost. Effective gold = purse +
//   cost of held items (approximates goldEarned, which the wire only carries
//   at match end). Pid churn from probing is canonicalised through an alias
//   map so level tracking survives it.
// - Randomness varies per match via the injected rand seed: it names the room
//   id, and bot brains derive from hashSeed(roomId, seatIndex), so each seed
//   is a distinct match.
// - The §10 perf run uses a null IO and disconnects the human after lock (all
//   16 seats bot-driven, zero snapshot channels), then measures tickOnce()
//   wall time — the headless sim tick: vision + bot thinking +
//   world.advance() + event dispatch, with no IO and no snapshot fan-out.
// ============================================================================
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ITEM_LIST,
  LANES_FOR_TEAM_SIZE,
  MATCH_HARD_CAP_S,
  TICK_RATE,
} from '@rift/shared';
import type {
  EndReason,
  ItemId,
  RiftEvent,
  RiftS2C,
  RosterEntry,
  TeamId,
} from '@rift/shared';
import { rng } from '@platform/shared';
import type { PlayerId, RoomIO } from '@platform/shared';
import type { RoomDeps } from './ports.js';
import { RiftRoom } from './room.js';

// ---- measurement constants ----------------------------------------------------

const TICKS_PER_MIN = TICK_RATE * 60;
const HARD_CAP_TICKS = MATCH_HARD_CAP_S * TICK_RATE; // 36000
const GOLD_SAMPLE_TICK = 10 * TICKS_PER_MIN; // 10:00 — the §9 gold checkpoint
const SAMPLE_WINDOW = 200; // observer reconnects every 200 ticks (10s)
const WINDOW_TICKS = 2; // snapshots captured per window (1% observer duty)
const NAN_REPORT_CAP = 40;

const ITEM_COST = new Map<ItemId, number>();
for (const def of ITEM_LIST) ITEM_COST.set(def.id, def.cost);

type Snap = Extract<RiftS2C, { t: 'rift_snap' }>;
type RosterEv = Extract<RiftEvent, { t: 'rift_roster' }>;
type EndEv = Extract<RiftEvent, { t: 'rift_end' }>;

interface YouSample {
  tick: number;
  gold: number;
  items: (ItemId | null)[];
}

interface GoldSample {
  pid: string; // canonical (pre-probe) seat pid
  team: TeamId;
  gold: number; // purse + held-item costs
}

interface MatchResult {
  teamSize: number;
  lanes: number;
  seed: number;
  endReason: EndReason | null;
  winner: TeamId | null;
  endTick: number; // pump count when the phase flipped (== match tick)
  durationMin: number;
  firstTowerMin: number | null; // 10s sampling granularity (upper bound)
  level6MedianMin: number | null; // censored: unreached heroes count at match end
  level6TimesMin: number[];
  level6Unreached: number;
  gold10: GoldSample[] | null; // null when the match ended before 10:00
  teamGold10: [number, number] | null;
  nanReports: string[];
  tickAnomalies: number; // duplicate/regressing snapshot ticks within windows
  ioErrors: string[];
}

// ---- small numeric helpers ------------------------------------------------------

function medianOf(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const a = s[mid];
  const b = s[s.length % 2 === 1 ? mid : mid - 1];
  if (a === undefined || b === undefined) return null;
  return s.length % 2 === 1 ? a : (a + b) / 2;
}

function percentileOf(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const v = s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return v === undefined ? null : v;
}

function effectiveGold(y: YouSample): number {
  let items = 0;
  for (const it of y.items) {
    if (it === null) continue;
    items += ITEM_COST.get(it) ?? 0;
  }
  return y.gold + items;
}

function noteBad(out: string[], label: string, v: number): void {
  if (!Number.isFinite(v) && out.length < NAN_REPORT_CAP) out.push(`${label}=${String(v)}`);
}

// ---- the recording IO -------------------------------------------------------------

/**
 * Extracts every measurement synchronously at send time (snapshot objects are
 * reused by the room). Events are recorded once, from the p1 channel. The
 * observer disconnects between sample windows, so per-pid tick continuity is
 * only checked for duplicates/regressions (forward jumps across windows are
 * the windowing, not stalls — the runner's pump counter covers stall detection
 * via the hard-cap assertion).
 */
class ProbeIO implements RoomIO {
  readonly events: RiftEvent[] = [];
  readonly errors: string[] = [];
  readonly nanReports: string[] = [];
  readonly you = new Map<PlayerId, YouSample>();
  /** canonical pid -> first sampled tick at level >= 6 (window granularity). */
  readonly level6Tick = new Map<string, number>();
  /** structure ent id -> first sampled tick with hp <= 0 (towers only). */
  readonly towerDeadTick = new Map<number, number>();
  /** probe pid -> original bot pid (filled by the gold-probe walk). */
  readonly alias = new Map<string, string>();
  tickAnomalies = 0;
  lastTick = -1;
  private readonly lastTickByPid = new Map<PlayerId, number>();

  send(id: PlayerId, msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) {
      this.errors.push(`non-object message for ${id}`);
      return;
    }
    const t = (msg as { t?: unknown }).t;
    if (t === 'rift_snap') {
      this.onSnap(id, msg as Snap);
      return;
    }
    if (t === 'event') {
      const ev = (msg as { ev?: unknown }).ev as RiftEvent;
      if (id === 'p1') this.events.push(ev);
      return;
    }
    if (t === 'error') {
      this.errors.push(`error frame for ${id}: ${JSON.stringify(msg)}`);
      return;
    }
    // rift_hello / rift_lobby / rift_begin: not measurements.
  }

  rttMs(): number {
    return 0;
  }

  endEvent(): EndEv | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (ev !== undefined && ev.t === 'rift_end') return ev;
    }
    return undefined;
  }

  /** Bot seats (in room seat order) from the last roster broadcast. */
  botSeats(): RosterEntry[] {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (ev !== undefined && ev.t === 'rift_roster') {
        return (ev as RosterEv).roster.filter((r) => r.bot);
      }
    }
    return [];
  }

  /** Team of the observer seat, from the first roster (lock-time). */
  observerTeam(pid: PlayerId): TeamId {
    for (const ev of this.events) {
      if (ev.t === 'rift_roster') {
        const seat = (ev as RosterEv).roster.find((r) => r.id === pid);
        if (seat !== undefined) return seat.team;
      }
    }
    return 0;
  }

  firstTowerDeadTick(): number | null {
    let best: number | null = null;
    for (const t of this.towerDeadTick.values()) {
      if (best === null || t < best) best = t;
    }
    return best;
  }

  private onSnap(id: PlayerId, snap: Snap): void {
    const mt = snap.matchTick;
    const prev = this.lastTickByPid.get(id);
    if (prev !== undefined && mt <= prev) this.tickAnomalies += 1; // duplicate/regression
    this.lastTickByPid.set(id, mt);
    if (mt > this.lastTick) this.lastTick = mt;

    const you = snap.you;
    if (you !== null) this.you.set(id, { tick: mt, gold: you.gold, items: [...you.items] });

    for (const row of snap.board) {
      if (row.level < 6) continue;
      const cid = this.alias.get(row.id) ?? row.id;
      if (!this.level6Tick.has(cid)) this.level6Tick.set(cid, mt);
    }
    for (const e of snap.ents) {
      if (e.k === 'tower' && e.hp <= 0 && !this.towerDeadTick.has(e.id)) {
        this.towerDeadTick.set(e.id, mt);
      }
    }
    this.scan(id, snap);
  }

  /** NaN/Infinity sweep over every numeric snapshot field (sampled windows). */
  private scan(id: PlayerId, snap: Snap): void {
    const out = this.nanReports;
    if (out.length >= NAN_REPORT_CAP) return;
    noteBad(out, `${id}.matchTick`, snap.matchTick);
    noteBad(out, `${id}.kills0`, snap.kills[0] ?? NaN);
    noteBad(out, `${id}.kills1`, snap.kills[1] ?? NaN);
    noteBad(out, `${id}.wardStock`, snap.wardStock);
    const you = snap.you;
    if (you !== null) {
      noteBad(out, `${id}.you.x`, you.x);
      noteBad(out, `${id}.you.z`, you.z);
      noteBad(out, `${id}.you.hp`, you.hp);
      noteBad(out, `${id}.you.maxHp`, you.maxHp);
      noteBad(out, `${id}.you.mana`, you.mana);
      noteBad(out, `${id}.you.maxMana`, you.maxMana);
      noteBad(out, `${id}.you.level`, you.level);
      noteBad(out, `${id}.you.xp`, you.xp);
      noteBad(out, `${id}.you.gold`, you.gold);
      noteBad(out, `${id}.you.respawnAtTick`, you.respawnAtTick);
      you.abilities.forEach((ab, i) => {
        noteBad(out, `${id}.you.ab${i}.rank`, ab.rank);
        noteBad(out, `${id}.you.ab${i}.cd`, ab.cdUntilTick);
      });
      you.itemCharges.forEach((c, i) => noteBad(out, `${id}.you.itemCharges${i}`, c));
      you.itemCdUntilTick.forEach((c, i) => noteBad(out, `${id}.you.itemCd${i}`, c));
    }
    for (const row of snap.board) {
      noteBad(out, `${id}.board.${row.id}.level`, row.level);
      noteBad(out, `${id}.board.${row.id}.kills`, row.kills);
    }
    for (const e of snap.ents) {
      noteBad(out, `${id}.ent${e.id}.x`, e.x);
      noteBad(out, `${id}.ent${e.id}.z`, e.z);
      noteBad(out, `${id}.ent${e.id}.hp`, e.hp);
      noteBad(out, `${id}.ent${e.id}.maxHp`, e.maxHp);
      if (e.lvl !== undefined) noteBad(out, `${id}.ent${e.id}.lvl`, e.lvl);
      if (e.tx !== undefined) noteBad(out, `${id}.ent${e.id}.tx`, e.tx);
      if (e.tz !== undefined) noteBad(out, `${id}.ent${e.id}.tz`, e.tz);
      if (e.atk !== undefined) noteBad(out, `${id}.ent${e.id}.atk`, e.atk);
    }
  }
}

// ---- match driver -----------------------------------------------------------------

const MATCH_SEEDS: Readonly<Record<number, readonly number[]>> = {
  2: [0xace1, 0xace2, 0xace3],
  4: [0xbed1, 0xbed2, 0xbed3],
  8: [0xcafe1, 0xcafe2, 0xcafe3],
};

/**
 * Gold checkpoint at 10:00. The observer rebinds (its own purse is then on the
 * wire), then the bot seats are walked through the public late-joiner flow —
 * displace (inherit purse), read one snapshot, convert back to a bot-driven
 * ghost. Displacement always consumes the OLDEST remaining bot seat, and
 * seats array order is the roster order captured at lock, so probe i maps
 * 1:1 to botSeats[i]. Returns the extra ticks consumed (the sim advances
 * during probing).
 */
function probeGoldAt10(
  room: RiftRoom,
  io: ProbeIO,
  botSeats: readonly RosterEntry[],
): { samples: GoldSample[]; ticksUsed: number } {
  const samples: GoldSample[] = [];
  let ticks = 0;

  room.addPlayer('p1', 'Ada', 'p1'); // rebind the observer ghost
  room.tickOnce();
  ticks += 1;
  const own = io.you.get('p1');
  if (own !== undefined) {
    samples.push({ pid: 'p1', team: io.observerTeam('p1'), gold: effectiveGold(own) });
  }
  for (const seat of botSeats) {
    const probeId = `gp-${seat.id}`;
    room.addPlayer(probeId, 'GP'); // displaces the oldest remaining bot seat
    io.alias.set(probeId, seat.id);
    room.tickOnce(); // exactly one snapshot for the probe's inherited hero
    ticks += 1;
    const y = io.you.get(probeId);
    samples.push({
      pid: seat.id,
      team: seat.team,
      gold: y !== undefined ? effectiveGold(y) : NaN,
    });
    room.removePlayer(probeId, false); // ghost: same-seed bot brain drives on
  }
  room.removePlayer('p1'); // observer back to bot-driven ghost
  return { samples, ticksUsed: ticks };
}

/** One full all-bot match, pumped headless to its end (ancient or hard cap). */
function runMatch(teamSize: number, seed: number): MatchResult {
  vi.useFakeTimers();
  const io = new ProbeIO();
  const deps: RoomDeps = { rand: rng(seed) };
  const room = new RiftRoom('public', io, { teamSize }, deps);
  const lanes = LANES_FOR_TEAM_SIZE[teamSize] ?? 1;
  try {
    room.start();
    room.addPlayer('p1', 'Ada'); // -> team 0 (first seat)
    room.start();
    room.handleMessage('p1', { t: 'rift_start' });
    vi.advanceTimersToNextTimer(); // LOBBY_COUNTDOWN_MS -> lock()
    if (room.info().phase !== 'live') {
      throw new Error(`match ${teamSize}v${teamSize} seed ${seed}: lock failed`);
    }

    // Canonical bot seats, in room seat order, from the lock-time roster
    // (recorded while the observer is still connected).
    const botSeats = io.botSeats();

    // Even bot skill from here on: the observer's hero gets a bot brain too.
    room.removePlayer('p1');

    let tick = 0;
    let gold10: GoldSample[] | null = null;
    while (room.info().phase === 'live' && tick <= HARD_CAP_TICKS + 2) {
      room.tickOnce();
      tick += 1;
      if (gold10 === null && tick >= GOLD_SAMPLE_TICK) {
        const probe = probeGoldAt10(room, io, botSeats);
        gold10 = probe.samples;
        tick += probe.ticksUsed;
      } else if (tick % SAMPLE_WINDOW === 0) {
        room.addPlayer('p1', 'Ada', 'p1'); // observation window
        for (let i = 0; i < WINDOW_TICKS; i++) {
          room.tickOnce();
          tick += 1;
        }
        room.removePlayer('p1');
      }
    }

    // The room caches rift_end during the ended dwell and replays it to a
    // rejoining ghost (CONTRACT §2) — the authoritative reason/winner/stats.
    if (room.info().phase === 'ended' && io.endEvent() === undefined) {
      room.addPlayer('p1', 'Ada', 'p1');
    }
    const end = io.endEvent();
    const endTick = tick;
    const endMin = endTick / TICKS_PER_MIN;

    const firstDead = io.firstTowerDeadTick();

    // Level-6 times across ALL seats (every seat is bot-driven); heroes that
    // never reached 6 are censored at match end (a lower bound on their true
    // time, so the median never flattered).
    const level6Times: number[] = [];
    let unreached = 0;
    const allPids = [...botSeats.map((s) => s.id), 'p1'];
    for (const pid of allPids) {
      const t6 = io.level6Tick.get(pid);
      if (t6 === undefined) {
        unreached += 1;
        level6Times.push(endMin);
      } else {
        level6Times.push(t6 / TICKS_PER_MIN);
      }
    }

    // End-of-match stats feed the NaN sweep too.
    if (end !== undefined) {
      for (const s of end.stats) {
        noteBad(io.nanReports, `end.${s.id}.goldEarned`, s.goldEarned);
        noteBad(io.nanReports, `end.${s.id}.heroDamage`, s.heroDamage);
        noteBad(io.nanReports, `end.${s.id}.structureDamage`, s.structureDamage);
      }
    }

    const teamGold10: [number, number] | null =
      gold10 === null
        ? null
        : [
            gold10.filter((g) => g.team === 0).reduce((a, g) => a + g.gold, 0),
            gold10.filter((g) => g.team === 1).reduce((a, g) => a + g.gold, 0),
          ];

    return {
      teamSize,
      lanes,
      seed,
      endReason: end?.reason ?? null,
      winner: end?.winner ?? null,
      endTick,
      durationMin: endMin,
      firstTowerMin: firstDead === null ? null : firstDead / TICKS_PER_MIN,
      level6MedianMin: medianOf(level6Times),
      level6TimesMin: level6Times,
      level6Unreached: unreached,
      gold10,
      teamGold10,
      nanReports: [...io.nanReports],
      tickAnomalies: io.tickAnomalies,
      ioErrors: [...io.errors],
    };
  } finally {
    room.stop();
    vi.useRealTimers();
  }
}

function fmt(v: number | null, digits = 2): string {
  return v === null ? '  n/a' : v.toFixed(digits);
}

// ---- the suite ---------------------------------------------------------------------

const results: MatchResult[] = [];
const reportLines: string[] = [];

describe('rift balance harness (T13 — CONTRACT §9 bands, measured)', () => {
  beforeAll(() => {
    for (const teamSize of [2, 4, 8]) {
      for (const seed of MATCH_SEEDS[teamSize] ?? []) {
        results.push(runMatch(teamSize, seed));
      }
    }
    // ---- human-readable distribution report (also the tuning evidence) ----
    reportLines.push('=== rift balance report (T13) ===');
    for (const r of results) {
      const goldMed = medianOf((r.gold10 ?? []).map((g) => g.gold));
      const tg = r.teamGold10;
      const div =
        tg === null || Math.max(tg[0], tg[1]) <= 0
          ? null
          : Math.abs(tg[0] - tg[1]) / Math.max(tg[0], tg[1]);
      reportLines.push(
        `${r.teamSize}v${r.teamSize} seed 0x${r.seed.toString(16)} lanes=${r.lanes} ` +
          `end=${r.endReason ?? 'NONE'}@${fmt(r.durationMin, 1)}min winner=${String(r.winner)} ` +
          `firstTower=${fmt(r.firstTowerMin, 1)}min ` +
          `lvl6med=${fmt(r.level6MedianMin, 1)}min (unreached=${r.level6Unreached}) ` +
          `gold10med=${fmt(goldMed, 0)} div10=${fmt(div === null ? null : div * 100, 1)}% ` +
          `nan=${r.nanReports.length} anomalies=${r.tickAnomalies}`,
      );
    }
    const ancient = results.filter((r) => r.endReason === 'ancient').map((r) => r.durationMin);
    reportLines.push(
      `ancient-kill durations (min): [${ancient.map((d) => d.toFixed(1)).join(', ')}] ` +
        `median=${fmt(medianOf(ancient), 2)} ` +
        `non-ancient=${results.filter((r) => r.endReason !== 'ancient').length}/${results.length}`,
    );
    // eslint-disable-next-line no-console
    console.log(reportLines.join('\n'));
  }, 285_000);

  afterAll(() => {
    vi.useRealTimers();
  });

  it('every match ends (ancient/tiebreak/draw) at or before the hard cap; the tick always advances; no IO errors', () => {
    expect(results).toHaveLength(9);
    for (const r of results) {
      const label = `${r.teamSize}v${r.teamSize} seed 0x${r.seed.toString(16)}`;
      expect(r.ioErrors, label).toEqual([]);
      expect(r.endReason, `${label} never ended`).not.toBeNull();
      expect(['ancient', 'tiebreak', 'draw']).toContain(r.endReason);
      expect(r.endTick, `${label} ran past MATCH_HARD_CAP_S`).toBeLessThanOrEqual(HARD_CAP_TICKS + 2);
      expect(r.endTick, `${label} ended suspiciously early`).toBeGreaterThan(0);
      expect(r.tickAnomalies, `${label}: duplicate/regressing snapshot ticks`).toBe(0);
    }
  });

  it('median match duration by Ancient kill is 12-18 min game-time across the set', () => {
    const ancient = results.filter((r) => r.endReason === 'ancient').map((r) => r.durationMin);
    expect(ancient.length, 'no match ended by Ancient kill — sim stall finding').toBeGreaterThan(0);
    const med = medianOf(ancient);
    expect(med).not.toBeNull();
    expect(med as number, `median ancient-kill duration ${fmt(med)}min`).toBeGreaterThanOrEqual(12);
    expect(med as number, `median ancient-kill duration ${fmt(med)}min`).toBeLessThanOrEqual(18);
  });

  it('the hard cap is a backstop: tiebreak/draw in < 20% of matches (<= 1 of 9)', () => {
    const nonAncient = results.filter((r) => r.endReason !== 'ancient').length;
    expect(nonAncient, `${nonAncient}/9 matches needed the tiebreak`).toBeLessThanOrEqual(1);
  });

  it('first tower falls at 5-8 min median', () => {
    const falls: number[] = [];
    for (const r of results) {
      const label = `${r.teamSize}v${r.teamSize} seed 0x${r.seed.toString(16)}`;
      expect(r.firstTowerMin, `${label}: no tower ever fell`).not.toBeNull();
      if (r.firstTowerMin !== null) falls.push(r.firstTowerMin);
    }
    const med = medianOf(falls);
    expect(med).not.toBeNull();
    expect(med as number, `median first-tower ${fmt(med)}min`).toBeGreaterThanOrEqual(5);
    expect(med as number, `median first-tower ${fmt(med)}min`).toBeLessThanOrEqual(8);
  });

  it('heroes reach level 6 between 6-11 min at 2v2/4v4, by ~14 min at 8v8', () => {
    for (const size of [2, 4, 8]) {
      const times = results.filter((r) => r.teamSize === size).flatMap((r) => r.level6TimesMin);
      expect(times.length).toBeGreaterThan(0);
      const med = medianOf(times);
      expect(med).not.toBeNull();
      if (size === 8) {
        expect(med as number, `8v8 level-6 median ${fmt(med)}min`).toBeLessThanOrEqual(14.5);
      } else {
        expect(med as number, `${size}v${size} level-6 median ${fmt(med)}min`).toBeGreaterThanOrEqual(6);
        expect(med as number, `${size}v${size} level-6 median ${fmt(med)}min`).toBeLessThanOrEqual(11);
      }
    }
  });

  it('gold per hero at 10 min is 2200-5500 (median per match; all finite)', () => {
    for (const r of results) {
      const label = `${r.teamSize}v${r.teamSize} seed 0x${r.seed.toString(16)}`;
      expect(r.gold10, `${label}: ended before 10:00`).not.toBeNull();
      const samples = r.gold10 ?? [];
      expect(samples.length).toBeGreaterThan(0);
      for (const g of samples) {
        expect(Number.isFinite(g.gold), `${label}: NaN gold for ${g.pid}`).toBe(true);
      }
      const med = medianOf(samples.map((g) => g.gold));
      expect(med).not.toBeNull();
      expect(med as number, `${label} gold10 median ${fmt(med, 0)}`).toBeGreaterThanOrEqual(2200);
      expect(med as number, `${label} gold10 median ${fmt(med, 0)}`).toBeLessThanOrEqual(5500);
    }
  });

  it('team gold divergence at 10 min is < 40%', () => {
    for (const r of results) {
      const label = `${r.teamSize}v${r.teamSize} seed 0x${r.seed.toString(16)}`;
      expect(r.teamGold10, label).not.toBeNull();
      const tg = r.teamGold10;
      if (tg === null) continue;
      const div = Math.abs(tg[0] - tg[1]) / Math.max(tg[0], tg[1]);
      expect(div, `${label} divergence ${(div * 100).toFixed(1)}%`).toBeLessThan(0.4);
    }
  });

  it('no NaN/Infinity in any sampled snapshot field or end-of-match stat', () => {
    for (const r of results) {
      const label = `${r.teamSize}v${r.teamSize} seed 0x${r.seed.toString(16)}`;
      expect(r.nanReports, `${label}: ${r.nanReports.join('; ')}`).toEqual([]);
    }
  });
});

// ---- §10 perf budget ----------------------------------------------------------------

class NullIO implements RoomIO {
  send(): void {
    // perf run: IO is deliberately a black hole (no snapshot fan-out cost)
  }

  rttMs(): number {
    return 0;
  }
}

describe('rift sim tick budget (CONTRACT §10: <= 2ms at 8v8, headless)', () => {
  it('measures tickOnce wall time p95 over a full 8v8 bot match', { timeout: 240_000 }, () => {
    vi.useFakeTimers();
    const io = new NullIO();
    const room = new RiftRoom('public', io, { teamSize: 8 }, { rand: rng(0xf00d) });
    const times: number[] = [];
    try {
      room.start();
      room.addPlayer('p1', 'Ada');
      room.start();
      room.handleMessage('p1', { t: 'rift_start' });
      vi.advanceTimersToNextTimer(); // -> lock
      if (room.info().phase !== 'live') throw new Error('perf match: lock failed');
      room.removePlayer('p1'); // ghost: all 16 seats bot-driven, zero channels
      vi.useRealTimers(); // wall-clock measurement from here on
      let guard = HARD_CAP_TICKS + 5;
      while (room.info().phase === 'live' && guard > 0) {
        guard -= 1;
        const t0 = performance.now();
        room.tickOnce();
        times.push(performance.now() - t0);
      }
    } finally {
      room.stop();
      vi.useRealTimers();
    }
    const warm = times.slice(200); // JIT warm-up excluded from the budget check
    const p50 = percentileOf(warm, 0.5);
    const p95 = percentileOf(warm, 0.95);
    const p99 = percentileOf(warm, 0.99);
    const max = percentileOf(warm, 1);
    // eslint-disable-next-line no-console
    console.log(
      `=== rift perf (8v8 headless tick) === ticks=${times.length} ` +
        `p50=${fmt(p50, 3)}ms p95=${fmt(p95, 3)}ms p99=${fmt(p99, 3)}ms max=${fmt(max, 3)}ms`,
    );
    expect(warm.length).toBeGreaterThan(1000);
    expect(p95).not.toBeNull();
    expect(p95 as number, `sim tick p95 ${fmt(p95, 3)}ms exceeds the 2ms budget`).toBeLessThanOrEqual(2);
  });
});
