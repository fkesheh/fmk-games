// ============================================================================
// SKI SPLAT — CONTAINMENT SWEEP (CONTRACT §12.4 gate 7, §12.2a).
//
// The empirical evidence that the two v3 gameplay changes — the AIR LOCK
// (§12.1) and the RAISED TERRAIN AMPLITUDE (§12.2a) — did not break the
// 4-year-old law: a child holding one direction always lands, is never stuck,
// never leaves the mountain, and always reaches the finish.
//
// WHY THIS IS A VITEST SUITE AND NOT A SCRIPT (§12.2, rev 2): v2 shipped this
// evidence as `docs/splat-v2/prototype-v2.mts`, which (a) never ran in CI, so
// the evidence rotted, and (b) hand-rolled its own `stepSkiV2`, so it measured
// a replica instead of the shipped sim. THIS FILE IMPORTS AND CALLS THE REAL
// `stepSki` AND THE REAL `genSlope`. There is no physics in this file — only a
// driver policy (what the player holds) and instrumentation (what we observed).
//
// THREE SWEEPS, because they measure different things and none can substitute
// for another:
//
//   1. FULL LOCK (§12.4 gate 7) — steer pinned to +1 / -1 for the whole run,
//      20 seeds x 2 directions, kickers present. This is the 4-year-old.
//      MEASURED FACT, recorded so it is not rediscovered: a full-lock skier
//      launches off ZERO kickers. Kickers sit on the corridor centreline with
//      `halfWidth = KICKER_HALF_WIDTH` (1.6 m) and a full-lock skier leaves the
//      centreline within the first second, so the `|x - k.x| <= halfWidth`
//      capture test never passes. The sweep therefore proves containment and
//      finishing, and proves NOTHING about flight — which is exactly why
//      sweep 2 exists.
//
//   2. CORRIDOR FOLLOWING (§12.2a's two new gates) — the driver holds the
//      bearing to the next unconsumed kicker, so it actually RIDES the ramps
//      (174 launches of a possible 180 across the 20 seeds). This is the only
//      sweep in the repo that produces real kicker flights in bulk, and it is
//      where `max flight < KICKER_SPACING` and `zero J_MAX_AIRTIME_S cap hits`
//      are measured. Its non-vacuity is asserted explicitly (a minimum launch
//      count per seed) so it can never silently degrade into sweep 1.
//
//   3. KICKER-CHASE-THEN-HOLD (edge-approach transient) — chases the corridor
//      bearing toward the next unconsumed kicker (sweep 2's law), then LOCKS
//      one direction for the final `lead` metres before it. Neither sweep 1
//      nor sweep 2 exercises this: sweep 1 never tracks a kicker (it leaves
//      the centreline immediately) and sweep 2 never locks a heading (it is
//      always correcting toward the next ramp), so neither can arrive at the
//      soft edge already carrying substantial |yaw| the way an ordinary child
//      who "aims, then commits" does. This sweep can and does exceed
//      `CONTAINMENT_M` — that is real physics (the soft edge, `sim.ts:347-355`,
//      is tuned around the full-lock EQUILIBRIUM excursion, and a transient
//      arrival overshoots it), not a test bug — so it is gated on its own,
//      separately measured and documented `TRANSIENT_CONTAINMENT_M` instead of
//      silently weakening `CONTAINMENT_M` for sweeps 1 and 2, where the tight
//      bound remains true and is kept. See `TRANSIENT_CONTAINMENT_M` below for
//      the derivation and the non-vacuity guard that proves this sweep is
//      actually probing the failure mode rather than passing on an empty set.
//
// Instrumentation notes (all read shipped state; none re-derives physics):
//  - A flight OPENS on the step where `airborne` goes false->true, and its
//    launch point is the post-step (x, z) — the same position `stepSki` used
//    for `airStartY`, because the kicker scan runs after motion.
//  - A flight CLOSES on the step where `airborne` goes true->false. Airtime is
//    `(simMs - airStartMs) / 1000` evaluated with the airStartMs captured at
//    launch — bit-identical to the `t` the sim itself tests against
//    `J_MAX_AIRTIME_S`, so `airtime >= J_MAX_AIRTIME_S` IS the cap firing.
//  - A land-and-relaunch inside one step would make a flight unmeasurable
//    (airStartMs is overwritten before we look). We detect it via the
//    airStartMs change and assert it never happens, rather than silently
//    mis-attributing a flight.
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  J_MAX_AIRTIME_S,
  KICKER_SPACING,
  SIM_DT,
  UND_LAT_AMP,
  UND_LONG_1_AMP,
  UND_LONG_1_LEN,
  UND_LONG_2_AMP,
  UND_LONG_2_LEN,
} from './config.js';
import { makeSim, stepSki } from './sim.js';
import { genSlope } from './slope.js';
import type { SkierSim, SlopeDef } from './types.js';

/** §12.4 gate 7: twenty seeds. Seeds 1..20, matching the existing 4-year-old
 *  suites in `sim.test.ts` and `slope.test.ts` so the evidence is comparable. */
const SEEDS: readonly number[] = Array.from({ length: 20 }, (_, i) => i + 1);

/** 9000 steps x SIM_DT = 300 s of sim time — well past RACE_HARD_CAP_MS
 *  (150 s). A run that has not finished by here is stuck, not slow. */
const MAX_STEPS = 9000;

/** §12.4 gate 7 / `sim.test.ts:1235`: metres past the piste edge a contained
 *  skier may reach, for sweeps 1 (full lock) and 2 (corridor following). NOT
 *  to be relaxed for those two — a failure in either is a blocking finding.
 *  This bound is NOT asserted against sweep 3 (see below): it measures a
 *  different failure mode the full-lock EQUILIBRIUM tuning was never meant to
 *  cover, and forcing sweep 3 under it would misrepresent either the mistuned
 *  soft edge as fixed or the bound as universal — neither is true. */
const CONTAINMENT_M = 3.5;

/** Sweep 3 only (kicker-chase-then-hold, see the header). MEASURED, not
 *  guessed: the real `stepSki`/`genSlope`, this exact policy, swept 20 seeds
 *  x 2 directions x leads 0..20 (this suite's `SEEDS` x `LEADS`, 840 runs) —
 *  worst excursion **6.462 m** (seed 9, dir -1, lead 1). A wider, uncommitted
 *  research sweep (500 seeds x 2 directions x leads 0..40, 41,000 runs) found
 *  worst **6.942 m** (seed 141, dir +1, lead 6) and did not grow further with
 *  more seeds or a wider lead range — the tail is stable, not unbounded.
 *  7.5 m keeps ~0.55 m of margin over the widest measurement found while
 *  still being tight enough to catch a real regression (e.g. the soft edge
 *  being weakened further, or a policy variant that overshoots materially
 *  more than what was measured here). All runs land, none stick, and every
 *  run finishes — this bound is purely about the OFF-PISTE excursion, the
 *  same "never leaves the mountain" law sweeps 1 and 2 assert, just measured
 *  honestly for a policy that produces a transient the other two do not. */
const TRANSIENT_CONTAINMENT_M = 7.5;

/** Sweep 3's lead sweep: metres of "final approach" before the next
 *  unconsumed kicker over which the driver locks a direction instead of
 *  chasing the bearing. 0..20 by 1 m, matching the reviewer probe that found
 *  this failure mode (leads 0..20, step 1 => 21 values). */
const LEADS: readonly number[] = Array.from({ length: 21 }, (_, i) => i);

/** genSlope is deterministic and pure, so one slope per seed is shared by both
 *  sweeps. Regenerating per run would dominate the runtime of the suite. */
const slopeCache = new Map<number, SlopeDef>();
function slopeFor(seed: number): SlopeDef {
  let s = slopeCache.get(seed);
  if (s === undefined) {
    s = genSlope(seed);
    slopeCache.set(seed, s);
  }
  return s;
}

/** What the player is holding this step. Policy only — never physics. */
type Driver = (s: Readonly<SkierSim>, slope: SlopeDef) => number;

interface RunResult {
  readonly finished: boolean;
  readonly steps: number;
  /** THE 4-year-old failure: the run ran out of steps with the skier still in
   *  the air. Distinct from finishing mid-arc, which is legal — `stepSki`
   *  freezes a finished skier, so `airborne` simply stays true forever. */
  readonly stuckAloft: boolean;
  /** Crossed `finishZ` mid-flight. Legal; recorded because it TRUNCATES that
   *  flight — the landing never happens, so the segment is deliberately left
   *  out of the flight statistics rather than measured against a frozen sim. */
  readonly finishedInFlight: boolean;
  /** max (|x| - width/2) over every step; <= 0 means never off the piste. */
  readonly maxOffPiste: number;
  /** completed airborne segments (launch AND landing observed). */
  readonly flights: number;
  /** max ground-plane distance launch -> landing, hypot(dx, dz). This is >= the
   *  z-distance, so gating on it is strictly stronger than the frozen
   *  "never overshoots the next ramp" law, which is about z spacing. */
  readonly maxFlightDist: number;
  /** max z-distance launch -> landing (the literal ramp-spacing quantity). */
  readonly maxFlightDz: number;
  /** max airtime (s) of any completed flight. */
  readonly maxAirtime: number;
  /** flights that ended because `t >= J_MAX_AIRTIME_S` fired — the anti-stuck
   *  backstop. §12.2a: this must be ZERO in normal play. */
  readonly airtimeCapHits: number;
  /** land-and-relaunch within a single step: makes a flight unmeasurable. */
  readonly ambiguousFlights: number;
}

/** Drive one skier from the start gate to the finish (or to MAX_STEPS) with the
 *  REAL stepSki over the REAL genSlope slope, recording containment and flight
 *  telemetry. No jump input is ever supplied: every flight observed here is a
 *  KICKER launch, which is what §12.2a's two new gates are about. */
function runOne(slope: SlopeDef, drive: Driver): RunResult {
  const s = makeSim(0, 0, 0);
  const halfW = slope.width / 2;

  let maxOffPiste = -Infinity;
  let flights = 0;
  let maxFlightDist = 0;
  let maxFlightDz = 0;
  let maxAirtime = 0;
  let airtimeCapHits = 0;
  let ambiguousFlights = 0;

  let inFlight = false;
  let launchX = 0;
  let launchZ = 0;
  let launchMs = 0;

  const closeFlight = (airtime: number, measurable: boolean): void => {
    flights++;
    const dx = s.x - launchX;
    const dz = s.z - launchZ;
    const dist = Math.hypot(dx, dz);
    if (dist > maxFlightDist) maxFlightDist = dist;
    if (dz > maxFlightDz) maxFlightDz = dz;
    if (!measurable) {
      ambiguousFlights++;
      return;
    }
    if (airtime > maxAirtime) maxAirtime = airtime;
    if (airtime >= J_MAX_AIRTIME_S) airtimeCapHits++;
  };

  const openFlight = (): void => {
    inFlight = true;
    launchX = s.x;
    launchZ = s.z;
    launchMs = s.airStartMs;
  };

  let steps = 0;
  while (!s.finished && steps < MAX_STEPS) {
    stepSki(s, drive(s, slope), SIM_DT, slope);
    steps++;

    const off = Math.abs(s.x) - halfW;
    if (off > maxOffPiste) maxOffPiste = off;

    if (!inFlight && s.airborne) {
      openFlight();
    } else if (inFlight && !s.airborne) {
      closeFlight((s.simMs - launchMs) / 1000, true);
      inFlight = false;
    } else if (inFlight && s.airborne && s.airStartMs !== launchMs) {
      // Landed and re-launched inside one step: the first flight's clock is
      // already gone, so it is counted but flagged unmeasurable.
      closeFlight(0, false);
      openFlight();
    }
  }

  return {
    finished: s.finished,
    steps,
    stuckAloft: s.airborne && !s.finished,
    finishedInFlight: s.airborne && s.finished,
    maxOffPiste,
    flights,
    maxFlightDist,
    maxFlightDz,
    maxAirtime,
    airtimeCapHits,
    ambiguousFlights,
  };
}

/** The 4-year-old: one direction, held forever. */
function fullLock(dir: 1 | -1): Driver {
  return () => dir;
}

/** Corridor following: hold the BEARING to the next unconsumed kicker.
 *
 *  A naive proportional-on-lateral-offset driver (`steer = clamp(dx * k)`,
 *  which is what the kicker-CROSSING test in `slope.test.ts` uses) is good
 *  enough to cross every ramp but not to RIDE one: it nulls the offset without
 *  nulling the heading, so the skier sails through the 1.6 m capture window
 *  still turning. Measured: 59 launches out of a possible 180, and a max flight
 *  of only 34 m, because the constant sawing also scrubs speed.
 *
 *  Nulling the heading error instead tracks the ramp tightly AND keeps yaw
 *  small, so the skier arrives fast — which is the condition the
 *  "never overshoots the next ramp" law is actually about. Measured: 174/180
 *  launches, max flight 65.5 m. Gains are driver policy, not physics. */
const CORRIDOR_GAIN = 3;      // steer per rad of heading error
const CORRIDOR_MIN_AHEAD = 3; // m; floor on the bearing baseline near the ramp
const corridorFollow: Driver = (s, slope) => {
  const ix = s.lastKickerIx + 1;
  if (ix >= slope.kickers.length) return 0;
  const k = slope.kickers[ix];
  if (k === undefined) return 0;
  const ahead = k.z - s.z;
  const bearing = Math.atan2(k.x - s.x, ahead > CORRIDOR_MIN_AHEAD ? ahead : CORRIDOR_MIN_AHEAD);
  const c = (bearing - s.yaw) * CORRIDOR_GAIN;
  return c < -1 ? -1 : c > 1 ? 1 : c;
};

/** The corridor sweep is consumed by two `it`s (the gates and the non-vacuity
 *  guard). Memoised so the second reads the first's numbers rather than
 *  re-simulating — and so the two can never disagree. */
const corridorCache = new Map<number, RunResult>();
function corridorRun(seed: number): RunResult {
  let r = corridorCache.get(seed);
  if (r === undefined) {
    r = runOne(slopeFor(seed), corridorFollow);
    corridorCache.set(seed, r);
  }
  return r;
}

/** Kicker-chase-then-hold: the edge-approach transient (see the header).
 *  Chases the SAME bearing law as `corridorFollow` toward the next unconsumed
 *  kicker while it is more than `lead` metres of z ahead; once within `lead`
 *  metres (or once there is no further kicker to chase) it locks `dir` and
 *  holds it, exactly like `fullLock`, for the rest of the run. This is what
 *  puts real |yaw| on the skier right as it reaches the soft edge — neither
 *  `fullLock` (never tracks a kicker) nor `corridorFollow` (never stops
 *  correcting) can produce that combination. */
function kickerChaseThenHold(dir: 1 | -1, lead: number): Driver {
  return (s, slope) => {
    const ix = s.lastKickerIx + 1;
    const k = ix < slope.kickers.length ? slope.kickers[ix] : undefined;
    if (k !== undefined && k.z - s.z > lead) {
      const ahead = k.z - s.z;
      const bearing = Math.atan2(k.x - s.x, ahead > CORRIDOR_MIN_AHEAD ? ahead : CORRIDOR_MIN_AHEAD);
      const c = (bearing - s.yaw) * CORRIDOR_GAIN;
      return c < -1 ? -1 : c > 1 ? 1 : c;
    }
    return dir;
  };
}

// ===========================================================================
// SWEEP 1 — §12.4 gate 7: the 4-year-old law under air lock + raised terrain
// ===========================================================================

describe('§12.4 gate 7 — full-lock containment sweep (20 seeds x 2 directions)', () => {
  it('always lands, is never stuck, stays within 3.5 m of the piste edge, and always finishes', () => {
    const rows: string[] = [];
    let worstOff = -Infinity;
    let worstSeed = 0;
    let worstDir = 0;
    let totalFlights = 0;
    let unfinished = 0;
    let stuck = 0;

    for (const seed of SEEDS) {
      const slope = slopeFor(seed);
      const perSeed: string[] = [];
      for (const dir of [1, -1] as const) {
        const r = runOne(slope, fullLock(dir));
        totalFlights += r.flights;
        if (!r.finished) unfinished++;
        if (r.stuckAloft) stuck++;
        if (r.maxOffPiste > worstOff) {
          worstOff = r.maxOffPiste;
          worstSeed = seed;
          worstDir = dir;
        }
        perSeed.push(
          `dir ${dir > 0 ? '+1' : '-1'}: off ${r.maxOffPiste.toFixed(3)} m, ` +
            `${r.steps} steps, finished ${r.finished}, flights ${r.flights}`,
        );

        // Per-run assertions carry the seed + direction so a failure names the
        // exact case instead of just the aggregate.
        expect(r.finished, `seed ${seed} dir ${dir}: did not finish in ${MAX_STEPS} steps`).toBe(true);
        expect(r.stuckAloft, `seed ${seed} dir ${dir}: never landed — stuck aloft`).toBe(false);
        expect(
          r.maxOffPiste,
          `seed ${seed} dir ${dir}: escaped ${r.maxOffPiste.toFixed(3)} m past the piste edge`,
        ).toBeLessThanOrEqual(CONTAINMENT_M);
        expect(r.ambiguousFlights, `seed ${seed} dir ${dir}: unmeasurable flight`).toBe(0);
        expect(r.airtimeCapHits, `seed ${seed} dir ${dir}: J_MAX_AIRTIME_S fired`).toBe(0);
      }
      rows.push(`  seed ${String(seed).padStart(2)} | ${perSeed.join(' | ')}`);
    }

    console.log(
      `[containment] full lock, 20 seeds x 2 dirs, kickers present, ` +
        `undulation amps ${UND_LONG_1_AMP}/${UND_LONG_2_AMP}/${UND_LAT_AMP} ` +
        `(lens ${UND_LONG_1_LEN}/${UND_LONG_2_LEN}):\n${rows.join('\n')}\n` +
        `  WORST excursion ${worstOff.toFixed(3)} m (seed ${worstSeed} dir ${worstDir}) ` +
        `vs bound ${CONTAINMENT_M} m | unfinished ${unfinished}/40 | stuck aloft ${stuck}/40 | ` +
        `airborne segments ${totalFlights} (expected 0 — see the header)`,
    );

    expect(unfinished).toBe(0);
    expect(stuck).toBe(0);
    expect(worstOff).toBeLessThanOrEqual(CONTAINMENT_M);
  }, 60_000);
});

// ===========================================================================
// SWEEP 2 — §12.2a: the two new flight gates, measured where flights exist
// ===========================================================================

describe('§12.2a — kicker flight sweep (corridor-following, 20 seeds)', () => {
  it('max flight is shorter than KICKER_SPACING and the airtime cap never fires', () => {
    const rows: string[] = [];
    let worstDist = 0;
    let worstDistSeed = 0;
    let worstDz = 0;
    let worstAirtime = 0;
    let totalFlights = 0;
    let totalCapHits = 0;
    let worstOff = -Infinity;

    for (const seed of SEEDS) {
      const r = corridorRun(seed);
      totalFlights += r.flights;
      totalCapHits += r.airtimeCapHits;
      if (r.maxFlightDist > worstDist) {
        worstDist = r.maxFlightDist;
        worstDistSeed = seed;
      }
      if (r.maxFlightDz > worstDz) worstDz = r.maxFlightDz;
      if (r.maxAirtime > worstAirtime) worstAirtime = r.maxAirtime;
      if (r.maxOffPiste > worstOff) worstOff = r.maxOffPiste;

      rows.push(
        `  seed ${String(seed).padStart(2)} | landings ${String(r.flights).padStart(2)} | ` +
          `max flight ${r.maxFlightDist.toFixed(2)} m (dz ${r.maxFlightDz.toFixed(2)} m) | ` +
          `max airtime ${r.maxAirtime.toFixed(3)} s | off ${r.maxOffPiste.toFixed(3)} m | ` +
          `finished ${r.finished}${r.finishedInFlight ? ' (mid-arc)' : ''}`,
      );

      // Every flight in this sweep is a kicker launch (no jump input is ever
      // sent), so these are exactly §12.2a's gates.
      expect(r.finished, `seed ${seed}: corridor run did not finish`).toBe(true);
      expect(r.stuckAloft, `seed ${seed}: never landed — stuck aloft`).toBe(false);
      expect(r.ambiguousFlights, `seed ${seed}: unmeasurable flight (land+relaunch in one step)`).toBe(0);
      expect(
        r.maxFlightDist,
        `seed ${seed}: flight of ${r.maxFlightDist.toFixed(2)} m overshoots KICKER_SPACING ${KICKER_SPACING} m`,
      ).toBeLessThan(KICKER_SPACING);
      expect(
        r.airtimeCapHits,
        `seed ${seed}: J_MAX_AIRTIME_S (${J_MAX_AIRTIME_S} s) fired ${r.airtimeCapHits}x — ` +
          `the anti-stuck backstop must never fire in normal play`,
      ).toBe(0);
      expect(
        r.maxOffPiste,
        `seed ${seed}: corridor run escaped ${r.maxOffPiste.toFixed(3)} m past the piste edge`,
      ).toBeLessThanOrEqual(CONTAINMENT_M);
    }

    console.log(
      `[containment] corridor-following, 20 seeds, kicker launches only:\n${rows.join('\n')}\n` +
        `  WORST flight ${worstDist.toFixed(2)} m (seed ${worstDistSeed}, dz ${worstDz.toFixed(2)} m) ` +
        `vs KICKER_SPACING ${KICKER_SPACING} m | worst airtime ${worstAirtime.toFixed(3)} s ` +
        `vs cap ${J_MAX_AIRTIME_S} s | cap hits ${totalCapHits} | total flights ${totalFlights} | ` +
        `worst excursion ${worstOff.toFixed(3)} m`,
    );

    expect(totalCapHits).toBe(0);
    expect(worstDist).toBeLessThan(KICKER_SPACING);
    expect(worstAirtime).toBeLessThan(J_MAX_AIRTIME_S);
  }, 60_000);

  it('the sweep actually flies — the two gates above cannot pass vacuously', () => {
    // The hazard §12.2a's two new gates face is that "max flight < 85 m" and
    // "zero cap hits" are trivially true on a sweep with no flights at all —
    // which is exactly what the full-lock sweep provably is. This pins the
    // corridor sweep to real, plentiful flight, so a driver or terrain change
    // that quietly stops riding the ramps fails HERE instead of turning the
    // gates green for the wrong reason.
    // Measured with A1's rev-3 amplitudes: 9 kickers per slope, 8-9 launches
    // per seed, 174 of a possible 180 flights over the 20 seeds.
    let totalFlights = 0;
    let seedsWithFlights = 0;
    let kickersTotal = 0;
    for (const seed of SEEDS) {
      const r = corridorRun(seed);
      totalFlights += r.flights;
      kickersTotal += slopeFor(seed).kickers.length;
      if (r.flights > 0) seedsWithFlights++;
      expect(
        r.flights,
        `seed ${seed}: corridor skier launched off only ${r.flights} of ` +
          `${slopeFor(seed).kickers.length} kickers`,
      ).toBeGreaterThanOrEqual(5);
    }
    console.log(
      `[containment] non-vacuity: ${totalFlights} kicker launches of a possible ${kickersTotal}, ` +
        `over ${seedsWithFlights}/${SEEDS.length} seeds`,
    );
    expect(seedsWithFlights).toBe(SEEDS.length);
    expect(totalFlights).toBeGreaterThanOrEqual(SEEDS.length * 7);
  }, 60_000);
});

// ===========================================================================
// SWEEP 3 — edge-approach transient: kicker-chase-then-hold, swept over lead
//
// Closes the gap a review of this suite found: sweeps 1 and 2 are real
// evidence for the two policies they exercise, but neither can produce a
// skier that arrives at the soft edge already carrying substantial |yaw| —
// full lock never tracks a kicker, corridor-following never stops
// correcting. An ordinary third policy — aim at the next feature, then
// commit to a direction for the final approach — does exactly that, and
// measurably exceeds `CONTAINMENT_M` (see `TRANSIENT_CONTAINMENT_M` above
// for the numbers). This sweep is that policy, gated on its own honestly
// measured bound instead of silently retrofitting `CONTAINMENT_M` upward for
// every driver, which would erase the tight, still-true guarantee sweeps 1
// and 2 provide.
// ===========================================================================

describe('edge-approach transient — kicker-chase-then-hold (20 seeds x 2 directions x 21 leads)', () => {
  it(
    'always lands, is never stuck, always finishes, and stays within TRANSIENT_CONTAINMENT_M of the piste edge',
    () => {
      let worstOff = -Infinity;
      let worstSeed = 0;
      let worstDir = 0;
      let worstLead = 0;
      let overClassicBound = 0; // combos that exceed CONTAINMENT_M (non-vacuity of §12.4's original 3.5 m)
      let total = 0;
      let unfinished = 0;
      let stuck = 0;

      for (const seed of SEEDS) {
        const slope = slopeFor(seed);
        for (const dir of [1, -1] as const) {
          for (const lead of LEADS) {
            total++;
            const r = runOne(slope, kickerChaseThenHold(dir, lead));
            if (!r.finished) unfinished++;
            if (r.stuckAloft) stuck++;
            if (r.maxOffPiste > CONTAINMENT_M) overClassicBound++;
            if (r.maxOffPiste > worstOff) {
              worstOff = r.maxOffPiste;
              worstSeed = seed;
              worstDir = dir;
              worstLead = lead;
            }

            expect(r.finished, `seed ${seed} dir ${dir} lead ${lead}: did not finish in ${MAX_STEPS} steps`).toBe(
              true,
            );
            expect(r.stuckAloft, `seed ${seed} dir ${dir} lead ${lead}: never landed — stuck aloft`).toBe(false);
            expect(
              r.maxOffPiste,
              `seed ${seed} dir ${dir} lead ${lead}: escaped ${r.maxOffPiste.toFixed(3)} m past the piste edge`,
            ).toBeLessThanOrEqual(TRANSIENT_CONTAINMENT_M);
          }
        }
      }

      console.log(
        `[containment] kicker-chase-then-hold, ${SEEDS.length} seeds x 2 dirs x ${LEADS.length} leads ` +
          `(${total} runs):\n` +
          `  WORST excursion ${worstOff.toFixed(3)} m (seed ${worstSeed} dir ${worstDir} lead ${worstLead}) ` +
          `vs TRANSIENT_CONTAINMENT_M ${TRANSIENT_CONTAINMENT_M} m | ` +
          `${overClassicBound}/${total} combos exceed the classic CONTAINMENT_M ${CONTAINMENT_M} m | ` +
          `unfinished ${unfinished}/${total} | stuck aloft ${stuck}/${total}`,
      );

      expect(unfinished).toBe(0);
      expect(stuck).toBe(0);
      expect(worstOff).toBeLessThanOrEqual(TRANSIENT_CONTAINMENT_M);
    },
    60_000,
  );

  it('the sweep actually probes the failure mode — cannot pass vacuously on TRANSIENT_CONTAINMENT_M alone', () => {
    // If nothing in this sweep ever exceeded CONTAINMENT_M, TRANSIENT_CONTAINMENT_M
    // would be doing no work and this whole sweep would be redundant with sweep 1.
    // Pin the sweep to reproducing the actual defect this suite was missing, so a
    // future soft-edge fix that genuinely closes the gap is visible here (this
    // assertion should then be revisited and tightened) instead of the sweep
    // quietly stopping to mean anything.
    let overClassicBound = 0;
    let total = 0;
    for (const seed of SEEDS) {
      const slope = slopeFor(seed);
      for (const dir of [1, -1] as const) {
        for (const lead of LEADS) {
          total++;
          const r = runOne(slope, kickerChaseThenHold(dir, lead));
          if (r.maxOffPiste > CONTAINMENT_M) overClassicBound++;
        }
      }
    }
    expect(
      overClassicBound,
      'expected this driver to demonstrably exceed the classic 3.5 m CONTAINMENT_M somewhere in the sweep ' +
        '(that is the defect this sweep exists to keep visible); 0 would mean either the soft edge was fixed ' +
        '(update this comment and tighten TRANSIENT_CONTAINMENT_M) or the sweep stopped exercising the transient',
    ).toBeGreaterThan(0);
    expect(total).toBe(SEEDS.length * 2 * LEADS.length);
  }, 60_000);
});
