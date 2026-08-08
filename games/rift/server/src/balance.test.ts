// ============================================================================
// ANCIENTS (rift) BALANCE HARNESS (T13) — measures the CONTRACT §9 bands and
// the DESIGN_DELTA §2 jungle relationships over headless all-bot matches,
// pumped through the room's tickOnce() seam (CONTRACT §5), plus the §10
// sim-tick budget at 8v8.
//
// ---------------------------------------------------------------------------
// WHY THIS HARNESS NO LONGER OBSERVES THROUGH THE WIRE (measured, not stylistic)
// ---------------------------------------------------------------------------
// The previous revision observed the match by reconnecting a ghost every 200
// ticks (addPlayer -> 2 snapshots -> removePlayer) and, at 10:00, by walking
// every bot seat through the late-joiner displace/restore flow to read `you`.
//
// Both of those go through `removePlayer`, and `removePlayer` on a live match
// does this (room.ts:383):
//
//     seat.brain = createBotBrain(hashSeed(this.id, seat.seatIndex), ...)
//
// A FRESH brain. `createBotBrain` (bots.ts:320) builds its rng stream and all
// of its state in the closure — `retreating`, `lastWardTick`,
// `skillBlockedUntil`, and `campCommit`/`campReleaseTick`, the jungle
// commitment. So the old flow wiped the observed seat's brain ~100 times per
// match and every seat's brain once at 10:00, and restarted their rng streams
// from the same seed each time.
//
// A/B over the same nine seeds, unperturbed run vs an exact replay of the old
// churn: 9 of 9 matches ended differently.
//
//     metric                    unperturbed        with the old observer churn
//     median ancient duration        18.91 min                     20.36 min
//     tiebreak/draw                     1 / 9                         3 / 9
//     wins (team0 : team1)              4 : 5                         6 : 3
//     4v4 0xbed1                ancient @24.61            tiebreak @30.00
//     8v8 0xcafe2               ancient @14.15             ancient @28.58
//
// The old numbers were measurements of the instrument. Per AMENDMENT_6, a gate
// that reports a number it manufactured is worse than no gate, so the harness
// now takes ONE reference to the live `World` at lock and reads it directly;
// nothing joins or leaves for the duration of the match. The only membership
// call after lock is the single post-match rejoin that replays the cached
// `rift_end` (CONTRACT §2 dwell) — the match is already over at that point.
//
// Consequences of the change, stated so nobody has to rediscover them:
//   - Levels and gold at 10:00 are read at TICK resolution instead of the old
//     10-second sampling window; tower falls at 1-second resolution.
//   - The NaN sweep moved from ~1%-sampled WIRE fields to every numeric field
//     of every entity every second. Wire-shape coverage is protocol.test.ts
//     and room.test.ts's job; this file's job is the sim's numbers.
//   - Gold at 10:00 is still purse + cost of held items — the same quantity the
//     old `you`-probe measured, so the §9 band is compared like for like.
//
// ---------------------------------------------------------------------------
// WHY THE PERF BLOCK IS FIRST IN THIS FILE
// ---------------------------------------------------------------------------
// §10's budget is measured in WALL time, so it measures the process as well as
// the sim. Running it after the harness — six minutes of full matches in the
// same worker — measured a p95 of 2.222 ms with a max of 100.665 ms; the same
// build measured alone reports p50 0.351 / p95 0.507 / max 3.145. The 100 ms
// outliers are collections over the heap the harness left behind, not ticks.
// The budget therefore runs FIRST, on a clean heap. Do not move it back, and if
// it ever fails, re-run this file alone before believing the number.
// ---------------------------------------------------------------------------
//
// METHODOLOGY
// - §9's bands are defined at EVEN BOT SKILL, so every seat must be bot-driven.
//   One fake human is seated to satisfy MIN_PLAYERS; immediately after lock it
//   is disconnected (removePlayer, permanent=false), which puts a same-seed bot
//   brain on its hero. From then on the match is 100% bot-vs-bot and untouched.
// - Randomness varies per match via the injected rand seed: it names the room
//   id, and bot brains derive from hashSeed(roomId, seatIndex) (ports.ts). The
//   sim core itself consumes no rand, so two seeds whose bot brains happen to
//   behave alike produce a bit-identical match — which is why the suite also
//   asserts the sample is non-degenerate.
// - ECONOMY ATTRIBUTION. Every point of hero xp in the sim flows through
//   `splitXpAmongHeroes` (combat.ts:281), so the harness can reproduce it from
//   outside: it keeps the Ent references of every mobile before a tick, and
//   after the tick any that flipped to `!alive` is a death whose `lastHitBy`,
//   corpse position and `xpValue`/`bounty` are all still readable (combat.ts
//   deletes the corpse from `mobileMap`, but the object itself is held here).
//   The split is then recomputed exactly as combat.ts computes it. The suite
//   ASSERTS that the reconstruction matches the heroes' real xp to within
//   0.5% — an instrument that cannot prove it measures the thing is not a gate.
// ============================================================================
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ITEM_LIST,
  LANES_FOR_TEAM_SIZE,
  MATCH_HARD_CAP_S,
  TICK_RATE,
  XP_SHARE_RADIUS,
  HERO_KILL_XP_BASE,
  HERO_KILL_XP_PER_LEVEL,
  isPlayerTeam,
} from '@rift/shared';
import type { EndReason, EntKind, ItemId, RiftEvent, TeamId } from '@rift/shared';
import { rng } from '@platform/shared';
import type { PlayerId, RoomIO } from '@platform/shared';
import { NO_ENT } from './sim/types.js';
import type { Ent, EntId, World } from './sim/types.js';
import type { RoomDeps } from './ports.js';
import { RiftRoom } from './room.js';

// ---- measurement constants ----------------------------------------------------

const TICKS_PER_MIN = TICK_RATE * 60;
const HARD_CAP_TICKS = MATCH_HARD_CAP_S * TICK_RATE; // 36000
const GOLD_SAMPLE_TICK = 10 * TICKS_PER_MIN; // 10:00 — the §9 gold checkpoint
const SWEEP_EVERY = TICK_RATE; // 1 s between full-entity NaN + structure scans
const NAN_REPORT_CAP = 40;
const LEVEL_SIX = 6;

/** Five seeds per team size. Three was the original sample; it put the median
 *  of a 12-18 min band on six ancient kills. The extra two per size are the
 *  next values in each existing sequence — chosen mechanically, and written
 *  down before any result was looked at, so the sample cannot have been fitted
 *  to the bands. */
const MATCH_SEEDS: Readonly<Record<number, readonly number[]>> = {
  2: [0xace1, 0xace2, 0xace3, 0xace4, 0xace5],
  4: [0xbed1, 0xbed2, 0xbed3, 0xbed4, 0xbed5],
  8: [0xcafe1, 0xcafe2, 0xcafe3, 0xcafe4, 0xcafe5],
};
const TEAM_SIZES = [2, 4, 8] as const;
const MATCH_COUNT = TEAM_SIZES.length * 5;
/** §9: "hard cap is a backstop, hit in < 20% of sims". */
const TIEBREAK_ALLOWANCE = Math.floor(MATCH_COUNT * 0.2);

const LANE_CREEP_KINDS: ReadonlySet<EntKind> = new Set<EntKind>(['melee', 'ranged', 'siege']);
const CAMP_KINDS: ReadonlySet<EntKind> = new Set<EntKind>(['campPack', 'campBrute', 'campHive']);

const ITEM_COST = new Map<ItemId, number>();
for (const def of ITEM_LIST) ITEM_COST.set(def.id, def.cost);

type EndEv = Extract<RiftEvent, { t: 'rift_end' }>;

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

function fmt(v: number | null, digits = 2): string {
  return v === null ? '  n/a' : v.toFixed(digits);
}

function noteBad(out: string[], label: string, v: number): void {
  if (!Number.isFinite(v) && out.length < NAN_REPORT_CAP) out.push(`${label}=${String(v)}`);
}

/** FNV-1a step. Two runs of one seed must agree on the folded end-state; two
 *  different seeds should not (see the sample-quality test). */
function mixHash(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), 16777619) >>> 0;
}

// ============================================================================
// §10 perf budget — FIRST in the file, on a clean heap. See the header.
// ============================================================================

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

// ============================================================================
// §9 bands + DESIGN_DELTA §2 relationships
// ============================================================================

interface SourceSplit {
  laneCreep: number;
  camp: number;
  heroKill: number;
  other: number;
}
function emptySplit(): SourceSplit {
  return { laneCreep: 0, camp: 0, heroKill: 0, other: 0 };
}
function splitTotal(s: SourceSplit): number {
  return s.laneCreep + s.camp + s.heroKill + s.other;
}

interface HeroCensus {
  readonly id: EntId;
  readonly team: TeamId;
  level6Tick: number | null;
  gold10: number | null;
  readonly xp: SourceSplit;
  readonly gold: SourceSplit;
}

interface GoldSample {
  readonly id: EntId;
  readonly team: TeamId;
  readonly gold: number; // purse + cost of held items
}

interface MatchResult {
  readonly teamSize: number;
  readonly lanes: number;
  readonly seed: number;
  readonly roomId: string;
  readonly endReason: EndReason | null;
  readonly winner: TeamId | null;
  readonly endTick: number;
  readonly durationMin: number;
  readonly firstTowerMin: number | null;
  readonly level6MedianMin: number | null;
  readonly level6TimesMin: number[];
  readonly level6Unreached: number;
  readonly gold10: GoldSample[] | null;
  readonly teamGold10: [number, number] | null;
  readonly xp: SourceSplit;
  readonly gold: SourceSplit;
  readonly modelledXp: number;
  readonly actualXp: number;
  readonly nanReports: string[];
  readonly tickAnomalies: number;
  readonly ioErrors: string[];
  readonly trajectoryHash: number;
}

/** The room owns its `World` privately. The harness needs the live sim to
 *  measure the match without joining it (see the header). This is the only
 *  place the file reaches past the public surface, and it is read-only. */
interface RoomWorldWindow {
  readonly world: World | null;
}

// ---- the recording IO -------------------------------------------------------------

/** Nothing is connected while the match runs, so this IO only ever sees the
 *  post-match rejoin that replays the cached `rift_end`. */
class ProbeIO implements RoomIO {
  readonly events: RiftEvent[] = [];
  readonly errors: string[] = [];

  send(id: PlayerId, msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) {
      this.errors.push(`non-object message for ${id}`);
      return;
    }
    const t = (msg as { t?: unknown }).t;
    if (t === 'event') {
      this.events.push((msg as { ev: RiftEvent }).ev);
      return;
    }
    if (t === 'error') {
      this.errors.push(`error frame for ${id}: ${JSON.stringify(msg)}`);
    }
    // rift_hello / rift_lobby / rift_begin / rift_snap: not measurements here.
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
}

// ---- match driver -----------------------------------------------------------------

function liveWorld(room: RiftRoom): World {
  const w = (room as unknown as RoomWorldWindow).world;
  if (w === null) throw new Error('room is live but exposes no world');
  return w;
}

/** Which player team a death pays, mirroring combat.ts's `lootTeam`. */
function payingTeam(w: World, victim: Ent): TeamId | null {
  if (isPlayerTeam(victim.team)) return victim.team === 0 ? 1 : 0;
  if (victim.lastHitBy === NO_ENT) return null;
  const killer = w.get(victim.lastHitBy);
  if (killer === undefined) return null;
  return isPlayerTeam(killer.team) ? killer.team : null;
}

function sourceOf(kind: EntKind): keyof SourceSplit {
  if (LANE_CREEP_KINDS.has(kind)) return 'laneCreep';
  if (CAMP_KINDS.has(kind)) return 'camp';
  if (kind === 'hero') return 'heroKill';
  return 'other';
}

function heldItemValue(e: Ent): number {
  let sum = 0;
  for (const it of e.items) {
    if (it === null) continue;
    sum += ITEM_COST.get(it) ?? 0;
  }
  return sum;
}

/** Sweeps every numeric field the sim owns; the wire shape is protocol.ts's. */
function sweepEntity(out: string[], e: Ent, tick: number): void {
  const tag = `t${tick}.ent${e.id}`;
  noteBad(out, `${tag}.x`, e.x);
  noteBad(out, `${tag}.z`, e.z);
  noteBad(out, `${tag}.hp`, e.hp);
  noteBad(out, `${tag}.maxHp`, e.maxHp);
  noteBad(out, `${tag}.mana`, e.mana);
  noteBad(out, `${tag}.maxMana`, e.maxMana);
  noteBad(out, `${tag}.damage`, e.damage);
  noteBad(out, `${tag}.armor`, e.armor);
  noteBad(out, `${tag}.moveSpeed`, e.moveSpeed);
  if (e.kind !== 'hero') return;
  noteBad(out, `${tag}.level`, e.level);
  noteBad(out, `${tag}.xp`, e.xp);
  noteBad(out, `${tag}.gold`, e.gold);
  noteBad(out, `${tag}.goldEarned`, e.goldEarned);
  noteBad(out, `${tag}.respawnAtTick`, e.respawnAtTick);
  for (let i = 0; i < e.abilityRanks.length; i++) {
    noteBad(out, `${tag}.ab${i}.rank`, e.abilityRanks[i] ?? NaN);
    noteBad(out, `${tag}.ab${i}.cd`, e.abilityCdUntilTick[i] ?? NaN);
  }
  for (let i = 0; i < e.itemCharges.length; i++) {
    noteBad(out, `${tag}.itemCharges${i}`, e.itemCharges[i] ?? NaN);
    noteBad(out, `${tag}.itemCd${i}`, e.itemCdUntilTick[i] ?? NaN);
  }
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
    // Even bot skill from here on: the observer's hero gets a bot brain too,
    // and NOTHING joins or leaves again until the match is over.
    room.removePlayer('p1');
    const roomId = room.info().id;
    const w = liveWorld(room);

    const census: HeroCensus[] = [];
    const byId = new Map<EntId, HeroCensus>();
    for (const e of w.mobiles()) {
      if (e.kind !== 'hero' || !isPlayerTeam(e.team)) continue;
      const c: HeroCensus = {
        id: e.id,
        team: e.team,
        level6Tick: null,
        gold10: null,
        xp: emptySplit(),
        gold: emptySplit(),
      };
      census.push(c);
      byId.set(e.id, c);
    }
    const heroEnts: Ent[] = [];
    for (const c of census) {
      const h = w.get(c.id);
      if (h !== undefined) heroEnts.push(h);
    }

    const nanReports: string[] = [];
    const xp = emptySplit();
    const gold = emptySplit();
    const alive: Ent[] = []; // pre-tick census, reused every tick
    const recipients: Ent[] = []; // inRadius buffer, reused every tick
    let firstTowerTick: number | null = null;
    let tickAnomalies = 0;
    let tick = 0;

    while (room.info().phase === 'live' && tick <= HARD_CAP_TICKS + 2) {
      alive.length = 0;
      for (const e of w.mobiles()) if (e.alive) alive.push(e);
      const beforeTick = w.tick;

      room.tickOnce();
      tick += 1;
      if (w.tick !== beforeTick + 1) tickAnomalies += 1;

      // --- deaths this tick. The corpse is gone from `mobileMap` by now, but
      // `alive` holds the object, so xpValue/bounty/lastHitBy/position are all
      // still readable — and a dead ent does not move.
      for (const victim of alive) {
        if (victim.alive) continue;
        const src = sourceOf(victim.kind);

        // Creep bounty goes to the killing hero alone. Hero-kill gold is scaled
        // by the victim's level, which is unrecoverable once it respawns, and
        // it is not part of any band here — so it is left unattributed rather
        // than guessed at, and `gold.heroKill` stays zero by design.
        if (victim.kind !== 'hero' && victim.bounty > 0 && victim.lastHitBy !== NO_ENT) {
          const killer = w.get(victim.lastHitBy);
          if (killer !== undefined && killer.kind === 'hero' && killer.team !== victim.team) {
            const c = byId.get(killer.id);
            if (c !== undefined) {
              c.gold[src] += victim.bounty;
              gold[src] += victim.bounty;
            }
          }
        }

        const team = payingTeam(w, victim);
        const amount =
          victim.kind === 'hero'
            ? HERO_KILL_XP_BASE + HERO_KILL_XP_PER_LEVEL * victim.level
            : victim.xpValue;
        if (team === null || !(amount > 0)) continue;

        const n = w.inRadius(victim.x, victim.z, XP_SHARE_RADIUS, recipients);
        let count = 0;
        for (let i = 0; i < n; i++) {
          const e = recipients[i];
          if (e !== undefined && e.kind === 'hero' && e.alive && e.team === team) count += 1;
        }
        if (count === 0) continue;
        const per = amount / count;
        for (let i = 0; i < n; i++) {
          const e = recipients[i];
          if (e === undefined || e.kind !== 'hero' || !e.alive || e.team !== team) continue;
          const c = byId.get(e.id);
          if (c === undefined) continue;
          c.xp[src] += per;
          xp[src] += per;
        }
      }

      // --- per-tick reads off the live world (heroes only; cheap)
      for (let i = 0; i < census.length; i++) {
        const c = census[i];
        const h = heroEnts[i];
        if (c === undefined || h === undefined) continue;
        if (c.level6Tick === null && h.level >= LEVEL_SIX) c.level6Tick = tick;
        if (c.gold10 === null && tick >= GOLD_SAMPLE_TICK) c.gold10 = h.gold + heldItemValue(h);
      }

      // --- once a second: structures + the full NaN sweep
      if (tick % SWEEP_EVERY === 0) {
        for (const e of w.all()) {
          if (firstTowerTick === null && e.kind === 'tower' && !e.alive) firstTowerTick = tick;
          if (nanReports.length < NAN_REPORT_CAP) sweepEntity(nanReports, e, tick);
        }
        noteBad(nanReports, `t${tick}.worldTick`, w.tick);
      }
    }

    const endTick = tick;
    const endMin = endTick / TICKS_PER_MIN;

    // The room caches rift_end during the ended dwell and replays it to a
    // rejoining ghost (CONTRACT §2). The match is over, so this cannot perturb
    // anything it measures.
    if (room.info().phase === 'ended') room.addPlayer('p1', 'Ada', 'p1');
    const end = io.endEvent();
    if (end !== undefined) {
      for (const s of end.stats) {
        noteBad(nanReports, `end.${s.id}.goldEarned`, s.goldEarned);
        noteBad(nanReports, `end.${s.id}.heroDamage`, s.heroDamage);
        noteBad(nanReports, `end.${s.id}.structureDamage`, s.structureDamage);
      }
    }

    const level6Times: number[] = [];
    let unreached = 0;
    let actualXp = 0;
    let hash = 2166136261;
    const gold10: GoldSample[] = [];
    for (let i = 0; i < census.length; i++) {
      const c = census[i];
      const h = heroEnts[i];
      if (c === undefined || h === undefined) continue;
      // Heroes that never reached 6 are censored at match end — a LOWER bound
      // on their true time, so the median is never flattered.
      if (c.level6Tick === null) {
        unreached += 1;
        level6Times.push(endMin);
      } else {
        level6Times.push(c.level6Tick / TICKS_PER_MIN);
      }
      if (c.gold10 !== null) gold10.push({ id: c.id, team: c.team, gold: c.gold10 });
      actualXp += h.xp;
      for (const v of [h.xp, h.gold, h.kills, h.deaths, Math.round(h.x * 1000), Math.round(h.z * 1000)]) {
        hash = mixHash(hash, v);
      }
    }
    const teamGold10: [number, number] | null =
      gold10.length === 0
        ? null
        : [
            gold10.filter((g) => g.team === 0).reduce((a, g) => a + g.gold, 0),
            gold10.filter((g) => g.team === 1).reduce((a, g) => a + g.gold, 0),
          ];

    return {
      teamSize,
      lanes,
      seed,
      roomId,
      endReason: end?.reason ?? null,
      winner: end?.winner ?? null,
      endTick,
      durationMin: endMin,
      firstTowerMin: firstTowerTick === null ? null : firstTowerTick / TICKS_PER_MIN,
      level6MedianMin: medianOf(level6Times),
      level6TimesMin: level6Times,
      level6Unreached: unreached,
      gold10: gold10.length === 0 ? null : gold10,
      teamGold10,
      xp,
      gold,
      modelledXp: splitTotal(xp),
      actualXp,
      nanReports,
      tickAnomalies,
      ioErrors: [...io.errors],
      trajectoryHash: mixHash(hash, endTick),
    };
  } finally {
    room.stop();
    vi.useRealTimers();
  }
}

// ---- the suite ---------------------------------------------------------------------

const results: MatchResult[] = [];
/** Second run of one seed per team size — the determinism control. */
const repeats: MatchResult[] = [];

describe('rift balance harness (T13 — CONTRACT §9 bands, measured)', () => {
  beforeAll(() => {
    for (const teamSize of TEAM_SIZES) {
      for (const seed of MATCH_SEEDS[teamSize] ?? []) {
        results.push(runMatch(teamSize, seed));
      }
      const control = MATCH_SEEDS[teamSize]?.[0];
      if (control !== undefined) repeats.push(runMatch(teamSize, control));
    }

    // ---- human-readable distribution report (also the tuning evidence) ----
    const lines: string[] = ['=== rift balance report (T13) ==='];
    for (const r of results) {
      const goldMed = medianOf((r.gold10 ?? []).map((g) => g.gold));
      const tg = r.teamGold10;
      const div =
        tg === null || Math.max(tg[0], tg[1]) <= 0
          ? null
          : Math.abs(tg[0] - tg[1]) / Math.max(tg[0], tg[1]);
      const creepGold = r.gold.laneCreep + r.gold.camp;
      const creepXp = r.xp.laneCreep + r.xp.camp;
      lines.push(
        `${r.teamSize}v${r.teamSize} 0x${r.seed.toString(16)} lanes=${r.lanes} ` +
          `end=${r.endReason ?? 'NONE'}@${fmt(r.durationMin, 1)}min win=${String(r.winner)} ` +
          `tower1=${fmt(r.firstTowerMin, 1)} lvl6med=${fmt(r.level6MedianMin, 1)}(miss ${r.level6Unreached}) ` +
          `gold10med=${fmt(goldMed, 0)} div=${fmt(div === null ? null : div * 100, 1)}% ` +
          `| xp lane/camp/kill ${fmt((100 * r.xp.laneCreep) / r.modelledXp, 0)}/` +
          `${fmt((100 * r.xp.camp) / r.modelledXp, 0)}/${fmt((100 * r.xp.heroKill) / r.modelledXp, 0)}% ` +
          `| jungle share of creep gold ${fmt(creepGold > 0 ? (100 * r.gold.camp) / creepGold : null, 1)}% ` +
          `xp ${fmt(creepXp > 0 ? (100 * r.xp.camp) / creepXp : null, 1)}% ` +
          `| hash=${r.trajectoryHash.toString(16)} nan=${r.nanReports.length} anom=${r.tickAnomalies}`,
      );
    }
    const ancient = results.filter((r) => r.endReason === 'ancient').map((r) => r.durationMin);
    lines.push(
      `ancient-kill durations (min): [${ancient.map((d) => d.toFixed(1)).join(', ')}] ` +
        `median=${fmt(medianOf(ancient), 2)} ` +
        `non-ancient=${results.length - ancient.length}/${results.length}`,
    );
    for (const size of TEAM_SIZES) {
      const g = results.filter((r) => r.teamSize === size);
      const gAnc = g.filter((r) => r.endReason === 'ancient').map((r) => r.durationMin);
      lines.push(
        `${size}v${size}: duration median ${fmt(medianOf(gAnc))}min over ${gAnc.length} ancient kills, ` +
          `level-6 median ${fmt(medianOf(g.flatMap((r) => r.level6TimesMin)))}min, ` +
          `wins ${g.filter((r) => r.winner === 0).length}:${g.filter((r) => r.winner === 1).length}, ` +
          `distinct matches ${new Set(g.map((r) => r.trajectoryHash)).size}/${g.length}`,
      );
    }
    lines.push(
      `wins overall team0=${results.filter((r) => r.winner === 0).length} ` +
        `team1=${results.filter((r) => r.winner === 1).length} ` +
        `undecided=${results.filter((r) => r.winner === null).length}`,
    );
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }, 900_000);

  afterAll(() => {
    vi.useRealTimers();
  });

  it('every match ends (ancient/tiebreak/draw) at or before the hard cap; the tick always advances; no IO errors', () => {
    expect(results).toHaveLength(MATCH_COUNT);
    for (const r of results) {
      const label = `${r.teamSize}v${r.teamSize} seed 0x${r.seed.toString(16)}`;
      expect(r.ioErrors, label).toEqual([]);
      expect(r.endReason, `${label} never ended`).not.toBeNull();
      expect(['ancient', 'tiebreak', 'draw']).toContain(r.endReason);
      expect(r.endTick, `${label} ran past MATCH_HARD_CAP_S`).toBeLessThanOrEqual(HARD_CAP_TICKS + 2);
      expect(r.endTick, `${label} ended suspiciously early`).toBeGreaterThan(0);
      expect(r.tickAnomalies, `${label}: world tick did not advance by exactly 1`).toBe(0);
    }
  });

  it('the harness measures the real economy: reconstructed xp matches the heroes own xp', () => {
    for (const r of results) {
      const label = `${r.teamSize}v${r.teamSize} seed 0x${r.seed.toString(16)}`;
      expect(r.actualXp, `${label}: no xp was earned at all`).toBeGreaterThan(0);
      const err = Math.abs(r.modelledXp - r.actualXp) / r.actualXp;
      expect(
        err,
        `${label}: attribution model is ${(err * 100).toFixed(2)}% off ` +
          `(modelled ${r.modelledXp.toFixed(0)} vs actual ${r.actualXp.toFixed(0)}) — ` +
          'every number this harness reports about xp SOURCES is suspect until this is 0',
      ).toBeLessThan(0.005);
    }
  });

  it('identical seeds produce identical matches (determinism is not negotiable)', () => {
    expect(repeats).toHaveLength(TEAM_SIZES.length);
    for (const rep of repeats) {
      const first = results.find((r) => r.teamSize === rep.teamSize && r.seed === rep.seed);
      expect(first, `no first run for ${rep.teamSize}v${rep.teamSize} 0x${rep.seed.toString(16)}`).toBeDefined();
      if (first === undefined) continue;
      const label = `${rep.teamSize}v${rep.teamSize} seed 0x${rep.seed.toString(16)}`;
      expect(rep.roomId, `${label}: room id differs between runs`).toBe(first.roomId);
      expect(rep.endTick, `${label}: duration differs between runs`).toBe(first.endTick);
      expect(rep.endReason, `${label}: end reason differs between runs`).toBe(first.endReason);
      expect(rep.winner, `${label}: winner differs between runs`).toBe(first.winner);
      expect(
        rep.trajectoryHash,
        `${label}: the same seed produced a DIFFERENT match — a real defect, not a threshold`,
      ).toBe(first.trajectoryHash);
    }
  });

  it('the sample is not degenerate: the seeds produce distinct matches', () => {
    // The sim core consumes no rand (ports.ts): a seed only varies a match
    // through hashSeed(roomId, seat) -> bot brains. Seeds that collapse to one
    // trajectory shrink the sample every median below is computed over, and
    // over-weight whichever outcome they share. This is an instrument check,
    // not a balance band — but a distribution measured over a degenerate sample
    // is exactly the AMENDMENT_6 failure of reporting a number that means less
    // than it looks like it means.
    for (const size of TEAM_SIZES) {
      const group = results.filter((r) => r.teamSize === size);
      const distinct = new Set(group.map((r) => r.trajectoryHash));
      expect(
        distinct.size,
        `${size}v${size}: ${group.length} seeds produced only ${distinct.size} distinct matches`,
      ).toBe(group.length);
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

  it('the hard cap is a backstop: tiebreak/draw in < 20% of matches', () => {
    const nonAncient = results.filter((r) => r.endReason !== 'ancient').length;
    expect(
      nonAncient,
      `${nonAncient}/${results.length} matches needed the tiebreak`,
    ).toBeLessThanOrEqual(TIEBREAK_ALLOWANCE);
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
    for (const size of TEAM_SIZES) {
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
        expect(Number.isFinite(g.gold), `${label}: NaN gold for ent ${g.id}`).toBe(true);
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

  it('the map is mirrored: neither side is systematically richer at 10 min', () => {
    // Signed and aggregated. The per-match divergence above is unsigned and so
    // cannot see a consistent lean; this can, and it has far less variance than
    // a win count over a handful of matches.
    let t0 = 0;
    let t1 = 0;
    for (const r of results) {
      const tg = r.teamGold10;
      if (tg === null) continue;
      t0 += tg[0];
      t1 += tg[1];
    }
    expect(t0 + t1).toBeGreaterThan(0);
    const bias = (t0 - t1) / (t0 + t1);
    expect(
      Math.abs(bias),
      `team-0 gold lead at 10 min is ${(bias * 100).toFixed(1)}% of the pool ` +
        `(team0=${t0.toFixed(0)}, team1=${t1.toFixed(0)}) across ${results.length} matches`,
    ).toBeLessThan(0.1);
  });

  it('neither side wins more than 55% of decided matches', () => {
    // Side bias, not hero balance: the two teams are drawn from the same hero
    // cycle in alternating seat order, so a lopsided split WITHIN one team size
    // is a hero matchup and is reported above rather than gated here.
    const decided = results.filter((r) => r.winner !== null);
    expect(decided.length, 'no match was decided').toBeGreaterThan(0);
    const w0 = decided.filter((r) => r.winner === 0).length;
    const w1 = decided.length - w0;
    const top = Math.max(w0, w1) / decided.length;
    expect(
      top,
      `wins team0=${w0} team1=${w1} of ${decided.length} decided ` +
        `(${(top * 100).toFixed(1)}% to the leader)`,
    ).toBeLessThanOrEqual(0.55);
  });

  it('the jungle is a supplement, not the main course (DESIGN_DELTA §2)', () => {
    for (const r of results) {
      const label = `${r.teamSize}v${r.teamSize} seed 0x${r.seed.toString(16)}`;
      const creepGold = r.gold.laneCreep + r.gold.camp;
      expect(creepGold, `${label}: no creep gold was collected at all`).toBeGreaterThan(0);
      const jungleShare = r.gold.camp / creepGold;
      // "Total jungle income per half must be below total lane income per
      // half" — transcribed literally, onto income actually COLLECTED. The
      // production pools are already below it (config.ts derivation (c)), so if
      // the realised split inverts it is because lanes are being abandoned, not
      // because a camp pays too much.
      expect(
        jungleShare,
        `${label}: camps paid ${(jungleShare * 100).toFixed(1)}% of all creep gold ` +
          `(camp ${r.gold.camp.toFixed(0)} vs lane ${r.gold.laneCreep.toFixed(0)}) — ` +
          'clearing camps out-earns laning outright',
      ).toBeLessThan(0.5);
      // ...and meaningful: a jungle nobody farms is a dead feature.
      expect(
        jungleShare,
        `${label}: camps paid only ${(jungleShare * 100).toFixed(1)}% of creep gold`,
      ).toBeGreaterThan(0.05);
    }
  });

  it('jungling pays MORE gold and LESS experience than laning (DESIGN_DELTA §2)', () => {
    for (const r of results) {
      const label = `${r.teamSize}v${r.teamSize} seed 0x${r.seed.toString(16)}`;
      expect(r.xp.camp, `${label}: camps paid no xp`).toBeGreaterThan(0);
      expect(r.xp.laneCreep, `${label}: lane creeps paid no xp`).toBeGreaterThan(0);
      const campRatio = r.gold.camp / r.xp.camp;
      const laneRatio = r.gold.laneCreep / r.xp.laneCreep;
      expect(
        campRatio,
        `${label}: camps pay ${campRatio.toFixed(2)} gold per xp, lane creeps ${laneRatio.toFixed(2)} — ` +
          'the jungle must be the gold-weighted side of the trade',
      ).toBeGreaterThan(laneRatio);
      // ...and xp must be the axis the jungle LOSES on.
      const jungleXpShare = r.xp.camp / (r.xp.camp + r.xp.laneCreep);
      const jungleGoldShare = r.gold.camp / (r.gold.camp + r.gold.laneCreep);
      expect(
        jungleXpShare,
        `${label}: jungle is ${(jungleXpShare * 100).toFixed(1)}% of creep xp but only ` +
          `${(jungleGoldShare * 100).toFixed(1)}% of creep gold`,
      ).toBeLessThan(jungleGoldShare);
    }
  });

  it('no NaN/Infinity in any sim entity field or end-of-match stat', () => {
    for (const r of results) {
      const label = `${r.teamSize}v${r.teamSize} seed 0x${r.seed.toString(16)}`;
      expect(r.nanReports, `${label}: ${r.nanReports.join('; ')}`).toEqual([]);
    }
  });
});
